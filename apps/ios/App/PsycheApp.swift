import PsycheBlocks
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
    /// The live Gateway client, nil in fixture mode.
    var client: GatewayClient?

    /// Debug builds only: `-psycheScenario <name>` (unpaired, pending, live, away, gatewayOff, tailscaleOff,
    /// mismatch) runs the fixtures. A release build ignores launch arguments, so nothing on a device's launch
    /// line can swap the Gateway for fixtures.
    static func launch(defaults: UserDefaults = .standard) -> AppModel {
        #if DEBUG
        if let name = defaults.string(forKey: "psycheScenario"), !name.isEmpty {
            return fixtures(FixtureSessionDriver.fromLaunchArguments(defaults))
        }
        #endif
        return live()
    }

    static func fixtures(_ driver: FixtureSessionDriver = FixtureSessionDriver(scenario: .live)) -> AppModel {
        AppModel(session: Session(driver: driver), backend: FixtureBackend.shared, client: nil)
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
        return AppModel(session: Session(driver: driver), backend: GatewayBackend(client: client), client: client)
    }
}

@main
struct PsycheApp: App {
    @State private var model = AppModel.launch()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        PsycheAppearance.install()
    }

    private var appRoot: some View {
        RootView(store: model.backend)
            .environment(model.session)
            .onChange(of: scenePhase, initial: true) { _, phase in
                model.session.setActive(phase == .active)
            }
            .onChange(of: model.session.fixtureModeRequested) { _, requested in
                guard requested else { return }
                // Leaving the live client behind must stop it: a pairing attempt in progress is cancelled (nothing
                // unproven stays stored) and its connection closes.
                let live = model.client
                model = .fixtures()
                if let live { Task { await live.cancelPairing(); await live.setActive(false) } }
            }
    }

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if WidgetGallery.isRequested {
                // Hidden: `-psycheWidgetGallery YES` shows every widget fixture instead of the app.
                WidgetGallery()
            } else {
                appRoot
            }
            #else
            appRoot
            #endif
        }
    }
}
