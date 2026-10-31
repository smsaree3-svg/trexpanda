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
        saveKeyboardCopy(snippets)
    }

    // MARK: Keyboard copy
    //
    // Keyboard extensions get a small memory budget (~50-70 MB). Loading
    // snippets.json, where every image/file travels as base64 inside its snippet,
    // could crash the keyboard for a library with many attachments. So the app
    // also writes a light copy (attachments without their data) plus one file
    // per attachment, and the keyboard reads an attachment only when it is used.

    private static let keyboardFile = "keyboard-snippets.json"
    private static let attachmentsDir = "attachments"

    private static func saveKeyboardCopy(_ snippets: [Snippet]) {
        guard let root = container else { return }
        let dir = root.appendingPathComponent(attachmentsDir, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var keep = Set<String>()
        let light: [Snippet] = snippets.map { s in
            guard var att = s.attachment, !att.data.isEmpty else { return s }
            let name = fileName(for: s.id)
            keep.insert(name)
            let url = dir.appendingPathComponent(name)
            // Rewrite only when the attachment changed (cheap size check + content compare).
            let existing = try? Data(contentsOf: url)
            let encoded = try? JSONEncoder().encode(att)
            if let encoded, existing != encoded {
                try? encoded.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
            att.data = ""
            var out = s
            out.attachment = att
            return out
        }
        write(light, keyboardFile)
        // Remove files of attachments that no longer exist.
        if let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) {
            for n in names where !keep.contains(n) { try? FileManager.default.removeItem(at: dir.appendingPathComponent(n)) }
        }
    }

    private static func fileName(for id: String) -> String {
        let safe = id.lowercased().filter { $0.isLetter || $0.isNumber || $0 == "-" }
        return (safe.isEmpty ? "snippet" : safe) + ".json"
    }

    /// Snippets for the keyboard: attachments carry name/type only (data empty).
    /// Falls back to the full file for data written by an older app version.
    static func loadKeyboardSnippets() -> [Snippet] {
        read([Snippet].self, keyboardFile) ?? loadSnippets()
    }

    /// The full attachment of one snippet, read on demand by the keyboard.
    static func loadAttachment(snippetId: String) -> SnippetAttachment? {
        guard let u = container?.appendingPathComponent(attachmentsDir, isDirectory: true)
            .appendingPathComponent(fileName(for: snippetId)),
              let d = try? Data(contentsOf: u) else { return nil }
        return try? JSONDecoder().decode(SnippetAttachment.self, from: d)
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
