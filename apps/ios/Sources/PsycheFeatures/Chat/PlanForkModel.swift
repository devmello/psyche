import Foundation
import Observation
import PsycheStore

// Fork a plan on the phone (docs/design/fork-a-plan-2026.md §5.2): the models behind the fork card, the lanes and
// comparison, the start sheet and the Take sheet. Pure state and rules, so they are tested off the device.

/// One fork, kept fresh: read with `planForks.get`, refetched on every `planFork.updated` and after a reconnect.
@MainActor @Observable
final class PlanForkModel {
    let forkID: String
    private(set) var phase: LoadPhase<PlanForkDetail> = .idle
    private(set) var busy = false
    private(set) var notice: String?
    private let store: any PlanForkBackend & LiveUpdates

    init(forkID: String, store: any PlanForkBackend & LiveUpdates) {
        self.forkID = forkID
        self.store = store
    }

    var detail: PlanForkDetail? { phase.value }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(try await store.planFork(id: forkID))
        } catch {
            // A failed refresh keeps what is on screen.
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }

    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.planForks), .resynced: await load()
            default: break
            }
        }
    }

    func cancel() async {
        await act { try await self.store.cancelPlanFork(forkID: self.forkID, branchID: nil) }
    }

    func dismiss() async {
        await act { try await self.store.dismissPlanFork(forkID: self.forkID) }
    }

    func continuePlan() async {
        guard let detail, detail.continuePending, let branch = detail.fork.takenBranchID else { return }
        await act { try await self.store.continuePlanFork(forkID: self.forkID, branchID: branch) }
    }

    func clearNotice() { notice = nil }

    private func act(_ work: () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        notice = nil
        do { try await work() } catch { notice = error.localizedDescription }
        await load()
    }
}

// MARK: - Start

/// The start sheet's state: 2 to 4 options, a worst-case estimate and the suggestion. The Gateway refuses the rest
/// (an incognito chat, a running reply, another running fork) in its own words, shown as the sheet's banner.
@MainActor @Observable
final class PlanForkStartModel {
    struct Draft: Identifiable, Equatable {
        let id = UUID()
        var label = ""
        var premise = ""
    }

    let threadID: String
    let messageID: String
    private(set) var drafts: [Draft] = [Draft(), Draft()]
    private(set) var estimate: PlanForkEstimate?
    private(set) var suggesting = false
    private(set) var starting = false
    private(set) var error: String?
    /// Fields the owner has edited: an error shows only after that, never on an untouched form.
    private(set) var edited: Set<UUID> = []
    private let store: any PlanForkBackend

    init(threadID: String, messageID: String, store: any PlanForkBackend) {
        self.threadID = threadID
        self.messageID = messageID
        self.store = store
    }

    /// The options as they would be sent: trimmed, and only the ones with both a name and an assumption.
    var options: [PlanForkOption] {
        drafts.compactMap { draft in
            let label = Self.clean(draft.label, limit: PlanForkOption.labelLimit)
            let premise = Self.clean(draft.premise, limit: PlanForkOption.premiseLimit)
            return label.isEmpty || premise.isEmpty ? nil : PlanForkOption(label: label, premise: premise)
        }
    }

    var canStart: Bool { !starting && options.count >= PlanForkOption.minOptions }
    var canAdd: Bool { drafts.count < PlanForkOption.maxOptions }
    func canRemove(_: Draft) -> Bool { drafts.count > PlanForkOption.minOptions }

    /// A half-filled option, shown as needing the other field only once it was edited.
    func isIncomplete(_ draft: Draft) -> Bool {
        edited.contains(draft.id) && (draft.label.trimmed.isEmpty != draft.premise.trimmed.isEmpty)
    }

    static func clean(_ text: String, limit: Int) -> String {
        String(text.trimmed.prefix(limit))
    }

    func edit(_ id: UUID, label: String? = nil, premise: String? = nil) {
        guard let index = drafts.firstIndex(where: { $0.id == id }) else { return }
        if let label { drafts[index].label = String(label.prefix(PlanForkOption.labelLimit)) }
        if let premise { drafts[index].premise = String(premise.prefix(PlanForkOption.premiseLimit)) }
        edited.insert(id)
    }

    func add() {
        if canAdd { drafts.append(Draft()) }
    }

    func remove(_ id: UUID) {
        if drafts.count > PlanForkOption.minOptions { drafts.removeAll { $0.id == id } }
    }

    /// Fills the sheet with the Gateway's two suggestions, unless the owner already typed something.
    func suggest() async {
        guard drafts.allSatisfy({ $0.label.isEmpty && $0.premise.isEmpty }) else { return }
        suggesting = true
        defer { suggesting = false }
        guard let options = try? await store.suggestPlanForkOptions(threadID: threadID, messageID: messageID),
              options.count >= PlanForkOption.minOptions,
              drafts.allSatisfy({ $0.label.isEmpty && $0.premise.isEmpty })
        else { return }
        drafts = options.prefix(PlanForkOption.maxOptions).map { Draft(label: $0.label, premise: $0.premise) }
    }

    func refreshEstimate() async {
        let options = options
        guard options.count >= PlanForkOption.minOptions else {
            estimate = nil
            return
        }
        estimate = try? await store.estimatePlanFork(threadID: threadID, options: options)
    }

    /// The fork, or nil with `error` set in the Gateway's words.
    func start() async -> PlanForkDetail? {
        guard canStart else { return nil }
        starting = true
        defer { starting = false }
        error = nil
        do {
            return try await store.createPlanFork(threadID: threadID, messageID: messageID, options: options)
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }
}

extension String {
    fileprivate var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

// MARK: - Take

/// The Take sheet: the branch's prepared items to tick, then one tap. Which items can be ticked, and that a send never
/// rides along with Select all, are `NightShiftSelection`'s rules (the same prepared items, the same approval). What
/// goes out is what is ticked and shown; the backend refuses to answer anything else.
@MainActor @Observable
final class PlanForkTakeModel {
    enum Banner: Equatable {
        /// The approval did not bind what was ticked. Nothing was answered.
        case mismatch
        /// The approval can't be answered on the phone: it waits on the Mac.
        case needsMac
        /// The answer did not come back approved. Nothing was applied.
        case declined
        /// Some ticked items were left out by the Gateway.
        case refused(Int)
        case failure(String)
    }

    let forkID: String
    let branchID: String
    private(set) var items: LoadPhase<[NightShiftItem]> = .idle
    private(set) var selection = NightShiftSelection()
    private(set) var banner: Banner?
    private(set) var busy = false
    /// The plan was taken (or its approval answered): the sheet closes.
    private(set) var finished = false
    /// "Psyche starts on the remaining steps, asking before each action": on unless the owner turns it off (§14 Q3).
    var continuePlan = true
    private let store: any PlanForkBackend

    init(forkID: String, branchID: String, store: any PlanForkBackend) {
        self.forkID = forkID
        self.branchID = branchID
        self.store = store
    }

    var loadedItems: [NightShiftItem] { items.value ?? [] }

    func load() async {
        items = .loading
        do {
            let list = try await store.planForkStagedItems(forkID: forkID, branchID: branchID)
            items = .loaded(list)
            selection.reconcile(with: list)
        } catch {
            items = .failed(error.localizedDescription)
        }
    }

    func toggle(_ item: NightShiftItem) { selection.toggle(item) }
    func toggleSend(_ item: NightShiftItem) { selection.toggleSend(item) }
    func expand(_ item: NightShiftItem) { selection.expand(item) }

    /// What a tap would send now, with each hash taken from the item as it is shown.
    var request: PlanForkTakeRequest {
        let ticked = selection.request(reviewID: forkID, items: loadedItems)
        return PlanForkTakeRequest(
            forkID: forkID, branchID: branchID, items: ticked.items, sends: ticked.sends, continuePlan: continuePlan)
    }

    func take() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        banner = nil
        let request = request
        do {
            switch try await store.takePlanFork(request) {
            case .taken:
                finished = true
            case .answered(let refused):
                selection.markRefused(refused)
                if refused.isEmpty { finished = true } else { banner = .refused(refused.count) }
            case .needsMac(let refused):
                selection.markRefused(refused)
                banner = .needsMac
            case .declined:
                banner = .declined
            case .nothingApproved(let refused):
                selection.markRefused(refused)
                banner = .failure(refused.first?.reason ?? "")
            }
        } catch PlanForkError.mismatch {
            banner = .mismatch
        } catch {
            banner = .failure(error.localizedDescription)
        }
        if !finished { await load() }
    }
}
