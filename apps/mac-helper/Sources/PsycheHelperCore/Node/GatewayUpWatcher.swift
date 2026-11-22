import Foundation

/// Calls `onChange` when something in `$PSYCHE_HOME/run` changes. The Gateway rewrites
/// `run/node-socket` on every start, so a directory write is the "Gateway is up" signal that lets the
/// daemon skip the rest of its backoff (the daemon checks which file changed before it acts). A vnode
/// source: no polling, no wakeups while nothing changes. It only reads the directory's change
/// events; it never reads or follows what the Gateway wrote.
///
/// If `run/` is deleted or renamed and made again, the descriptor would stay on the old directory and
/// the watcher would go deaf, so it re-opens the path (retrying until the directory exists).
public final class GatewayUpWatcher: @unchecked Sendable {
    private let dir: String
    private let onChange: @Sendable () -> Void
    private let retryInterval: TimeInterval
    private let queue = DispatchQueue(label: "com.psyche.helper.gateway-up", qos: .utility)
    private let lock = NSLock()
    private var source: DispatchSourceFileSystemObject?
    private var closed = false

    /// If the directory does not exist yet, the watcher keeps retrying until it does.
    public init(
        environment: [String: String] = ProcessInfo.processInfo.environment, retryInterval: TimeInterval = 2,
        onChange: @escaping @Sendable () -> Void
    ) {
        dir = (HelperPaths.nodeSocketPointerPath(environment: environment) as NSString).deletingLastPathComponent
        self.onChange = onChange
        self.retryInterval = retryInterval
        if !open() { queue.asyncAfter(deadline: .now() + retryInterval) { [weak self] in self?.attemptReopen() } }
    }

    private func open() -> Bool {
        let fd = Darwin.open(dir, O_EVTONLY)
        guard fd >= 0 else { return false }
        let s = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: queue)
        s.setEventHandler { [weak self, weak s] in
            guard let self, let s else { return }
            if s.data.contains(.delete) || s.data.contains(.rename) { self.reopen(after: s) }
            self.onChange()
        }
        s.setCancelHandler { Darwin.close(fd) }
        let accepted: Bool = lock.withLock {
            guard !closed else { return false }
            source = s
            return true
        }
        guard accepted else {
            s.setEventHandler {}
            s.resume()
            s.cancel()
            return true
        }
        s.resume()
        return true
    }

    /// The watched directory went away: drop the dead source and re-open the path, now or when it returns.
    private func reopen(after old: DispatchSourceFileSystemObject) {
        lock.withLock { if source === old { source = nil } }
        old.cancel()
        attemptReopen()
    }

    private func attemptReopen() {
        if lock.withLock({ closed }) { return }
        if open() {
            onChange()  // the directory came back: whatever it holds now is new
        } else {
            queue.asyncAfter(deadline: .now() + retryInterval) { [weak self] in self?.attemptReopen() }
        }
    }

    deinit {
        let s: DispatchSourceFileSystemObject? = lock.withLock {
            closed = true
            defer { source = nil }
            return source
        }
        s?.cancel()
    }
}
