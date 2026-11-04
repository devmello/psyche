import PsycheClient
import PsycheDesign
import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

/// What the connection looks like on a screen (docs/design/ios-app-2026.md §3.2).
/// - `connecting`: nothing for the first 1.5 s (no flash), then a quiet "Connecting…".
/// - `unreachable`: a paper banner that says what to do; cached content stays readable underneath.
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
                Text("Connecting…").font(.footnote).foregroundStyle(PsycheColor.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.default, value: visible)
        .task {
            try? await Task.sleep(for: .seconds(1.5))
            visible = true
        }
    }
}

private struct UnreachableBanner: View {
    let reason: UnreachableReason
    let lastSyncedAt: Date?
    @Environment(\.openURL) private var openURL

    var body: some View {
        PaperCard(padding: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: reason.symbol)
                    .font(.body)
                    .foregroundStyle(PsycheColor.muted)
                    .frame(width: 22, height: 22)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(reason.title).font(.psycheRow.weight(.semibold)).foregroundStyle(PsycheColor.text)
                    Text(reason.detail).font(.footnote).foregroundStyle(PsycheColor.muted)
                    if let lastSyncedAt {
                        EvidenceLine(["Updated \(lastSyncedAt.formatted(.dateTime.hour().minute()))", "cached"])
                            .padding(.top, 2)
                    }
                    if reason == .tailscaleOff {
                        Button(Tailscale.isInstalled ? "Open Tailscale" : "Get Tailscale") {
                            openURL(Tailscale.isInstalled ? Tailscale.appURL : Tailscale.storeURL)
                        }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(PsycheColor.inkText)
                        .padding(.top, 6)
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

    var title: String {
        switch self {
        case .awayFromHome: "You're away from home"
        case .gatewayOff: "Your Mac isn't answering"
        case .tailscaleOff: "Turn on Tailscale to reach your Mac"
        }
    }

    var detail: String {
        switch self {
        case .awayFromHome:
            "Your Mac is only reachable on your home network. Answers wait until you're back, or turn on Tailscale."
        case .gatewayOff: "It may be asleep. Answers wait until it's back."
        case .tailscaleOff: "Psyche reaches your Mac over Tailscale when you're away. Answers wait until it's on."
        }
    }
}
