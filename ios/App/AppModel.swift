import Foundation
import SwiftUI

/// App state: the user's snippets (shared with the keyboard through the App
/// Group), sign-in, sync and account deletion.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var snippets: [Snippet] = []
    @Published var status: String?
    @Published private(set) var usage: UsageData = UsageLog.combined()
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
        // Store screenshots (simulator only): show sample snippets, save nothing.
        if ProcessInfo.processInfo.arguments.contains("-TrexDemoSnippets") {
            snippets = Self.demoSnippets
            return
        }
        if snippets.isEmpty && tombstones.isEmpty && !auth.isSignedIn {
            snippets = Self.starterSnippets
            persist()
        }
    }

    var sortedSnippets: [Snippet] { snippets.sorted { $0.trigger.lowercased() < $1.trigger.lowercased() } }

    // MARK: Sharing attachments

    /// A snippet's file waiting to be shown in the share sheet.
    @Published var shareFile: ShareFile?

    struct ShareFile: Identifiable {
        let id = UUID()
        let url: URL
        /// The snippet's text, shared with the file so WhatsApp & co. use it as the caption.
        var text: String? = nil
        var items: [Any] { [url] + (text.map { [$0] } ?? []) }
    }

    /// Handle trexpanda://share?trigger=<trigger> sent by the keyboard.
    func openShareLink(_ url: URL) {
        guard url.scheme == "trexpanda", url.host == "share",
              let trigger = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "trigger" })?.value else { return }
        let lower = trigger.lowercased()
        guard let s = snippets.last(where: { $0.trigger.lowercased() == lower && !$0.isDeleted && $0.attachment != nil })
        else { return }
        share(s)
    }

    /// Write the attachment to a temporary file with its real name and share it.
    func share(_ snippet: Snippet) {
        guard let att = snippet.attachment, let data = att.bytes else { return }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("share-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent(att.name)
        do { try data.write(to: file) } catch { return }
        let text = snippet.replacement.trimmingCharacters(in: .whitespacesAndNewlines)
        shareFile = ShareFile(url: file, text: text.isEmpty ? nil : snippet.replacement)
    }

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

    /// An edit arrived while a sync was running: sync again when it finishes, so
    /// the edit reaches the cloud now rather than on the next app launch.
    private var syncAgain = false

    func sync() async {
        guard auth.isSignedIn else { return }
        guard !isSyncing else { syncAgain = true; return }
        isSyncing = true
        defer {
            isSyncing = false
            if syncAgain { syncAgain = false; Task { await sync() } }
        }
        do {
            adoptLocalSnippetsIfAccountChanged()
            let remote = try await api.pullSnippets()
            let merged = SyncMerge.merge(live: snippets, tombstones: tombstones, remote: remote)
            snippets = merged.live
            tombstones = merged.tombstones
            persist()
            try await api.pushSnippets(merged.push)
            Self.lastSyncedUser = auth.userId
            // Use counts and time saved, combined across every device.
            let dev = UsageLog.deviceId()
            let local = UsageLog.local()
            if (try? await api.pushUsage(deviceId: dev, usage: local)) != nil,
               let rows = try? await api.pullUsage() {
                UsageLog.saveCombined(UsageLog.combine(local: local, rows: rows, deviceId: dev))
            }
            usage = UsageLog.combined()
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
        UsageLog.reset() // another account's usage isn't this account's
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
        // Accounts that use Sign in with Apple: revoke Apple's tokens first, as
        // Apple requires. The user confirms once with Face ID / passcode.
        if await auth.usesAppleSignIn() {
            do {
                let code = try await auth.appleAuthorizationCode()
                try await api.revokeApple(authorizationCode: code)
            } catch AuthError.cancelled {
                alert = .init(title: "Account not deleted", message: "Confirm with Apple to delete your account.")
                return
            } catch {
                // Still delete the account; the user can also remove Trexpanda in
                // Settings > Apple Account > Sign in with Apple.
            }
        }
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

    private static let demoSnippets: [Snippet] = [
        Snippet(trigger: ";addr", replacement: "221 Market Street, Suite 400, San Francisco, CA 94105", label: "Office address"),
        Snippet(trigger: ";email", replacement: "hello@yourcompany.com", label: "Work email"),
        Snippet(trigger: ";ty", replacement: "Thank you so much! Let me know if there's anything else I can help with.", label: "Thank you"),
        Snippet(trigger: ";meet", replacement: "Here's my meeting link: https://meet.example.com/you", label: "Meeting link"),
        Snippet(trigger: ";sig", replacement: "Best regards,\nAlex Morgan\nCustomer Success", label: "Signature"),
        Snippet(trigger: ";date", replacement: "{date}", label: "Today's date"),
        Snippet(trigger: ";price", replacement: "Here's our latest price list:", label: "Price list",
                attachment: SnippetAttachment(bytes: Data(count: 64), name: "Price list.pdf", mime: "application/pdf")),
        Snippet(trigger: ";track", replacement: "You can track your order here: https://track.example.com", label: "Order tracking"),
    ]

    private static let starterSnippets: [Snippet] = [
        Snippet(trigger: ";date", replacement: "{date}", label: "Today's date"),
        Snippet(trigger: ";ty", replacement: "Thank you so much!$|", label: "Thank you"),
    ]
}
