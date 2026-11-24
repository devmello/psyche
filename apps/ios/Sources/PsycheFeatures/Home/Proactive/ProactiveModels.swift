import Foundation
import Observation
import PsycheStore

/// Feed, Ideas, Goals and Scheduled models. Each loads its own snapshot and keeps what is on screen when a
/// refresh fails. Acting on a card or idea takes it off the list at once and puts it back if the call fails.

@MainActor @Observable
final class FeedModel {
    private(set) var phase: LoadPhase<FeedSnapshot> = .idle
    private(set) var actionError: String?
    private let store: any PsycheBackend

    init(store: any PsycheBackend) { self.store = store }

    func load() async {
        if phase.value == nil { phase = .loading }
        do { phase = .loaded(try await store.feed()) } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }

    func observe() async {
        for await event in store.events() {
            if case .resynced = event { await load() }
        }
    }

    /// "Not interested" is the dismiss: the card leaves. Save and like keep it, marked.
    func give(_ feedback: FeedFeedback, to card: FeedCard) async {
        guard var snapshot = phase.value, let index = snapshot.cards.firstIndex(where: { $0.id == card.id }) else { return }
        let before = snapshot
        // A second tap on the same mark clears it.
        let next: FeedFeedback? = card.feedback == feedback ? nil : feedback
        if next == .notInterested { snapshot.cards.remove(at: index) } else { snapshot.cards[index].feedback = next }
        phase = .loaded(snapshot)
        do {
            try await store.setFeedback(postID: card.id, next)
            actionError = nil
        } catch {
            phase = .loaded(before)
            actionError = error.localizedDescription
        }
    }
}

@MainActor @Observable
final class IdeasModel {
    private(set) var phase: LoadPhase<[IdeaItem]> = .idle
    private(set) var actionError: String?
    private let store: any PsycheBackend

    init(store: any PsycheBackend) { self.store = store }

    func load() async {
        if phase.value == nil { phase = .loading }
        do { phase = .loaded(try await store.ideas()) } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }

    func observe() async {
        for await event in store.events() {
            if case .resynced = event { await load() }
        }
    }

    func accept(_ idea: IdeaItem) async {
        await decide(idea) { try await self.store.acceptIdea(id: idea.id) }
    }

    func dismiss(_ idea: IdeaItem, reason: IdeaDismissReason) async {
        await decide(idea) { try await self.store.dismissIdea(id: idea.id, reason: reason) }
    }

    private func decide(_ idea: IdeaItem, _ work: () async throws -> Void) async {
        guard let before = phase.value else { return }
        phase = .loaded(before.filter { $0.id != idea.id })
        do {
            try await work()
            actionError = nil
        } catch {
            phase = .loaded(before)
            actionError = error.localizedDescription
        }
    }
}

@MainActor @Observable
final class GoalsModel {
    private(set) var phase: LoadPhase<[GoalItem]> = .idle
    private(set) var detail: LoadPhase<GoalDetail> = .idle
    private(set) var actionError: String?
    private(set) var busy = false
    private let store: any PsycheBackend

    init(store: any PsycheBackend) { self.store = store }

    func load() async {
        if phase.value == nil { phase = .loading }
        do { phase = .loaded(try await store.goals()) } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }

    func observe() async {
        for await event in store.events() {
            if case .resynced = event { await load() }
        }
    }

    func open(_ goal: GoalItem) async {
        detail = .loading
        actionError = nil
        do { detail = .loaded(try await store.goalDetail(id: goal.id)) } catch {
            detail = .failed(error.localizedDescription)
        }
    }

    /// Creates the goal the draft describes, then reloads the list so it shows. A refusal throws and leaves the
    /// list as it was; the Add goal sheet shows the Gateway's words.
    func create(_ draft: GoalDraft) async throws {
        guard draft.isValid else { return }
        _ = try await store.createGoal(title: draft.trimmedTitle, category: draft.category)
        await load()
    }

    /// The statuses a phone can set from the goal's current one.
    static func choices(for status: String) -> [GoalStatusChange] {
        switch status {
        case "candidate": [.active]
        case "active": [.paused, .done]
        case "paused": [.active, .done]
        case "done": [.active]
        default: []
        }
    }

    /// Sets the status. The sheet and the list show the Gateway's goal once it has answered; a refusal leaves
    /// both as they were and says why.
    func setStatus(_ status: GoalStatusChange, for goal: GoalItem) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let updated = try await store.setGoalStatus(id: goal.id, status)
            detail = .loaded(updated)
            if var goals = phase.value, let index = goals.firstIndex(where: { $0.id == goal.id }) {
                goals[index] = updated.goal
                phase = .loaded(goals)
            }
            actionError = nil
        } catch {
            actionError = error.localizedDescription
        }
    }

    func close() {
        detail = .idle
        actionError = nil
    }
}

@MainActor @Observable
final class ScheduledModel {
    private(set) var phase: LoadPhase<ScheduledOverview> = .idle
    private(set) var actionError: String?
    /// Items with a pause or run in flight: their buttons are off until the Gateway answers.
    private(set) var busy: Set<String> = []
    private let store: any PsycheBackend

    init(store: any PsycheBackend) { self.store = store }

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
        do { phase = .loaded(try await store.scheduled()) } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }

    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.activity), .resynced: await load()
            default: break
            }
        }
    }
}
