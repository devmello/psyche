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
    @Environment(Router.self) private var router
    @Environment(Session.self) private var session

    init(store: any PsycheBackend) {
        _model = State(initialValue: AgentModel(store: store))
        #if DEBUG
        // `-psycheSegment Soul` for screenshots.
        _segment = State(initialValue: UserDefaults.standard.string(forKey: "psycheSegment").flatMap(Segment.init(rawValue:)) ?? .activity)
        #endif
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                header
                Picker("Section", selection: $segment) {
                    ForEach(Segment.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                if let error = model.error {
                    StatusDot(.failed, error, textColor: PsycheColor.text)
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
            .padding(PsycheMetrics.pagePadding)
            .padding(.top, 8)
        }
        .psycheScreen()
        .presentationDragIndicator(.visible)
        .presentationDetents([.medium, .large])
        .task {
            await model.load()
            await model.observe()
        }
        .confirmationDialog(
            cancelling.map { "Cancel “\($0.title)”?" } ?? "", isPresented: Binding(
                get: { cancelling != nil }, set: { if !$0 { cancelling = nil } }),
            titleVisibility: .visible, presenting: cancelling
        ) { task in
            Button("Cancel task", role: .destructive) { Task { await model.cancel(taskID: task.id) } }
            Button("Keep running", role: .cancel) {}
        } message: { _ in
            Text("Psyche stops where it is. Work already done stays.")
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            MothAvatar(size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.persona?.name ?? "Psyche").psycheTitle(.title)
                if let activity = model.phase.value {
                    StatusDot(
                        activity.needsYou.isEmpty ? .neutral : .needsYou,
                        activity.needsYou.isEmpty
                            ? (activity.now.isEmpty ? "Idle" : "Working on \(activity.now.count)")
                            : "\(activity.needsYou.count) need\(activity.needsYou.count == 1 ? "s" : "") you")
                }
            }
            Spacer(minLength: 8)
            // Settings from the avatar (§4.7) without the long-press, which few people find.
            Button { router.sheet = .settings } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 17))
                    .foregroundStyle(PsycheColor.text)
                    .frame(width: 40, height: 40)
                    .glassEffect(.regular.interactive(), in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Settings")
        }
    }

    // MARK: Activity

    @ViewBuilder
    private func activityView(_ activity: AgentActivity) -> some View {
        if activity.needsYou.isEmpty && activity.now.isEmpty && activity.nextUp.isEmpty && activity.recent.isEmpty {
            quiet("Nothing going on right now.")
        }
        if !activity.needsYou.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Needs you", count: activity.needsYou.count, needsYou: true)
                needsYouCard(activity.needsYou)
            }
        }
        if !activity.now.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Now")
                PaperCard {
                    ForEach(Array(activity.now.enumerated()), id: \.element.id) { index, task in
                        if index > 0 { HairlineDivider() }
                        nowRow(task)
                    }
                }
            }
        }
        if !activity.nextUp.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Next up")
                upcomingCard(Array(activity.nextUp.prefix(3)))
            }
        }
        if !activity.recent.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Recent")
                recentCard(activity.recent)
            }
        }
    }

    private func needsYouCard(_ items: [NeedsYouItem]) -> some View {
        PaperCard {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 { HairlineDivider() }
                let row = NeedsYouRow(
                    title: item.title,
                    evidence: session.state.canAnswer ? [item.kind.label, item.source, item.time] : [item.kind.label, "reconnect to answer"],
                    showsChevron: session.state.canAnswer)
                if session.state.canAnswer {
                    Button { router.open(item) } label: { row }.buttonStyle(.plain)
                } else {
                    row
                }
            }
        }
    }

    private func nowRow(_ task: RunningTask) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(task.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                Spacer(minLength: 0)
                Button("Cancel") { cancelling = task }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(PsycheColor.muted)
                    .disabled(!session.state.canAnswer)
            }
            ProgressBar(fraction: task.fraction)
            EvidenceLine(["Step \(task.step) of \(task.stepCount)", task.detail, task.elapsed])
        }
        .padding(PsycheMetrics.rowPadding)
    }

    private func upcomingCard(_ items: [UpcomingItem]) -> some View {
        PaperCard {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 { HairlineDivider() }
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                    EvidenceLine([item.when])
                }
                .padding(PsycheMetrics.rowPadding)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func recentCard(_ runs: [RecentRun]) -> some View {
        PaperCard {
            ForEach(Array(runs.enumerated()), id: \.element.id) { index, run in
                if index > 0 { HairlineDivider() }
                VStack(alignment: .leading, spacing: 4) {
                    Text(run.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                    HStack(spacing: 8) {
                        StatusDot(run.outcome.dot, run.outcome.label)
                        EvidenceLine([run.time])
                    }
                }
                .padding(PsycheMetrics.rowPadding)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            }
        }
    }

    // MARK: Approvals, Upcoming, Soul

    @ViewBuilder
    private func approvals(_ activity: AgentActivity) -> some View {
        let pending = activity.needsYou.filter { $0.kind == .approval }
        if pending.isEmpty {
            quiet("No approvals waiting.")
        } else {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Waiting for you", count: pending.count, needsYou: true)
                needsYouCard(pending)
            }
        }
    }

    @ViewBuilder
    private func upcoming(_ activity: AgentActivity) -> some View {
        if activity.nextUp.isEmpty {
            quiet("Nothing scheduled.")
        } else {
            upcomingCard(activity.nextUp)
        }
    }

    @ViewBuilder
    private var soul: some View {
        if let persona = model.persona {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Soul")
                PaperCard(padding: 16) {
                    VStack(alignment: .leading, spacing: 14) {
                        Text(persona.summary).font(.callout).foregroundStyle(PsycheColor.text)
                        if !persona.files.isEmpty {
                            HairlineDivider()
                            EvidenceLine(persona.files)
                        }
                    }
                }
                Text("Edit on your Mac")
                    .font(.footnote).foregroundStyle(PsycheColor.muted)
                    .padding(.horizontal, 2)
            }
        } else {
            quiet("Loading…")
        }
    }

    private func quiet(_ text: String) -> some View {
        Text(text).font(.subheadline).foregroundStyle(PsycheColor.muted)
            .frame(maxWidth: .infinity).padding(.vertical, 24)
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
        case .done: "Done"
        case .failed: "Failed"
        case .cancelled: "Cancelled"
        }
    }
}
