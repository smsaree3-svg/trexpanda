import Foundation

/// One text-expansion snippet. Mirrors the Android `Snippet` model and the
/// `snippets` table columns, so the same Supabase backend serves both apps.
struct Snippet: Codable, Identifiable, Equatable {
    var id: String
    var trigger: String
    var replacement: String
    var label: String?
    var html: String?
    /// Optional image or file delivered after the text (synced like on desktop).
    var attachment: SnippetAttachment?
    var enabled: Bool
    /// Milliseconds since epoch, last-write-wins for sync.
    var updatedAt: Int64
    /// Set (ms since epoch) when the row is a deletion tombstone.
    var deletedAt: Int64?
    /// Local only: the attachment was removed on purpose in the editor (never synced).
    var attachmentCleared: Bool?

    var isDeleted: Bool { deletedAt != nil }

    init(
        id: String = UUID().uuidString.lowercased(), // Postgres returns uuids lower-case
        trigger: String,
        replacement: String,
        label: String? = nil,
        html: String? = nil,
        attachment: SnippetAttachment? = nil,
        enabled: Bool = true,
        updatedAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        deletedAt: Int64? = nil
    ) {
        self.id = id
        self.trigger = trigger
        self.replacement = replacement
        self.label = label
        self.html = html
        self.attachment = attachment
        self.enabled = enabled
        self.updatedAt = updatedAt
        self.deletedAt = deletedAt
    }
}

/// A snippet's image or file, in the shape every Trexpanda app syncs through
/// the `snippets.attachment` jsonb column: base64 data without a data-URL prefix.
struct SnippetAttachment: Codable, Equatable {
    var type: String // "image" or "file"
    var name: String
    var mime: String
    var data: String

    /// Same limit as the desktop app (the file travels inside the snippet row).
    static let maxBytes = 1024 * 1024

    var isImage: Bool { type == "image" }
    var bytes: Data? { Data(base64Encoded: data, options: .ignoreUnknownCharacters) }

    init(type: String, name: String, mime: String, data: String) {
        self.type = type
        self.name = SnippetAttachment.safeFileName(name, fallback: type == "image" ? "image.png" : "file")
        self.mime = mime
        self.data = data
    }

    init(bytes: Data, name: String, mime: String) {
        let m = mime.lowercased()
        self.init(type: m.hasPrefix("image/") ? "image" : "file", name: name, mime: m,
                  data: bytes.base64EncodedString())
    }

    /// From the jsonb value of a Supabase row; nil if absent or invalid.
    init?(json: Any?) {
        guard let o = json as? [String: Any],
              let type = o["type"] as? String, type == "image" || type == "file",
              let data = o["data"] as? String, !data.isEmpty else { return nil }
        self.init(type: type, name: (o["name"] as? String) ?? "", mime: (o["mime"] as? String) ?? "", data: data)
    }

    var json: [String: Any] { ["type": type, "name": name, "mime": mime, "data": data] }

    /// A bare, safe file name: names can come from another device, so drop any path.
    static func safeFileName(_ name: String, fallback: String = "attachment") -> String {
        let base = name.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? ""
        var cleaned = base.replacingOccurrences(of: #"[\u0000-\u001f<>:"|?*]"#, with: "_", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        while cleaned.hasPrefix(".") { cleaned.removeFirst() }
        let out = String(cleaned.prefix(120))
        return out.trimmingCharacters(in: .whitespaces).isEmpty ? fallback : out
    }
}

/// A deletion tombstone kept for a while so deletes propagate across devices.
struct Tombstone: Codable, Equatable {
    var id: String
    var deletedAt: Int64
}
