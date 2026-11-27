import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// "Fork a plan…": the options to work out side by side (docs/design/fork-a-plan-2026.md §5.1, §5.2). Two rows to start,
/// up to four, each a short name and what to assume. The suggestion fills the rows when they are still empty. The same
/// `planForks.create` the Mac sends, with the same scope as sending a chat message.
struct PlanForkStartSheet: View {
    @State private var model: PlanForkStartModel
    @Environment(\.dismiss) private var dismiss
    @Environment(Session.self) private var session
    private let started: (PlanForkDetail) -> Void

    init(threadID: String, messageID: String, store: any PsycheBackend, started: @escaping (PlanForkDetail) -> Void) {
        _model = State(initialValue: PlanForkStartModel(threadID: threadID, messageID: messageID, store: store))
        self.started = started
    }

    var body: some View {
        NavigationStack {
            Form {
                if let error = model.error { Section { StatusDot(.failed, error) } }
                ForEach(Array(model.drafts.enumerated()), id: \.element.id) { index, draft in
                    Section {
                        TextField(String(localized: "Name", bundle: .module), text: label(draft))
                        TextField(String(localized: "Assume…", bundle: .module), text: premise(draft), axis: .vertical)
                            .lineLimit(1...4)
                        if model.isIncomplete(draft) {
                            Text("Each option needs a name and what to assume.", bundle: .module)
                                .font(.footnote).foregroundStyle(PsycheColor.muted)
                        }
                        if model.canRemove(draft) {
                            Button(role: .destructive) { model.remove(draft.id) } label: {
                                Text("Remove option", bundle: .module)
                            }
                        }
                    } header: {
                        Text("Option \(index + 1)", bundle: .module)
                    }
                }
                if model.canAdd {
                    Section {
                        Button { model.add() } label: { Label(String(localized: "Add an option", bundle: .module), systemImage: "plus") }
                    }
                }
                Section {
                    if model.suggesting {
                        Text("Thinking of options…", bundle: .module)
                    } else if let estimate = model.estimate {
                        Text(PlanForkText.estimate(estimate))
                    }
                } footer: {
                    Text("Reads your memory, calendar, mail and the web. Changes nothing until you take a plan.", bundle: .module)
                }
            }
            .navigationTitle(String(localized: "Compare plans", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel", bundle: .module)) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Start", bundle: .module)) {
                        Task {
                            if let detail = await model.start() {
                                dismiss()
                                started(detail)
                            }
                        }
                    }
                    .disabled(!model.canStart || !session.state.canAnswer)
                }
            }
            .task { await model.suggest() }
            .task(id: model.options) { await model.refreshEstimate() }
        }
        .presentationDetents([.large])
    }

    private func label(_ draft: PlanForkStartModel.Draft) -> Binding<String> {
        Binding(get: { model.drafts.first { $0.id == draft.id }?.label ?? "" }, set: { model.edit(draft.id, label: $0) })
    }

    private func premise(_ draft: PlanForkStartModel.Draft) -> Binding<String> {
        Binding(get: { model.drafts.first { $0.id == draft.id }?.premise ?? "" }, set: { model.edit(draft.id, premise: $0) })
    }
}

/// Take this plan: tick what Psyche applies now, then one tap. The prepared items are the Night shift kind, so the same
/// rules decide what can be ticked and a send is its own box that starts off. The tap asks the Gateway for one approval
/// and answers it only if the approval lists exactly what was ticked (`PlanForkBackend.takePlanFork`). A payment, or
/// details too large to read here, are answered on the Mac.
struct PlanForkTakeSheet: View {
    let detail: PlanForkDetail
    let branch: PlanForkBranch
    @State private var model: PlanForkTakeModel
    @Environment(\.dismiss) private var dismiss
    @Environment(Session.self) private var session
    private let done: () -> Void

    init(detail: PlanForkDetail, branch: PlanForkBranch, store: any PsycheBackend, done: @escaping () -> Void) {
        self.detail = detail
        self.branch = branch
        self.done = done
        _model = State(initialValue: PlanForkTakeModel(forkID: detail.fork.id, branchID: branch.id, store: store))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Tick what Psyche should apply now. Nothing is sent unless you tick Send it too.", bundle: .module)
                        .font(.subheadline).foregroundStyle(PsycheColor.muted)
                }
                if let banner = model.banner { Section { bannerView(banner) } }
                prepared
                otherSteps
                Section {
                    Toggle(isOn: Bindable(model).continuePlan) {
                        Text("Psyche starts on the remaining steps, asking before each action", bundle: .module)
                    }
                }
            }
            .homeListStyle()
            .scrollContentBackground(.hidden)
            .psycheScreen()
            .navigationTitle(String(localized: "Take “\(branch.label)”", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel", bundle: .module)) { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                Button { Task { await model.take() } } label: { Text("Take this plan", bundle: .module) }
                    .buttonStyle(.psycheInk)
                    .disabled(model.busy || !session.state.canAnswer)
                    .padding(.horizontal, PsycheMetrics.pagePadding)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity)
                    .background(PsycheColor.paper)
            }
            .task { await model.load() }
            .onChange(of: model.finished) { _, finished in
                if finished {
                    done()
                    dismiss()
                }
            }
        }
    }

    // MARK: Prepared items

    @ViewBuilder
    private var prepared: some View {
        switch model.items {
        case .idle, .loading:
            Section { ProgressView() }
        case .failed:
            Section {
                Text("Couldn't load the prepared items. You can still take the plan without them.", bundle: .module)
                    .font(.subheadline).foregroundStyle(PsycheColor.muted)
            }
        case .loaded(let items):
            if !items.isEmpty {
                Section {
                    ForEach(items) { item in itemRow(item) }
                } header: {
                    Text("Prepared", bundle: .module)
                }
            }
        }
    }

    private func itemRow(_ item: NightShiftItem) -> some View {
        let ticked = model.selection.ticked.contains(item.id)
        let selectable = model.selection.canTick(item)
        return VStack(alignment: .leading, spacing: 6) {
            Button { model.toggle(item) } label: {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: ticked ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(ticked ? PsycheColor.inkText : PsycheColor.muted.opacity(selectable ? 0.8 : 0.35))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(verbatim: item.withheldMessages ? NightShiftText.withheldLine : item.summary)
                            .foregroundStyle(selectable ? PsycheColor.text : PsycheColor.muted)
                        if item.newRecipient { StatusDot(.needsYou, String(localized: "New recipient", bundle: .module)) }
                        if item.untrusted { StatusDot(.neutral, String(localized: "Untrusted source", bundle: .module)) }
                        if item.status == .stale || item.status == .superseded {
                            Text("This changed since it was prepared.", bundle: .module).font(.footnote).foregroundStyle(PsycheColor.muted)
                        } else if item.needsMac && !item.withheldMessages {
                            Text("Too long to review here. Open it on your Mac.", bundle: .module)
                                .font(.footnote).foregroundStyle(PsycheColor.muted)
                        }
                        if let refusal = model.selection.refused[item.id] {
                            Text(verbatim: refusal.isEmpty ? String(localized: "Psyche left this one out.", bundle: .module) : refusal)
                                .font(.footnote).foregroundStyle(PsycheColor.muted)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!selectable || model.busy)
            .accessibilityAddTraits(ticked ? .isSelected : [])
            if item.canOfferSend, item.status == .ready, !item.needsMac, !item.withheldMessages { sendBox(item) }
        }
    }

    /// "Send it too": its own box, off by default, never part of a tick-all, and only after the whole draft was read.
    private func sendBox(_ item: NightShiftItem) -> some View {
        let on = model.selection.sendTicked.contains(item.id)
        let enabled = model.selection.canTickSend(item)
        return VStack(alignment: .leading, spacing: 4) {
            Button { model.toggleSend(item) } label: {
                HStack(spacing: 12) {
                    Image(systemName: on ? "checkmark.circle.fill" : "circle").font(.title3)
                        .foregroundStyle(on ? PsycheColor.inkText : PsycheColor.muted.opacity(enabled ? 0.8 : 0.35))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Send it too", bundle: .module).font(.subheadline.weight(.semibold))
                            .foregroundStyle(enabled ? PsycheColor.text : PsycheColor.muted)
                        if let send = item.send {
                            Text(verbatim: send.recipients.joined(separator: ", ")).font(.footnote).foregroundStyle(PsycheColor.muted)
                        }
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(!enabled || model.busy)
            if item.truncated && !model.selection.expanded.contains(item.id), item.fullBody != nil {
                Button { model.expand(item) } label: { Text("Show full draft", bundle: .module).font(.footnote.weight(.semibold)) }
                    .buttonStyle(.plain).foregroundStyle(PsycheColor.inkText)
            }
        }
        .padding(.leading, 34)
    }

    /// What is not prepared: Psyche's steps wait for the plan to be taken, and the owner's are theirs.
    @ViewBuilder
    private var otherSteps: some View {
        let steps = (branch.report?.steps ?? []).filter { !$0.prepared }
        if !steps.isEmpty {
            Section {
                ForEach(steps) { step in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: step.text)
                        Group {
                            if step.who == .psyche {
                                Text("Psyche does this after you take the plan", bundle: .module)
                            } else {
                                Text("You do this", bundle: .module)
                            }
                        }
                        .font(.footnote).foregroundStyle(PsycheColor.muted)
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: {
                Text("Steps", bundle: .module)
            }
        }
    }

    @ViewBuilder
    private func bannerView(_ banner: PlanForkTakeModel.Banner) -> some View {
        switch banner {
        case .mismatch:
            StatusDot(.failed, String(localized: "What Psyche asked to approve doesn't match what you ticked, so nothing was applied. Review it again.", bundle: .module))
        case .needsMac:
            StatusDot(.needsYou, String(localized: "This one needs your Mac. Answer it there.", bundle: .module))
        case .declined:
            StatusDot(.failed, String(localized: "Nothing was applied.", bundle: .module))
        case .refused(let count):
            StatusDot(.needsYou, String(localized: "\(count) items couldn't be applied.", bundle: .module))
        case .failure(let message):
            if !message.isEmpty { StatusDot(.failed, message) }
        }
    }
}
