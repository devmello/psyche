import Foundation
import Testing

/// The approval and question sheets are native layouts (NavigationStack + List) around an unchanged answer path.
/// These read the sources, as `LocalizedLiteralsTests` does, to keep three promises of the layout change:
/// an approval stays one plain tap (no confirmation step in front of Allow or Deny), the only way an answer
/// leaves the sheet is `AnswerFlow.answer`, and the sheet opens at a medium detent.
struct AnswerSheetLayoutTests {
    private static func source(_ name: String) throws -> String {
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("Sources/PsycheFeatures/Approvals/\(name)")
        return try String(contentsOf: url, encoding: .utf8)
    }

    @Test func approvalIsOneTapWithNoConfirmationStep() throws {
        let sheet = try Self.source("ApprovalSheet.swift")
        for forbidden in [".confirmationDialog", ".alert(", ".sheet(", ".fullScreenCover"] {
            #expect(!sheet.contains(forbidden), "ApprovalSheet must not add a step in front of the answer: \(forbidden)")
        }
        // Allow and Deny each call `answer(_:)` straight from the button.
        #expect(sheet.contains("{ answer(.deny) }"))
        #expect(sheet.contains("{ answer(.allow) }"))
    }

    @Test func approvalAnswersOnlyThroughTheFlow() throws {
        let sheet = try Self.source("ApprovalSheet.swift")
        #expect(sheet.contains("flow.answer("))
        #expect(sheet.contains("store.answerApproval(id: id, decision: decision)"))
        // Presence is decided by `AnswerFlow` (payments only); the view never asks for it itself.
        #expect(!sheet.contains("presence.confirm"))
        #expect(!sheet.contains("LAContext"))
        // Allow stays off while the Gateway's arming delay runs.
        #expect(sheet.contains("isArmed: armed"))
    }

    @Test func approvalSheetOpensAtMediumAndLarge() throws {
        let sheet = try Self.source("ApprovalSheet.swift")
        #expect(sheet.contains(".presentationDetents([.medium, .large])"))
        #expect(!sheet.contains(".presentationDetents([.large])"))
    }

    @Test func questionSheetSendsOneAnswerThroughTheFlow() throws {
        let sheet = try Self.source("QuestionSheet.swift")
        #expect(sheet.contains("store.answerQuestion(id: id, answer: answer)"))
        #expect(sheet.contains(".disabled(!draft.unanswered.isEmpty"))
    }

    /// Positive control: the scan really finds a construct when it is there.
    @Test func theScanSeesAConfirmationDialogWhereOneExists() throws {
        let run = try Self.source("TaskRunView.swift")
        #expect(run.contains(".confirmationDialog("))
    }
}
