import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// The approval sheet (docs/design/ios-app-2026.md §4.3): full arguments, never truncated, and one prominent
/// button (Allow). A `NavigationStack` with a `List`; only the layout is native, the answer path (`AnswerFlow`,
/// `answer(_:)`) is unchanged. Away from home the buttons are off and say why.
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
    /// Whether the Gateway's 400 ms arming delay has passed; Allow stays off until then.
    @State private var armed = false
    @State private var detailsOpen = false
    /// More fields than this and the Details section starts collapsed.
    private static let collapseAbove = 4

    private static let armingDelay: Duration = .seconds(PsycheMotion.Duration.arming)

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        StatusDot(.needsYou, String(localized: "Needs your OK · \(detail.kindLabel)", bundle: .module), font: .footnote.weight(.semibold))
                        if let machine = detail.machineName {
                            Label {
                                Text("On \(machine)", bundle: .module)
                            } icon: {
                                Image(systemName: "desktopcomputer")
                            }
                            .font(.subheadline.weight(.medium))
                            .accessibilityIdentifier("approvalMachineLine")
                        }
                        Text(detail.title).font(.title2.weight(.semibold))
                        Text(detail.summary).font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }
                Section {
                    if detail.fields.count > Self.collapseAbove {
                        // A long list starts closed; the title, the summary and Allow stay in view.
                        DisclosureGroup(isExpanded: $detailsOpen) {
                            ForEach(detail.fields, id: \.path) { fieldRow($0) }
                        } label: {
                            Text("Details", bundle: .module)
                        }
                    } else {
                        ForEach(detail.fields, id: \.path) { fieldRow($0) }
                    }
                } header: {
                    if detail.fields.count <= Self.collapseAbove { Text("Details", bundle: .module) }
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(String(localized: "Why", bundle: .module)) \(detail.evidence.joined(separator: " \u{B7} "))")
                        Text("\(String(localized: "Also sends to", bundle: .module)) \(detail.alsoSentTo)")
                    }
                }
            }
            .navigationTitle(String(localized: "Approval", bundle: .module))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .safeAreaInset(edge: .bottom, spacing: 0) { actions }
        }
        // Allow is a success; Deny is a firm, neutral tap. Both fire once, when the Gateway took the answer.
        .sensoryFeedback(trigger: flow.answeredCount) { _, _ in
            decision == .deny ? .impact(weight: .medium) : .success
        }
        .interactiveDismissDisabled(flow.isBusy)
        .presentationDragIndicator(.visible)
        .presentationDetents([.medium, .large])
        .task {
            try? await Task.sleep(for: Self.armingDelay)
            armed = true
        }
        .onChange(of: flow.answeredCount) {
            Task {
                try? await Task.sleep(for: .milliseconds(1100))
                dismiss()
            }
        }
    }

    /// One fact of the approval. Nested details are indented under their heading, code or a command is set in mono,
    /// and nothing is truncated (security §3.7): long values wrap and the list scrolls.
    @ViewBuilder
    private func fieldRow(_ field: ApprovalDetail.Field) -> some View {
        Group {
            if field.value.isEmpty {
                // A heading over the nested rows below it.
                Text(field.key).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            } else if field.monospaced || field.value.count > 40 {
                VStack(alignment: .leading, spacing: 4) {
                    Text(field.key).font(.subheadline).foregroundStyle(.secondary)
                    value(field)
                }
            } else {
                LabeledContent {
                    value(field).multilineTextAlignment(.trailing)
                } label: {
                    Text(field.key)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, CGFloat(min(field.depth, 8)) * 14)
        .accessibilityElement(children: .combine)
    }

    private func value(_ field: ApprovalDetail.Field) -> some View {
        Group {
            if field.monospaced {
                Text(field.value).font(.psycheMono(.subheadline, weight: .medium))
            } else {
                Text(field.value).font(.subheadline.weight(.medium))
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
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
                // Right above Allow. A card the phone can't allow says so (Allow is off); otherwise the note explains
                // the Face ID that Allow asks for (a payment).
                if detail.needsMac {
                    Label(notice("This one needs your Mac."), systemImage: "laptopcomputer")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if let note = detail.presenceNote {
                    Label(notice(note), systemImage: "faceid")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !session.state.canAnswer {
                    Text("Reconnect to answer", bundle: .module).font(.footnote).foregroundStyle(.secondary)
                }
                AnswerButtonRow {
                    // Deny stays on a card the phone holds an answer for (refusing shows nothing the card doesn't); off
                    // when it holds none (a payment, a card kept on the Mac), where it could only fail.
                    SecondaryAnswerButton(title: String(localized: "Deny", bundle: .module)) { answer(.deny) }
                        .disabled(!detail.canDeny)
                    PrimaryAnswerButton(
                        title: flow.stage == .checking ? String(localized: "Checking…", bundle: .module) : detail.allowLabel,
                        isArmed: armed, isBusy: flow.stage == .sending
                    ) { answer(.allow) }
                    .disabled(detail.needsMac)
                }
                .disabled(!session.state.canAnswer || flow.isBusy)
            }
        }
        .padding(.horizontal)
        .padding(.top, 12)
        .padding(.bottom, 12)
        .background(.bar)
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
