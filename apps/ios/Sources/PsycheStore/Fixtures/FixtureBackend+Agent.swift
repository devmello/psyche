import Foundation

/// The agent sheet's fixture state.
struct AgentState: Sendable {
    var nextUp = FixtureData.nextUp
    var recent = FixtureData.recent
    /// Task states the fixture's owner controls have moved (pause, resume, retry), by task id.
    var taskStates: [String: TaskRunState] = [:]
}

extension FixtureBackend: AgentBackend {
    public func activity() async throws -> AgentActivity {
        await pause()
        return AgentActivity(
            needsYou: homeState.snapshot.needsYou, now: homeState.snapshot.running,
            nextUp: agentState.nextUp, recent: agentState.recent)
    }

    public func persona() async throws -> PersonaSummary { FixtureData.persona }

    public func cancelTask(id: String) async throws {
        guard let task = homeState.snapshot.running.first(where: { $0.id == id }) else { throw BackendError.notFound }
        homeState.snapshot.running.removeAll { $0.id == id }
        agentState.recent.insert(RecentRun(id: id, title: task.title, outcome: .cancelled, time: "now"), at: 0)
        agentState.taskStates[id] = .cancelled
        publish(.changed(.activity))
        publish(.changed(.home))
    }

    public func taskRun(taskID: String) async throws -> TaskRunDetail {
        await pause()
        let running = homeState.snapshot.running.first { $0.id == taskID }
        let recent = agentState.recent.first { $0.id == taskID }
        guard let title = running?.title ?? recent?.title else { throw BackendError.notFound }
        let state = agentState.taskStates[taskID] ?? running.map { _ in TaskRunState.running } ?? Self.fixtureState(recent?.outcome)
        return TaskRunDetail(
            taskID: taskID, title: title, state: state,
            startedAt: .now.addingTimeInterval(-340), endedAt: state.isLive ? nil : .now.addingTimeInterval(-20),
            summary: state == .done ? "Filed the expense report and sent the receipt copy to Dana." : nil,
            steps: FixtureData.runSteps(now: .now, state: state))
    }

    public func pauseTask(id: String) async throws {
        try requireTask(id)
        agentState.taskStates[id] = .paused
        publish(.changed(.activity))
    }

    public func resumeTask(id: String) async throws {
        try requireTask(id)
        agentState.taskStates[id] = .running
        publish(.changed(.activity))
    }

    public func retryTask(id: String) async throws {
        guard let task = agentState.recent.first(where: { $0.id == id }) else { throw BackendError.notFound }
        agentState.recent.removeAll { $0.id == id }
        homeState.snapshot.running.insert(
            RunningTask(id: id, title: task.title, step: 1, stepCount: 4, detail: "Starting again", elapsed: "just now", startedAt: .now), at: 0)
        agentState.taskStates[id] = .running
        publish(.changed(.activity))
        publish(.changed(.home))
    }

    public func steerTask(id: String, text: String) async throws {
        try requireTask(id)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw BackendError.refused("Write what to change first.") }
        publish(.changed(.activity))
    }

    private func requireTask(_ id: String) throws {
        guard homeState.snapshot.running.contains(where: { $0.id == id }) || agentState.recent.contains(where: { $0.id == id })
        else { throw BackendError.notFound }
    }

    private static func fixtureState(_ outcome: RecentRun.Outcome?) -> TaskRunState {
        switch outcome {
        case .failed: .failed
        case .cancelled: .cancelled
        case .done, nil: .done
        }
    }
}

extension FixtureData {

    public static let nextUp: [UpcomingItem] = [
        UpcomingItem(id: "u1", title: "Morning brief", when: "Tomorrow 7:00 · every weekday"),
        UpcomingItem(id: "u2", title: "Check the PG&E payment cleared", when: "Fri 9:00"),
        UpcomingItem(id: "u3", title: "Remind you to leave for SFO", when: "Today 17:40"),
    ]

    public static let recent: [RecentRun] = [
        RecentRun(id: "r1", title: "Filed the expense report", outcome: .done, time: "Yesterday 16:02"),
        RecentRun(id: "r2", title: "Summarized the lease renewal", outcome: .done, time: "Oct 28"),
        RecentRun(id: "r3", title: "Looked up flight UA 1182", outcome: .done, time: "Oct 24"),
    ]

    public static let persona = PersonaSummary(
        name: "Psyche",
        summary: "Plain-spoken and brief. Asks before spending money or writing to anyone. Keeps you posted on Home, not with pings.",
        files: ["persona.md", "voice.md", "boundaries.md"])

    /// Four steps for a run page; the last one's status follows the task's.
    static func runSteps(now: Date, state: TaskRunState) -> [TaskRunStep] {
        let last: TaskRunStep.Status = switch state {
        case .failed: .failed
        case .cancelled: .cancelled
        case .done: .ok
        default: .running
        }
        return [
            TaskRunStep(id: "s1", label: "Opened the expense folder", status: .ok,
                        startedAt: now.addingTimeInterval(-340), endedAt: now.addingTimeInterval(-300), result: "12 receipts found"),
            TaskRunStep(id: "s2", label: "Read the receipts", status: .ok,
                        startedAt: now.addingTimeInterval(-300), endedAt: now.addingTimeInterval(-200), result: "Total $412.80"),
            TaskRunStep(id: "s3", label: "Filled in the report", status: last == .running ? .running : .ok,
                        startedAt: now.addingTimeInterval(-200), endedAt: last == .running ? nil : now.addingTimeInterval(-60)),
            TaskRunStep(id: "s4", label: "Sent it to Dana", status: last == .running ? .pending : last,
                        startedAt: last == .running ? nil : now.addingTimeInterval(-60), endedAt: nil,
                        result: last == .failed ? "The mail server refused the message" : nil),
        ]
    }
}
