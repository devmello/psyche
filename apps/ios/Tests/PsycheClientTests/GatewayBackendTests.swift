import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import struct PsycheProtocol.WireReqFrame
import PsycheStore
import Testing

@testable import PsycheClient

struct GatewayBackendTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        let gateway = FakeGateway()
        configure(gateway)
        let h = GatewayClientTests.Harness(gateway: gateway)
        await h.client.beginPairing(try GatewayClientTests.link())
        #expect(await GatewayClientTests.wait(h.client) { $0 == .live } == .live)
        return (GatewayBackend(client: h.client), h)
    }

    static func thread(_ id: String, kind: String = "side", title: String = "Chat", last: String? = nil) -> JSONValue {
        var entry: [String: JSONValue] = [
            "thread": .object(["id": .string(id), "kind": .string(kind), "title": .string(title),
                               "updatedAt": "2030-01-01T09:12:00Z", "lastMessageAt": "2030-01-01T09:12:00Z"]),
            "activity": .object(["running": .number(0), "awaitingInput": .number(0), "awaitingApproval": .number(0)]),
        ]
        if let last { entry["lastMessage"] = .object(["role": "agent", "text": .string(last), "at": "2030-01-01T09:12:00Z"]) }
        return .object(entry)
    }

    @Test func threadsMapToSummariesAndRemembersTheMainThread() async throws {
        let (backend, _) = try await live { g in
            g.on("threads.list") { _ in .success(.object(["threads": .array([
                Self.thread("thr_main", kind: "main", title: "Main", last: "Bill is paid"),
                Self.thread("thr_2", title: ""),
            ])])) }
        }
        let threads = try await backend.threads()
        #expect(threads.map(\.id) == ["thr_main", "thr_2"])
        #expect(threads[0].isMain && threads[0].status == "Bill is paid")
        #expect(threads[1].title == "New chat")
        #expect(await backend.mainThread.get() == "thr_main")
    }

    @Test func aThreadReadsOldestFirstAndMapsBlocks() async throws {
        let (backend, _) = try await live { g in
            g.on("threads.get") { _ in .success(Self.thread("thr_1", title: "Rent")) }
            g.on("chat.history") { _ in .success(.object(["messages": .array([  // newest first
                .object(["id": "m2", "threadId": "thr_1", "role": "agent", "blocks": .array([
                    .object(["type": "tool_call", "toolCallId": "tc1", "tool": "mail_search", "status": "done", "level1": "Searched mail"]),
                    .object(["type": "text", "md": "Found it."]),
                    .object(["type": "plan", "planId": "p1"]),
                ])]),
                .object(["id": "m1", "threadId": "thr_1", "role": "user", "blocks": .array([.object(["type": "text", "md": "When is rent due?"])])]),
            ])])) }
        }
        let thread = try await backend.thread(id: "thr_1")
        #expect(thread.title == "Rent")
        #expect(thread.items == [
            .user(id: "m1", text: "When is rent due?"),
            .toolCall(id: "tc1", symbol: "envelope", summary: "Searched mail"),
            .assistant(id: "m2", text: "Found it.", streaming: false),
        ])
    }

    @Test func theFixtureMainThreadIdMeansTheMainThreadOnARealGateway() async throws {
        let asked = OutboxTests.Sent()
        let (backend, _) = try await live { g in
            g.on("threads.list") { _ in .success(.object(["threads": .array([Self.thread("thr_real_main", kind: "main", title: "Main")])])) }
            g.on("threads.get") { req in asked.add(req.params?["threadId"]?.stringValue ?? ""); return .success(Self.thread("thr_real_main", kind: "main", title: "Main")) }
            g.on("chat.history") { _ in .success(.object(["messages": .array([])])) }
        }
        let thread = try await backend.thread(id: "thr_main")
        #expect(thread.id == "thr_real_main")
        #expect(asked.all == ["thr_real_main"])
    }

    @Test func sendingGoesThroughTheOutboxWithTheClientIDAsTheIdempotencyKey() async throws {
        let sent = OutboxTests.Sent()
        let (backend, _) = try await live { g in
            g.on("chat.send") { req in
                sent.add(req.idempotencyKey ?? "?")
                return .success(.object(["messageId": "m_server", "queued": .bool(false)]))
            }
        }
        let draft = MessageDraft(clientID: "client-1", threadID: "thr_1", text: "Hello")
        let result = try await backend.send(draft)
        #expect(result == SentMessage(threadID: "thr_1", messageID: "m_server", delivery: .sent))
        #expect(sent.all == ["client-1"])
    }

    @Test func sendingWhileOfflineIsQueuedNotLost() async throws {
        let gateway = FakeGateway()
        let h = GatewayClientTests.Harness(gateway: gateway)
        let backend = GatewayBackend(client: h.client)
        let result = try await backend.send(MessageDraft(clientID: "c9", threadID: "thr_1", text: "Later"))
        #expect(result == SentMessage(threadID: "thr_1", messageID: "c9", delivery: .queued))
        #expect(await h.outbox.pending.map(\.id) == ["c9"])
        // Reads fail honestly while away.
        await #expect(throws: BackendError.unreachable) { _ = try await backend.threads() }
    }

    @Test func homeAssemblesApprovalsQuestionsTasksAndSectionsDegradeGracefully() async throws {
        let (backend, _) = try await live { g in
            g.on("approvals.list") { _ in .success(.object(["approvals": .array([.object([
                "id": "ap1", "kind": "send_email", "summary": "Send the invoice to Dana", "status": "pending",
                "details": .object(["to": "dana@example.com", "subject": "Invoice 42"]),
                "requestedBy": .object(["agent": "Bills", "threadId": "thr_1"]),
                "requestedAt": "2030-01-01T09:12:00Z", "deviceOnly": .bool(false), "requiresAuthentication": .bool(false),
            ])])])) }
            g.on("questions.list") { _ in .success(.object(["inputRequests": .array([.object([
                "id": "q1", "threadId": "thr_2", "status": "open", "createdAt": "2030-01-01T09:00:00Z",
                "questions": .array([.object(["question": "Which card?", "header": "Card", "multiSelect": .bool(false),
                                              "options": .array([.object(["label": "Visa"]), .object(["label": "Amex"])])])]),
            ])])])) }
            g.on("tasks.list") { _ in .success(.object(["tasks": .array([.object([
                "id": "tk1", "title": "Reconcile receipts", "goal": "g", "createdAt": "2030-01-01T08:00:00Z",
                "checklist": .array([.object(["text": "Collect", "status": "done"]), .object(["text": "Match", "status": "running"]), .object(["text": "Report", "status": "pending"])]),
            ])])])) }
            // daily.* and nudges.* are not answered: those sections stay empty instead of failing Home.
        }
        let home = try await backend.home()
        #expect(home.needsYou.map(\.id) == ["ap1", "q1"])
        let approval = try #require(home.needsYou.first?.approval)
        #expect(approval.fields.contains { $0.key == "To" && $0.value == "dana@example.com" })
        #expect(approval.kindLabel == "Send email")
        #expect(home.running == [RunningTask(id: "tk1", title: "Reconcile receipts", step: 2, stepCount: 3, detail: "Match", elapsed: home.running.first?.elapsed ?? "")])
        #expect(home.today.isEmpty && home.keepInTouch.isEmpty)
    }

    @Test func allowingAnApprovalUsesTheSurfaceTokenAndScopeOnce() async throws {
        let answered = OutboxTests.Sent()
        let (backend, _) = try await live { g in
            g.on("approvals.get") { _ in .success(.object(["approval": .object(["id": "ap1", "status": "pending", "deviceOnly": .bool(false), "requiresAuthentication": .bool(false)]), "answerToken": "tok"])) }
            g.on("approvals.answer") { req in
                let p = req.params
                answered.add("\(p?["decision"]?.stringValue ?? "")|\(p?["answerToken"]?.stringValue ?? "")|\(p?["scope"]?.stringValue ?? "-")|\(req.idempotencyKey ?? "nokey")")
                return .success(.object([:]))
            }
        }
        try await backend.answerApproval(id: "ap1", decision: .allow)
        try await backend.answerApproval(id: "ap1", decision: .deny)
        #expect(answered.all == ["approve|tok|once|nokey", "deny|tok|-|nokey"])
    }

    @Test func presenceGatedApprovalsStayOnTheMacAndAreNeverQueued() async throws {
        let (backend, h) = try await live { g in
            g.on("approvals.get") { _ in .success(.object(["approval": .object(["id": "ap2", "status": "pending", "requiresAuthentication": .bool(true)]), "answerToken": "tok"])) }
        }
        await #expect(throws: BackendError.refused("This one needs your Mac. Answer it there.")) {
            try await backend.answerApproval(id: "ap2", decision: .allow)
        }
        #expect(h.gateway.received.allSatisfy { $0.method != "approvals.answer" })
        #expect(await h.outbox.isEmpty)
    }

    @Test func approvalsFailRatherThanQueueWhenOffline() async {
        let h = GatewayClientTests.Harness()
        let backend = GatewayBackend(client: h.client)
        await #expect(throws: BackendError.unreachable) { try await backend.answerApproval(id: "ap1", decision: .allow) }
        #expect(await h.outbox.isEmpty)
    }

    @Test func answeringAQuestionKeysTheAnswerByTheQuestionHeader() async throws {
        let seen = OutboxTests.Sent()
        let (backend, _) = try await live { g in
            g.on("questions.get") { _ in .success(.object(["inputRequest": .object(["id": "q1", "questions": .array([.object(["question": "Which card?", "header": "Card"])])])])) }
            g.on("questions.answer") { req in
                seen.add("\(req.params?["answer"]?["Card"]?.stringValue ?? "")|\(req.idempotencyKey ?? "")")
                return .success(.object([:]))
            }
        }
        try await backend.answerQuestion(id: "q1", answer: QuestionAnswer(optionID: "Visa"))
        #expect(seen.all == ["Visa|answer-q1"])
    }

    @Test func inboxAndMarkReadMap() async throws {
        let marked = OutboxTests.Sent()
        let (backend, _) = try await live { g in
            g.on("notifications.list") { _ in .success(.object(["notifications": .array([.object([
                "id": "n1", "kind": "approval", "title": "Approve payment", "body": "Pacific Power", "route": "/chat/thr_1?approval=ap1",
                "createdAt": "2030-01-01T09:12:00Z", "readAt": .null, "resolvedAt": .null,
            ])])])) }
            g.on("notifications.markRead") { req in marked.add((req.params?["notificationIds"]?.array?.compactMap(\.stringValue) ?? []).joined(separator: ",")); return .success(.object(["updated": .number(1)])) }
        }
        let inbox = try await backend.inbox()
        #expect(inbox.first?.needsYou == true && inbox.first?.read == false && inbox.first?.kindLabel == "Approval")
        #expect(inbox.first?.route == "/chat/thr_1?approval=ap1")
        try await backend.markRead(ids: ["n1", "n2"])
        #expect(marked.all == ["n1,n2"])
    }

    @Test func unwiredFeaturesAnswerUnreachableNotMadeUpContent() async throws {
        let h = GatewayClientTests.Harness()
        let backend = GatewayBackend(client: h.client)
        await #expect(throws: BackendError.unreachable) { _ = try await backend.memory() }
        await #expect(throws: BackendError.unreachable) { _ = try await backend.search(query: "rent") }
        await #expect(throws: BackendError.unreachable) { _ = try await backend.settings() }
    }
}
