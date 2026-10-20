import Darwin
import Foundation

public enum NodeSocketError: Error, Equatable, CustomStringConvertible {
    case socketMissing(path: String)
    case pathTooLong(path: String)
    case connectFailed(path: String, errno: Int32)
    case io(errno: Int32)
    case timedOut
    case closedByPeer

    public var description: String {
        switch self {
        case .socketMissing(let path):
            return "Gateway node socket not found at \(path). Start the Gateway (psyched) or set PSYCHE_NODE_SOCKET."
        case .pathTooLong(let path):
            return "Socket path is too long for AF_UNIX (\(path.utf8.count) bytes): \(path)"
        case .connectFailed(let path, let err):
            return "Could not connect to \(path): \(String(cString: strerror(err)))"
        case .io(let err):
            return "Socket I/O error: \(String(cString: strerror(err)))"
        case .timedOut:
            return "Timed out waiting for the Gateway"
        case .closedByPeer:
            return "The Gateway closed the connection"
        }
    }
}

/// Blocking AF_UNIX stream socket (POSIX; no Network.framework).
public final class UnixSocketConnection: @unchecked Sendable {
    public let fd: Int32
    private var closed = false
    private let lock = NSLock()

    /// Wraps an already-connected descriptor (tests use `socketpair`).
    public init(fd: Int32) {
        self.fd = fd
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    }

    public convenience init(path: String) throws {
        guard FileManager.default.fileExists(atPath: path) else { throw NodeSocketError.socketMissing(path: path) }
        var addr = sockaddr_un()
        let pathBytes = Array(path.utf8)
        guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            throw NodeSocketError.pathTooLong(path: path)
        }
        addr.sun_family = sa_family_t(AF_UNIX)
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in
            buf.copyBytes(from: pathBytes)
            buf[pathBytes.count] = 0
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw NodeSocketError.io(errno: errno) }
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if rc != 0 {
            let err = errno
            Darwin.close(fd)
            if err == ENOENT { throw NodeSocketError.socketMissing(path: path) }
            throw NodeSocketError.connectFailed(path: path, errno: err)
        }
        self.init(fd: fd)
    }

    deinit { close() }

    /// Closes the descriptor. Writes after this throw instead of reaching a reused fd number.
    public func close() {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        closed = true
        Darwin.shutdown(fd, SHUT_RDWR)
        Darwin.close(fd)
    }

    /// Hands the descriptor to the caller (who must close it) without shutting it down.
    public func releaseDescriptor() -> Int32? {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return nil }
        closed = true
        return fd
    }

    /// Wakes a blocked reader with EOF without releasing the fd (safe from any thread); the owner
    /// closes once its read loop has returned.
    public func shutdown() {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        Darwin.shutdown(fd, SHUT_RDWR)
    }

    public var isClosed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return closed
    }

    public func write(_ data: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { throw NodeSocketError.closedByPeer }
        try data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            var offset = 0
            while offset < buf.count {
                let n = Darwin.write(fd, buf.baseAddress!.advanced(by: offset), buf.count - offset)
                if n < 0 {
                    if errno == EINTR { continue }
                    throw NodeSocketError.io(errno: errno)
                }
                offset += n
            }
        }
    }

    /// Reads whatever is available before `deadline`. Returns `nil` on EOF.
    public func read(before deadline: Date, maxBytes: Int = 64 * 1024) throws -> Data? {
        while true {
            if isClosed { return nil }
            let remainingMs = Int32(max(0, min(Double(Int32.max), deadline.timeIntervalSinceNow * 1000)))
            if remainingMs == 0 { throw NodeSocketError.timedOut }
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let ready = poll(&pfd, 1, remainingMs)
            if ready < 0 {
                if errno == EINTR { continue }
                throw NodeSocketError.io(errno: errno)
            }
            if ready == 0 { throw NodeSocketError.timedOut }
            var buffer = [UInt8](repeating: 0, count: maxBytes)
            let n = Darwin.read(fd, &buffer, maxBytes)
            if n < 0 {
                if errno == EINTR || errno == EAGAIN { continue }
                throw NodeSocketError.io(errno: errno)
            }
            if n == 0 { return nil }
            return Data(buffer[0..<n])
        }
    }
}
