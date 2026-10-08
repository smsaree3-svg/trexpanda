import Foundation

/// One text-expansion snippet. Mirrors the Android `Snippet` model and the
/// `snippets` table columns, so the same Supabase backend serves both apps.
struct Snippet: Codable, Identifiable, Equatable {
    var id: String
    var trigger: String
    var replacement: String
    var label: String?
    var html: String?
    var enabled: Bool
    /// Milliseconds since epoch, last-write-wins for sync.
    var updatedAt: Int64
    /// Set (ms since epoch) when the row is a deletion tombstone.
    var deletedAt: Int64?

    var isDeleted: Bool { deletedAt != nil }

    init(
        id: String = UUID().uuidString,
        trigger: String,
        replacement: String,
        label: String? = nil,
        html: String? = nil,
        enabled: Bool = true,
        updatedAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        deletedAt: Int64? = nil
    ) {
        self.id = id
        self.trigger = trigger
        self.replacement = replacement
        self.label = label
        self.html = html
        self.enabled = enabled
        self.updatedAt = updatedAt
        self.deletedAt = deletedAt
    }
}

/// A deletion tombstone kept for a while so deletes propagate across devices.
struct Tombstone: Codable, Equatable {
    var id: String
    var deletedAt: Int64
}
