import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireEventFrame
import struct PsycheProtocol.WireError
import PsycheStore
import Testing

@testable import PsycheClient

/// Mapping tests over recorded JSON shaped like the protocol schemas (graph.ts, search.ts, widgets.ts).
struct MemorySearchWidgetsTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        let gateway = FakeGateway()
        configure(gateway)
        let h = GatewayClientTests.Harness(gateway: gateway)
        await h.client.beginPairing(try GatewayClientTests.link())
        #expect(await GatewayClientTests.wait(h.client) { $0 == .live } == .live)
        return (GatewayBackend(client: h.client), h)
    }

    static func iso(_ days: Double) -> JSONValue {
        .string(Date.now.addingTimeInterval(days * 86_400).formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
    }

    static func entity(_ id: String, _ kind: String, _ name: String, extra: [String: JSONValue] = [:]) -> JSONValue {
        var o: [String: JSONValue] = [
            "id": .string(id), "kind": .string(kind), "name": .string(name), "subtitle": .null, "summary": .null,
            "status": "active", "lastInteractionAt": .null, "openLoops": .number(0), "pinned": .bool(false), "isOwner": .bool(false),
        ]
        for (k, v) in extra { o[k] = v }
        return .object(o)
    }

    final class Calls: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [String] = []
        func add(_ s: String) { lock.withLock { items.append(s) } }
        var all: [String] { lock.withLock { items } }
    }

    func memoryGateway(_ g: FakeGateway, calls: Calls = Calls()) {
        g.on("memory.entities.search") { req -> Result<JSONValue, WireError> in
            switch req.params?["kinds"]?.array?.first?.stringValue {
            case "assignment":
                return .success(.object(["entities": .array([
                    Self.entity("ent_a1", "assignment", "Lecture Work 7", extra: ["workStatus": "in_progress", "dueAt": Self.iso(2)]),
                    Self.entity("ent_a2", "assignment", "Lecture Work 6", extra: ["workStatus": "submitted", "dueAt": Self.iso(-3)]),
                    Self.entity("ent_a3", "assignment", "Final paper", extra: ["workStatus": "not_started", "dueAt": Self.iso(20)]),
                    Self.entity("ent_a4", "assignment", "Dropped one", extra: ["workStatus": "dropped"]),
                ])]))
            case "project":
                return .success(.object(["entities": .array([Self.entity("ent_p1", "project", "MATH 21", extra: ["projectType": "course"])])]))
            default:
                return .success(.object(["entities": .array([
                    Self.entity("ent_pe1", "person", "Sam Ortiz", extra: ["subtitle": "Landlord", "summary": "Secret summary"]),
                    Self.entity("ent_me", "person", "Me", extra: ["isOwner": .bool(true)]),
                ])]))
            }
        }
        g.on("memory.loops.list") { req in
            calls.add("loops:\(req.params?["direction"]?.stringValue ?? "")")
            return .success(.object(["loops": .array([.object([
                "id": "loop_1", "direction": "i_owe", "text": "Pay rent", "status": "open", "dueAt": Self.iso(1),
                "projectId": "ent_p1", "counterpartId": "ent_pe1", "evidence": "secret quote",
            ])]), "nextCursor": .null]))
        }
        g.on("memory.entities.get") { req in
            if req.params?["id"]?.stringValue == "ent_p1" {
                return .success(.object([
                    "entity": Self.entity("ent_p1", "project", "MATH 21", extra: ["dueAt": .null]),
                    "facts": .array([.object(["id": "fact_n", "attribute": "next_step", "value": "Read chapter 4", "provenance": "owner",
                                             "sources": .array([]), "recordedAt": Self.iso(-1)])]),
                    "edges": .array([
                        .object(["id": "e1", "src": "ent_a1", "dst": "ent_p1", "rel": "part_of"]),
                        .object(["id": "e2", "src": "ent_a2", "dst": "ent_p1", "rel": "part_of"]),
                    ]),
                    "related": .array([
                        Self.entity("ent_a1", "assignment", "Lecture Work 7", extra: ["workStatus": "in_progress", "dueAt": Self.iso(2)]),
                        Self.entity("ent_a2", "assignment", "Lecture Work 6", extra: ["workStatus": "submitted"]),
                    ]),
                    "openLoops": .array([.object(["id": "loop_2", "direction": "i_owe", "text": "Email the TA", "status": "open", "projectId": "ent_p1"])]),
                ]))
            }
            return .success(.object([
                "entity": Self.entity("ent_pe1", "person", "Sam Ortiz", extra: ["lastInteractionAt": Self.iso(-2)]),
                "facts": .array([
                    .object(["id": "fact_1", "attribute": "relationship_to_owner", "value": "landlord", "provenance": "owner",
                             "sources": .array(["contact:c1"]), "recordedAt": Self.iso(-5)]),
                    .object(["id": "fact_2", "attribute": "preference", "value": "Prefers a bank transfer", "provenance": "agent", "review": "pending",
                             "sources": .array(["mail:m1"]), "recordedAt": Self.iso(-5)]),
                    .object(["id": "fact_3", "attribute": "note", "value": "Gone", "provenance": "agent", "review": "discarded", "sources": .array([]), "recordedAt": Self.iso(-5)]),
                ]),
                "edges": .array([]), "related": .array([]), "openLoops": .array([]),
            ]))
        }
        g.on("memory.entities.timeline") { _ in
            .success(.object(["rows": .array([.object([
                "id": "row1", "at": Self.iso(-2), "kind": "interaction", "text": "Mail: asked about renewal",
                "chip": .object(["source": "mail", "label": "Sam"]),
            ])]), "nextBefore": .null]))
        }
        g.on("memory.catchup.list") { _ in
            .success(.object(["items": .array([.object([
                "entityId": "ent_a1", "kind": "assignment", "title": "Lecture Work 7", "line": "Due Thursday, you stopped at problem 3",
                "changes": .array([.object(["text": "x", "at": Self.iso(-1), "source": "mail"])]),
                "resume": .object(["text": "You stopped at problem 3.", "at": Self.iso(-1), "open": .object(["kind": "thread", "ref": "thr_9"])]),
                "parent": .object(["id": "ent_p1", "name": "MATH 21"]), "ask": .bool(true),
            ])]), "pendingCount": .number(0), "hiddenCount": .number(0), "asOf": Self.iso(0)]))
        }
    }

    @Test func memorySortsTodosAndMapsProjectsPeopleAndLeftOff() async throws {
        let calls = Calls()
        let (backend, _) = try await live { memoryGateway($0, calls: calls) }
        let snapshot = try await backend.memory()
        let byID = Dictionary(uniqueKeysWithValues: snapshot.todos.map { ($0.id, $0) })
        #expect(byID["ent_a4"] == nil)  // dropped
        #expect(byID["ent_a1"]?.bucket == .thisWeek && byID["ent_a1"]?.needsYou == true && byID["ent_a1"]?.threadID == "thr_9")
        #expect(byID["ent_a1"]?.meta.contains("MATH 21") == true && byID["ent_a1"]?.meta.contains("in progress") == true)
        #expect(byID["ent_a2"]?.done == true && byID["ent_a2"]?.meta.hasPrefix("Handed in") == true)
        #expect(byID["ent_a3"]?.bucket == .later)
        #expect(byID["loop_1"]?.title == "Pay rent" && byID["loop_1"]?.bucket == .thisWeek && byID["loop_1"]?.meta.contains("MATH 21") == true)
        #expect(snapshot.todos.last?.done == true)
        #expect(calls.all == ["loops:i_owe"])
        #expect(snapshot.projects.map(\.title) == ["MATH 21"])
        #expect(snapshot.projects[0].fraction == 0.5 && snapshot.projects[0].detail.hasPrefix("1 of 2 done"))
        // People rows: no owner, no summary or facts.
        #expect(snapshot.people.map(\.name) == ["Sam Ortiz"])
        #expect(snapshot.people[0].detail.hasPrefix("Landlord") && !snapshot.people[0].detail.contains("Secret"))
        #expect(snapshot.leftOff.title == "Lecture Work 7." && snapshot.leftOff.text == "You stopped at problem 3.")
    }

    @Test func settingATodoUsesTheLoopOrTheCatchUpMethod() async throws {
        let seen = Calls()
        let (backend, _) = try await live { g in
            g.on("memory.loops.update") { req in seen.add("loop:\(req.params?["id"]?.stringValue ?? ""):\(req.params?["status"]?.stringValue ?? "")"); return .success(.object([:])) }
            g.on("memory.entities.facts.set") { req in
                seen.add("fact:\(req.params?["entityId"]?.stringValue ?? ""):\(req.params?["attribute"]?.stringValue ?? ""):\(req.params?["value"]?.stringValue ?? ""):\(req.params?["source"]?["kind"]?.stringValue ?? "")")
                return .success(.object([:]))
            }
            g.on("memory.catchup.act") { req in seen.add("act:\(req.params?["entityId"]?.stringValue ?? ""):\(req.params?["action"]?.stringValue ?? "")"); return .success(.object([:])) }
        }
        try await backend.setTodo(id: "loop_1", done: true)
        try await backend.setTodo(id: "loop_1", done: false)
        try await backend.setTodo(id: "ent_a1", done: true)
        // Reopening an assignment is the desktop's own write: the owner's status fact.
        try await backend.setTodo(id: "ent_a1", done: false)
        #expect(seen.all == ["loop:loop_1:done", "loop:loop_1:open", "act:ent_a1:done", "fact:ent_a1:status:not_started:owner_edit"])
    }

    @Test func aPersonPageHoldsFactsAndRecentRows() async throws {
        let (backend, _) = try await live { memoryGateway($0) }
        let detail = try await backend.person(id: "ent_pe1")
        #expect(detail.person.name == "Sam Ortiz" && detail.person.initials == "SO" && detail.person.detail.hasPrefix("Landlord"))
        #expect(detail.facts.map(\.id) == ["fact_1", "fact_2"])  // discarded left out
        #expect(detail.facts[0].confirmed && detail.facts[0].text == "Relationship: landlord" && detail.facts[0].evidence[0].hasPrefix("contacts"))
        #expect(!detail.facts[1].confirmed && detail.facts[1].text == "Prefers a bank transfer")
        #expect(detail.recent.first?.text == "Mail: asked about renewal" && detail.recent.first?.evidence.first?.hasPrefix("mail") == true)
    }

    @Test func aProjectPageHoldsItsTodosAndNotes() async throws {
        let (backend, _) = try await live { memoryGateway($0) }
        let detail = try await backend.project(id: "ent_p1")
        #expect(detail.project.fraction == 0.5)
        #expect(Set(detail.todos.map(\.id)) == ["ent_a1", "ent_a2", "loop_2"])
        #expect(detail.notes.map(\.text) == ["Next step: Read chapter 4"])
        #expect(!detail.evidence.isEmpty)
    }

    @Test func factsAreConfirmedByReviewAndRetractedByTheGraph() async throws {
        let seen = Calls()
        let (backend, _) = try await live { g in
            g.on("memory.review.decide") { req in seen.add("decide:\(req.params?["factIds"]?.array?.first?.stringValue ?? ""):\(req.params?["decision"]?.stringValue ?? "")"); return .success(.object(["facts": .array([])])) }
            g.on("memory.entities.facts.retract") { req in seen.add("retract:\(req.params?["factId"]?.stringValue ?? "")"); return .success(.object([:])) }
        }
        try await backend.confirmFact(personID: "ent_pe1", factID: "fact_2")
        try await backend.retractFact(personID: "ent_pe1", factID: "fact_2")
        #expect(seen.all == ["decide:fact_2:confirm", "retract:fact_2"])
    }

    @Test func searchGroupsHitsAndFillsTheAnswerForAQuestion() async throws {
        let (backend, _) = try await live { g in
            g.on("search.query") { _ in .success(.object(["hits": .array([
                .object(["scope": "threads", "id": "thr_1", "title": "Lease questions", "snippet": "rent", "score": .number(1), "threadId": .null, "route": .null, "kind": "thread", "createdAt": .number(1_761_900_000_000)]),
                .object(["scope": "messages", "id": "msg_1", "title": "Message", "snippet": "x", "score": .number(1), "threadId": "thr_2", "route": .null, "kind": "message"]),
                .object(["scope": "library", "id": "library:lib_1", "title": "lease.pdf", "snippet": "rent due", "score": .number(1), "threadId": .null, "route": .null, "kind": "library"]),
                .object(["scope": "people", "id": "entity:ent_pe1", "title": "Sam Ortiz", "snippet": "lives in Oakland", "score": .number(1), "threadId": .null, "route": .null, "kind": "person"]),
                .object(["scope": "memory", "id": "memory:ent_a1", "title": "Pay rent", "snippet": "To-do: Pay rent", "score": .number(1), "threadId": .null, "route": .null, "kind": "memory"]),
                .object(["scope": "projects", "id": "entity:ent_pr1", "title": "Thesis", "snippet": "chapter 4", "score": .number(1), "threadId": .null, "route": "/agent/soul?entity=ent_pr1", "kind": "project"]),
                .object(["scope": "tasks", "id": "act_9", "title": "Book flights", "snippet": "searched", "score": .number(1), "threadId": "thr_3", "route": "/agent/activity/tsk_7", "kind": "task"]),
                .object(["scope": "memory", "id": "memory:ent_pr2", "title": "Garden", "snippet": "Project: Garden", "score": .number(1), "threadId": .null, "route": .null, "kind": "memory"]),
                .object(["scope": "memory", "id": "memory:notes", "title": "notes", "snippet": "a note", "score": .number(1), "threadId": .null, "route": .null, "kind": "memory"]),
                // The typed entity wins over the snippet's first line; a snippet that says otherwise is ignored.
                .object(["scope": "memory", "id": "memory:ent_a2", "title": "Call Sam", "snippet": "Status: open", "score": .number(1), "threadId": .null, "route": .null, "kind": "memory", "entityType": "assignment"]),
                .object(["scope": "memory", "id": "memory:ent_pr3", "title": "Move", "snippet": "To-do: not really", "score": .number(1), "threadId": .null, "route": .null, "kind": "memory", "entityType": "project"]),
                .object(["scope": "memory", "id": "memory:ent_pe9", "title": "Sam", "snippet": "To-do: stale prefix", "score": .number(1), "threadId": .null, "route": .null, "kind": "memory", "entityType": "person"]),
            ])])) }
            g.on("memory.life.answer") { _ in .success(.object([
                "answer": "Rent is due on the 6th.", "reason": .null,
                "facts": .array([.object(["factId": "f1", "source": "mail", "observedAt": "2030-01-05T12:00:00Z"]), .object(["factId": "f2", "source": "mail", "observedAt": "2030-01-05T12:30:00Z"])]),
            ])) }
        }
        let results = try await backend.search(query: "when is rent due?")
        #expect(results.answer?.text == "Rent is due on the 6th." && results.answer?.evidence == ["mail Jan 5"])
        #expect(results.hits.map(\.group) == [.chatsAndFiles, .chatsAndFiles, .chatsAndFiles, .people, .todo, .chatsAndFiles, .chatsAndFiles, .chatsAndFiles, .chatsAndFiles, .todo, .chatsAndFiles, .chatsAndFiles])
        #expect(results.hits[0].target == .chat(id: "thr_1") && results.hits[1].target == .chat(id: "thr_2"))
        #expect(results.hits[2].target == .file(id: "lib_1"))
        #expect(results.hits[3].target == .person(id: "ent_pe1") && results.hits[3].detail == "Person")
        #expect(results.hits[4].target == .todo(id: "ent_a1"))
        #expect(results.hits[5].target == .project(id: "ent_pr1") && results.hits[5].detail.hasPrefix("Project"))
        #expect(results.hits[6].target == .task(id: "tsk_7"))
        #expect(results.hits[7].target == .project(id: "ent_pr2"))
        #expect(results.hits[8].target == nil)
        #expect(results.hits[9].target == .todo(id: "ent_a2") && results.hits[9].group == .todo)
        #expect(results.hits[10].target == .project(id: "ent_pr3"))
        #expect(results.hits[11].target == nil)  // a typed person is neither a to-do nor a project, whatever the snippet says
    }

    @Test func aPlainQueryAsksNoQuestionAndNoAnswerMeansNoCard() async throws {
        let asked = Calls()
        let (backend, _) = try await live { g in
            g.on("search.query") { _ in .success(.object(["hits": .array([])])) }
            g.on("memory.life.answer") { _ in asked.add("answer"); return .success(.object(["answer": .null, "facts": .array([]), "reason": "no_facts"])) }
        }
        #expect(try await backend.search(query: "rent").answer == nil)
        #expect(try await backend.search(query: "what is the wifi password").answer == nil)
        #expect(asked.all == ["answer"])
    }

    static let widget: JSONValue = .object([
        "id": "wdg_1", "threadId": "thr_1", "messageId": "m1", "rev": .number(3),
        "spec": .object(["v": .number(1), "title": "Booking", "fallbackText": "Booking", "root": .object([
            "type": "stack", "id": "root", "children": .array([.object(["type": "text", "id": "t1", "text": "Hello"])]),
        ])]),
        "taint": .array([.object(["sourceKind": "email", "sender": "a@b.c"])]),
        "owner": .object(["kind": "task", "taskId": "tsk_1"]), "state": "live", "pinned": .bool(true),
        "createdAt": "2030-01-01T09:00:00Z", "updatedAt": "2030-01-01T09:12:00Z",
    ])

    @Test func aWidgetMapsItsSpecTaintAndPin() async throws {
        let (backend, _) = try await live { g in
            g.on("widgets.get") { req in
                req.params?["widgetIds"]?.array?.first?.stringValue == "wdg_1"
                    ? .success(.object(["widgets": .array([Self.widget]), "missing": .array([])]))
                    : .success(.object(["widgets": .array([]), "missing": .array(["nope"])]))
            }
            g.on("widgets.list") { req in
                .success(.object(["widgets": req.params?["pinned"]?.bool == true ? .array([Self.widget]) : .array([])]))
            }
        }
        let snapshot = try await backend.widget(id: "wdg_1")
        #expect(snapshot.rev == 3 && snapshot.title == "Booking" && snapshot.isLive && snapshot.pinned)
        #expect(snapshot.untrustedSources == ["a@b.c"])
        #expect(snapshot.root.find(id: "t1") != nil)
        await #expect(throws: BackendError.notFound) { _ = try await backend.widget(id: "nope") }
        #expect(try await backend.pinnedWidgets().map { $0.id } == ["wdg_1"])
    }

    static func boundWidget(taskID: String = "tsk_1", thread: String = "thr_1") -> JSONValue {
        .object([
            "id": "wdg_b", "threadId": .string(thread), "messageId": "m1", "rev": .number(2),
            "spec": .object(["v": .number(1), "title": "Trip", "fallbackText": "Trip", "root": .object([
                "type": "stack", "id": "root", "children": .array([
                    .object(["type": "progress", "id": "p1", "label": "Packing", "value": .number(0), "max": .number(10),
                             "bind": .object(["source": "task", "id": .string(taskID), "field": "progress"])]),
                    .object(["type": "status", "id": "s1", "label": "Stored",
                             "bind": .object(["source": "task", "id": .string(taskID), "field": "status"])]),
                    .object(["type": "text", "id": "n1", "text": "Next run",
                             "bind": .object(["source": "automation", "id": "aut_1", "field": "nextRun"])]),
                    .object(["type": "text", "id": "r1", "text": "stored research",
                             "bind": .object(["source": "research", "id": "tc_1", "field": "status"])]),
                    .object(["type": "text", "id": "r2", "text": "stored claims",
                             "bind": .object(["source": "research", "id": "tc_1", "field": "claims"])]),
                    .object(["type": "stat", "id": "r3", "label": "Sources", "value": "0",
                             "bind": .object(["source": "research", "id": "tc_1", "field": "sources"])]),
                    .object(["type": "progress", "id": "r4", "label": "Research", "value": .number(0), "max": .number(7),
                             "bind": .object(["source": "research", "id": "tc_1", "field": "progress"])]),
                    .object(["type": "status", "id": "c1", "label": "Fetch", "tone": "neutral",
                             "bind": .object(["source": "tool_call", "id": "tc_2", "field": "status"])]),
                ]),
            ])]),
            "taint": .array([]), "owner": .object(["kind": "task", "taskId": "tsk_1"]), "state": "live", "pinned": .bool(true),
            "createdAt": "2030-01-01T09:00:00Z", "updatedAt": "2030-01-01T09:12:00Z",
        ])
    }

    @Test func boundWidgetNodesShowTheLiveTaskAndAutomation() async throws {
        let (backend, _) = try await live { g in
            g.on("widgets.get") { _ in .success(.object(["widgets": .array([Self.boundWidget()]), "missing": .array([])])) }
            g.on("widgets.list") { _ in .success(.object(["widgets": .array([Self.boundWidget()])])) }
            g.on("tasks.get") { _ in .success(.object(["task": .object([
                "id": "tsk_1", "threadId": "thr_1", "title": "Trip", "status": "running", "summary": .null,
                "checklist": .array([
                    .object(["text": "a", "status": "completed"]), .object(["text": "b", "status": "completed"]),
                    .object(["text": "c", "status": "in_progress"]), .object(["text": "d", "status": "pending"]),
                ]),
            ])])) }
            g.on("automations.list") { _ in .success(.object(["automations": .array([.object([
                "id": "aut_1", "enabled": .bool(true), "nextRunAt": .null, "lastRunAt": .null, "lastStatus": .null,
            ])])])) }
            g.on("widgets.binding.resolve") { req in
                guard req.params?["widgetId"]?.string == "wdg_b" else { return .failure(WireError(code: "not_found", message: "no such widget")) }
                switch req.params?["nodeId"]?.string {
                case "c1": return .success(.object(["available": .bool(true), "status": "ok"]))
                default: return .success(.object([
                    "available": .bool(true), "status": "running", "claims": .number(1), "sources": .number(3), "step": .number(3), "steps": .number(7),
                ]))
                }
            }
        }
        for snapshot in [try await backend.widget(id: "wdg_b"), try #require(try await backend.pinnedWidgets().first)] {
            guard case .progress(_, let progress)? = snapshot.root.find(id: "p1") else { Issue.record("no progress"); return }
            #expect(progress.value == 2 && progress.max == 4 && !progress.indeterminate)
            guard case .status(_, let label, _)? = snapshot.root.find(id: "s1") else { Issue.record("no status"); return }
            #expect(label == "Running")
            guard case .text(_, let next)? = snapshot.root.find(id: "n1") else { Issue.record("no text"); return }
            #expect(next.text == "Not scheduled")
            // Research and tool-call nodes come from `widgets.binding.resolve`.
            guard case .text(_, let research)? = snapshot.root.find(id: "r1") else { Issue.record("no text"); return }
            #expect(research.text == "Running")
            guard case .text(_, let claims)? = snapshot.root.find(id: "r2") else { Issue.record("no text"); return }
            #expect(claims.text == "1 claim")
            guard case .stat(_, let sources)? = snapshot.root.find(id: "r3") else { Issue.record("no stat"); return }
            #expect(sources.number == 3)
            guard case .progress(_, let steps)? = snapshot.root.find(id: "r4") else { Issue.record("no progress"); return }
            #expect(steps.value == 3 && steps.max == 7)
            guard case .status(_, let call, _)? = snapshot.root.find(id: "c1") else { Issue.record("no status"); return }
            #expect(call == "Done")
        }
    }

    @Test func aBoundTaskOfAnotherChatOrThatIsGoneIsUnavailable() async throws {
        let (backend, _) = try await live { g in
            g.on("widgets.get") { _ in .success(.object(["widgets": .array([Self.boundWidget(taskID: "tsk_other")]), "missing": .array([])])) }
            g.on("tasks.get") { _ in .success(.object(["task": .object([
                "id": "tsk_other", "threadId": "thr_ELSEWHERE", "title": "x", "status": "running", "checklist": .array([]),
            ])])) }
            g.on("automations.list") { _ in .success(.object(["automations": .array([])])) }
        }
        let snapshot = try await backend.widget(id: "wdg_b")
        guard case .text(_, let t)? = snapshot.root.find(id: "p1") else { Issue.record("no text"); return }
        #expect(t.text == "Packing: Unavailable")
        guard case .text(_, let auto)? = snapshot.root.find(id: "n1") else { Issue.record("no text"); return }
        #expect(auto.text == "Unavailable")
    }

    @Test func aBoundCallThatIsGoneIsUnavailableAndAGatewayWithoutTheMethodKeepsStoredProps() async throws {
        let (gone, _) = try await live { g in
            g.on("widgets.get") { _ in .success(.object(["widgets": .array([Self.boundWidget()]), "missing": .array([])])) }
            g.on("tasks.get") { _ in .success(.object(["task": .null])) }
            g.on("automations.list") { _ in .success(.object(["automations": .array([])])) }
            g.on("widgets.binding.resolve") { _ in .success(.object(["available": .bool(false)])) }
        }
        guard case .text(_, let t)? = try await gone.widget(id: "wdg_b").root.find(id: "r1") else { Issue.record("no text"); return }
        #expect(t.text == "Unavailable")
        let (old, _) = try await live { g in
            g.on("widgets.get") { _ in .success(.object(["widgets": .array([Self.boundWidget()]), "missing": .array([])])) }
            g.on("tasks.get") { _ in .success(.object(["task": .null])) }
            g.on("automations.list") { _ in .success(.object(["automations": .array([])])) }
        }
        guard case .text(_, let stored)? = try await old.widget(id: "wdg_b").root.find(id: "r1") else { Issue.record("no text"); return }
        #expect(stored.text == "stored research")
    }

    @Test func widgetActionsRouteToTheirOwnMethods() async throws {
        let seen = Calls()
        let (backend, _) = try await live { g in
            g.on("widgets.get") { _ in .success(.object(["widgets": .array([Self.widget]), "missing": .array([])])) }
            g.on("widgets.act") { req in
                seen.add("act:\(req.params?["nodeId"]?.stringValue ?? ""):\(req.params?["itemId"]?.stringValue ?? "-"):\(req.params?["values"]?["to"]?.stringValue ?? "-")")
                return .success(.object(["messageId": "m9", "runId": .null]))
            }
            g.on("chat.send") { req in seen.add("send:\(req.params?["threadId"]?.stringValue ?? ""):\(req.params?["fromWidget"]?["widgetId"]?.stringValue ?? "")"); return .success(.object(["messageId": "m10"])) }
            g.on("questions.get") { _ in .success(.object(["inputRequest": .object(["id": "q1", "questions": .array([.object(["question": "Which?", "header": "Pick"])])])])) }
            g.on("questions.answer") { req in seen.add("answer:\(req.params?["answer"]?["Pick"]?.stringValue ?? "")"); return .success(.object([:])) }
            g.on("widgets.image") { req in seen.add("image:\(req.params?["url"]?.stringValue ?? "")"); return .success(.object(["mime": "image/png", "bytes": .string(Data([1, 2, 3]).base64EncodedString())])) }
        }
        let none: [String: PsycheStore.JSONValue] = [:]
        #expect(try await backend.act(widgetID: "wdg_1", nodeID: "btn", itemID: "row1", action: .tool(name: "send_email", args: none), values: ["to": .string("a@b.c"), "skip": .null]) == nil)
        #expect(try await backend.act(widgetID: "wdg_1", nodeID: "btn", itemID: nil, action: .reply(text: "Yes"), values: none) == nil)
        #expect(try await backend.act(widgetID: "wdg_1", nodeID: "btn", itemID: nil, action: .answer(inputRequestID: "q1", values: ["A"]), values: none) == nil)
        #expect(try await backend.act(widgetID: "wdg_1", nodeID: "btn", itemID: nil, action: .open(route: "/x", artifactID: nil, fileID: nil, url: nil), values: none) == nil)
        #expect(try await backend.image(widgetID: "wdg_1", ref: "https://x.test/a.png") == Data([1, 2, 3]))
        #expect(try await backend.image(widgetID: "wdg_1", ref: "lib_1") == nil)
        #expect(seen.all == ["act:btn:row1:a@b.c", "send:thr_1:wdg_1", "answer:A", "image:https://x.test/a.png"])
    }

    @Test func memoryAndWidgetEventsPublishChangedTopics() async {
        var m = EventMapper(lookupQuestion: { _ in nil })
        func frame(_ e: String) -> WireEventFrame { .init(event: e, payload: .object([:]), seq: 1, stateVersion: 1) }
        #expect(await m.map(frame("memory.review.updated"), ownDeviceID: "d").events == [.changed(.memory)])
        #expect(await m.map(frame("memory.loop.updated"), ownDeviceID: "d").events == [.changed(.memory)])
        #expect(await m.map(frame("widget.updated"), ownDeviceID: "d").events == [.changed(.widgets), .changed(.home)])
        #expect(await m.map(frame("tool_call.updated"), ownDeviceID: "d").events == [.changed(.widgets)])
        #expect(await m.map(frame("research.progress"), ownDeviceID: "d").events == [.changed(.widgets)])
    }
}
