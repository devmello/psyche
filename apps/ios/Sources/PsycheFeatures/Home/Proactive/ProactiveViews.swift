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
            title: String(localized: "Scheduled tasks", bundle: .module), phase: model.phase, skeleton: .skeleton,
            load: model.load, observe: model.observe
        ) { overview in
            if overview.items.isEmpty && overview.runs.isEmpty && model.past.isEmpty {
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
            if !model.past.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader(String(localized: "Past", bundle: .module))
                    PaperCard {
                        ForEach(Array(model.past.enumerated()), id: \.element.id) { index, run in
                            if index > 0 { HairlineDivider() }
                            NavigationLink { TaskRunView(store: store, taskID: run.id) } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(run.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                                    HStack(spacing: 8) {
                                        StatusDot(run.outcome.dot, run.outcome.label)
                                        EvidenceLine([run.time])
                                    }
                                }
                                .padding(PsycheMetrics.rowPadding)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
            }
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
