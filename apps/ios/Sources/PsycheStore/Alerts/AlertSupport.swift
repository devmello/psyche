import Foundation
import PsycheShared

// The small pieces under the live alerts: a throttle for Live Activity updates, a record of what has
// already been announced, and the builder for an activity's content state.

/// Coalesces bursts of "something changed" into at most one run per `interval` (about a second), with
/// the last request always honored. A pure state machine: the caller sleeps and runs.
public struct UpdateCoalescer: Sendable, Equatable {
    public enum Decision: Equatable, Sendable {
        /// Run now.
        case runNow
        /// Run once after this many seconds; further requests until then fold into that run.
        case runAfter(TimeInterval)
        /// A run is already scheduled.
        case alreadyScheduled
    }

    public var interval: TimeInterval
    private var lastRun: Date?
    private var scheduled = false

    public init(interval: TimeInterval = 1) {
        self.interval = interval
    }

    public mutating func request(at now: Date) -> Decision {
        if scheduled { return .alreadyScheduled }
        guard let lastRun, now.timeIntervalSince(lastRun) < interval else {
            self.lastRun = now
            return .runNow
        }
        scheduled = true
        return .runAfter(max(0, interval - now.timeIntervalSince(lastRun)))
    }

    /// The scheduled run is starting.
    public mutating func fire(at now: Date) {
        scheduled = false
        lastRun = now
    }
}

/// What has been announced already, so a restart, a reconnect or a background check never posts the same
/// approval twice. Lives in the app group's data directory.
public actor NotifiedLedger {
    private struct Stored: Codable {
        var announced: [String: Date] = [:]
        /// Tasks seen running at the last check, to notice when one finishes.
        var running: [String] = []
    }

    private let fileURL: URL?
    private var stored: Stored
    private let keepFor: TimeInterval
    private let cap: Int

    public init(directory: URL?, keepFor: TimeInterval = 14 * 86_400, cap: Int = 300) {
        fileURL = directory?.appendingPathComponent("announced.json")
        self.keepFor = keepFor
        self.cap = cap
        if let fileURL, let data = try? Data(contentsOf: fileURL),
           let decoded = try? JSONDecoder().decode(Stored.self, from: data) {
            stored = decoded
        } else {
            stored = Stored()
        }
    }

    /// True the first time an id is seen; remembers it. Call before posting.
    public func claim(_ id: String, at now: Date = .now) -> Bool {
        prune(now: now)
        guard stored.announced[id] == nil else { return false }
        stored.announced[id] = now
        save()
        return true
    }

    /// Marks ids as already known without announcing them (the baseline on the first foreground sync).
    public func markSeen(_ ids: [String], at now: Date = .now) {
        var changed = false
        for id in ids where stored.announced[id] == nil {
            stored.announced[id] = now
            changed = true
        }
        if changed { save() }
    }

    public func contains(_ id: String) -> Bool { stored.announced[id] != nil }

    public func knownRunning() -> [String] { stored.running }

    public func setRunning(_ ids: [String]) {
        guard ids != stored.running else { return }
        stored.running = ids
        save()
    }

    private func prune(now: Date) {
        stored.announced = stored.announced.filter { now.timeIntervalSince($0.value) < keepFor }
        if stored.announced.count > cap {
            let keep = stored.announced.sorted { $0.value > $1.value }.prefix(cap)
            stored.announced = Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })
        }
    }

    private func save() {
        guard let fileURL, let data = try? JSONEncoder().encode(stored) else { return }
        try? AppGroup.prepareDirectory(fileURL.deletingLastPathComponent())
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

extension TaskActivityContent {
    /// The content state for a task. The title is included only when the owner turned on
    /// "Task titles on the Lock Screen"; with it off nothing about the task but its progress leaves the app.
    /// `inlineApprovalID` is the waiting approval only when the island may answer it (a write approval with
    /// no presence gate; the caller decides with `AlertPolicy.answersInline`).
    /// The island-only fields (`islandTitle`, `detail`, `asking`) are always filled: the Dynamic Island
    /// shows only on an unlocked phone, and the activity never leaves it.
    public static func make(
        task: RunningTask, status: TaskActivityStatus, showTitle: Bool, now: Date = .now, fallbackStart: Date? = nil,
        asking: String? = nil, inlineApprovalID: String? = nil
    ) -> TaskActivityContent {
        let detail = task.detail.trimmingCharacters(in: .whitespacesAndNewlines)
        return TaskActivityContent(
            step: task.stepCount > 0 ? task.step : 0, stepCount: max(task.stepCount, 0), status: status,
            startedAt: task.startedAt ?? fallbackStart ?? now, endedAt: nil,
            title: showTitle ? task.title : nil, islandTitle: task.title,
            detail: detail.isEmpty ? nil : detail.prefix(1).uppercased() + detail.dropFirst(),
            asking: status == .needsApproval ? asking : nil,
            inlineApprovalID: status == .needsApproval ? inlineApprovalID : nil)
    }

    /// The same activity, finished: the timer stops and the title rule still applies.
    public func finished(failed: Bool, at now: Date = .now) -> TaskActivityContent {
        var copy = self
        copy.status = failed ? .failed : .done
        copy.endedAt = now
        copy.asking = nil
        copy.inlineApprovalID = nil
        copy.detail = failed ? "Open Psyche to see what went wrong" : nil
        if !failed, stepCount > 0 { copy.step = stepCount }
        return copy
    }

    /// Applies the title setting to an existing content state without refetching.
    public func titled(_ title: String?, show: Bool) -> TaskActivityContent {
        var copy = self
        copy.title = show ? title : nil
        return copy
    }
}
