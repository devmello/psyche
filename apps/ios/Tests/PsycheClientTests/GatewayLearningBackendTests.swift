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

    @Test func claimsListsOnlyTheOnesWaitingForTheOwner() async throws {
        let (backend, _) = try await live { g in
            g.on("memory.claims.list") { _ in .success(.object(["claims": .array([
                .object(["id": "clm_1", "text": "Due in March.", "confidence": .number(0.4), "kind": "fact",
                         "retractedAt": .null, "supersededBy": .null]),
                .object(["id": "clm_2", "text": "Retracted.", "confidence": .number(0.6), "kind": "fact",
                         "retractedAt": "2026-11-20T10:00:00.000Z", "supersededBy": .null]),
                .object(["id": "clm_3", "text": "Superseded.", "confidence": .number(0.6), "kind": "fact",
                         "retractedAt": .null, "supersededBy": "clm_9"]),
            ])])) }
        }
        #expect(try await backend.claims() == [ClaimItem(id: "clm_1", text: "Due in March.", confidence: 0.4)])
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

    @Test func rememberSendsTheTextAndForgetSendsTheSubject() async throws {
        let seen = Seen()
        let (backend, _) = try await live { g in
            g.on("memory.remember") { req in
                seen.record(req.method, req.params)
                return .success(.object(["path": "memory/2026-11-24.md", "chunk": .object(["id": "chk_1"])]))
            }
            g.on("memory.forget") { req in
                seen.record(req.method, req.params)
                return .success(.object(["retractedClaimIds": .array([]), "removedChunkIds": .array([]),
                                         "files": .array([])]))
            }
        }
        try await backend.remember(text: "Dentist on Friday")
        try await backend.forget(subject: "Your car is due for service in March.")
        #expect(seen.params(of: "memory.remember") == [.object(["text": "Dentist on Friday"])])
        #expect(seen.params(of: "memory.forget") == [.object(["subject": "Your car is due for service in March."])])
    }
}
