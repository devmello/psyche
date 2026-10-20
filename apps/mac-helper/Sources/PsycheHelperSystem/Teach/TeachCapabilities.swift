import AppKit
import Carbon.HIToolbox
import Foundation
import PsycheHelperCore
import PsycheProtocol
import ScreenCaptureKit

/// Source of owner input for a teach session (live: `TeachRecorder`; tests: a fake AX stream).
public protocol TeachInputSource: AnyObject, Sendable {
    func start(_ onInput: @escaping @Sendable (TeachInput, Date) -> Void) -> Bool
    func stop()
}

public final class LiveTeachInput: TeachInputSource, @unchecked Sendable {
    private var recorder: TeachRecorder?
    public init() {}
    public func start(_ onInput: @escaping @Sendable (TeachInput, Date) -> Void) -> Bool {
        let r = TeachRecorder(onInput: onInput)
        guard r.start() else { return false }
        recorder = r
        return true
    }
    public func stop() { recorder?.stop() }
}

/// A window screenshot after a click: (bytes, mime type), or nil when not allowed or not possible.
public typealias TeachScreenshotter = @Sendable (_ app: String) async -> (Data, String)?

/// One teach session at a time (J8). The helper keeps the draft in memory only and hands it to
/// whoever started the session; nothing is written to disk.
public final class TeachController: @unchecked Sendable {
    public enum End: String, Sendable { case stop, timeout, limit, cancel }

    struct Active {
        let session: TeachSession
        let source: any TeachInputSource
        let screenshots: Bool
        let emit: @Sendable (JSONValue) async -> Void
        var waiters: [CheckedContinuation<JSONValue, Never>] = []
        var result: JSONValue?
    }

    private let lock = NSLock()
    private var active: Active?
    private var finished: [String: JSONValue] = [:]
    private let makeSource: @Sendable () -> any TeachInputSource
    private let screenshot: TeachScreenshotter
    private let now: @Sendable () -> Date
    let log: HelperLog

    public init(
        makeSource: @escaping @Sendable () -> any TeachInputSource = { LiveTeachInput() },
        screenshot: @escaping TeachScreenshotter = { _ in nil }, now: @escaping @Sendable () -> Date = { Date() }, log: HelperLog = HelperLog()
    ) {
        self.makeSource = makeSource
        self.screenshot = screenshot
        self.now = now
        self.log = log
    }

    public struct StartParams: Decodable, Sendable {
        public var name: String?
        public var description: String?
        public var app: String?
        public var screenshots: Bool?
        public var maxSteps: Int?
        public var maxSeconds: Int?
    }

    public var activeId: String? { lock.withLock { active?.session.id } }

    /// Starts recording and returns the session id; the draft comes from `wait`.
    public func begin(_ p: StartParams, emit: @escaping @Sendable (JSONValue) async -> Void) throws -> String {
        if let n = p.name, !TeachDraftRenderer.isValidName(n) {
            throw CapabilityError.invalidParams("name must be lowercase letters, digits and single hyphens", field: "name")
        }
        let id = "teach-\(UUID().uuidString.lowercased().prefix(12))"
        let session = TeachSession(id: id, name: p.name ?? "", description: p.description, appFilter: p.app,
                                   maxSteps: p.maxSteps ?? TeachSession.defaultMaxSteps, startedAt: now())
        let source = makeSource()
        try lock.withLock {
            guard active == nil else { throw CapabilityError(.conflict, reason: "teach_busy", "A teach session is already recording") }
            active = Active(session: session, source: source, screenshots: p.screenshots == true, emit: emit)
        }
        guard source.start({ [weak self] input, at in self?.input(id, input, at) }) else {
            lock.withLock { active = nil }
            throw CapabilityError.permissionMissing(.accessibility)
        }
        let seconds = TimeInterval(max(10, min(1800, p.maxSeconds ?? TeachSession.defaultMaxSeconds)))
        _Concurrency.Task { [weak self] in
            try? await _Concurrency.Task.sleep(nanoseconds: UInt64(seconds * 1e9))
            _ = self?.end(id, .timeout)
        }
        log.info("teach started id=\(id) screenshots=\(p.screenshots == true)")
        return id
    }

    /// Waits until the session ends; returns its draft.
    public func wait(_ id: String) async -> JSONValue {
        await withCheckedContinuation { (c: CheckedContinuation<JSONValue, Never>) in
            let ready: JSONValue? = lock.withLock {
                if let r = finished[id] { return r }
                guard active?.session.id == id else { return ["error": "no such session"] }
                active?.waiters.append(c)
                return nil
            }
            if let ready { c.resume(returning: ready) }
        }
    }

    /// Ends the session and returns the draft (also delivered to `wait`). Idempotent.
    @discardableResult
    public func end(_ id: String, _ how: End) -> JSONValue? {
        let ended: Active? = lock.withLock {
            guard let a = active, a.session.id == id else { return nil }
            active = nil
            return a
        }
        guard let a = ended else { return lock.withLock { finished[id] } }
        a.source.stop()
        let draft = Self.draft(a.session, endedBy: how, at: now())
        lock.withLock {
            finished[id] = draft
            if finished.count > 8, let oldest = finished.keys.sorted().first { finished.removeValue(forKey: oldest) }
        }
        for w in a.waiters { w.resume(returning: draft) }
        log.info("teach ended id=\(id) by=\(how.rawValue) steps=\(a.session.steps.count)")
        return draft
    }

    public func status() -> JSONValue {
        lock.withLock {
            guard let a = active else { return ["active": false] }
            return ["active": true, "sessionId": .string(a.session.id), "steps": .int(a.session.steps.count),
                    "startedAt": .string(AppleDates.string(a.session.startedAt))]
        }
    }

    func input(_ id: String, _ input: TeachInput, _ at: Date) {
        guard let a = lock.withLock({ active?.session.id == id ? active : nil }) else { return }
        let steps = a.session.handle(input, at: at)
        for step in steps {
            _Concurrency.Task { [weak self] in await self?.publish(a, step) }
        }
        if a.session.limitReached { end(id, .limit) }
    }

    func publish(_ a: Active, _ step: TeachStepRecord) async {
        var json = (try? JSONValue(encoding: step)).flatMap(\.objectValue) ?? [:]
        json.removeValue(forKey: "screenshot")
        if a.screenshots, ["click", "double_click", "right_click"].contains(step.kind), let app = step.target?.app,
           let (data, mime) = await screenshot(app) {
            let path = "screens/step-\(step.index).\(mime == "image/png" ? "png" : "jpg")"
            a.session.attachScreenshot(path, toStep: step.index)
            json["screenshot"] = ["path": .string(path), "mimeType": .string(mime), "base64": .string(data.base64EncodedString())]
        }
        await a.emit(["type": "teach.step", "sessionId": .string(a.session.id), "step": .object(json)])
    }

    static func draft(_ s: TeachSession, endedBy: End, at: Date) -> JSONValue {
        let steps = endedBy == .cancel ? [] : s.finish()
        let apps = TeachDraftRenderer.appNames(steps).map(\.name)
        let name = s.name.isEmpty ? TeachDraftRenderer.defaultName(apps: apps, at: s.startedAt) : s.name
        let description = String((s.description?.isEmpty == false ? s.description! : "Repeat the \(apps.first ?? "app") flow the owner demonstrated").prefix(1024))
        var files: [JSONValue] = []
        if endedBy != .cancel {
            files.append(["path": "SKILL.md", "text": .string(TeachDraftRenderer.skillMarkdown(name: name, description: description, steps: steps, recordedAt: s.startedAt))])
            for step in steps { if let shot = step.screenshot { files.append(["path": .string(shot), "fromStep": .int(step.index)]) } }
        }
        let stepJSON: [JSONValue] = steps.compactMap { step in
            var o = (try? JSONValue(encoding: step)).flatMap(\.objectValue)
            o?.removeValue(forKey: "screenshot")
            return o.map(JSONValue.object)
        }
        return [
            "sessionId": .string(s.id), "name": .string(name), "description": .string(description),
            "startedAt": .string(AppleDates.string(s.startedAt)), "endedAt": .string(AppleDates.string(at)), "endedBy": .string(endedBy.rawValue),
            "steps": .array(stepJSON), "files": .array(files),
        ]
    }
}

/// `teach.*` (J8). Owner-only (the Gateway never offers these to the agent); recording needs
/// Accessibility, screenshots Screen Recording. No computer-use session may run meanwhile.
public enum TeachCapabilities {
    struct SessionParams: Decodable { var sessionId: String }

    public static func make(_ teach: TeachController, computer: ComputerUse) -> [any CapabilityHandler] {
        [
            Capability(CapabilitySpec(
                name: "teach.start",
                description: "Record the owner demonstrating a flow (clicks and typing as accessibility targets, optional window screenshots) into a skill draft. Streams teach.step; returns the draft when recording ends (teach.stop, teach.cancel, maxSeconds or maxSteps). Password fields and off-limits apps are never recorded; nothing is saved.",
                sideEffect: .write,
                inputSchema: Schema.object([
                    "name": Schema.string(maxLength: 64), "description": Schema.string(maxLength: 1024), "app": Schema.string("Record only this bundle id"),
                    "screenshots": Schema.boolean(), "maxSteps": Schema.integer(min: 1, max: 200), "maxSeconds": Schema.integer(min: 10, max: 1800),
                ]),
                streaming: true, permissions: [.accessibility], receiptKind: "teach"
            )) { ctx in
                let p = try ctx.decode(TeachController.StartParams.self)
                guard computer.sessions.activeSession == nil else {
                    throw CapabilityError(.conflict, reason: "computer_busy", "The agent is using the computer; teach mode waits until it is done", retryable: true)
                }
                let id = try teach.begin(p, emit: ctx.emit)
                await ctx.emit(["type": "teach.started", "sessionId": .string(id)])
                let draft = await teach.wait(id)
                let count = draft["steps"]?.arrayValue?.count ?? 0
                return CapabilityOutput(draft, receipt: ReceiptDraft(outcome: .ok, summary: "Recorded a demonstration (\(count) steps)"))
            },
            Capability(CapabilitySpec(
                name: "teach.stop", description: "Stop recording and return the skill draft for review.",
                sideEffect: .none, inputSchema: Schema.object(["sessionId": Schema.string()], required: ["sessionId"])
            )) { ctx in
                let p = try ctx.decode(SessionParams.self)
                guard let draft = teach.end(p.sessionId, .stop) else { throw CapabilityError(.notFound, reason: "teach_not_found", "No teach session \(p.sessionId)") }
                return CapabilityOutput(draft)
            },
            Capability(CapabilitySpec(
                name: "teach.cancel", description: "Stop recording and discard everything recorded.",
                sideEffect: .none, inputSchema: Schema.object(["sessionId": Schema.string()], required: ["sessionId"])
            )) { ctx in
                let p = try ctx.decode(SessionParams.self)
                guard teach.end(p.sessionId, .cancel) != nil else { throw CapabilityError(.notFound, reason: "teach_not_found", "No teach session \(p.sessionId)") }
                return CapabilityOutput(["cancelled": true])
            },
            Capability(CapabilitySpec(
                name: "teach.status", description: "Whether teach mode is recording, and how many steps so far.", sideEffect: .read
            )) { _ in CapabilityOutput(teach.status()) },
        ]
    }

    /// Live screenshots: the target app's largest on-screen window, downscaled; never Psyche,
    /// terminals, password managers, finance or Off apps, and never while a password field has focus.
    static func liveScreenshotter(_ cu: ComputerUse) -> TeachScreenshotter {
        { bundleId in
            guard CGPreflightScreenCaptureAccess(), !IsSecureEventInputEnabled() else { return nil }
            try? await _Concurrency.Task.sleep(nanoseconds: 300_000_000)  // let the click's UI settle
            guard let content = try? await ScreenshotCapabilities.shareable(),
                  let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundleId })
            else { return nil }
            let running = NSWorkspace.shared.runningApplications.map { CaptureHygiene.AppRef(bundleId: $0.bundleIdentifier, pid: $0.processIdentifier) }
            let excluded = CaptureHygiene.excludedPids(running: running, ownPid: ProcessInfo.processInfo.processIdentifier, policy: cu.policy)
            guard !excluded.contains(app.processIdentifier) else { return nil }
            let windows = content.windows.filter { $0.owningApplication?.processID == app.processIdentifier && $0.isOnScreen && $0.windowLayer == 0 }
            guard let w = windows.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else { return nil }
            let (width, height) = CaptureHygiene.scaledSize(width: Int(w.frame.width * 2), height: Int(w.frame.height * 2), maxWidth: 1280, maxHeight: 800)
            let config = SCStreamConfiguration()
            config.width = width
            config.height = height
            config.showsCursor = false
            guard let image = try? await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: w), configuration: config),
                  let (data, mime) = try? ScreenshotCapabilities.encode(image, png: false)
            else { return nil }
            return (data, mime)
        }
    }
}
