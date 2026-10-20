import AppKit
import ApplicationServices
import Foundation
import PsycheHelperCore
import PsycheProtocol

/// Shared state for computer use: AX engine, tier policy, session lock and Esc stop.
public final class ComputerUse: @unchecked Sendable {
    let engine = AXEngine()
    public let policy: TierPolicy
    public let sessions: ComputerSessionLock
    public let stop = StopSignal()
    /// Owner input recency for pause-when-unwatched (#272).
    let attention = AttentionMonitor()
    private var escTap: EscStopTap?
    private let escLock = NSLock()
    private let settingsPath: String
    private let log: HelperLog
    /// Notified when the user presses Esc during a session (the app shows / logs it).
    public var onUserStop: (@Sendable (String?) -> Void)?

    public init(environment: [String: String] = ProcessInfo.processInfo.environment, log: HelperLog) {
        settingsPath = TierSettings.path(environment: environment)
        policy = TierPolicy(settings: TierSettings.load(path: settingsPath), ownerInput: { [attention] in attention.lastOwnerInput })
        sessions = ComputerSessionLock()
        self.log = log
    }

    /// Installs the Esc and attention taps (need Accessibility; retried on each computer-use call
    /// until they work).
    func ensureEscTap() {
        attention.start()
        escLock.lock()
        defer { escLock.unlock() }
        guard escTap == nil else { return }
        let tap = EscStopTap(
            stop: stop, isActive: { [sessions] in sessions.activeSession != nil },
            onStop: { [weak self] in
                guard let self else { return }
                let stopped = self.sessions.stopActive()
                self.log.info("computer use stopped by Esc")
                self.onUserStop?(stopped)
            }
        )
        if tap.start() { escTap = tap }
    }

    func reloadSettings() { policy.update(TierSettings.load(path: settingsPath)) }

    /// Session lock for one mutating call. The Gateway must name the session (the run id): a
    /// shared default would let one Esc block every later run, or let runs share a lock.
    func beginAction(session: String?) throws {
        guard let session, !session.isEmpty, session.count <= 128 else {
            throw CapabilityError.invalidParams("session (the run id) is required for computer actions", field: "session")
        }
        ensureEscTap()
        reloadSettings()
        try sessions.acquire(session)
    }
}

// MARK: - Params

struct SnapshotParams: Decodable {
    var app: String?
    var pid: Int32?
    var window: Int?
    var root: String?
    var menubar: Bool?
    var maxVisit: Int?
    var maxEmit: Int?
    var textMax: Int?
    var valueMax: Int?
    var clip: Bool?
    var format: String?
    var session: String?
}

/// An element by ref (or by a unique selector over the last snapshot), or a screen point.
struct TargetParams: Decodable {
    var ref: String?
    var selector: AXSelector?
    var x: Double?
    var y: Double?
    var expect: AXExpectation?
    var session: String?
    /// The app the call names (required for x/y targets, #267): the point must land in it.
    var app: String? = nil
}

private func targetSchema(_ extra: [String: JSONValue] = [:], description: String) -> JSONValue {
    var props: [String: JSONValue] = [
        "ref": Schema.string("Element ref from the latest computer.ax_tree snapshot, e.g. e12"),
        "selector": Schema.object([
            "role": Schema.string(), "label": Schema.string(), "id": Schema.string(),
        ], description: "Exact match over the last snapshot; must match exactly one element"),
        "x": Schema.number("Screen x in points (top-left origin), when no ref"),
        "y": Schema.number("Screen y in points (top-left origin), when no ref"),
        "expect": Schema.object([
            "role": Schema.string(), "label": Schema.string(), "valuePrefix": Schema.string(),
        ], required: ["role"], description: "Copied from the snapshot; the call is refused if the element changed (required with ref)"),
        "session": Schema.string("Computer-use session id (the run id); one session drives the computer at a time"),
        "app": Schema.string("Bundle id of the app the call targets; required with x/y"),
    ]
    for (k, v) in extra { props[k] = v }
    return Schema.object(props, description: description)
}

/// What one mutating call did (spike 04 action ladder outcomes).
struct ActionOutcome {
    var status: String  // ok | unverified | ineffective
    var method: String  // ax | cgevent | menu
    var detail: String?
    var ref: String?
    var app: TargetApp

    var result: JSONValue {
        var o: [String: JSONValue] = ["status": .string(status), "method": .string(method), "app": .string(app.bundleId ?? app.name)]
        if let detail { o["detail"] = .string(detail) }
        if let ref { o["ref"] = .string(ref) }
        return .object(o)
    }

    func output(_ verb: String) -> CapabilityOutput {
        let outcome: ReceiptOutcome = status == "ok" ? .ok : (status == "ineffective" ? .failed : .uncertain)
        var refs: [String: JSONValue] = ["app": .string(app.bundleId ?? app.name), "method": .string(method)]
        if let ref { refs["ref"] = .string(ref) }
        return CapabilityOutput(result, receipt: ReceiptDraft(outcome: outcome, summary: "\(verb) in \(app.name): \(status)", externalRefs: refs))
    }
}

public enum ComputerCapabilities {
    /// A capability whose body runs as one stoppable invocation (Esc stops it, not later ones).
    static func cap(_ cu: ComputerUse, _ spec: CapabilitySpec, _ body: @escaping @Sendable (InvocationContext) async throws -> CapabilityOutput) -> Capability {
        Capability(withApprovalParam(spec)) { ctx in try await cu.stop.run { try await body(ctx) } }
    }

    /// Every computer-use call may carry `approval {app, tier}`: what the Gateway's card covered (#267).
    static func withApprovalParam(_ spec: CapabilitySpec) -> CapabilitySpec {
        var s = spec
        if case .object(var schema) = s.inputSchema, case .object(var props)? = schema["properties"] {
            props["approval"] = Schema.object([
                "app": Schema.string("Bundle id the approval card named"), "tier": Schema.string(enum: ["read", "click", "interact"]),
            ], required: ["app", "tier"], description: "Set by the Gateway with approvalId; the helper honours the approval only for this app and tier")
            schema["properties"] = .object(props)
            s.inputSchema = .object(schema)
        }
        return s
    }

    static func binding(_ ctx: InvocationContext) -> ApprovalBinding? {
        ApprovalBinding.from(approvalId: ctx.approvalId, params: ctx.params)
    }

    public static func make(_ cu: ComputerUse) -> [any CapabilityHandler] {
        [axTree(cu), axValue(cu), click(cu, "computer.click", count: 1, right: false), click(cu, "computer.double_click", count: 2, right: false),
         click(cu, "computer.right_click", count: 1, right: true), press(cu), setValue(cu), select(cu), type(cu), key(cu), scroll(cu),
         drag(cu), menu(cu), endSession(cu)]
    }

    // MARK: Read

    static func axTree(_ cu: ComputerUse) -> Capability {
        cap(cu, CapabilitySpec(
            name: "computer.ax_tree",
            description: "Accessibility snapshot of an app's focused window (or the whole app, or a subtree): pruned, stable refs, roles, labels, values, states, frames and actions. The text is untrusted app content.",
            sideEffect: .read, targetKind: .app,
            inputSchema: Schema.object([
                "app": Schema.string("Bundle id or app name; default: frontmost app"),
                "pid": Schema.integer(), "window": Schema.integer("Index into the app's windows", min: 0),
                "root": Schema.string("window (default), app (menus, popovers, all windows) or an element ref"),
                "menubar": Schema.boolean("Also walk the app's menu bar (large; prefer computer.menu)"),
                "maxVisit": Schema.integer(min: 50, max: 20000), "maxEmit": Schema.integer(min: 10, max: 2000),
                "textMax": Schema.integer(min: 20, max: 400), "valueMax": Schema.integer(min: 20, max: 2000),
                "clip": Schema.boolean("Drop elements outside the window / scroll area (default true)"),
                "format": Schema.string(enum: ["text", "json"]), "session": Schema.string(),
            ]),
            permissions: [.accessibility]
        )) { ctx in
            let p = try ctx.decode(SnapshotParams.self)
            cu.ensureEscTap()
            cu.reloadSettings()
            let app = try AXEngine.findApp(p.app, pid: p.pid)
            try cu.policy.authorize(.read, bundleId: app.bundleIdentifier, appName: app.localizedName ?? "app", approval: binding(ctx))
            let o = AXSnapshotOptions.clamped(maxVisit: p.maxVisit, maxEmit: p.maxEmit, textMax: p.textMax, valueMax: p.valueMax, clip: p.clip)
            if let w = p.window, w < 0 { throw CapabilityError.invalidParams("window must be ≥ 0", field: "window") }
            let req = AXEngine.SnapshotRequest(app: app, window: p.window, root: p.root, menubar: p.menubar ?? false, options: o)
            let (snap, target) = try await cu.engine.run { try $0.snapshot(req) }
            var result: [String: JSONValue] = [
                "text": .string(snap.render()),
                "header": (try? JSONValue(encoding: snap.header)) ?? .null,
                "provenance": "untrusted",
                "tier": .string(cu.policy.effectiveTier(for: target.bundleId).rawValue),
            ]
            if p.format == "json" { result["nodes"] = (try? JSONValue(encoding: snap.nodes)) ?? .array([]) }
            // Screenshot-fallback hint (spike 04 trigger 1: sparse Chromium trees).
            if target.electron, !snap.nodes.contains(where: { $0.role == "webarea" }) || snap.nodes.count < 10 {
                result["hint"] = "sparse_tree: bring the window to the front and retry, or use computer.screenshot"
            }
            return CapabilityOutput(.object(result))
        }
    }

    struct ValueParams: Decodable {
        var ref: String
        var max: Int?
    }

    static func axValue(_ cu: ComputerUse) -> Capability {
        cap(cu, CapabilitySpec(
            name: "computer.ax_value", description: "Full text value of one element (snapshots truncate values). Untrusted content.",
            sideEffect: .read, targetKind: .app,
            inputSchema: Schema.object(["ref": Schema.string(), "max": Schema.integer(min: 1, max: 200_000)], required: ["ref"]),
            permissions: [.accessibility]
        )) { ctx in
            let p = try ctx.decode(ValueParams.self)
            let el = try await cu.engine.run { try $0.element(for: p.ref) }
            try cu.policy.authorize(.read, bundleId: el.app.bundleId, appName: el.app.name, approval: binding(ctx))
            if el.info.isSecure { throw secureRefusal() }
            let value = try await cu.engine.run { [el] in $0.fullValue(el, max: min(200_000, max(1, p.max ?? 50_000))) }
            return CapabilityOutput(["ref": .string(p.ref), "role": .string(el.roleName), "value": value.map { .string($0) } ?? .null,
                                     "provenance": "untrusted"])
        }
    }

    // MARK: Element actions

    static func secureRefusal() -> CapabilityError {
        CapabilityError(.policyDenied, reason: "secure_field", "Psyche never reads or types into password fields. Use a {{cred:…}} fill through the vault instead.")
    }

    /// Resolves the target element, checks the session, tier, expectation and risk.
    static func element(
        _ cu: ComputerUse, _ ctx: InvocationContext, _ t: TargetParams, intent: ComputerIntent, customAction: String? = nil
    ) async throws -> ResolvedElement {
        try cu.beginAction(session: t.session)
        let ref: String
        if let r = t.ref {
            ref = r
        } else if let sel = t.selector {
            ref = try await cu.engine.run { try $0.resolve(selector: sel) }
        } else {
            throw CapabilityError.invalidParams("ref or selector is required", field: "ref")
        }
        let el = try await cu.engine.run { try $0.element(for: ref) }
        // A click or press on a menu-like element runs an app command (#266).
        let intent = intent.escalated(forRole: el.info.role)
        try cu.policy.authorize(intent, bundleId: el.app.bundleId, appName: el.app.name, approval: binding(ctx))
        guard let expect = t.expect else {
            throw CapabilityError.invalidParams("expect {role, label} from the snapshot is required with a ref", field: "expect")
        }
        let value = try await cu.engine.run { [el] in $0.currentValue(el) }
        if let why = expect.mismatch(role: el.roleName, label: el.label, value: el.info.isSecure ? nil : value) {
            throw CapabilityError(.conflict, reason: "expectation_failed", "\(ref) changed: \(why). Take a new snapshot.",
                                  details: ["ref": .string(ref), "role": .string(el.roleName), "label": el.label.map { .string($0) } ?? .null])
        }
        if intent != .read, binding(ctx) == nil, RiskLabels.isRisky(label: el.label, customAction: customAction) {
            throw CapabilityError(.approvalRequired, reason: "risky_label",
                                  "\"\(el.label ?? customAction ?? "")\" may delete, send or create data; this action needs approval.",
                                  details: ["label": .string(el.label ?? ""), "app": .string(el.app.bundleId ?? el.app.name)])
        }
        return el
    }

    /// Point target: authorizes the app under the point.
    static func point(_ cu: ComputerUse, _ ctx: InvocationContext, _ t: TargetParams, intent: ComputerIntent) async throws -> (CGPoint, TargetApp) {
        try cu.beginAction(session: t.session)
        guard let x = t.x, let y = t.y, x.isFinite, y.isFinite else {
            throw CapabilityError.invalidParams("ref, selector or x/y is required", field: "ref")
        }
        let p = CGPoint(x: x, y: y)
        guard let app = try await cu.engine.run({ $0.app(at: p) }) else {
            throw CapabilityError(.notFound, reason: "nothing_at_point", "No app owns the point \(Int(x)),\(Int(y))")
        }
        let target = AXEngine.target(app)
        // The point must land in the app the call (and its approval) named (#267).
        guard let named = t.app, !named.isEmpty else {
            throw CapabilityError.invalidParams("app (the bundle id the point is in) is required with x/y", field: "app")
        }
        guard named.lowercased() == target.bundleId?.lowercased() else {
            throw CapabilityError(.policyDenied, reason: "app_mismatch", "The point is in \(target.name), not \(named)",
                                  details: ["app": .string(named), "appAtPoint": .string(target.bundleId ?? target.name)])
        }
        let intent = intent.escalated(forRole: AXEngine.hitTest(p)?.role)
        try cu.policy.authorize(intent, bundleId: target.bundleId, appName: target.name, approval: binding(ctx))
        return (p, target)
    }

    /// Brings `app` forward and verifies it really is frontmost: HID events go to whatever app is,
    /// so acting without this check would type into a terminal or a password prompt.
    static func activate(_ app: TargetApp, stop: StopSignal) throws {
        guard let running = AXEngine.runningApp(pid: app.pid) else {
            throw CapabilityError(.notFound, reason: "app_not_running", "\(app.name) is no longer running")
        }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != app.pid {
            running.unhide()
            running.activate()
            for _ in 0..<30 {
                try Input.pause(20, stop: stop)
                if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.pid { break }
            }
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.pid else {
            throw CapabilityError(.conflict, reason: "not_frontmost",
                                  "\(app.name) could not be brought to the front; input was not sent", retryable: true)
        }
    }

    /// Keyboard input goes only to `app`'s own focused element.
    static func ensureKeyboardTarget(_ app: TargetApp) throws {
        let focus = AXEngine.keyboardFocus()
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.pid, focus.pid == nil || focus.pid == app.pid else {
            throw CapabilityError(.conflict, reason: "focus_moved", "Keyboard focus is no longer in \(app.name); input stopped", retryable: true)
        }
    }

    /// Hit-tests `point` before a synthetic mouse event: it must land in `app` (and, for a ref, on
    /// that element or inside it), and on nothing secure or risky without approval.
    static func checkHit(_ point: CGPoint, app: TargetApp, element: ResolvedElement?, approvalId: String?) throws {
        guard let hit = AXEngine.hitTest(point) else {
            throw CapabilityError(.conflict, reason: "hit_test_failed", "Nothing to click at \(Int(point.x)),\(Int(point.y))")
        }
        guard hit.pid == app.pid else {
            throw CapabilityError(.conflict, reason: "occluded", "Another window covers the target at \(Int(point.x)),\(Int(point.y)); bring \(app.name) forward and re-snapshot")
        }
        if let element, !hit.isInside(element.key) {
            throw CapabilityError(.conflict, reason: "occluded", "Something else covers \(element.ref); re-snapshot")
        }
        if hit.secure { throw secureRefusal() }
        if element == nil, approvalId == nil, hit.labels.contains(where: { RiskLabels.isRisky(label: $0) }) {
            throw CapabilityError(.approvalRequired, reason: "risky_label", "The control at this point may delete, send or create data; this click needs approval.")
        }
    }

    static func center(_ cu: ComputerUse, _ el: ResolvedElement) async throws -> CGPoint {
        guard let f = try await cu.engine.run({ [el] in $0.frame(el) }), f.width > 0, f.height > 0 else {
            throw CapabilityError(.unavailable, reason: "no_frame", "\(el.ref) has no on-screen frame; scroll it into view and re-snapshot")
        }
        return CGPoint(x: f.midX, y: f.midY)
    }

    struct ClickParams: Decodable {
        var ref: String?
        var selector: AXSelector?
        var x: Double?
        var y: Double?
        var expect: AXExpectation?
        var session: String?
        var modifiers: [String]?
        var app: String?

        var target: TargetParams { TargetParams(ref: ref, selector: selector, x: x, y: y, expect: expect, session: session, app: app) }
    }

    static func modifierFlags(_ names: [String]?) throws -> CGEventFlags {
        guard let names, !names.isEmpty else { return [] }
        return try KeyChord.parse(names.joined(separator: "+") + "+a").flags
    }

    static func click(_ cu: ComputerUse, _ name: String, count: Int, right: Bool) -> Capability {
        let verb = right ? "right-click" : (count == 2 ? "double-click" : "click")
        return cap(cu, CapabilitySpec(
            name: name,
            description: right ? "Right-click an element (opens its context menu) or a point."
                : count == 2 ? "Double-click an element or a point." : "Click an element (AXPress first, mouse click fallback) or a point.",
            sideEffect: .write, targetKind: .app,
            inputSchema: targetSchema(["modifiers": Schema.array(Schema.string(enum: ["cmd", "shift", "opt", "ctrl"]))], description: verb),
            permissions: [.accessibility], receiptKind: "computer_action"
        )) { ctx in
            let p = try ctx.decode(ClickParams.self)
            let flags = try modifierFlags(p.modifiers)
            let intent: ComputerIntent = right ? .rightClick : (flags.isEmpty ? .click : .modifierClick)
            if p.ref != nil || p.selector != nil {
                let el = try await element(cu, ctx, p.target, intent: intent)
                // 1. Semantic AX first.
                if count == 1, !right, flags.isEmpty {
                    let actions = try await cu.engine.run { [el] in $0.actionNames(el) }
                    if actions.contains("AXPress") {
                        let r = try await cu.engine.run { [el] in $0.perform(el, action: "AXPress") }
                        if r == .success {
                            return ActionOutcome(status: "ok", method: "ax", detail: "AXPress; re-snapshot to confirm the effect", ref: el.ref, app: el.app).output(verb)
                        }
                    }
                }
                if right, count == 1, flags.isEmpty {
                    let actions = try await cu.engine.run { [el] in $0.actionNames(el) }
                    if actions.contains("AXShowMenu"), try await cu.engine.run({ [el] in $0.perform(el, action: "AXShowMenu") }) == .success {
                        return ActionOutcome(status: "ok", method: "ax", detail: "AXShowMenu", ref: el.ref, app: el.app).output(verb)
                    }
                }
                // 2. CGEvent fallback at the frame centre, app frontmost, through the HID tap.
                let c = try await center(cu, el)
                try activate(el.app, stop: cu.stop)
                try checkHit(c, app: el.app, element: el, approvalId: ctx.approvalId)
                try Input.click(at: c, count: count, right: right, flags: flags, stop: cu.stop)
                return ActionOutcome(status: "ok", method: "cgevent", detail: "mouse \(verb) at the element centre", ref: el.ref, app: el.app).output(verb)
            }
            let (pt, app) = try await point(cu, ctx, p.target, intent: intent)
            try activate(app, stop: cu.stop)
            try checkHit(pt, app: app, element: nil, approvalId: ctx.approvalId)
            try Input.click(at: pt, count: count, right: right, flags: flags, stop: cu.stop)
            return ActionOutcome(status: "ok", method: "cgevent", detail: "mouse \(verb) at \(Int(pt.x)),\(Int(pt.y))", app: app).output(verb)
        }
    }

    struct PressParams: Decodable {
        var ref: String?
        var selector: AXSelector?
        var expect: AXExpectation?
        var session: String?
        var action: String

        var target: TargetParams { TargetParams(ref: ref, selector: selector, expect: expect, session: session) }
    }

    static let pressActions: [String: String] = [
        "press": "AXPress", "confirm": "AXConfirm", "cancel": "AXCancel", "pick": "AXPick", "inc": "AXIncrement",
        "dec": "AXDecrement", "raise": "AXRaise", "menu": "AXShowMenu", "open": "AXOpen",
    ]

    static func press(_ cu: ComputerUse) -> Capability {
        cap(cu, CapabilitySpec(
            name: "computer.press",
            description: "Perform a semantic accessibility action on an element: press, confirm, cancel, pick, inc, dec, raise, menu, open, or custom:<Name> as listed in the snapshot.",
            sideEffect: .write, targetKind: .app,
            inputSchema: targetSchema(["action": Schema.string("press, confirm, … or custom:<Name>")], description: "press"),
            permissions: [.accessibility], receiptKind: "computer_action"
        )) { ctx in
            let p = try ctx.decode(PressParams.self)
            let custom = p.action.hasPrefix("custom:") ? String(p.action.dropFirst(7)) : nil
            // Plain AXPress on a control is a click; menu items and other actions can run any app
            // command (Terminal Edit>Paste, Xcode Product>Run), so they need Read and interact.
            var intent: ComputerIntent = p.action == "press" ? .press : .menu
            if let r = p.ref, intent == .press {
                let role = try? await cu.engine.run { try $0.element(for: r).info.role }
                if let role, ["AXMenuItem", "AXMenuBarItem", "AXMenuButton", "AXPopUpButton"].contains(role) { intent = .menu }
            } else if p.selector?.role?.hasPrefix("menu") == true || p.selector?.role == "popupbutton" {
                intent = .menu
            }
            let el = try await element(cu, ctx, p.target, intent: intent, customAction: custom)
            let raw = try await cu.engine.run { [el] in $0.actionNames(el) }
            let axName: String
            if let custom {
                guard let match = raw.first(where: { AXText.customActionName($0) == custom }) else {
                    throw CapabilityError(.notFound, reason: "action_not_supported", "\(el.ref) has no custom action \(custom)")
                }
                axName = match
            } else {
                guard let mapped = pressActions[p.action], raw.contains(mapped) else {
                    throw CapabilityError(.notFound, reason: "action_not_supported", "\(el.ref) does not support \(p.action)",
                                          details: ["actions": .array(raw.map { .string(AXText.customActionName($0)) })])
                }
                axName = mapped
            }
            let r = try await cu.engine.run { [el] in $0.perform(el, action: axName) }
            guard r == .success else {
                if r == .cannotComplete { throw AXEngine.notResponding(el.app) }
                return ActionOutcome(status: "ineffective", method: "ax", detail: "AXError \(r.rawValue)", ref: el.ref, app: el.app).output(p.action)
            }
            return ActionOutcome(status: "ok", method: "ax", detail: "\(p.action); re-snapshot to confirm the effect", ref: el.ref, app: el.app).output(p.action)
        }
    }

    struct SetParams: Decodable {
        var ref: String?
        var selector: AXSelector?
        var expect: AXExpectation?
        var session: String?
        var value: String

        var target: TargetParams { TargetParams(ref: ref, selector: selector, expect: expect, session: session) }
    }

    /// Read back with backoff (Chromium applies AX writes asynchronously, spike 04).
    static func verify(_ cu: ComputerUse, _ el: ResolvedElement, _ check: @escaping @Sendable (String?) -> Bool) async throws -> String? {
        for (i, wait) in [50, 100, 200, 400].enumerated() {
            try Input.pause(wait, stop: cu.stop)
            let now = try await cu.engine.run { [el] in $0.currentValue(el) }
            if check(now) { return "verified after \([50, 150, 350, 750][i]) ms" }
        }
        return nil
    }

    static func setValue(_ cu: ComputerUse) -> Capability {
        cap(cu, CapabilitySpec(
            name: "computer.set_value",
            description: "Replace a text field's or slider's value through AXValue (only when the element is settable), then read it back. Refused for password fields.",
            sideEffect: .write, targetKind: .app,
            inputSchema: targetSchema(["value": Schema.string(maxLength: 100_000)], description: "set value"),
            permissions: [.accessibility], receiptKind: "computer_action"
        )) { ctx in
            let p = try ctx.decode(SetParams.self)
            let el = try await element(cu, ctx, p.target, intent: .setValue)
            if el.info.isSecure { throw secureRefusal() }
            guard try await cu.engine.run({ [el] in $0.isSettable(el, "AXValue") }) else {
                throw CapabilityError(.conflict, reason: "not_settable", "\(el.ref) (\(el.roleName)) has no settable value; click it and use computer.type")
            }
            // Finder's list-view name cell accepts AXValue cosmetically without renaming the file.
            if el.app.bundleId == "com.apple.finder", el.info.role == "AXTextField" {
                let focusedRef = try await cu.engine.run { [el] _ in AX.element(AX.attr(AXUIElementCreateApplication(el.app.pid), "AXFocusedUIElement")).map(AXKey.init) }
                if focusedRef != el.key {
                    throw CapabilityError(.conflict, reason: "cosmetic_field",
                                          "Setting a Finder name cell does not rename the file. Select the row, use computer.menu File>Rename, set the focused field, then press return.")
                }
            }
            let r = try await cu.engine.run { [el] in $0.set(el, "AXValue", p.value as CFString) }
            guard r == .success else {
                return ActionOutcome(status: "ineffective", method: "ax", detail: "AXError \(r.rawValue)", ref: el.ref, app: el.app).output("set value")
            }
            let want = p.value
            if let how = try await verify(cu, el, { $0 == want }) {
                return ActionOutcome(status: "ok", method: "ax", detail: how, ref: el.ref, app: el.app).output("set value")
            }
            let detail = el.app.electron ? "read-back did not match after 750 ms (Chromium window in the background?)" : "read-back did not match after 750 ms"
            return ActionOutcome(status: "unverified", method: "ax", detail: detail, ref: el.ref, app: el.app).output("set value")
        }
    }

    static func select(_ cu: ComputerUse) -> Capability {
        cap(cu, CapabilitySpec(
            name: "computer.select", description: "Select a row, tab or list item by setting AXSelected (verified by read-back).",
            sideEffect: .write, targetKind: .app, inputSchema: targetSchema(description: "select"),
            permissions: [.accessibility], receiptKind: "computer_action"
        )) { ctx in
            let t = try ctx.decode(TargetParams.self)
            let el = try await element(cu, ctx, t, intent: .click)
            guard try await cu.engine.run({ [el] in $0.isSettable(el, "AXSelected") }) else {
                throw CapabilityError(.conflict, reason: "not_selectable", "\(el.ref) cannot be selected through AX; use computer.click")
            }
            let r = try await cu.engine.run { [el] in $0.set(el, "AXSelected", kCFBooleanTrue) }
            guard r == .success else {
                return ActionOutcome(status: "ineffective", method: "ax", detail: "AXError \(r.rawValue)", ref: el.ref, app: el.app).output("select")
            }
            try Input.pause(50, stop: cu.stop)
            let selected = try await cu.engine.run { [el] in $0.isSelected(el) }
            return ActionOutcome(status: selected == true ? "ok" : "unverified", method: "ax", ref: el.ref, app: el.app).output("select")
        }
    }

    struct TypeParams: Decodable {
        var ref: String?
        var selector: AXSelector?
        var expect: AXExpectation?
        var session: String?
        var app: String?
        var text: String

        var target: TargetParams { TargetParams(ref: ref, selector: selector, expect: expect, session: session) }
    }

    static func type(_ cu: ComputerUse) -> Capability {
        cap(cu, CapabilitySpec(
            name: "computer.type",
            description: "Type text at the caret: into an element (focused first through AX) or into the app's focused element. Refused while a password field has focus.",
            sideEffect: .write, targetKind: .app,
            inputSchema: targetSchema(["text": Schema.string(maxLength: 20_000), "app": Schema.string("Target app when no ref (default frontmost)")],
                                      description: "type"),
            permissions: [.accessibility], receiptKind: "computer_action"
        )) { ctx in
            let p = try ctx.decode(TypeParams.self)
            guard !p.text.isEmpty else { throw CapabilityError.invalidParams("text is empty", field: "text") }
            let sendsLine = SendKeys.textSends(p.text)
            if p.text.contains("{{cred:") {
                throw CapabilityError(.policyDenied, reason: "credential_placeholder", "Credential placeholders are filled by the vault, never typed")
            }
            let app: TargetApp
            var ref: String?
            if p.ref != nil || p.selector != nil {
                let el = try await element(cu, ctx, p.target, intent: .type)
                if el.info.isSecure { throw secureRefusal() }
                _ = try await cu.engine.run { [el] in $0.set(el, "AXFocused", kCFBooleanTrue) }
                app = el.app
                ref = el.ref
            } else {
                try cu.beginAction(session: p.session)
                let running = try AXEngine.findApp(p.app)
                app = AXEngine.target(running)
                try cu.policy.authorize(.type, bundleId: app.bundleId, appName: app.name, approval: binding(ctx))
            }
            // #270: a line break in typed text presses Return, which sends in messaging and mail apps.
            if sendsLine, SendKeys.isMessagingApp(app.bundleId), binding(ctx) == nil {
                throw CapabilityError(.approvalRequired, reason: "send_text", "Typing a line break sends in \(app.name); sending needs your approval",
                                      details: ["app": .string(app.bundleId ?? app.name), "sideEffect": "destructive"])
            }
            try activate(app, stop: cu.stop)
            // Checked before every chunk: Tab/Return can move focus (into a password field, or out
            // of the app), and the dispatch layer refuses secure fields below the model.
            try Input.type(p.text, stop: cu.stop) {
                try ensureKeyboardTarget(app)
                if AXEngine.keyboardFocus().secure { throw secureRefusal() }
            }
            return ActionOutcome(status: "ok", method: "cgevent", detail: "typed \(p.text.count) characters", ref: ref, app: app).output("type")
        }
    }

    struct KeyParams: Decodable {
        var keys: String
        var app: String?
        var session: String?
        var repeatCount: Int?

        enum CodingKeys: String, CodingKey {
            case keys, app, session
            case repeatCount = "repeat"
        }
    }

    static func key(_ cu: ComputerUse) -> Capability {
        cap(cu, CapabilitySpec(
            name: "computer.key",
            description: "Press a key or chord (e.g. return, escape, tab, cmd+s, shift+cmd+t) in an app, as keycode events. cmd+q, cmd+w and similar need approval.",
            sideEffect: .write, targetKind: .app,
            inputSchema: Schema.object([
                "keys": Schema.string("Chord: modifiers (cmd, shift, opt, ctrl, fn) + one key"),
                "app": Schema.string("Bundle id or name (default frontmost)"), "session": Schema.string(),
                "repeat": Schema.integer(min: 1, max: 50),
            ], required: ["keys"]),
            permissions: [.accessibility], receiptKind: "computer_action"
        )) { ctx in
            let p = try ctx.decode(KeyParams.self)
            let chord = try KeyChord.parse(p.keys)
            try cu.beginAction(session: p.session)
            let running = try AXEngine.findApp(p.app)
            let app = AXEngine.target(running)
            try cu.policy.authorize(.key, bundleId: app.bundleId, appName: app.name, approval: binding(ctx))
            // #270: Return / Enter / cmd+shift+D send in messaging and mail apps: destructive, needs its own approval.
            if SendKeys.isMessagingApp(app.bundleId), SendKeys.isSendChord(chord), binding(ctx) == nil {
                throw CapabilityError(.approvalRequired, reason: "send_key", "\(p.keys) sends in \(app.name); sending needs your approval",
                                      details: ["app": .string(app.bundleId ?? app.name), "sideEffect": "destructive"])
            }
            if chord.isHighRisk, binding(ctx) == nil {
                throw CapabilityError(.approvalRequired, reason: "risky_chord", "\(p.keys) can close windows, quit apps or delete; it needs approval")
            }
            try activate(app, stop: cu.stop)
            if try await cu.engine.run({ $0.focusedIsSecure(pid: app.pid) }), !chord.isBareEscape, chord.keyCode != 48 {
                throw secureRefusal()  // allow Esc and Tab to leave the field
            }
            for _ in 0..<min(50, max(1, p.repeatCount ?? 1)) {
                try ensureKeyboardTarget(app)
                if chord.keyCode != 53 && chord.keyCode != 48, AXEngine.keyboardFocus().secure { throw secureRefusal() }
                try Input.key(chord, stop: cu.stop)
            }
            return ActionOutcome(status: "ok", method: "cgevent", detail: p.keys, app: app).output("key \(p.keys)")
        }
    }

    struct ScrollParams: Decodable {
        var ref: String?
        var selector: AXSelector?
        var x: Double?
        var y: Double?
        var expect: AXExpectation?
        var session: String?
        var dx: Int?
        var dy: Int?
        var app: String?

        var target: TargetParams { TargetParams(ref: ref, selector: selector, x: x, y: y, expect: expect, session: session, app: app) }
    }

    static func scroll(_ cu: ComputerUse) -> Capability {
        cap(cu, CapabilitySpec(
            name: "computer.scroll", description: "Scroll by lines over an element or a point (dy > 0 scrolls up, dy < 0 down).",
            sideEffect: .write, targetKind: .app,
            inputSchema: targetSchema(["dx": Schema.integer(min: -200, max: 200), "dy": Schema.integer(min: -200, max: 200)], description: "scroll"),
            permissions: [.accessibility], receiptKind: "computer_action"
        )) { ctx in
            let p = try ctx.decode(ScrollParams.self)
            let dx = Int32(max(-200, min(200, p.dx ?? 0)))
            let dy = Int32(max(-200, min(200, p.dy ?? 0)))
            let (pt, app, ref): (CGPoint, TargetApp, String?)
            if p.ref != nil || p.selector != nil {
                let el = try await element(cu, ctx, p.target, intent: .scroll)
                (pt, app, ref) = (try await center(cu, el), el.app, el.ref)
            } else {
                let (point, a) = try await point(cu, ctx, p.target, intent: .scroll)
                (pt, app, ref) = (point, a, nil)
            }
            guard AXEngine.hitTest(pt)?.pid == app.pid else {
                throw CapabilityError(.conflict, reason: "occluded", "Another window covers the scroll point; bring \(app.name) forward")
            }
            try Input.scroll(at: pt, dx: dx, dy: dy, stop: cu.stop)
            return ActionOutcome(status: "ok", method: "cgevent", detail: "scrolled dx=\(dx) dy=\(dy)", ref: ref, app: app).output("scroll")
        }
    }

    struct DragParams: Decodable {
        var from: TargetParams
        var to: TargetParams
        var session: String?
    }

    static func drag(_ cu: ComputerUse) -> Capability {
        let end = Schema.object(["ref": Schema.string(), "x": Schema.number(), "y": Schema.number(), "app": Schema.string(),
                                 "expect": Schema.object(["role": Schema.string(), "label": Schema.string()], required: ["role"])])
        return cap(cu, CapabilitySpec(
            name: "computer.drag", description: "Drag with the left mouse button from one element or point to another, within one app.",
            sideEffect: .write, targetKind: .app,
            inputSchema: Schema.object(["from": end, "to": end, "session": Schema.string()], required: ["from", "to"]),
            permissions: [.accessibility], receiptKind: "computer_action"
        )) { ctx in
            let p = try ctx.decode(DragParams.self)
            func resolve(_ t: TargetParams) async throws -> (CGPoint, TargetApp) {
                var t = t
                t.session = p.session
                if t.ref != nil || t.selector != nil {
                    let el = try await element(cu, ctx, t, intent: .drag)
                    return (try await center(cu, el), el.app)
                }
                return try await point(cu, ctx, t, intent: .drag)
            }
            let (a, appA) = try await resolve(p.from)
            let (b, appB) = try await resolve(p.to)
            guard appA.pid == appB.pid else {
                throw CapabilityError(.policyDenied, reason: "cross_app_drag", "Drags between apps are not allowed")
            }
            try activate(appA, stop: cu.stop)
            try checkHit(a, app: appA, element: nil, approvalId: ctx.approvalId)
            try Input.drag(from: a, to: b, stop: cu.stop)
            return ActionOutcome(status: "ok", method: "cgevent", app: appA).output("drag")
        }
    }

    struct MenuParams: Decodable {
        var app: String?
        var path: String
        var session: String?
    }

    static func menu(_ cu: ComputerUse) -> Capability {
        cap(cu, CapabilitySpec(
            name: "computer.menu",
            description: "Choose a menu-bar item by path without opening the menus, e.g. \"File>Rename\" or \"Edit>Undo\". Each segment must match one item exactly.",
            sideEffect: .write, targetKind: .app,
            inputSchema: Schema.object(["app": Schema.string(), "path": Schema.string("Item titles separated by >"), "session": Schema.string()],
                                       required: ["path"]),
            permissions: [.accessibility], receiptKind: "computer_action"
        )) { ctx in
            let p = try ctx.decode(MenuParams.self)
            let path = p.path.split(separator: ">").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            guard !path.isEmpty else { throw CapabilityError.invalidParams("path is empty", field: "path") }
            try cu.beginAction(session: p.session)
            let running = try AXEngine.findApp(p.app)
            let app = AXEngine.target(running)
            try cu.policy.authorize(.menu, bundleId: app.bundleId, appName: app.name, approval: binding(ctx))
            if ctx.approvalId == nil, path.contains(where: { RiskLabels.isRisky(label: $0) }) {
                throw CapabilityError(.approvalRequired, reason: "risky_label", "\(p.path) may delete, send or quit; it needs approval")
            }
            let title = try await cu.engine.run { [running] in try $0.pressMenu(running, path: path) }
            return ActionOutcome(status: "ok", method: "menu", detail: title, app: app).output("menu \(p.path)")
        }
    }

    struct EndParams: Decodable { var session: String? }

    static func endSession(_ cu: ComputerUse) -> Capability {
        cap(cu, CapabilitySpec(
            name: "computer.end_session", description: "Release the computer-use session lock when a run is done.",
            sideEffect: .none, inputSchema: Schema.object(["session": Schema.string()])
        )) { ctx in
            let p = try ctx.decode(EndParams.self)
            cu.sessions.release(p.session ?? "default")
            return CapabilityOutput(["released": true])
        }
    }
}

extension AXEngine.SnapshotRequest: @unchecked Sendable {}
