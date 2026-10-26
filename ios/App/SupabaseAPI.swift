import Foundation

/// PostgREST calls for the signed-in user (row-level security scopes every
/// request to their own rows). Same row shape as the Android and desktop apps.
struct SupabaseAPI {
    let auth: AuthService

    enum APIError: LocalizedError {
        case notSignedIn, http(Int, String)
        var errorDescription: String? {
            switch self {
            case .notSignedIn: return "Sign in to sync."
            case .http(let code, _): return "The server returned an error (\(code)). Please try again."
            }
        }
    }

    func pullSnippets() async throws -> [Snippet] {
        let (token, uid) = try await credentials()
        let url = AppConfig.restURL("snippets?user_id=eq.\(uid)&select=id,trigger,replacement,label,html,enabled,updated_at,deleted_at")
        let data = try await send(url, method: "GET", token: token, body: nil)
        let rows = (try JSONSerialization.jsonObject(with: data) as? [[String: Any]]) ?? []
        return rows.compactMap(Self.snippet(fromRow:))
    }

    func pushSnippets(_ rows: [Snippet]) async throws {
        guard !rows.isEmpty else { return }
        let (token, uid) = try await credentials()
        let payload = rows.map { Self.row(from: $0, userId: uid) }
        let body = try JSONSerialization.data(withJSONObject: payload)
        _ = try await send(AppConfig.restURL("snippets?on_conflict=id"), method: "POST", token: token, body: body,
                           extraHeaders: ["Prefer": "resolution=merge-duplicates,return=minimal"])
    }

    /// Deletes the account and all its cloud data. Returns nil on success, or the
    /// server's user-facing reason when it refuses (e.g. an active subscription).
    func deleteAccount() async throws -> String? {
        let (token, _) = try await credentials()
        let data = try await send(AppConfig.restURL("rpc/delete_my_account"), method: "POST", token: token, body: Data("{}".utf8))
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if (json["ok"] as? Bool) == true { return nil }
        return (json["message"] as? String) ?? "Your account could not be deleted. Please contact hello@trexpanda.com."
    }

    // MARK: Plumbing

    private func credentials() async throws -> (String, String) {
        guard let token = await auth.freshAccessToken(), let uid = await auth.userId else { throw APIError.notSignedIn }
        return (token, uid)
    }

    private func send(_ url: URL, method: String, token: String, body: Data?, extraHeaders: [String: String] = [:]) async throws -> Data {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue(AppConfig.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        extraHeaders.forEach { req.setValue($1, forHTTPHeaderField: $0) }
        req.httpBody = body
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw APIError.http(code, String(decoding: data, as: UTF8.self)) }
        return data
    }

    // MARK: Row mapping (timestamps: ISO-8601 on the server, epoch ms in the app)

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoNoFraction = ISO8601DateFormatter()

    static func millis(_ s: Any?) -> Int64? {
        guard let s = s as? String, !s.isEmpty else { return nil }
        guard let d = iso.date(from: s) ?? isoNoFraction.date(from: s) ?? postgresDate(s) else { return nil }
        return Int64(d.timeIntervalSince1970 * 1000)
    }

    /// PostgREST returns e.g. "2026-10-26T07:46:37.780123+00:00" (microseconds).
    private static func postgresDate(_ s: String) -> Date? {
        let trimmed = s.replacingOccurrences(of: #"(\.\d{3})\d+"#, with: "$1", options: .regularExpression)
        return iso.date(from: trimmed) ?? isoNoFraction.date(from: trimmed)
    }

    static func isoString(_ ms: Int64) -> String {
        iso.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }

    static func snippet(fromRow r: [String: Any]) -> Snippet? {
        guard let id = r["id"] as? String else { return nil }
        return Snippet(id: id,
                       trigger: (r["trigger"] as? String) ?? "",
                       replacement: (r["replacement"] as? String) ?? "",
                       label: r["label"] as? String,
                       html: r["html"] as? String,
                       enabled: (r["enabled"] as? Bool) ?? true,
                       updatedAt: millis(r["updated_at"]) ?? 0,
                       deletedAt: millis(r["deleted_at"]))
    }

    static func row(from s: Snippet, userId: String) -> [String: Any] {
        var row: [String: Any] = [
            "id": s.id,
            "user_id": userId,
            "replacement": s.replacement,
            "enabled": s.enabled,
            "updated_at": isoString(s.updatedAt > 0 ? s.updatedAt : Int64(Date().timeIntervalSince1970 * 1000)),
        ]
        row["trigger"] = s.trigger.isEmpty ? NSNull() : s.trigger
        row["label"] = s.label ?? NSNull()
        row["html"] = s.html ?? NSNull()
        row["deleted_at"] = s.deletedAt.map(isoString) ?? NSNull()
        return row
    }
}
