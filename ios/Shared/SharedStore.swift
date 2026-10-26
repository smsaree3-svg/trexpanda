import Foundation

/// Snippet storage shared by the app and the keyboard extension through the App
/// Group container. The app writes; the keyboard only reads (and needs "Allow
/// Full Access" to see the shared container, which iOS requires for any keyboard
/// that reads data its containing app saved).
///
/// Stored as two small JSON files so both processes can read them without
/// UserDefaults (no privacy-manifest "required reason" API involved).
enum SharedStore {
    static let appGroup = "group.com.lumisha.trexpanda"

    private static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    private static func url(_ name: String) -> URL? { container?.appendingPathComponent(name) }

    /// Live (non-deleted) snippets, as the keyboard should see them.
    static func loadSnippets() -> [Snippet] { read([Snippet].self, "snippets.json") ?? [] }

    /// Local deletion tombstones, kept so deletes propagate on the next sync.
    static func loadTombstones() -> [Tombstone] { read([Tombstone].self, "tombstones.json") ?? [] }

    static func save(snippets: [Snippet], tombstones: [Tombstone]) {
        write(snippets, "snippets.json")
        write(tombstones, "tombstones.json")
    }

    /// Remove everything (used after the account is deleted, if the user asks).
    static func clear() { save(snippets: [], tombstones: []) }

    /// True when the shared container is reachable. In the keyboard this is false
    /// until the user turns on "Allow Full Access".
    static var isAvailable: Bool { container != nil }

    private static func read<T: Decodable>(_ type: T.Type, _ name: String) -> T? {
        guard let u = url(name), let data = try? Data(contentsOf: u) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private static func write<T: Encodable>(_ value: T, _ name: String) {
        guard let u = url(name), let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: u, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
