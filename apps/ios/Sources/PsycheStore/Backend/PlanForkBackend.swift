import Foundation

// Fork a plan (docs/design/fork-a-plan-2026.md §5.2, §7.2): the owner splits a chat into 2 to 4 options, Psyche works each
// out read-only on the Mac, and the phone shows the lanes and the comparison. Taking a plan is one plain-tap
// `staged_apply` approval, answered only after the approval's item hashes were checked against what was ticked.
// Gateway methods: planForks.suggest/estimate/create/get/staged/cancel/dismiss/take, approvals.answer; event planFork.updated.
//
// What the phone gets is already scrubbed by the Gateway (§4.4): an item that cites Memory, Messages or Contacts never
// arrives, and a branch that read them has no model-written text. The models here carry that as counts and flags, so
// the screens say "1 more on your Mac" instead of showing a gap. Every string is the model's and may echo another
// person's words: it is drawn as plain text.

public protocol PlanForkBackend: Sendable {
    /// Two suggested options for the start sheet (`planForks.suggest`). Empty when suggestions are off. Stores nothing.
    func suggestPlanForkOptions(threadID: String, messageID: String) async throws -> [PlanForkOption]
    /// The worst-case cost of forking this chat into these options (`planForks.estimate`).
    func estimatePlanFork(threadID: String, options: [PlanForkOption]) async throws -> PlanForkEstimate
    /// Starts the fork at one message (`planForks.create`). The Gateway refuses it in an incognito chat, while the chat
    /// runs, and while another fork of the chat runs; the refusal is thrown in its words.
    func createPlanFork(threadID: String, messageID: String, options: [PlanForkOption]) async throws -> PlanForkDetail
    /// One fork with its branches and comparison, scrubbed for this phone (`planForks.get`).
    func planFork(id: String) async throws -> PlanForkDetail
    /// The prepared items of one branch, for the Take sheet (`planForks.staged`). The same shape as a Night shift item.
    func planForkStagedItems(forkID: String, branchID: String) async throws -> [NightShiftItem]
    /// Stops one branch, or all of them when `branchID` is nil (`planForks.cancel`). Filed reports are kept.
    func cancelPlanFork(forkID: String, branchID: String?) async throws
    /// Ends a ready fork and dismisses its prepared items (`planForks.dismiss`). Runs nothing.
    func dismissPlanFork(forkID: String) async throws
    /// Takes one branch's plan. With ticked items it requests the one approval, checks that it binds exactly what was
    /// ticked (`PlanForkError.mismatch` when not, with nothing answered), and answers it with this phone's token.
    func takePlanFork(_ request: PlanForkTakeRequest) async throws -> PlanForkTakeOutcome
    /// Starts the turn of an already taken plan whose chat was busy (`planForks.take` with nothing ticked).
    func continuePlanFork(forkID: String, branchID: String) async throws
}

// MARK: - Options and estimate

public struct PlanForkOption: Sendable, Equatable, Identifiable {
    public var id: String { label + "\u{1F}" + premise }
    /// A short name ("Move to Austin"), at most 40 characters.
    public var label: String
    /// What to assume ("Assume we move by June"), at most 280 characters.
    public var premise: String

    public init(label: String, premise: String) {
        self.label = label
        self.premise = premise
    }

    public static let labelLimit = 40
    public static let premiseLimit = 280
    public static let minOptions = 2
    public static let maxOptions = 4
}

public struct PlanForkEstimate: Sendable, Equatable {
    /// Worst case in dollars; nil for a model with no price ("Up to about 300k tokens").
    public var maxUsd: Double?
    public var maxTokens: Int
    public var budgetUsd: Double

    public init(maxUsd: Double?, maxTokens: Int, budgetUsd: Double) {
        self.maxUsd = maxUsd
        self.maxTokens = maxTokens
        self.budgetUsd = budgetUsd
    }
}

// MARK: - States

public enum PlanForkStatus: String, Sendable, Equatable {
    case running, comparing, ready, taken, dismissed, expired, cancelled, failed

    /// An unknown state reads as failed: shown, never actionable.
    public init(wire: String?) { self = wire.flatMap(Self.init(rawValue:)) ?? .failed }

    public var isLive: Bool { self == .running || self == .comparing }
}

public enum PlanForkBranchStatus: String, Sendable, Equatable {
    case queued, running, reported, failed, cancelled
    case budgetStopped = "budget_stopped"

    public init(wire: String?) { self = wire.flatMap(Self.init(rawValue:)) ?? .failed }

    public var isLive: Bool { self == .queued || self == .running }
}

/// The fork's `error` while a taken plan waits for its chat to finish replying (§3.4): Continue is offered.
public let planForkContinuePending = "continue_pending"

// MARK: - A branch's report

/// The source a cite came from. Memory, Messages and Contacts are the owner-only ones (§4.4): the phone never receives
/// an item citing them, so these appear on the Mac only; the rest label where a figure came from.
public enum PlanForkSource: String, Sendable, Equatable, CaseIterable {
    case memory, mail, calendar, contacts, messages, web, files
}

public struct PlanForkStep: Sendable, Equatable, Identifiable {
    public enum Who: String, Sendable, Equatable { case psyche, you }
    public var id: String
    public var text: String
    public var who: Who
    /// An ISO date or date-time the step is for.
    public var when: String?
    /// The step is a prepared (staged) item of this branch.
    public var prepared: Bool

    public init(id: String, text: String, who: Who, when: String? = nil, prepared: Bool = false) {
        self.id = id
        self.text = text
        self.who = who
        self.when = when
        self.prepared = prepared
    }
}

public struct PlanForkCost: Sendable, Equatable, Identifiable {
    public enum Period: String, Sendable, Equatable, CaseIterable { case once, month, year }
    public var id: String
    public var label: String
    public var amount: Double
    /// ISO 4217. Never converted.
    public var currency: String
    public var period: Period
    /// Psyche's own estimate, not a figure a source contains.
    public var estimate: Bool
    public var basis: String?
    public var sources: [PlanForkSource]
    /// Every cite was dropped by the Gateway's check: shown as "No source".
    public var unsourced: Bool

    public init(
        id: String, label: String, amount: Double, currency: String, period: Period = .once, estimate: Bool = false,
        basis: String? = nil, sources: [PlanForkSource] = [], unsourced: Bool = false
    ) {
        self.id = id
        self.label = label
        self.amount = amount
        self.currency = currency
        self.period = period
        self.estimate = estimate
        self.basis = basis
        self.sources = sources
        self.unsourced = unsourced
    }
}

public struct PlanForkDate: Sendable, Equatable, Identifiable {
    public enum Kind: String, Sendable, Equatable { case deadline, event, milestone }
    public var id: String
    public var label: String
    /// `YYYY-MM-DD` or an ISO date-time.
    public var date: String
    public var kind: Kind
    public var estimate: Bool
    public var sources: [PlanForkSource]
    public var unsourced: Bool

    public init(
        id: String, label: String, date: String, kind: Kind = .event, estimate: Bool = false, sources: [PlanForkSource] = [],
        unsourced: Bool = false
    ) {
        self.id = id
        self.label = label
        self.date = date
        self.kind = kind
        self.estimate = estimate
        self.sources = sources
        self.unsourced = unsourced
    }
}

public struct PlanForkPerson: Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var effect: String
    public var sources: [PlanForkSource]
    public var unsourced: Bool

    public init(id: String, name: String, effect: String, sources: [PlanForkSource] = [], unsourced: Bool = false) {
        self.id = id
        self.name = name
        self.effect = effect
        self.sources = sources
        self.unsourced = unsourced
    }
}

public struct PlanForkTradeoff: Sendable, Equatable, Identifiable {
    public var id: String
    public var gain: String?
    public var giveUp: String
    public var sources: [PlanForkSource]
    public var unsourced: Bool

    public init(id: String, gain: String? = nil, giveUp: String, sources: [PlanForkSource] = [], unsourced: Bool = false) {
        self.id = id
        self.gain = gain
        self.giveUp = giveUp
        self.sources = sources
        self.unsourced = unsourced
    }
}

public struct PlanForkRisk: Sendable, Equatable, Identifiable {
    public enum Likelihood: String, Sendable, Equatable { case low, medium, high }
    public var id: String
    public var text: String
    public var likelihood: Likelihood
    public var sources: [PlanForkSource]
    public var unsourced: Bool

    public init(id: String, text: String, likelihood: Likelihood = .medium, sources: [PlanForkSource] = [], unsourced: Bool = false) {
        self.id = id
        self.text = text
        self.likelihood = likelihood
        self.sources = sources
        self.unsourced = unsourced
    }
}

public struct PlanForkQuestion: Sendable, Equatable, Identifiable {
    public var id: String
    public var text: String

    public init(id: String, text: String) {
        self.id = id
        self.text = text
    }
}

public struct PlanForkReport: Sendable, Equatable {
    public var summary: String
    public var steps: [PlanForkStep]
    public var costs: [PlanForkCost]
    public var dates: [PlanForkDate]
    public var people: [PlanForkPerson]
    public var tradeoffs: [PlanForkTradeoff]
    public var risks: [PlanForkRisk]
    public var questions: [PlanForkQuestion]

    public init(
        summary: String = "", steps: [PlanForkStep] = [], costs: [PlanForkCost] = [], dates: [PlanForkDate] = [],
        people: [PlanForkPerson] = [], tradeoffs: [PlanForkTradeoff] = [], risks: [PlanForkRisk] = [],
        questions: [PlanForkQuestion] = []
    ) {
        self.summary = summary
        self.steps = steps
        self.costs = costs
        self.dates = dates
        self.people = people
        self.tradeoffs = tradeoffs
        self.risks = risks
        self.questions = questions
    }

    /// Totals per currency and period, summed here from the report's own items (§4.3: the model never writes a number).
    /// Currencies are never converted.
    public var totals: [PlanForkTotal] {
        var by: [String: PlanForkTotal] = [:]
        for cost in costs {
            let key = "\(cost.currency)|\(cost.period.rawValue)"
            if var current = by[key] {
                current.amount += cost.amount
                current.includesEstimate = current.includesEstimate || cost.estimate
                by[key] = current
            } else {
                by[key] = PlanForkTotal(
                    currency: cost.currency, period: cost.period, amount: cost.amount, includesEstimate: cost.estimate)
            }
        }
        return by.values.sorted {
            $0.currency == $1.currency
                ? PlanForkCost.Period.allCases.firstIndex(of: $0.period)! < PlanForkCost.Period.allCases.firstIndex(of: $1.period)!
                : $0.currency < $1.currency
        }
    }

    /// The earliest deadline (dates compare as ISO text), or nil.
    public var earliestDeadline: PlanForkDate? {
        dates.filter { $0.kind == .deadline }.min { $0.date < $1.date }
    }
}

public struct PlanForkTotal: Sendable, Equatable {
    public var currency: String
    public var period: PlanForkCost.Period
    public var amount: Double
    public var includesEstimate: Bool

    public init(currency: String, period: PlanForkCost.Period, amount: Double, includesEstimate: Bool) {
        self.currency = currency
        self.period = period
        self.amount = amount
        self.includesEstimate = includesEstimate
    }
}

/// What the Gateway withheld from this phone (§4.4). All zero and false for the desktop app.
public struct PlanForkScrub: Sendable, Equatable {
    /// Items withheld whole: "1 more on your Mac".
    public var hiddenItems: Int
    /// The summary, headline, notes and "Better if" are replaced: "Open on your Mac to read this".
    public var textHidden: Bool
    /// A total that includes a withheld item: "Total on your Mac".
    public var totalsHidden: Bool

    public init(hiddenItems: Int = 0, textHidden: Bool = false, totalsHidden: Bool = false) {
        self.hiddenItems = hiddenItems
        self.textHidden = textHidden
        self.totalsHidden = totalsHidden
    }

    public static let none = PlanForkScrub()
    public var isScrubbed: Bool { hiddenItems > 0 || textHidden || totalsHidden }
}

// MARK: - Branches, the comparison, the fork

public struct PlanForkBranch: Sendable, Equatable, Identifiable {
    public var id: String
    public var ord: Int
    public var label: String
    public var premise: String
    public var status: PlanForkBranchStatus
    public var error: String?
    /// The checked report, scrubbed for this phone. Nil before one is filed.
    public var report: PlanForkReport?
    public var scrub: PlanForkScrub
    /// The branch read Memory, Messages or Contacts: it can't be taken from here.
    public var readOwnerOnly: Bool

    public init(
        id: String, ord: Int, label: String, premise: String, status: PlanForkBranchStatus, error: String? = nil,
        report: PlanForkReport? = nil, scrub: PlanForkScrub = .none, readOwnerOnly: Bool = false
    ) {
        self.id = id
        self.ord = ord
        self.label = label
        self.premise = premise
        self.status = status
        self.error = error
        self.report = report
        self.scrub = scrub
        self.readOwnerOnly = readOwnerOnly
    }
}

public enum PlanComparisonDimension: String, Sendable, Equatable, CaseIterable {
    case cost, dates, people, tradeoffs, risks, open
}

public struct PlanComparisonCell: Sendable, Equatable {
    public var branchID: String
    public var itemIDs: [String]
    public var note: String?

    public init(branchID: String, itemIDs: [String], note: String? = nil) {
        self.branchID = branchID
        self.itemIDs = itemIDs
        self.note = note
    }
}

public struct PlanComparisonRow: Sendable, Equatable {
    public var dimension: PlanComparisonDimension
    /// The model's label; empty when the text was withheld from this phone.
    public var label: String
    public var cells: [PlanComparisonCell]
    public var differs: Bool

    public init(dimension: PlanComparisonDimension, label: String, cells: [PlanComparisonCell], differs: Bool) {
        self.dimension = dimension
        self.label = label
        self.cells = cells
        self.differs = differs
    }
}

public struct PlanComparison: Sendable, Equatable {
    public var headline: String
    public var rows: [PlanComparisonRow]
    /// "Better if you want…" per branch, never a recommendation. Empty text is withheld text.
    public var betterIf: [String: String]

    public init(headline: String, rows: [PlanComparisonRow], betterIf: [String: String] = [:]) {
        self.headline = headline
        self.rows = rows
        self.betterIf = betterIf
    }
}

public struct PlanForkInfo: Sendable, Equatable, Identifiable {
    public var id: String
    public var threadID: String
    public var status: PlanForkStatus
    public var error: String?
    public var budgetUsd: Double
    public var spentUsd: Double
    public var comparison: PlanComparison?
    public var takenBranchID: String?

    public init(
        id: String, threadID: String, status: PlanForkStatus, error: String? = nil, budgetUsd: Double = 1, spentUsd: Double = 0,
        comparison: PlanComparison? = nil, takenBranchID: String? = nil
    ) {
        self.id = id
        self.threadID = threadID
        self.status = status
        self.error = error
        self.budgetUsd = budgetUsd
        self.spentUsd = spentUsd
        self.comparison = comparison
        self.takenBranchID = takenBranchID
    }
}

public struct PlanForkDetail: Sendable, Equatable, Identifiable {
    public var fork: PlanForkInfo
    public var branches: [PlanForkBranch]

    public init(fork: PlanForkInfo, branches: [PlanForkBranch]) {
        self.fork = fork
        self.branches = branches.sorted { $0.ord < $1.ord }
    }

    public var id: String { fork.id }

    public func branch(_ id: String) -> PlanForkBranch? { branches.first { $0.id == id } }

    /// "Move to Austin vs Stay".
    public var labels: [String] { branches.map(\.label) }

    /// Counts across branches for the "N more on your Mac" line.
    public var hiddenItems: Int { branches.reduce(0) { $0 + $1.scrub.hiddenItems } }
    public var textHidden: Bool { branches.contains { $0.scrub.textHidden } }

    /// A plan whose chat was busy when it was taken: Continue starts its turn.
    public var continuePending: Bool {
        fork.status == .taken && fork.takenBranchID != nil && fork.error == planForkContinuePending
    }

    /// The branch can be taken at all: the fork is ready and the branch reported.
    public func isTakeable(_ branch: PlanForkBranch) -> Bool {
        fork.status == .ready && branch.status == .reported && branch.report != nil
    }

    /// The owner can take this branch from the phone. A branch that read the owner's Memory, Messages or Contacts is
    /// shown with its text and items withheld (§4.4), so what it would do can't be read here: it is taken on the Mac.
    public func canTake(_ branch: PlanForkBranch) -> Bool {
        isTakeable(branch) && !branch.readOwnerOnly
    }

    /// Takeable, but only on the Mac: the phone shows "Open on your Mac" instead of Take.
    public func needsMacToTake(_ branch: PlanForkBranch) -> Bool {
        isTakeable(branch) && branch.readOwnerOnly
    }
}

// MARK: - Take

public struct PlanForkTakeRequest: Sendable, Equatable {
    public var forkID: String
    public var branchID: String
    /// Every ticked prepared item, with the hash the owner saw.
    public var items: [NightShiftTick]
    /// Items whose "Send it too" box is ticked. Never more than the owner ticked.
    public var sends: [NightShiftTick]
    /// Start one turn with the remaining Psyche steps once the plan is taken.
    public var continuePlan: Bool

    public init(forkID: String, branchID: String, items: [NightShiftTick], sends: [NightShiftTick], continuePlan: Bool) {
        self.forkID = forkID
        self.branchID = branchID
        self.items = items
        self.sends = sends
        self.continuePlan = continuePlan
    }
}

public enum PlanForkTakeOutcome: Sendable, Equatable {
    /// Nothing was ticked: the plan is taken at once and no approval exists.
    case taken
    /// The approval was answered; the Gateway applies the ticked items and then takes the plan.
    case answered(refused: [NightShiftRefusal])
    /// The approval can't be answered from the phone (a payment, or details too large to read here): answer it on the Mac.
    /// Nothing was sent to `approvals.answer`.
    case needsMac(refused: [NightShiftRefusal])
    /// The answer did not come back approved (it expired or was withdrawn): nothing was applied and the plan still waits.
    case declined
    /// Every ticked item was refused: no approval was made and the plan is still waiting.
    case nothingApproved(refused: [NightShiftRefusal])
}

public enum PlanForkError: Error, Equatable {
    /// The approval does not bind exactly the items that were ticked. Nothing was answered.
    case mismatch
}
