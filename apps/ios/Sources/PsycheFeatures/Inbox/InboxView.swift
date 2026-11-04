import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// The inbox page (docs/design/ios-app-2026.md §4.1, "More"): needs-you first, then Today and Earlier.
/// A tap marks the entry read and follows its route; a swipe only marks it read.
struct InboxView: View {
    @State private var model: InboxModel
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
            switch model.phase {
            case .idle, .loading:
                rows(.skeleton, title: "Today").redacted(reason: .placeholder).allowsHitTesting(false)
            case .loaded(let items):
                content(items)
            case .failed(let message):
                PhaseView(phase: LoadPhase<Int>.failed(message), skeleton: 0, retry: model.load) { _ in EmptyView() }
                    .listRowBackground(Color.clear)
            }
        }
        .psycheGroupedList()
        .psycheScreen()
        .navigationTitle("Inbox")
        .psycheInlineTitle()
        .psycheShowsNavigationBar()
        .task {
            await model.load()
            await model.observe()
        }
        .refreshable { await model.load() }
    }

    @ViewBuilder
    private func content(_ items: [InboxItem]) -> some View {
        let waiting = items.filter(\.needsYou)
        let rest = items.filter { !$0.needsYou }
        if items.isEmpty {
            Text("Nothing here yet.").font(.subheadline).foregroundStyle(PsycheColor.muted)
                .frame(maxWidth: .infinity).padding(.vertical, 40)
                .listRowBackground(Color.clear)
        }
        if !waiting.isEmpty { rows(waiting, title: "Needs you", needsYou: true) }
        if !rest.filter({ !$0.earlier }).isEmpty { rows(rest.filter { !$0.earlier }, title: "Today") }
        if !rest.filter(\.earlier).isEmpty { rows(rest.filter(\.earlier), title: "Earlier") }
    }

    private func rows(_ items: [InboxItem], title: String, needsYou: Bool = false) -> some View {
        Section {
            ForEach(items) { item in
                InboxRow(item: item) { open(item) }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(PsycheColor.sheet)
                    .listRowSeparatorTint(PsycheColor.hairline)
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        if !item.read {
                            Button("Read", systemImage: "envelope.open") { Task { await model.markRead(item) } }
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
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 12) {
                marker
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title)
                        .font(.psycheRow.weight(item.read ? .regular : .semibold))
                        .foregroundStyle(PsycheColor.text)
                        .multilineTextAlignment(.leading)
                    if !item.body.isEmpty {
                        Text(item.body).font(.footnote).foregroundStyle(PsycheColor.muted)
                            .multilineTextAlignment(.leading)
                    }
                    EvidenceLine([item.kindLabel, item.time])
                        .padding(.top, 1)
                }
                Spacer(minLength: 0)
            }
            .padding(PsycheMetrics.rowPadding)
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityValue(item.read ? "Read" : "Unread")
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
