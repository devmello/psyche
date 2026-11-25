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
                        ContentUnavailableView {
                            Label(String(localized: "Pick a chat", bundle: .module), systemImage: "bubble.left")
                        }
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
    @State private var spaces: SpaceMenuModel
    /// The chat being renamed, its draft title, and the chat waiting for delete confirmation.
    @State private var renaming: ChatThreadSummary?
    @State private var renameText = ""
    @State private var deleting: ChatThreadSummary?
    @State private var query = ""
    @Binding var selection: String?
    /// Shown again after a back swipe on a phone, when the same row is tapped twice.
    @Binding var column: NavigationSplitViewColumn
    @Environment(Session.self) private var session
    private let sideBySide: Bool

    init(store: any PsycheBackend, selection: Binding<String?>, column: Binding<NavigationSplitViewColumn>, sideBySide: Bool) {
        self.sideBySide = sideBySide
        _model = State(initialValue: ThreadListModel(store: store))
        _spaces = State(initialValue: SpaceMenuModel(store: store))
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
            PhaseView(phase: model.phase, skeleton: .skeleton, retry: model.load) { all in
                let threads = matching(all)
                let archived = matching(model.archived)
                if searching && threads.isEmpty && archived.isEmpty {
                    ContentUnavailableView.search(text: query)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
                ForEach(threads) { thread in
                    // Only a side-by-side layout shows a selected row; on a phone the thread covers the list.
                    let selected = sideBySide && selection == thread.id
                    Button { selection = thread.id; column = .detail } label: { ThreadRow(thread: thread) }
                        .buttonStyle(.plain)
                        .badge(thread.statusKind == .needsYou ? Text("Needs you", bundle: .module) : nil)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                        .listRowBackground(selected ? PsycheColor.fill : nil)
                        .contextMenu {
                            if !thread.isMain, !spaces.spaces.isEmpty {
                                MoveToSpaceMenu(model: spaces, thread: thread) { await model.load() }
                            }
                            if !thread.isMain {
                                Button {
                                    renameText = thread.title
                                    renaming = thread
                                } label: {
                                    Label(String(localized: "Rename", bundle: .module), systemImage: "pencil")
                                }
                            }
                            Button { Task { await model.export(thread) } } label: {
                                Label(String(localized: "Export", bundle: .module), systemImage: "square.and.arrow.up")
                            }
                            if !thread.isMain {
                                Button(role: .destructive) { deleting = thread } label: {
                                    Label(String(localized: "Delete", bundle: .module), systemImage: "trash")
                                }
                            }
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            if !thread.isMain {
                                Button { Task { await model.pin(thread) } } label: {
                                    Label(thread.isPinned ? String(localized: "Unpin", bundle: .module) : String(localized: "Pin", bundle: .module), systemImage: thread.isPinned ? "pin.slash" : "pin")
                                }
                                .tint(PsycheColor.muted)
                            }
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            if !thread.isMain {
                                Button { Task { await model.archive(thread) } } label: {
                                    Label(String(localized: "Archive", bundle: .module), systemImage: "archivebox")
                                }
                                .tint(PsycheColor.muted)
                            }
                        }
                }
                // Archived chats sit below the list; a row opens the chat, and a swipe brings it back.
                if !archived.isEmpty {
                    Section(String(localized: "Archived", bundle: .module)) {
                        ForEach(archived) { thread in
                            Button { selection = thread.id; column = .detail } label: { ThreadRow(thread: thread) }
                                .buttonStyle(.plain)
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                    Button { Task { await model.restore(thread) } } label: {
                                        Label(String(localized: "Restore", bundle: .module), systemImage: "arrow.uturn.backward")
                                    }
                                    .tint(PsycheColor.muted)
                                }
                        }
                        if model.archivedCursor != nil {
                            Button { Task { await model.loadMoreArchived() } } label: {
                                HStack {
                                    Text(String(localized: "Load older chats", bundle: .module))
                                    if model.loadingMoreArchived { ProgressView() }
                                }
                            }
                            .disabled(model.loadingMoreArchived)
                        }
                    }
                }
                // The last row's neighbour: the next page loads when it appears. Its id is the cursor, so each
                // page is a new row and a failed page does not retry in a loop.
                if let cursor = model.nextCursor {
                    PageSentinel(loading: model.loadingMore, label: String(localized: "Loading more chats", bundle: .module))
                        .id(cursor)
                        .onAppear { Task { await model.loadMore() } }
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .psycheScreen()
        .navigationTitle(String(localized: "Chat", bundle: .module))
        // The Space new chats go into: a tap on the title, instead of a toolbar button.
        .toolbarTitleMenu {
            if !spaces.spaces.isEmpty { SpaceTargetItems(model: spaces) }
        }
        .searchable(text: $query, prompt: String(localized: "Search chats", bundle: .module))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { selection = await newChat() ?? selection } } label: {
                    Label(String(localized: "New chat", bundle: .module), systemImage: "square.and.pencil")
                }
                .accessibilityLabel(String(localized: "New chat", bundle: .module))
            }
        }
        .alert(String(localized: "Couldn't do that", bundle: .module), isPresented: errorShown) {
            Button(String(localized: "OK", bundle: .module)) { model.clearError(); spaces.clearError() }
        } message: {
            Text(model.actionError ?? spaces.actionError ?? "")
        }
        .alert(String(localized: "Rename chat", bundle: .module), isPresented: renameShown) {
            TextField(String(localized: "Title", bundle: .module), text: $renameText)
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) { renaming = nil }
            Button(String(localized: "Save", bundle: .module)) {
                if let thread = renaming { Task { await model.rename(thread, to: renameText) } }
                renaming = nil
            }
        }
        .confirmationDialog(
            String(localized: "Delete chat?", bundle: .module), isPresented: deleteShown, titleVisibility: .visible
        ) {
            Button(String(localized: "Delete", bundle: .module), role: .destructive) {
                if let thread = deleting { Task { await model.delete(thread) } }
                deleting = nil
            }
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) { deleting = nil }
        } message: {
            Text(String(localized: "This deletes the chat and its messages. Receipts and audit entries are kept.", bundle: .module))
        }
        .sheet(item: exportShown) { chat in
            ExportSheet(chat: chat)
        }
        .task {
            await spaces.load()
            await model.load()
            await model.observe()
        }
        .task { await spaces.observe() }
        .refreshable { await model.resync() }
    }

    private var searching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The chats whose title matches the search field (all of them while it is empty).
    private func matching(_ threads: [ChatThreadSummary]) -> [ChatThreadSummary] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return threads }
        return threads.filter { $0.title.localizedStandardContains(needle) }
    }

    private var errorShown: Binding<Bool> {
        Binding(
            get: { model.actionError != nil || spaces.actionError != nil },
            set: { if !$0 { model.clearError(); spaces.clearError() } })
    }

    private var renameShown: Binding<Bool> {
        Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
    }

    private var deleteShown: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }

    private var exportShown: Binding<ExportedChat?> {
        Binding(get: { model.exported }, set: { if $0 == nil { model.clearExport() } })
    }

    /// A new chat, in the Space the owner chose in the menu (none by default), then the list refreshes.
    private func newChat() async -> String? {
        let id = await spaces.newChat()
        await model.load()
        return id
    }
}

/// A chat's Markdown transcript with the system share sheet, which can send it to Notes, Mail, Files and more.
private struct ExportSheet: View {
    let chat: ExportedChat

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(verbatim: chat.markdown)
                    .font(.body.monospaced())
                    .foregroundStyle(PsycheColor.text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(PsycheMetrics.pagePadding)
            }
            .psycheScreen()
            .navigationTitle(String(localized: "Export", bundle: .module))
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    ShareLink(item: chat.markdown, subject: Text(verbatim: chat.title)) {
                        Label(String(localized: "Share", bundle: .module), systemImage: "square.and.arrow.up")
                    }
                }
            }
        }
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
                    .accessibilityLabel(String(localized: "Pinned", bundle: .module))
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
