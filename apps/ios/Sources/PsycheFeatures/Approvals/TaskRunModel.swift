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
    /// The latest run's helper and specialist runs. Empty when it spawned none.
    private(set) var helpers: [RunHelper] = []
    /// Why the helpers did not load, shown in their section with a retry. The page itself still shows.
    private(set) var helpersError: String?
    let taskID: String
    private let store: any PsycheBackend
    /// How soon a live task is re-read while no event arrives. It doubles after each quiet poll, up to `maxPollInterval`.
    private let pollInterval: Duration
    private let maxPollInterval: Duration
    /// Activity or Home events inside this window mean the session is streaming: those already reload the page.
    private let quietWindow: Duration
    @ObservationIgnored private var lastEventAt: ContinuousClock.Instant?

    init(
        store: any PsycheBackend, taskID: String, pollInterval: Duration = .milliseconds(2500),
        maxPollInterval: Duration = .seconds(15), quietWindow: Duration = .seconds(10)
    ) {
        self.store = store
        self.taskID = taskID
        self.pollInterval = pollInterval
        self.maxPollInterval = maxPollInterval
        self.quietWindow = quietWindow
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
        await reloadHelpers()
    }

    /// Loads the latest run's helpers. A page with no run yet has none. A failure stays in `helpersError`.
    func reloadHelpers() async {
        guard let runID = phase.value?.runID else {
            helpers = []
            helpersError = nil
            return
        }
        do {
            helpers = try await store.runChildren(runID: runID)
            helpersError = nil
        } catch {
            helpersError = error.localizedDescription
        }
    }

    /// Reloads on the activity, home and resync events the agent sheet already listens to.
    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.activity), .changed(.home), .resynced:
                lastEventAt = ContinuousClock.now
                await load()
            default: break
            }
        }
    }

    /// Re-reads a live task while no event arrives, for the steps that have no event of their own. The poll backs off
    /// (2.5 s, doubling, up to 15 s) while it finds nothing new, and waits out events that already reload the page.
    /// An idle page checks rarely. The loop ends when the page's task is cancelled, which happens when the page goes away.
    func pollWhileLive() async {
        var interval = pollInterval
        while true {
            do {
                try await Task.sleep(for: interval)
            } catch {
                return
            }
            guard phase.value?.state.isLive == true else {
                interval = maxPollInterval
                continue
            }
            if let last = lastEventAt, ContinuousClock.now - last < quietWindow {
                interval = pollInterval
                continue
            }
            await load()
            interval = min(interval * 2, maxPollInterval)
        }
    }

    func pause() async { await act { try await self.store.pauseTask(id: self.taskID) } }
    func resume() async { await act { try await self.store.resumeTask(id: self.taskID) } }
    func retry() async { await act { try await self.store.retryTask(id: self.taskID) } }
    func cancel() async { await act { try await self.store.cancelTask(id: self.taskID) } }

    /// Saves the owner's limit changes. Unlike the other actions the failure is thrown, not kept on the page: the
    /// edit sheet shows the Gateway's words and stays open. On success the page reloads what the Gateway now says.
    func updateTask(_ changes: TaskChanges) async throws {
        busy = true
        defer { busy = false }
        try await store.updateTask(id: taskID, changes: changes)
        error = nil
        await load()
    }

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
