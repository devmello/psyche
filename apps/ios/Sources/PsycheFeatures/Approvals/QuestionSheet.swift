import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// A question from Psyche, answered from Home: the options, or a few words of your own.
struct QuestionSheet: View {
    let item: NeedsYouItem
    let detail: QuestionDetail
    @Environment(Session.self) private var session
    @Environment(\.backend) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var flow = AnswerFlow()
    @State private var optionID: String?
    @State private var text = ""
    @FocusState private var typing: Bool

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool { optionID != nil || !trimmed.isEmpty }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    StatusDot(.needsYou, "Needs your answer · \(item.source)", font: .footnote.weight(.semibold))
                    Text(item.title).psycheTitle(.title).foregroundStyle(PsycheColor.text)
                    Text(detail.prompt).font(.subheadline).foregroundStyle(PsycheColor.muted)
                }
                if !detail.options.isEmpty {
                    PaperCard {
                        ForEach(Array(detail.options.enumerated()), id: \.element.id) { index, option in
                            if index > 0 { HairlineDivider() }
                            optionRow(option)
                        }
                    }
                }
                if detail.allowsFreeText {
                    TextField("Or write an answer", text: $text, axis: .vertical)
                        .font(.callout)
                        .lineLimit(1...4)
                        .focused($typing)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 13)
                        .background(PsycheColor.sheet, in: RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous)
                                .strokeBorder(PsycheColor.rule, lineWidth: 1))
                        .onChange(of: text) { if !text.isEmpty { optionID = nil } }
                }
                EvidenceLine(["Question", item.source, item.time])
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

    private func optionRow(_ option: QuestionDetail.Option) -> some View {
        Button {
            optionID = option.id
            text = ""
            typing = false
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(option.label).font(.psycheRow).foregroundStyle(PsycheColor.text)
                    if let detail = option.detail { EvidenceLine([detail]) }
                }
                Spacer(minLength: 0)
                Image(systemName: optionID == option.id ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(optionID == option.id ? PsycheColor.inkText : PsycheColor.rule)
                    .accessibilityHidden(true)
            }
            .padding(PsycheMetrics.rowPadding)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(optionID == option.id ? .isSelected : [])
    }

    @ViewBuilder
    private var actions: some View {
        VStack(spacing: 12) {
            switch flow.stage {
            case .answered(let text):
                AnsweredLine(text: text)
            case .failed(let message):
                AnswerError(message: message, retry: { Task { await flow.retry() } }, cancel: flow.dismissError)
            case .review, .checking, .sending:
                if !session.state.canAnswer {
                    Text("Reconnect to answer").font(.footnote).foregroundStyle(PsycheColor.muted)
                }
                ArmingInkButton(title: "Send answer", isBusy: flow.stage == .sending, action: send)
                    .disabled(!canSend || !session.state.canAnswer || flow.isBusy)
            }
        }
        .padding(.horizontal, PsycheMetrics.pagePadding)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .background(PsycheColor.paper)
        .animation(.default, value: flow.stage)
    }

    private func send() {
        let id = item.id
        let answer = QuestionAnswer(optionID: optionID, text: optionID == nil ? trimmed : nil)
        let store = store
        typing = false
        Task {
            await flow.run(confirmation: "Sent. Psyche carries on.") {
                try await store.answerQuestion(id: id, answer: answer)
            }
        }
    }
}
