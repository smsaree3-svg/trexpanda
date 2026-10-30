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
    /// Set while asking Apple for an authorization code to revoke (account deletion).
    private var appleCodeContinuation: CheckedContinuation<String, Error>?

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
                else if let error, (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin {
                    cont.resume(throwing: error)
                } else { cont.resume(throwing: AuthError.cancelled) } // closed the sheet: not an error
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
            appleContinuation?.resume(throwing: AuthError.cancelled) // a second tap: don't strand the first
            appleContinuation = cont
            controller.performRequests()
        }
    }

    /// True when this account signs in with Apple (so deleting it must revoke Apple's tokens).
    func usesAppleSignIn() async -> Bool {
        guard let token = await freshAccessToken() else { return false }
        var req = URLRequest(url: AppConfig.authURL("user"))
        req.setValue(AppConfig.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        let providers = ((json["app_metadata"] as? [String: Any])?["providers"] as? [String]) ?? []
        let identities = (json["identities"] as? [[String: Any]])?.compactMap { $0["provider"] as? String } ?? []
        return (providers + identities).contains("apple")
    }

    /// Ask Apple (one Face ID / passcode confirmation) for a fresh authorization
    /// code, which the server exchanges and revokes before the account is deleted.
    func appleAuthorizationCode() async throws -> String {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
            appleCodeContinuation?.resume(throwing: AuthError.cancelled)
            appleCodeContinuation = cont
            controller.performRequests()
        }
    }

    fileprivate func finishAppleCode(_ code: String?) {
        if let code { appleCodeContinuation?.resume(returning: code) }
        else { appleCodeContinuation?.resume(throwing: AuthError.failed("Apple didn't return an authorization code.")) }
        appleCodeContinuation = nil
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
        // Refresh tokens are single-use: concurrent callers share one refresh.
        if let refreshTask { return await refreshTask.value }
        guard let refreshToken else { return nil }
        let task = Task { () async -> String? in
            do {
                let json = try await self.post(AppConfig.authURL("token?grant_type=refresh_token"),
                                               body: ["refresh_token": refreshToken])
                // Signed out (or into another account) meanwhile: don't bring the old session back.
                guard self.refreshToken == refreshToken else { return self.accessToken }
                try self.store(json)
                return self.accessToken
            } catch AuthError.rejected {
                // revoked or expired session: show "signed out", not a broken sync
                if self.refreshToken == refreshToken { self.signOut() }
                return nil
            } catch {
                return nil // offline etc.: keep the session and try again later
            }
        }
        refreshTask = task
        let token = await task.value
        refreshTask = nil
        return token
    }
    private var refreshTask: Task<String?, Never>?

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
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 400 || code == 401 { throw AuthError.rejected((json["error_description"] as? String) ?? "Session expired.") }
        guard code < 300 else {
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
    case rejected(String)
    var errorDescription: String? {
        switch self {
        case .cancelled: return "Sign-in was cancelled."
        case .failed(let m), .rejected(let m): return m
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
        let credential = authorization.credential as? ASAuthorizationAppleIDCredential
        let token = credential?.identityToken.flatMap { String(data: $0, encoding: .utf8) }
        let code = credential?.authorizationCode.flatMap { String(data: $0, encoding: .utf8) }
        Task { @MainActor in
            if self.appleCodeContinuation != nil { self.finishAppleCode(code); return }
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
            if self.appleCodeContinuation != nil {
                self.appleCodeContinuation?.resume(throwing: cancelled ? AuthError.cancelled : error)
                self.appleCodeContinuation = nil
                return
            }
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
