import PsycheDesign
import SwiftUI

/// The persona's avatar in a nav bar; opens the agent sheet (docs/design/ios-app-2026.md §4.8).
struct AgentButton: View {
    @Environment(Router.self) private var router
    let needsYou: Bool

    var body: some View {
        Button { router.sheet = .agent } label: { MothButtonLabel(needsYou: needsYou) }
            .buttonStyle(.plain)
            .accessibilityLabel("Open Psyche's activity")
            .contextMenu {
                Button { router.sheet = .settings } label: { Label("Settings", systemImage: "gearshape") }
            }
    }
}
