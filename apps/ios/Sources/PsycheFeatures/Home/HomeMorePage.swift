import PsycheBlocks
import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

extension View {
    /// The system's inset-grouped list on iOS (the macOS slice only builds for `swift test`).
    @ViewBuilder
    func homeListStyle() -> some View {
        #if os(iOS)
        listStyle(.insetGrouped)
        #else
        self
        #endif
    }
}

/// What Home does not show at a glance: Notifications and Scheduled tasks (which holds the past runs).
struct HomeMorePage: View {
    let store: any PsycheBackend
    let model: HomeModel

    var body: some View {
        List {
            Section {
                routeRow(String(localized: "Notifications", bundle: .module), "tray", .inbox, badge: model.unreadInbox)
                routeRow(String(localized: "Scheduled tasks", bundle: .module), "clock", .scheduled)
            }
        }
        .homeListStyle()
        .navigationTitle(String(localized: "More", bundle: .module))
        .psycheInlineTitle()
    }

    /// A row that pushes a route on Home's stack, with the system chevron.
    private func routeRow(_ title: String, _ symbol: String, _ route: Route, badge: Int = 0) -> some View {
        // A destination link, not a path push: a route pushed on Home's path from this page replaces the pages
        // pushed as destinations (Back would skip More), and a value link finds no destination from here.
        NavigationLink { RouteView(route: route) } label: {
            HStack {
                Label(title, systemImage: symbol)
                if badge > 0 {
                    Spacer(minLength: 0)
                    Text(badge, format: .number).foregroundStyle(.secondary)
                }
            }
        }
    }
}
