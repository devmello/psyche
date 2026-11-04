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
            g.on("memory.catchup.act") { req in seen.add("act:\(req.params?["entityId"]?.stringValue ?? ""):\(req.params?["action"]?.stringValue ?? "")"); return .success(.object([:])) }
        }
        try await backend.setTodo(id: "loop_1", done: true)
        try await backend.setTodo(id: "loop_1", done: false)
        try await backend.setTodo(id: "ent_a1", done: true)
        await #expect(throws: BackendError.refused("Reopen this on your Mac.")) { try await backend.setTodo(id: "ent_a1", done: false) }
        #expect(seen.all == ["loop:loop_1:done", "loop:loop_1:open", "act:ent_a1:done"])
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
                .object(["scope": "memory", "id": "memory:notes", "title": "notes", "snippet": "a note", "score": .number(1), "threadId": .null, "route": .null, "kind": "memory"]),
            ])])) }
            g.on("memory.life.answer") { _ in .success(.object([
                "answer": "Rent is due on the 6th.", "reason": .null,
                "facts": .array([.object(["factId": "f1", "source": "mail", "observedAt": "2030-01-05T12:00:00Z"]), .object(["factId": "f2", "source": "mail", "observedAt": "2030-01-05T12:30:00Z"])]),
            ])) }
        }
        let results = try await backend.search(query: "when is rent due?")
        #expect(results.answer?.text == "Rent is due on the 6th." && results.answer?.evidence == ["mail Jan 5"])
        #expect(results.hits.map(\.group) == [.chatsAndFiles, .chatsAndFiles, .chatsAndFiles, .people, .todo, .chatsAndFiles])
        #expect(results.hits[0].target == .chat(id: "thr_1") && results.hits[1].target == .chat(id: "thr_2"))
        #expect(results.hits[2].target == .file(id: "lib_1"))
        #expect(results.hits[3].target == .person(id: "ent_pe1") && results.hits[3].detail == "Person")
        #expect(results.hits[4].target == .todo(id: "ent_a1") && results.hits[5].target == nil)
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
        #expect(await m.map(frame("widget.updated"), ownDeviceID: "d").events == [.changed(.home)])
    }
}
