import Foundation

/// The event taps that exist only while a computer-use session runs: the global Esc stop and the
/// owner-attention listener. Each tap wakes the helper for every keystroke or mouse move on the Mac,
/// so they are installed when a session begins and removed when it ends (explicit release, Esc, or
/// the idle timeout), not kept for the life of the process.
public enum SessionTapKind: Sendable, Equatable {
    case escStop
    case attention
}

/// A live tap. `remove` is idempotent, never blocks, and is safe to call from the tap's own callback.
public protocol SessionTapHandle: AnyObject, Sendable {
    func remove()
}

/// Installs a tap of one kind; nil when the system refuses (no Accessibility).
public protocol SessionTapInstaller: Sendable {
    func install(_ kind: SessionTapKind) -> (any SessionTapHandle)?
    /// Why the last `install` returned nil, as the installer itself saw it.
    func failureAfterInstall(_ kind: SessionTapKind) -> SessionTapFailure
}

public enum SessionTapFailure: Sendable, Equatable {
    case permission
    /// The tap was requested but did not become ready in time; worth retrying.
    case timeout
    /// Accessibility is granted yet the system would not create the tap; retrying will not help.
    case createFailed
}

extension SessionTapInstaller {
    public func failureAfterInstall(_ kind: SessionTapKind) -> SessionTapFailure { .permission }
}

/// Runs `fire` once after `delay`; the returned closure cancels it.
public typealias SessionTapScheduler = @Sendable (TimeInterval, @escaping @Sendable () -> Void) -> @Sendable () -> Void

public enum SessionTapTimer {
    public static let live: SessionTapScheduler = { delay, fire in
        let source = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "com.psyche.helper.session-taps", qos: .utility))
        source.schedule(deadline: .now() + delay, leeway: .seconds(5))
        source.setEventHandler(handler: fire)
        source.resume()
        return { source.cancel() }
    }
}

public enum AttentionSeed {
    /// When the owner last gave input, read from the system idle clock as a tap is installed. nil when
    /// that last event could be the helper's own (it posted within `slack` of it), so the helper's
    /// previous session never counts as the owner being at the Mac.
    public static func ownerInput(now: Date, idle: TimeInterval, lastHelperPost: Date, slack: TimeInterval = 1) -> Date? {
        guard idle.isFinite, idle >= 0 else { return nil }
        let at = now.addingTimeInterval(-idle)
        return at > lastHelperPost.addingTimeInterval(slack) ? at : nil
    }
}

/// Owns the lifecycle ordering: the Esc stop is installed BEFORE a session lock is taken, and is
/// removed only after the lock is gone. If the Esc tap cannot be installed, the session does not
/// start (fail closed). Install, acquire and remove-on-idle all run under one lock, so a session
/// that starts while an old one is being torn down keeps its taps.
public final class SessionTaps: @unchecked Sendable {
    private let lock = NSLock()
    private let installer: any SessionTapInstaller
    private let sessions: ComputerSessionLock
    private let schedule: SessionTapScheduler
    private var esc: (any SessionTapHandle)?
    private var attention: (any SessionTapHandle)?
    private var cancelIdle: (@Sendable () -> Void)?
    /// Called with the session id when its action outlived `maxInFlight` and the session was released.
    /// Runs with the session lock held, before the session is released: trip the stop signal and
    /// nothing else. It must never re-enter `ComputerSessionLock`.
    public var onOverlong: (@Sendable (String) -> Void)?
    /// Runs after the session lock is released (log, notify).
    public var afterOverlong: (@Sendable (String) -> Void)?
    /// Runs the deferred reconcile of `stopActiveFromTap`; tests replace it to run inline or capture.
    public var dispatchReconcile: @Sendable (@escaping @Sendable () -> Void) -> Void = { work in
        DispatchQueue.global(qos: .userInitiated).async(execute: work)
    }

    public init(installer: any SessionTapInstaller, sessions: ComputerSessionLock, schedule: @escaping SessionTapScheduler = SessionTapTimer.live) {
        self.installer = installer
        self.sessions = sessions
        self.schedule = schedule
    }

    public var isInstalled: Bool {
        lock.withLock { esc != nil }
    }

    /// Esc tap first, then the session lock, so no action can run without the Esc stop. With
    /// `invocation`, the action is also marked in flight atomically with taking the session; end it
    /// with `endInvocation`.
    @discardableResult
    public func beginSession(_ id: String, invocation: Bool = false) throws -> Int? {
        try lock.withLock {
            if esc == nil {
                guard let tap = installer.install(.escStop) else {
                    switch installer.failureAfterInstall(.escStop) {
                    case .timeout:
                        throw CapabilityError.unavailable("esc_tap_timeout", "Computer use could not start its Esc stop in time. Try again.", retryable: true)
                    case .createFailed:
                        throw CapabilityError.unavailable("esc_tap_failed", "The system refused to create the Esc stop for computer use.")
                    case .permission:
                        throw CapabilityError.permissionMissing(.accessibility)
                    }
                }
                esc = tap
            }
            if attention == nil { attention = installer.install(.attention) }  // best effort: no record fails closed
            let token: Int?
            do { token = try sessions.acquire(id, markInFlight: invocation) } catch {
                removeIfIdleLocked()
                throw error
            }
            armIdleLocked()
            return token
        }
    }

    /// An action of `id` started (after `beginSession`): the session stays active, and its taps stay,
    /// until `endInvocation`, however long the action runs.
    public func beginInvocation(_ id: String) { sessions.beginInvocation(id) }

    /// The action ended: completes a deferred `end_session`, then removes the taps if idle.
    public func endInvocation(_ id: String, token: Int? = nil) {
        sessions.endInvocation(id, token: token)
        reconcile()
    }

    /// Releases the session lock (deferred while an action of it runs), then removes the taps if nothing holds it.
    public func release(_ id: String) {
        sessions.release(id)
        reconcile()
    }

    /// Esc: stops the active session, then removes the taps.
    @discardableResult
    public func stopActive() -> String? {
        let stopped = sessions.stopActive()
        reconcile()
        return stopped
    }

    /// Esc callback variant: trips the session synchronously, but removes the taps off the callback's
    /// thread. `reconcile` takes the tap lock, which another thread can hold for seconds while it
    /// installs a tap; the held Esc keyDown must not wait for that.
    @discardableResult
    public func stopActiveFromTap() -> String? {
        let stopped = sessions.stopActive()
        dispatchReconcile { [weak self] in self?.reconcile() }
        return stopped
    }

    /// Removes the taps when no session is active (an idle session expires without a release).
    public func reconcile() {
        // An action that has run past the hard cap loses the session; trip the stop signal so it ends.
        // The stop is tripped before the session is released, so nothing sees it inactive while it runs.
        if let id = sessions.reapOverlong(trip: { id in onOverlong?(id) }) { afterOverlong?(id) }
        lock.withLock {
            if sessions.activeSession == nil { removeIfIdleLocked() } else { armIdleLocked() }
        }
    }

    private func removeIfIdleLocked() {
        guard sessions.activeSession == nil else { return }
        cancelIdle?()
        cancelIdle = nil
        esc?.remove()
        attention?.remove()
        esc = nil
        attention = nil
    }

    private func armIdleLocked() {
        cancelIdle?()
        // Wake for the idle timeout, or sooner for the hard cap on a running action.
        var delay = sessions.idleTimeout + 1
        if let untilCap = sessions.timeUntilCap() { delay = min(delay, max(0.05, untilCap)) }
        cancelIdle = schedule(delay) { [weak self] in self?.reconcile() }
    }
}
