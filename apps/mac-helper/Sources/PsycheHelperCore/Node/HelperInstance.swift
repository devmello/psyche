import Foundation

/// One helper per `$PSYCHE_HOME` (packaging contract, docs/archive/status/s14.md): the desktop runs
/// `open` on every start, so a second copy must find the lock taken and exit quietly.
public final class SingleInstanceLock: @unchecked Sendable {
    private let fd: Int32

    private init(fd: Int32) { self.fd = fd }

    /// `$PSYCHE_HOME/run/helper.lock`.
    public static func path(environment env: [String: String] = ProcessInfo.processInfo.environment) -> String {
        (HelperPaths.psycheHome(environment: env) as NSString).appendingPathComponent("run/helper.lock")
    }

    /// Takes the lock, or nil when another process holds it. The lock lasts until `release()` or
    /// process exit (the kernel drops it with the descriptor, so a crash never leaves it stale).
    public static func acquire(path: String) -> SingleInstanceLock? {
        try? FileManager.default.createDirectory(
            atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return nil }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            close(fd)
            return nil
        }
        let pid = "\(getpid())\n"
        _ = ftruncate(fd, 0)
        _ = pid.withCString { write(fd, $0, strlen($0)) }
        return SingleInstanceLock(fd: fd)
    }

    public func release() {
        flock(fd, LOCK_UN)
        close(fd)
    }
}

/// Notices when the helper's own executable is replaced or removed (Psyche.app updated or moved
/// to the Trash): the running copy then exits and the desktop's next `open` starts the new one.
public final class BundleWatcher: @unchecked Sendable {
    struct FileIdentity: Equatable {
        var device: Int32
        var inode: UInt64
    }

    private let path: String
    private let original: FileIdentity?
    private let interval: TimeInterval
    private let onChange: @Sendable () -> Void
    private var timer: DispatchSourceTimer?
    private let lock = NSLock()
    private var fired = false

    public init(executablePath: String, interval: TimeInterval = 30, onChange: @escaping @Sendable () -> Void) {
        path = executablePath
        original = Self.identity(executablePath)
        self.interval = interval
        self.onChange = onChange
    }

    static func identity(_ path: String) -> FileIdentity? {
        var st = stat()
        guard stat(path, &st) == 0 else { return nil }
        return FileIdentity(device: st.st_dev, inode: st.st_ino)
    }

    /// True once the file at the path is gone or is a different file.
    public var replaced: Bool {
        guard let original else { return false }
        return Self.identity(path) != original
    }

    /// Checks once; calls `onChange` the first time the executable is found replaced.
    @discardableResult
    public func check() -> Bool {
        guard replaced else { return false }
        lock.lock()
        let first = !fired
        fired = true
        lock.unlock()
        if first { onChange() }
        return true
    }

    public func start(queue: DispatchQueue = .global(qos: .utility)) {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + interval, repeating: interval, leeway: .seconds(2))
        t.setEventHandler { [weak self] in self?.check() }
        lock.lock()
        timer = t
        lock.unlock()
        t.resume()
    }

    public func stop() {
        lock.lock()
        timer?.cancel()
        timer = nil
        lock.unlock()
    }
}

/// How the running helper is signed, for `permissions.status.bundle` (doctor warns on ad-hoc:
/// TCC grants do not survive an ad-hoc upgrade).
public enum SigningKind: String, Sendable {
    case developerId = "developer_id"
    case development
    case adhoc
    case unsigned

    public static func classify(signed: Bool, adhoc: Bool, leafCommonName: String?) -> SigningKind {
        guard signed else { return .unsigned }
        if adhoc { return .adhoc }
        if leafCommonName?.hasPrefix("Developer ID Application") == true { return .developerId }
        return .development
    }
}
