import Foundation
import Observation
import PsycheStore

/// The Scheduled tasks model: loads its own snapshot and keeps what is on screen when a refresh fails.

/// Coalesces a burst of change events into one reload.
@MainActor
final class ReloadDebouncer {
    private let delay: Duration
    private var task: Task<Void, Never>?

    init(delay: Duration) { self.delay = delay }

    func schedule(_ work: @escaping @MainActor () async -> Void) {
        task?.cancel()
        task = Task { [delay] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await work()
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
    }
}

/// The wait before a change event reloads a list; tests pass a shorter one.
let proactiveReloadDelay: Duration = .milliseconds(400)

@MainActor @Observable
final class ScheduledModel {
    private(set) var phase: LoadPhase<ScheduledOverview> = .idle
    /// Finished and running tasks, newest first: the "Past" section (what Task history showed). A failed read keeps
    /// what is on screen.
    private(set) var past: [RecentRun] = []
    private(set) var actionError: String?
    /// Items with a pause or run in flight: their buttons are off until the Gateway answers.
    private(set) var busy: Set<String> = []
    private let store: any PsycheBackend
    private let reloads: ReloadDebouncer

    init(store: any PsycheBackend, reloadDelay: Duration = proactiveReloadDelay) {
        self.store = store
        reloads = ReloadDebouncer(delay: reloadDelay)
    }

    func isBusy(_ id: String) -> Bool { busy.contains(id) }

    /// Pause an active or paused item, or resume a paused one. The state shown changes only after the Gateway
    /// answers with it.
    func togglePause(_ job: ScheduledJob) async {
        guard job.state == "active" || job.state == "paused", !busy.contains(job.id) else { return }
        busy.insert(job.id)
        defer { busy.remove(job.id) }
        do {
            let state = try await store.setScheduledPaused(id: job.id, paused: job.state == "active")
            if var overview = phase.value, let index = overview.items.firstIndex(where: { $0.id == job.id }) {
                overview.items[index].state = state
                overview.upcoming = ScheduledOverview.upcomingOf(overview.items)
                phase = .loaded(overview)
            }
            actionError = nil
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }

    /// Deletes an automation the owner made (routines are Psyche's own and stay). The list reloads after the Gateway
    /// answers; a refusal is shown in the list's action error.
    func delete(_ job: ScheduledJob) async {
        guard !job.isRoutine, !busy.contains(job.id) else { return }
        busy.insert(job.id)
        defer { busy.remove(job.id) }
        do {
            try await store.deleteAutomation(id: job.id)
            actionError = nil
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }

    /// Run now. A run it starts appears in the list after a reload.
    func runNow(_ job: ScheduledJob) async {
        guard job.state != "off", !busy.contains(job.id) else { return }
        busy.insert(job.id)
        defer { busy.remove(job.id) }
        do {
            try await store.runScheduledNow(id: job.id)
            actionError = nil
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        async let activity = try? store.activity()
        do { phase = .loaded(try await store.scheduled()) } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
        if let activity = await activity { past = activity.recent }
    }

    func observe() async {
        defer { reloads.cancel() }
        for await event in store.events() {
            switch event {
            case .resynced:
                reloads.cancel()
                await load()
            // `automation.updated` and run changes: an open Scheduled page follows them.
            case .changed(.scheduled), .changed(.activity): reloads.schedule { await self.load() }
            default: break
            }
        }
    }
}
