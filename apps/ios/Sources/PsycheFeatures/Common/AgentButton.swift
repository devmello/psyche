import PsycheDesign
import SwiftUI

/// The persona's avatar in a nav bar; opens the agent sheet (docs/design/ios-app-2026.md §4.8).
/// In a toolbar the system supplies the glass; on a page with its own header (Home) pass `glass: true`.
struct AgentButton: View {
    @Environment(Router.self) private var router
    let needsYou: Bool
    var glass = false
    @Environment(\.psycheZoomNamespace) private var zoom

    /// The id the agent sheet zooms out of. Only one tab is on screen, so there is one source at a time.
    static let zoomID = "agent-avatar"

    var body: some View {
        Button { router.sheet = .agent } label: { label.frame(minWidth: 44, minHeight: 44).contentShape(Rectangle()) }
            .buttonStyle(.plain)
            .psycheZoomSource(id: Self.zoomID, in: zoom)
            .accessibilityLabel(needsYou ? String(localized: "Open Psyche's activity, something needs you", bundle: .module) : String(localized: "Open Psyche's activity", bundle: .module))
            .contextMenu {
                Button { router.sheet = .settings } label: { Label(String(localized: "Settings", bundle: .module), systemImage: "gearshape") }
            }
    }

    @ViewBuilder
    private var label: some View {
        if glass {
            MothAvatar(size: 26)
                .frame(width: 44, height: 44)
                .glassEffect(.regular.interactive(), in: .circle)
                .overlay(alignment: .topTrailing) {
                    if needsYou {
                        Circle().fill(PsycheColor.amber).frame(width: 10, height: 10)
                            .overlay(Circle().strokeBorder(PsycheColor.paper, lineWidth: 2))
                            .offset(x: 1, y: -1)
                            .accessibilityHidden(true)
                    }
                }
        } else {
            MothButtonLabel(needsYou: needsYou)
        }
    }
}
