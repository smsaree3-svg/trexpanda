import SwiftUI

@main
struct TrexpandaApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .environmentObject(model.auth)
                .tint(Color("AccentColor"))
                // trexpanda://share?trigger=;x from the keyboard's "Send file" button.
                .onOpenURL { model.openShareLink($0) }
        }
        .onChange(of: scenePhase) { phase in
            if phase == .active { Task { await model.sync() } }
        }
    }
}
