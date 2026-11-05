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
    }

    private(set) var phase: LoadPhase<Loaded> = .idle
    var notice: String?
    /// Set when the Gateway could not be reached for "Remove this phone": the owner may still wipe this phone only.
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
            phase = .loaded(Loaded(device: try await device, settings: try await settings))
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

/// The phone's own settings (docs/design/ios-app-2026.md §4.7). Everything else says "Change this on
/// your Mac": the phone has no admin scope.
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
            ScrollView {
                VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                    switch model.phase {
                    case .idle, .loading:
                        content(.skeleton).redacted(reason: .placeholder).allowsHitTesting(false)
                    case .loaded(let loaded):
                        content(loaded)
                    case .failed(let message):
                        VStack(spacing: 12) {
                            Text("Couldn't load this").font(.headline)
                            Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
                            Button("Try again") { Task { await model.load() } }
                                .buttonStyle(.psycheOutline).frame(maxWidth: 220)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 40)
                    }
                }
                .padding(.horizontal, PsycheMetrics.pagePadding)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .psycheScreen()
            .navigationTitle("Settings")
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDragIndicator(.visible)
        .task {
            await model.load()
            await model.observe()
        }
        .alert("Couldn't do that", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.notice ?? "")
        }
        .confirmationDialog("Re-pair with your Mac?", isPresented: $confirmingRepair, titleVisibility: .visible) {
            Button("Scan a new code") {
                dismiss()
                session.cancelPairing()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Open Settings \u{2192} Server & remote access \u{2192} Pair another computer on your Mac, then scan the code it shows.")
        }
        .confirmationDialog(
            "Your Mac isn't reachable right now.", isPresented: $model.offeringLocalRemoval, titleVisibility: .visible
        ) {
            Button("Remove from this phone only", role: .destructive) {
                Task {
                    if await model.removeThisPhoneLocally() {
                        dismiss()
                        session.markRevoked()
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This phone can clear its keys and saved data now, but your Mac will keep listing it until you remove it in Settings \u{2192} Devices there.")
        }
        .confirmationDialog("Remove this phone?", isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button("Remove this phone", role: .destructive) {
                Task {
                    if await model.removeThisPhone() {
                        dismiss()
                        session.markRevoked()
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your Mac forgets this phone and this phone clears everything it saved. You'll pair again to use Psyche here.")
        }
    }

    // MARK: Sections

    @ViewBuilder
    private func content(_ loaded: SettingsModel.Loaded) -> some View {
        let device = loaded.device
        let settings = loaded.settings

        section("This phone") {
            infoRow("Name", device.name)
            infoRow("Access", device.scopes.joined(separator: ", "))
            infoRow("Gateway", device.gatewayHost, mono: true, stacked: true)
            infoRow("Fingerprint", device.gatewayFingerprint, mono: true, stacked: true)
            infoRow("Connection", device.transport, last: true)
        }

        section("Notifications", footer: Self.notificationsFooter) {
            toggleRow("Notifications", isOn: notificationsBinding(settings))
            toggleRow("Live Activities", isOn: liveActivitiesBinding(settings), disabled: !settings.notifications)
            toggleRow(
                "Task titles on the Lock Screen", isOn: binding(\.taskTitlesOnLockScreen, settings),
                disabled: !settings.notifications || !settings.liveActivities, last: true)
        }

        stayConnectedSection(settings)

        section("Approvals", footer: "Asks for Face ID before you allow a risky action from this phone.") {
            toggleRow("Face ID for approvals", isOn: binding(\.faceIDForApprovals, settings), last: true)
        }

        section("Gateway") {
            Button { confirmingRepair = true } label: { actionRow("Re-pair with your Mac", destructive: false) }
                .buttonStyle(.plain)
            HairlineDivider()
            Button { confirmingRemove = true } label: { actionRow("Remove this phone", destructive: true) }
                .buttonStyle(.plain)
                .disabled(model.removing)
        }

        section("Appearance") {
            infoRow("Theme", "Follows your system", last: true)
        }

        section("About") {
            infoRow("Version", Self.version, mono: true, last: true)
        }

        EditOnMacNote(text: "Change everything else on your Mac, in Settings.")
    }

    /// "Stay connected while a task runs" (off by default), its battery note, and what it has cost today.
    private func stayConnectedSection(_ settings: PhoneSettings) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(String(localized: "Background", bundle: .module))
            PaperStack {
                Toggle(isOn: binding(\.stayConnectedWhileRunning, settings)) {
                    Text("Stay connected while a task runs", bundle: .module)
                }
                .font(.psycheRow)
                .foregroundStyle(PsycheColor.text)
                .tint(PsycheColor.muted)
                .disabled(!settings.notifications || !settings.liveActivities)
                .padding(PsycheMetrics.rowPadding)
                .accessibilityIdentifier("stayConnectedToggle")
                HairlineDivider()
                AwakeTodayRow(alerts: alerts, isOn: settings.stayConnectedWhileRunning)
            }
            Text(
                "Keeps Psyche running in the background, with a silent audio session, only while a task you're watching runs or waits for you. It uses some battery, and stops on Low Power Mode or when the battery is under 20% and unplugged.",
                bundle: .module
            )
            .font(.footnote).foregroundStyle(PsycheColor.muted).padding(.horizontal, 2)
        }
    }

    private func section<Body: View>(
        _ title: String, footer: String? = nil, @ViewBuilder content: () -> Body
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title)
            PaperStack { content() }
            if let footer {
                Text(footer).font(.footnote).foregroundStyle(PsycheColor.muted).padding(.horizontal, 2)
            }
        }
    }

    /// A label and its value. Long values (host, fingerprint) go under the label so they never truncate.
    private func infoRow(
        _ title: String, _ value: String, mono: Bool = false, stacked: Bool = false, last: Bool = false
    ) -> some View {
        let valueText = Text(value)
            .font(mono ? .psycheMono(.footnote) : .subheadline)
            .foregroundStyle(PsycheColor.muted)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        return VStack(spacing: 0) {
            Group {
                if stacked {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                        valueText
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                        Spacer(minLength: 12)
                        valueText.multilineTextAlignment(.trailing)
                    }
                }
            }
            .padding(PsycheMetrics.rowPadding)
            if !last { HairlineDivider() }
        }
        .accessibilityElement(children: .combine)
    }

    private func toggleRow(_ title: String, isOn: Binding<Bool>, disabled: Bool = false, last: Bool = false) -> some View {
        VStack(spacing: 0) {
            Toggle(title, isOn: isOn)
                .font(.psycheRow)
                .foregroundStyle(PsycheColor.text)
                .tint(PsycheColor.muted)  // a quiet track: the ink fill is for the screen's one action
                .disabled(disabled)
                .padding(PsycheMetrics.rowPadding)
            if !last { HairlineDivider() }
        }
    }

    private func actionRow(_ title: String, destructive: Bool) -> some View {
        HStack {
            Text(title).font(.psycheRow.weight(.medium))
                .foregroundStyle(destructive ? PsycheColor.red : PsycheColor.inkText)
            Spacer(minLength: 0)
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
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
                        model.notice = "Notifications are off for Psyche in the iOS Settings app. Turn them on there, then try again."
                    }
                }
            })
    }

    private func liveActivitiesBinding(_ settings: PhoneSettings) -> Binding<Bool> {
        Binding(
            get: { settings.liveActivities },
            set: { value in
                model.update { $0.liveActivities = value }
                if value, let alerts, !alerts.liveActivitiesAllowedBySystem {
                    model.notice = "Live Activities are off for Psyche in the iOS Settings app. Turn them on there to see tasks on the Lock Screen."
                }
            })
    }

    static let notificationsFooter = """
        Task titles on the Lock Screen are off by default.

        Without an Apple Developer account, Psyche can only notify you while it's open or when iOS lets it check in the background.
        """

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
        .foregroundStyle(PsycheColor.muted)
        .padding(PsycheMetrics.rowPadding)
        .accessibilityIdentifier("keptAwakeToday")
        .task(id: isOn) {
            while !Task.isCancelled {
                seconds = await alerts?.awakeSecondsToday() ?? 0
                try? await Task.sleep(for: .seconds(isOn ? 30 : 3600))
            }
        }
    }
}
