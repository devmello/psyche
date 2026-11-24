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

/// Where "Suggest a next step" stands on a goal's sheet.
enum GoalSuggestState: Equatable {
    case idle
    case working
    /// The idea the Gateway made: Start puts it to work, Not now dismisses it. Nothing starts without a tap.
    case offered(IdeaItem)
    case none
    case failed(String)
}

@MainActor @Observable
final class GoalsModel {
    private(set) var phase: LoadPhase<[GoalItem]> = .idle
    private(set) var detail: LoadPhase<GoalDetail> = .idle
    private(set) var actionError: String?
    private(set) var busy = false
    private(set) var suggest: GoalSuggestState = .idle
    /// The owner's chat threads, for the Link a thread picker and to name the linked ones.
    private(set) var threads: [ChatThreadSummary] = []
    private let store: any PsycheBackend
    private var suggestTask: Task<Void, Never>?

    init(store: any PsycheBackend) { self.store = store }

    /// Starts one suggestion in a task the sheet can cancel. A second tap while one runs does nothing.
    func startSuggest(for goal: GoalItem) {
        guard suggest != .working else { return }
        suggest = .working
        suggestTask = Task { await self.runSuggest(for: goal) }
    }

    /// Asks the Gateway for the goal's next step and reads the idea it made from the Home ideas. A cancelled run
    /// changes nothing; any other failure says why. Internal so tests can await one run.
    func runSuggest(for goal: GoalItem) async {
        do {
            guard let ideaID = try await store.suggestNextStep(goalID: goal.id) else {
                if !Task.isCancelled { suggest = .none }
                return
            }
            let ideas = try await store.ideas()
            guard !Task.isCancelled else { return }
            if let idea = ideas.first(where: { $0.id == ideaID }) {
                suggest = .offered(idea)
            } else {
                suggest = .none
            }
        } catch {
            guard !Task.isCancelled else { return }
            suggest = .failed(error.localizedDescription)
        }
    }

    /// Stops a suggestion that is still running and forgets it. The Gateway may still have made the idea; it waits on Home.
    func cancelSuggest() {
        suggestTask?.cancel()
        suggestTask = nil
        suggest = .idle
    }

    /// Start: accepts the offered idea. Not now: dismisses it. Either way the card goes once the Gateway answers.
    func decideSuggestion(start: Bool) async {
        guard case .offered(let idea) = suggest else { return }
        do {
            if start {
                try await store.acceptIdea(id: idea.id)
            } else {
                try await store.dismissIdea(id: idea.id, reason: .notNow)
            }
            suggest = .idle
        } catch {
            suggest = .failed(error.localizedDescription)
        }
    }

    /// Loads the chat threads for the picker and the goal's linked-thread names. A failed load leaves the list empty.
    func loadThreads() async {
        threads = (try? await store.threads()) ?? []
    }

    /// Links a chat thread to the goal and shows the goal page the Gateway answers with. A refusal throws, so the
    /// picker shows the Gateway's words and stays open.
    func linkThread(_ thread: ChatThreadSummary, to goal: GoalItem) async throws {
        try await store.linkThread(goalID: goal.id, threadID: thread.id)
        if let fresh = try? await store.goalDetail(id: goal.id) { showDetail(fresh) }
        actionError = nil
    }

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

    /// The statuses a phone can set from the goal's current one. A suggested goal is decided, not set.
    static func choices(for status: String) -> [GoalStatusChange] {
        switch status {
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
            showDetail(updated)
            actionError = nil
        } catch {
            actionError = error.localizedDescription
        }
    }

    /// Add goal, Not now or Dismiss on a suggested goal. Returns true when the goal is now archived (it was
    /// dismissed), so the sheet closes. Nothing is created before confirm.
    func decide(_ decision: GoalDecision, for goal: GoalItem) async -> Bool {
        await write { try await self.store.decideGoal(id: goal.id, decision) }
    }

    /// Archive goal: its check-ins stop. Returns true once archived, so the sheet closes.
    func archive(_ goal: GoalItem) async -> Bool {
        await write { try await self.store.archiveGoal(id: goal.id) }
    }

    /// Marks a milestone done or not done, or removes it. A refusal stays in `actionError`.
    func changeMilestone(_ change: GoalMilestoneChange, for goal: GoalItem) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            showDetail(try await store.changeMilestone(goalID: goal.id, change))
            actionError = nil
        } catch {
            actionError = error.localizedDescription
        }
    }

    /// Adds a milestone. A refusal throws so the Add milestone sheet can show it in the Gateway's words.
    func addMilestone(title: String, dueAt: Date?, for goal: GoalItem) async throws {
        showDetail(try await store.changeMilestone(goalID: goal.id, .add(title: title, dueAt: dueAt)))
        actionError = nil
    }

    /// One write that moves the goal in the list and the sheet. Returns true when the goal is now archived.
    private func write(_ work: () async throws -> GoalItem) async -> Bool {
        guard !busy else { return false }
        busy = true
        defer { busy = false }
        do {
            let updated = try await work()
            showGoal(updated)
            actionError = nil
            return updated.status == "archived"
        } catch {
            actionError = error.localizedDescription
            return false
        }
    }

    /// Shows a goal the Gateway returned: its list row, which leaves the list once archived, and the sheet's goal
    /// with its milestones kept.
    private func showGoal(_ goal: GoalItem) {
        if var goals = phase.value {
            if goal.status == "archived" {
                goals.removeAll { $0.id == goal.id }
            } else if let index = goals.firstIndex(where: { $0.id == goal.id }) {
                goals[index] = goal
            }
            phase = .loaded(goals)
        }
        if let current = detail.value, current.goal.id == goal.id {
            detail = .loaded(GoalDetail(
                goal: goal, milestones: current.milestones, linkedTasks: current.linkedTasks, linkedTaskIDs: current.linkedTaskIDs))
        }
    }

    /// Shows a whole goal page the Gateway returned.
    private func showDetail(_ updated: GoalDetail) {
        detail = .loaded(updated)
        showGoal(updated.goal)
    }

    func close() {
        cancelSuggest()
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
