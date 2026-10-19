import Foundation
import PsycheProtocol

/// Keeps the helper connected: connect → handshake → serve, reconnecting with capped exponential
/// backoff when the Gateway restarts, while pairing is pending, or after a denial.
public final class NodeDaemon: @unchecked Sendable {
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
    }

    public enum Outcome: Sendable, Equatable {
        case served
        case pending(code: String?)
        case denied
        case failed
    }

    private let identity: DeviceIdentity
    private let registry: CapabilityRegistry
    private let preflight: any PermissionPreflight
    private let log: HelperLog
    private let environment: [String: String]
    private let backoff: Backoff
    private let lock = NSLock()
    private var stopped = false
    private var current: FrameChannel?

    public init(
        identity: DeviceIdentity, registry: CapabilityRegistry, preflight: any PermissionPreflight, log: HelperLog,
        environment: [String: String] = ProcessInfo.processInfo.environment, backoff: Backoff = Backoff()
    ) {
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
            switch runOnce() {
            case .served:
                failures = 0
                delay = backoff.initial
            case .pending:
                delay = backoff.pendingRetry
            case .denied:
                delay = backoff.deniedRetry
            case .failed:
                delay = backoff.delay(afterFailures: failures)
                failures += 1
            }
            sleepUnlessStopped(delay)
        }
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
        channel?.close()
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

    private func sleepUnlessStopped(_ seconds: TimeInterval) {
        let deadline = Date().addingTimeInterval(seconds)
        while !isStopped, Date() < deadline {
            Thread.sleep(forTimeInterval: Swift.min(0.25, deadline.timeIntervalSinceNow))
        }
    }
}
