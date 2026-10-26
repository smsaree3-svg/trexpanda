import AuthenticationServices
import CryptoKit
import Foundation
import Security
import UIKit

/// Supabase sign-in for iOS, without third-party SDKs.
///  - Google: the Supabase hosted flow in ASWebAuthenticationSession with PKCE,
///    returning to trexpanda://auth (same flow as the Android app).
///  - Apple: native Sign in with Apple; the identity token is exchanged with
///    Supabase (grant_type=id_token). Requires the Apple provider to be enabled in
///    Supabase with the app's bundle id as an allowed client id.
/// Tokens are kept in the Keychain (this device only).
@MainActor
final class AuthService: NSObject, ObservableObject {
    @Published private(set) var userId: String?
    @Published private(set) var email: String?

    var isSignedIn: Bool { userId != nil }

    private var accessToken: String?
    private var refreshToken: String?
    private var expiresAt: Date = .distantPast

    private var webSession: ASWebAuthenticationSession?
    private var appleNonce: String?
    private var appleContinuation: CheckedContinuation<Void, Error>?

    override init() {
        super.init()
        if let saved = Keychain.load() {
            accessToken = saved.access
            refreshToken = saved.refresh
            expiresAt = saved.expiresAt
            userId = saved.userId
            email = saved.email
        }
    }

    // MARK: Google (PKCE)

    func signInWithGoogle() async throws {
        let verifier = Self.randomURLSafe(32)
        let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        var comps = URLComponents(url: AppConfig.authURL("authorize"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [
            .init(name: "provider", value: "google"),
            .init(name: "redirect_to", value: AppConfig.redirectURI),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "s256"),
        ]
        let callback: URL = try await withCheckedThrowingContinuation { cont in
            let session = ASWebAuthenticationSession(url: comps.url!, callbackURLScheme: AppConfig.callbackScheme) { url, error in
                if let url { cont.resume(returning: url) }
                else { cont.resume(throwing: error ?? AuthError.cancelled) }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.webSession = session
            if !session.start() { cont.resume(throwing: AuthError.cancelled) }
        }
        guard let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "code" })?.value else { throw AuthError.failed("No sign-in code returned.") }
        let json = try await post(AppConfig.authURL("token?grant_type=pkce"),
                                  body: ["auth_code": code, "code_verifier": verifier])
        try store(json)
    }

    // MARK: Apple

    func signInWithApple() async throws {
        let nonce = Self.randomURLSafe(32)
        appleNonce = nonce
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.email]
        request.nonce = Self.sha256Hex(nonce)
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            appleContinuation = cont
            controller.performRequests()
        }
    }

    fileprivate func finishApple(idToken: String) async {
        do {
            let json = try await post(AppConfig.authURL("token?grant_type=id_token"),
                                      body: ["provider": "apple", "id_token": idToken, "nonce": appleNonce ?? ""])
            try store(json)
            appleContinuation?.resume()
        } catch {
            appleContinuation?.resume(throwing: error)
        }
        appleContinuation = nil
        appleNonce = nil
    }

    // MARK: Session

    /// A valid access token, refreshed when close to expiry; nil when signed out.
    func freshAccessToken() async -> String? {
        guard isSignedIn else { return nil }
        if Date() < expiresAt.addingTimeInterval(-60), let accessToken { return accessToken }
        guard let refreshToken else { return nil }
        do {
            let json = try await post(AppConfig.authURL("token?grant_type=refresh_token"),
                                      body: ["refresh_token": refreshToken])
            try store(json)
            return accessToken
        } catch {
            return nil
        }
    }

    func signOut() {
        accessToken = nil; refreshToken = nil; userId = nil; email = nil
        expiresAt = .distantPast
        Keychain.clear()
    }

    private func store(_ json: [String: Any]) throws {
        guard let access = json["access_token"] as? String, let refresh = json["refresh_token"] as? String else {
            throw AuthError.failed((json["error_description"] as? String) ?? (json["msg"] as? String) ?? "Sign-in failed.")
        }
        let expiresIn = (json["expires_in"] as? NSNumber)?.doubleValue ?? 3600
        let user = json["user"] as? [String: Any]
        accessToken = access
        refreshToken = refresh
        expiresAt = Date().addingTimeInterval(expiresIn)
        userId = (user?["id"] as? String) ?? userId
        email = (user?["email"] as? String) ?? email
        Keychain.save(.init(access: access, refresh: refresh, expiresAt: expiresAt, userId: userId, email: email))
    }

    private func post(_ url: URL, body: [String: String]) async throws -> [String: Any] {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(AppConfig.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (resp as? HTTPURLResponse)?.statusCode ?? 0 < 300 else {
            throw AuthError.failed((json["error_description"] as? String) ?? (json["msg"] as? String) ?? "Sign-in failed.")
        }
        return json
    }

    // MARK: Helpers

    static func randomURLSafe(_ bytes: Int) -> String {
        var b = [UInt8](repeating: 0, count: bytes)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &b)
        return base64URL(Data(b))
    }

    static func base64URL(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func sha256Hex(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

enum AuthError: LocalizedError {
    case cancelled
    case failed(String)
    var errorDescription: String? {
        switch self {
        case .cancelled: return "Sign-in was cancelled."
        case .failed(let m): return m
        }
    }
}

extension AuthService: ASWebAuthenticationPresentationContextProviding, ASAuthorizationControllerPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { Self.keyWindow() }
    }
    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated { Self.keyWindow() }
    }
    private static func keyWindow() -> UIWindow {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first(where: \.isKeyWindow) ?? UIWindow()
    }
}

extension AuthService: ASAuthorizationControllerDelegate {
    nonisolated func authorizationController(controller: ASAuthorizationController,
                                             didCompleteWithAuthorization authorization: ASAuthorization) {
        let token = (authorization.credential as? ASAuthorizationAppleIDCredential)?
            .identityToken.flatMap { String(data: $0, encoding: .utf8) }
        Task { @MainActor in
            if let token { await self.finishApple(idToken: token) }
            else {
                self.appleContinuation?.resume(throwing: AuthError.failed("Apple didn't return an identity token."))
                self.appleContinuation = nil
            }
        }
    }
    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        Task { @MainActor in
            let cancelled = (error as? ASAuthorizationError)?.code == .canceled
            self.appleContinuation?.resume(throwing: cancelled ? AuthError.cancelled : error)
            self.appleContinuation = nil
        }
    }
}

/// Minimal Keychain wrapper for the session (this device only, after first unlock).
enum Keychain {
    struct Session: Codable {
        var access: String
        var refresh: String
        var expiresAt: Date
        var userId: String?
        var email: String?
    }
    private static let service = "com.lumisha.trexpanda.session"

    static func save(_ s: Session) {
        guard let data = try? JSONEncoder().encode(s) else { return }
        clear()
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                                kSecValueData as String: data]
        SecItemAdd(q as CFDictionary, nil)
    }

    static func load() -> Session? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecReturnData as String: true,
                                kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Session.self, from: data)
    }

    static func clear() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                       kSecAttrService as String: service] as CFDictionary)
    }
}
