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
    /// Live Activities and local notifications, driven from this backend's live connection.
    var alerts: AlertCenter

    /// Debug builds only: `-psycheScenario <name>` (unpaired, pending, live, away, gatewayOff, tailscaleOff,
    /// mismatch) runs the fixtures. A release build ignores launch arguments, so nothing on a device's launch
    /// line can swap the Gateway for fixtures.
    static func launch(defaults: UserDefaults = .standard) -> AppModel {
        #if DEBUG
        if let name = defaults.string(forKey: "psycheScenario"), !name.isEmpty {
            // `psycheDemoParked YES` (a launch argument, or `defaults write` so a launch by the system sees it too)
            // starts the watched task's script already waiting on its approval: for answering from the Dynamic
            // Island with the app closed.
            if defaults.bool(forKey: "psycheDemoParked") {
                Task { await FixtureBackend.shared.startRunningDemoParkedOnApproval(taskID: "task_q3") }
            }
            return fixtures(FixtureSessionDriver.fromLaunchArguments(defaults))
        }
        #endif
        let model = live()
        #if DEBUG
        // `-psycheDevPair "<origin>|<sha256 fingerprint>|<pst_ token>"` pairs with a development Gateway on loopback.
        if let spec = defaults.string(forKey: "psycheDevPair"), let client = model.client {
            let parts = spec.split(separator: "|").map(String.init)
            if parts.count == 3, let link = PairingLink.development(origin: parts[0], fingerprint: parts[1], setupToken: parts[2]) {
                Task { await client.beginPairing(link) }
            }
        }
        #endif
        return model
    }

    static func fixtures(_ driver: FixtureSessionDriver = FixtureSessionDriver(scenario: .live)) -> AppModel {
        AppModel(
            session: Session(driver: driver), backend: FixtureBackend.shared, client: nil,
            alerts: AlertCenter.make(store: FixtureBackend.shared, client: nil))
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
        let backend = GatewayBackend(client: client)
        return AppModel(
            session: Session(driver: driver), backend: backend, client: client,
            alerts: AlertCenter.make(store: backend, client: client))
    }
}

/// The model the app launches with, made exactly once. `@State`'s initial value and the hooks installed in
/// `PsycheApp.init` must be the same `AlertCenter`: reading `model` inside `init` returned a different one,
/// so notification taps, the island's Deny / Approve and background checks reached a center the screens
/// never read.
@MainActor
private enum Launch {
    static let model: AppModel = {
        let model = AppModel.launch()
        PsycheAppearance.install()
        // Before launch finishes: the delegate must be set for a tap that launched the app, the island's
        // intent handler installed, and the background task registered. None of these asks for a permission.
        model.alerts.installSystemHooks()
        #if os(iOS)
        model.alerts.registerBackgroundRefresh()
        #endif
        return model
    }()
}

@main
struct PsycheApp: App {
    @State private var model = Launch.model
    @Environment(\.scenePhase) private var scenePhase

    init() {
        _ = Launch.model
    }

    private var appRoot: some View {
        RootView(store: model.backend, alerts: model.alerts)
            .environment(model.session)
            .onChange(of: scenePhase, initial: true) { _, phase in
                model.session.setActive(phase == .active)
                model.alerts.setAppActive(phase == .active)
                // No microphone once the scene leaves the screen (the `audio` background mode would let it run on).
                if phase != .active { PsycheDictation.stopAll() }
                #if os(iOS)
                if phase == .background { model.alerts.scheduleBackgroundRefresh() }
                #endif
            }
            .onChange(of: model.session.fixtureModeRequested) { _, requested in
                guard requested else { return }
                // Leaving the live client behind must stop it: a pairing attempt in progress is cancelled (nothing
                // unproven stays stored) and its connection closes.
                let live = model.client
                model = .fixtures()
                model.alerts.installSystemHooks()
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
