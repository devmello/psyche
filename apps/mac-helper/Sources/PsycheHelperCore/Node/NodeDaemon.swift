import Foundation
import PsycheProtocol
import PsycheWire

/// Keeps the helper connected: connect → handshake → serve, reconnecting with capped exponential
/// backoff when the Gateway restarts, while pairing is pending, or after a denial.
public final class NodeDaemon: @unchecked Sendable {
    /// What the Gateway rewrites when it starts: the socket pointer and the per-launch handshake secret.
    /// Other files in `run/` (update progress, pid files) change all the time and say nothing about it.
    public struct RunFingerprint: Sendable, Equatable {
        public struct FileMark: Sendable, Equatable {
            var inode: UInt64
            var mtimeSec: Int
            var mtimeNsec: Int
        }
        public var socket: FileMark?
        public var secret: FileMark?

        public static func read(environment: [String: String]) -> RunFingerprint {
            RunFingerprint(
                socket: mark(HelperPaths.nodeSocketPointerPath(environment: environment)),
                secret: mark(HelperPaths.handshakeSecretPath(environment: environment)))
        }

        private static func mark(_ path: String) -> FileMark? {
            var st = stat()
            guard lstat(path, &st) == 0 else { return nil }
            return FileMark(inode: UInt64(st.st_ino), mtimeSec: Int(st.st_mtimespec.tv_sec), mtimeNsec: Int(st.st_mtimespec.tv_nsec))
        }
    }

    public struct Backoff: Sendable, Equatable {
        public var initial: TimeInterval = 0.5
        public var max: TimeInterval = 30
        public var pendingRetry: TimeInterval = 5
        public var deniedRetry: TimeInterval = 300
        public init() {}

        /// Delay before attempt `n` (0-based) after consecutive failures.
        public func delay(afterFailures n: Int) -> TimeInterval {
            Swift.min(max, initial * pow(2, Double(Swift.max(0, n))))
        }

        /// `delay` with equal jitter: half fixed, half random, so a Gateway restart does not bring
        /// every client back in the same instant. `random` is in [0, 1); the result never exceeds `delay`.
        public func jittered(_ delay: TimeInterval, random: Double) -> TimeInterval {
            let r = Swift.min(Swift.max(random, 0), 1)
            return delay / 2 + delay / 2 * r
        }
    }

    public enum Outcome: Sendable, Equatable {
        case served
        case pending(code: String?)
        case denied
        case failed
    }

    /// A session that lasts at least this long counts as healthy and resets the back-off.
    static let healthySession: TimeInterval = 10

    /// The next failure count and base delay after a session that `lasted` seconds before the
    /// Gateway closed it: a healthy one starts over at `initial`; a short one keeps climbing the
    /// capped schedule, so a drop right after pairing cannot loop at the initial 0.5 s.
    static func afterServed(failures: Int, lasted: TimeInterval, backoff: Backoff) -> (failures: Int, delay: TimeInterval) {
        if lasted >= healthySession { return (0, backoff.initial) }
        return (failures + 1, backoff.delay(afterFailures: failures))
    }

    /// The shortest pause before an immediate reconnect after a Gateway-up signal.
    static let minRetryGap: TimeInterval = 0.25

    private let identity: DeviceIdentity
    private let registry: CapabilityRegistry
    private let preflight: any PermissionPreflight
    private let log: HelperLog
    private let environment: [String: String]
    private let backoff: Backoff
    private let lock = NSLock()
    private var stopped = false
    private var current: FrameChannel?
    // Reconnect waits block on this condition instead of polling: zero wakeups while waiting.
    private let wait = NSCondition()
    private var waiting = false
    private var wakeRequested = false
    private var waitFingerprint = RunFingerprint(socket: nil, secret: nil)
    private var waitIsDenied = false
    private let random: @Sendable () -> Double

    public init(
        identity: DeviceIdentity, registry: CapabilityRegistry, preflight: any PermissionPreflight, log: HelperLog,
        environment: [String: String] = ProcessInfo.processInfo.environment, backoff: Backoff = Backoff(),
        random: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) }
    ) {
        self.random = random
        self.identity = identity
        self.registry = registry
        self.preflight = preflight
        self.log = log
        self.environment = environment
        self.backoff = backoff
    }

    /// Runs until `stop()`; blocks the calling thread.
    public func run() {
        var failures = 0
        while !isStopped {
            let delay: TimeInterval
            var denied = false
            let baseline = RunFingerprint.read(environment: environment)
            let began = Date()
            switch runOnce() {
            case .served:
                // A connection that drops right after pairing is not a healthy session: back off
                // like a failure instead of reconnecting every half second.
                let step = Self.afterServed(
                    failures: failures, lasted: Date().timeIntervalSince(began), backoff: backoff)
                failures = step.failures
                delay = step.delay
            case .pending:
                delay = backoff.jittered(backoff.pendingRetry, random: random())
            case .denied:
                denied = true
                delay = backoff.jittered(backoff.deniedRetry, random: random())
            case .failed:
                delay = backoff.jittered(backoff.delay(afterFailures: failures), random: random())
                failures += 1
            }
            if sleepUnlessStopped(delay, denied: denied, baseline: baseline) { failures = 0 }  // woken by a Gateway-up signal: start the schedule over
        }
    }

    /// Something in `run/` changed. Cuts the current wait short and reconnects now only if the Gateway
    /// really restarted: `run/node-socket` or `run/handshake.secret` is a different file or was
    /// rewritten since the wait began. A denied or revoked wait (300 s) ends only on a new
    /// `handshake.secret`, since a Gateway restart is what makes a denial worth retrying. Ignored while
    /// connected. The fingerprint check is what keeps a noisy `run/` from spinning the loop.
    public func gatewayMayBeUp(now: Date = Date()) {
        let seen = RunFingerprint.read(environment: environment)
        wait.lock()
        defer { wait.unlock() }
        guard waiting, restarted(seen) else { return }
        wakeRequested = true
        wait.broadcast()
    }

    /// One connect → handshake → serve cycle.
    public func runOnce() -> Outcome {
        let path = HelperPaths.nodeSocketPath(environment: environment)
        do {
            let channel = FrameChannel(socket: try UnixSocketConnection(path: path))
            setCurrent(channel)
            defer {
                setCurrent(nil)
                channel.close()
            }
            let client = NodeHandshakeClient(
                identity: identity,
                options: NodeHandshakeOptions(
                    timeout: 10, handshakeSecret: HelperPaths.readHandshakeSecret(environment: environment),
                    capabilities: registry.manifestEntries
                ),
                log: log
            )
            guard case .completed(let result) = try client.perform(on: channel) else { return .failed }
            switch result.phase {
            case "paired":
                log.info("serving capabilities=\(registry.ordered.count)")
                let session = NodeSession(channel: channel, registry: registry, preflight: preflight, log: log)
                try session.serve()
                log.info("gateway closed the connection")
                return .served
            case "pending":
                // The pairing code is shown to the user to compare in the desktop app; it is not a secret.
                log.info("pairing pending: approve this device in Psyche (code \(result.code ?? "?"))")
                return .pending(code: result.code)
            default:
                log.error("pairing denied")
                return .denied
            }
        } catch let error as NodeSocketError {
            if case .socketMissing = error {} else { log.error(error.description) }
            return .failed
        } catch {
            log.error("connection failed: \(String(describing: type(of: error)))")
            return .failed
        }
    }

    public func stop() {
        lock.lock()
        stopped = true
        let channel = current
        lock.unlock()
        wait.lock()
        wait.broadcast()
        wait.unlock()
        channel?.shutdown()
    }

    private var isStopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    private func setCurrent(_ channel: FrameChannel?) {
        lock.lock()
        current = channel
        lock.unlock()
    }

    /// Whether `seen` shows a Gateway restart since the wait's baseline. Call with `wait` held.
    private func restarted(_ seen: RunFingerprint) -> Bool {
        if waitIsDenied { return seen.secret != waitFingerprint.secret }
        return seen.socket != waitFingerprint.socket || seen.secret != waitFingerprint.secret
    }

    /// Waits up to `seconds` on a condition that `stop()` and `gatewayMayBeUp` signal. True if woken early
    /// by the Gateway-up signal.
    @discardableResult
    func sleepUnlessStopped(_ seconds: TimeInterval, denied: Bool = false, baseline: RunFingerprint? = nil) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        let current = RunFingerprint.read(environment: environment)
        wait.lock()
        defer { wait.unlock() }
        // The baseline is how `run/` looked before the attempt, so a restart that landed while the
        // attempt was failing is seen at once instead of being waited out.
        waitFingerprint = baseline ?? current
        waitIsDenied = denied
        waiting = true
        wakeRequested = restarted(current)
        defer { waiting = false }
        let started = Date()
        while !isStopped, !wakeRequested, Date() < deadline {
            _ = wait.wait(until: deadline)
        }
        // However early the signal came, an immediate reconnect still waits `minRetryGap`, so a process
        // rewriting `run/node-socket` in a loop cannot drive back-to-back handshakes.
        if wakeRequested {
            let gapEnd = started.addingTimeInterval(Self.minRetryGap)
            while !isStopped, Date() < gapEnd { _ = wait.wait(until: gapEnd) }
        }
        return wakeRequested && !isStopped
    }
}
