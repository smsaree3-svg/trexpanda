import Foundation
import SwiftUI

/// App state: the user's snippets (shared with the keyboard through the App
/// Group), sign-in, sync and account deletion.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var snippets: [Snippet] = []
    @Published var status: String?
    @Published var isSyncing = false
    @Published var alert: AlertItem?

    let auth = AuthService()
    private var tombstones: [Tombstone] = []
    private var api: SupabaseAPI { SupabaseAPI(auth: auth) }

    struct AlertItem: Identifiable {
        let id = UUID()
        let title: String
        let message: String
    }

    init() {
        // Ids are compared as strings with the server's lower-case uuids.
        snippets = SharedStore.loadSnippets().map { var s = $0; s.id = s.id.lowercased(); return s }
        tombstones = SharedStore.loadTombstones().map { Tombstone(id: $0.id.lowercased(), deletedAt: $0.deletedAt) }
        if snippets.isEmpty && tombstones.isEmpty && !auth.isSignedIn {
            snippets = Self.starterSnippets
            persist()
        }
    }

    var sortedSnippets: [Snippet] { snippets.sorted { $0.trigger.lowercased() < $1.trigger.lowercased() } }

    // MARK: Editing

    func save(_ edited: Snippet) {
        var list = snippets
        if let i = list.firstIndex(where: { $0.id == edited.id }) { list[i] = edited } else { list.append(edited) }
        apply(list)
    }

    func delete(_ snippet: Snippet) {
        apply(snippets.filter { $0.id != snippet.id })
    }

    private func apply(_ incoming: [Snippet]) {
        (snippets, tombstones) = SnippetReconcile.reconcile(current: snippets, tombstones: tombstones, incoming: incoming)
        persist()
        if auth.isSignedIn { Task { await sync() } }
    }

    private func persist() {
        SharedStore.save(snippets: snippets, tombstones: tombstones)
    }

    // MARK: Account

    func signIn(apple: Bool) async {
        guard AppConfig.isConfigured else {
            alert = .init(title: "Not available", message: "Cloud sign-in isn't configured in this build.")
            return
        }
        do {
            if apple { try await auth.signInWithApple() } else { try await auth.signInWithGoogle() }
            await sync()
        } catch AuthError.cancelled {
            // User closed the sheet; nothing to report.
        } catch {
            alert = .init(title: "Couldn't sign in", message: error.localizedDescription)
        }
    }

    func signOut() {
        auth.signOut()
        status = nil
    }

    func sync() async {
        guard auth.isSignedIn, !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }
        do {
            adoptLocalSnippetsIfAccountChanged()
            let remote = try await api.pullSnippets()
            let merged = SyncMerge.merge(live: snippets, tombstones: tombstones, remote: remote)
            snippets = merged.live
            tombstones = merged.tombstones
            persist()
            try await api.pushSnippets(merged.push)
            Self.lastSyncedUser = auth.userId
            status = "Synced \(merged.live.count) snippet\(merged.live.count == 1 ? "" : "s")"
        } catch {
            status = "Sync failed: \(error.localizedDescription)"
        }
    }

    /// Snippet ids are unique across ALL accounts on the server, so another
    /// account's ids can't be uploaded here. When a different account signs in,
    /// give the snippets on this iPhone fresh ids (they become this account's).
    private func adoptLocalSnippetsIfAccountChanged() {
        guard let uid = auth.userId, let last = Self.lastSyncedUser, last != uid else { return }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        snippets = snippets.map { var s = $0; s.id = UUID().uuidString.lowercased(); s.updatedAt = now; return s }
        tombstones = []
        persist()
    }

    /// The account the local snippets were last synced with (a small file, so no
    /// UserDefaults privacy-manifest entry is needed).
    private static var lastSyncedUserURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("last-synced-user")
    }
    private static var lastSyncedUser: String? {
        get { lastSyncedUserURL.flatMap { try? String(contentsOf: $0, encoding: .utf8) } }
        set {
            guard let url = lastSyncedUserURL else { return }
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if let v = newValue { try? v.write(to: url, atomically: true, encoding: .utf8) }
        }
    }

    /// Permanently deletes the account and its cloud data. Local snippets stay
    /// on this iPhone unless `alsoClearDevice` is true.
    func deleteAccount(alsoClearDevice: Bool) async {
        do {
            if let refusal = try await api.deleteAccount() {
                alert = .init(title: "Can't delete yet", message: refusal)
                return
            }
            auth.signOut()
            if alsoClearDevice {
                snippets = []
                tombstones = []
                persist()
            } else {
                tombstones = []
                persist()
            }
            status = nil
            alert = .init(title: "Account deleted", message: "Your Trexpanda account and its cloud data have been deleted.")
        } catch {
            alert = .init(title: "Couldn't delete your account", message: "Check your connection and try again.")
        }
    }

    private static let starterSnippets: [Snippet] = [
        Snippet(trigger: ";date", replacement: "{date}", label: "Today's date"),
        Snippet(trigger: ";ty", replacement: "Thank you so much!$|", label: "Thank you"),
    ]
}
