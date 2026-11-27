import PsycheClient
import PsycheDesign
import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

/// What the connection looks like on a screen (docs/design/ios-app-2026.md §3.2).
/// - `connecting`: nothing for the first 1.5 s (no flash), then a quiet "Connecting…".
/// - `unreachable`: one compact row, with the cause under "Details"; cached content stays readable underneath.
/// - Every other state is a full-screen stop or the pairing flow, drawn by `RootView`, so this draws nothing.
struct ConnectionBanner: View {
    let state: ConnectionState
    let lastSyncedAt: Date?

    var body: some View {
        switch state {
        case .connecting:
            ConnectingLine()
        case .unreachable(let reason):
            UnreachableBanner(reason: reason, lastSyncedAt: lastSyncedAt)
        case .unpaired, .pending, .live, .refused, .revoked:
            EmptyView()
        }
    }
}

/// "Connecting…" after 1.5 s, so a quick connect never flashes anything.
private struct ConnectingLine: View {
    @State private var visible = false

    var body: some View {
        HStack(spacing: 8) {
            if visible {
                ProgressView().controlSize(.small)
                Text("Connecting…", bundle: .module).font(.footnote).foregroundStyle(PsycheColor.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .psycheFade(PsycheMotion.Duration.medium, value: visible)
        .task {
            try? await Task.sleep(for: .seconds(1.5))
            visible = true
        }
    }
}

/// One quiet row: what is wrong, and "Details" for the cause and the Tailscale button.
private struct UnreachableBanner: View {
    let reason: UnreachableReason
    let lastSyncedAt: Date?
    @Environment(\.openURL) private var openURL
    @State private var showsDetails = false

    var body: some View {
        PaperCard(padding: 12) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    Image(systemName: reason.symbol)
                        .font(.body)
                        .foregroundStyle(PsycheColor.muted)
                        .frame(width: 22, height: 22)
                        .accessibilityHidden(true)
                    Text("Mac not reachable", bundle: .module)
                        .font(.psycheRow.weight(.semibold)).foregroundStyle(PsycheColor.text)
                    Spacer(minLength: 8)
                    Button { showsDetails.toggle() } label: {
                        Text("Details", bundle: .module)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(PsycheColor.inkText)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(.isButton)
                }
                if showsDetails {
                    Text(reason.detail).font(.footnote).foregroundStyle(PsycheColor.muted)
                    if let lastSyncedAt {
                        EvidenceLine([String(localized: "Updated \(lastSyncedAt.formatted(.dateTime.hour().minute()))", bundle: .module), String(localized: "cached", bundle: .module)])
                    }
                    if reason == .tailscaleOff {
                        Button(Tailscale.isInstalled ? String(localized: "Open Tailscale", bundle: .module) : String(localized: "Get Tailscale", bundle: .module)) {
                            openURL(Tailscale.isInstalled ? Tailscale.appURL : Tailscale.storeURL)
                        }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(PsycheColor.inkText)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// Opens the Tailscale app when it is installed. The scheme is declared in `LSApplicationQueriesSchemes`
/// so `canOpenURL` can answer; the on-demand spike (S1) settles whether a deeper link exists.
enum Tailscale {
    static let appURL = URL(string: "tailscale://")!
    static let storeURL = URL(string: "https://apps.apple.com/app/tailscale/id1470499037")!

    @MainActor
    static var isInstalled: Bool {
        #if canImport(UIKit)
        UIApplication.shared.canOpenURL(appURL)
        #else
        false
        #endif
    }
}

extension UnreachableReason {
    var symbol: String {
        switch self {
        case .awayFromHome: "wifi.slash"
        case .gatewayOff: "moon.zzz"
        case .tailscaleOff: "lock.slash"
        }
    }

    var detail: String {
        switch self {
        case .awayFromHome:
            String(localized: "Your Mac is only reachable on your home network. Answers wait until you're back, or turn on Tailscale.", bundle: .module)
        case .gatewayOff: String(localized: "It may be asleep. Answers wait until it's back.", bundle: .module)
        case .tailscaleOff: String(localized: "Psyche reaches your Mac over Tailscale when you're away. Answers wait until it's on.", bundle: .module)
        }
    }
}
