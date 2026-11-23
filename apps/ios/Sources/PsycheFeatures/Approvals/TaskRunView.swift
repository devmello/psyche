import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// One task's run page: its status and times, its latest run's steps, and the owner's controls. Pause, resume,
/// retry, steer and cancel each show only when the task's state allows it (`TaskRunControls`).
struct TaskRunView: View {
    @State private var model: TaskRunModel
    @State private var draft = ""
    @State private var confirmingCancel = false
    @Environment(Session.self) private var session

    init(store: any PsycheBackend, taskID: String) {
        _model = State(initialValue: TaskRunModel(store: store, taskID: taskID))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                PhaseView(phase: model.phase, skeleton: .skeleton, retry: model.load) { run in
                    header(run)
                    if !run.controls.isEmpty { controls(run) }
                    steps(run)
                }
                if let error = model.error {
                    StatusDot(.failed, error, textColor: PsycheColor.text)
                }
            }
            .padding(PsycheMetrics.pagePadding)
            .padding(.top, 8)
        }
        .psycheScreen()
        .navigationTitle(model.phase.value?.title ?? String(localized: "Task", bundle: .module))
        .psycheInlineTitle()
        .task { await model.load() }
        .task { await model.observe() }
        .task { await model.pollWhileLive() }
        .confirmationDialog(
            String(localized: "Cancel task", bundle: .module), isPresented: $confirmingCancel, titleVisibility: .visible
        ) {
            Button(String(localized: "Cancel task", bundle: .module), role: .destructive) { Task { await model.cancel() } }
            Button(String(localized: "Keep running", bundle: .module), role: .cancel) {}
        } message: {
            Text("Psyche stops where it is. Work already done stays.", bundle: .module)
        }
    }

    // MARK: Header

    private func header(_ run: TaskRunDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(run.title).psycheTitle(.title)
            StatusDot(run.state.dot, run.state.label)
            PaperCard(padding: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    if let started = run.startedAt {
                        timeRow(String(localized: "Started", bundle: .module), Text(started.formatted(date: .abbreviated, time: .shortened)))
                        timeRow(String(localized: "Elapsed", bundle: .module), timer(from: started, to: run.endedAt))

                    }
                    if let summary = run.summary {
                        HairlineDivider()
                        Text(summary).font(.callout).foregroundStyle(PsycheColor.text)
                    }
                }
            }
        }
    }

    private func timeRow(_ label: String, _ value: Text) -> some View {
        HStack(spacing: 8) {
            Text(label).font(.footnote).foregroundStyle(PsycheColor.muted)
            Spacer(minLength: 8)
            value.font(.footnote.monospacedDigit()).foregroundStyle(PsycheColor.text)
        }
        .accessibilityElement(children: .combine)
    }

    /// Counts up while the step or task is still going, and stops at its end time once it has one.
    private func timer(from start: Date, to end: Date?) -> Text {
        Text(timerInterval: start...(end ?? .distantFuture), countsDown: false)
    }

    // MARK: Controls

    private func controls(_ run: TaskRunDetail) -> some View {
        let allowed = run.controls
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                if allowed.canPause {
                    Button(String(localized: "Pause", bundle: .module)) { Task { await model.pause() } }
                }
                if allowed.canResume {
                    Button(String(localized: "Resume", bundle: .module)) { Task { await model.resume() } }
                }
                if allowed.canRetry {
                    Button(String(localized: "Retry", bundle: .module)) { Task { await model.retry() } }
                }
                if allowed.canCancel {
                    Button(String(localized: "Cancel", bundle: .module), role: .destructive) { confirmingCancel = true }
                }
            }
            .buttonStyle(.bordered)
            if allowed.canSteer {
                HStack(alignment: .bottom, spacing: 10) {
                    TextField(String(localized: "Tell Psyche what to change", bundle: .module), text: $draft, axis: .vertical)
                        .lineLimit(1...4)
                        .textFieldStyle(.roundedBorder)
                    Button(String(localized: "Send guidance", bundle: .module)) {
                        let text = draft
                        Task { if await model.steer(text) { draft = "" } }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .disabled(!session.state.canAnswer || model.busy)
    }

    // MARK: Steps

    private func steps(_ run: TaskRunDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(String(localized: "Steps", bundle: .module))
            if run.steps.isEmpty {
                Text("No steps recorded yet.", bundle: .module)
                    .font(.subheadline).foregroundStyle(PsycheColor.muted)
            } else {
                PaperCard {
                    ForEach(Array(run.steps.enumerated()), id: \.element.id) { index, step in
                        if index > 0 { HairlineDivider() }
                        stepRow(step).transition(.opacity)
                    }
                }
            }
        }
    }

    private func stepRow(_ step: TaskRunStep) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(step.label).font(.psycheRow).foregroundStyle(PsycheColor.text)
                Spacer(minLength: 0)
                StatusDot(step.status.dot, step.status.label)
            }
            if let started = step.startedAt {
                timer(from: started, to: step.endedAt)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(PsycheColor.muted)
            }
            if let result = step.result {
                Text(result).font(.footnote).foregroundStyle(PsycheColor.muted).lineLimit(2)
            }
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

private extension TaskRunState {
    var label: String {
        switch self {
        case .queued: String(localized: "Queued", bundle: .module)
        case .running: String(localized: "Running", bundle: .module)
        case .awaitingInput: String(localized: "Awaiting your input", bundle: .module)
        case .awaitingApproval: String(localized: "Needs your OK", bundle: .module)
        case .paused: String(localized: "Paused", bundle: .module)
        case .done: String(localized: "Done", bundle: .module)
        case .failed: String(localized: "Failed", bundle: .module)
        case .cancelled: String(localized: "Cancelled", bundle: .module)
        }
    }

    var dot: StatusDot.Kind {
        switch self {
        case .done: .done
        case .failed: .failed
        case .awaitingInput, .awaitingApproval: .needsYou
        case .queued, .running, .paused, .cancelled: .neutral
        }
    }
}

private extension TaskRunStep.Status {
    var label: String {
        switch self {
        case .pending: String(localized: "Pending", bundle: .module)
        case .running: String(localized: "Running", bundle: .module)
        case .ok: String(localized: "Done", bundle: .module)
        case .failed: String(localized: "Failed", bundle: .module)
        case .waiting: String(localized: "Waiting", bundle: .module)
        case .cancelled: String(localized: "Cancelled", bundle: .module)
        case .skipped: String(localized: "Skipped", bundle: .module)
        case .denied: String(localized: "Denied", bundle: .module)
        }
    }

    var dot: StatusDot.Kind {
        switch self {
        case .ok: .done
        case .failed, .denied: .failed
        case .waiting: .needsYou
        case .pending, .running, .cancelled, .skipped: .neutral
        }
    }
}
