import Observation
import PsycheBlocks
import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// Words for the proactive pages, all from the catalog in `Resources/Localizable.xcstrings`.
enum ProactiveText {
    static func time(_ date: Date) -> String { date.formatted(date: .omitted, time: .shortened) }

    static func when(_ date: Date?, now: Date = .now) -> String {
        guard let date else { return "" }
        if Calendar.current.isDate(date, inSameDayAs: now) { return time(date) }
        return date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }

    static func goalStatus(_ status: String) -> String {
        switch status {
        case "candidate": String(localized: "Suggested", bundle: .module)
        case "paused": String(localized: "Paused", bundle: .module)
        case "done": String(localized: "Done", bundle: .module)
        case "archived": String(localized: "Archived", bundle: .module)
        default: String(localized: "Active", bundle: .module)
        }
    }

    static func goalCategory(_ category: GoalCategoryChoice) -> String {
        switch category {
        case .health: String(localized: "Health", bundle: .module)
        case .finance: String(localized: "Finance", bundle: .module)
        case .career: String(localized: "Career", bundle: .module)
        case .relationships: String(localized: "Relationships", bundle: .module)
        case .productivity: String(localized: "Productivity", bundle: .module)
        case .learning: String(localized: "Learning", bundle: .module)
        case .home: String(localized: "Household", bundle: .module)
        case .other: String(localized: "Other", bundle: .module)
        }
    }

    static func runState(_ state: ScheduledRunState) -> String {
        switch state {
        case .running: String(localized: "Running", bundle: .module)
        case .waiting: String(localized: "Waiting for you", bundle: .module)
        case .succeeded: String(localized: "Done", bundle: .module)
        case .notVerified: String(localized: "Needs a check", bundle: .module)
        case .failed: String(localized: "Failed", bundle: .module)
        case .skipped: String(localized: "Skipped", bundle: .module)
        case .cancelled: String(localized: "Cancelled", bundle: .module)
        }
    }

    /// The button that moves a goal to `target`, named for what it does from `status`.
    static func goalChange(_ target: GoalStatusChange, from status: String) -> String {
        switch target {
        case .active where status == "candidate": String(localized: "Start", bundle: .module)
        case .active where status == "done": String(localized: "Reopen", bundle: .module)
        case .active: String(localized: "Resume", bundle: .module)
        case .paused: String(localized: "Pause", bundle: .module)
        case .done: String(localized: "Mark done", bundle: .module)
        }
    }

    /// The line under a scheduled item: its next run, or why it has none.
    static func scheduleLine(_ job: ScheduledJob, now: Date = .now) -> String {
        switch job.state {
        case "paused": String(localized: "Paused", bundle: .module)
        case "off": String(localized: "Turned off", bundle: .module)
        default: when(job.nextRunAt, now: now)
        }
    }

    static func runDot(_ state: ScheduledRunState) -> StatusDot.Kind {
        switch state {
        case .succeeded: .done
        case .failed, .notVerified: .failed
        case .waiting: .needsYou
        default: .neutral
        }
    }

    /// "Retrying at 9:12" for a run waiting on its next attempt; the run's state otherwise.
    /// A retry time already past reads as plain "Running": the attempt is under way.
    static func runLine(_ run: ScheduledRunItem, now: Date = .now) -> String {
        if run.state == .running, let retryAt = run.retryAt, retryAt > now {
            return String(localized: "Retrying at \(time(retryAt))", bundle: .module)
        }
        return runState(run.state)
    }
}

/// A pushed page: paper background, connection banner, skeleton while loading, pull to refresh.
private struct ProactivePage<Value: Sendable, Content: View>: View {
    let title: String
    let phase: LoadPhase<Value>
    let skeleton: Value
    let load: () async -> Void
    let observe: () async -> Void
    @ViewBuilder let content: (Value) -> Content
    @Environment(Session.self) private var session

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                ConnectionBanner(state: session.state, lastSyncedAt: session.lastSyncedAt)
                PhaseView(phase: phase, skeleton: skeleton, retry: load) { value in content(value) }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .psycheScreen()
        .navigationTitle(title)
        .psycheInlineTitle()
        .psycheShowsNavigationBar()
        .task {
            await load()
            await observe()
        }
        .refreshable { await load() }
    }
}

private struct EmptyLine: View {
    let text: String
    var body: some View {
        Text(text).font(.subheadline).foregroundStyle(PsycheColor.muted)
            .frame(maxWidth: .infinity).padding(.vertical, 40)
    }
}

/// "Load more" under a page that has older entries. An explicit tap, so a long Feed is never fetched by scrolling.
@MainActor @ViewBuilder
private func loadMoreButton(loading: Bool, _ action: @escaping () async -> Void) -> some View {
    if loading {
        ProgressView().frame(maxWidth: .infinity).padding(.vertical, 8)
    } else {
        Button(String(localized: "Load more", bundle: .module)) { Task { await action() } }
            .proactiveAction()
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
    }
}

private struct ActionError: View {
    let message: String?
    var body: some View {
        if let message { Text(message).font(.footnote).foregroundStyle(PsycheColor.red) }
    }
}

private extension View {
    /// The quiet text-button look used under cards on Home.
    func proactiveAction(prominent: Bool = false) -> some View {
        font(.subheadline.weight(.medium))
            .foregroundStyle(prominent ? PsycheColor.inkText : PsycheColor.muted)
            .buttonStyle(.plain)
    }
}

// MARK: Feed

struct FeedView: View {
    @State private var model: FeedModel
    @State private var expanded: Set<String> = []
    @State private var confirming: URL?
    @Environment(\.openURL) private var openURL
    /// A post to open on arrival (`/feed/<id>`, a daily brief, mail digest, meeting prep or notes notification).
    private let focusPostID: String?

    init(store: any PsycheBackend, focusPostID: String? = nil) {
        _model = State(initialValue: FeedModel(store: store))
        self.focusPostID = focusPostID
    }

    var body: some View {
        ProactivePage(
            title: String(localized: "Feed", bundle: .module), phase: model.phase, skeleton: .skeleton,
            load: model.load, observe: model.observe
        ) { snapshot in
            if snapshot.cards.isEmpty {
                feedEmptyState
            } else {
                ForEach(snapshot.cards) { card in cardView(card) }
            }
            if snapshot.nextCursor != nil { loadMoreButton(loading: model.loadingOlder) { await model.loadOlder() } }
            if let next = snapshot.nextBriefAt {
                Text("Next brief \(ProactiveText.when(next))", bundle: .module).font(.footnote).foregroundStyle(PsycheColor.muted)
            }
            ActionError(message: model.actionError)
        }
        .task(id: focusPostID) {
            // The post a notification names opens expanded; the card's id is the post id.
            if let id = focusPostID { expanded.insert(id) }
        }
        .confirmationDialog(
            String(localized: "Open this link?", bundle: .module), isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
            presenting: confirming
        ) { url in
            Button(String(localized: "Open \(url.host ?? "link")", bundle: .module)) { openURL(url) }
        }
    }

    /// No brief yet: the owner can make today's now instead of waiting for the schedule. While it runs, a progress line
    /// replaces the button so it can't be tapped twice.
    private var feedEmptyState: some View {
        VStack(alignment: .leading, spacing: 12) {
            EmptyLine(text: String(localized: "Nothing new in your feed.", bundle: .module))
            if model.generating {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Making today's brief", bundle: .module)
                        .font(.subheadline).foregroundStyle(PsycheColor.muted)
                }
            } else {
                Button(String(localized: "Make today's brief now", bundle: .module)) {
                    Task { await model.generate() }
                }
                .proactiveAction(prominent: true)
            }
        }
    }

    private func cardView(_ card: FeedCard) -> some View {
        let open = expanded.contains(card.id)
        return PaperCard(padding: 14) {
            VStack(alignment: .leading, spacing: 10) {
                Button {
                    if open { expanded.remove(card.id) } else { expanded.insert(card.id) }
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(card.title).font(.psycheRow).foregroundStyle(PsycheColor.text).multilineTextAlignment(.leading)
                        Text(card.body).font(.subheadline).foregroundStyle(PsycheColor.muted)
                            .lineLimit(open ? nil : 3).multilineTextAlignment(.leading)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(open ? String(localized: "Collapse", bundle: .module) : String(localized: "Expand", bundle: .module))
                if open, let source = card.sources.first, let url = URL(string: source.url),
                   case .confirmExternal = LinkPolicy.decision(for: url) {
                    Button { confirming = url } label: { Text(source.title).lineLimit(1) }.proactiveAction(prominent: true)
                }
                HStack(spacing: 20) {
                    Button(card.feedback == .save ? String(localized: "Saved", bundle: .module) : String(localized: "Save", bundle: .module)) {
                        Task { await model.give(.save, to: card) }
                    }
                    .proactiveAction(prominent: card.feedback == .save)
                    Button(String(localized: "Not interested", bundle: .module)) { Task { await model.give(.notInterested, to: card) } }
                        .proactiveAction()
                }
            }
        }
    }
}

// MARK: Ideas

struct IdeasView: View {
    @State private var model: IdeasModel

    init(store: any PsycheBackend) { _model = State(initialValue: IdeasModel(store: store)) }

    var body: some View {
        ProactivePage(
            title: String(localized: "Ideas", bundle: .module), phase: model.phase, skeleton: IdeaItem.skeleton,
            load: model.load, observe: model.observe
        ) { ideas in
            if ideas.isEmpty {
                EmptyLine(text: String(localized: "No ideas right now.", bundle: .module))
            } else {
                ForEach(ideas) { idea in
                    PaperCard(padding: 14) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(idea.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                            Text(idea.body).font(.subheadline).foregroundStyle(PsycheColor.muted)
                            if !idea.effort.isEmpty { EvidenceLine([idea.effort]) }
                            HStack(spacing: 20) {
                                Button(String(localized: "Accept", bundle: .module)) { Task { await model.accept(idea) } }
                                    .proactiveAction(prominent: true)
                                Button(String(localized: "Not now", bundle: .module)) { Task { await model.dismiss(idea, reason: .notNow) } }
                                    .proactiveAction()
                                Button(String(localized: "Not interested", bundle: .module)) { Task { await model.dismiss(idea, reason: .notInterested) } }
                                    .proactiveAction()
                            }
                        }
                    }
                }
                if model.nextCursor != nil { loadMoreButton(loading: model.loadingOlder) { await model.loadOlder() } }
            }
            ActionError(message: model.actionError)
        }
    }
}

// MARK: Goals

struct GoalsView: View {
    @State private var model: GoalsModel
    @State private var showing = false
    @State private var adding = false
    @Environment(Router.self) private var router
    /// A goal to open on arrival (`/goals/<id>`, a goal notification). Its sheet opens and loads that goal.
    private let openGoalID: String?

    init(store: any PsycheBackend, openGoalID: String? = nil) {
        _model = State(initialValue: GoalsModel(store: store))
        self.openGoalID = openGoalID
    }

    var body: some View {
        ProactivePage(
            title: String(localized: "Goals", bundle: .module), phase: model.phase, skeleton: GoalItem.skeleton,
            load: model.load, observe: model.observe
        ) { goals in
            if goals.isEmpty {
                EmptyLine(text: String(localized: "No goals yet.", bundle: .module))
            } else {
                PaperCard {
                    ForEach(Array(goals.enumerated()), id: \.element.id) { index, goal in
                        if index > 0 { HairlineDivider() }
                        Button {
                            showing = true
                            Task { await model.open(goal) }
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(goal.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                                EvidenceLine([ProactiveText.goalStatus(goal.status)])
                            }
                            .padding(PsycheMetrics.rowPadding)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                Text("Set a goal's plan and check-in cadence on your Mac.", bundle: .module).font(.footnote).foregroundStyle(PsycheColor.muted)
            }
        }
        .sheet(isPresented: $showing, onDismiss: {
            model.close()
            router.runDeferredOpen()
        }) {
            GoalSheet(model: model)
        }
        .task(id: openGoalID) {
            guard let id = openGoalID else { return }
            showing = true
            // Only the id is used to load; the goal's fields come from the detail.
            await model.open(GoalItem(id: id, title: "", category: "", status: ""))
        }
        .sheet(isPresented: $adding) {
            AddGoalSheet { draft in try await model.create(draft) }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { adding = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel(String(localized: "Add goal", bundle: .module))
            }
        }
    }
}

private struct GoalSheet: View {
    let model: GoalsModel
    @Environment(\.dismiss) private var dismiss
    @Environment(Router.self) private var router
    @State private var confirmingArchive = false
    @State private var addingMilestone = false
    @State private var linking = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                switch model.detail {
                case .idle, .loading:
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40)
                case .failed(let message):
                    Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
                case .loaded(let detail):
                    loaded(detail)
                }
                ActionError(message: model.actionError)
            }
            .padding(PsycheMetrics.pagePadding)
        }
        .psycheScreen()
        .presentationDetents([.medium, .large])
        .task { await model.loadLinkTitles() }
        .confirmationDialog(String(localized: "Archive this goal?", bundle: .module), isPresented: $confirmingArchive, titleVisibility: .visible) {
            Button(String(localized: "Archive goal", bundle: .module), role: .destructive) {
                guard let goal = currentGoal else { return }
                Task { if await model.archive(goal) { dismiss() } }
            }
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
        } message: {
            Text("Its check-ins stop. Nothing is deleted.", bundle: .module)
        }
        .sheet(isPresented: $linking) {
            if let goal = currentGoal {
                LinkGoalSheet(goal: goal, model: model)
            }
        }
        .sheet(isPresented: $addingMilestone) {
            if let goal = currentGoal {
                AddMilestoneSheet { title, dueAt in
                    try await model.addMilestone(title: title, dueAt: dueAt, for: goal)
                }
            }
        }
    }

    private var currentGoal: GoalItem? { model.detail.value?.goal }

    /// Add goal, Not now or Dismiss. The sheet closes once the goal has left the goals (a dismissed one).
    private func decide(_ decision: GoalDecision, _ goal: GoalItem) {
        Task { if await model.decide(decision, for: goal) { dismiss() } }
    }

    @ViewBuilder
    private func loaded(_ detail: GoalDetail) -> some View {
        let goal = detail.goal
        let archived = goal.status == "archived"
        VStack(alignment: .leading, spacing: 6) {
            Text(goal.title).psycheTitle()
            EvidenceLine(
                [ProactiveText.goalStatus(goal.status)]
                    + (goal.nextCheckinAt.map { [String(localized: "Next check-in \(ProactiveText.when($0))", bundle: .module)] } ?? []))
        }
        if goal.status == "candidate" {
            HStack(spacing: 20) {
                Button(String(localized: "Add goal", bundle: .module)) { decide(.confirm, goal) }
                    .proactiveAction(prominent: true)
                    .disabled(model.busy)
                Button(String(localized: "Not now", bundle: .module)) { decide(.later, goal) }
                    .proactiveAction()
                    .disabled(model.busy)
                Button(String(localized: "Dismiss", bundle: .module)) { decide(.reject, goal) }
                    .proactiveAction()
                    .disabled(model.busy)
            }
        } else {
            let choices = GoalsModel.choices(for: goal.status)
            if !choices.isEmpty {
                HStack(spacing: 20) {
                    ForEach(choices, id: \.self) { choice in
                        Button(ProactiveText.goalChange(choice, from: goal.status)) {
                            Task { await model.setStatus(choice, for: goal) }
                        }
                        .proactiveAction(prominent: choice == .active)
                        .disabled(model.busy)
                    }
                }
            }
        }
        if goal.status == "active" {
            suggestion(goal)
        }
        if let progress = detail.progress {
            VStack(alignment: .leading, spacing: 8) {
                ProgressBar(fraction: progress)
                let done = detail.milestones.filter(\.done).count
                Text("\(done) of \(detail.milestones.count) milestones done", bundle: .module)
                    .font(.footnote).foregroundStyle(PsycheColor.muted)
            }
        }
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(String(localized: "Milestones", bundle: .module))
            if detail.milestones.isEmpty {
                Text("No milestones yet.", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
            } else {
                PaperCard {
                    ForEach(Array(detail.milestones.enumerated()), id: \.element.id) { index, milestone in
                        if index > 0 { HairlineDivider() }
                        milestoneRow(milestone, goal: goal, editable: !archived)
                    }
                }
            }
            if !archived {
                Button(String(localized: "Add milestone", bundle: .module)) { addingMilestone = true }
                    .proactiveAction()
                    .disabled(model.busy)
            }
        }
        linkedGoalItems(detail, archived: archived)
        if !archived && goal.status != "candidate" {
            Button(String(localized: "Archive goal", bundle: .module), role: .destructive) { confirmingArchive = true }
                .proactiveAction()
                .disabled(model.busy)
        }
    }

    /// "Suggest a next step": the model's one idea for the goal, shown with Start and Not now. The request runs in a
    /// task the sheet cancels; nothing starts without the owner's Start.
    @ViewBuilder
    private func suggestion(_ goal: GoalItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(String(localized: "Next step", bundle: .module))
            switch model.suggest {
            case .idle:
                Button(String(localized: "Suggest a next step", bundle: .module)) { model.startSuggest(for: goal) }
                    .proactiveAction()
                    .disabled(model.busy)
                    .accessibilityIdentifier("goal.suggest")
            case .working:
                HStack(spacing: 12) {
                    ProgressView()
                    Text("Thinking of a next step…", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
                    Spacer(minLength: 0)
                    Button(String(localized: "Cancel", bundle: .module)) { model.cancelSuggest() }
                        .proactiveAction()
                        .accessibilityIdentifier("goal.suggest.cancel")
                }
                .accessibilityIdentifier("goal.suggest.working")
            case .offered(let idea):
                PaperCard {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(idea.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                        Text(idea.body).font(.subheadline).foregroundStyle(PsycheColor.muted)
                    }
                    .padding(PsycheMetrics.rowPadding)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                HStack(spacing: 20) {
                    Button(String(localized: "Start", bundle: .module)) { Task { await model.decideSuggestion(start: true) } }
                        .proactiveAction(prominent: true)
                        .accessibilityIdentifier("goal.suggest.start")
                    Button(String(localized: "Not now", bundle: .module)) { Task { await model.decideSuggestion(start: false) } }
                        .proactiveAction()
                        .accessibilityIdentifier("goal.suggest.notNow")
                }
            case .none:
                Text("No next step to suggest right now.", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
                Button(String(localized: "Try again", bundle: .module)) { model.startSuggest(for: goal) }
                    .proactiveAction()
            case .failed(let message):
                Text(message).font(.footnote).foregroundStyle(PsycheColor.red)
                Button(String(localized: "Try again", bundle: .module)) { model.startSuggest(for: goal) }
                    .proactiveAction()
            }
        }
    }

    /// The goal's linked tasks and automations by title. A task opens (its run page); a linked item can be unlinked
    /// from its context menu, as the desktop's Unlink does. "Link…" adds one more.
    @ViewBuilder
    private func linkedGoalItems(_ detail: GoalDetail, archived: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(String(localized: "Linked", bundle: .module))
            if detail.links.isEmpty {
                Text("No tasks or automations linked yet.", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
            } else {
                PaperCard {
                    ForEach(Array(detail.links.enumerated()), id: \.element) { index, link in
                        if index > 0 { HairlineDivider() }
                        linkRow(link, goal: detail.goal, archived: archived)
                    }
                }
            }
            if !archived {
                Button(String(localized: "Link…", bundle: .module)) { linking = true }
                    .proactiveAction()
                    .disabled(model.busy)
                    .accessibilityIdentifier("goal.link")
            }
        }
    }

    @ViewBuilder
    private func linkRow(_ link: GoalLinkTarget, goal: GoalItem, archived: Bool) -> some View {
        let fallback = link.isTask ? String(localized: "Task", bundle: .module) : String(localized: "Automation", bundle: .module)
        let label = HStack(spacing: 12) {
            Image(systemName: link.isTask ? "checklist" : "gearshape.2")
                .foregroundStyle(PsycheColor.muted)
            Text(model.linkTitles[link.id] ?? fallback)
                .font(.psycheRow).foregroundStyle(PsycheColor.text)
            Spacer(minLength: 0)
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        Group {
            if case .task(let id) = link {
                Button {
                    // The goal sheet is dismissing: its onDismiss opens the task's run page once it is gone.
                    dismiss()
                    router.deferOpen(appPath: "/task/\(id)")
                } label: {
                    label
                }
                .buttonStyle(.plain)
            } else {
                label
            }
        }
        .contextMenu {
            if !archived {
                Button(String(localized: "Unlink", bundle: .module), role: .destructive) {
                    Task { await model.unlink(link, from: goal) }
                }
                .accessibilityIdentifier("goal.unlink.\(link.id)")
            }
        }
        .accessibilityIdentifier("goal.link.\(link.id)")
    }

    /// A milestone with a checkbox to mark it done or not, its due date, and a button to remove it.
    @ViewBuilder
    private func milestoneRow(_ milestone: GoalMilestoneItem, goal: GoalItem, editable: Bool) -> some View {
        HStack(spacing: 12) {
            Button {
                Task { await model.changeMilestone(.setDone(id: milestone.id, !milestone.done), for: goal) }
            } label: {
                Image(systemName: milestone.done ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(milestone.done ? PsycheColor.green : PsycheColor.muted)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!editable || model.busy)
            .accessibilityLabel(milestone.done ? String(localized: "Mark not done", bundle: .module) : String(localized: "Mark done", bundle: .module))
            VStack(alignment: .leading, spacing: 2) {
                Text(milestone.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                if let due = milestone.dueAt {
                    Text("Due \(due.formatted(.dateTime.month(.abbreviated).day()))", bundle: .module)
                        .font(.footnote).foregroundStyle(PsycheColor.muted)
                }
            }
            Spacer(minLength: 0)
            if editable {
                Button {
                    Task { await model.changeMilestone(.remove(id: milestone.id), for: goal) }
                } label: {
                    Image(systemName: "minus.circle")
                        .foregroundStyle(PsycheColor.muted)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(model.busy)
                .accessibilityLabel(String(localized: "Remove milestone", bundle: .module))
            }
        }
        .padding(PsycheMetrics.rowPadding)
    }
}

/// "Link…": the tasks and automations the goal does not link yet, in two sections. Tapping one links it; a refusal
/// stays on the sheet in the Gateway's words.
private struct LinkGoalSheet: View {
    let goal: GoalItem
    let model: GoalsModel
    @Environment(\.dismiss) private var dismiss
    @State private var choices: (tasks: [GoalsModel.LinkChoice], automations: [GoalsModel.LinkChoice])?
    @State private var linking: String?
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            List {
                if let choices {
                    if choices.tasks.isEmpty && choices.automations.isEmpty {
                        Text("Nothing to link right now.", bundle: .module).foregroundStyle(PsycheColor.muted)
                    }
                    if !choices.tasks.isEmpty {
                        Section(String(localized: "Tasks", bundle: .module)) {
                            ForEach(choices.tasks) { choice in linkButton(choice) }
                        }
                    }
                    if !choices.automations.isEmpty {
                        Section(String(localized: "Automations", bundle: .module)) {
                            ForEach(choices.automations) { choice in linkButton(choice) }
                        }
                    }
                }
            }
            .navigationTitle(String(localized: "Link to this goal", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel", bundle: .module)) { dismiss() }
                        .disabled(linking != nil)
                }
            }
            .safeAreaInset(edge: .bottom) {
                if let failure {
                    Text(failure).font(.footnote).foregroundStyle(PsycheColor.red).padding()
                }
            }
        }
        .presentationDragIndicator(.visible)
        .task { choices = await model.linkChoices() }
    }

    private func linkButton(_ choice: GoalsModel.LinkChoice) -> some View {
        Button(choice.title) {
            Task { await link(choice.target) }
        }
        .disabled(linking != nil)
        .accessibilityIdentifier("goal.link.row.\(choice.id)")
    }

    private func link(_ target: GoalLinkTarget) async {
        linking = target.id
        failure = nil
        defer { linking = nil }
        do {
            try await model.link(target, to: goal)
            dismiss()
        } catch {
            failure = error.localizedDescription
        }
    }
}

// MARK: Scheduled

struct ScheduledView: View {
    @State private var model: ScheduledModel
    @State private var confirmingRun: ScheduledJob?
    @State private var confirmingDelete: ScheduledJob?
    @State private var editing: ScheduledJob?
    @State private var adding = false
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
        _model = State(initialValue: ScheduledModel(store: store))
    }

    var body: some View {
        ProactivePage(
            title: String(localized: "Scheduled", bundle: .module), phase: model.phase, skeleton: .skeleton,
            load: model.load, observe: model.observe
        ) { overview in
            if overview.items.isEmpty && overview.runs.isEmpty {
                EmptyLine(text: String(localized: "Nothing scheduled.", bundle: .module))
            }
            if !overview.items.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader(String(localized: "Schedule", bundle: .module))
                    PaperCard {
                        ForEach(Array(overview.items.enumerated()), id: \.element.id) { index, job in
                            if index > 0 { HairlineDivider() }
                            jobRow(job)
                        }
                    }
                }
            }
            ActionError(message: model.actionError)
            if !overview.runs.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader(String(localized: "Recent runs", bundle: .module))
                    PaperCard {
                        ForEach(Array(overview.runs.enumerated()), id: \.element.id) { index, run in
                            if index > 0 { HairlineDivider() }
                            VStack(alignment: .leading, spacing: 4) {
                                Text(run.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                                HStack(spacing: 8) {
                                    StatusDot(ProactiveText.runDot(run.state), ProactiveText.runLine(run))
                                    EvidenceLine([ProactiveText.when(run.startedAt)])
                                }
                            }
                            .padding(PsycheMetrics.rowPadding)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
            }
        }
        .confirmationDialog(
            String(localized: "Run this now?", bundle: .module),
            isPresented: Binding(get: { confirmingRun != nil }, set: { if !$0 { confirmingRun = nil } }),
            titleVisibility: .visible, presenting: confirmingRun
        ) { job in
            Button(String(localized: "Run now", bundle: .module)) { Task { await model.runNow(job) } }
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
        } message: { _ in
            Text("This can take actions for you. Anything that needs your approval still waits for you.", bundle: .module)
        }
        .confirmationDialog(
            String(localized: "Delete this automation?", bundle: .module),
            isPresented: Binding(get: { confirmingDelete != nil }, set: { if !$0 { confirmingDelete = nil } }),
            titleVisibility: .visible, presenting: confirmingDelete
        ) { job in
            Button(String(localized: "Delete", bundle: .module), role: .destructive) { Task { await model.delete(job) } }
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
        } message: { _ in
            Text("It won't run again, and this can't be undone.", bundle: .module)
        }
        .sheet(item: $editing) { job in
            AutomationEditorSheet(store: store, automationID: job.id) { Task { await model.load() } }
        }
        .sheet(isPresented: $adding) {
            AutomationEditorSheet(store: store, automationID: nil) { Task { await model.load() } }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { adding = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel(String(localized: "New automation", bundle: .module))
            }
        }
    }

    private func jobRow(_ job: ScheduledJob) -> some View {
        let busy = model.isBusy(job.id)
        return VStack(alignment: .leading, spacing: 6) {
            if job.isRoutine {
                Text(job.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
            } else {
                Button { editing = job } label: {
                    Text(job.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                }
                .buttonStyle(.plain)
            }
            EvidenceLine([ProactiveText.scheduleLine(job)])
            if job.state != "off" {
                HStack(spacing: 20) {
                    if job.state == "active" || job.state == "paused" {
                        Button(job.state == "paused" ? String(localized: "Resume", bundle: .module) : String(localized: "Pause", bundle: .module)) {
                            Task { await model.togglePause(job) }
                        }
                        .proactiveAction()
                        .disabled(busy)
                    }
                    Button(String(localized: "Run now", bundle: .module)) {
                        if job.confirmsRunNow { confirmingRun = job } else { Task { await model.runNow(job) } }
                    }
                    .proactiveAction()
                    .disabled(busy)
                }
            }
            if !job.isRoutine {
                HStack(spacing: 20) {
                    Button(String(localized: "Edit", bundle: .module)) { editing = job }
                        .proactiveAction()
                    Button(String(localized: "Delete", bundle: .module), role: .destructive) { confirmingDelete = job }
                        .proactiveAction()
                }
            }
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: Home sections

/// Feed, Ideas and Goals on Home's models, kept by Home so its pull to refresh can reload them with the rest.
@MainActor @Observable
final class ProactiveHomeModel {
    let feed: FeedModel
    let ideas: IdeasModel
    let goals: GoalsModel

    init(store: any PsycheBackend, reloadDelay: Duration = proactiveReloadDelay) {
        feed = FeedModel(store: store, reloadDelay: reloadDelay)
        ideas = IdeasModel(store: store, reloadDelay: reloadDelay)
        goals = GoalsModel(store: store, reloadDelay: reloadDelay)
    }

    func load() async {
        async let a: Void = feed.load()
        async let b: Void = ideas.load()
        async let c: Void = goals.load()
        _ = await (a, b, c)
    }

    /// Each section reloads on its change events and on a resync, until the view goes away.
    func observe() async {
        async let a: Void = feed.observe()
        async let b: Void = ideas.observe()
        async let c: Void = goals.observe()
        _ = await (a, b, c)
    }

    /// Goals on Home are the ones still in play; done goals stay on the Goals page.
    var homeGoals: [GoalItem] { (goals.phase.value ?? []).filter { $0.status != "done" } }
}
