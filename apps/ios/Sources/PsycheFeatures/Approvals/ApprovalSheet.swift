import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// The approval sheet (docs/design/ios-app-2026.md §4.3): full arguments, never truncated, the amber
/// hairline, and one ink fill (Allow). Away from home the buttons are off and say why.
struct ApprovalSheet: View {
    let item: NeedsYouItem
    let detail: ApprovalDetail
    @Environment(Session.self) private var session
    @Environment(\.backend) private var store
    @Environment(\.presenceCheck) private var presence
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var flow = AnswerFlow()
    /// 0 → 1 over the Gateway's 400 ms arming delay; shown as the ink filling the Allow button.
    @State private var arming = 0.0

    private static let armingDelay: Duration = .milliseconds(400)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    StatusDot(.needsYou, "Needs your OK · \(detail.kindLabel)", font: .footnote.weight(.semibold))
                    Text(detail.title).psycheTitle(.title).foregroundStyle(PsycheColor.text)
                    Text(detail.summary).font(.subheadline).foregroundStyle(PsycheColor.muted)
                }
                ApprovalCard(fields: detail.fields.map { .init(key: $0.key, value: $0.value) })
                VStack(alignment: .leading, spacing: 6) {
                    EvidenceLine("Because", detail.evidence)
                    EvidenceLine("Also sent to", [detail.alsoSentTo])
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 28)
            .padding(.bottom, 16)
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaInset(edge: .bottom, spacing: 0) { actions }
        .psycheScreen()
        .sensoryFeedback(.success, trigger: flow.answeredCount)
        .interactiveDismissDisabled(flow.isBusy)
        .presentationDragIndicator(.visible)
        .presentationDetents([.large])
        .task {
            if reduceMotion {
                try? await Task.sleep(for: Self.armingDelay)
                arming = 1
            } else {
                withAnimation(.linear(duration: 0.4)) { arming = 1 }
            }
        }
        .onChange(of: flow.answeredCount) {
            Task {
                try? await Task.sleep(for: .milliseconds(1100))
                dismiss()
            }
        }
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
                // Right above Allow, as in the mockup: the note explains the Face ID that Allow asks for.
                if let note = detail.presenceNote {
                    Label(note, systemImage: "faceid")
                        .font(.footnote)
                        .foregroundStyle(PsycheColor.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !session.state.canAnswer {
                    Text("Reconnect to answer").font(.footnote).foregroundStyle(PsycheColor.muted)
                }
                HStack(spacing: 10) {
                    GlassTextButton(title: "Deny") { answer(.deny) }
                    ArmingInkButton(
                        title: flow.stage == .checking ? "Checking…" : detail.allowLabel,
                        progress: arming, isBusy: flow.stage == .sending
                    ) { answer(.allow) }
                }
                .disabled(!session.state.canAnswer || flow.isBusy)
            }
        }
        .padding(.horizontal, PsycheMetrics.pagePadding)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .background(PsycheColor.paper)
        .animation(.default, value: flow.stage)
    }

    private func answer(_ decision: ApprovalDecision) {
        let id = item.id
        let store = store
        let needsPresence = decision == .allow && detail.presenceNote != nil
        Task {
            await flow.run(
                presence: needsPresence ? presence : nil,
                reason: needsPresence ? "Allow: \(detail.title)" : nil,
                confirmation: decision == .allow ? "Allowed. Your Mac has your answer." : "Denied. Your Mac has your answer."
            ) {
                try await store.answerApproval(id: id, decision: decision)
            }
        }
    }
}
