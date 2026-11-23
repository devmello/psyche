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
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        _model = State(initialValue: SettingsModel(store: store))
        self.store = store
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
                            Text("Couldn't load this", bundle: .module).font(.headline)
                            Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
                            Button(String(localized: "Try again", bundle: .module)) { Task { await model.load() } }
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
            .navigationTitle(String(localized: "Settings", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Done", bundle: .module)) { dismiss() }
                }
            }
        }
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

        section(String(localized: "This phone", bundle: .module)) {
            infoRow(String(localized: "Name", bundle: .module), device.name)
            infoRow(String(localized: "Access", bundle: .module), device.scopes.joined(separator: ", "))
            infoRow(String(localized: "Gateway", bundle: .module), device.gatewayHost, mono: true, stacked: true)
            infoRow(String(localized: "Fingerprint", bundle: .module), device.gatewayFingerprint, mono: true, stacked: true)
            infoRow(String(localized: "Connection", bundle: .module), device.transport, last: true)
        }

        section(String(localized: "Notifications", bundle: .module), footer: Self.notificationsFooter) {
            toggleRow(String(localized: "Notifications", bundle: .module), isOn: notificationsBinding(settings))
            toggleRow(String(localized: "Live Activities", bundle: .module), isOn: liveActivitiesBinding(settings), disabled: !settings.notifications)
            toggleRow(
                String(localized: "Task titles on the Lock Screen", bundle: .module), isOn: binding(\.taskTitlesOnLockScreen, settings),
                disabled: !settings.notifications || !settings.liveActivities, last: true)
        }

        stayConnectedSection(settings)

        section("Approvals", footer: String(localized: "Asks for Face ID before you allow a risky action from this phone.", bundle: .module)) {
            toggleRow(String(localized: "Face ID for approvals", bundle: .module), isOn: binding(\.faceIDForApprovals, settings), last: true)
        }

        section(String(localized: "Model", bundle: .module)) {
            NavigationLink { DefaultModelView(store: store) } label: {
                linkRow(String(localized: "Default model", bundle: .module))
            }
            .buttonStyle(.plain)
            NavigationLink { UsageView(store: store) } label: {
                linkRow(String(localized: "Usage", bundle: .module), last: true)
            }
            .buttonStyle(.plain)
        }

        computersSection(loaded.machines)

        section(String(localized: "Skills", bundle: .module)) {
            NavigationLink { SkillsView(store: store) } label: { actionRow(String(localized: "Skills", bundle: .module), destructive: false) }
                .buttonStyle(.plain)
        }

        section(String(localized: "Gateway", bundle: .module)) {
            Button { confirmingRepair = true } label: { actionRow(String(localized: "Re-pair with your Mac", bundle: .module), destructive: false) }
                .buttonStyle(.plain)
            HairlineDivider()
            Button { confirmingRemove = true } label: { actionRow(String(localized: "Remove this phone", bundle: .module), destructive: true) }
                .buttonStyle(.plain)
                .disabled(model.removing)
        }

        section(String(localized: "Appearance", bundle: .module)) {
            infoRow("Theme", String(localized: "Follows your system", bundle: .module), last: true)
        }

        section(String(localized: "About", bundle: .module)) {
            infoRow(String(localized: "Version", bundle: .module), Self.version, mono: true, last: true)
        }

        EditOnMacNote(text: String(localized: "Change everything else on your Mac, in Settings.", bundle: .module))
    }

    /// "Computers Psyche can use": read-only. Adding or pairing one is done on the Mac.
    private func computersSection(_ machines: [MachineSummary]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(String(localized: "Computers Psyche can use", bundle: .module))
            PaperStack {
                if machines.isEmpty {
                    Text("No computers added yet.", bundle: .module)
                        .font(.subheadline).foregroundStyle(PsycheColor.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(PsycheMetrics.rowPadding)
                } else {
                    ForEach(Array(machines.enumerated()), id: \.element.id) { index, machine in
                        VStack(spacing: 0) {
                            HStack(alignment: .firstTextBaseline, spacing: 12) {
                                Text(machine.name).font(.psycheRow).foregroundStyle(PsycheColor.text)
                                Spacer(minLength: 12)
                                Self.statusText(machine.status)
                                    .font(.subheadline).foregroundStyle(PsycheColor.muted)
                            }
                            .padding(PsycheMetrics.rowPadding)
                            if index < machines.count - 1 { HairlineDivider() }
                        }
                        .accessibilityElement(children: .combine)
                    }
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
                "Keeps Psyche running in the background, with a silent audio session, only while a task or chat reply you're watching runs or waits for you. It uses some battery, and stops on Low Power Mode or when the battery is below 20 percent and unplugged.",
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

    /// A row that opens a screen: its title, then a disclosure chevron.
    private func linkRow(_ title: String, last: Bool = false) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text(title).font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(PsycheColor.muted)
            }
            .padding(PsycheMetrics.rowPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
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
                        model.notice = String(localized: "Notifications are off for Psyche in the iOS Settings app. Turn them on there, then try again.", bundle: .module)
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
                    model.notice = String(localized: "Live Activities are off for Psyche in the iOS Settings app. Turn them on there to see tasks on the Lock Screen.", bundle: .module)
                }
            })
    }

    static let notificationsFooter = [
        String(localized: "Task titles on the Lock Screen are off by default.", bundle: .module),
        String(localized: "Without an Apple Developer account, Psyche can only notify you while it's open or when iOS lets it check in the background.", bundle: .module),
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
