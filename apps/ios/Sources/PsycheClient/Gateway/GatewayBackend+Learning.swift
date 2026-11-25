import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// What Psyche learned, claims to confirm, recent changes and quick notes, over the Gateway's memory methods
// (memory.lessons.*, memory.claims.*, memory.review.*, memory.remember). Every write sends an
// idempotency key, so a retried tap does not repeat the change.
extension GatewayBackend {
    public func lessons() async throws -> [LessonItem] {
        try await lessonsPage(cursor: nil).lessons
    }

    /// One page of what Psyche learned, newest first, with the Mac's status filter (live lessons only: a forgotten,
    /// dormant or superseded lesson is not listed). The cursor is the Gateway's own.
    public func lessonsPage(cursor: String?) async throws -> LessonsPage {
        var params: [String: JSONValue] = [
            "status": .array(Self.liveLessonStatuses.map { .string($0) }),
            "limit": .number(Double(Self.lessonPageSize)),
        ]
        if let cursor { params["cursor"] = .string(cursor) }
        let result = try await call("memory.lessons.list", .object(params))
        return LessonsPage(
            lessons: (result["lessons"]?.array ?? []).compactMap(Self.lesson), nextCursor: result["nextCursor"]?.string)
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

    /// One page of the owner's feedback (feedback.list), newest first. The cursor is the Gateway's own.
    public func feedbackPage(cursor: String?) async throws -> FeedbackPage {
        var params: [String: JSONValue] = ["limit": .number(Double(Self.feedbackPageSize))]
        if let cursor { params["cursor"] = .string(cursor) }
        let result = try await call("feedback.list", .object(params))
        let events = (result["events"]?.array ?? []).compactMap(Self.feedbackItem)
        return FeedbackPage(events: events, nextCursor: result["nextCursor"]?.string)
    }

    public func deleteFeedback(id: String) async throws {
        _ = try await call(
            "feedback.delete", .obj(["eventId": .string(id)]), key: "feedback-delete-\(UUID().uuidString)")
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
        // Only the live statuses are shown (the list asks for them too; this is a second guard).
        if let status = row["status"]?.string, !liveLessonStatuses.contains(status) { return nil }
        return LessonItem(
            id: id, statement: statement, value: value, previous: row["previous"]?.string,
            confidence: number(row["confidence"]) ?? 0,
            confirmed: row["confirmedAt"]?.string != nil || row["status"]?.string == "confirmed")
    }

    /// Lessons the Mac lists: the live statuses, as its LIVE_LESSONS filter.
    static let liveLessonStatuses = ["proposed", "active", "confirmed"]
    /// Lessons per page, the Gateway's default.
    static let lessonPageSize = 50
    /// Provenance of a claim the owner can confirm (`confirmClaim` refuses every other kind).
    static let confirmableProvenances: Set<String> = ["agent"]

    /// Rows per feedback page, the Mac's size.
    static let feedbackPageSize = 20

    static func feedbackItem(_ row: JSONValue) -> FeedbackItem? {
        guard let id = row["id"]?.string, !id.isEmpty, let kind = row["kind"]?.string,
            let targetType = row["target"]?["type"]?.string
        else { return nil }
        return FeedbackItem(
            id: id, kind: kind, targetType: targetType, text: row["text"]?.string, reason: row["reason"]?.string)
    }

    static func claim(_ row: JSONValue) -> ClaimItem? {
        guard let id = row["id"]?.string, !id.isEmpty, let text = row["text"]?.string else { return nil }
        // Retracted or superseded claims are not waiting for the owner.
        if row["retractedAt"]?.string != nil || row["supersededBy"]?.string != nil { return nil }
        // Only what memory.claims.confirm accepts: Psyche's own claims. The owner's own, and any from untrusted or
        // system content, are refused (policy_denied), so they are never waiting for the owner.
        guard confirmableProvenances.contains(row["provenance"]?.string ?? "") else { return nil }
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
