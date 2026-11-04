import AuthenticationServices
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Home

struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var auth: AuthService
    @Environment(\.openURL) private var openURL
    @State private var editing: Snippet?
    @State private var showKeyboardHelp = false
    @State private var showAccount = false
    @State private var query = ""
    @State private var pendingDelete: Snippet?
    @State private var shareText: SharedText?
    @State private var toast: String?
    @State private var toastTask: Task<Void, Never>?

    /// Plain text handed to the share sheet (snippets without a file).
    struct SharedText: Identifiable {
        let id = UUID()
        let text: String
    }

    private var isSearching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var showSetupCard: Bool { !model.keyboardUsedHere && !model.setupCardDismissed && !isSearching }

    var body: some View {
        NavigationStack {
            let visible = model.visibleSnippets(matching: query)
            List {
                if !isSearching && !model.snippets.isEmpty {
                    Section { StatsCard() }
                }

                if showSetupCard {
                    Section {
                        KeyboardSetupCard(
                            onOpenSettings: openSettings,
                            onMoreHelp: { showKeyboardHelp = true },
                            onDismiss: { withAnimation { model.setupCardDismissed = true } })
                    }
                }

                if model.snippets.isEmpty {
                    emptyLibrary
                } else if visible.isEmpty {
                    noResults
                } else {
                    Section {
                        ForEach(visible) { s in
                            row(s)
                        }
                    } header: {
                        Text(isSearching ? "Results" : "Snippets")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $query, prompt: "Search triggers, names, text")
            .navigationTitle("Trexpanda")
            .refreshable { await model.refresh() }
            .overlay(alignment: .bottom) { toastView }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showAccount = true } label: { AccountAvatar(email: auth.email, signedIn: auth.isSignedIn) }
                        .accessibilityLabel(auth.isSignedIn ? "Account, signed in" : "Account and sign-in")
                }
                ToolbarItemGroup(placement: .bottomBar) {
                    sortMenu
                    Spacer()
                    SyncStatusView(count: model.snippets.count) { showAccount = true }
                    Spacer()
                    Button { newSnippet() } label: { Image(systemName: "square.and.pencil") }
                        .accessibilityLabel("New snippet")
                }
            }
            .sheet(item: $editing) { s in
                let others = model.snippets.filter { $0.id != s.id }
                    .map { $0.trigger.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
                let deleteAction: (() -> Void)? = s.id.isEmpty ? nil : { model.delete(s) }
                SnippetEditView(snippet: s, otherTriggers: Set(others),
                                onSave: { model.save($0) }, onDelete: deleteAction)
            }
            .sheet(isPresented: $showKeyboardHelp) { KeyboardSetupView() }
            .sheet(item: $model.shareFile) { f in ShareSheet(items: f.items).ignoresSafeArea() }
            .sheet(item: $shareText) { t in ShareSheet(items: [t.text]).ignoresSafeArea() }
            .sheet(isPresented: $showAccount) { AccountView() }
            .confirmationDialog(
                "Delete \(pendingDelete?.trigger ?? "this snippet")?",
                isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                titleVisibility: .visible,
                presenting: pendingDelete
            ) { s in
                Button("Delete snippet", role: .destructive) {
                    withAnimation { model.delete(s) }
                    Haptics.success()
                    pendingDelete = nil
                }
                Button("Cancel", role: .cancel) { pendingDelete = nil }
            } message: { _ in
                Text(auth.isSignedIn ? "It's also removed from your other devices." : "This can't be undone.")
            }
            .onAppear {
                // Store screenshots (simulator only): open a given screen at launch.
                let args = ProcessInfo.processInfo.arguments
                guard let i = args.firstIndex(of: "-TrexScreen"), i + 1 < args.count else { return }
                let screen = args[i + 1]
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    switch screen {
                    case "editor": editing = model.sortedSnippets.first { $0.attachment != nil }
                    case "setup": showKeyboardHelp = true
                    case "account": showAccount = true
                    default: break
                    }
                }
            }
            .alert(item: $model.alert) { a in
                Alert(title: Text(a.title), message: Text(a.message), dismissButton: .default(Text("OK")))
            }
        }
    }

    // MARK: Rows

    private func row(_ s: Snippet) -> some View {
        Button { editing = s } label: {
            SnippetRow(snippet: s, uses: model.usage.count(for: s))
        }
        .foregroundStyle(.primary)
        .accessibilityHint("Opens the editor")
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button { copy(s) } label: { Label("Copy", systemImage: "doc.on.doc") }
                .tint(.indigo)
            if s.attachment != nil {
                Button { model.share(s) } label: { Label("Send file", systemImage: "square.and.arrow.up") }
                    .tint(.blue)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            // Not role: .destructive, which would animate the row away before the
            // user confirms.
            Button { pendingDelete = s } label: { Label("Delete", systemImage: "trash") }
                .tint(.red)
        }
        .contextMenu {
            Button { editing = s } label: { Label("Edit", systemImage: "pencil") }
            Button { copy(s) } label: { Label("Copy text", systemImage: "doc.on.doc") }
            Button { share(s) } label: {
                Label(s.attachment == nil ? "Share text" : "Send file", systemImage: "square.and.arrow.up")
            }
            Button { toggle(s) } label: {
                Label(s.enabled ? "Turn off" : "Turn on", systemImage: s.enabled ? "pause.circle" : "play.circle")
            }
            Divider()
            Button(role: .destructive) { pendingDelete = s } label: { Label("Delete", systemImage: "trash") }
        }
    }

    // MARK: Empty states

    @ViewBuilder private var emptyLibrary: some View {
        Section {
            EmptyStateView(
                systemImage: "text.badge.plus",
                title: "No snippets yet",
                message: "Save text you type again and again (addresses, replies, tracking links) and type a short trigger to paste it anywhere.",
                actionTitle: "New snippet",
                action: { newSnippet() })
        }
        Section {
            ForEach(Self.samples) { s in
                Button {
                    var draft = s
                    draft.id = "" // becomes a new snippet when saved
                    editing = draft
                } label: {
                    HStack(spacing: 12) {
                        SnippetRow(snippet: s)
                        Image(systemName: "plus.circle.fill")
                            .imageScale(.large)
                            .foregroundStyle(Color.accentColor)
                            .accessibilityHidden(true)
                    }
                }
                .foregroundStyle(.primary)
                .accessibilityHint("Opens the editor with this example filled in")
            }
        } header: {
            Text("Start with an example")
        } footer: {
            Text("Tap one to edit it, then save.")
        }
    }

    @ViewBuilder private var noResults: some View {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        Section {
            EmptyStateView(
                systemImage: "magnifyingglass",
                title: "No results for “\(q)”",
                message: "Search looks at triggers, names, text and file names.",
                actionTitle: q.contains(where: { $0.isWhitespace }) ? "New snippet" : "Create \(Self.suggestedTrigger(q))",
                action: {
                    let t = q.contains(where: { $0.isWhitespace }) ? "" : Self.suggestedTrigger(q)
                    editing = Snippet(id: "", trigger: t, replacement: "")
                })
        }
    }

    /// Search text as a trigger: keep a leading ; or !, otherwise add ;.
    private static func suggestedTrigger(_ q: String) -> String {
        guard let first = q.first else { return ";" }
        return first.isLetter || first.isNumber ? ";" + q : q
    }

    private static let samples: [Snippet] = [
        Snippet(id: "sample-addr", trigger: ";addr", replacement: "221 Market Street, Suite 400, San Francisco, CA 94105", label: "Office address"),
        Snippet(id: "sample-ty", trigger: ";ty", replacement: "Thank you so much! Let me know if there's anything else I can help with.$|", label: "Thank you"),
        Snippet(id: "sample-eta", trigger: ";eta", replacement: "Your order is on the way and should arrive by {{day=Friday}}. Tracking: ", label: "Delivery update"),
        Snippet(id: "sample-sig", trigger: ";sig", replacement: "Best regards,\nYour Name\nCustomer Support", label: "Signature"),
    ]

    // MARK: Toolbar

    private var sortMenu: some View {
        Menu {
            Picker("Sort by", selection: $model.sortOrder) {
                ForEach(SnippetSort.allCases) { o in
                    Label(o.title, systemImage: o.systemImage).tag(o)
                }
            }
        } label: {
            Image(systemName: "arrow.up.arrow.down")
        }
        .accessibilityLabel("Sort snippets")
        .accessibilityValue(model.sortOrder.title)
    }

    // MARK: Actions

    private func newSnippet() {
        editing = Snippet(id: "", trigger: "", replacement: "")
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
    }

    private func copy(_ s: Snippet) {
        UIPasteboard.general.string = model.renderedText(s)
        Haptics.success()
        showToast("Copied \(s.trigger)")
    }

    private func share(_ s: Snippet) {
        if s.attachment != nil {
            model.share(s)
        } else {
            shareText = SharedText(text: model.renderedText(s))
        }
    }

    private func toggle(_ s: Snippet) {
        var t = s
        t.enabled.toggle()
        model.save(t)
        Haptics.tap()
        showToast(t.enabled ? "\(s.trigger) turned on" : "\(s.trigger) turned off")
    }

    // MARK: Toast

    @ViewBuilder private var toastView: some View {
        if let toast {
            Text(toast)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.regularMaterial, in: Capsule())
                .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
                .padding(.horizontal, 24)
                .padding(.bottom, 12)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .allowsHitTesting(false)
        }
    }

    private func showToast(_ text: String) {
        withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { toast = text }
        UIAccessibility.post(notification: .announcement, argument: text)
        toastTask?.cancel()
        toastTask = Task {
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.25)) { toast = nil }
        }
    }
}

// MARK: - Home pieces

/// The signed-in user's initial, or a person glyph.
struct AccountAvatar: View {
    let email: String?
    let signedIn: Bool
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 30

    var body: some View {
        if signedIn, let first = email?.first {
            Text(String(first).uppercased())
                .font(.subheadline.weight(.semibold))
                .foregroundColor(.white)
                .frame(width: size, height: size)
                .background(Circle().fill(Color.accentColor))
        } else {
            Image(systemName: "person.crop.circle")
                .imageScale(.large)
        }
    }
}

/// Time saved, expansions and snippet count.
struct StatsCard: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let usage = model.usage
        let acrossDevices = (usage.totals.devices ?? 0) > 1 ? ", across your devices" : ""
        let note = usage.totals.expansions == 0
            ? "Type a trigger with the Trexpanda keyboard to start counting."
            : "Time saved at 35 words per minute" + acrossDevices + "."
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        VStack(alignment: .leading, spacing: 10) {
            layout {
                tile(title: "Time saved", value: UsageData.formatDuration(usage.minutesSaved()),
                     systemImage: "timer", highlight: true)
                tile(title: "Expansions", value: usage.totals.expansions.formatted(), systemImage: "bolt")
                tile(title: "Snippets", value: model.snippets.count.formatted(), systemImage: "text.quote")
            }
            Text(note)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
    }

    private func tile(title: String, value: String, systemImage: String, highlight: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Text(value)
                .font(.title3.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(highlight ? Color.accentColor : Color.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// "Synced 2 min ago" / "Sync failed" / "On this iPhone only", for the bottom bar.
struct SyncStatusView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var auth: AuthService
    let count: Int
    let onSignIn: () -> Void

    var body: some View {
        VStack(spacing: 1) {
            status
                .font(.caption)
                .lineLimit(1)
            Text(count == 1 ? "1 snippet" : "\(count) snippets")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .minimumScaleFactor(0.8)
    }

    @ViewBuilder private var status: some View {
        if !auth.isSignedIn {
            Button(action: onSignIn) { Text("Sign in to sync") }
                .accessibilityHint("Opens account settings")
        } else if model.isSyncing {
            HStack(spacing: 4) {
                ProgressView().controlSize(.mini)
                Text("Syncing…").foregroundStyle(.secondary)
            }
        } else if model.syncError != nil {
            Button {
                Task { await model.refresh() }
            } label: {
                Label("Sync failed · Retry", systemImage: "exclamationmark.icloud")
                    .foregroundStyle(.red)
            }
            .accessibilityHint(model.syncError ?? "")
        } else if let at = model.lastSyncedAt {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(Self.syncedText(at, now: context.date)).foregroundStyle(.secondary)
            }
        } else {
            Text("Pull down to sync").foregroundStyle(.secondary)
        }
    }

    static func syncedText(_ date: Date, now: Date) -> String {
        if now.timeIntervalSince(date) < 60 { return "Synced just now" }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return "Synced \(f.localizedString(for: date, relativeTo: now))"
    }
}

/// Dismissible "turn on the keyboard" card shown until the keyboard has been used.
struct KeyboardSetupCard: View {
    let onOpenSettings: () -> Void
    let onMoreHelp: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Label("Turn on the keyboard", systemImage: "keyboard")
                        .font(.headline)
                    Text("Expand your snippets in any app. It takes about 30 seconds.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Button(action: onDismiss) {
                    Image(systemName: "xmark.circle.fill")
                        .imageScale(.large)
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(.secondary)
                        .frame(minWidth: 44, minHeight: 44, alignment: .topTrailing)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Hide keyboard setup")
                .accessibilityHint("You can find it again under Account")
            }
            .padding(.bottom, -8)

            SetupStep(number: 1, text: Text("Open **Settings**, then **Keyboards**"))
            SetupStep(number: 2, text: Text("Turn on **Trexpanda** and **Allow Full Access**"))
            SetupStep(number: 3, text: Text("In any app, hold \(Image(systemName: "globe")) and pick Trexpanda"))

            HStack(spacing: 10) {
                Button(action: onOpenSettings) {
                    Text("Open Settings").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                Button(action: onMoreHelp) {
                    Text("Help")
                }
                .buttonStyle(.bordered)
            }
            .controlSize(.large)
        }
        .padding(.vertical, 6)
    }
}

/// A numbered step: accent-filled number, then the instruction.
struct SetupStep: View {
    let number: Int
    let text: Text
    @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 24

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(number)")
                .font(.footnote.weight(.bold))
                .foregroundColor(.white)
                .frame(width: size, height: size)
                .background(Circle().fill(Color.accentColor))
                .accessibilityHidden(true)
            text
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("Step \(number): ") + text)
    }
}

/// Icon, title, message and one primary action.
struct EmptyStateView: View {
    let systemImage: String
    let title: String
    let message: String
    let actionTitle: String
    let action: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.largeTitle)
                .foregroundStyle(Color.accentColor)
                .accessibilityHidden(true)
            Text(title)
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: action) {
                Label(actionTitle, systemImage: "plus")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
    }
}

// MARK: - Snippet row

struct SnippetRow: View {
    let snippet: Snippet
    var uses: Int = 0

    /// The snippet's name when it has a real one. (The desktop app stores the
    /// trigger as the name by default, which says nothing useful here.)
    private var name: String? {
        let label = (snippet.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if label.isEmpty || label.caseInsensitiveCompare(snippet.trigger) == .orderedSame { return nil }
        return label
    }

    /// What the snippet expands to, on as few lines as possible.
    private var preview: String {
        snippet.replacement
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .center, spacing: 6) {
                TriggerPill(trigger: snippet.trigger, enabled: snippet.enabled)
                if !snippet.enabled {
                    Text("Off")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.secondary.opacity(0.18)))
                }
                Spacer(minLength: 4)
                if uses > 0 {
                    Text("used \(uses)×")
                        .font(.caption.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            if let name {
                Text(name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
            }
            if !preview.isEmpty {
                Text(preview)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let att = snippet.attachment {
                Label(att.name, systemImage: att.isImage ? "photo" : "paperclip")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        var parts = ["Trigger \(snippet.trigger)"]
        if let name { parts.append(name) }
        if !preview.isEmpty { parts.append("expands to \(preview)") }
        if let att = snippet.attachment { parts.append("with \(att.isImage ? "image" : "file") \(att.name)") }
        if uses > 0 { parts.append("used \(uses) \(uses == 1 ? "time" : "times")") }
        if !snippet.enabled { parts.append("turned off") }
        return parts.joined(separator: ", ")
    }
}

/// The trigger in a tinted capsule.
struct TriggerPill: View {
    let trigger: String
    var enabled: Bool = true

    var body: some View {
        Text(trigger.isEmpty ? " " : trigger)
            .font(.callout.monospaced().weight(.semibold))
            .foregroundStyle(enabled ? Color.accentColor : Color.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
            .padding(.horizontal, 9)
            .padding(.vertical, 3)
            .background(Capsule().fill((enabled ? Color.accentColor : Color.secondary).opacity(0.14)))
    }
}

// MARK: - Editor

@MainActor
struct SnippetEditView: View {
    @Environment(\.dismiss) private var dismiss
    @State var snippet: Snippet
    /// The snippet as it was opened, to detect unsaved changes.
    private let original: Snippet
    /// Lower-cased triggers of the other snippets, for the uniqueness check.
    private let otherTriggers: Set<String>
    let onSave: (Snippet) -> Void
    let onDelete: (() -> Void)?

    @State private var photo: PhotosPickerItem?
    @State private var pickingFile = false
    @State private var attachError: String?
    @State private var confirmDiscard = false
    @State private var confirmDelete = false
    @FocusState private var focus: Field?

    private enum Field { case trigger, name, text }

    init(snippet: Snippet, otherTriggers: Set<String> = [], onSave: @escaping (Snippet) -> Void,
         onDelete: (() -> Void)? = nil) {
        _snippet = State(initialValue: snippet)
        original = snippet
        self.otherTriggers = otherTriggers
        self.onSave = onSave
        self.onDelete = onDelete
    }

    private var isNew: Bool { original.id.isEmpty }
    private var trimmedTrigger: String { snippet.trigger.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var originalTrigger: String { original.trigger.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasChanges: Bool { snippet != original }

    /// Why the trigger can't be saved, if it can't. A trigger that came unchanged
    /// from another device is accepted as it is.
    private var triggerProblem: String? {
        let t = trimmedTrigger
        if t.isEmpty { return nil }
        let unchanged = t.lowercased() == originalTrigger.lowercased() && !isNew
        if !unchanged && t.contains(where: { $0.isWhitespace }) { return "Triggers can't contain spaces." }
        if !unchanged && otherTriggers.contains(t.lowercased()) { return "Another snippet already uses \(t)." }
        return nil
    }

    /// Starts with a letter or digit, so it may fire inside ordinary words.
    private var triggerLooksRisky: Bool {
        guard let first = trimmedTrigger.first else { return false }
        return first.isLetter || first.isNumber
    }

    private var hasContent: Bool {
        !snippet.replacement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || snippet.attachment != nil
    }

    private var canSave: Bool { !trimmedTrigger.isEmpty && triggerProblem == nil && hasContent }

    var body: some View {
        NavigationStack {
            Form {
                triggerSection
                nameSection
                textSection
                previewSection
                attachmentSection
                Section {
                    Toggle("Expand this snippet", isOn: $snippet.enabled)
                } footer: {
                    Text("Turn off to keep the snippet without it expanding.")
                }
                if onDelete != nil {
                    Section {
                        Button(role: .destructive) { confirmDelete = true } label: {
                            Label("Delete snippet", systemImage: "trash")
                        }
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: photo) { item in
                guard let item else { return }
                Task { await loadPhoto(item) }
            }
            .fileImporter(isPresented: $pickingFile, allowedContentTypes: [.item]) { result in
                if case .success(let url) = result { loadFile(url) }
            }
            .navigationTitle(isNew ? "New snippet" : "Edit snippet")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(hasChanges)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        if hasChanges { confirmDiscard = true } else { dismiss() }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .fontWeight(.semibold)
                        .disabled(!canSave)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focus = nil }
                }
            }
            .confirmationDialog("Discard your changes?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard changes", role: .destructive) { dismiss() }
                Button("Keep editing", role: .cancel) {}
            }
            .confirmationDialog("Delete \(originalTrigger)?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete snippet", role: .destructive) {
                    onDelete?()
                    Haptics.success()
                    dismiss()
                }
                Button("Cancel", role: .cancel) {}
            }
            .onAppear {
                if isNew && snippet.trigger.isEmpty {
                    // A sheet's fields can't take focus until it has finished presenting.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { focus = .trigger }
                }
            }
        }
    }

    // MARK: Sections

    private var triggerSection: some View {
        Section {
            TextField(";addr", text: $snippet.trigger)
                .font(.body.monospaced())
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .submitLabel(.next)
                .focused($focus, equals: .trigger)
                .onSubmit { focus = .name }
                .accessibilityLabel("Trigger")
        } header: {
            Text("Trigger")
        } footer: {
            if let problem = triggerProblem {
                Label(problem, systemImage: "exclamationmark.circle")
                    .foregroundStyle(.red)
            } else if triggerLooksRisky {
                Label("Tip: start with ; or ! (like ;\(trimmedTrigger)) so it doesn't expand inside normal words.",
                      systemImage: "lightbulb")
                    .foregroundStyle(.orange)
            } else {
                Text("Type this in any app with the Trexpanda keyboard and it's replaced by the text below. Start it with ; or ! so it doesn't fire by accident.")
            }
        }
    }

    private var nameSection: some View {
        Section {
            TextField("e.g. Office address", text: Binding(
                get: { snippet.label ?? "" },
                set: { snippet.label = $0.isEmpty ? nil : $0 }))
                .submitLabel(.next)
                .focused($focus, equals: .name)
                .onSubmit { focus = .text }
                .accessibilityLabel("Name")
        } header: {
            Text("Name (optional)")
        } footer: {
            Text("Helps you find it in search and in the keyboard's suggestions.")
        }
    }

    private var textSection: some View {
        Section {
            TextEditor(text: $snippet.replacement)
                .focused($focus, equals: .text)
                .frame(minHeight: 120)
                .accessibilityLabel("Expands to")
                .overlay(alignment: .topLeading) {
                    if snippet.replacement.isEmpty {
                        Text("The text to paste…")
                            .foregroundStyle(.tertiary)
                            .padding(.top, 8)
                            .padding(.leading, 5)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    tokenButton("{date}", label: "Date")
                    tokenButton("{time}", label: "Time")
                    tokenButton("{datetime}", label: "Date & time")
                    tokenButton("$|", label: "Cursor here")
                    tokenButton("{{name}}", label: "Fill-in field")
                }
                .padding(.vertical, 2)
            }
        } header: {
            HStack {
                Text("Expands to")
                Spacer()
                Text("\(snippet.replacement.count) characters")
                    .textCase(nil)
                    .monospacedDigit()
            }
        } footer: {
            Text("Tap a chip to add it at the end. {date}, {time} and {datetime} are filled in when the snippet expands; $| marks where the cursor lands; {{field}} asks you for a value.")
        }
    }

    private func tokenButton(_ token: String, label: String) -> some View {
        Button {
            snippet.replacement += token
            Haptics.tap()
        } label: {
            Text(label).font(.footnote.weight(.medium))
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .accessibilityLabel("Insert \(label)")
    }

    @ViewBuilder private var previewSection: some View {
        if !snippet.replacement.isEmpty {
            let engine = ExpanderEngine()
            let rendered = engine.fill(snippet.replacement, values: [:])
            let fields = engine.parseFields(snippet.replacement)
            Section {
                previewText(rendered.text, caretBack: rendered.caretBack)
                    .font(.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } header: {
                Text("Preview")
            } footer: {
                if !fields.isEmpty {
                    Text("You'll be asked for \(fields.map(\.name).joined(separator: ", ")) when it expands.")
                } else if snippet.replacement.contains("$|") {
                    Text("The bar shows where the cursor lands.")
                }
            }
        }
    }

    /// The expansion with a cursor bar where `$|` puts the caret.
    private func previewText(_ text: String, caretBack: Int) -> Text {
        guard snippet.replacement.contains("$|"), caretBack >= 0, caretBack <= text.count else { return Text(text) }
        let split = text.index(text.endIndex, offsetBy: -caretBack)
        return Text(text[..<split]) + Text("|").foregroundColor(.accentColor).bold() + Text(text[split...])
    }

    private var attachmentSection: some View {
        Section {
            if let att = snippet.attachment {
                HStack(spacing: 12) {
                    if att.isImage, let data = att.bytes, let img = UIImage(data: data) {
                        Image(uiImage: img).resizable().scaledToFill()
                            .frame(width: 44, height: 44).clipShape(RoundedRectangle(cornerRadius: 8))
                            .accessibilityHidden(true)
                    } else {
                        Image(systemName: "doc.fill").font(.title2).foregroundStyle(.secondary)
                            .frame(width: 44, height: 44)
                            .accessibilityHidden(true)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(att.name).lineLimit(1).truncationMode(.middle)
                        if let size = att.bytes?.count {
                            Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button("Remove", role: .destructive) { snippet.attachment = nil }
                        .buttonStyle(.borderless)
                }
            }
            PhotosPicker(selection: $photo, matching: .images) {
                Label(snippet.attachment == nil ? "Add a photo" : "Replace with a photo", systemImage: "photo")
            }
            Button { pickingFile = true } label: {
                Label(snippet.attachment == nil ? "Add a file" : "Replace with a file", systemImage: "paperclip")
            }
            if let attachError {
                Label(attachError, systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundStyle(.red)
            }
        } header: { Text("Attachment") } footer: {
            Text("Sent with the text when the snippet expands (up to 1 MB). On iPhone, images are copied so you can tap Paste; files open the share sheet. Syncs with your computer and other phones.")
        }
    }

    private func save() {
        guard canSave else { return }
        snippet.trigger = trimmedTrigger
        if let label = snippet.label?.trimmingCharacters(in: .whitespacesAndNewlines) {
            snippet.label = label.isEmpty ? nil : label
        }
        onSave(snippet)
        Haptics.success()
        dismiss()
    }
}

extension SnippetEditView {
    /// Photos become a JPEG of at most 1 MB, so every device (and Windows) can open them.
    @MainActor
    func loadPhoto(_ item: PhotosPickerItem) async {
        attachError = nil
        defer { photo = nil }
        guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data),
              let jpeg = Self.jpegUnderLimit(image) else {
            attachError = "Couldn't use that photo."
            return
        }
        snippet.attachment = SnippetAttachment(bytes: jpeg, name: "photo.jpg", mime: "image/jpeg")
    }

    static func jpegUnderLimit(_ image: UIImage) -> Data? {
        var img = image
        for _ in 0..<8 {
            for q in [0.85, 0.7, 0.55] {
                if let d = img.jpegData(compressionQuality: q), d.count <= SnippetAttachment.maxBytes { return d }
            }
            let size = CGSize(width: img.size.width * 0.75, height: img.size.height * 0.75)
            let format = UIGraphicsImageRendererFormat.default()
            format.scale = 1
            let src = img
            img = UIGraphicsImageRenderer(size: size, format: format).image { _ in src.draw(in: CGRect(origin: .zero, size: size)) }
        }
        return nil
    }

    func loadFile(_ url: URL) {
        attachError = nil
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { attachError = "Couldn't read that file."; return }
        guard data.count <= SnippetAttachment.maxBytes else { attachError = "That file is too large (max 1 MB)."; return }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        snippet.attachment = SnippetAttachment(bytes: data, name: url.lastPathComponent, mime: mime)
    }
}

/// The iOS share sheet: pick WhatsApp (or Mail, Messages...) to send the real file.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

// MARK: - Keyboard setup

/// The full setup guide, as its own sheet.
struct KeyboardSetupView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            KeyboardSetupList()
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

/// The setup steps (also pushed from the Account screen).
struct KeyboardSetupList: View {
    @Environment(\.openURL) private var openURL

    var body: some View {
        List {
            Section {
                step(1, "Open Settings", "Tap the button below. It opens Trexpanda's page in Settings.")
                step(2, "Turn on the keyboard", "Tap Keyboards, then turn on Trexpanda.")
                step(3, "Allow Full Access", "Needed so the keyboard can read the snippets you save in this app. Trexpanda never records or sends what you type.")
                step(4, "Switch to it", "In any app, hold the globe key and choose Trexpanda. Type a trigger and it expands.")
            }
            Section {
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                } label: {
                    Label("Open Settings", systemImage: "gear")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
            Section {
                Link(destination: AppConfig.privacyURL) {
                    Label("How Trexpanda handles your data", systemImage: "hand.raised")
                }
                Link(destination: AppConfig.supportURL) {
                    Label("Still stuck? Email \(AppConfig.supportEmail)", systemImage: "envelope")
                }
            } footer: {
                Text("Don't see Trexpanda under Keyboards? Restart Settings, or reinstall the app.")
            }
        }
        .navigationTitle("Set up the keyboard")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func step(_ n: Int, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            StepNumber(number: n)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

private struct StepNumber: View {
    let number: Int
    @ScaledMetric(relativeTo: .headline) private var size: CGFloat = 28

    var body: some View {
        Text("\(number)")
            .font(.headline)
            .foregroundColor(.white)
            .frame(width: size, height: size)
            .background(Circle().fill(Color.accentColor))
            .accessibilityHidden(true)
    }
}

// MARK: - Account

struct AccountView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var auth: AuthService
    @Environment(\.colorScheme) private var colorScheme
    @State private var confirmDelete = false
    @State private var confirmSignOut = false
    @State private var working = false

    private var version: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
        return b.isEmpty ? v : "\(v) (\(b))"
    }

    var body: some View {
        NavigationStack {
            List {
                if auth.isSignedIn {
                    signedInSection
                } else {
                    signInSection
                }

                Section {
                    NavigationLink {
                        KeyboardSetupList()
                    } label: {
                        Label {
                            HStack {
                                Text("Keyboard setup")
                                Spacer()
                                if model.keyboardUsedHere {
                                    Text("Working").foregroundStyle(.secondary)
                                }
                            }
                        } icon: {
                            Image(systemName: "keyboard")
                        }
                    }
                    if model.setupCardDismissed && !model.keyboardUsedHere {
                        Button {
                            model.setupCardDismissed = false
                            dismiss()
                        } label: {
                            Label("Show setup card on Home", systemImage: "rectangle.on.rectangle")
                        }
                    }
                } header: {
                    Text("Keyboard")
                }

                Section {
                    Link(destination: AppConfig.supportURL) {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Help & contact").foregroundStyle(.primary)
                                Text(AppConfig.supportEmail).font(.footnote).foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: "envelope")
                        }
                    }
                    Link(destination: AppConfig.privacyURL) {
                        Label { Text("Privacy policy").foregroundStyle(.primary) } icon: { Image(systemName: "hand.raised") }
                    }
                    Link(destination: AppConfig.deleteInfoURL) {
                        Label { Text("Delete account without the app").foregroundStyle(.primary) } icon: {
                            Image(systemName: "safari")
                        }
                    }
                } header: {
                    Text("Help")
                }

                if auth.isSignedIn {
                    Section {
                        Button { confirmSignOut = true } label: {
                            Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                    } footer: {
                        Text("Your snippets stay on this iPhone after you sign out.")
                    }

                    Section {
                        Button(role: .destructive) { confirmDelete = true } label: {
                            HStack {
                                Label("Delete account", systemImage: "trash")
                                Spacer()
                                if working { ProgressView() }
                            }
                        }
                        .disabled(working)
                    } footer: {
                        Text("Permanently deletes your account and everything stored in the cloud: synced snippets, shared libraries, friends and profile.")
                    }
                }

                Section {
                } footer: {
                    Text("Trexpanda \(version) · Lumisha LLC")
                        .frame(maxWidth: .infinity, alignment: .center)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Sign out of Trexpanda?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { model.signOut() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Snippets stay on this iPhone but stop syncing until you sign in again.")
            }
            .confirmationDialog("Delete your Trexpanda account?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete account, keep snippets on this iPhone", role: .destructive) { run(clear: false) }
                Button("Delete account and snippets on this iPhone", role: .destructive) { run(clear: true) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This can't be undone. If you pay for Trexpanda, cancel your subscription first.")
            }
        }
    }

    private var signedInSection: some View {
        Section {
            HStack(spacing: 12) {
                AccountAvatar(email: auth.email, signedIn: true)
                    .font(.title3)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(auth.email ?? "Your account")
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text("Syncing with your computer and other phones")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)

            Button {
                Task { await model.refresh() }
            } label: {
                HStack {
                    Label("Sync now", systemImage: "arrow.triangle.2.circlepath")
                    Spacer()
                    if model.isSyncing {
                        ProgressView()
                    } else if let at = model.lastSyncedAt {
                        TimelineView(.periodic(from: .now, by: 30)) { context in
                            Text(SyncStatusView.syncedText(at, now: context.date))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .disabled(model.isSyncing)
        } header: {
            Text("Signed in")
        } footer: {
            if let err = model.syncError {
                Label("Last sync failed: \(err)", systemImage: "exclamationmark.icloud")
                    .foregroundStyle(.red)
            }
        }
    }

    private var signInSection: some View {
        Section {
            SignInWithAppleButton(.signIn) { _ in } onCompletion: { _ in }
                .allowsHitTesting(false)
                .overlay(Color.clear.contentShape(Rectangle()).onTapGesture {
                    Task { await model.signIn(apple: true) }
                })
                .frame(height: 46)
                .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                .id(colorScheme) // the button doesn't restyle itself when the appearance changes
                .accessibilityAddTraits(.isButton)
            Button {
                Task { await model.signIn(apple: false) }
            } label: {
                Label("Sign in with Google", systemImage: "globe")
                    .frame(maxWidth: .infinity, minHeight: 34)
            }
            .buttonStyle(.bordered)
        } header: {
            Text("Sync across devices")
        } footer: {
            Text("Optional. Sign in to keep your snippets in sync with Trexpanda on your computer and other phones. Everything works without an account too.")
        }
    }

    private func run(clear: Bool) {
        working = true
        Task {
            await model.deleteAccount(alsoClearDevice: clear)
            working = false
        }
    }
}
