import Observation
import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

@MainActor @Observable
final class SettingsModel {
    struct Loaded: Equatable, Sendable {
        var device: DeviceInfo
        var settings: PhoneSettings
        /// This month's spend in US dollars; nil when the Mac doesn't say or nothing was spent.
        var monthCostUsd: Double?
    }

    private(set) var phase: LoadPhase<Loaded> = .idle
    var notice: String?
    /// Set when the Gateway could not be reached for String(localized: "Remove this phone", bundle: .module): the owner may still wipe this phone only.
    var offeringLocalRemoval = false
    private(set) var removing = false
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            async let device = store.device()
            async let settings = store.settings()
            async let usage = store.usage()
            let month = (try? await usage)?.month.costUsd
            phase = .loaded(Loaded(
                device: try await device, settings: try await settings, monthCostUsd: month.flatMap { $0 > 0 ? $0 : nil }))
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }

    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.settings), .resynced: await load()
            default: break
            }
        }
    }

    /// Changes one setting at once on screen, then saves it; a failed save puts the old value back.
    func update(_ change: (inout PhoneSettings) -> Void) {
        guard var loaded = phase.value else { return }
        let before = loaded.settings
        change(&loaded.settings)
        guard loaded.settings != before else { return }
        phase = .loaded(loaded)
        let next = loaded.settings
        Task {
            do {
                try await store.updateSettings(next)
            } catch {
                if var current = phase.value {
                    current.settings = before
                    phase = .loaded(current)
                }
                notice = error.localizedDescription
            }
        }
    }

    /// "Share location with Psyche". Shows the new value at once; iOS permission is asked only when it goes on,
    /// and a refusal puts the switch back off with a line that says where to change it.
    func setShareLocation(_ on: Bool) async {
        guard var loaded = phase.value, loaded.settings.shareLocation != on else { return }
        loaded.settings.shareLocation = on
        phase = .loaded(loaded)
        func putBack() {
            if var current = phase.value {
                current.settings.shareLocation = !on
                phase = .loaded(current)
            }
        }
        do {
            if try await store.setLocationSharing(on) == .permissionDenied {
                putBack()
                notice = String(localized: "Location is off for Psyche in the iOS Settings app. Turn it on there, then try again.", bundle: .module)
            }
        } catch {
            putBack()
            notice = error.localizedDescription
        }
    }

    /// Asks the Gateway to forget this phone. Returns whether the caller should now leave to pairing.
    func removeThisPhone() async -> Bool {
        removing = true
        defer { removing = false }
        do {
            try await store.revokeThisPhone()
            return true
        } catch BackendError.unreachable {
            offeringLocalRemoval = true
            return false
        } catch {
            notice = "\(error.localizedDescription) \(String(localized: "You can also remove this phone on your Mac: Settings > Devices.", bundle: .module))"
            return false
        }
    }

    /// The wipe without the Gateway. Returns whether the caller should now leave to pairing.
    func removeThisPhoneLocally() async -> Bool {
        removing = true
        defer { removing = false }
        do {
            try await store.removeThisPhoneLocally()
            return true
        } catch {
            notice = error.localizedDescription
            return false
        }
    }
}

/// The phone's own settings (docs/design/ios-app-2026.md §4.7): a native grouped `List`. Everything else says
/// "Change this on your Mac": the phone has no admin scope.
struct SettingsSheet: View {
    @State private var model: SettingsModel
    @Environment(Session.self) private var session
    @Environment(\.alerts) private var alerts
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingRepair = false
    @State private var confirmingRemove = false
    init(store: any PsycheBackend) {
        _model = State(initialValue: SettingsModel(store: store))
    }

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .idle, .loading:
                    List { content(.skeleton) }.redacted(reason: .placeholder).allowsHitTesting(false)
                case .loaded(let loaded):
                    List { content(loaded) }
                case .failed(let message):
                    ContentUnavailableView {
                        Label(String(localized: "Couldn't load this", bundle: .module), systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button(String(localized: "Try again", bundle: .module)) { Task { await model.load() } }
                            .buttonStyle(.bordered)
                    }
                }
            }
            .navigationTitle(String(localized: "Settings", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Done", bundle: .module)) { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .task {
            await model.load()
            await model.observe()
        }
        .alert(String(localized: "Couldn't do that", bundle: .module), isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            Button(String(localized: "OK", bundle: .module), role: .cancel) {}
        } message: {
            Text(model.notice ?? "")
        }
        .confirmationDialog(String(localized: "Re-pair with your Mac?", bundle: .module), isPresented: $confirmingRepair, titleVisibility: .visible) {
            Button(String(localized: "Scan a new code", bundle: .module)) {
                dismiss()
                session.cancelPairing()
            }
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
        } message: {
            Text("On your Mac: Settings > Devices > Pair iPhone. Then scan the code.", bundle: .module)
        }
        .confirmationDialog(
            String(localized: "Your Mac isn't reachable right now.", bundle: .module), isPresented: $model.offeringLocalRemoval, titleVisibility: .visible
        ) {
            Button(String(localized: "Remove from this phone only", bundle: .module), role: .destructive) {
                Task {
                    if await model.removeThisPhoneLocally() {
                        dismiss()
                        session.markRevoked()
                    }
                }
            }
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
        } message: {
            Text("This phone can clear its data now. Your Mac keeps listing it until you remove it in Settings > Devices.", bundle: .module)
        }
        .confirmationDialog(String(localized: "Remove this phone?", bundle: .module), isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button(String(localized: "Remove this phone", bundle: .module), role: .destructive) {
                Task {
                    if await model.removeThisPhone() {
                        dismiss()
                        session.markRevoked()
                    }
                }
            }
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
        } message: {
            Text("Your Mac forgets this phone and this phone clears everything it saved. You'll pair again to use Psyche here.", bundle: .module)
        }
    }

    // MARK: Sections

    @ViewBuilder
    private func content(_ loaded: SettingsModel.Loaded) -> some View {
        let device = loaded.device
        let settings = loaded.settings

        Section(String(localized: "This phone", bundle: .module)) {
            LabeledContent(String(localized: "Name", bundle: .module), value: device.name)
            NavigationLink {
                ConnectionDetailView(device: device)
            } label: {
                LabeledContent(String(localized: "Connected", bundle: .module), value: device.transport)
            }
            Button(String(localized: "Re-pair with your Mac", bundle: .module)) { confirmingRepair = true }
            Button(String(localized: "Remove this phone", bundle: .module), role: .destructive) { confirmingRemove = true }
                .disabled(model.removing)
        }

        Section {
            Toggle(String(localized: "Allow notifications", bundle: .module), isOn: notificationsBinding(settings))
            Toggle(String(localized: "Live Activities", bundle: .module), isOn: liveActivitiesBinding(settings))
                .disabled(!settings.notifications)
        } header: {
            Text("Notifications", bundle: .module)
        } footer: {
            Text("Live Activities show progress on the Lock Screen, never task titles.", bundle: .module)
        }

        Section {
            Toggle(String(localized: "Share location with Psyche", bundle: .module), isOn: shareLocationBinding(settings))
        } header: {
            Text("Location", bundle: .module)
        } footer: {
            Text("Only while Psyche is open on this phone, and only sent to your Mac.", bundle: .module)
        }

        if session.isDemo {
            Section {
                Button(String(localized: "Exit demo", bundle: .module)) {
                    dismiss()
                    session.exitDemo()
                }
            } header: {
                Text("Demo", bundle: .module)
            } footer: {
                Text("You're looking at sample content. Exit to go back to pairing with your Mac.", bundle: .module)
            }
        }

        Section {
            LabeledContent(String(localized: "Version", bundle: .module)) {
                Text(Self.version).font(.psycheMono(.footnote))
            }
            if let cost = loaded.monthCostUsd {
                LabeledContent(String(localized: "This month", bundle: .module), value: cost.formatted(.currency(code: "USD")))
            }
        } header: {
            Text("About", bundle: .module)
        } footer: {
            Text("Change everything else on your Mac, in Settings.", bundle: .module)
        }
    }

    /// Turning notifications on asks iOS for permission (the only place besides the first approval that does);
    /// if it is refused the switch goes back off and a line says where to change it.
    private func notificationsBinding(_ settings: PhoneSettings) -> Binding<Bool> {
        Binding(
            get: { settings.notifications },
            set: { value in
                model.update { $0.notifications = value }
                guard value, let alerts else { return }
                Task {
                    if await !alerts.requestNotificationPermission() {
                        model.update { $0.notifications = false }
                        model.notice = String(localized: "Notifications are off for Psyche in the iOS Settings app. Turn them on there, then try again.", bundle: .module)
                    }
                }
            })
    }

    private func shareLocationBinding(_ settings: PhoneSettings) -> Binding<Bool> {
        Binding(
            get: { settings.shareLocation },
            set: { value in Task { await model.setShareLocation(value) } })
    }

    private func liveActivitiesBinding(_ settings: PhoneSettings) -> Binding<Bool> {
        Binding(
            get: { settings.liveActivities },
            set: { value in
                model.update { $0.liveActivities = value }
                if value, let alerts, !alerts.liveActivitiesAllowedBySystem {
                    model.notice = String(localized: "Live Activities are off for Psyche in the iOS Settings app. Turn them on there to see tasks on the Lock Screen.", bundle: .module)
                }
            })
    }

    static var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = info?["CFBundleVersion"] as? String
        return build.map { "\(short) (\($0))" } ?? short
    }
}

extension SettingsModel.Loaded {
    static let skeleton = SettingsModel.Loaded(
        device: DeviceInfo(
            name: "Placeholder", scopes: ["Read", "Write"], gatewayHost: "placeholder.example.net",
            gatewayFingerprint: "sha256:0000 0000 0000", transport: "Tailscale"),
        settings: PhoneSettings(notifications: true, liveActivities: true, taskTitlesOnLockScreen: false))
}


/// The details behind "Connected": where your Mac is and its security code.
private struct ConnectionDetailView: View {
    let device: DeviceInfo

    var body: some View {
        Form {
            Section {
                LabeledContent(String(localized: "Connected", bundle: .module), value: device.transport)
                stacked(String(localized: "Your Mac", bundle: .module), device.gatewayHost)
                stacked(String(localized: "Security code", bundle: .module), device.gatewayFingerprint)
            } footer: {
                Text("The security code should match the one on your Mac. If it ever differs, pair again.", bundle: .module)
            }
        }
        .navigationTitle(String(localized: "Details", bundle: .module))
        .psycheInlineTitle()
    }

    /// Long values (host, fingerprint) go under the label so they never truncate.
    private func stacked(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.subheadline).foregroundStyle(.secondary)
            Text(value).font(.psycheMono(.footnote)).textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }
}
