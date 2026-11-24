import Foundation
import Testing

@testable import PsycheStore

/// The task edit sheet's rules: which fields count as changed, when Save is allowed, and the fixture's owner edits.
/// Pure model tests: no view, no Gateway. Number text is written in forms every locale reads the same way.
struct TaskEditDraftTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func limits(tokens: Int? = 200_000, cost: Double? = 2.5, minutes: Int? = 30, deadline: Date? = nil) -> TaskLimits {
        TaskLimits(tokens: tokens, costUsd: cost, minutes: minutes, deadline: deadline)
    }

    @Test func anUntouchedDraftSendsNothingAndCannotSave() {
        let draft = TaskEditDraft(limits: limits(), now: now)
        #expect(draft.changes == nil)
        #expect(!draft.canSave)
    }

    @Test func onlyTheEditedTokensAreSent() {
        var draft = TaskEditDraft(limits: limits(), now: now)
        draft.tokensText = "250000"
        #expect(draft.changes == TaskChanges(tokens: 250_000))
        #expect(draft.canSave)
    }

    @Test func retypingTheSameValueIsNoChange() {
        var draft = TaskEditDraft(limits: limits(), now: now)
        draft.tokensText = " 200000 "
        #expect(draft.changes == nil)
        #expect(!draft.canSave)
    }

    @Test func aCostAndATimeEditSendOnlyThoseFields() {
        var draft = TaskEditDraft(limits: limits(), now: now)
        draft.costText = "4"
        draft.minutesText = "45"
        #expect(draft.changes == TaskChanges(costUsd: 4, minutes: 45))
    }

    @Test func aFieldLeftBlankAndUntouchedIsNotAProblem() {
        // The Gateway sent no token limit. Leaving that field blank must not block a change to another field.
        var draft = TaskEditDraft(limits: limits(tokens: nil), now: now)
        #expect(draft.tokensText.isEmpty)
        draft.minutesText = "45"
        #expect(draft.changes == TaskChanges(minutes: 45))
        #expect(draft.canSave)
    }

    @Test func aFieldTheOwnerClearedBlocksSave() {
        var draft = TaskEditDraft(limits: limits(), now: now)
        draft.tokensText = ""
        #expect(draft.tokensInvalid)
        #expect(!draft.canSave)
    }

    @Test func tokensAndMinutesMustBeWholeNumbersAboveZero() {
        var draft = TaskEditDraft(limits: limits(), now: now)
        draft.minutesText = "0"
        #expect(draft.minutesInvalid)
        #expect(!draft.canSave)

        draft.minutesText = "30"
        draft.tokensText = "0"
        #expect(draft.tokensInvalid)
        #expect(!draft.canSave)
    }

    @Test func aNegativeCostIsRefused() {
        var draft = TaskEditDraft(limits: limits(), now: now)
        draft.costText = "-1"
        #expect(draft.costInvalid)
        #expect(!draft.canSave)

        draft.costText = "0"
        #expect(draft.changes == TaskChanges(costUsd: 0))
    }

    @Test func aDeadlineInTheFutureIsSentAndAPastOneBlocksSave() {
        var draft = TaskEditDraft(limits: limits(), now: now)
        draft.deadline = now.addingTimeInterval(3_600)
        #expect(draft.changes == TaskChanges(deadline: now.addingTimeInterval(3_600)))
        #expect(draft.canSave)

        draft.deadline = now.addingTimeInterval(-60)
        #expect(draft.deadlineInvalid)
        #expect(!draft.canSave)
    }

    @Test func aDeadlineTheJobAlreadyHasIsKeptWithoutAChange() {
        let due = now.addingTimeInterval(7_200)
        let draft = TaskEditDraft(limits: limits(deadline: due), now: now)
        #expect(draft.changes == nil)
        #expect(!draft.deadlineInvalid)
    }

    @Test func limitsEditedTogetherGoInOneChangeSet() {
        var draft = TaskEditDraft(limits: limits(), now: now)
        draft.tokensText = "300000"
        draft.minutesText = "60"
        draft.deadline = now.addingTimeInterval(3_600)
        #expect(draft.changes == TaskChanges(tokens: 300_000, minutes: 60, deadline: now.addingTimeInterval(3_600)))
    }

    @Test func theFixtureOwnerEditsAreSavedOnALiveJobAndRefusedOnAnEndedOne() async throws {
        let store = FixtureBackend()
        try await store.updateTask(id: "task_q3", changes: TaskChanges(tokens: 300_000, minutes: 60))
        let run = try await store.taskRun(taskID: "task_q3")
        #expect(run.limits?.tokens == 300_000)
        #expect(run.limits?.minutes == 60)
        #expect(run.controls.canEdit)

        await #expect(throws: BackendError.notFound) {
            try await store.updateTask(id: "task_missing", changes: TaskChanges(minutes: 5))
        }
    }

    @Test func aTaskThatHasEndedOffersNoEditAndRefusesOne() async throws {
        let store = FixtureBackend()
        let ended = try await store.taskRun(taskID: "r1")
        #expect(ended.limits == nil)
        #expect(!ended.controls.canEdit)
        await #expect(throws: BackendError.refused("This task has already ended.")) {
            try await store.updateTask(id: "r1", changes: TaskChanges(minutes: 5))
        }
    }
}
