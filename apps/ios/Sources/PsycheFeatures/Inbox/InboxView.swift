import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// The inbox page (docs/design/ios-app-2026.md §4.1, "More"): needs-you first, then Today and Earlier.
/// A tap marks the entry read and follows its route; a swipe only marks it read.
struct InboxView: View {
    @State private var model: InboxModel
    @State private var confirming: InboxItem?
    @Environment(Router.self) private var router
    @Environment(Session.self) private var session

    init(store: any PsycheBackend) {
        _model = State(initialValue: InboxModel(store: store))
    }

    var body: some View {
        List {
            if !session.state.canAnswer, case .unreachable = session.state {
                ConnectionBanner(state: session.state, lastSyncedAt: session.lastSyncedAt)
                    .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 8, trailing: 20))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            if let result = model.recoveryResult {
                Text(result).font(.footnote).foregroundStyle(PsycheColor.muted)
                    .listRowBackground(Color.clear)
            }
            if let error = model.actionError {
                Text(error).font(.footnote).foregroundStyle(PsycheColor.muted)
                    .listRowBackground(Color.clear)
            }
            switch model.phase {
            case .idle, .loading:
                rows(.skeleton, title: String(localized: "Today", bundle: .module)).redacted(reason: .placeholder).allowsHitTesting(false)
            case .loaded(let items):
                content(items)
                pageEnd(hasRows: !items.isEmpty)
            case .failed(let message):
                PhaseView(phase: LoadPhase<Int>.failed(message), skeleton: 0, retry: model.load) { _ in EmptyView() }
                    .listRowBackground(Color.clear)
            }
        }
        .psycheGroupedList()
        .psycheScreen()
        .navigationTitle(String(localized: "Inbox", bundle: .module))
        .psycheInlineTitle()
        .psycheShowsNavigationBar()
        .task {
            await model.load()
            await model.observe()
        }
        .refreshable { await model.load() }
        .confirmationDialog(
            String(localized: "Cancel this security request?", bundle: .module), isPresented: Binding(
                get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
            titleVisibility: .visible
        ) {
            Button(String(localized: "Cancel recovery", bundle: .module), role: .destructive) {
                if let item = confirming { Task { await model.cancelRecovery(item) } }
                confirming = nil
            }
            Button(String(localized: "Keep request", bundle: .module), role: .cancel) { confirming = nil }
        } message: {
            Text("The change will not be made. If you asked for it on your Mac, you will need to ask again.", bundle: .module)
        }
    }

    @ViewBuilder
    private func content(_ items: [InboxItem]) -> some View {
        let waiting = items.filter(\.needsYou)
        let rest = items.filter { !$0.needsYou }
        if items.isEmpty {
            Text("Nothing here yet.", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
                .frame(maxWidth: .infinity).padding(.vertical, 40)
                .listRowBackground(Color.clear)
        }
        if !waiting.isEmpty { rows(waiting, title: String(localized: "Needs you", bundle: .module), needsYou: true) }
        if !rest.filter({ !$0.earlier }).isEmpty { rows(rest.filter { !$0.earlier }, title: String(localized: "Today", bundle: .module)) }
        if !rest.filter(\.earlier).isEmpty { rows(rest.filter(\.earlier), title: String(localized: "Earlier", bundle: .module)) }
    }

    /// The end of the list: the next page loads while this row is on screen (`PagedRowsEnd`). A failed page shows a
    /// retry row instead, which does not load again by itself.
    @ViewBuilder
    private func pageEnd(hasRows: Bool) -> some View {
        if hasRows {
            PagedRowsEnd(
                moreFailed: model.moreFailed, nextCursor: model.nextCursor, loadingMore: model.loadingMore,
                label: String(localized: "Loading more notices", bundle: .module),
                loadMore: { await model.loadMore() }, retryMore: { await model.retryMore() })
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
        }
    }

    private func rows(_ items: [InboxItem], title: String, needsYou: Bool = false) -> some View {
        Section {
            ForEach(items) { item in
                InboxRow(
                    item: item,
                    canCancelRecovery: model.canCancelRecoveries && !model.cancellingRecovery
                        && model.cancellable.contains(item.id),
                    onOpen: { open(item) },
                    onAction: { action in Task { await model.act(item, action) } },
                    onCancelRecovery: { askCancel(item) })
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(PsycheColor.sheet)
                    .listRowSeparatorTint(PsycheColor.hairline)
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        if !item.read {
                            Button(String(localized: "Read", bundle: .module), systemImage: "envelope.open") { Task { await model.markRead(item) } }
                                .tint(PsycheColor.muted)
                        }
                    }
            }
        } header: {
            SectionHeader(title, count: needsYou ? items.count : nil, needsYou: needsYou)
                .textCase(nil)
                .padding(.leading, 6)
        }
    }

    /// A re-seal or presence reset is asked for on the Mac and is the way out of a blocked state, so cancelling
    /// one asks first. Other requests cancel at once.
    private func askCancel(_ item: InboxItem) {
        let op = InboxModel.recoveryNotice(for: item)?.op
        if op == "seal" || op == "presence" { confirming = item } else { Task { await model.cancelRecovery(item) } }
    }

    private func open(_ item: InboxItem) {
        Task { await model.markRead(item) }
        if let pending = model.pending(for: item), session.state.canAnswer {
            router.open(pending)
        } else if let route = item.route {
            router.open(appPath: route)
        }
    }
}

private struct InboxRow: View {
    let item: InboxItem
    /// A security request this phone may cancel from here (it holds admin, and the notice still says "unless you cancel").
    let canCancelRecovery: Bool
    let onOpen: () -> Void
    let onAction: (InboxAction) -> Void
    let onCancelRecovery: () -> Void

    var body: some View {
        // The text opens the entry; the notice's own buttons sit beside it, not inside the tap target.
        VStack(alignment: .leading, spacing: 10) {
            Button(action: onOpen) {
                HStack(alignment: .top, spacing: 12) {
                    marker
                    VStack(alignment: .leading, spacing: 3) {
                        Text(NoticeWording.title(item))
                            .font(.psycheRow.weight(item.read ? .regular : .semibold))
                            .foregroundStyle(PsycheColor.text)
                            .multilineTextAlignment(.leading)
                        if !NoticeWording.body(item).isEmpty {
                            Text(NoticeWording.body(item)).font(.footnote).foregroundStyle(PsycheColor.muted)
                                .multilineTextAlignment(.leading)
                        }
                        EvidenceLine([item.kindLabel, item.time])
                            .padding(.top, 1)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityValue(item.read ? "Read" : String(localized: "Unread", bundle: .module))

            if !item.actions.isEmpty || canCancelRecovery {
                HStack(spacing: 8) {
                    ForEach(item.actions) { action in
                        Button(role: action.destructive ? .destructive : nil) {
                            onAction(action)
                        } label: {
                            Text(NoticeWording.label(action))
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                    if canCancelRecovery {
                        Button(role: .destructive, action: onCancelRecovery) {
                            Text("Cancel recovery", bundle: .module)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                }
                .padding(.leading, 20)
            }
        }
        .padding(PsycheMetrics.rowPadding)
        .padding(.horizontal, 6)
    }

    /// The amber dot for needs-you, a small ink dot for unread, nothing once read.
    @ViewBuilder
    private var marker: some View {
        Group {
            if item.needsYou {
                Circle().fill(PsycheColor.amber)
            } else if !item.read {
                Circle().fill(PsycheColor.inkText)
            } else {
                Color.clear
            }
        }
        .frame(width: 8, height: 8)
        .padding(.top, 6)
        .accessibilityHidden(true)
    }
}
