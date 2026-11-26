import SwiftUI

/// Settings, one tap from the root of every tab: a gear at the leading edge of the navigation bar that opens the
/// Settings sheet (the system's own pattern for an app's settings; pushed pages keep their Back button).
private struct SettingsToolbarButton: ViewModifier {
    @Environment(Router.self) private var router

    func body(content: Content) -> some View {
        content.toolbar {
            ToolbarItem(placement: .navigation) {
                Button { router.sheet = .settings } label: {
                    Label(String(localized: "Settings", bundle: .module), systemImage: "gearshape")
                }
                .accessibilityIdentifier("settings.open")
            }
        }
    }
}

extension View {
    /// Adds the Settings gear to this screen's navigation bar. Apply it to a tab's root view.
    func psycheSettingsButton() -> some View { modifier(SettingsToolbarButton()) }
}
