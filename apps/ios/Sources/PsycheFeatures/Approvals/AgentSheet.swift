import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// The agent sheet (docs/design/ios-app-2026.md §4.8): Activity, Approvals, Upcoming and Soul.
struct AgentSheet: View {
    enum Segment: String, CaseIterable, Identifiable {
        case activity = "Activity", approvals = "Approvals", upcoming = "Upcoming", soul = "Soul"
        var id: String { rawValue }
    }

    @State private var model: AgentModel
    @State private var segment = Segment.activity
    @State private var cancelling: RunningTask?
    /// The task whose run page is open (a nested sheet).
    @State private var openedTaskID: String?
    @Environment(Router.self) private var router
    @Environment(Session.self) private var session
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
        _model = State(initialValue: AgentModel(store: store))
        #if DEBUG
        // `-psycheSegment Soul` for screenshots.
        _segment = State(initialValue: UserDefaults.standard.string(forKey: "psycheSegment").flatMap(Segment.init(rawValue:)) ?? .activity)
        #endif
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker(String(localized: "Section", bundle: .module), selection: $segment) {
                        ForEach(Segment.allCases) { Text(LocalizedStringKey($0.rawValue), bundle: .module).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 8, trailing: 16))
                }
                if let error = model.error {
                    Section { StatusDot(.failed, error, textColor: .primary) }
                }
                switch segment {
                case .soul:
                    soul
                default:
                    PhaseView(phase: model.phase, skeleton: .skeleton, retry: model.load) { activity in
                        switch segment {
                        case .activity: activityView(activity)
                        case .approvals: approvals(activity)
                        default: upcoming(activity)
                        }
                    }
                }
            }
            // Tasks and approvals arriving or leaving: fade, then the gap closes on the smooth spring.
            .psycheAnimation(.smooth, value: model.phase.value.map(Self.identity))
            .navigationTitle(model.persona?.name ?? "Psyche")
            .navigationSubtitle(statusLine)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                // Settings from the sheet (§4.7) without the long-press, which few people find.
                ToolbarItem(placement: .primaryAction) {
                    Button { router.sheet = .settings } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel(String(localized: "Settings", bundle: .module))
                }
            }
        }
        .presentationDragIndicator(.visible)
        .presentationDetents([.medium, .large])
        .task {
            await model.load()
            await model.observe()
        }
        .onAppear(perform: consumeFocus)
        .onChange(of: router.agentFocus) { consumeFocus() }
        .confirmationDialog(
            cancelling.map { "Cancel “\($0.title)”?" } ?? "", isPresented: Binding(
                get: { cancelling != nil }, set: { if !$0 { cancelling = nil } }),
            titleVisibility: .visible, presenting: cancelling
        ) { task in
            Button(String(localized: "Cancel task", bundle: .module), role: .destructive) { Task { await model.cancel(taskID: task.id) } }
            Button(String(localized: "Keep running", bundle: .module), role: .cancel) {}
        } message: { _ in
            Text("Psyche stops where it is. Work already done stays.", bundle: .module)
        }
        .sheet(isPresented: Binding(get: { openedTaskID != nil }, set: { if !$0 { openedTaskID = nil } })) {
            if let taskID = openedTaskID {
                NavigationStack { TaskRunView(store: store, taskID: taskID) }
                    .presentationDragIndicator(.visible)
            }
        }
    }

    /// Applies the router's request (a task's run page, or the Approvals segment) and clears it, so a later open asks again.
    private func consumeFocus() {
        guard let focus = router.agentFocus else { return }
        router.agentFocus = nil
        switch focus {
        case .task(let id): openedTaskID = id
        case .approvals: segment = .approvals
        }
    }

    /// What the Activity lists hold, by id: a change is an item arriving or leaving, not a progress tick.
    private static func identity(_ activity: AgentActivity) -> [String] {
        activity.needsYou.map(\.id) + activity.now.map(\.id) + activity.nextUp.map(\.id) + activity.recent.map(\.id)
    }

    /// Idle, working on N, or N need you: what used to sit under the avatar.
    private var statusLine: String {
        guard let activity = model.phase.value else { return "" }
        if activity.needsYou.isEmpty {
            return activity.now.isEmpty ? String(localized: "Idle", bundle: .module) : String(localized: "Working on \(activity.now.count)", bundle: .module)
        }
        return "\(activity.needsYou.count) need\(activity.needsYou.count == 1 ? "s" : "") you"
    }

    // MARK: Activity

    @ViewBuilder
    private func activityView(_ activity: AgentActivity) -> some View {
        if activity.needsYou.isEmpty && activity.now.isEmpty && activity.nextUp.isEmpty && activity.recent.isEmpty {
            quiet(String(localized: "Nothing going on right now.", bundle: .module))
        }
        if !activity.needsYou.isEmpty {
            Section(String(localized: "Needs you", bundle: .module)) { needsYouRows(activity.needsYou) }
        }
        if !activity.now.isEmpty {
            Section(String(localized: "Now", bundle: .module)) {
                ForEach(activity.now, id: \.id) { nowRow($0) }
            }
        }
        if !activity.nextUp.isEmpty {
            Section(String(localized: "Next up", bundle: .module)) { upcomingRows(Array(activity.nextUp.prefix(3))) }
        }
        if !activity.recent.isEmpty {
            Section(String(localized: "Recent", bundle: .module)) { recentRows(activity.recent) }
        }
    }

    private func meta(_ parts: [String]) -> some View {
        Text(parts.joined(separator: " \u{B7} ")).font(.caption).foregroundStyle(.secondary)
    }

    @ViewBuilder
    private func needsYouRows(_ items: [NeedsYouItem]) -> some View {
        ForEach(items, id: \.id) { item in
            let canAnswer = session.state.canAnswer
            let row = HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title).foregroundStyle(.primary).multilineTextAlignment(.leading)
                    meta(canAnswer ? [item.kind.label, item.source, item.time] : [item.kind.label, String(localized: "reconnect to answer", bundle: .module)])
                }
                Spacer(minLength: 0)
                if canAnswer {
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
            if canAnswer {
                // Opening the card is a plain tap; the answer itself is in the approval sheet.
                Button { router.open(item) } label: { row }.buttonStyle(.plain)
            } else {
                row
            }
        }
    }

    private func nowRow(_ task: RunningTask) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { openedTaskID = task.id } label: {
                Text(task.title).foregroundStyle(.primary).multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            ProgressView(value: min(max(task.fraction, 0), 1)).accessibilityHidden(true)
            meta([String(localized: "Step \(task.step) of \(task.stepCount)", bundle: .module), task.detail, task.elapsed])
        }
        .padding(.vertical, 2)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            // Away from home there is nothing to cancel with: the action is not offered.
            if session.state.canAnswer {
                Button(role: .destructive) { cancelling = task } label: {
                    Label(String(localized: "Cancel", bundle: .module), systemImage: "xmark")
                }
            }
        }
        .contextMenu {
            Button { openedTaskID = task.id } label: { Label(String(localized: "Open", bundle: .module), systemImage: "arrow.up.right") }
            if session.state.canAnswer {
                Button(role: .destructive) { cancelling = task } label: { Label(String(localized: "Cancel", bundle: .module), systemImage: "xmark") }
            }
        }
    }

    @ViewBuilder
    private func upcomingRows(_ items: [UpcomingItem]) -> some View {
        ForEach(items, id: \.id) { item in
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                meta([item.when])
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private func recentRows(_ runs: [RecentRun]) -> some View {
        ForEach(runs, id: \.id) { run in
            Button { openedTaskID = run.id } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(run.title).foregroundStyle(.primary)
                    HStack(spacing: 8) {
                        StatusDot(run.outcome.dot, run.outcome.label)
                        Text(run.time).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: Approvals, Upcoming, Soul

    @ViewBuilder
    private func approvals(_ activity: AgentActivity) -> some View {
        let pending = activity.needsYou.filter { $0.kind == .approval }
        if pending.isEmpty {
            quiet(String(localized: "No approvals waiting.", bundle: .module))
        } else {
            Section(String(localized: "Waiting for you", bundle: .module)) { needsYouRows(pending) }
        }
    }

    @ViewBuilder
    private func upcoming(_ activity: AgentActivity) -> some View {
        if activity.nextUp.isEmpty {
            quiet(String(localized: "Nothing scheduled.", bundle: .module))
        } else {
            Section { upcomingRows(activity.nextUp) }
        }
    }

    @ViewBuilder
    private var soul: some View {
        if let persona = model.persona {
            Section {
                Text(persona.summary)
                if !persona.files.isEmpty {
                    meta(persona.files)
                }
            } header: {
                Text("Soul", bundle: .module)
            } footer: {
                Text("Edit on your Mac", bundle: .module)
            }
        } else {
            quiet(String(localized: "Loading…", bundle: .module))
        }
    }

    private func quiet(_ text: String) -> some View {
        Text(text).font(.subheadline).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity).padding(.vertical, 24)
            .listRowBackground(Color.clear)
    }
}

extension RecentRun.Outcome {
    var dot: StatusDot.Kind {
        switch self {
        case .done: .done
        case .failed: .failed
        case .cancelled: .neutral
        }
    }

    var label: String {
        switch self {
        case .done: String(localized: "Done", bundle: .module)
        case .failed: String(localized: "Failed", bundle: .module)
        case .cancelled: String(localized: "Cancelled", bundle: .module)
        }
    }
}
