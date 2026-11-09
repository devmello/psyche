import Foundation

/// Which chat replies are running right now, and for how long. Pure logic: the app feeds it chat events (and the
/// thread list as a safety net) and acts on what it reports; nothing here touches ActivityKit.
///
/// The Gateway announces a reply with `run.updated` (a chat run starts, waits, ends) and streams it with
/// `chat.delta` and tool-call blocks. A fixture backend sends `.status` instead. Both are understood, so a reply
/// is noticed whichever the source says first. A task's own run (`kind: task`) is not a chat reply and is ignored:
/// the task has its own Live Activity.
public struct ChatTurnTracker: Sendable {
    /// A reply this long earns a Live Activity; a shorter one is over before the owner could look away.
    public static let longRunning: TimeInterval = 20
    /// The thread list may say "idle" only this long after the last word on a reply (events can arrive after a
    /// list fetch that was already in flight).
    public static let settleDelay: TimeInterval = 5

    public enum Latest: Equatable, Sendable {
        case thinking
        case writing
        /// A tool's one-line summary, or the Gateway's own status text.
        case text(String)
    }

    public struct Turn: Equatable, Sendable {
        public var threadID: String
        public var startedAt: Date
        public var latest: Latest
        public var waiting: Bool
        /// The Gateway (or fixture) said the reply started, as opposed to this tracker inferring it from text
        /// that was already streaming. Only an inferred reply ends when its text does.
        var announced: Bool
        var lastEventAt: Date
    }

    public enum Outcome: Equatable, Sendable { case done, failed, cancelled }

    public enum Change: Equatable, Sendable {
        case started(Turn)
        case updated(Turn)
        case ended(Turn, Outcome, at: Date)
    }

    public private(set) var turns: [String: Turn] = [:]

    public init() {}

    /// The longest status text kept: it has to fit one line of an island.
    static let maxStatusLength = 80

    // MARK: Events

    public mutating func apply(_ event: ChatEvent, now: Date) -> [Change] {
        switch event {
        case .run(let threadID, let run):
            guard run.isChat else { return [] }
            switch run.state {
            case .running: return begin(threadID, startedAt: run.startedAt, announced: true, waiting: false, now: now)
            case .waiting: return begin(threadID, startedAt: run.startedAt, announced: true, waiting: true, now: now)
            case .done: return end(threadID, .done, now: now)
            case .failed: return end(threadID, .failed, now: now)
            case .cancelled: return end(threadID, .cancelled, now: now)
            }
        case .status(let threadID, let status, let kind):
            switch kind {
            case .running:
                let latest: Latest = status.isEmpty || status == "Thinking" ? .thinking : .text(Self.short(status))
                return begin(threadID, latest: latest, announced: true, waiting: false, now: now)
            case .needsYou:
                return begin(threadID, announced: true, waiting: true, now: now)
            case .neutral:
                return end(threadID, .done, now: now)
            }
        case .item(let threadID, let item):
            switch item {
            case .assistant(_, _, true):
                return begin(threadID, latest: .writing, announced: false, waiting: false, now: now)
            case .toolCall(_, _, let summary), .toolRun(_, _, let summary, _, _):
                return begin(threadID, latest: .text(Self.short(summary)), announced: false, waiting: false, now: now)
            default:
                return touch(threadID, now: now)
            }
        case .delta(let threadID, _, _):
            return begin(threadID, latest: .writing, announced: false, waiting: false, now: now)
        case .done(let threadID, _):
            // The text finished. A reply the Gateway announced goes on until the Gateway says otherwise (a tool
            // call can follow); one inferred from text alone is over.
            guard let turn = turns[threadID], !turn.announced else { return touch(threadID, now: now) }
            return end(threadID, .done, now: now)
        }
    }

    /// The thread list, read after `threads` changed or the app opened. It only keeps what the events started
    /// honest: it ends a reply the events never closed and marks one that waits for the owner. It never starts a
    /// reply: a list row says "running" for a task's run as well as for a chat reply, and only the run's own
    /// event says which it is.
    public mutating func reconcile(_ summaries: [ChatThreadSummary], now: Date) -> [Change] {
        var changes: [Change] = []
        for summary in summaries {
            guard let turn = turns[summary.id] else { continue }
            switch summary.statusKind {
            case .running:
                if turn.waiting { changes += begin(summary.id, announced: true, waiting: false, now: now) }
            case .needsYou:
                changes += begin(summary.id, announced: true, waiting: true, now: now)
            case .neutral:
                if now.timeIntervalSince(turn.lastEventAt) >= Self.settleDelay { changes += end(summary.id, .done, now: now) }
            }
        }
        // A thread that left the list (archived) cannot be running any more.
        let known = Set(summaries.map(\.id))
        for id in turns.keys where !known.contains(id) { changes += end(id, .cancelled, now: now) }
        return changes
    }

    /// The phone's own send failed before the Gateway took it.
    public mutating func sendFailed(threadID: String, now: Date) -> [Change] {
        end(threadID, .failed, now: now)
    }

    // MARK: Internals

    private mutating func begin(
        _ id: String, startedAt: Date? = nil, latest: Latest? = nil, announced: Bool, waiting: Bool, now: Date
    ) -> [Change] {
        if var turn = turns[id] {
            let before = turn
            if let latest { turn.latest = latest }
            turn.waiting = waiting
            turn.announced = turn.announced || announced
            // The Gateway's start time is better than ours, if it is plausible (not in the future, not hours old).
            if let startedAt, turn.startedAt > startedAt, now.timeIntervalSince(startedAt) < 6 * 3600 { turn.startedAt = startedAt }
            let changed = turn != before  // lastEventAt is bookkeeping, not a change
            turn.lastEventAt = now
            turns[id] = turn
            return changed ? [.updated(turn)] : []
        }
        var start = now
        if let startedAt, startedAt <= now, now.timeIntervalSince(startedAt) < 6 * 3600 { start = startedAt }
        let turn = Turn(
            threadID: id, startedAt: start, latest: latest ?? .thinking, waiting: waiting, announced: announced,
            lastEventAt: now)
        turns[id] = turn
        return [.started(turn)]
    }

    private mutating func touch(_ id: String, now: Date) -> [Change] {
        turns[id]?.lastEventAt = now
        return []
    }

    private mutating func end(_ id: String, _ outcome: Outcome, now: Date) -> [Change] {
        guard let turn = turns.removeValue(forKey: id) else { return [] }
        return [.ended(turn, outcome, at: now)]
    }

    static func short(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.count > maxStatusLength ? String(trimmed.prefix(maxStatusLength - 1)) + "…" : trimmed
    }
}
