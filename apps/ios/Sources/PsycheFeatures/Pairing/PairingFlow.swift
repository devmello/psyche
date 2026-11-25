import PsycheClient
import PsycheDesign
import SwiftUI
#if os(iOS)
import UIKit
#endif

/// The pairing screens: scan the code from Settings → Server & remote access → Pair another computer on the Mac. A
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

private struct ScannerView: View {
    @Environment(Session.self) private var session
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var camera = CameraAccess()

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            MothAvatar(size: 64)
            VStack(alignment: .leading, spacing: 8) {
                Text("Pair with your Mac", bundle: .module).psycheTitle(.title)
                    .foregroundStyle(PsycheColor.text)
                Text("On your Mac, open Settings → Server & remote access → Pair another computer. If it says there is no address yet, turn on Allow computers on this network and choose From this network. Then scan the code it shows.", bundle: .module)
                    .font(.subheadline).foregroundStyle(PsycheColor.muted)
            }
            viewfinder
            if let error = session.pairingError {
                Text(error).font(.footnote).foregroundStyle(PsycheColor.red)
            }
            Spacer(minLength: 0)
            actions
            alternatives
        }
        .padding(.horizontal, 28)
        .padding(.top, 56)
        .padding(.bottom, 32)
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .psycheScreen()
        .onChange(of: scenePhase) { _, phase in if phase == .active { camera.refresh() } }
    }

    @ViewBuilder
    private var viewfinder: some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        ZStack {
            switch camera.status {
            case .ready:
                #if os(iOS)
                CameraScanner { session.beginPairing(code: $0) }
                #endif
            case .undetermined:
                note(String(localized: "Psyche uses the camera only to read this code. Nothing is recorded.", bundle: .module))
            case .denied:
                note(String(localized: "Camera access is off. Turn it on in Settings to scan the code.", bundle: .module))
            case .unavailable:
                note(String(localized: "This device has no camera to scan with.", bundle: .module))
            }
        }
        .frame(maxWidth: .infinity)
        .aspectRatio(1, contentMode: .fit)
        .background(PsycheColor.sheet)
        .clipShape(shape)
        .overlay(shape.strokeBorder(PsycheColor.hairline, lineWidth: 1))
        .accessibilityLabel(String(localized: "Camera viewfinder", bundle: .module))
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(PsycheColor.muted)
            .multilineTextAlignment(.center)
            .padding(24)
    }

    @ViewBuilder
    private var actions: some View {
        switch camera.status {
        case .undetermined:
            Button(String(localized: "Allow camera", bundle: .module)) { Task { await camera.request() } }.buttonStyle(.psycheInk)
        case .denied:
            Button(String(localized: "Open Settings", bundle: .module)) {
                #if os(iOS)
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                #endif
            }
            .buttonStyle(.psycheInk)
        case .unavailable:
            EmptyView()
        case .ready:
            EmptyView()
        }
    }
}

extension ScannerView {
    /// Other ways in: a pasted link (read only from this field, never from a URL), and the fixtures.
    @ViewBuilder
    fileprivate var alternatives: some View {
        VStack(spacing: 14) {
            PasteButton(payloadType: String.self) { strings in
                Task { @MainActor in session.beginPairing(code: strings.first ?? "") }
            }
            .buttonBorderShape(.capsule)
            .tint(PsycheColor.inkText)
            .accessibilityLabel(String(localized: "Paste a pairing link", bundle: .module))
            Button(String(localized: "Try it without a Mac", bundle: .module)) { session.requestFixtureMode() }
                .font(.subheadline)
                .foregroundStyle(PsycheColor.muted)
                .accessibilityHint(String(localized: "Opens the app with sample content", bundle: .module))
        }
        .frame(maxWidth: .infinity)
    }
}

/// "Connect to studio-mac (studio-mac.tail1234.ts.net)?": nothing has been sent to the address yet.
private struct ConfirmView: View {
    let preview: PairingPreview
    @Environment(Session.self) private var session

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            MothAvatar(size: 64)
            VStack(alignment: .leading, spacing: 8) {
                Text("Connect to \(preview.hostName)?", bundle: .module).psycheTitle(.title)
                    .foregroundStyle(PsycheColor.text)
                Text(preview.host)
                    .font(.psycheMono(.subheadline))
                    .foregroundStyle(PsycheColor.muted)
                    .textSelection(.enabled)
            }
            PaperCard(padding: 18, radius: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Gateway key", bundle: .module).font(.footnote).foregroundStyle(PsycheColor.muted)
                    Text(preview.fingerprint)
                        .font(.psycheMono(.title3, weight: .semibold))
                        .foregroundStyle(PsycheColor.text)
                        .accessibilityLabel(String(localized: "Gateway key \(preview.fingerprint)", bundle: .module))
                    EvidenceLine([preview.transport.label, String(localized: "pinned from the code", bundle: .module)])
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Text("Your Mac shows the same key next to this phone's request. If they differ, don't connect.", bundle: .module)
                .font(.subheadline).foregroundStyle(PsycheColor.muted)
            Spacer(minLength: 0)
            Button(String(localized: "Connect", bundle: .module)) { session.confirmPairing() }.buttonStyle(.psycheInk)
            Button(String(localized: "Not now", bundle: .module)) { session.declinePairing() }.buttonStyle(.psycheOutline)
        }
        .padding(.horizontal, 28)
        .padding(.top, 56)
        .padding(.bottom, 32)
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .psycheScreen()
    }
}

private struct PendingView: View {
    let pending: PendingApproval
    @Environment(Session.self) private var session

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            MothAvatar(size: 64)
            VStack(alignment: .leading, spacing: 8) {
                Text("Your Mac hasn't let this phone in yet", bundle: .module).psycheTitle(.title)
                    .foregroundStyle(PsycheColor.text)
                Text("If your Mac asks, check that the code matches and approve. If it doesn't ask, scan a new pairing code.", bundle: .module)
                    .font(.subheadline).foregroundStyle(PsycheColor.muted)
            }
            PaperCard(padding: 18, radius: 16) {
                VStack(spacing: 12) {
                    Text(pending.code)
                        .font(.psycheMono(.largeTitle, weight: .semibold))
                        .tracking(4)
                        .foregroundStyle(PsycheColor.text)
                        .frame(maxWidth: .infinity)
                        .accessibilityLabel(String(localized: "Code \(pending.code.replacingOccurrences(of: " ", with: ", "))", bundle: .module))
                    HairlineDivider()
                    VStack(alignment: .leading, spacing: 4) {
                        Text(pending.endpoint.host).font(.subheadline.weight(.medium)).foregroundStyle(PsycheColor.text)
                        EvidenceLine([pending.endpoint.transport.label, "Gateway key \(pending.endpoint.fingerprint)", "pinned"])
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            VStack(alignment: .leading, spacing: 14) {
                step(done: true, String(localized: "Read the pairing code from your Mac", bundle: .module))
                step(
                    done: false,
                    Text("If your Mac asks, approve \(Text(pending.deviceName).fontWeight(.semibold)). It gets read, write and approvals, not admin.", bundle: .module))
            }
            Spacer(minLength: 0)
            StatusDot(.needsYou, String(localized: "Waiting for your Mac", bundle: .module), textColor: PsycheColor.muted, font: .subheadline)
                .frame(maxWidth: .infinity)
            Button(String(localized: "Cancel", bundle: .module)) { session.cancelPairing() }.buttonStyle(.psycheOutline)
        }
        .padding(.horizontal, 28)
        .padding(.top, 56)
        .padding(.bottom, 32)
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .psycheScreen()
    }

    private func step(done: Bool, _ text: String) -> some View {
        step(done: done, Text(text))
    }

    private func step(done: Bool, _ text: Text) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                // The step waiting on the owner is amber (needs you); a finished one is a gray check.
                Circle().fill(done ? PsycheColor.muted : PsycheColor.amber)
                if done {
                    Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(PsycheColor.sheet)
                } else {
                    Text("2").font(.caption.weight(.semibold)).foregroundStyle(Color.black.opacity(0.8))
                }
            }
            .frame(width: 22, height: 22)
            .accessibilityHidden(true)
            text.font(.subheadline).foregroundStyle(PsycheColor.text)
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
        VStack(alignment: .leading, spacing: 28) {
            MothAvatar(size: 64)
            VStack(alignment: .leading, spacing: 8) {
                Text("Pairing with \(attempt.hostName)", bundle: .module).psycheTitle(.title)
                    .foregroundStyle(PsycheColor.text)
                if reachable {
                    Text("Connecting to \(attempt.host)…", bundle: .module)
                        .font(.subheadline).foregroundStyle(PsycheColor.muted)
                } else {
                    Text("Can't reach your Mac at \(attempt.host). Check that it's on and awake and on the same network as this phone. Psyche keeps trying until you cancel.", bundle: .module)
                        .font(.subheadline).foregroundStyle(PsycheColor.muted)
                }
            }
            Spacer(minLength: 0)
            if reachable {
                ProgressView().frame(maxWidth: .infinity)
            } else {
                StatusDot(.needsYou, String(localized: "Waiting for your Mac", bundle: .module), textColor: PsycheColor.muted, font: .subheadline)
                    .frame(maxWidth: .infinity)
            }
            Button(String(localized: "Cancel", bundle: .module)) { session.cancelPairing() }.buttonStyle(.psycheOutline)
        }
        .padding(.horizontal, 28)
        .padding(.top, 56)
        .padding(.bottom, 32)
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .psycheScreen()
    }
}

/// `refused(.identityMismatch)` or `refused(.identityChanged)`: a full-screen stop (companion M1 acceptance 2). Nothing is ever sent to the Mac that
/// answered, and the phone doesn't retry it. The way out is to forget the saved Gateway and pair again, because the
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
                Text("This isn't your Gateway.", bundle: .module).psycheTitle(.title).foregroundStyle(PsycheColor.text)
                Text("The Mac that answered isn't the one this phone was paired with, so Psyche stopped. Nothing was sent to it.", bundle: .module)
                    .font(.subheadline).foregroundStyle(PsycheColor.muted)
            case .identityChanged:
                Text("Psyche can't confirm your Mac.", bundle: .module).psycheTitle(.title).foregroundStyle(PsycheColor.text)
                Text("Psyche found a different device at your Mac's address, so it sent nothing. If you're on another network, or another device took this address, Psyche keeps trying. Pair again only if you reset or reinstalled Psyche on your Mac.", bundle: .module)
                    .font(.subheadline).foregroundStyle(PsycheColor.muted)
            }
            if reason == .identityMismatch {
                Text("If you reset or reinstalled Psyche on your Mac, it has a new identity, and this phone has to pair with it again.", bundle: .module)
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
