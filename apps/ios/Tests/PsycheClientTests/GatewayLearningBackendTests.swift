import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import Testing

@testable import PsycheClient

/// The learning calls (memory.lessons.*, memory.claims.*, memory.review.*, memory.remember, memory.forget) over the
/// fake gateway: the params each sends, and how the rows map back to the models.
struct GatewayLearningBackendTests {
    /// Records the params each call sent, in order. Handlers run off the test's actor, hence the lock.
    final class Seen: @unchecked Sendable {
        private let lock = NSLock()
        private var calls: [(method: String, params: JSONValue?)] = []

        func record(_ method: String, _ params: JSONValue?) {
            lock.lock()
            defer { lock.unlock() }
            calls.append((method, params))
        }

        func params(of method: String) -> [JSONValue] {
            lock.lock()
            defer { lock.unlock() }
            return calls.filter { $0.method == method }.compactMap { $0.params }
        }

        /// How many times a method was called, whether or not it sent params.
        func count(of method: String) -> Int {
            lock.lock()
            defer { lock.unlock() }
            return calls.filter { $0.method == method }.count
        }
    }

    /// One live lesson row as memory.lessons.list sends it.
    static func lessonRow(_ id: String) -> JSONValue {
        .object(["id": .string(id), "statement": .string("Line \(id)."), "value": "v", "previous": .null,
                 "confidence": .number(0.9), "status": "active"])
    }

    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        let gateway = FakeGateway()
        configure(gateway)
        let h = GatewayClientTests.Harness(gateway: gateway)
        await h.client.beginPairing(try GatewayClientTests.link())
        #expect(await GatewayClientTests.wait(h.client) { $0 == .live } == .live)
        return (GatewayBackend(client: h.client), h)
    }

    @Test func lessonsMapTheRowsAndDropForgottenOnes() async throws {
        let (backend, _) = try await live { g in
            g.on("memory.lessons.list") { _ in .success(.object(["lessons": .array([
                .object(["id": "les_1", "statement": "Keep replies short.", "value": "Short replies.",
                         "previous": .null, "confidence": .number(0.8), "status": "active", "confirmedAt": .null]),
                .object(["id": "les_2", "statement": "Call Dana Dana.", "value": "First name.",
                         "previous": "Full name.", "confidence": .number(0.95), "status": "confirmed",
                         "confirmedAt": "2026-11-20T10:00:00.000Z"]),
                .object(["id": "les_3", "statement": "Gone.", "value": "x", "previous": .null,
                         "confidence": .number(0.5), "status": "forgotten"]),
            ])])) }
        }
        let lessons = try await backend.lessons()
        #expect(lessons == [
            LessonItem(id: "les_1", statement: "Keep replies short.", value: "Short replies.", previous: nil,
                       confidence: 0.8, confirmed: false),
            LessonItem(id: "les_2", statement: "Call Dana Dana.", value: "First name.", previous: "Full name.",
                       confidence: 0.95, confirmed: true),
        ])
    }

    @Test func lessonWritesSendTheLessonId() async throws {
        let seen = Seen()
        let (backend, _) = try await live { g in
            for method in ["memory.lessons.confirm", "memory.lessons.forget"] {
                g.on(method) { req in
                    seen.record(req.method, req.params)
                    return .success(.object(["lesson": .object(["id": "les_1"])]))
                }
            }
            g.on("memory.lessons.edit") { req in
                seen.record(req.method, req.params)
                return .success(.object(["lesson": .object(["id": "les_1"]), "approval": .null]))
            }
            g.on("memory.lessons.list") { _ in .success(.object(["lessons": .array([])])) }
        }
        try await backend.confirmLesson(id: "les_1")
        try await backend.editLesson(id: "les_1", value: "Short replies, please.")
        try await backend.forgetLesson(id: "les_1")
        #expect(seen.params(of: "memory.lessons.confirm") == [.object(["lessonId": "les_1"])])
        #expect(seen.params(of: "memory.lessons.edit") == [.object(["lessonId": "les_1", "value": "Short replies, please."])])
        #expect(seen.params(of: "memory.lessons.forget") == [.object(["lessonId": "les_1"])])
    }

    @Test func claimsListsOnlyTheOnesTheOwnerCanConfirm() async throws {
        let (backend, _) = try await live { g in
            g.on("memory.claims.list") { _ in .success(.object(["claims": .array([
                .object(["id": "clm_1", "text": "Due in March.", "confidence": .number(0.4), "kind": "fact",
                         "provenance": "agent", "retractedAt": .null, "supersededBy": .null]),
                .object(["id": "clm_2", "text": "Retracted.", "confidence": .number(0.6), "kind": "fact",
                         "provenance": "agent", "retractedAt": "2026-11-20T10:00:00.000Z", "supersededBy": .null]),
                .object(["id": "clm_3", "text": "Superseded.", "confidence": .number(0.6), "kind": "fact",
                         "provenance": "agent", "retractedAt": .null, "supersededBy": "clm_9"]),
                .object(["id": "clm_4", "text": "Owner's own.", "confidence": .number(0.9), "kind": "fact",
                         "provenance": "owner", "retractedAt": .null, "supersededBy": .null]),
                .object(["id": "clm_5", "text": "From a web page.", "confidence": .number(0.5), "kind": "fact",
                         "provenance": "untrusted", "retractedAt": .null, "supersededBy": .null]),
                .object(["id": "clm_6", "text": "From the system.", "confidence": .number(0.5), "kind": "fact",
                         "provenance": "system", "retractedAt": .null, "supersededBy": .null]),
            ])])) }
        }
        #expect(try await backend.claims() == [ClaimItem(id: "clm_1", text: "Due in March.", confidence: 0.4)])
    }

    /// Confirming a claim makes an owner claim that supersedes it. After the reload the old claim is superseded and
    /// the owner's new one is not waiting, so the To confirm list is empty.
    @Test func aConfirmedClaimIsGoneAfterTheReload() async throws {
        let seen = Seen()
        let before: JSONValue = .object(["claims": .array([
            .object(["id": "clm_1", "text": "Due in March.", "confidence": .number(0.4), "kind": "fact",
                     "provenance": "agent", "retractedAt": .null, "supersededBy": .null]),
        ])])
        let after: JSONValue = .object(["claims": .array([
            .object(["id": "clm_1", "text": "Due in March.", "confidence": .number(0.4), "kind": "fact",
                     "provenance": "agent", "retractedAt": .null, "supersededBy": "clm_9"]),
            .object(["id": "clm_9", "text": "Due in March.", "confidence": .number(0.9), "kind": "fact",
                     "provenance": "owner", "retractedAt": .null, "supersededBy": .null]),
        ])])
        let (backend, _) = try await live { g in
            g.on("memory.claims.list") { _ in
                .success(seen.count(of: "memory.claims.confirm") > 0 ? after : before)
            }
            g.on("memory.claims.confirm") { req in
                seen.record(req.method, req.params)
                return .success(.object(["claim": .object(["id": "clm_9"])]))
            }
        }
        #expect(try await backend.claims().map(\.id) == ["clm_1"])
        try await backend.confirmClaim(id: "clm_1")
        #expect(try await backend.claims().isEmpty)
    }

    @Test func lessonsPagesFollowTheGatewayCursor() async throws {
        let seen = Seen()
        let (backend, _) = try await live { g in
            g.on("memory.lessons.list") { req in
                seen.record(req.method, req.params)
                if req.params?["cursor"]?.string == "page-2" {
                    return .success(.object(["lessons": .array([GatewayLearningBackendTests.lessonRow("les_2")]), "nextCursor": .null]))
                }
                return .success(.object(["lessons": .array([GatewayLearningBackendTests.lessonRow("les_1")]), "nextCursor": "page-2"]))
            }
        }
        let first = try await backend.lessonsPage(cursor: nil)
        #expect(first.lessons.map(\.id) == ["les_1"])
        #expect(first.nextCursor == "page-2")
        let second = try await backend.lessonsPage(cursor: first.nextCursor)
        #expect(second.lessons.map(\.id) == ["les_2"])
        #expect(second.nextCursor == nil)
        let sent = seen.params(of: "memory.lessons.list")
        #expect(sent.count == 2)
        #expect(sent.allSatisfy { $0["status"] == .array([.string("proposed"), .string("active"), .string("confirmed")]) })
        #expect(sent.first?["cursor"] == nil)
        #expect(sent.last?["cursor"] == "page-2")
    }

    @Test func confirmingAClaimSendsItsId() async throws {
        let seen = Seen()
        let (backend, _) = try await live { g in
            g.on("memory.claims.confirm") { req in
                seen.record(req.method, req.params)
                return .success(.object(["claim": .object(["id": "clm_1"])]))
            }
        }
        try await backend.confirmClaim(id: "clm_1")
        #expect(seen.params(of: "memory.claims.confirm") == [.object(["claimId": "clm_1"])])
    }

    @Test func recentChangesAskForAutoAcceptedFactsAndMapThem() async throws {
        let seen = Seen()
        let (backend, _) = try await live { g in
            g.on("memory.review.list") { req in
                seen.record(req.method, req.params)
                return .success(.object([
                    "items": .array([
                        .object([
                            "fact": .object(["id": "fct_1"]), "entityName": "Ava",
                            "sentence": "Ava's birthday is May 3", "change": "new", "previousValue": .null,
                        ]),
                        .object([
                            "fact": .object(["id": "fct_2"]), "entityName": "Dana",
                            "sentence": "Dana's office moved", "change": "changed",
                            "previousValue": "Main Street",
                        ]),
                        .object([
                            "fact": .object(["id": "fct_3"]), "entityName": "Kitchen",
                            "sentence": "Quote due Nov 28", "change": "conflict", "previousValue": "Dec 2",
                        ]),
                    ]),
                    "counts": .object(["pending": .number(0), "autoAccepted": .number(3), "quarantined": .number(0)]),
                ]))
            }
        }
        let changes = try await backend.recentChanges()
        #expect(seen.params(of: "memory.review.list") == [.object(["state": .array(["auto_accepted"])])])
        #expect(changes == [
            RecentChange(id: "fct_1", sentence: "Ava's birthday is May 3", entityName: "Ava", change: .new),
            RecentChange(id: "fct_2", sentence: "Dana's office moved", entityName: "Dana", change: .changed,
                         previousValue: "Main Street"),
            RecentChange(id: "fct_3", sentence: "Quote due Nov 28", entityName: "Kitchen", change: .conflict,
                         previousValue: "Dec 2"),
        ])
    }

    @Test func undoSendsTheFactId() async throws {
        let seen = Seen()
        let (backend, _) = try await live { g in
            g.on("memory.review.undo") { req in
                seen.record(req.method, req.params)
                return .success(.object(["fact": .object(["id": "fct_1"])]))
            }
        }
        try await backend.undoChange(factID: "fct_1")
        #expect(seen.params(of: "memory.review.undo") == [.object(["factId": "fct_1"])])
    }

    @Test func rememberSendsTheText() async throws {
        let seen = Seen()
        let (backend, _) = try await live { g in
            g.on("memory.remember") { req in
                seen.record(req.method, req.params)
                return .success(.object(["path": "memory/2026-11-24.md", "chunk": .object(["id": "chk_1"])]))
            }
        }
        try await backend.remember(text: "Dentist on Friday")
        #expect(seen.params(of: "memory.remember") == [.object(["text": "Dentist on Friday"])])
    }

    /// The To confirm screen only lists and confirms claims. Its "Not now" is local, so no memory.forget is
    /// ever sent from there: a forget-by-text would retract more than the one claim.
    @Test func theToConfirmScreenNeverCallsMemoryForget() async throws {
        let seen = Seen()
        let (backend, _) = try await live { g in
            g.on("memory.claims.list") { req in
                seen.record(req.method, req.params)
                return .success(.object(["claims": .array([
                    .object(["id": "clm_1", "text": "Due in March.", "confidence": .number(0.4), "kind": "fact",
                             "retractedAt": .null, "supersededBy": .null]),
                ])]))
            }
            g.on("memory.claims.confirm") { req in
                seen.record(req.method, req.params)
                return .success(.object(["claim": .object(["id": "clm_1"])]))
            }
            g.on("memory.forget") { req in
                seen.record(req.method, req.params)
                return .success(.object(["retractedClaimIds": .array([]), "removedChunkIds": .array([]),
                                         "files": .array([])]))
            }
        }
        _ = try await backend.claims()
        try await backend.confirmClaim(id: "clm_1")
        #expect(seen.count(of: "memory.forget") == 0)
        #expect(seen.count(of: "memory.claims.list") == 1)
        #expect(seen.params(of: "memory.claims.confirm") == [.object(["claimId": "clm_1"])])
    }

    @Test func feedbackListSendsTheCursorAndMapsTheRows() async throws {
        let seen = Seen()
        let (backend, _) = try await live { g in
            g.on("feedback.list") { req in
                seen.record(req.method, req.params)
                return .success(.object([
                    "events": .array([
                        .object(["id": "fbk_1", "kind": "not_helpful", "target": .object(["type": "message", "id": "msg_1"]),
                                 "text": .null, "reason": "too_long", "lessonId": .null]),
                        .object(["id": "fbk_2", "kind": "correction", "target": .object(["type": "draft", "id": "drf_1"]),
                                 "text": "Short replies.", "reason": .null]),
                        .object(["id": "", "kind": "helpful", "target": .object(["type": "message", "id": "msg_2"])]),
                    ]),
                    "nextCursor": "c2",
                ]))
            }
        }
        let page = try await backend.feedbackPage(cursor: "c1")
        #expect(page == FeedbackPage(events: [
            FeedbackItem(id: "fbk_1", kind: "not_helpful", targetType: "message", text: nil, reason: "too_long"),
            FeedbackItem(id: "fbk_2", kind: "correction", targetType: "draft", text: "Short replies.", reason: nil),
        ], nextCursor: "c2"))
        #expect(seen.params(of: "feedback.list") == [.object(["limit": .number(20), "cursor": "c1"])])
    }

    @Test func deletingFeedbackSendsTheEventId() async throws {
        let seen = Seen()
        let (backend, _) = try await live { g in
            g.on("feedback.delete") { req in
                seen.record(req.method, req.params)
                return .success(.object([:]))
            }
        }
        try await backend.deleteFeedback(id: "fbk_1")
        #expect(seen.params(of: "feedback.delete") == [.object(["eventId": "fbk_1"])])
    }
}
