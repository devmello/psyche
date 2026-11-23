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
        default: String(localized: "Active", bundle: .module)
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

    init(store: any PsycheBackend) { _model = State(initialValue: FeedModel(store: store)) }

    var body: some View {
        ProactivePage(
            title: String(localized: "Feed", bundle: .module), phase: model.phase, skeleton: .skeleton,
            load: model.load, observe: model.observe
        ) { snapshot in
            if snapshot.cards.isEmpty {
                EmptyLine(text: String(localized: "Nothing new in your feed.", bundle: .module))
            } else {
                ForEach(snapshot.cards) { card in cardView(card) }
            }
            if let next = snapshot.nextBriefAt {
                Text("Next brief \(ProactiveText.when(next))", bundle: .module).font(.footnote).foregroundStyle(PsycheColor.muted)
            }
            ActionError(message: model.actionError)
        }
        .confirmationDialog(
            String(localized: "Open this link?", bundle: .module), isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
            presenting: confirming
        ) { url in
            Button(String(localized: "Open \(url.host ?? "link")", bundle: .module)) { openURL(url) }
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
            }
            ActionError(message: model.actionError)
        }
    }
}

// MARK: Goals

struct GoalsView: View {
    @State private var model: GoalsModel
    @State private var showing = false

    init(store: any PsycheBackend) { _model = State(initialValue: GoalsModel(store: store)) }

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
                Text("Edit goal details and check-ins on your Mac.", bundle: .module).font(.footnote).foregroundStyle(PsycheColor.muted)
            }
        }
        .sheet(isPresented: $showing, onDismiss: model.close) {
            GoalSheet(model: model)
        }
    }
}

private struct GoalSheet: View {
    let model: GoalsModel

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
    }

    @ViewBuilder
    private func loaded(_ detail: GoalDetail) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(detail.goal.title).psycheTitle()
            EvidenceLine(
                [ProactiveText.goalStatus(detail.goal.status)]
                    + (detail.goal.nextCheckinAt.map { [String(localized: "Next check-in \(ProactiveText.when($0))", bundle: .module)] } ?? []))
        }
        let choices = GoalsModel.choices(for: detail.goal.status)
        if !choices.isEmpty {
            HStack(spacing: 20) {
                ForEach(choices, id: \.self) { choice in
                    Button(ProactiveText.goalChange(choice, from: detail.goal.status)) {
                        Task { await model.setStatus(choice, for: detail.goal) }
                    }
                    .proactiveAction(prominent: choice == .active)
                    .disabled(model.busy)
                }
            }
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
                        HStack(spacing: 12) {
                            Image(systemName: milestone.done ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(milestone.done ? PsycheColor.green : PsycheColor.muted)
                                .accessibilityHidden(true)
                            Text(milestone.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                            Spacer(minLength: 0)
                        }
                        .padding(PsycheMetrics.rowPadding)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
    }
}

// MARK: Scheduled

struct ScheduledView: View {
    @State private var model: ScheduledModel
    @State private var confirmingRun: ScheduledJob?

    init(store: any PsycheBackend) { _model = State(initialValue: ScheduledModel(store: store)) }

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
            Text("Edit schedules and prompts on your Mac.", bundle: .module).font(.footnote).foregroundStyle(PsycheColor.muted)
        }
        .confirmationDialog(
            String(localized: "Run this now?", bundle: .module),
            isPresented: Binding(get: { confirmingRun != nil }, set: { if !$0 { confirmingRun = nil } }),
            titleVisibility: .visible, presenting: confirmingRun
        ) { job in
            Button(String(localized: "Run now", bundle: .module)) { Task { await model.runNow(job) } }
        } message: { _ in
            Text("This can take actions for you. Anything that needs your approval still waits for you.", bundle: .module)
        }
    }

    private func jobRow(_ job: ScheduledJob) -> some View {
        let busy = model.isBusy(job.id)
        return VStack(alignment: .leading, spacing: 6) {
            Text(job.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
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
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: Home sections

/// Feed, Ideas and Goals on Home: the top few of each, with "See all" to the full page. Empty ones aren't drawn,
/// and a section that fails to load is left out rather than breaking Home.
struct ProactiveHomeSections: View {
    @State private var feed: FeedModel
    @State private var ideas: IdeasModel
    @State private var goals: GoalsModel
    @Environment(Router.self) private var router

    init(store: any PsycheBackend) {
        _feed = State(initialValue: FeedModel(store: store))
        _ideas = State(initialValue: IdeasModel(store: store))
        _goals = State(initialValue: GoalsModel(store: store))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
            if let cards = feed.phase.value?.cards, !cards.isEmpty {
                section(String(localized: "Feed", bundle: .module), count: cards.count, route: .feed) {
                    ForEach(Array(cards.prefix(3).enumerated()), id: \.element.id) { index, card in
                        if index > 0 { HairlineDivider() }
                        row(card.title, detail: ProactiveText.when(card.createdAt))
                    }
                }
            }
            if let items = ideas.phase.value, !items.isEmpty {
                section(String(localized: "Ideas", bundle: .module), count: items.count, route: .ideas) {
                    ForEach(Array(items.prefix(2).enumerated()), id: \.element.id) { index, idea in
                        if index > 0 { HairlineDivider() }
                        row(idea.title, detail: idea.effort)
                    }
                }
            }
            if let items = goals.phase.value, !items.isEmpty {
                section(String(localized: "Goals", bundle: .module), count: items.count, route: .goals) {
                    ForEach(Array(items.prefix(3).enumerated()), id: \.element.id) { index, goal in
                        if index > 0 { HairlineDivider() }
                        row(goal.title, detail: ProactiveText.goalStatus(goal.status))
                    }
                }
            }
        }
        .task {
            async let a: Void = feed.load()
            async let b: Void = ideas.load()
            async let c: Void = goals.load()
            _ = await (a, b, c)
        }
    }

    private func section<Rows: View>(_ title: String, count: Int, route: Route, @ViewBuilder rows: () -> Rows) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                SectionHeader(title, count: count)
                Spacer(minLength: 0)
                Button(String(localized: "See all", bundle: .module)) { router.homePath.append(route) }
                    .proactiveAction()
            }
            Button { router.homePath.append(route) } label: {
                PaperCard { rows() }
            }
            .buttonStyle(.plain)
        }
    }

    private func row(_ title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.psycheRow).foregroundStyle(PsycheColor.text).lineLimit(2).multilineTextAlignment(.leading)
            if !detail.isEmpty { EvidenceLine([detail]) }
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
