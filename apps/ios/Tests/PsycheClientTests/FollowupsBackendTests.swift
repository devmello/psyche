import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheStore
import Testing

@testable import PsycheClient

struct FollowupsBackendTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await GatewayBackendTests().live(configure)
    }

    static func proposal(
        id: String, status: String, tool: String = "mail_mark_read", taint: Bool = false, undoOf: JSONValue = .null,
        undoable: Bool? = nil, undoneBy: JSONValue = .null, approvalId: JSONValue = .null
    ) -> JSONValue {
        .object([
            "id": .string(id), "title": .string("Mark the newsletters read"), "status": .string(status),
            "calls": .array([.object(["tool": .string(tool), "summary": .string("Mark read: Weekly digest"), "params": .object([:])])]),
            "sideEffect": .string("write"), "postId": .null, "approvalId": approvalId, "taint": .bool(taint),
            "undoOf": undoOf, "undoneBy": undoneBy, "undoable": undoable.map(JSONValue.bool) ?? .null, "createdBy": .object(["job": .string("mail.digest")]),
            "createdAt": .string("2030-01-01T09:00:00Z"), "expiresAt": .string("2030-01-02T09:00:00Z"),
            "updatedAt": .string("2030-01-01T09:00:00Z"),
        ])
    }

    @Test func followUpsKeepOnlyWellFormedItemsAndHideWhenOff() async throws {
        let (backend, h) = try await live { g in
            g.on("mailFollowups.list") { _ in .success(.object([
                "enabled": .bool(true),
                "items": .array([
                    .object(["id": .string("mf1"), "kind": .string("no_reply"), "source": .string("gmail"),
                             "who": .string("Dana"), "subject": .string("Q3 deck"), "daysQuiet": .number(4),
                             "untrusted": .bool(true)]),
                    .object(["id": .string("mf2"), "kind": .string("a_new_kind"), "who": .string("x"),
                             "subject": .string("y"), "daysQuiet": .number(1)]),
                    .object(["kind": .string("no_reply")]),
                ]),
            ])) }
        }
        let items = try await backend.mailFollowups()
        #expect(items == [MailFollowup(id: "mf1", kind: .noReply, who: "Dana", subject: "Q3 deck", daysQuiet: 4)])
        #expect(h.gateway.received.last?.method == "mailFollowups.list")
    }

    @Test func disabledFollowUpsListNothing() async throws {
        let (backend, _) = try await live { g in
            g.on("mailFollowups.list") { _ in .success(.object([
                "enabled": .bool(false),
                "items": .array([.object(["id": .string("mf1"), "kind": .string("no_reply"), "who": .string("Dana"),
                                          "subject": .string("Q3"), "daysQuiet": .number(4)])]),
            ])) }
        }
        #expect(try await backend.mailFollowups().isEmpty)
    }

    @Test func followUpActionsSendTheWireNames() async throws {
        let (backend, h) = try await live { g in
            g.on("mailFollowups.act") { _ in .success(.object(["ok": .bool(true)])) }
        }
        try await backend.actOnMailFollowup(id: "mf1", action: .snooze)
        try await backend.actOnMailFollowup(id: "mf1", action: .dismiss)
        let calls = h.gateway.received.filter { $0.method == "mailFollowups.act" }
        #expect(calls.count == 2)
        #expect(calls[0].params?["id"]?.string == "mf1")
        #expect(calls[0].params?["action"]?.string == "snooze")
        #expect(calls[1].params?["action"]?.string == "dismiss")
    }

    @Test func suggestionsMapStatusCallsAndReversibility() async throws {
        let (backend, h) = try await live { g in
            g.on("proposals.list") { _ in .success(.object(["proposals": .array([
                Self.proposal(id: "sg1", status: "pending", tool: "gmail_modify_labels", undoable: true),
                Self.proposal(id: "sg2", status: "awaiting_approval", tool: "mail_mark_read", taint: true, undoable: false),
                Self.proposal(id: "sg3", status: "a_new_status"),
            ])])) }
        }
        let list = try await backend.suggestions()
        #expect(list.map(\.id) == ["sg1", "sg2"])
        #expect(list[0].status == .pending)
        #expect(list[0].callSummaries == ["Mark read: Weekly digest"])
        #expect(list[0].reversible)
        #expect(list[0].source == "mail.digest")
        #expect(list[1].status == .awaitingApproval)
        #expect(!list[1].reversible)
        #expect(list[1].fromOutsideContent)
        let wanted = h.gateway.received.last(where: { $0.method == "proposals.list" })?.params?["status"]?.array?.compactMap(\.string)
        #expect(wanted == ["pending", "awaiting_approval"])
    }

    @Test func undoneBySetOnTheOriginalHidesUndo() async throws {
        let (backend, _) = try await live { g in
            g.on("proposals.get") { _ in .success(.object(["proposal": Self.proposal(
                id: "sg1", status: "done", undoable: true, undoneBy: .string("sg1_inverse"))])) }
        }
        let one = try await backend.suggestion(id: "sg1")
        #expect(one.undoOffered)
        #expect(!one.canUndo)
    }

    @Test func undoableFromTheGatewayOffersUndoAndTheClientHoldsNoToolList() async throws {
        let (backend, _) = try await live { g in
            // gmail_modify_labels is what the digest creates; the old client list did not know it.
            g.on("proposals.get") { _ in .success(.object(["proposal": Self.proposal(
                id: "sg1", status: "done", tool: "gmail_modify_labels", undoable: true)])) }
        }
        let one = try await backend.suggestion(id: "sg1")
        #expect(one.canUndo)
        // Without the flag (an older Gateway, or not reversible) no Undo is guessed from tool names.
        let (other, _) = try await live { g in
            g.on("proposals.get") { _ in .success(.object(["proposal": Self.proposal(
                id: "sg2", status: "done", tool: "mail_mark_read")])) }
        }
        #expect(try await other.suggestion(id: "sg2").canUndo == false)
    }

    @Test func anInverseProposalIsNeverUndoneAgain() async throws {
        let (backend, _) = try await live { g in
            g.on("proposals.get") { _ in .success(.object(["proposal": Self.proposal(
                id: "sg1_inverse", status: "done", undoOf: .string("sg1"), undoable: true)])) }
        }
        #expect(try await backend.suggestion(id: "sg1_inverse").canUndo == false)
    }

    @Test func aBatchAlreadyApprovedByAStandingGrantIsNotAnswered() async throws {
        let (backend, h) = try await live { g in
            g.on("proposals.get") { _ in .success(.object(["proposal": Self.proposal(id: "sg1", status: "pending")])) }
            g.on("proposals.approve") { _ in .success(.object([
                "proposal": Self.proposal(id: "sg1", status: "running"),
                "approval": .object(["id": .string("ap_1"), "status": .string("approved")]),
                "answerToken": .string("tok_phone"),
            ])) }
            g.on("approvals.answer") { _ in .failure(WireError(code: "conflict", message: "approval is approved")) }
        }
        let handoff = try await backend.approveSuggestion(id: "sg1")
        #expect(handoff == nil)
        #expect(h.gateway.received.filter { $0.method == "approvals.answer" }.isEmpty)
    }

    @Test func aDeniedOrExpiredApprovalIsRefusedNotAnswered() async throws {
        let (backend, h) = try await live { g in
            g.on("proposals.get") { _ in .success(.object(["proposal": Self.proposal(id: "sg1", status: "pending")])) }
            g.on("proposals.approve") { _ in .success(.object([
                "proposal": Self.proposal(id: "sg1", status: "dismissed"),
                "approval": .object(["id": .string("ap_1"), "status": .string("denied")]),
                "answerToken": .string("tok_phone"),
            ])) }
        }
        await #expect(throws: BackendError.refused("That suggestion is no longer waiting.")) {
            try await backend.approveSuggestion(id: "sg1")
        }
        #expect(h.gateway.received.filter { $0.method == "approvals.answer" }.isEmpty)
    }

    @Test func awaitingApprovalRoutesToTheExistingApprovalInsteadOfApprovingAgain() async throws {
        let (backend, h) = try await live { g in
            g.on("proposals.get") { _ in .success(.object(["proposal": Self.proposal(
                id: "sg1", status: "awaiting_approval", approvalId: .string("ap_9"))])) }
            g.on("approvals.get") { _ in .success(.object([
                "approval": .object([
                    "id": .string("ap_9"), "status": .string("pending"), "kind": .string("batch"),
                    "summary": .string("Mark the newsletters read"),
                ]),
                "answerToken": .string("tok_phone"),
            ])) }
            g.on("proposals.approve") { _ in .failure(WireError(code: "conflict", message: "proposal sg1 is awaiting_approval")) }
        }
        let handoff = try await backend.approveSuggestion(id: "sg1")
        #expect(handoff?.id == "ap_9")
        #expect(h.gateway.received.filter { $0.method == "proposals.approve" }.isEmpty)
        #expect(h.gateway.received.filter { $0.method == "approvals.answer" }.isEmpty)
    }

    @Test func approveRunsTheBatchWithThisPhonesToken() async throws {
        let (backend, h) = try await live { g in
            g.on("proposals.get") { _ in .success(.object(["proposal": Self.proposal(id: "sg1", status: "pending")])) }
            g.on("proposals.approve") { _ in .success(.object([
                "proposal": Self.proposal(id: "sg1", status: "awaiting_approval"),
                "approval": .object(["id": .string("ap_1"), "status": .string("pending")]),
                "answerToken": .string("tok_phone"),
            ])) }
            g.on("approvals.answer") { _ in .success(.object(["approval": .object([:]), "grant": .null])) }
        }
        try await backend.approveSuggestion(id: "sg1")
        let approve = h.gateway.received.filter { $0.method == "proposals.approve" }
        #expect(approve.count == 1)
        #expect(approve[0].params?["proposalId"]?.string == "sg1")
        let answer = h.gateway.received.filter { $0.method == "approvals.answer" }
        #expect(answer.count == 1)
        #expect(answer[0].params?["approvalId"]?.string == "ap_1")
        #expect(answer[0].params?["answerToken"]?.string == "tok_phone")
        #expect(answer[0].params?["decision"]?.string == "approve")
        #expect(answer[0].params?["scope"]?.string == "once")
    }

    @Test func aPaymentApprovalIsHandedToTheSheetNotAnswered() async throws {
        let (backend, h) = try await live { g in
            g.on("proposals.get") { _ in .success(.object(["proposal": Self.proposal(id: "sg1", status: "pending")])) }
            g.on("proposals.approve") { _ in .success(.object([
                "proposal": Self.proposal(id: "sg1", status: "awaiting_approval"),
                "approval": .object([
                    "id": .string("ap_pay"), "status": .string("pending"), "kind": .string("payment"),
                    "summary": .string("Pay the electricity bill"), "requiresAuthentication": .bool(true),
                    "details": .object([:]),
                ]),
                "answerToken": .string("tok_phone"),
            ])) }
            g.on("approvals.answer") { _ in .success(.object([:])) }
        }
        let handoff = try await backend.approveSuggestion(id: "sg1")
        #expect(handoff?.id == "ap_pay")
        #expect(handoff?.approval?.needsMac == true)
        #expect(handoff?.approval?.canDeny == false)
        // Nothing is answered from the phone: the sheet decides, with its own presence rules.
        #expect(h.gateway.received.filter { $0.method == "approvals.answer" }.isEmpty)
    }

    @Test func approveWithoutATokenSendsNothingAndAsksForTheMac() async throws {
        let (backend, h) = try await live { g in
            g.on("proposals.get") { _ in .success(.object(["proposal": Self.proposal(id: "sg1", status: "pending")])) }
            g.on("proposals.approve") { _ in .success(.object([
                "proposal": Self.proposal(id: "sg1", status: "awaiting_approval"),
                "approval": .object(["id": .string("ap_1"), "status": .string("pending")]),
            ])) }
        }
        await #expect(throws: BackendError.refused("This one needs your Mac. Answer it there.")) {
            try await backend.approveSuggestion(id: "sg1")
        }
        #expect(h.gateway.received.filter { $0.method == "approvals.answer" }.isEmpty)
    }

    @Test func gatewayRefusalKeepsItsWords() async throws {
        let (backend, _) = try await live { g in
            g.on("proposals.get") { _ in .success(.object(["proposal": Self.proposal(id: "sg1", status: "pending")])) }
            g.on("proposals.approve") { _ in .failure(WireError(code: "forbidden", message: "This phone can't approve batches.")) }
        }
        await #expect(throws: BackendError.refused("This phone can't approve batches.")) {
            try await backend.approveSuggestion(id: "sg1")
        }
    }

    @Test func dismissAndUndoUseTheProposalMethods() async throws {
        let (backend, h) = try await live { g in
            g.on("proposals.dismiss") { _ in .success(.object(["proposal": Self.proposal(id: "sg1", status: "dismissed")])) }
            g.on("proposals.undo") { _ in .success(.object(["proposal": Self.proposal(id: "sg1_inverse", status: "pending")])) }
        }
        try await backend.dismissSuggestion(id: "sg1")
        try await backend.undoSuggestion(id: "sg1")
        #expect(h.gateway.received.filter { $0.method == "proposals.dismiss" }.first?.params?["proposalId"]?.string == "sg1")
        #expect(h.gateway.received.filter { $0.method == "proposals.undo" }.first?.params?["proposalId"]?.string == "sg1")
    }
}
