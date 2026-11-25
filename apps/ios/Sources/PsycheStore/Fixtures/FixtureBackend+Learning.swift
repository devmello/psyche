import Foundation

/// What Psyche learned, the claims it is not sure of and its recent changes, for the demo. Kept in `MemoryState`.
struct LearningState: Sendable {
    var lessons = FixtureData.lessons
    var claims = FixtureData.claims
    var changes = FixtureData.recentChanges
    var feedback = FixtureData.feedback
    var held = FixtureData.heldItems
    var senderTrust = FixtureData.senderTrust
}

extension FixtureBackend {
    public func lessons() async throws -> [LessonItem] {
        await pause()
        return memoryState.learning.lessons
    }

    public func lessonsPage(cursor: String?) async throws -> LessonsPage {
        await pause()
        // The demo keeps its few lessons on one page.
        return LessonsPage(lessons: memoryState.learning.lessons, nextCursor: nil)
    }

    public func confirmLesson(id: String) async throws {
        guard let index = memoryState.learning.lessons.firstIndex(where: { $0.id == id }) else {
            throw BackendError.notFound
        }
        memoryState.learning.lessons[index].confirmed = true
        publish(.changed(.memory))
    }

    public func editLesson(id: String, value: String) async throws {
        guard let index = memoryState.learning.lessons.firstIndex(where: { $0.id == id }) else {
            throw BackendError.notFound
        }
        memoryState.learning.lessons[index].value = value
        publish(.changed(.memory))
    }

    public func forgetLesson(id: String) async throws {
        guard memoryState.learning.lessons.contains(where: { $0.id == id }) else { throw BackendError.notFound }
        memoryState.learning.lessons.removeAll { $0.id == id }
        publish(.changed(.memory))
    }

    public func feedbackPage(cursor: String?) async throws -> FeedbackPage {
        await pause()
        let all = memoryState.learning.feedback
        // The cursor is the offset of the next row, as a string. 20 rows a page, as the Gateway.
        let start = min(max(Int(cursor ?? "0") ?? 0, 0), all.count)
        let end = min(start + 20, all.count)
        return FeedbackPage(events: Array(all[start..<end]), nextCursor: end < all.count ? String(end) : nil)
    }

    public func deleteFeedback(id: String) async throws {
        guard memoryState.learning.feedback.contains(where: { $0.id == id }) else { throw BackendError.notFound }
        memoryState.learning.feedback.removeAll { $0.id == id }
        publish(.changed(.memory))
    }

    public func claims() async throws -> [ClaimItem] {
        await pause()
        return memoryState.learning.claims
    }

    public func confirmClaim(id: String) async throws {
        guard memoryState.learning.claims.contains(where: { $0.id == id }) else { throw BackendError.notFound }
        memoryState.learning.claims.removeAll { $0.id == id }
        publish(.changed(.memory))
    }

    public func recentChanges() async throws -> [RecentChange] {
        await pause()
        return memoryState.learning.changes
    }

    public func undoChange(factID: String) async throws {
        guard memoryState.learning.changes.contains(where: { $0.id == factID }) else { throw BackendError.notFound }
        memoryState.learning.changes.removeAll { $0.id == factID }
        publish(.changed(.memory))
    }

    public func remember(text: String) async throws {
        await pause()
        publish(.changed(.memory))
    }

}

extension FixtureData {
    /// 45 rows, so the paging proof has three pages.
    public static let feedback: [FeedbackItem] = (1...45).map { n in
        let kinds = ["not_helpful", "correction", "helpful", "regenerated"]
        let targets = ["message", "draft", "task"]
        let kind = kinds[n % kinds.count]
        return FeedbackItem(
            id: "fbk_\(n)", kind: kind, targetType: targets[n % targets.count],
            text: kind == "correction" ? "Keep replies short on the phone." : nil)
    }

    public static let lessons: [LessonItem] = [
        LessonItem(
            id: "les_1", statement: "Keep replies short when you're on the phone.",
            value: "Keep replies short on the phone.", previous: "Use full sentences.", confidence: 0.8, confirmed: false),
        LessonItem(
            id: "les_2", statement: "Call Dana by her first name.", value: "Refer to Dana by first name.",
            previous: nil, confidence: 0.95, confirmed: true),
        LessonItem(
            id: "les_3", statement: "Remind about rent on Fridays, not Mondays.",
            value: "Remind about rent on Fridays.", previous: "Remind about rent on Mondays.", confidence: 0.55,
            confirmed: false),
    ]

    public static let claims: [ClaimItem] = [
        ClaimItem(id: "clm_1", text: "Your car is due for service in March.", confidence: 0.4),
        ClaimItem(id: "clm_2", text: "You prefer aisle seats on flights.", confidence: 0.6),
    ]

    public static let recentChanges: [RecentChange] = [
        RecentChange(id: "fct_1", sentence: "Ava's birthday is May 3", entityName: "Ava", change: .new),
        RecentChange(
            id: "fct_2", sentence: "Dana's office moved to Harbor Street", entityName: "Dana", change: .changed,
            previousValue: "Dana's office is on Main Street"),
        RecentChange(
            id: "fct_3", sentence: "The kitchen quote is due Nov 28", entityName: "Kitchen remodel", change: .conflict,
            previousValue: "Due Dec 2"),
    ]
}
