import AppKit
import ApplicationServices
import Foundation
import PsycheAXEnable
import PsycheAXRead
import PsycheCapture
import PsycheHelperCore
import PsycheProtocol

/// Psyche points (docs/design/psyche-points-2026.md): the helper half. This target may import
/// `PsycheHelperCore`, `PsycheAXRead`, `PsycheCapture` and `PsycheAXEnable`, never `PsycheHelperSystem`,
/// so nothing here can post an event or perform an AX action. `scripts/check-points-boundary.sh`
/// enforces it. W3 is perception (`points.windows`, `points.session`, `points.end`), W4 the overlay
/// (`points.show`), W5 the vision fallback (`points.look`): they read and draw, and never act.
///
/// `make` takes exactly two closures, `isComputerBusy` (a computer-use session holds the lock) and
/// `isRecording` (a teach recording runs): Points refuses to start while either is true. The reverse
/// direction, computer actions refused while a session runs, is `PointsActivity.shared`, read by
/// `ComputerUse.isPointing`.
public enum PointsCapabilities {
    public static func make(isComputerBusy: @escaping @Sendable () -> Bool, isRecording: @escaping @Sendable () -> Bool) -> [any CapabilityHandler] {
        let host = PointsHost(isComputerBusy: isComputerBusy, isRecording: isRecording)
        return [
            Capability(CapabilitySpec(
                name: "points.windows",
                description: "Owner only, Host only. Lists the windows Psyche points could help with (app, title, pid, window index), through accessibility: no screenshot, no Screen Recording. A window of an app Points refuses carries its refusal. Reads titles and roles only.",
                sideEffect: .read, inputSchema: Schema.object([:])
            )) { _ in
                let settings = TierSettings.load(path: TierSettings.path())
                let result = PointsHelperWindowsResult(windows: PointsWindowList.list(settings: settings))
                return CapabilityOutput(try JSONValue(encoding: result))
            },
            Capability(CapabilitySpec(
                name: "points.session",
                description: "Owner only, Host only. Starts reading ONE window's accessibility tree for Psyche points and streams events (digest, field, focus, page, visible, ended) until cancelled or points.end. `window` is `<pid>:<windowIndex>` from points.windows. A field's value is never read when the field looks sensitive, and a value is sent only when the owner leaves a field. Never clicks, types or acts.",
                sideEffect: .read,
                inputSchema: Schema.object(
                    ["window": Schema.string("<pid>:<windowIndex> from points.windows", maxLength: 80),
                     "strings": Schema.object([:], additional: true)],
                    required: ["window", "strings"]),
                streaming: true, permissions: [.accessibility]
            )) { ctx in
                try await host.runSession(ctx)
            },
            Capability(CapabilitySpec(
                name: "points.show",
                description: "Owner only, Host only. Draws the ring and the note card for ONE field of a running points.session, by its fieldId. Text only: the helper clamps lengths, drops a suggested value for a sensitive field and never clicks, types or takes focus.",
                sideEffect: .none,
                inputSchema: Schema.object(
                    ["sessionId": Schema.string(maxLength: 80),
                     "target": Schema.object(["fieldId": Schema.string(maxLength: 40)], additional: true),
                     "kind": Schema.string(enum: ["fill", "choose", "check", "review", "next_page", "skip", "info", "self"]),
                     "note": Schema.string(maxLength: 1000),
                     "value": Schema.string(maxLength: 1000),
                     "sources": Schema.array(Schema.string(maxLength: 200), maxItems: 8),
                     "step": Schema.object(["n": Schema.integer(min: 1, max: 999), "of": Schema.integer(min: 1, max: 999)], required: ["n", "of"]),
                     "warning": Schema.string(maxLength: 1000)],
                    required: ["sessionId", "target", "kind", "note", "step"])
            )) { ctx in
                let p = try ctx.decode(PointsShowParams.self)
                let shown = try await host.show(p)
                return CapabilityOutput(try JSONValue(encoding: PointsShowResult(shown: shown)))
            },
            Capability(CapabilitySpec(
                name: "points.look",
                description: "Owner only, Host only. One picture of the session's window ONLY (never the screen), for the owner's own Let Psyche look press: `actionId` is the id on that press's action event, valid once. Every known sensitive field is painted solid before the picture leaves the helper. Refused under Secure Event Input, for an app Points refuses, and for an unknown, used or old id.",
                sideEffect: .read,
                inputSchema: Schema.object(
                    ["sessionId": Schema.string(maxLength: 80), "actionId": Schema.string(maxLength: 80)],
                    required: ["sessionId", "actionId"]),
                permissions: [.screenRecording]
            )) { ctx in
                let p = try ctx.decode(PointsLookParams.self)
                let result = try await host.look(p)
                return CapabilityOutput(try JSONValue(encoding: result))
            },
            Capability(CapabilitySpec(
                name: "points.end",
                description: "Owner only, Host only. Ends a Psyche points session (the id of its points.session call). Safe to call twice.",
                sideEffect: .none,
                inputSchema: Schema.object(["sessionId": Schema.string(maxLength: 80)], required: ["sessionId"])
            )) { ctx in
                let p = try ctx.decode(PointsEndParams.self)
                host.end(p.sessionID, reason: .stop)
                return CapabilityOutput(try JSONValue(encoding: PointsEndResult()))
            },
        ]
    }
}

/// The session state of the `points.*` group: at most one session, the id of its `points.session` call.
final class PointsHost: @unchecked Sendable {
    private let isComputerBusy: @Sendable () -> Bool
    private let isRecording: @Sendable () -> Bool
    private let activity: PointsActivity
    static let maxSessionSeconds: UInt64 = 30 * 60
    private let lock = NSLock()
    private var sessions: [String: PointsSessionController] = [:]

    init(isComputerBusy: @escaping @Sendable () -> Bool, isRecording: @escaping @Sendable () -> Bool, activity: PointsActivity = .shared) {
        self.isComputerBusy = isComputerBusy
        self.isRecording = isRecording
        self.activity = activity
    }

    func end(_ id: String, reason: PointsEndReason) {
        let c = lock.withLock { sessions[id] }
        c?.stop(reason)
    }

    /// `points.show`: the overlay of the session `p.sessionID` (the id of its `points.session` call).
    func show(_ p: PointsShowParams) async throws -> Bool {
        let c = lock.withLock { sessions[p.sessionID] }
        guard let c else { throw CapabilityError(.notFound, reason: "no_session", "No points session with that id") }
        // A field the helper holds, or a box drawn on the last picture (vision mode); never both.
        if let fieldId = p.target.fieldID {
            guard p.target.box == nil else { throw CapabilityError.invalidParams("target is a fieldId or a box, not both", field: "target") }
            return try await c.show(p, fieldId: fieldId)
        }
        return try await c.showBox(p)
    }

    /// `points.look`: the session `p.sessionID` (the id of its `points.session` call) takes one masked picture.
    func look(_ p: PointsLookParams) async throws -> PointsLookResult {
        let c = lock.withLock { sessions[p.sessionID] }
        guard let c else { throw CapabilityError(.notFound, reason: "no_session", "No points session with that id") }
        return try await c.look(actionId: p.actionID)
    }

    func runSession(_ ctx: InvocationContext) async throws -> CapabilityOutput {
        let p = try ctx.decode(PointsSessionParams.self)
        // Exclusion with computer use and teach (§4.3 item 4), in this direction.
        if isComputerBusy() {
            throw CapabilityError(.conflict, reason: "computer_busy", "The agent is using the computer; pointing waits until it is done", retryable: true)
        }
        if isRecording() {
            throw CapabilityError(.conflict, reason: "recording_active", "A recording is running; pointing waits until it stops", retryable: true)
        }
        guard let ref = PointsWindowList.parse(ref: p.window) else {
            throw CapabilityError.invalidParams("window must be <pid>:<windowIndex>", field: "window")
        }
        guard AXIsProcessTrusted() else { throw CapabilityError.permissionMissing(.accessibility) }
        guard let app = NSRunningApplication(processIdentifier: ref.pid), !app.isTerminated, let bundleId = app.bundleIdentifier else {
            throw CapabilityError(.notFound, reason: "not_a_window", "That window is gone")
        }
        // The same refusals as the Gateway's, checked again where the window is read (§2.2).
        if let refusal = PointsPolicy.refusal(bundleId: bundleId, settings: TierSettings.load(path: TierSettings.path())) {
            throw CapabilityError(
                .forbidden, reason: "points_refused", "Psyche points does not help in this app", details: ["refusal": .string(refusal.rawValue)])
        }
        let windows = PointsWindowList.windows(of: ref.pid)
        guard ref.index < windows.count, PointsWindowList.isWindow(windows[ref.index]) else {
            throw CapabilityError(.notFound, reason: "not_a_window", "That window is gone")
        }
        let window = windows[ref.index]
        // Busy check and slot take in one step, against a computer action taking its session (7d).
        try activity.begin(ctx.invocationId) {
            if isComputerBusy() {
                return CapabilityError(.conflict, reason: "computer_busy", "The agent is using the computer; pointing waits until it is done", retryable: true)
            }
            if isRecording() {
                return CapabilityError(.conflict, reason: "recording_active", "A recording is running; pointing waits until it stops", retryable: true)
            }
            return nil
        }
        let target = PointsTarget(
            bundleId: bundleId, appName: String((app.localizedName ?? bundleId).prefix(120)), pid: ref.pid,
            windowTitle: String((AX.string(AX.attr(window, "AXTitle")) ?? "").prefix(200)))
        // Chromium and Electron build their tree only after this one attribute is set on the app element.
        enableManualAccessibility(pid: ref.pid)
        let controller = PointsSessionController(
            sessionId: ctx.invocationId, app: app, window: window, target: target, teamId: codeSigningTeamID(pid: ref.pid),
            strings: p.strings)
        lock.withLock { sessions[ctx.invocationId] = controller }
        let id = ctx.invocationId
        defer {
            lock.withLock { sessions[id] = nil }
            activity.end(id)
        }
        guard controller.start() else {
            throw CapabilityError.unavailable("points_unavailable", "Could not read that window's accessibility tree", retryable: true)
        }
        // A helper-side limit: a session never outlives 30 minutes, even if the Gateway forgets it.
        let limit = PointsSessionLimit.watch { [controller] in controller.stop(.idle) }
        defer { limit.cancel() }
        await withTaskCancellationHandler {
            for await event in controller.events {
                if let json = try? JSONValue(encoding: event) { await ctx.emit(json) }
            }
        } onCancel: {
            controller.stop(.stop)
        }
        controller.stop(.stop)
        _ = controller.waitUntilExited(timeout: 2)
        return CapabilityOutput(try JSONValue(encoding: PointsEndResult()))
    }
}
