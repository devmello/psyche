import PsycheClient
import PsycheDesign
import PsycheShared
import SwiftUI
#if os(iOS)
import UIKit
#endif

/// The pairing screens: scan the code from Settings > Devices > Pair iPhone on the Mac. A
/// valid code pairs at once; the Mac is asked to approve this phone only when it did not accept the code.
struct PairingFlow: View {
    @Environment(Session.self) private var session

    var body: some View {
        Group {
            if case .pending(let pending) = session.state {
                PendingView(pending: pending)
            } else if let preview = session.pairingPreview {
                ConfirmView(preview: preview)
            } else {
                ScannerView()
            }
        }
        .tint(PsycheColor.inkText)
    }
}

/// Plain words for how the phone reaches the Mac. The technical name stays in the Details.
private func connectedOver(_ transport: GatewayEndpoint.Transport) -> String {
    switch transport {
    case .lan: String(localized: "Connected over your home network", bundle: .module)
    case .tailscale: String(localized: "Connected over a private network", bundle: .module)
    }
}

/// Shared frame of the pairing screens: the content scrolls (so large text never hides a button) and the
/// buttons stay at the bottom.
private struct PairingScaffold<Content: View, Footer: View>: View {
    let content: Content
    let footer: Footer

    init(@ViewBuilder content: () -> Content, @ViewBuilder footer: () -> Footer) {
        self.content = content()
        self.footer = footer()
    }

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // At accessibility text sizes the buttons scroll with the content, so they never cover half the screen.
        let pinned = !typeSize.isAccessibilitySize
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                MothAvatar(size: 56)
                content
                if !pinned { VStack(spacing: 12) { footer }.padding(.top, 8) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 28)
            .padding(.top, 40)
            .padding(.bottom, 16)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if pinned {
                VStack(spacing: 12) { footer }
                    .padding(.horizontal, 28)
                    .padding(.vertical, 16)
                    .frame(maxWidth: 560)
                    .frame(maxWidth: .infinity)
                    .background(.bar)
            }
        }
        .psycheScreen()
    }
}

/// Technical facts, folded away until asked for.
private struct DetailsDisclosure: View {
    let rows: [(label: String, value: String)]
    @State private var open = false

    var body: some View {
        DisclosureGroup(isExpanded: $open) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(rows.indices, id: \.self) { index in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(rows[index].label).font(.footnote).foregroundStyle(PsycheColor.muted)
                        Text(rows[index].value)
                            .font(.psycheMono(.footnote))
                            .foregroundStyle(PsycheColor.text)
                            .textSelection(.enabled)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 8)
        } label: {
            Text("Details", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
        }
    }
}

private struct ScannerView: View {
    @Environment(Session.self) private var session
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var camera = CameraAccess()
    @State private var enteringCode = false

    var body: some View {
        PairingScaffold {
            Text("Scan the code on your Mac.", bundle: .module).psycheTitle(.title)
                .foregroundStyle(PsycheColor.text)
                .accessibilityIdentifier("pairing.scan.title")
            viewfinder
            if let error = session.pairingError {
                Text(error).font(.footnote).foregroundStyle(PsycheColor.red)
            }
            Text("On your Mac: Settings > Devices > Pair iPhone.", bundle: .module)
                .font(.footnote).foregroundStyle(PsycheColor.muted)
        } footer: {
            Button(String(localized: "Enter code by hand", bundle: .module)) { enteringCode = true }
                .font(.subheadline)
                .accessibilityIdentifier("pairing.enter-code")
            Button(String(localized: "Try the demo", bundle: .module)) { session.requestFixtureMode() }
                .font(.subheadline)
                .accessibilityHint(String(localized: "Opens the app with sample content", bundle: .module))
        }
        .onChange(of: scenePhase) { _, phase in if phase == .active { camera.refresh() } }
        .sheet(isPresented: $enteringCode) { CodeEntrySheet() }
    }

    @ViewBuilder
    private var viewfinder: some View {
        let shape = RoundedRectangle(cornerRadius: 24, style: .continuous)
        ZStack {
            switch camera.status {
            case .ready:
                #if os(iOS)
                CameraScanner { session.beginPairing(code: $0) }
                #endif
            case .undetermined:
                note(
                    symbol: "qrcode.viewfinder",
                    text: String(localized: "Psyche uses the camera only to read this code. Nothing is recorded.", bundle: .module),
                    button: String(localized: "Scan the code", bundle: .module)
                ) { Task { await camera.request() } }
            case .denied:
                note(
                    symbol: "camera.fill",
                    text: String(localized: "Camera access is off. Turn it on in Settings to scan the code.", bundle: .module),
                    button: String(localized: "Open Settings", bundle: .module)
                ) {
                    #if os(iOS)
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    #endif
                }
            case .unavailable:
                note(
                    symbol: "camera.fill",
                    text: String(localized: "This device has no camera to scan with.", bundle: .module),
                    button: nil
                ) {}
            }
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: 280)
        .background(PsycheColor.sheet)
        .clipShape(shape)
        .overlay(shape.strokeBorder(PsycheColor.hairline, lineWidth: 1))
        .accessibilityElement(children: camera.status == .ready ? .ignore : .contain)
        .accessibilityLabel(camera.status == .ready ? String(localized: "Camera viewfinder", bundle: .module) : "")
    }

    private func note(symbol: String, text: String, button: String?, action: @escaping () -> Void) -> some View {
        VStack(spacing: 16) {
            Image(systemName: symbol)
                .font(.largeTitle)
                .foregroundStyle(PsycheColor.muted)
                .accessibilityHidden(true)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(PsycheColor.muted)
                .multilineTextAlignment(.center)
            if let button {
                Button(button, action: action).buttonStyle(.psycheInk)
            }
        }
        .padding(24)
    }
}

/// Typing or pasting the pairing link, for when the camera can't read the code. The link is read only from this
/// field or the paste button, never from a URL the phone opens.
private struct CodeEntrySheet: View {
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(String(localized: "Paste a pairing link", bundle: .module), text: $text, axis: .vertical)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .autocorrectionDisabled()
                        .font(.psycheMono(.footnote))
                        .lineLimit(1...4)
                        .accessibilityIdentifier("pairing.code-field")
                    PasteButton(payloadType: String.self) { strings in
                        Task { @MainActor in text = strings.first ?? "" }
                    }
                    .accessibilityLabel(String(localized: "Paste a pairing link", bundle: .module))
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Copy the pairing link on your Mac, then paste it here.", bundle: .module)
                        if let error = session.pairingError {
                            Text(error).foregroundStyle(PsycheColor.red)
                        }
                    }
                }
            }
            .navigationTitle(Text("Enter a code", bundle: .module))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel", bundle: .module)) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Connect", bundle: .module)) { session.beginPairing(code: text) }
                        .accessibilityIdentifier("pairing.code-connect")
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear { session.clearPairingError() }
    }
}

/// "Connect to studio-mac?": nothing has been sent to the address yet.
private struct ConfirmView: View {
    let preview: PairingPreview
    @Environment(Session.self) private var session

    var body: some View {
        PairingScaffold {
            Text("Connect to \(preview.hostName)?", bundle: .module).psycheTitle(.title)
                .foregroundStyle(PsycheColor.text)
                .accessibilityIdentifier("pairing.confirm.title")
            PaperCard(padding: 18, radius: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Security code", bundle: .module).font(.footnote).foregroundStyle(PsycheColor.muted)
                    Text(preview.fingerprint)
                        .font(.psycheMono(.title3, weight: .semibold))
                        .foregroundStyle(PsycheColor.text)
                        .accessibilityLabel(String(localized: "Security code \(preview.fingerprint)", bundle: .module))
                    Text(connectedOver(preview.transport)).font(.footnote).foregroundStyle(PsycheColor.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Text("Your Mac shows the same security code next to this phone's request. If they differ, don't connect.", bundle: .module)
                .font(.subheadline).foregroundStyle(PsycheColor.muted)
            DetailsDisclosure(rows: [
                (String(localized: "Address", bundle: .module), preview.host),
                (String(localized: "Connection", bundle: .module), preview.transport.label),
            ])
        } footer: {
            Button(String(localized: "Connect", bundle: .module)) { session.confirmPairing() }.buttonStyle(.psycheInk)
            Button(String(localized: "Not now", bundle: .module)) { session.declinePairing() }.buttonStyle(.psycheOutline)
        }
    }
}

private struct PendingView: View {
    let pending: PendingApproval
    @Environment(Session.self) private var session

    var body: some View {
        PairingScaffold {
            VStack(alignment: .leading, spacing: 8) {
                Text("Approve this iPhone on your Mac", bundle: .module).psycheTitle(.title)
                    .foregroundStyle(PsycheColor.text)
            }
            PaperCard(padding: 18, radius: 16) {
                VStack(spacing: 12) {
                    Text("Security code", bundle: .module).font(.footnote).foregroundStyle(PsycheColor.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(pending.code)
                        .font(.psycheMono(.largeTitle, weight: .semibold))
                        .tracking(4)
                        .foregroundStyle(PsycheColor.text)
                        .frame(maxWidth: .infinity)
                        .accessibilityLabel(String(localized: "Security code \(pending.code.replacingOccurrences(of: " ", with: ", "))", bundle: .module))
                }
            }
        } footer: {
            StatusDot(.needsYou, String(localized: "Waiting for your Mac", bundle: .module), textColor: PsycheColor.muted, font: .subheadline)
                .frame(maxWidth: .infinity)
            Button(String(localized: "Cancel", bundle: .module)) { session.cancelPairing() }.buttonStyle(.psycheOutline)
        }
    }
}

/// A pairing the person confirmed that has not reached the Mac: still connecting, or the Mac can't be reached at
/// that address. The phone never completed pairing, so there is nothing to show but a way out.
struct PairingProgressView: View {
    let attempt: Session.PairingAttempt
    let reachable: Bool
    @Environment(Session.self) private var session

    var body: some View {
        PairingScaffold {
            VStack(alignment: .leading, spacing: 8) {
                Text("Pairing with \(attempt.hostName)", bundle: .module).psycheTitle(.title)
                    .foregroundStyle(PsycheColor.text)
                if reachable {
                    Text("Connecting to your Mac…", bundle: .module)
                        .font(.subheadline).foregroundStyle(PsycheColor.muted)
                } else {
                    Text("Can't reach your Mac. Check that it's on and awake, and on the same Wi-Fi as this iPhone. Psyche keeps trying until you cancel.", bundle: .module)
                        .font(.subheadline).foregroundStyle(PsycheColor.muted)
                        .accessibilityIdentifier("pairing.unreachable")
                }
            }
            DetailsDisclosure(rows: [(String(localized: "Address", bundle: .module), attempt.host)])
        } footer: {
            if reachable {
                ProgressView().frame(maxWidth: .infinity)
            } else {
                StatusDot(.needsYou, String(localized: "Waiting for your Mac", bundle: .module), textColor: PsycheColor.muted, font: .subheadline)
                    .frame(maxWidth: .infinity)
            }
            Button(String(localized: "Cancel", bundle: .module)) { session.cancelPairing() }.buttonStyle(.psycheOutline)
        }
    }
}

/// `refused(.identityMismatch)` or `refused(.identityChanged)`: a full-screen stop (companion M1 acceptance 2). Nothing is ever sent to the Mac that
/// answered, and the phone doesn't retry it. The way out is to forget the saved Mac and pair again, because the
/// usual cause is a Mac that was reset or reinstalled and so has a new identity.
struct RefusedView: View {
    let reason: RefusalReason
    @Environment(Session.self) private var session
    @State private var confirming = false
    @State private var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            MothAvatar(size: 64)
            switch reason {
            case .identityMismatch:
                Text("This isn't the Mac you paired with.", bundle: .module).psycheTitle(.title).foregroundStyle(PsycheColor.text)
                    .accessibilityIdentifier("pairing.refused.mismatch")
                Text("Psyche stopped and sent nothing. If you reset your Mac, pair again.", bundle: .module)
                    .font(.subheadline).foregroundStyle(PsycheColor.muted)
            case .identityChanged:
                Text("Psyche can't confirm your Mac.", bundle: .module).psycheTitle(.title).foregroundStyle(PsycheColor.text)
                    .accessibilityIdentifier("pairing.refused.changed")
                Text("Psyche sent nothing and keeps trying. If you reset your Mac, pair again.", bundle: .module)
                    .font(.subheadline).foregroundStyle(PsycheColor.muted)
            }
            Spacer(minLength: 0)
            if reason == .identityChanged {
                // Primary: dial again now. The phone also keeps trying by itself, and goes back to normal when the real Mac answers.
                Button(String(localized: "Try again", bundle: .module)) { session.retryConnection() }
                    .buttonStyle(.psycheInk)
                Button(String(localized: "Pair again", bundle: .module)) { confirming = true }
                    .buttonStyle(.psycheOutline)
                    .disabled(working)
            } else {
                Button(String(localized: "Pair again", bundle: .module)) { confirming = true }
                    .buttonStyle(.psycheInk)
                    .disabled(working)
            }
        }
        .padding(.horizontal, 28)
        .padding(.top, 56)
        .padding(.bottom, 32)
        .frame(maxWidth: 560, maxHeight: .infinity, alignment: .leading)
        .frame(maxWidth: .infinity)
        .psycheScreen()
        .confirmationDialog(String(localized: "Pair this phone again?", bundle: .module), isPresented: $confirming, titleVisibility: .visible) {
            Button(String(localized: "Pair again", bundle: .module), role: .destructive) {
                working = true
                Task {
                    await session.forgetGateway()
                    working = false
                }
            }
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
        } message: {
            Text("This phone forgets the Mac it was paired with and clears what it saved. Then you scan a new code on your Mac.", bundle: .module)
        }
    }
}
