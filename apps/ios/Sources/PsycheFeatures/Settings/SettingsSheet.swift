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
        } catch {
            notice = "\(error.localizedDescription) You can also remove this phone in Settings \u{2192} Devices on your Mac."
            return false
        }
    }
}

/// The phone's own settings (docs/design/ios-app-2026.md §4.7). Everything else says "Change this on
/// your Mac": the phone has no admin scope.
struct SettingsSheet: View {
    @State private var model: SettingsModel
    @Environment(Session.self) private var session
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
            Text("Open Settings \u{2192} Devices \u{2192} Add phone on your Mac, then scan the code it shows.")
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
            infoRow("Gateway", device.gatewayHost, mono: true)
            infoRow("Fingerprint", device.gatewayFingerprint, mono: true)
            infoRow("Connection", device.transport, last: true)
        }

        section("Notifications", footer: "Task titles on the Lock Screen are off by default. When on, titles travel to your phone as plain text through Apple's push service.") {
            toggleRow("Notifications", isOn: binding(\.notifications, settings))
            toggleRow("Live Activities", isOn: binding(\.liveActivities, settings), disabled: !settings.notifications)
            toggleRow(
                "Task titles on the Lock Screen", isOn: binding(\.taskTitlesOnLockScreen, settings),
                disabled: !settings.notifications || !settings.liveActivities, last: true)
        }

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

    private func section<Body: View>(
        _ title: String, footer: String? = nil, @ViewBuilder content: () -> Body
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title)
            PaperCard { content() }
            if let footer {
                Text(footer).font(.footnote).foregroundStyle(PsycheColor.muted).padding(.horizontal, 2)
            }
        }
    }

    private func infoRow(_ title: String, _ value: String, mono: Bool = false, last: Bool = false) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                Spacer(minLength: 12)
                Text(value)
                    .font(mono ? .psycheMono(.footnote) : .subheadline)
                    .foregroundStyle(PsycheColor.muted)
                    .multilineTextAlignment(.trailing)
                    .textSelection(.enabled)
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
