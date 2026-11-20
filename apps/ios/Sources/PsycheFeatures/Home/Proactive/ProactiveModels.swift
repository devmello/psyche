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
        do { detail = .loaded(try await store.goalDetail(id: goal.id)) } catch {
            detail = .failed(error.localizedDescription)
        }
    }

    func close() { detail = .idle }
}

@MainActor @Observable
final class ScheduledModel {
    private(set) var phase: LoadPhase<ScheduledOverview> = .idle
    private let store: any PsycheBackend

    init(store: any PsycheBackend) { self.store = store }

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
