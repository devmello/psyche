import Darwin
import Foundation

/// Filesystem locations from the wire spec: `$PSYCHE_HOME` defaults to `~/.psyche`; the node socket
/// is `PSYCHE_NODE_SOCKET`, else the path the Gateway recorded in `$PSYCHE_HOME/run/node-socket`,
/// else `$PSYCHE_HOME/run/node.sock`.
public enum HelperPaths {
    /// `sun_path` holds 104 bytes on macOS, including the terminating NUL (the Gateway's
    /// `MAX_SOCKET_PATH_BYTES`).
    public static let maxSocketPathBytes = 103

    /// The pointer is one short line; anything bigger is not the Gateway's.
    static let maxPointerFileBytes = 4096

    public static func psycheHome(environment env: [String: String] = ProcessInfo.processInfo.environment) -> String {
        if let home = env["PSYCHE_HOME"], !home.isEmpty { return home }
        return (NSHomeDirectory() as NSString).appendingPathComponent(".psyche")
    }

    public static func nodeSocketPath(environment env: [String: String] = ProcessInfo.processInfo.environment) -> String {
        if let path = env["PSYCHE_NODE_SOCKET"], !path.isEmpty { return path }
        if let path = readNodeSocketPointer(environment: env) { return path }
        return (psycheHome(environment: env) as NSString).appendingPathComponent("run/node.sock")
    }

    /// `$PSYCHE_HOME/run/node-socket`: where the Gateway records the node socket it actually
    /// listens on (`writeSocketPointer`). When `$PSYCHE_HOME` is too deep for `run/node.sock` that
    /// is a private temp path (`psyche-<uid>/<hash>.sock`), so this file is the only way to find it.
    public static func nodeSocketPointerPath(environment env: [String: String] = ProcessInfo.processInfo.environment) -> String {
        (psycheHome(environment: env) as NSString).appendingPathComponent("run/node-socket")
    }

    /// The socket path from the Gateway's pointer file, or nil when there is no usable pointer. Read
    /// defensively, and anything that fails a check is ignored so the caller falls back to
    /// `run/node.sock`:
    /// - the file is opened with `O_NOFOLLOW | O_NONBLOCK` (no symlink, no blocking on a FIFO) and
    ///   checked with `fstat` on that descriptor: a regular file owned by this user, 1–4096 bytes;
    /// - its first line, trimmed, is an absolute path that fits `sun_path`, with no NUL;
    /// - the socket's directory is private like the Gateway's `ensureSocketDir`: a real directory
    ///   (not a symlink) owned by this user with no group or other permission bits. A stale pointer
    ///   into a shared temp dir another account recreated is not followed.
    public static func readNodeSocketPointer(environment env: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        guard let data = readPrivateSmallFile(nodeSocketPointerPath(environment: env), limit: maxPointerFileBytes),
              let text = String(data: data, encoding: .utf8)
        else { return nil }
        let firstLine = text.split(maxSplits: 1, omittingEmptySubsequences: false, whereSeparator: \.isNewline).first ?? ""
        let path = firstLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard path.hasPrefix("/"),
              !path.contains("\0"),
              path.utf8.count <= maxSocketPathBytes,
              isPrivateDirectory((path as NSString).deletingLastPathComponent)
        else { return nil }
        return path
    }

    /// The contents of a regular file owned by this user and at most `limit` bytes, read from one
    /// descriptor (no check-then-open race), or nil.
    static func readPrivateSmallFile(_ file: String, limit: Int) -> Data? {
        let fd = open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0,
              (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == getuid(),
              info.st_size > 0, info.st_size <= Int64(limit)
        else { return nil }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: limit + 1)
        while data.count <= limit {
            let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if n < 0, errno == EINTR { continue }
            guard n >= 0 else { return nil }
            if n == 0 { break }
            data.append(contentsOf: buffer[0..<n])
        }
        // The file grew after fstat: not the Gateway's one-line pointer.
        guard !data.isEmpty, data.count <= limit else { return nil }
        return data
    }

    /// A real directory (lstat: not a symlink) owned by this user, with `(mode & 0o077) == 0`.
    static func isPrivateDirectory(_ dir: String) -> Bool {
        var info = stat()
        return lstat(dir, &info) == 0
            && (info.st_mode & S_IFMT) == S_IFDIR
            && info.st_uid == getuid()
            && (info.st_mode & 0o077) == 0
    }

    /// Where the Gateway accepts relayed sandbox guests (`PSYCHE_GUEST_SOCKET`, else next to the
    /// node socket: `node.sock` -> `guest.sock`, `<x>.sock` -> `<x>-guest.sock`). The node socket
    /// here is the resolved one, pointer included, so a deep `$PSYCHE_HOME` gives
    /// `psyche-<uid>/<hash>-guest.sock` next to the Gateway's fallback node socket. The Host helper
    /// copies each guest psyche-node stream here and never into the node socket, so the Gateway
    /// can tell a guest from the Host's own helper whatever the guest declares. The Gateway
    /// derives the same path (`resolveGuestSocketPath`).
    public static func guestSocketPath(environment env: [String: String] = ProcessInfo.processInfo.environment) -> String {
        if let path = env["PSYCHE_GUEST_SOCKET"], !path.isEmpty { return path }
        let node = nodeSocketPath(environment: env) as NSString
        let base = node.lastPathComponent
        let name: String
        if base == "node.sock" {
            name = "guest.sock"
        } else if base.hasSuffix(".sock") {
            name = String(base.dropLast(".sock".count)) + "-guest.sock"
        } else {
            name = base + "-guest.sock"
        }
        return (node.deletingLastPathComponent as NSString).appendingPathComponent(name)
    }

    public static func handshakeSecretPath(environment env: [String: String] = ProcessInfo.processInfo.environment) -> String {
        (psycheHome(environment: env) as NSString).appendingPathComponent("run/handshake.secret")
    }

    /// The per-launch handshake secret, if the Gateway wrote one (trimmed). Never logged.
    public static func readHandshakeSecret(environment env: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        guard let data = FileManager.default.contents(atPath: handshakeSecretPath(environment: env)),
              let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty
        else { return nil }
        return text
    }
}
