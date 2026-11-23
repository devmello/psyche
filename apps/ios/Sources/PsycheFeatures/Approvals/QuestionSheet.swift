import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// A question from Psyche, answered from Home: every part of it, each with its options (one or several) or a few
/// words of the owner's own. Send stays off until every part is answered and sends one answer for all of them. A
/// failure shows inline and keeps the picks.
struct QuestionSheet: View {
    let item: NeedsYouItem
    let detail: QuestionDetail
    @Environment(Session.self) private var session
    @Environment(\.backend) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var flow = AnswerFlow()
    private let motion = MotionContext()
    @State private var draft: QuestionDraft
    @FocusState private var focusedPart: String?

    init(item: NeedsYouItem, detail: QuestionDetail) {
        self.item = item
        self.detail = detail
        _draft = State(initialValue: QuestionDraft(detail: detail))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    StatusDot(.needsYou, "Needs your answer · \(item.source)", font: .footnote.weight(.semibold))
                    Text(item.title).psycheTitle(.title).foregroundStyle(PsycheColor.text)
                }
                ForEach(draft.parts) { part in
                    partView(part)
                }
                EvidenceLine([String(localized: "Question", bundle: .module), item.source, item.time])
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 28)
            .padding(.bottom, 16)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) { actions }
        .psycheScreen()
        .sensoryFeedback(.success, trigger: flow.answeredCount)
        .interactiveDismissDisabled(flow.isBusy)
        .presentationDragIndicator(.visible)
        .presentationDetents([.medium, .large])
        .onChange(of: flow.answeredCount) {
            Task {
                try? await Task.sleep(for: .milliseconds(1100))
                dismiss()
            }
        }
    }

    private func partView(_ part: QuestionDetail.Part) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(part.prompt).font(.subheadline).foregroundStyle(PsycheColor.muted)
                if part.multiSelect {
                    Text("Pick any", bundle: .module).font(.footnote).foregroundStyle(PsycheColor.muted)
                }
            }
            if !part.options.isEmpty {
                PaperCard {
                    ForEach(Array(part.options.enumerated()), id: \.element.id) { index, option in
                        if index > 0 { HairlineDivider() }
                        optionRow(part, option)
                    }
                }
            }
            if part.allowsFreeText {
                TextField(String(localized: "Or write an answer", bundle: .module), text: typedBinding(part), axis: .vertical)
                    .font(.callout)
                    .lineLimit(1...4)
                    .focused($focusedPart, equals: part.header)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 13)
                    .background(PsycheColor.sheet, in: RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous)
                            .strokeBorder(PsycheColor.rule, lineWidth: 1))
            }
        }
    }

    private func optionRow(_ part: QuestionDetail.Part, _ option: QuestionDetail.Option) -> some View {
        let picked = (draft.selected[part.header] ?? []).contains(option.id)
        let symbol = part.multiSelect ? (picked ? "checkmark.square.fill" : "square") : (picked ? "checkmark.circle.fill" : "circle")
        return Button {
            draft.choose(header: part.header, optionID: option.id)
            focusedPart = nil
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(option.label).font(.psycheRow).foregroundStyle(PsycheColor.text)
                    if let detail = option.detail { EvidenceLine([detail]) }
                }
                Spacer(minLength: 0)
                Image(systemName: symbol)
                    .font(.title3)
                    .foregroundStyle(picked ? PsycheColor.inkText : PsycheColor.rule)
                    .accessibilityHidden(true)
            }
            .padding(PsycheMetrics.rowPadding)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(picked ? .isSelected : [])
    }

    /// The typed "Other" answer of one part. Typing selects the part's Other row.
    private func typedBinding(_ part: QuestionDetail.Part) -> Binding<String> {
        Binding(
            get: { draft.typed[part.header] ?? "" },
            set: { draft.type($0, header: part.header) })
    }

    @ViewBuilder
    private var actions: some View {
        VStack(spacing: 12) {
            switch flow.stage {
            case .answered(let text):
                AnsweredLine(text: text)
                    .transition(motion.transition(.receipt))
            case .failed(let message):
                AnswerError(message: message, retry: { Task { await flow.retry() } }, cancel: flow.dismissError)
            case .review, .checking, .sending:
                if !session.state.canAnswer {
                    Text("Reconnect to answer", bundle: .module).font(.footnote).foregroundStyle(PsycheColor.muted)
                }
                if detail.parts.count > 1, !draft.unanswered.isEmpty {
                    Text("Answer every question to send.", bundle: .module).font(.footnote).foregroundStyle(PsycheColor.muted)
                }
                ArmingInkButton(title: String(localized: "Send answer", bundle: .module), isBusy: flow.stage == .sending, action: send)
                    .disabled(!draft.unanswered.isEmpty || !session.state.canAnswer || flow.isBusy)
            }
        }
        .padding(.horizontal, PsycheMetrics.pagePadding)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .background(PsycheColor.paper)
        .psycheAnimation(flow.stage.isAnswered ? .emphasis : .micro, value: flow.stage)
    }

    private func send() {
        // Every part answered is the button's rule, so the answer is always whole here.
        guard let answer = draft.answer() else { return }
        let id = item.id
        let store = store
        focusedPart = nil
        Task {
            await flow.run(confirmation: String(localized: "Sent. Psyche carries on.", bundle: .module)) {
                try await store.answerQuestion(id: id, answer: answer)
            }
        }
    }
}
