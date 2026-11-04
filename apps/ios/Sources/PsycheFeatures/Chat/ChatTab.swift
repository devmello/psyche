import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// Chat is a split view: thread list and thread side by side on iPad, a stack on iPhone
/// (docs/design/ios-app-2026.md §8, decision 5).
struct ChatTab: View {
    @Environment(Router.self) private var router
    @Environment(\.snapshotStore) private var store

    var body: some View {
        @Bindable var router = router
        NavigationSplitView {
            ThreadListView(store: store, selection: $router.selectedThread)
        } detail: {
            NavigationStack(path: $router.chatPath) {
                Group {
                    if let id = router.selectedThread {
                        ThreadView(id: id, store: store).id(id)
                    } else {
                        VStack(spacing: 8) {
                            MothAvatar(size: 44)
                            Text("Pick a chat").font(.psycheRow).foregroundStyle(PsycheColor.muted)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .psycheScreen()
                    }
                }
                .routeDestinations()
            }
        }
        .tint(PsycheColor.inkText)
    }
}

struct ThreadListView: View {
    @State private var model: ThreadListModel
    @Binding var selection: String?
    @Environment(Session.self) private var session

    init(store: any SnapshotStore, selection: Binding<String?>) {
        _model = State(initialValue: ThreadListModel(store: store))
        _selection = selection
    }

    var body: some View {
        List(selection: $selection) {
            if case .unreachable = session.state {
                ConnectionBanner(state: session.state, lastSyncedAt: session.lastSyncedAt)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            PhaseView(phase: model.phase, skeleton: .skeleton, retry: model.load) { threads in
                ForEach(threads) { thread in
                    ThreadRow(thread: thread).tag(thread.id)
                        .listRowBackground(PsycheColor.sheet)
                        .listRowSeparatorTint(PsycheColor.hairline)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .psycheScreen()
        .navigationTitle("Chat")
        .toolbar {
            ToolbarItem(placement: .primaryAction) { AgentButton(needsYou: true) }
        }
        .task { await model.load() }
        .refreshable { await model.resync() }
    }
}

private struct ThreadRow: View {
    let thread: ChatThreadSummary

    var body: some View {
        HStack(spacing: 12) {
            if thread.isMain { MothAvatar(size: 28) }
            VStack(alignment: .leading, spacing: 3) {
                Text(thread.title).font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text)
                StatusDot(thread.statusKind.dot, thread.status, textColor: PsycheColor.muted, font: .caption)
            }
        }
        .padding(.vertical, 2)
    }
}

extension ChatThreadSummary.Status {
    var dot: StatusDot.Kind {
        switch self {
        case .neutral, .running: .neutral
        case .needsYou: .needsYou
        }
    }
}

extension View {
    /// The pushes every tab's stack understands.
    func routeDestinations() -> some View {
        navigationDestination(for: Route.self) { route in
            RouteView(route: route)
        }
    }
}
