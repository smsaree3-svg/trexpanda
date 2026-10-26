import Foundation

/// Public cloud settings, injected at build time (Info.plist keys filled from the
/// SUPABASE_URL / SUPABASE_ANON_KEY build settings). The anon/publishable key is
/// meant to ship in apps; row-level security on the server protects the data.
enum AppConfig {
    static let supabaseURL: String = {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "TrexSupabaseURL") as? String) ?? ""
        return raw.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }()
    static let anonKey: String = (Bundle.main.object(forInfoDictionaryKey: "TrexSupabaseAnonKey") as? String) ?? ""

    static var isConfigured: Bool {
        supabaseURL.hasPrefix("https://") && !anonKey.isEmpty && !anonKey.hasPrefix("$(")
    }

    /// Must be listed in Supabase → Authentication → URL Configuration → Redirect URLs
    /// (the existing `trexpanda://*` entry covers it).
    static let redirectURI = "trexpanda://auth"
    static let callbackScheme = "trexpanda"

    static func authURL(_ path: String) -> URL { URL(string: "\(supabaseURL)/auth/v1/\(path)")! }
    static func restURL(_ path: String) -> URL { URL(string: "\(supabaseURL)/rest/v1/\(path)")! }

    static let privacyURL = URL(string: "https://trexpanda.com/privacy.html")!
    static let deleteInfoURL = URL(string: "https://trexpanda.com/delete-account/")!
}
