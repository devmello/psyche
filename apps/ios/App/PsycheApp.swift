import PsycheClient
import PsycheDesign
import PsycheFeatures
import PsycheShared
import PsycheStore
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// What the app runs against: the real Gateway, or fixtures (`-psycheScenario <name>` for simulator
/// checks, or "Try it without a Mac" on the pairing screen).
@MainActor
private struct AppModel {
    var session: Session
    var backend: any PsycheBackend

    /// `-psycheScenario <name>` (unpaired, pending, live, away, gatewayOff, tailscaleOff, mismatch) runs the fixtures.
    static func launch(defaults: UserDefaults = .standard) -> AppModel {
        if let name = defaults.string(forKey: "psycheScenario"), !name.isEmpty {
            return fixtures(FixtureSessionDriver.fromLaunchArguments(defaults))
        }
        return live()
    }

    static func fixtures(_ driver: FixtureSessionDriver = FixtureSessionDriver(scenario: .live)) -> AppModel {
        AppModel(session: Session(driver: driver), backend: FixtureBackend.shared)
    }

    static func live() -> AppModel {
        #if canImport(UIKit)
        let deviceName = UIDevice.current.name
        #else
        let deviceName = "iPhone"
        #endif
        let store = EndpointStore.standard()
        let client = GatewayClient(dependencies: GatewayClientDependencies(endpointStore: store, deviceName: deviceName))
        let driver = LiveSessionDriver(client: client, endpoint: store.load())
        return AppModel(session: Session(driver: driver), backend: GatewayBackend(client: client))
    }
}

@main
struct PsycheApp: App {
    @State private var model = AppModel.launch()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        PsycheAppearance.install()
    }

    var body: some Scene {
        WindowGroup {
            RootView(store: model.backend)
                .environment(model.session)
                .onChange(of: scenePhase, initial: true) { _, phase in
                    model.session.setActive(phase == .active)
                }
                .onChange(of: model.session.fixtureModeRequested) { _, requested in
                    if requested { model = .fixtures() }
                }
        }
    }
}
