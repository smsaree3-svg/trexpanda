import AuthenticationServices
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var auth: AuthService
    @State private var editing: Snippet?
    @State private var showKeyboardHelp = false
    @State private var showAccount = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        showKeyboardHelp = true
                    } label: {
                        Label("Set up the Trexpanda keyboard", systemImage: "keyboard")
                    }
                }

                Section {
                    if model.snippets.isEmpty {
                        Text("No snippets yet. Tap + to add one, like ;addr for your address.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(model.sortedSnippets) { s in
                        Button { editing = s } label: { SnippetRow(snippet: s) }
                            .foregroundStyle(.primary)
                    }
                    .onDelete { offsets in
                        let items = offsets.map { model.sortedSnippets[$0] }
                        items.forEach(model.delete)
                    }
                } header: {
                    Text("Snippets")
                } footer: {
                    if let status = model.status { Text(status) }
                }
            }
            .navigationTitle("Trexpanda")
            .refreshable { await model.sync() }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showAccount = true } label: {
                        Image(systemName: auth.isSignedIn ? "person.crop.circle.fill" : "person.crop.circle")
                    }
                    .accessibilityLabel("Account")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { editing = Snippet(id: "", trigger: "", replacement: "") } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New snippet")
                }
            }
            .sheet(item: $editing) { s in
                SnippetEditView(snippet: s) { model.save($0) }
            }
            .sheet(isPresented: $showKeyboardHelp) { KeyboardSetupView() }
            .sheet(isPresented: $showAccount) { AccountView() }
            .alert(item: $model.alert) { a in
                Alert(title: Text(a.title), message: Text(a.message), dismissButton: .default(Text("OK")))
            }
        }
    }
}

struct SnippetRow: View {
    let snippet: Snippet
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(snippet.trigger).font(.body.monospaced().weight(.semibold))
                if let att = snippet.attachment {
                    Image(systemName: att.isImage ? "photo" : "paperclip")
                        .font(.caption).foregroundStyle(.secondary)
                        .accessibilityLabel("Has attachment \(att.name)")
                }
                if !snippet.enabled {
                    Text("Off").font(.caption2.weight(.bold)).padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(Color.secondary.opacity(0.2)))
                }
            }
            Text(snippet.label ?? snippet.replacement)
                .font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
        }
        .padding(.vertical, 2)
    }
}

struct SnippetEditView: View {
    @Environment(\.dismiss) private var dismiss
    @State var snippet: Snippet
    let onSave: (Snippet) -> Void
    @State private var photo: PhotosPickerItem?
    @State private var pickingFile = false
    @State private var attachError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Trigger, e.g. ;addr", text: $snippet.trigger)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .font(.body.monospaced())
                } header: { Text("Trigger") } footer: {
                    Text("Type this anywhere with the Trexpanda keyboard and it expands. Start it with a symbol like ; so it doesn't fire by accident.")
                }
                Section("Replacement") {
                    TextEditor(text: $snippet.replacement).frame(minHeight: 140)
                }
                Section {
                    if let att = snippet.attachment {
                        HStack {
                            if att.isImage, let data = att.bytes, let img = UIImage(data: data) {
                                Image(uiImage: img).resizable().scaledToFill()
                                    .frame(width: 44, height: 44).clipShape(RoundedRectangle(cornerRadius: 6))
                            } else {
                                Image(systemName: "doc").font(.title2).frame(width: 44, height: 44)
                            }
                            Text(att.name).lineLimit(1).truncationMode(.middle)
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
                    if let attachError { Text(attachError).font(.footnote).foregroundStyle(.red) }
                } header: { Text("Attachment") } footer: {
                    Text("Sent after the text when the snippet expands (up to 1 MB). On iPhone it's copied so you can tap Paste. Syncs with your computer and other phones.")
                }
                Section {
                    TextField("Label (optional)", text: Binding(
                        get: { snippet.label ?? "" },
                        set: { snippet.label = $0.isEmpty ? nil : $0 }))
                    Toggle("Enabled", isOn: $snippet.enabled)
                } footer: {
                    Text("Tokens: {date}, {time}, {datetime}. Put $| where the cursor should land.")
                }
            }
            .onChange(of: photo) { item in
                guard let item else { return }
                Task { await loadPhoto(item) }
            }
            .fileImporter(isPresented: $pickingFile, allowedContentTypes: [.item]) { result in
                if case .success(let url) = result { loadFile(url) }
            }
            .navigationTitle(snippet.id.isEmpty ? "New snippet" : "Edit snippet")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        snippet.trigger = snippet.trigger.trimmingCharacters(in: .whitespacesAndNewlines)
                        onSave(snippet)
                        dismiss()
                    }
                    .disabled(snippet.trigger.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
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

struct KeyboardSetupView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            List {
                Section {
                    step(1, "Open Settings", "Tap the button below. It opens Trexpanda's page in Settings.")
                    step(2, "Turn on the keyboard", "Tap Keyboards, then turn on Trexpanda.")
                    step(3, "Allow Full Access", "Needed so the keyboard can read the snippets you save in this app. Trexpanda never records or sends what you type.")
                    step(4, "Switch to it", "In any app, hold the globe key and choose Trexpanda. Type a trigger and it expands.")
                }
                Section {
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                    Link("How Trexpanda handles your data", destination: AppConfig.privacyURL)
                }
            }
            .navigationTitle("Set up the keyboard")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func step(_ n: Int, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(n)").font(.headline).frame(width: 26, height: 26)
                .background(Circle().fill(Color.accentColor.opacity(0.18)))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

struct AccountView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var auth: AuthService
    @State private var confirmDelete = false
    @State private var working = false

    var body: some View {
        NavigationStack {
            List {
                if auth.isSignedIn {
                    Section("Signed in") {
                        Text(auth.email ?? "Your account")
                        Button {
                            Task { await model.sync() }
                        } label: {
                            HStack { Text("Sync now"); Spacer(); if model.isSyncing { ProgressView() } }
                        }
                        Button("Sign out") { model.signOut() }
                    }
                    Section {
                        Button("Delete account", role: .destructive) { confirmDelete = true }
                            .disabled(working)
                    } footer: {
                        Text("Permanently deletes your account and everything stored in the cloud: synced snippets, shared libraries, friends and profile.")
                    }
                } else {
                    Section {
                        SignInWithAppleButton(.signIn) { _ in } onCompletion: { _ in }
                            .allowsHitTesting(false)
                            .overlay(Color.clear.contentShape(Rectangle()).onTapGesture {
                                Task { await model.signIn(apple: true) }
                            })
                            .frame(height: 46)
                            .signInWithAppleButtonStyle(.black)
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
                Section {
                    Link("Privacy policy", destination: AppConfig.privacyURL)
                    Link("Delete account without the app", destination: AppConfig.deleteInfoURL)
                }
            }
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Delete your Trexpanda account?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete account, keep snippets on this iPhone", role: .destructive) { run(clear: false) }
                Button("Delete account and snippets on this iPhone", role: .destructive) { run(clear: true) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This can't be undone. If you pay for Trexpanda, cancel your subscription first.")
            }
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
