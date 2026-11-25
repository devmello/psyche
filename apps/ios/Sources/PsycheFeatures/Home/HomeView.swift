import PsycheBlocks
import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// Home at a glance: an inset-grouped list under a native large title with three sections (Needs you, Running,
/// Today) and one More row. Everything else (inbox, to-dos, nudges, pinned widgets, follow-ups, Spaces, Feed, Ideas,
/// Goals) is behind More and the toolbar menu. Chat and Search own asking, so Home has no Ask field.
struct HomeView: View {
    @State private var model: HomeModel
    @State private var proactive: ProactiveHomeModel
    @Environment(Session.self) private var session
    @Environment(Router.self) private var router
    @Environment(\.alerts) private var alerts
    private let motion = MotionContext()

    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
        _model = State(initialValue: HomeModel(store: store))
        _proactive = State(initialValue: ProactiveHomeModel(store: store))
    }

    var body: some View {
        List {
            if session.state != .live {
                ConnectionBanner(state: session.state, lastSyncedAt: session.lastSyncedAt)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            PhaseView(phase: model.phase, skeleton: .skeleton, retry: model.load) { snapshot in
                sections(snapshot)
            }
        }
        .homeListStyle()
        .navigationTitle(String(localized: "Home", bundle: .module))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.large)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                AgentButton(needsYou: !(model.phase.value?.needsYou.isEmpty ?? true))
            }
            ToolbarItem(placement: .secondaryAction) { shortcuts }
        }
        .overlay(alignment: .bottom) { notice }
        .psycheAnimation(.smooth, value: model.notice)
        // Rows that appear or go (an approval answered elsewhere, a task finishing) animate on the smooth spring.
        .psycheAnimation(.smooth, value: listIdentity)
        .task {
            await model.load()
            await model.observe()
        }
        .refreshable {
            async let sections: Void = proactive.load()
            await model.load()
            await sections
        }
    }

    // MARK: Sections

    /// What is on the page, by id: a change here is a row appearing or leaving.
    private var listIdentity: [String] {
        guard let snapshot = model.phase.value else { return [] }
        return snapshot.needsYou.map(\.id) + snapshot.running.map(\.id) + snapshot.today.map(\.id)
    }

    /// Empty sections aren't drawn; with all three empty, an empty state says so.
    @ViewBuilder
    private func sections(_ snapshot: HomeSnapshot) -> some View {
        if !snapshot.needsYou.isEmpty { needsYou(snapshot.needsYou) }
        if !snapshot.running.isEmpty { running(snapshot.running) }
        if !snapshot.today.isEmpty { today(snapshot.today) }
        if snapshot.needsYou.isEmpty && snapshot.running.isEmpty && snapshot.today.isEmpty {
            Section {
                ContentUnavailableView {
                    Label(String(localized: "All caught up", bundle: .module), systemImage: "checkmark.circle")
                } description: {
                    Text("Nothing needs you right now.", bundle: .module)
                }
                .listRowBackground(Color.clear)
            }
        }
        Section {
            NavigationLink {
                HomeMorePage(store: store, model: model, proactive: proactive)
            } label: {
                HStack {
                    Label(String(localized: "More", bundle: .module), systemImage: "ellipsis.circle")
                    if model.unreadInbox > 0 {
                        Spacer(minLength: 0)
                        Text(model.unreadInbox, format: .number).foregroundStyle(.secondary)
                    }
                }
            }
            .accessibilityIdentifier("home.more")
        }
    }

    /// Inbox, Scheduled and Overview, and Settings, one tap from the toolbar.
    private var shortcuts: some View {
        Menu {
            Button { router.homePath.append(.inbox) } label: {
                Label(String(localized: "Inbox", bundle: .module), systemImage: "tray")
            }
            Button { router.homePath.append(.scheduled) } label: {
                Label(String(localized: "Scheduled", bundle: .module), systemImage: "clock")
            }
            Button { router.homePath.append(.overview) } label: {
                Label(String(localized: "Overview", bundle: .module), systemImage: "square.grid.2x2")
            }
            Divider()
            Button { router.sheet = .settings } label: {
                Label(String(localized: "Settings", bundle: .module), systemImage: "gearshape")
            }
        } label: {
            Label(String(localized: "More options", bundle: .module), systemImage: "ellipsis")
        }
    }

    private func needsYou(_ items: [NeedsYouItem]) -> some View {
        Section {
            ForEach(items) { item in needsYouRow(item) }
        } header: {
            Text("Needs you", bundle: .module)
        }
    }

    @ViewBuilder
    private func needsYouRow(_ item: NeedsYouItem) -> some View {
        let canAnswer = session.state.canAnswer
        let kind = item.kind.label
        let caption = canAnswer ? [kind, item.source, item.time] : [kind, String(localized: "reconnect to answer", bundle: .module)]
        let row = HomeRow(title: item.title, caption: caption)
        if canAnswer {
            // A plain tap opens the approval or question; nothing else stands between the owner and the answer.
            Button { router.open(item) } label: { row }.buttonStyle(.plain)
        } else {
            row.accessibilityElement(children: .combine)
        }
    }

    private func running(_ tasks: [RunningTask]) -> some View {
        Section {
            ForEach(tasks) { task in
                let watching = alerts?.watching.contains(task.id) == true
                NavigationLink {
                    TaskRunView(store: store, taskID: task.id)
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(task.title).font(.body)
                        ProgressView(value: task.fraction)
                        HomeCaption(
                            [String(localized: "Step \(task.step) of \(task.stepCount)", bundle: .module), task.detail, task.elapsed]
                                + (watching ? [String(localized: "Watching", bundle: .module)] : []))
                    }
                    .padding(.vertical, 2)
                }
                .swipeActions(edge: .trailing) {
                    if !watching { watchButton(task).tint(.accentColor) }
                }
                .contextMenu {
                    if !watching { watchButton(task) }
                }
            }
        } header: {
            Text("Running", bundle: .module)
        }
    }

    private func watchButton(_ task: RunningTask) -> some View {
        Button { watch(task) } label: {
            Label(String(localized: "Watch", bundle: .module), systemImage: "eye")
        }
    }

    /// Starts a Live Activity for the task; a quiet line says why when it can't.
    private func watch(_ task: RunningTask) {
        guard let alerts else { return }
        Task {
            if let message = await alerts.watch(task) { model.show(message, seconds: 5) }
        }
    }

    private func today(_ items: [BriefItem]) -> some View {
        Section {
            ForEach(items) { item in
                HomeRow(title: item.text, caption: [item.evidenceLabel] + item.evidence)
                    .swipeActions(edge: .trailing) {
                        Button { Task { await model.actOnFollowup(item, .done) } } label: {
                            Label(String(localized: "Done", bundle: .module), systemImage: "checkmark")
                        }
                        .tint(.green)
                        Button { Task { await model.actOnFollowup(item, .snooze) } } label: {
                            Label(String(localized: "Snooze", bundle: .module), systemImage: "moon.zzz")
                        }
                        .tint(.indigo)
                    }
                    .contextMenu { followupMenu(item) }
                    .disabled(model.followupsBusy.contains(item.id))
                    .accessibilityIdentifier("today.followup.\(item.id)")
            }
        } header: {
            Text("Today", bundle: .module)
        }
    }

    /// A Today follow-up's actions, as the desktop's: Done, Snooze (tomorrow or a week) and Dismiss. The row leaves
    /// Today once the Gateway accepts; a refusal shows its words in the quiet line.
    @ViewBuilder
    private func followupMenu(_ item: BriefItem) -> some View {
        Button { Task { await model.actOnFollowup(item, .done) } } label: {
            Label(String(localized: "Done", bundle: .module), systemImage: "checkmark")
        }
        Button { Task { await model.actOnFollowup(item, .snooze) } } label: {
            Label(String(localized: "Until tomorrow", bundle: .module), systemImage: "moon.zzz")
        }
        Button {
            let week = Calendar.current.date(byAdding: .day, value: 7, to: .now)
            Task { await model.actOnFollowup(item, .snooze, until: week) }
        } label: {
            Label(String(localized: "For a week", bundle: .module), systemImage: "calendar")
        }
        Button(role: .destructive) { Task { await model.actOnFollowup(item, .dismiss) } } label: {
            Label(String(localized: "Dismiss", bundle: .module), systemImage: "xmark")
        }
    }

    // MARK: Notice

    @ViewBuilder
    private var notice: some View {
        if let message = model.notice {
            Text(message)
                .font(.subheadline)
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .glassEffect(.regular, in: .capsule)
                .padding(.bottom, 24)
                .transition(motion.transition(.toast))
        }
    }
}

/// A title with a quiet caption under it, in system styles: the row Needs you and Today share.
struct HomeRow: View {
    let title: String
    let caption: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.body).multilineTextAlignment(.leading)
            HomeCaption(caption)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// Secondary text in the system's caption style (not the mono evidence line): wraps at word breaks at AX5.
struct HomeCaption: View {
    private let text: String

    init(_ parts: [String]) { text = parts.filter { !$0.isEmpty }.joined(separator: " · ") }

    var body: some View {
        Text(text).font(.footnote).foregroundStyle(.secondary)
    }
}

extension NeedsYouItem.Kind {
    var label: String {
        switch self {
        case .approval: String(localized: "Approval", bundle: .module)
        case .question: String(localized: "Question", bundle: .module)
        case .task: String(localized: "Task", bundle: .module)
        }
    }
}
