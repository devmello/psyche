import PsycheClient
import PsycheDesign
import SwiftUI

/// The paper banner for an unreachable Gateway (docs/design/ios-app-2026.md §3.2). Cached content stays
/// readable underneath it. Draws nothing in any other state.
struct ConnectionBanner: View {
    let state: ConnectionState
    let lastSyncedAt: Date?
    @Environment(\.openURL) private var openURL

    var body: some View {
        if case .unreachable(let reason) = state {
            PaperCard(padding: 14) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: reason.symbol)
                        .font(.body)
                        .foregroundStyle(PsycheColor.muted)
                        .frame(width: 22)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(reason.title).font(.psycheRow.weight(.semibold)).foregroundStyle(PsycheColor.text)
                        Text(reason.detail).font(.footnote).foregroundStyle(PsycheColor.muted)
                        if let lastSyncedAt {
                            EvidenceLine(["Updated \(lastSyncedAt.formatted(.dateTime.hour().minute()))", "cached"])
                        }
                        if reason == .tailscaleOff {
                            // The scheme is unverified; the Tailscale on-demand spike (S1) settles it.
                            Button("Open Tailscale") {
                                if let url = URL(string: "tailscale://") { openURL(url) }
                            }
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(PsycheColor.inkText)
                            .padding(.top, 4)
                        }
                    }
                }
            }
            .accessibilityElement(children: .contain)
        }
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
