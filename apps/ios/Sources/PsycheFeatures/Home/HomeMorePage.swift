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

/// Everything Home no longer shows at a glance, one row each: nothing the owner used is gone, it is a tap away.
struct HomeMorePage: View {
    let store: any PsycheBackend
    let model: HomeModel
    let proactive: ProactiveHomeModel
    @Environment(Router.self) private var router

    var body: some View {
        List {
            Section {
                routeRow(String(localized: "Inbox", bundle: .module), "tray", .inbox, badge: model.unreadInbox)
                routeRow(String(localized: "Scheduled", bundle: .module), "clock", .scheduled)
                routeRow(String(localized: "Overview", bundle: .module), "square.grid.2x2", .overview)
            }
            Section {
                NavigationLink { HomeTodosPage(model: model) } label: {
                    row(String(localized: "To-do", bundle: .module), "checklist", count: model.comingUp.count + model.laterTodos.count)
                }
                NavigationLink { KeepInTouchPage(model: model) } label: {
                    row(String(localized: "Keep in touch", bundle: .module), "person.2", count: model.phase.value?.keepInTouch.count ?? 0)
                }
                NavigationLink { PinnedPage(store: store, model: model) } label: {
                    row(String(localized: "Pinned", bundle: .module), "pin", count: model.pinnedWidgets.count)
                }
            }
            Section {
                NavigationLink { FollowupsHomeSections(store: store) } label: {
                    row(String(localized: "Follow-ups", bundle: .module), "arrowshape.turn.up.left", count: nil)
                }
                NavigationLink { SpacesHomeSection(store: store) } label: {
                    row(String(localized: "Spaces", bundle: .module), "square.stack", count: nil)
                }
                routeRow(String(localized: "Feed", bundle: .module), "newspaper", .feed, badge: proactive.feed.phase.value?.cards.count ?? 0)
                routeRow(String(localized: "Ideas", bundle: .module), "lightbulb", .ideas, badge: proactive.ideas.phase.value?.count ?? 0)
                routeRow(String(localized: "Goals", bundle: .module), "target", .goals, badge: proactive.homeGoals.count)
            }
        }
        .homeListStyle()
        .navigationTitle(String(localized: "More", bundle: .module))
        .psycheInlineTitle()
        .task { await proactive.load() }
    }

    /// A row that pushes a route on Home's stack, with the system chevron.
    private func routeRow(_ title: String, _ symbol: String, _ route: Route, badge: Int = 0) -> some View {
        // A destination link, not a path push: a route pushed on Home's path from this page replaces the pages
        // pushed as destinations (Back would skip More), and a value link finds no destination from here.
        NavigationLink { RouteView(route: route) } label: { row(title, symbol, count: badge) }
    }

    private func row(_ title: String, _ symbol: String, count: Int?) -> some View {
        HStack {
            Label(title, systemImage: symbol)
            if let count, count > 0 {
                Spacer(minLength: 0)
                Text(count, format: .number).foregroundStyle(.secondary)
            }
        }
    }
}

/// Coming up (due this week) and the rest of the open to-dos, read from Memory.
private struct HomeTodosPage: View {
    let model: HomeModel

    var body: some View {
        List {
            if model.comingUp.isEmpty && model.laterTodos.isEmpty {
                ContentUnavailableView(String(localized: "No to-dos", bundle: .module), systemImage: "checklist")
                    .listRowBackground(Color.clear)
            }
            if !model.comingUp.isEmpty {
                Section {
                    ForEach(model.comingUp) { HomeRow(title: $0.title, caption: [$0.meta]) }
                } header: {
                    Text("Coming up", bundle: .module)
                }
            }
            if !model.laterTodos.isEmpty {
                Section {
                    ForEach(model.laterTodos) { HomeRow(title: $0.title, caption: [$0.meta]) }
                } header: {
                    Text("To-do", bundle: .module)
                }
            }
        }
        .homeListStyle()
        .navigationTitle(String(localized: "To-do", bundle: .module))
        .psycheInlineTitle()
        .refreshable { await model.load() }
    }
}

/// People Psyche suggests reaching out to. A tap starts a message in Chat; swipe or long-press to snooze or mute.
private struct KeepInTouchPage: View {
    let model: HomeModel
    @Environment(Router.self) private var router

    var body: some View {
        let nudges = model.phase.value?.keepInTouch ?? []
        List {
            if nudges.isEmpty {
                ContentUnavailableView(String(localized: "No one to reach out to", bundle: .module), systemImage: "person.2")
                    .listRowBackground(Color.clear)
            }
            ForEach(nudges) { nudge in
                Button { start(nudge) } label: {
                    HStack(spacing: 12) {
                        InitialsAvatar(nudge.initials, size: 36)
                        Text(nudge.text).font(.body).multilineTextAlignment(.leading)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .swipeActions(edge: .leading) {
                    startButton(nudge).tint(.accentColor)
                }
                .swipeActions(edge: .trailing) {
                    muteButton(nudge)
                    snoozeButton(nudge).tint(.indigo)
                }
                .contextMenu {
                    startButton(nudge)
                    snoozeButton(nudge)
                    muteButton(nudge)
                }
            }
        }
        .homeListStyle()
        .navigationTitle(String(localized: "Keep in touch", bundle: .module))
        .psycheInlineTitle()
        .refreshable { await model.load() }
    }

    private func startButton(_ nudge: Nudge) -> some View {
        Button { start(nudge) } label: {
            Label(String(localized: "Start a message", bundle: .module), systemImage: "square.and.pencil")
        }
    }

    private func snoozeButton(_ nudge: Nudge) -> some View {
        Button { Task { await model.act(on: nudge, .snooze) } } label: {
            Label(String(localized: "Snooze", bundle: .module), systemImage: "moon.zzz")
        }
    }

    private func muteButton(_ nudge: Nudge) -> some View {
        Button(role: .destructive) { Task { await model.act(on: nudge, .mute) } } label: {
            Label(String(localized: "Mute", bundle: .module), systemImage: "bell.slash")
        }
    }

    private func start(_ nudge: Nudge) {
        router.askPsyche(nudge.draft ?? "Help me reach out. \(nudge.text)")
        Task { await model.act(on: nudge, .startMessage) }
    }
}

/// Up to 6 pinned widgets, drawn by the native widget renderer (live, open and reply only).
private struct PinnedPage: View {
    let store: any PsycheBackend
    let model: HomeModel

    var body: some View {
        List {
            if model.pinnedWidgets.isEmpty {
                ContentUnavailableView(String(localized: "Nothing pinned", bundle: .module), systemImage: "pin")
                    .listRowBackground(Color.clear)
            }
            ForEach(model.pinnedWidgets) { widget in
                WidgetView(snapshot: widget, backend: store, surface: .overview)
                    .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
            }
        }
        .homeListStyle()
        .navigationTitle(String(localized: "Pinned", bundle: .module))
        .psycheInlineTitle()
        .refreshable { await model.load() }
    }
}
