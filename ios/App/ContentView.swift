import AuthenticationServices
import SwiftUI

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
                    TextField("Label (optional)", text: Binding(
                        get: { snippet.label ?? "" },
                        set: { snippet.label = $0.isEmpty ? nil : $0 }))
                    Toggle("Enabled", isOn: $snippet.enabled)
                } footer: {
                    Text("Tokens: {date}, {time}, {datetime}. Put $| where the cursor should land.")
                }
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
