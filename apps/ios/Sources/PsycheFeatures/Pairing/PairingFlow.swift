import PsycheClient
import PsycheDesign
import SwiftUI
#if os(iOS)
import UIKit
#endif

/// The pairing screens: scan the code from Settings → Devices on the Mac, then wait for the Mac's approval.
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
                Text("Pair with your Mac").psycheTitle(.title)
                    .foregroundStyle(PsycheColor.text)
                Text("On your Mac, open Settings → Server & remote access → Pair another computer. Then scan the code it shows.")
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
                note("Psyche uses the camera only to read this code. Nothing is recorded.")
            case .denied:
                note("Camera access is off. Turn it on in Settings to scan the code.")
            case .unavailable:
                note("This device has no camera to scan with.")
            }
        }
        .frame(maxWidth: .infinity)
        .aspectRatio(1, contentMode: .fit)
        .background(PsycheColor.sheet)
        .clipShape(shape)
        .overlay(shape.strokeBorder(PsycheColor.hairline, lineWidth: 1))
        .accessibilityLabel("Camera viewfinder")
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
            Button("Allow camera") { Task { await camera.request() } }.buttonStyle(.psycheInk)
        case .denied:
            Button("Open Settings") {
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
            .accessibilityLabel("Paste a pairing link")
            Button("Try it without a Mac") { session.requestFixtureMode() }
                .font(.subheadline)
                .foregroundStyle(PsycheColor.muted)
                .accessibilityHint("Opens the app with sample content")
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
                Text("Connect to \(preview.hostName)?").psycheTitle(.title)
                    .foregroundStyle(PsycheColor.text)
                Text(preview.host)
                    .font(.psycheMono(.subheadline))
                    .foregroundStyle(PsycheColor.muted)
                    .textSelection(.enabled)
            }
            PaperCard(padding: 18, radius: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Gateway key").font(.footnote).foregroundStyle(PsycheColor.muted)
                    Text(preview.fingerprint)
                        .font(.psycheMono(.title3, weight: .semibold))
                        .foregroundStyle(PsycheColor.text)
                        .accessibilityLabel("Gateway key \(preview.fingerprint)")
                    EvidenceLine([preview.transport.label, "pinned from the code"])
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Text("Your Mac shows the same key next to this phone's request. If they differ, don't connect.")
                .font(.subheadline).foregroundStyle(PsycheColor.muted)
            Spacer(minLength: 0)
            Button("Connect") { session.confirmPairing() }.buttonStyle(.psycheInk)
            Button("Not now") { session.declinePairing() }.buttonStyle(.psycheOutline)
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
                Text("Approve this phone on your Mac").psycheTitle(.title)
                    .foregroundStyle(PsycheColor.text)
                Text("Psyche on your Mac is asking whether to let this phone in. Check that the code matches.")
                    .font(.subheadline).foregroundStyle(PsycheColor.muted)
            }
            PaperCard(padding: 18, radius: 16) {
                VStack(spacing: 12) {
                    Text(pending.code)
                        .font(.psycheMono(.largeTitle, weight: .semibold))
                        .tracking(4)
                        .foregroundStyle(PsycheColor.text)
                        .frame(maxWidth: .infinity)
                        .accessibilityLabel("Code \(pending.code.replacingOccurrences(of: " ", with: ", "))")
                    HairlineDivider()
                    VStack(alignment: .leading, spacing: 4) {
                        Text(pending.endpoint.host).font(.subheadline.weight(.medium)).foregroundStyle(PsycheColor.text)
                        EvidenceLine([pending.endpoint.transport.label, "Gateway key \(pending.endpoint.fingerprint)", "pinned"])
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            VStack(alignment: .leading, spacing: 14) {
                step(done: true, "Scanned the code from Settings → Devices")
                step(
                    done: false,
                    Text("On your Mac, approve \(Text(pending.deviceName).fontWeight(.semibold)). It gets read, write and approvals, not admin."))
            }
            Spacer(minLength: 0)
            StatusDot(.needsYou, "Waiting for your Mac", textColor: PsycheColor.muted, font: .subheadline)
                .frame(maxWidth: .infinity)
            Button("Cancel") { session.cancelPairing() }.buttonStyle(.psycheOutline)
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
                Circle().fill(done ? PsycheColor.muted : PsycheColor.fill)
                if done {
                    Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(PsycheColor.sheet)
                } else {
                    Text("2").font(.caption.weight(.semibold)).foregroundStyle(PsycheColor.muted)
                }
            }
            .frame(width: 22, height: 22)
            .accessibilityHidden(true)
            text.font(.subheadline).foregroundStyle(PsycheColor.text)
        }
    }
}

/// `refused(.identityMismatch)`: a full-screen stop with no retry (companion M1 acceptance 2).
struct RefusedView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            MothAvatar(size: 64)
            Text("This isn't your Gateway.").psycheTitle(.title).foregroundStyle(PsycheColor.text)
            Text("The Mac that answered isn't the one this phone was paired with, so Psyche stopped. Nothing was sent to it.")
                .font(.subheadline).foregroundStyle(PsycheColor.muted)
        }
        .padding(.horizontal, 28)
        .frame(maxWidth: 560, maxHeight: .infinity, alignment: .leading)
        .frame(maxWidth: .infinity)
        .psycheScreen()
    }
}
