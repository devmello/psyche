import Foundation
import Testing

@testable import PsycheStore

/// The run page's controls: which ones each task state allows, and the fixture's owner actions.
struct TaskRunTests {
    let store = FixtureBackend()

    @Test func theFixtureRunHasTwoHelpersAndOtherRunsHaveNone() async throws {
        let helpers = try await store.runChildren(runID: FixtureData.runID)
        #expect(helpers.count == 2)
        #expect(helpers.map(\.kind) == [.specialist, .helper])
        #expect(try await store.runChildren(runID: "run_not_in_fixture").isEmpty)
    }

    @Test func eachStateShowsOnlyTheControlsTheGatewayAccepts() {
        let expected: [TaskRunState: [String]] = [
            .running: ["pause", "steer", "cancel"],
            .queued: ["cancel"],
            .awaitingInput: ["cancel"],
            .awaitingApproval: ["cancel"],
            .paused: ["resume", "cancel"],
            .failed: ["retry"],
            .cancelled: ["retry"],
            .done: [],
        ]
        for state in TaskRunState.allCases {
            let controls = TaskRunControls.available(for: state)
            var shown: [String] = []
            if controls.canPause { shown.append("pause") }
            if controls.canResume { shown.append("resume") }
            if controls.canRetry { shown.append("retry") }
            if controls.canSteer { shown.append("steer") }
            if controls.canCancel { shown.append("cancel") }
            #expect(shown == expected[state], "\(state.rawValue) shows \(shown)")
            #expect(controls.isEmpty == shown.isEmpty)
        }
    }

    @Test func onlyUnfinishedStatesKeepThePageRefreshing() {
        #expect(TaskRunState.allCases.filter(\.isLive) == [.queued, .running, .awaitingInput, .awaitingApproval, .paused])
    }

    @Test func theFixtureRunPageFollowsTheOwnersActions() async throws {
        let first = try await store.taskRun(taskID: "task_q3")
        #expect(first.state == .running)
        #expect(first.controls.canPause && first.controls.canSteer)
        #expect(!first.steps.isEmpty)

        try await store.pauseTask(id: "task_q3")
        #expect(try await store.taskRun(taskID: "task_q3").state == .paused)
        try await store.resumeTask(id: "task_q3")
        #expect(try await store.taskRun(taskID: "task_q3").state == .running)

        // Blank guidance is refused, and nothing is sent.
        await #expect(throws: BackendError.self) { try await store.steerTask(id: "task_q3", text: "   ") }
        try await store.steerTask(id: "task_q3", text: "Use the Q3 file")

        try await store.cancelTask(id: "task_q3")
        #expect(try await store.taskRun(taskID: "task_q3").controls.canRetry)
        try await store.retryTask(id: "task_q3")
        #expect(try await store.taskRun(taskID: "task_q3").state == .running)
    }

    @Test func anUnknownTaskIsNotFound() async throws {
        await #expect(throws: BackendError.notFound) { try await store.taskRun(taskID: "nope") }
        await #expect(throws: BackendError.notFound) { try await store.pauseTask(id: "nope") }
    }
}
