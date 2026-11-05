import Foundation
import PsycheShared

// "Stay connected while a task runs": when Psyche keeps itself awake in the background (a silent, mixable audio
// session plus its one Gateway connection), and when it must stop. All of it is decided here as pure functions so
// every rule can be tested; `StayAwakeController` only carries the decision out.

public enum StayAwake {
    /// The longest one awake stretch lasts. After it the activity goes stale and the owner reopens Psyche.
    public static let hardCap: TimeInterval = 3 * 3600
    /// How long the Gateway may stay unreachable before the app stops holding itself awake for it.
    public static let unreachableLimit: TimeInterval = 10 * 60
    /// Unplugged and below this, the battery is more important than a running task.
    public static let lowBatteryLevel: Float = 0.20
    /// While awake, the ledger is saved at least this often so a kill loses little.
    public static let checkpoint: TimeInterval = 10 * 60

    public struct Inputs: Equatable, Sendable {
        /// Settings: "Stay connected while a task runs".
        public var switchOn: Bool
        /// Tasks with a Live Activity the owner started (the system's list: a swiped-away one is gone).
        public var watched: Int
        /// Of those, the ones still running or waiting on an approval.
        public var active: Int
        public var lowPowerMode: Bool
        /// 0...1, nil when unknown (the simulator reports -1).
        public var batteryLevel: Float?
        /// Plugged in (charging or full).
        public var pluggedIn: Bool
        /// When this awake stretch began; nil when not awake.
        public var awakeSince: Date?
        /// The cap ended a stretch and the same tasks are still running: do not start again for them.
        public var capLatched: Bool
        /// When the Gateway was last seen live and then was not; nil while it is reachable.
        public var unreachableSince: Date?
        public var now: Date

        public init(
            switchOn: Bool, watched: Int, active: Int, lowPowerMode: Bool = false, batteryLevel: Float? = nil,
            pluggedIn: Bool = false, awakeSince: Date? = nil, capLatched: Bool = false, unreachableSince: Date? = nil,
            now: Date
        ) {
            self.switchOn = switchOn
            self.watched = watched
            self.active = active
            self.lowPowerMode = lowPowerMode
            self.batteryLevel = batteryLevel
            self.pluggedIn = pluggedIn
            self.awakeSince = awakeSince
            self.capLatched = capLatched
            self.unreachableSince = unreachableSince
            self.now = now
        }
    }

    public enum StopReason: Equatable, Sendable {
        case switchOff
        /// No task has a Live Activity any more: the owner stopped watching (swiped it away or turned them off).
        case notWatching
        /// Everything watched has finished.
        case nothingRunning
        case lowPowerMode
        case lowBattery
        case hardCap
        case gatewayUnreachable

        /// The activity should be marked stale at once: what it shows can no longer be vouched for.
        public var makesActivityStaleNow: Bool { self == .hardCap || self == .gatewayUnreachable }
    }

    public enum Decision: Equatable, Sendable {
        case run
        case stop(StopReason)
        public var isRun: Bool { self == .run }
    }

    /// Whether to be awake right now. Used both to start and to keep going; the same rules apply to both.
    public static func decide(_ i: Inputs) -> Decision {
        if !i.switchOn { return .stop(.switchOff) }
        if i.lowPowerMode { return .stop(.lowPowerMode) }
        if let level = i.batteryLevel, level < lowBatteryLevel, !i.pluggedIn { return .stop(.lowBattery) }
        if i.watched == 0 { return .stop(.notWatching) }
        if i.active == 0 { return .stop(.nothingRunning) }
        if i.capLatched { return .stop(.hardCap) }
        if let since = i.awakeSince, i.now.timeIntervalSince(since) >= hardCap { return .stop(.hardCap) }
        if let down = i.unreachableSince, i.now.timeIntervalSince(down) >= unreachableLimit {
            return .stop(.gatewayUnreachable)
        }
        return .run
    }

    /// The next moment at which `decide` could change on its own while running (the cap, the unreachable limit)
    /// and the next ledger checkpoint. The controller sleeps until then: no polling.
    public static func nextWake(_ i: Inputs) -> Date? {
        guard let since = i.awakeSince else { return nil }
        var times = [since.addingTimeInterval(hardCap)]
        if let down = i.unreachableSince { times.append(down.addingTimeInterval(unreachableLimit)) }
        return times.min()
    }
}

/// Throttles Live Activity updates: one push only when the content actually changed, no more often than
/// `minInterval` (a change in status, such as a new approval or the end of the task, goes through at once), and
/// an unchanged activity is touched again only to move its stale date forward.
public struct ActivityUpdateGate: Sendable, Equatable {
    public enum Decision: Equatable, Sendable {
        case push
        /// Changed, but too soon after the last push: try again after this many seconds.
        case wait(TimeInterval)
        /// Nothing changed.
        case skip
        /// Nothing changed, but the stale date is about to pass and a live connection can vouch for the state.
        case refreshStale
    }

    public var minInterval: TimeInterval

    public init(minInterval: TimeInterval = 5) {
        self.minInterval = minInterval
    }

    public func decide(
        old: TaskActivityContent?, new: TaskActivityContent, lastPush: Date?, staleDate: Date?, awake: Bool, now: Date
    ) -> Decision {
        guard let old else { return .push }
        if old != new {
            if old.status != new.status { return .push }
            guard let lastPush else { return .push }
            let since = now.timeIntervalSince(lastPush)
            return since >= minInterval ? .push : .wait(minInterval - since)
        }
        if awake, let staleDate, now >= ActivityFreshness.refreshTime(forStaleDate: staleDate) { return .refreshStale }
        return .skip
    }
}

/// How long Psyche has kept itself awake, per local day, on this phone only ("Kept awake 42 min today").
/// A small JSON file in the app group's data directory; nil directory keeps it in memory (fixtures, tests).
public actor AwakeTimeLedger {
    private let fileURL: URL?
    private let calendar: Calendar
    private var seconds: [String: TimeInterval]
    private let keepDays = 14

    public init(directory: URL?, calendar: Calendar = .current) {
        fileURL = directory?.appendingPathComponent("awake-time.json")
        self.calendar = calendar
        if let fileURL, let data = try? Data(contentsOf: fileURL),
           let decoded = try? JSONDecoder().decode([String: TimeInterval].self, from: data) {
            seconds = decoded
        } else {
            seconds = [:]
        }
    }

    func key(_ date: Date) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Adds awake time to the day it ended on. A stretch that crosses midnight is split at midnight.
    public func record(from start: Date, to end: Date) {
        guard end > start else { return }
        var cursor = start
        while cursor < end {
            let nextMidnight = calendar.nextDate(
                after: cursor, matching: DateComponents(hour: 0, minute: 0, second: 0), matchingPolicy: .nextTime) ?? end
            let sliceEnd = min(end, nextMidnight)
            seconds[key(cursor), default: 0] += sliceEnd.timeIntervalSince(cursor)
            cursor = sliceEnd
        }
        prune(now: end)
        save()
    }

    public func seconds(on day: Date) -> TimeInterval { seconds[key(day)] ?? 0 }

    private func prune(now: Date) {
        guard seconds.count > keepDays else { return }
        let keep = Set((0..<keepDays).compactMap { calendar.date(byAdding: .day, value: -$0, to: now) }.map(key))
        seconds = seconds.filter { keep.contains($0.key) }
    }

    private func save() {
        guard let fileURL, let data = try? JSONEncoder().encode(seconds) else { return }
        try? AppGroup.prepareDirectory(fileURL.deletingLastPathComponent())
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
