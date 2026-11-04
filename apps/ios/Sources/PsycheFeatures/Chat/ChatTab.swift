import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// Chat is a split view: thread list and thread side by side on iPad, a stack on iPhone
/// (docs/design/ios-app-2026.md §8, decision 5).
struct ChatTab: View {
    @Environment(Router.self) private var router
    @Environment(\.backend) private var store

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

    init(store: any PsycheBackend, selection: Binding<String?>) {
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
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            if !thread.isMain {
                                Button { Task { await model.pin(thread) } } label: {
                                    Label(thread.isPinned ? "Unpin" : "Pin", systemImage: thread.isPinned ? "pin.slash" : "pin")
                                }
                                .tint(PsycheColor.muted)
                            }
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            if !thread.isMain {
                                Button { Task { await model.archive(thread) } } label: {
                                    Label("Archive", systemImage: "archivebox")
                                }
                                .tint(PsycheColor.muted)
                            }
                        }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .psycheScreen()
        .navigationTitle("Chat")
        .toolbar {
            ToolbarItem(placement: .primaryAction) { AgentButton(needsYou: true) }
            ToolbarItem(placement: .primaryAction) {
                Button { Task { selection = await model.newThread() ?? selection } } label: {
                    Label("New chat", systemImage: "square.and.pencil")
                }
                .accessibilityLabel("New chat")
            }
        }
        .alert("Couldn't do that", isPresented: errorShown) {
            Button("OK") { model.clearError() }
        } message: {
            Text(model.actionError ?? "")
        }
        .task {
            await model.load()
            await model.observe()
        }
        .refreshable { await model.resync() }
    }

    private var errorShown: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.clearError() } })
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
            Spacer(minLength: 0)
            if thread.isPinned, !thread.isMain {
                Image(systemName: "pin.fill").font(.caption2).foregroundStyle(PsycheColor.muted)
                    .accessibilityLabel("Pinned")
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
