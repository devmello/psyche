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
        /// Read-only; empty when there are none or the Gateway doesn't say.
        var machines: [MachineSummary] = []
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
            async let machines = store.machines()
            phase = .loaded(Loaded(
                device: try await device, settings: try await settings, machines: (try? await machines) ?? []))
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
            notice = "\(error.localizedDescription) You can also remove this phone in Settings \u{2192} Devices on your Mac."
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

/// The phone's own settings (docs/design/ios-app-2026.md §4.7): a native grouped `Form`. Everything else says
/// "Change this on your Mac": the phone has no admin scope.
struct SettingsSheet: View {
    @State private var model: SettingsModel
    @Environment(Session.self) private var session
    @Environment(\.alerts) private var alerts
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingRepair = false
    @State private var confirmingRemove = false
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        _model = State(initialValue: SettingsModel(store: store))
        self.store = store
    }

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .idle, .loading:
                    Form { content(.skeleton) }.redacted(reason: .placeholder).allowsHitTesting(false)
                case .loaded(let loaded):
                    Form { content(loaded) }
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
        .presentationDetents([.medium, .large])
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
            Text("Open Settings \u{2192} Server & remote access \u{2192} Pair another computer on your Mac, then scan the code it shows.", bundle: .module)
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
            Text("This phone can clear its keys and saved data now, but your Mac will keep listing it until you remove it in Settings \u{2192} Devices there.", bundle: .module)
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
            // Access, the Mac's address and its security code are one tap away, not on the first screen.
            NavigationLink {
                ConnectionDetailView(device: device)
            } label: {
                LabeledContent(String(localized: "Connected over", bundle: .module), value: device.transport)
            }
        }

        Section {
            Toggle(String(localized: "Allow notifications", bundle: .module), isOn: notificationsBinding(settings))
            Toggle(String(localized: "Live Activities", bundle: .module), isOn: liveActivitiesBinding(settings))
                .disabled(!settings.notifications)
            Toggle(String(localized: "Task titles on the Lock Screen", bundle: .module), isOn: binding(\.taskTitlesOnLockScreen, settings))
                .disabled(!settings.notifications || !settings.liveActivities)
        } header: {
            Text("Notifications", bundle: .module)
        } footer: {
            Text(Self.notificationsFooter)
        }

        stayConnectedSection(settings)

        Section {
            Toggle(String(localized: "Share location with Psyche", bundle: .module), isOn: shareLocationBinding(settings))
        } header: {
            Text("Location", bundle: .module)
        } footer: {
            Text(
                "Off by default. When on, Psyche on your Mac can ask where this phone is, but only while Psyche is open on this phone. It never tracks you in the background or keeps a history of where you've been, and your location goes only to your Mac.",
                bundle: .module)
        }

        // The Face ID toggle only changes how the phone asks before a risky action. Approving stays one tap.
        Section {
            Toggle(String(localized: "Face ID for approvals", bundle: .module), isOn: binding(\.faceIDForApprovals, settings))
        } header: {
            Text("Approvals", bundle: .module)
        } footer: {
            Text("Asks for Face ID before you allow a risky action from this phone.", bundle: .module)
        }

        Section(String(localized: "Model", bundle: .module)) {
            NavigationLink(String(localized: "Default model", bundle: .module)) { DefaultModelView(store: store) }
            NavigationLink(String(localized: "Usage", bundle: .module)) { UsageView(store: store) }
        }

        computersSection(loaded.machines)

        Section {
            NavigationLink(String(localized: "Standing permissions", bundle: .module)) { StandingPermissionsView(store: store) }
            NavigationLink(String(localized: "Skills", bundle: .module)) { SkillsView(store: store) }
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

        Section(String(localized: "Your Mac", bundle: .module)) {
            Button(String(localized: "Re-pair with your Mac", bundle: .module)) { confirmingRepair = true }
            Button(String(localized: "Remove this phone", bundle: .module), role: .destructive) { confirmingRemove = true }
                .disabled(model.removing)
        }

        Section {
            LabeledContent(String(localized: "Version", bundle: .module)) {
                Text(Self.version).font(.psycheMono(.footnote))
            }
        } header: {
            Text("About", bundle: .module)
        } footer: {
            Text("Change everything else on your Mac, in Settings.", bundle: .module)
        }
    }

    /// "Computers Psyche can use": read-only. Adding or pairing one is done on the Mac.
    private func computersSection(_ machines: [MachineSummary]) -> some View {
        Section(String(localized: "Computers Psyche can use", bundle: .module)) {
            if machines.isEmpty {
                Text("No computers added yet.", bundle: .module).foregroundStyle(.secondary)
            } else {
                ForEach(machines, id: \.id) { machine in
                    LabeledContent {
                        Self.statusText(machine.status)
                    } label: {
                        Text(machine.name)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    static func statusText(_ status: MachineSummary.Status) -> Text {
        switch status {
        case .online: Text("Online", bundle: .module)
        case .offline: Text("Offline", bundle: .module)
        case .degraded: Text("Limited", bundle: .module)
        }
    }

    /// "Stay connected while a task runs" (off by default), its battery note, and what it has cost today.
    private func stayConnectedSection(_ settings: PhoneSettings) -> some View {
        Section {
            Toggle(isOn: binding(\.stayConnectedWhileRunning, settings)) {
                Text("Stay connected while a task runs", bundle: .module)
            }
            .disabled(!settings.notifications || !settings.liveActivities)
            .accessibilityIdentifier("stayConnectedToggle")
            AwakeTodayRow(alerts: alerts, isOn: settings.stayConnectedWhileRunning)
        } header: {
            Text("Background", bundle: .module)
        } footer: {
            Text(
                "Keeps Psyche running in the background, with a silent audio session, only while a task or chat reply you're watching runs or waits for you. It uses some battery, and stops on Low Power Mode or when the battery is below 20 percent and unplugged.",
                bundle: .module)
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

    static let notificationsFooter = [
        String(localized: "Task titles on the Lock Screen are off by default.", bundle: .module),
        String(localized: "Psyche notifies you while it's open, and when iOS lets it check in the background.", bundle: .module),
    ].joined(separator: "\n\n")

    private func binding(_ keyPath: WritableKeyPath<PhoneSettings, Bool>, _ settings: PhoneSettings) -> Binding<Bool> {
        Binding(
            get: { settings[keyPath: keyPath] },
            set: { value in model.update { $0[keyPath: keyPath] = value } })
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
        settings: PhoneSettings(notifications: true, liveActivities: true, taskTitlesOnLockScreen: false, faceIDForApprovals: true))
}


/// "Kept awake 42 min today": read when the sheet opens and every half minute while it is open and the switch is on.
private struct AwakeTodayRow: View {
    let alerts: AlertCenter?
    let isOn: Bool
    @State private var seconds: TimeInterval = 0

    var body: some View {
        let minutes = Int(seconds / 60)
        HStack {
            if minutes > 0 {
                Text("Kept awake \(minutes) min today", bundle: .module)
            } else {
                Text("Not kept awake today", bundle: .module)
            }
            Spacer(minLength: 0)
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("keptAwakeToday")
        .task(id: isOn) {
            while !Task.isCancelled {
                seconds = await alerts?.awakeSecondsToday() ?? 0
                try? await Task.sleep(for: .seconds(isOn ? 30 : 3600))
            }
        }
    }
}


/// The technical details behind "Connected over": what this phone may do, where your Mac is and its security code.
private struct ConnectionDetailView: View {
    let device: DeviceInfo

    var body: some View {
        Form {
            Section {
                LabeledContent(String(localized: "Access", bundle: .module), value: device.scopes.joined(separator: ", "))
                LabeledContent(String(localized: "Connected over", bundle: .module), value: device.transport)
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
