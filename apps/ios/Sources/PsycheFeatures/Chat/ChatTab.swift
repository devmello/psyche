import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// Chat is a split view: thread list and thread side by side on iPad, a stack on iPhone
/// (docs/design/ios-app-2026.md §8, decision 5).
extension EnvironmentValues {
    /// False while a phone shows the thread list over a thread that is still alive in the detail column.
    @Entry var threadIsFrontmost = true
}

struct ChatTab: View {
    @Environment(Router.self) private var router
    @Environment(\.backend) private var store
    /// Which column a phone shows. Driven here rather than by system list selection, because the system draws
    /// its own selection ring on iPad and the row's quiet fill is the only mark we want.
    @State private var column: NavigationSplitViewColumn = .sidebar
    /// Read here, outside the split view: inside the sidebar column the size class is always compact.
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        @Bindable var router = router
        NavigationSplitView(preferredCompactColumn: $column) {
            ThreadListView(store: store, selection: $router.selectedThread, column: $column,
                           sideBySide: sizeClass == .regular)
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
        // The thread stays in the detail column after a back swipe (the selection is kept so the same row can be
        // tapped again), so it must be told when it is no longer the visible page: a tab-bar preference from a
        // page that is merely still in the tree would keep the bar hidden on the list.
        .environment(\.threadIsFrontmost, column == .detail)
        .task { if router.selectedThread != nil { column = .detail } }
        .onChange(of: router.selectedThread) { _, id in column = id == nil ? .sidebar : .detail }
    }
}

struct ThreadListView: View {
    @State private var model: ThreadListModel
    @Binding var selection: String?
    /// Shown again after a back swipe on a phone, when the same row is tapped twice.
    @Binding var column: NavigationSplitViewColumn
    @Environment(Session.self) private var session
    private let sideBySide: Bool

    init(store: any PsycheBackend, selection: Binding<String?>, column: Binding<NavigationSplitViewColumn>, sideBySide: Bool) {
        self.sideBySide = sideBySide
        _model = State(initialValue: ThreadListModel(store: store))
        _selection = selection
        _column = column
    }

    var body: some View {
        List {
            if case .unreachable = session.state {
                ConnectionBanner(state: session.state, lastSyncedAt: session.lastSyncedAt)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            PhaseView(phase: model.phase, skeleton: .skeleton, retry: model.load) { threads in
                ForEach(threads) { thread in
                    // Only a side-by-side layout shows a selected row; on a phone the thread covers the list.
                    let selected = sideBySide && selection == thread.id
                    Button { selection = thread.id; column = .detail } label: { ThreadRow(thread: thread) }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                        .listRowBackground(selected ? PsycheColor.fill : PsycheColor.sheet)
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
            ToolbarItem(placement: .primaryAction) { AgentButton(needsYou: model.phase.value?.contains { $0.statusKind == .needsYou } ?? false) }
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
        // The whole row is the button: without a shape only the title and status text took taps.
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
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
