import PsycheDesign
import PsycheStore
import SwiftUI

/// One automation's past runs, newest first: status, when it started, how long it took, and why a failed run failed.
/// The list loads a page at a time as the owner reaches the end (`automations.runs`). A run with a task opens that
/// task's run page; a run without one has no tap.
struct AutomationRunsScreen: View {
    @State private var model: PagedRows<AutomationRunItem>
    private let store: any PsycheBackend

    init(store: any PsycheBackend, automationID: String) {
        self.store = store
        _model = State(initialValue: PagedRows<AutomationRunItem> { cursor in
            let page = try await store.automationRuns(id: automationID, cursor: cursor)
            return (page.runs, page.nextCursor)
        })
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                switch model.phase {
                case .idle, .loading:
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                case .failed:
                    FailedNotice { Task { await model.reload() } }
                case .loaded(let runs) where runs.isEmpty:
                    Text("No runs yet", bundle: .module).font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text)
                    Text("Runs appear here once this automation has run.", bundle: .module)
                        .font(.footnote).foregroundStyle(PsycheColor.muted)
                case .loaded(let runs):
                    PaperCard {
                        VStack(spacing: 0) {
                            ForEach(Array(runs.enumerated()), id: \.element.id) { index, run in
                                if index > 0 { HairlineDivider().padding(.leading, 14) }
                                AutomationRunRow(run: run, store: store)
                            }
                        }
                    }
                    // The next page loads when this row appears; its cursor is its id, so each page is a new row.
                    if model.moreFailed {
                        FailedNotice { Task { await model.retryMore() } }
                    } else if let cursor = model.nextCursor {
                        PageSentinel(loading: model.loadingMore, label: String(localized: "Loading more runs", bundle: .module))
                            .id(cursor)
                            .onAppear { Task { await model.loadMore() } }
                    }
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .refreshable { await model.reload() }
        .psycheScreen()
        .psycheInlineTitle()
        .navigationTitle(String(localized: "Past runs", bundle: .module))
        .task { if model.phase.value == nil { await model.reload() } }
    }
}

private struct AutomationRunRow: View {
    let run: AutomationRunItem
    let store: any PsycheBackend

    var body: some View {
        if let taskID = run.taskID {
            NavigationLink { TaskRunView(store: store, taskID: taskID) } label: { AutomationRunLabel(run: run, tappable: true) }
                .buttonStyle(.plain)
        } else {
            AutomationRunLabel(run: run, tappable: false)
        }
    }
}

private struct AutomationRunLabel: View {
    let run: AutomationRunItem
    let tappable: Bool

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                StatusDot(dotKind, statusText, textColor: PsycheColor.text, font: .psycheRow.weight(.medium))
                Text(verbatim: details)
                    .font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted)
                if run.status == .failed, let reason = run.summary, !reason.isEmpty {
                    Text(verbatim: reason)
                        .font(.footnote).foregroundStyle(PsycheColor.muted)
                        .lineLimit(3).multilineTextAlignment(.leading)
                }
            }
            Spacer(minLength: 8)
            if tappable {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold)).foregroundStyle(PsycheColor.rule)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var dotKind: StatusDot.Kind {
        switch run.status {
        case .done: .done
        case .failed: .failed
        case .running, .noReply, .cancelled, .skipped: .neutral
        }
    }

    private var statusText: String {
        switch run.status {
        case .running: String(localized: "Running", bundle: .module)
        case .done: String(localized: "Done", bundle: .module)
        case .noReply: String(localized: "No reply", bundle: .module)
        case .failed: String(localized: "Failed", bundle: .module)
        case .cancelled: String(localized: "Cancelled", bundle: .module)
        case .skipped: String(localized: "Skipped", bundle: .module)
        }
    }

    /// When it started, and how long it took once it has ended.
    private var details: String {
        let when = DateFormatter.localizedString(from: run.startedAt, dateStyle: .medium, timeStyle: .short)
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.hour, .minute, .second]
        formatter.unitsStyle = .abbreviated
        formatter.maximumUnitCount = 2
        guard let duration = run.duration, let took = formatter.string(from: duration) else { return when }
        return "\(when) \u{00B7} \(took)"
    }
}
