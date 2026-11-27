import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// The Plans view (docs/design/fork-a-plan-2026.md §5.2): one lane per branch and a Compare tab, switched from the title menu
/// with the rows stacked by dimension, one block per branch inside each row. Everything is plain text from the Gateway's
/// scrubbed read; what it withheld shows as a count line ("1 more on your Mac"), never as a gap. Take opens the sheet.
struct PlanForkView: View {
    @State private var model: PlanForkModel
    @State private var tab: Tab = .compare
    @State private var showAllRows = false
    @State private var taking: PlanForkBranch?
    @Environment(Session.self) private var session
    @Environment(\.backend) private var store

    enum Tab: Hashable {
        case compare
        case branch(String)
    }

    init(forkID: String, store: any PsycheBackend) {
        _model = State(initialValue: PlanForkModel(forkID: forkID, store: store))
    }

    var body: some View {
        Group {
            switch model.phase {
            case .idle, .loading:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed:
                ContentUnavailableView {
                    Label(String(localized: "These plans aren't available.", bundle: .module), systemImage: "exclamationmark.triangle")
                } actions: {
                    Button(String(localized: "Retry", bundle: .module)) { Task { await model.load() } }
                }
            case .loaded(let detail):
                content(detail)
            }
        }
        .psycheScreen()
        .navigationTitle(navigationTitle)
        .psycheInlineTitle()
        .psycheShowsNavigationBar()
        // The plan switcher is the title menu (as in Chat), so each name shows in full rather than in a segment.
        .toolbarTitleMenu {
            if let detail = model.detail {
                Picker(String(localized: "Plans", bundle: .module), selection: $tab) {
                    Text("Compare", bundle: .module).tag(Tab.compare)
                    ForEach(detail.branches) { branch in
                        Text(verbatim: branch.label).tag(Tab.branch(branch.id))
                    }
                }
            }
        }
        .toolbar { toolbar }
        .task {
            await model.load()
            #if DEBUG
            applyLaunchArguments()
            #endif
            await model.observe()
        }
        .refreshable { await model.load() }
        .sheet(item: $taking) { branch in
            if let detail = model.detail {
                PlanForkTakeSheet(detail: detail, branch: branch, store: store) { Task { await model.load() } }
            }
        }
    }

    /// The current lane's name, or "Compare plans" on the Compare tab (or when that lane is gone).
    private var navigationTitle: String {
        if case .branch(let id) = tab, let branch = model.detail?.branch(id) { return branch.label }
        return String(localized: "Compare plans", bundle: .module)
    }

    #if DEBUG
    /// `simctl launch … -psycheForkTab 0` opens that lane (1 is the second; the Compare tab otherwise), and
    /// `-psycheForkSheet take` shows the Take sheet over the first branch that can be taken (screenshots; no taps).
    private func applyLaunchArguments() {
        guard let detail = model.detail else { return }
        let defaults = UserDefaults.standard
        if let lane = defaults.string(forKey: "psycheForkTab").flatMap(Int.init), detail.branches.indices.contains(lane) {
            tab = .branch(detail.branches[lane].id)
        }
        if defaults.string(forKey: "psycheForkSheet") == "take" { taking = detail.branches.first { detail.canTake($0) } }
    }
    #endif

    // MARK: Content

    private func content(_ detail: PlanForkDetail) -> some View {
        List {
            if let notice = model.notice {
                Section { StatusDot(.failed, notice) }
            }
            if detail.continuePending { continueSection }
            if detail.fork.status.isLive { progressSection(detail) }
            switch tab {
            case .compare: compare(detail)
            case .branch(let id):
                if let branch = detail.branch(id) { lane(detail, branch) } else { compare(detail) }
            }
        }
        .homeListStyle()
        .scrollContentBackground(.hidden)
        .safeAreaInset(edge: .bottom) { footer(detail) }
    }

    private var continueSection: some View {
        Section {
            Button { Task { await model.continuePlan() } } label: {
                Text("Continue", bundle: .module).font(.body.weight(.semibold))
            }
            .disabled(model.busy || !session.state.canAnswer)
        }
    }

    /// One line per branch while the fork runs, and Cancel.
    private func progressSection(_ detail: PlanForkDetail) -> some View {
        Section {
            ForEach(detail.branches) { branch in
                HStack {
                    Text(verbatim: branch.label)
                    Spacer()
                    Text(PlanForkText.branchStatus(branch.status)).foregroundStyle(PsycheColor.muted)
                    if branch.status.isLive { ProgressView().controlSize(.small) }
                }
                .font(.subheadline)
            }
            Button(String(localized: "Cancel", bundle: .module), role: .destructive) { Task { await model.cancel() } }
                .disabled(model.busy || !session.state.canAnswer)
        } header: {
            Text(PlanForkText.status(detail.fork.status))
        }
    }

    // MARK: Compare

    @ViewBuilder
    private func compare(_ detail: PlanForkDetail) -> some View {
        if let comparison = detail.fork.comparison {
            if detail.textHidden {
                Section { hiddenText }
            } else if !comparison.headline.isEmpty {
                Section { Text(verbatim: comparison.headline).font(.headline) }
            }
            totals(detail)
            let rows = detail.comparisonRows(showAll: showAllRows)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                Section {
                    ForEach(row.cells, id: \.branchID) { cell in
                        if let branch = detail.branch(cell.branchID) { block(branch, row: row, cell: cell) }
                    }
                } header: {
                    Text(PlanForkText.dimension(row.dimension))
                }
            }
            if (comparison.rows.count > detail.comparisonRows(showAll: false).count) || showAllRows {
                Section {
                    Toggle(isOn: $showAllRows) { Text("Show all rows", bundle: .module) }
                }
            }
            if !comparison.betterIf.isEmpty {
                Section {
                    ForEach(detail.branches.filter { comparison.betterIf[$0.id] != nil }) { branch in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: branch.label).font(.subheadline.weight(.semibold))
                            Text(verbatim: comparison.betterIf[branch.id] ?? "").font(.subheadline).foregroundStyle(PsycheColor.muted)
                        }
                    }
                }
            }
            hiddenCount(detail.hiddenItems)
        } else {
            Section {
                if detail.fork.status.isLive {
                    EmptyView()
                } else {
                    Text("The comparison isn't ready yet.", bundle: .module).foregroundStyle(PsycheColor.muted)
                }
            }
        }
    }

    /// Totals per branch, summed on the phone from the report's own items; "Total on your Mac" when a cost in them is
    /// withheld. The first deadline sits with them.
    private func totals(_ detail: PlanForkDetail) -> some View {
        Section {
            ForEach(detail.branches.filter { $0.report != nil }) { branch in
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: branch.label).font(.subheadline.weight(.semibold))
                    let lines = detail.totalLines(branch)
                    if lines.isEmpty {
                        Text("No costs found", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
                    }
                    ForEach(lines, id: \.self) { Text(verbatim: $0).font(.subheadline) }
                    if let deadline = branch.report?.earliestDeadline {
                        Text(verbatim: "\(deadline.label) · \(PlanForkText.date(deadline.date))")
                            .font(.footnote).foregroundStyle(PsycheColor.muted)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("Totals", bundle: .module)
        }
    }

    /// A branch's block inside one comparison row.
    private func block(_ branch: PlanForkBranch, row: PlanComparisonRow, cell: PlanComparisonCell) -> some View {
        let lines = branch.report?.lines(row.dimension, ids: cell.itemIDs) ?? []
        return VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: branch.label).font(.subheadline.weight(.semibold))
            if lines.isEmpty && branch.scrub.hiddenItems == 0 {
                Text(verbatim: "—").foregroundStyle(PsycheColor.muted)
            }
            ForEach(lines) { lineView($0) }
            if let note = cell.note, !branch.scrub.textHidden {
                Text(verbatim: note).font(.footnote).foregroundStyle(PsycheColor.muted)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    // MARK: Lanes

    @ViewBuilder
    private func lane(_ detail: PlanForkDetail, _ branch: PlanForkBranch) -> some View {
        Section {
            Text(verbatim: branch.premise).font(.subheadline).foregroundStyle(PsycheColor.muted)
            if branch.status != .reported { StatusDot(branch.status == .failed ? .failed : .neutral, PlanForkText.branchStatus(branch.status)) }
            if let error = branch.error, !error.isEmpty { Text(verbatim: error).font(.footnote).foregroundStyle(PsycheColor.muted) }
            if branch.scrub.textHidden { hiddenText } else if let summary = branch.report?.summary, !summary.isEmpty {
                Text(verbatim: summary)
            }
        }
        if let report = branch.report {
            if !report.steps.isEmpty {
                Section {
                    ForEach(report.steps) { step in stepRow(step) }
                } header: {
                    Text("Steps", bundle: .module)
                }
            }
            ForEach(PlanComparisonDimension.allCases, id: \.self) { dimension in
                let lines = report.lines(dimension)
                if !lines.isEmpty || (dimension == .cost && branch.scrub.totalsHidden) {
                    Section {
                        ForEach(lines) { lineView($0) }
                        if dimension == .cost {
                            ForEach(detail.totalLines(branch), id: \.self) { total in
                                Text(verbatim: total).font(.subheadline.weight(.semibold))
                            }
                        }
                    } header: {
                        Text(PlanForkText.dimension(dimension))
                    }
                }
            }
        }
        hiddenCount(branch.scrub.hiddenItems)
    }

    private func stepRow(_ step: PlanForkStep) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(verbatim: step.text)
            HStack(spacing: 10) {
                if step.prepared {
                    Text("Prepared", bundle: .module)
                } else if step.who == .psyche {
                    Text("Psyche does this after you take the plan", bundle: .module)
                } else {
                    Text("You do this", bundle: .module)
                }
                if let when = step.when { Text(verbatim: PlanForkText.date(when)) }
            }
            .font(.footnote).foregroundStyle(PsycheColor.muted)
        }
        .accessibilityElement(children: .combine)
    }

    private func lineView(_ line: PlanForkLine) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: line.title)
            if let detail = line.detail, !detail.isEmpty { Text(verbatim: detail).font(.subheadline).foregroundStyle(PsycheColor.muted) }
            let tags = tags(line)
            if !tags.isEmpty { Text(verbatim: tags.joined(separator: " · ")).font(.footnote).foregroundStyle(PsycheColor.muted) }
        }
        .accessibilityElement(children: .combine)
    }

    /// Estimate and No source are never hidden in a disclosure; where it came from follows.
    private func tags(_ line: PlanForkLine) -> [String] {
        var tags: [String] = []
        if line.estimate { tags.append(String(localized: "Estimate", bundle: .module)) }
        if line.unsourced { tags.append(String(localized: "No source", bundle: .module)) }
        tags += line.sources.map(PlanForkText.source)
        return tags
    }

    private var hiddenText: some View {
        Text(PlanForkText.readOnMac).font(.subheadline).foregroundStyle(PsycheColor.muted)
    }

    @ViewBuilder
    private func hiddenCount(_ count: Int) -> some View {
        if count > 0 {
            Section { Text(PlanForkText.moreOnMac(count)).font(.subheadline).foregroundStyle(PsycheColor.muted) }
        }
    }

    // MARK: Toolbar and footer

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            if let detail = model.detail, detail.fork.status == .ready {
                Menu {
                    Button(role: .destructive) { Task { await model.dismiss() } } label: {
                        Label(String(localized: "Dismiss", bundle: .module), systemImage: "xmark")
                    }
                    .disabled(model.busy || !session.state.canAnswer)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel(String(localized: "Plans", bundle: .module))
            }
        }
    }

    /// Take, for the lane on screen. A branch that read the owner's Memory, Messages or Contacts is taken on the Mac.
    @ViewBuilder
    private func footer(_ detail: PlanForkDetail) -> some View {
        if case .branch(let id) = tab, let branch = detail.branch(id) {
            if detail.canTake(branch) {
                footerButton {
                    Button { taking = branch } label: { Text("Take this plan", bundle: .module) }
                        .buttonStyle(.psycheInk)
                        .disabled(!session.state.canAnswer)
                        .accessibilityLabel(Text("Take the plan: \(branch.label)", bundle: .module))
                }
            } else if detail.needsMacToTake(branch) {
                footerButton { Text("Open on your Mac", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted) }
            }
        }
    }

    private func footerButton<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(PsycheColor.paper)
    }
}
