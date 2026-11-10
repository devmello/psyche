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
    /// defensively: it must be a small regular file owned by this user (not a symlink), and its
    /// first line, trimmed, must be an absolute path that fits `sun_path`. Anything else is ignored
    /// and the caller falls back to `run/node.sock`.
    public static func readNodeSocketPointer(environment env: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        let file = nodeSocketPointerPath(environment: env)
        var info = stat()
        guard lstat(file, &info) == 0,
              (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == getuid(),
              info.st_size > 0, info.st_size <= Int64(maxPointerFileBytes)
        else { return nil }
        guard let handle = FileHandle(forReadingAtPath: file) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: maxPointerFileBytes),
              let text = String(data: data, encoding: .utf8)
        else { return nil }
        let firstLine = text.split(maxSplits: 1, omittingEmptySubsequences: false, whereSeparator: \.isNewline).first ?? ""
        let path = firstLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard path.hasPrefix("/"),
              !path.contains("\0"),
              path.utf8.count <= maxSocketPathBytes
        else { return nil }
        return path
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
