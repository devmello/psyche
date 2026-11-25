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
/// enforces it. W3 is perception: `points.windows`, `points.session` and `points.end`. Showing the
/// overlay (`points.show`, W4) and the vision fallback (`points.look`, W5) come later.
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
        try PointsActivity.gate.withLock {
            if isComputerBusy() {
                throw CapabilityError(.conflict, reason: "computer_busy", "The agent is using the computer; pointing waits until it is done", retryable: true)
            }
            if isRecording() {
                throw CapabilityError(.conflict, reason: "recording_active", "A recording is running; pointing waits until it stops", retryable: true)
            }
            guard activity.begin(ctx.invocationId) else {
                throw CapabilityError(.conflict, reason: "points_active", "Psyche points is already helping with a window")
            }
        }
        let target = PointsTarget(
            bundleId: bundleId, appName: String((app.localizedName ?? bundleId).prefix(120)), pid: ref.pid,
            windowTitle: String((AX.string(AX.attr(window, "AXTitle")) ?? "").prefix(200)))
        // Chromium and Electron build their tree only after this one attribute is set on the app element.
        enableManualAccessibility(pid: ref.pid)
        let controller = PointsSessionController(
            sessionId: ctx.invocationId, app: app, window: window, target: target, teamId: codeSigningTeamID(pid: ref.pid))
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
        let limit = _Concurrency.Task { [controller] in
            try? await _Concurrency.Task.sleep(nanoseconds: Self.maxSessionSeconds * 1_000_000_000)
            controller.stop(.idle)
        }
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
