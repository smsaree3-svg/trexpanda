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
        }
        .onChange(of: scenePhase) { phase in
            if phase == .active { Task { await model.sync() } }
        }
    }
}
