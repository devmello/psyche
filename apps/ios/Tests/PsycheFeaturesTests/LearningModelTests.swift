import Foundation
import PsycheStore
import Testing

@testable import PsycheFeatures

/// The learning screens' model over the demo backend: the lists load, writes reload them, and a note is only
/// saved when it has words in it.
@MainActor
struct LearningModelTests {
    private func model() -> LearningModel {
        LearningModel(store: FixtureBackend(latency: .zero))
    }

    @Test(arguments: [
        ("", false), ("   \n\t", false), ("Dentist on Friday", true), ("  Dentist  ", true),
        (String(repeating: "a", count: LearningModel.noteLimit), true),
        (String(repeating: "a", count: LearningModel.noteLimit + 1), false),
    ] as [(String, Bool)])
    func aNoteNeedsWordsAndFitsTheLimit(text: String, expected: Bool) {
        #expect(LearningModel.canRemember(text) == expected)
    }

    @Test func lessonsLoadFromTheDemo() async {
        let model = model()
        await model.loadLessons()
        #expect(model.lessons.value?.count == 3)
    }

    @Test func forgettingALessonRemovesItFromTheList() async {
        let model = model()
        await model.loadLessons()
        guard let lesson = model.lessons.value?.first else {
            Issue.record("no lessons loaded")
            return
        }
        await model.forget(lesson)
        #expect(model.lessons.value?.contains(lesson) == false)
        #expect(model.notice == nil)
    }

    @Test func confirmingALessonKeepsItAndMarksItConfirmed() async {
        let model = model()
        await model.loadLessons()
        guard let lesson = model.lessons.value?.first(where: { !$0.confirmed }) else {
            Issue.record("no unconfirmed lesson in the demo")
            return
        }
        await model.confirm(lesson)
        #expect(model.lesson(id: lesson.id)?.confirmed == true)
    }

    @Test func editingALessonThrowsWhenTheLessonIsGone() async {
        let model = model()
        await model.loadLessons()
        let ghost = LessonItem(id: "les_gone", statement: "x", value: "x", confidence: 0.5, confirmed: false)
        await #expect(throws: BackendError.notFound) {
            try await model.edit(ghost, value: "y")
        }
    }

    @Test func rejectingAClaimRemovesIt() async {
        let model = model()
        await model.loadClaims()
        guard let claim = model.claims.value?.first else {
            Issue.record("no claims loaded")
            return
        }
        await model.reject(claim)
        #expect(model.claims.value?.contains(claim) == false)
    }

    @Test func confirmingAClaimRemovesItFromTheWaitingList() async {
        let model = model()
        await model.loadClaims()
        let before = model.claims.value?.count ?? 0
        guard let claim = model.claims.value?.first else {
            Issue.record("no claims loaded")
            return
        }
        await model.confirm(claim)
        #expect(model.claims.value?.count == before - 1)
    }

    @Test func undoingAChangeRemovesIt() async {
        let model = model()
        await model.loadChanges()
        guard let change = model.changes.value?.first else {
            Issue.record("no changes loaded")
            return
        }
        await model.undo(change)
        #expect(model.changes.value?.contains(change) == false)
    }

    @Test func aNoteIsSavedThroughTheBackend() async throws {
        let model = model()
        try await model.remember("  Dentist on Friday  ")
    }

    @Test func changeLabelsMatchTheMacWording() {
        let new = RecentChange(id: "a", sentence: "s", entityName: "e", change: .new)
        let changed = RecentChange(id: "b", sentence: "s", entityName: "e", change: .changed, previousValue: "Main")
        let conflict = RecentChange(id: "c", sentence: "s", entityName: "e", change: .conflict, previousValue: "Dec 2")
        #expect(RecentChangesView.label(new) == "New")
        #expect(RecentChangesView.label(changed) == "Changed (was Main)")
        #expect(RecentChangesView.label(conflict) == "Disagrees with Dec 2")
    }
}
