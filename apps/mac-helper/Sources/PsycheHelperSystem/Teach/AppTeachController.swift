import Foundation
import PsycheHelperCore
import PsycheProtocol

/// Teach by showing in a Mac app (J8 phase 2): the live part is a `AppTeachSource`; everything
/// that decides what is recorded is `AppTeachMapper` / `AppTeachPolicy` in PsycheHelperCore.
public protocol AppTeachSource: AnyObject, Sendable {
    /// Starts watching `bundleId`'s app. `bind` gets the process id before anything is observed, so
    /// the recording is bound to that process and not to a name; `onEnd` is called if the app quits
    /// (or its code-signing identity changes). False without Accessibility, when the app is not
    /// running, or when the mouse tap for that process cannot be made.
    func start(
        bundleId: String, bind: @escaping @Sendable (Int32) -> Void, onEvent: @escaping @Sendable (AppTeachEvent, Date) -> Void,
        onEnd: @escaping @Sendable () -> Void
    ) -> Bool
    func stop()
}

/// The always-visible sign that a recording is running, with a Stop that works without the app.
public protocol AppTeachIndicator: AnyObject, Sendable {
    func show(appName: String, onStop: @escaping @Sendable () -> Void)
    func hide()
}

/// One app recording at a time. The helper holds the steps in memory only; the owner's review
/// screen is where they go next, and `stop` hands them over once.
public final class AppTeachController: @unchecked Sendable {
    public enum End: String, Sendable { case stop, timeout, limit, cancel, interrupted }

    public static let defaultMaxSeconds = 900
    /// An ended recording nobody collected is forgotten after this long.
    public static let defaultUnclaimedSeconds: TimeInterval = 30 * 60

    struct Active {
        let id: String
        let mapper: AppTeachMapper
        let startedAt: Date
        let source: any AppTeachSource
        var ended: End?
        var endedAt: Date?
    }

    private let lock = NSLock()
    private var current: Active?
    private let makeSource: @Sendable () -> any AppTeachSource
    private let indicator: any AppTeachIndicator
    private let settings: @Sendable () -> TierSettings
    private let appName: @Sendable (String) -> String?
    private let now: @Sendable () -> Date
    private let maxSeconds: Int
    private let unclaimedSeconds: TimeInterval
    let log: HelperLog

    public init(
        makeSource: @escaping @Sendable () -> any AppTeachSource, indicator: any AppTeachIndicator,
        settings: @escaping @Sendable () -> TierSettings, appName: @escaping @Sendable (String) -> String?,
        now: @escaping @Sendable () -> Date = { Date() }, maxSeconds: Int = AppTeachController.defaultMaxSeconds,
        unclaimedSeconds: TimeInterval = AppTeachController.defaultUnclaimedSeconds, log: HelperLog = HelperLog()
    ) {
        self.unclaimedSeconds = unclaimedSeconds
        self.makeSource = makeSource
        self.indicator = indicator
        self.settings = settings
        self.appName = appName
        self.now = now
        self.maxSeconds = maxSeconds
        self.log = log
    }

    /// For tests: the id of the recording in progress or ended, started or not.
    var currentIdForTests: String? { lock.withLock { current?.id } }

    public var activeId: String? { lock.withLock { current?.ended == nil ? current?.id : nil } }

    /// Starts recording `bundleId`. Refuses an app the owner has not granted, Psyche, security
    /// prompts, password managers, and every app that cannot be driven (browsers, terminals, banking).
    public func begin(bundleId: String) throws -> (id: String, app: AppTeachStep.App) {
        guard bundleId.count <= 200, !bundleId.isEmpty else { throw CapabilityError.invalidParams("bundleId is required", field: "bundleId") }
        if let why = AppTeachPolicy.refusal(bundleId: bundleId, settings: settings()) {
            log.info("teach app refused app=\(bundleId) why=\(why.rawValue)")
            throw CapabilityError(.policyDenied, reason: why.rawValue, why.message, details: ["app": .string(bundleId)])
        }
        guard let name = appName(bundleId) else {
            throw CapabilityError(.unavailable, reason: "app_not_running", "Open the app first, then record in it", retryable: true)
        }
        let id = "app-teach-\(UUID().uuidString.lowercased().prefix(12))"
        let mapper = AppTeachMapper(bundleId: bundleId, appName: name)
        let source = makeSource()
        try lock.withLock {
            if let c = current {
                // An ended recording nobody collected makes way for a new one.
                guard c.ended != nil else { throw CapabilityError(.conflict, reason: "teach_busy", "A recording is already running") }
                current = nil
            }
            current = Active(id: id, mapper: mapper, startedAt: now(), source: source)
        }
        let started = source.start(
            bundleId: bundleId,
            bind: { pid in mapper.bind(pid: pid) },
            onEvent: { [weak self] event, at in self?.input(id, event, at) },
            onEnd: { [weak self] in _ = self?.end(id, .interrupted) }
        )
        guard started else {
            lock.withLock { if current?.id == id { current = nil } }
            throw CapabilityError.permissionMissing(.accessibility)
        }
        // A Stop or Cancel that arrived while the source was starting won: tear the source down
        // again instead of leaving it recording with nothing to show for it.
        let stillWanted = lock.withLock { current?.id == id && current?.ended == nil }
        guard stillWanted else {
            source.stop()
            indicator.hide()
            lock.withLock { if current?.id == id { current = nil } }
            throw CapabilityError(.conflict, reason: "teach_cancelled", "The recording was stopped while it was starting")
        }
        indicator.show(appName: mapper.app.name, onStop: { [weak self] in _ = self?.end(id, .stop) })
        let seconds = TimeInterval(maxSeconds)
        _Concurrency.Task { [weak self] in
            try? await _Concurrency.Task.sleep(nanoseconds: UInt64(seconds * 1e9))
            _ = self?.end(id, .timeout)
        }
        log.info("teach app started id=\(id) app=\(bundleId)")
        return (id, mapper.app)
    }

    func input(_ id: String, _ event: AppTeachEvent, _ at: Date) {
        guard let a = lock.withLock({ current?.id == id && current?.ended == nil ? current : nil }) else { return }
        a.mapper.handle(event, at: at)
        if a.mapper.limitReached { _ = end(id, .limit) }
    }

    /// Stops watching and hides the indicator. The steps stay in memory until `collect` or `cancel`.
    @discardableResult
    public func end(_ id: String, _ how: End) -> Bool {
        let a: Active? = lock.withLock {
            guard var c = current, c.id == id, c.ended == nil else { return nil }
            c.ended = how
            c.endedAt = now()
            current = c
            return c
        }
        guard let a else { return false }
        a.source.stop()
        indicator.hide()
        log.info("teach app ended id=\(id) by=\(how.rawValue) steps=\(a.mapper.stepCount)")
        // Nobody collected it: forget it on a timer, not only when someone next asks.
        let wait = unclaimedSeconds
        _Concurrency.Task { [weak self] in
            try? await _Concurrency.Task.sleep(nanoseconds: UInt64(wait * 1e9))
            self?.forgetIfUnclaimed(id)
        }
        return true
    }

    func forgetIfUnclaimed(_ id: String) {
        lock.withLock {
            if let c = current, c.id == id, c.ended != nil { current = nil }
        }
    }

    /// Ends the recording if it still runs and returns what it caught, once.
    public func collect() throws -> JSONValue {
        lock.withLock {
            if let c = current, let at = c.endedAt, now().timeIntervalSince(at) > unclaimedSeconds { current = nil }
        }
        let id: String? = lock.withLock { current?.id }
        guard let id else { throw CapabilityError(.notFound, reason: "teach_not_found", "Nothing is being recorded") }
        end(id, .stop)
        let a: Active? = lock.withLock {
            defer { current = nil }
            return current
        }
        guard let a else { throw CapabilityError(.notFound, reason: "teach_not_found", "Nothing is being recorded") }
        let steps = a.mapper.finish()
        let encoded: [JSONValue] = steps.compactMap { try? JSONValue(encoding: $0) }
        return [
            "id": .string(a.id), "endedBy": .string((a.ended ?? .stop).rawValue),
            "app": ["bundleId": .string(a.mapper.app.bundleId), "name": .string(a.mapper.app.name)],
            "steps": .array(encoded), "skipped": .int(a.mapper.skipped),
        ]
    }

    /// Drops the recording and everything it caught.
    public func cancel() -> Bool {
        let a: Active? = lock.withLock {
            defer { current = nil }
            return current
        }
        guard let a else { return false }
        if a.ended == nil {
            a.source.stop()
            indicator.hide()
        }
        log.info("teach app cancelled id=\(a.id)")
        return true
    }

    public func status() -> JSONValue {
        lock.lock()
        defer { lock.unlock() }
        if let c = current, let at = c.endedAt, now().timeIntervalSince(at) > unclaimedSeconds { current = nil }
        guard let c = current else { return ["active": false] }
        var o: [String: JSONValue] = [
            "active": .bool(c.ended == nil), "sessionId": .string(c.id),
            "app": ["bundleId": .string(c.mapper.app.bundleId), "name": .string(c.mapper.app.name)],
            "steps": .int(c.mapper.stepCount), "startedAt": .string(AppleDates.string(c.startedAt)),
        ]
        if let e = c.ended { o["ended"] = .string(e.rawValue) }
        return .object(o)
    }
}

/// `teach.record.*`: the Mac half of "Record in an app". The Gateway offers it only to the
/// desktop shell on the Host (`teach.app.*`); `nodes.invoke` and agent tools can never reach it.
public enum AppTeachCapabilities {
    public static func make(_ teach: AppTeachController, computer: ComputerUse) -> [any CapabilityHandler] {
        struct StartParams: Decodable { var bundleId: String }
        return [
            Capability(CapabilitySpec(
                name: "teach.record.start",
                description: "Owner only. Watch one granted app's accessibility events (focus, value changes, presses, menu choices) and turn them into semantic steps. Secure fields, Psyche, security prompts and other apps are never recorded; no screenshots; a menu-bar indicator shows while it records.",
                sideEffect: .write, targetKind: .app,
                inputSchema: Schema.object(["bundleId": Schema.string("Bundle id of the granted app", maxLength: 200)], required: ["bundleId"]),
                permissions: [.accessibility], receiptKind: "teach"
            )) { ctx in
                let p = try ctx.decode(StartParams.self)
                guard computer.sessions.activeSession == nil else {
                    throw CapabilityError(.conflict, reason: "computer_busy", "The agent is using the computer; recording waits until it is done", retryable: true)
                }
                let started = try teach.begin(bundleId: p.bundleId)
                return CapabilityOutput(
                    ["sessionId": .string(started.id), "app": ["bundleId": .string(started.app.bundleId), "name": .string(started.app.name)]],
                    receipt: ReceiptDraft(outcome: .ok, summary: "Started recording in \(started.app.name)")
                )
            },
            Capability(CapabilitySpec(
                name: "teach.record.stop", description: "Owner only. Stop recording and hand over the steps, once.", sideEffect: .none
            )) { _ in
                let out = try teach.collect()
                let n = out["steps"]?.arrayValue?.count ?? 0
                return CapabilityOutput(out, receipt: ReceiptDraft(outcome: .ok, summary: "Recorded \(n) steps"))
            },
            Capability(CapabilitySpec(
                name: "teach.record.cancel", description: "Owner only. Stop recording and drop everything caught.", sideEffect: .none
            )) { _ in CapabilityOutput(["cancelled": .bool(teach.cancel())]) },
            Capability(CapabilitySpec(
                name: "teach.record.status", description: "Whether an app is being recorded, and how many steps so far.", sideEffect: .read
            )) { _ in CapabilityOutput(teach.status()) },
        ]
    }
}
