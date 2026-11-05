import AppIntents
import PsycheShared

/// The expanded Dynamic Island's Deny and Approve buttons. Compiled into the app and the Widgets extension
/// (the widget draws `Button(intent:)`, the app runs it): a `LiveActivityIntent` performs in the app's process,
/// in the background, without opening it.
///
/// The island draws these buttons only for a plain write approval, the kind whose lock-screen notification
/// has Approve too. Payments and anything else with a presence gate get "Review…" instead, which opens the
/// full card where Face ID is asked. The app checks the id again before answering (`AlertCenter.answerFromIsland`),
/// and an answer goes out only over a live connection: it is never queued.
struct AnswerApprovalIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Answer an approval"
    static let description = IntentDescription("Approves or denies the approval a running task is waiting on.")
    /// Not offered in Shortcuts or Siri: only the island's buttons run it.
    static let isDiscoverable = false
    /// Like the notification's Approve (`.authenticationRequired`): never from a locked phone.
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Approval") var approvalID: String
    @Parameter(title: "Approve") var approve: Bool

    init() {}

    init(approvalID: String, approve: Bool) {
        self.approvalID = approvalID
        self.approve = approve
    }

    func perform() async throws -> some IntentResult {
        await IslandAnswers.answer(approvalID, approve: approve)
        return .result()
    }
}
