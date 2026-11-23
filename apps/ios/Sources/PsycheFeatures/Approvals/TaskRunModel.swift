import Observation
import PsycheStore

/// A task's run page: the task, its latest run's steps and the owner's actions. The page refreshes from the
/// activity events, and while the task is live it reloads every few seconds (steps have no event of their own
/// that the phone can count on). Every failure is kept and shown inline; nothing is swallowed.
extension TaskRunDetail {
    /// What the page draws while the first load is in flight.
    static let skeleton = TaskRunDetail(
        taskID: "skeleton", title: "Placeholder task title", state: .running, startedAt: nil, endedAt: nil, summary: nil,
        steps: (1...3).map { TaskRunStep(id: "skst\($0)", label: "Placeholder step", status: .pending) })
}

@MainActor @Observable
final class TaskRunModel {
    private(set) var phase: LoadPhase<TaskRunDetail> = .idle
    /// The last action's or refresh's failure, shown inline. Cleared when an action succeeds.
    private(set) var error: String?
    /// An action is in flight: its buttons wait.
    private(set) var busy = false
    let taskID: String
    private let store: any PsycheBackend

    init(store: any PsycheBackend, taskID: String) {
        self.store = store
        self.taskID = taskID
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(try await store.taskRun(taskID: taskID))
        } catch {
            if phase.value == nil {
                phase = .failed(error.localizedDescription)
            } else {
                self.error = error.localizedDescription
            }
        }
    }

    /// Reloads on the activity, home and resync events the agent sheet already listens to.
    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.activity), .changed(.home), .resynced: await load()
            default: break
            }
        }
    }

    /// While the task is live, reloads every 2.5 s. The loop ends when the page's task is cancelled, which
    /// happens when the page goes away.
    func pollWhileLive() async {
        while true {
            do {
                try await Task.sleep(for: .seconds(2.5))
            } catch {
                return
            }
            guard phase.value?.state.isLive == true else { continue }
            await load()
        }
    }

    func pause() async { await act { try await self.store.pauseTask(id: self.taskID) } }
    func resume() async { await act { try await self.store.resumeTask(id: self.taskID) } }
    func retry() async { await act { try await self.store.retryTask(id: self.taskID) } }
    func cancel() async { await act { try await self.store.cancelTask(id: self.taskID) } }

    /// Sends guidance to the running task. Returns false, and sends nothing, for blank text.
    func steer(_ text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return await act { try await self.store.steerTask(id: self.taskID, text: trimmed) }
    }

    /// Runs one action, then reloads so the page shows what the Gateway now says. The action's failure stays
    /// on the page; a reload failure after a successful action is reported too.
    @discardableResult
    private func act(_ work: () async throws -> Void) async -> Bool {
        busy = true
        defer { busy = false }
        var succeeded = true
        do {
            try await work()
            error = nil
        } catch {
            self.error = error.localizedDescription
            succeeded = false
        }
        await load()
        return succeeded
    }
}
