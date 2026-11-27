import PsycheDesign
import PsycheStore
import SwiftUI

/// The fork card in the thread (`plan_fork` block): the labels as a title, one line per branch while it works, and the
/// headline once it is ready. A tap pushes the Plans view. It reads the fork itself, so a card that scrolls into view
/// is always current.
struct PlanForkCard: View {
    let forkID: String
    @State private var model: PlanForkModel
    @Environment(Router.self) private var router

    init(forkID: String, store: any PsycheBackend) {
        self.forkID = forkID
        _model = State(initialValue: PlanForkModel(forkID: forkID, store: store))
    }

    var body: some View {
        Group {
            switch model.phase {
            case .idle, .loading:
                PaperCard(padding: 14, radius: PsycheMetrics.approvalRadius) {
                    Text("Loading plans…", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
                }
            case .failed:
                PaperCard(padding: 14, radius: PsycheMetrics.approvalRadius) {
                    Text("These plans aren't available.", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
                }
            case .loaded(let detail):
                Button { router.showPlanFork(threadID: detail.fork.threadID, forkID: forkID) } label: { card(detail) }
                    .buttonStyle(.plain)
            }
        }
        .task {
            await model.load()
            await model.observe()
        }
    }

    private func card(_ detail: PlanForkDetail) -> some View {
        PaperCard(padding: 14, radius: PsycheMetrics.approvalRadius) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    StatusDot(
                        Self.dot(detail.fork.status), PlanForkText.status(detail.fork.status), textColor: PsycheColor.muted,
                        font: .footnote.weight(.semibold))
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(PsycheColor.muted)
                        .accessibilityHidden(true)
                }
                Text(verbatim: PlanForkText.title(detail.labels)).font(.callout.weight(.semibold)).foregroundStyle(PsycheColor.text)
                if detail.fork.status.isLive {
                    ForEach(detail.branches) { branch in
                        HStack(spacing: 6) {
                            Text(verbatim: branch.label)
                            Spacer(minLength: 8)
                            Text(PlanForkText.branchStatus(branch.status)).foregroundStyle(PsycheColor.muted)
                            if branch.status.isLive { ProgressView().controlSize(.mini) }
                        }
                        .font(.footnote)
                    }
                } else if detail.textHidden {
                    Text(PlanForkText.readOnMac).font(.footnote).foregroundStyle(PsycheColor.muted)
                } else if let headline = detail.fork.comparison?.headline, !headline.isEmpty {
                    Text(verbatim: headline).font(.footnote).foregroundStyle(PsycheColor.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }

    static func dot(_ status: PlanForkStatus) -> StatusDot.Kind {
        switch status {
        case .ready: .needsYou
        case .taken: .done
        case .failed: .failed
        case .running, .comparing, .dismissed, .expired, .cancelled: .neutral
        }
    }
}

/// The line posted in the chat when a plan is taken (`plan_taken`): which one, and a way back to the comparison.
struct PlanTakenRow: View {
    let forkID: String
    let branchID: String
    @State private var model: PlanForkModel
    @Environment(Router.self) private var router

    init(forkID: String, branchID: String, store: any PsycheBackend) {
        self.forkID = forkID
        self.branchID = branchID
        _model = State(initialValue: PlanForkModel(forkID: forkID, store: store))
    }

    var body: some View {
        let detail = model.detail
        let label = detail?.branch(branchID)?.label
        Button {
            if let detail { router.showPlanFork(threadID: detail.fork.threadID, forkID: forkID) }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle").foregroundStyle(PsycheColor.green)
                if let label {
                    Text("Plan taken: \(label).", bundle: .module)
                } else {
                    Text("Plan taken", bundle: .module)
                }
                Spacer(minLength: 0)
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(PsycheColor.muted)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(detail == nil)
        .task { await model.load() }
    }
}
