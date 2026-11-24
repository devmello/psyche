import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// What Psyche learned, claims to confirm, recent changes and quick notes, over the Gateway's memory methods
// (memory.lessons.*, memory.claims.*, memory.review.*, memory.remember). Every write sends an
// idempotency key, so a retried tap does not repeat the change.
extension GatewayBackend {
    public func lessons() async throws -> [LessonItem] {
        let result = try await call("memory.lessons.list")
        return (result["lessons"]?.array ?? []).compactMap(Self.lesson)
    }

    public func confirmLesson(id: String) async throws {
        _ = try await call(
            "memory.lessons.confirm", .obj(["lessonId": .string(id)]), key: "lesson-confirm-\(UUID().uuidString)")
    }

    public func editLesson(id: String, value: String) async throws {
        _ = try await call(
            "memory.lessons.edit", .obj(["lessonId": .string(id), "value": .string(value)]),
            key: "lesson-edit-\(UUID().uuidString)")
    }

    public func forgetLesson(id: String) async throws {
        _ = try await call(
            "memory.lessons.forget", .obj(["lessonId": .string(id)]), key: "lesson-forget-\(UUID().uuidString)")
    }

    public func claims() async throws -> [ClaimItem] {
        let result = try await call("memory.claims.list")
        return (result["claims"]?.array ?? []).compactMap(Self.claim)
    }

    public func confirmClaim(id: String) async throws {
        _ = try await call(
            "memory.claims.confirm", .obj(["claimId": .string(id)]), key: "claim-confirm-\(UUID().uuidString)")
    }

    public func recentChanges() async throws -> [RecentChange] {
        let result = try await call("memory.review.list", .obj(["state": .array(["auto_accepted"])]))
        return (result["items"]?.array ?? []).compactMap(Self.recentChange)
    }

    public func undoChange(factID: String) async throws {
        _ = try await call(
            "memory.review.undo", .obj(["factId": .string(factID)]), key: "review-undo-\(UUID().uuidString)")
    }

    public func remember(text: String) async throws {
        _ = try await call("memory.remember", .obj(["text": .string(text)]), key: "remember-\(UUID().uuidString)")
    }

    // MARK: - Mapping (static, so the wire shapes can be tested without a connection)

    static func lesson(_ row: JSONValue) -> LessonItem? {
        guard let id = row["id"]?.string, !id.isEmpty, let statement = row["statement"]?.string,
            let value = row["value"]?.string
        else { return nil }
        // A forgotten lesson is never shown; the list asks for the live ones, this is a second guard.
        if row["status"]?.string == "forgotten" { return nil }
        return LessonItem(
            id: id, statement: statement, value: value, previous: row["previous"]?.string,
            confidence: number(row["confidence"]) ?? 0,
            confirmed: row["confirmedAt"]?.string != nil || row["status"]?.string == "confirmed")
    }

    static func claim(_ row: JSONValue) -> ClaimItem? {
        guard let id = row["id"]?.string, !id.isEmpty, let text = row["text"]?.string else { return nil }
        // Retracted or superseded claims are not waiting for the owner.
        if row["retractedAt"]?.string != nil || row["supersededBy"]?.string != nil { return nil }
        return ClaimItem(id: id, text: text, confidence: number(row["confidence"]) ?? 0)
    }

    static func recentChange(_ item: JSONValue) -> RecentChange? {
        guard let fact = item["fact"], let id = fact["id"]?.string, !id.isEmpty,
            let sentence = item["sentence"]?.string
        else { return nil }
        let change = RecentChange.Change(rawValue: item["change"]?.string ?? "") ?? .new
        return RecentChange(
            id: id, sentence: sentence, entityName: item["entityName"]?.string ?? "", change: change,
            previousValue: item["previousValue"]?.string)
    }

    private static func number(_ value: JSONValue?) -> Double? {
        if case .number(let number)? = value { return number }
        return nil
    }
}
