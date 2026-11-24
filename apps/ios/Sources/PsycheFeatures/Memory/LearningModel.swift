import Foundation
import Observation
import PsycheStore

/// The learning screens on the Memory tab: what Psyche learned, the claims to confirm, recent changes with undo,
/// and the owner's quick notes. Writes reload the list they change; a failed write shows in `notice`, or is thrown
/// to the sheet that made it, so the owner keeps what they typed.
@MainActor @Observable
final class LearningModel {
    /// The most a note may hold (memory.remember takes up to 4000 characters).
    nonisolated static let noteLimit = 4000

    private(set) var lessons: LoadPhase<[LessonItem]> = .idle
    private(set) var claims: LoadPhase<[ClaimItem]> = .idle
    private(set) var changes: LoadPhase<[RecentChange]> = .idle
    /// Shown in an alert when a write from a list fails.
    var notice: String?
    /// Claims put off with "Not now" this session. Not persisted and never sent to the Gateway.
    private(set) var hiddenClaimIDs: Set<String> = []

    /// The owner's feedback, a page at a time, newest first (feedback.list).
    let feedback: PagedRows<FeedbackItem>

    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
        feedback = PagedRows { cursor in
            let page = try await store.feedbackPage(cursor: cursor)
            return (page.events, page.nextCursor)
        }
    }

    // MARK: Reads

    func loadLessons() async {
        if lessons.value == nil { lessons = .loading }
        do {
            lessons = .loaded(try await store.lessons())
        } catch {
            if lessons.value == nil { lessons = .failed(error.localizedDescription) }
        }
    }

    func loadClaims() async {
        if claims.value == nil { claims = .loading }
        do {
            claims = .loaded(try await store.claims())
        } catch {
            if claims.value == nil { claims = .failed(error.localizedDescription) }
        }
    }

    func loadChanges() async {
        if changes.value == nil { changes = .loading }
        do {
            changes = .loaded(try await store.recentChanges())
        } catch {
            if changes.value == nil { changes = .failed(error.localizedDescription) }
        }
    }

    /// The lesson as it is now, so a detail page shows a confirm or an edit at once. Nil once it is gone.
    func lesson(id: String) -> LessonItem? {
        lessons.value?.first { $0.id == id }
    }

    // MARK: Lessons

    func confirm(_ lesson: LessonItem) async {
        await write { try await self.store.confirmLesson(id: lesson.id) }
        await loadLessons()
    }

    /// Saves the owner's line. Throws so the sheet stays open with the Gateway's words.
    func edit(_ lesson: LessonItem, value: String) async throws {
        try await store.editLesson(id: lesson.id, value: value)
        await loadLessons()
    }

    func forget(_ lesson: LessonItem) async {
        await write { try await self.store.forgetLesson(id: lesson.id) }
        await loadLessons()
    }

    // MARK: Feedback

    /// Deletes one piece of feedback, then reloads the feedback and the lessons: the Gateway forgets the lessons made
    /// only from it.
    func deleteFeedback(_ item: FeedbackItem) async {
        await write { try await self.store.deleteFeedback(id: item.id) }
        await feedback.reload()
        await loadLessons()
    }

    // MARK: Claims

    func confirm(_ claim: ClaimItem) async {
        await write { try await self.store.confirmClaim(id: claim.id) }
        await loadClaims()
    }

    /// "Not now": hides a claim for this session only. Nothing is sent to the Gateway and the claim stays waiting.
    func hideForNow(_ claim: ClaimItem) {
        hiddenClaimIDs.insert(claim.id)
    }

    /// The claims the To confirm screen shows: waiting ones the owner has not put off for now.
    func shownClaims(_ claims: [ClaimItem]) -> [ClaimItem] {
        claims.filter { !hiddenClaimIDs.contains($0.id) }
    }

    // MARK: Recent changes

    func undo(_ change: RecentChange) async {
        await write { try await self.store.undoChange(factID: change.id) }
        await loadChanges()
    }

    // MARK: Quick note

    /// A note is worth saving when it has text other than whitespace and fits the Gateway's limit.
    static func canRemember(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.count <= noteLimit
    }

    /// Saves the owner's note to today's daily note. Throws so the sheet stays open with the Gateway's words.
    func remember(_ text: String) async throws {
        try await store.remember(text: text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    // MARK: Helpers

    private func write(_ work: () async throws -> Void) async {
        do {
            try await work()
        } catch {
            notice = error.localizedDescription
        }
    }
}
