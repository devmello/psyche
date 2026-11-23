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
    private let motion = MotionContext()
    /// What was just answered: picks the haptic and the receipt's symbol.
    @State private var decision: ApprovalDecision?
    @State private var flow = AnswerFlow()
    /// 0 → 1 over the Gateway's 400 ms arming delay; shown as the ink filling the Allow button.
    @State private var arming = 0.0

    private static let armingDelay: Duration = .seconds(PsycheMotion.Duration.arming)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    StatusDot(.needsYou, "Needs your OK · \(detail.kindLabel)", font: .footnote.weight(.semibold))
                    if let machine = detail.machineName {
                        Label {
                            Text("On \(machine)", bundle: .module)
                        } icon: {
                            Image(systemName: "desktopcomputer")
                        }
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(PsycheColor.text)
                        .accessibilityIdentifier("approvalMachineLine")
                    }
                    Text(detail.title).psycheTitle(.title).foregroundStyle(PsycheColor.text)
                    Text(detail.summary).font(.subheadline).foregroundStyle(PsycheColor.muted)
                }
                ApprovalCard(fields: detail.fields.map {
                    .init(key: $0.key, value: $0.value, depth: $0.depth, monospaced: $0.monospaced, id: $0.path)
                })
                VStack(alignment: .leading, spacing: 6) {
                    EvidenceLine(String(localized: "Because", bundle: .module), detail.evidence)
                    EvidenceLine(String(localized: "Also sent to", bundle: .module), [detail.alsoSentTo])
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 28)
            .padding(.bottom, 16)
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaInset(edge: .bottom, spacing: 0) { actions }
        .psycheScreen()
        // Allow is a success; Deny is a firm, neutral tap. Both fire once, when the Gateway took the answer.
        .sensoryFeedback(trigger: flow.answeredCount) { _, _ in
            decision == .deny ? .impact(weight: .medium) : .success
        }
        .interactiveDismissDisabled(flow.isBusy)
        .presentationDragIndicator(.visible)
        .presentationDetents([.large])
        .task {
            if motion.reduced {
                try? await Task.sleep(for: Self.armingDelay)
                arming = 1
            } else {
                withAnimation(PsycheMotion.linear(PsycheMotion.Duration.arming)) { arming = 1 }
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
                AnsweredLine(text: text, denied: decision == .deny)
                    .transition(motion.transition(.receipt))
            case .failed(let message):
                AnswerError(message: message, retry: { Task { await flow.retry() } }, cancel: flow.dismissError)
            case .review, .checking, .sending:
                // Right above Allow, as in the mockup. A card the phone can't allow says so (no Face ID: Allow is
                // off); otherwise the note explains the Face ID that Allow asks for (a payment).
                if detail.needsMac {
                    Label(notice("This one needs your Mac."), systemImage: "laptopcomputer")
                        .font(.footnote)
                        .foregroundStyle(PsycheColor.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if let note = detail.presenceNote {
                    Label(notice(note), systemImage: "faceid")
                        .font(.footnote)
                        .foregroundStyle(PsycheColor.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !session.state.canAnswer {
                    Text("Reconnect to answer", bundle: .module).font(.footnote).foregroundStyle(PsycheColor.muted)
                }
                HStack(spacing: 10) {
                    // Deny stays on a card the phone holds an answer for (refusing shows nothing the card doesn't); off
                    // when it holds none (a payment, a card kept on the Mac), where it could only fail.
                    GlassTextButton(title: String(localized: "Deny", bundle: .module)) { answer(.deny) }
                        .disabled(!detail.canDeny)
                    ArmingInkButton(
                        title: flow.stage == .checking ? String(localized: "Checking…", bundle: .module) : detail.allowLabel,
                        progress: arming, isBusy: flow.stage == .sending
                    ) { answer(.allow) }
                    .disabled(detail.needsMac)
                }
                .disabled(!session.state.canAnswer || flow.isBusy)
            }
        }
        .padding(.horizontal, PsycheMetrics.pagePadding)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .background(PsycheColor.paper)
        // The answer landing is the one emphasis moment of the sheet (a touch of bounce, spec §4.4); the other
        // stage changes (checking, sending, an error) are quiet.
        .psycheAnimation(flow.stage.isAnswered ? .emphasis : .micro, value: flow.stage)
    }

    private func answer(_ decision: ApprovalDecision) {
        let id = item.id
        let store = store
        self.decision = decision
        let detail = detail
        let presence = presence
        Task {
            await flow.answer(
                decision, on: detail, presence: presence,
                confirmation: decision == .allow ? String(localized: "Allowed. Your Mac has your answer.", bundle: .module) : String(localized: "Denied. Your Mac has your answer.", bundle: .module)
            ) {
                try await store.answerApproval(id: id, decision: decision)
            }
        }
    }
}
