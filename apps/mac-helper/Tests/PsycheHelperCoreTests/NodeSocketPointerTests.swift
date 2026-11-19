import Darwin
import Foundation
import PsycheHelperCore
import Testing

/// A fresh `$PSYCHE_HOME` with an empty `run/` directory, under the temp dir. `deep` pads it past
/// what `run/node.sock` can fit in `sun_path`, the case where the Gateway falls back to a temp socket.
private func tempHome(deep: Bool = false) throws -> String {
    var home = (NSTemporaryDirectory() as NSString).appendingPathComponent("psyche-ptr-\(UUID().uuidString)")
    if deep { home = (home as NSString).appendingPathComponent(String(repeating: "d", count: 80)) }
    try FileManager.default.createDirectory(atPath: home + "/run", withIntermediateDirectories: true)
    return home
}

private func writePointer(_ home: String, _ text: String) throws {
    let file = home + "/run/node-socket"
    try Data(text.utf8).write(to: URL(fileURLWithPath: file))
    chmod(file, 0o600)
}

private func cleanUp(_ home: String) {
    try? FileManager.default.removeItem(atPath: home)
}

/// A private socket directory like the Gateway's fallback (`ensureSocketDir`: mode 0700, ours),
/// short enough for `sun_path`.
private func privateSocketDir(mode: mode_t = 0o700) throws -> String {
    let dir = "/tmp/pptr-\(UInt32.random(in: 0...UInt32.max))"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: false)
    chmod(dir, mode)
    return dir
}

/// A socket path shaped like the Gateway's fallback (`<private dir>/<16 hex>.sock`).
private func fallbackSocketPath(in dir: String) -> String {
    let hash = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(16))
    return "\(dir)/\(hash).sock"
}

/// A listening AF_UNIX socket standing in for the Gateway's node socket.
private func listenUnix(_ path: String) -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    withUnsafeMutableBytes(of: &addr.sun_path) { buf in
        buf.copyBytes(from: bytes)
        buf[bytes.count] = 0
    }
    let size = socklen_t(MemoryLayout<sockaddr_un>.size)
    let rc: Int32 = withUnsafePointer(to: &addr) { p in
        p.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, size) }
    }
    guard rc == 0, listen(fd, 4) == 0 else {
        close(fd)
        return -1
    }
    return fd
}

@Suite("Node socket pointer ($PSYCHE_HOME/run/node-socket)")
struct NodeSocketPointerTests {
    @Test func environmentWinsOverThePointer() throws {
        let home = try tempHome()
        let dir = try privateSocketDir()
        defer { cleanUp(home); cleanUp(dir) }
        try writePointer(home, fallbackSocketPath(in: dir) + "\n")
        let env = ["PSYCHE_HOME": home, "PSYCHE_NODE_SOCKET": "/x/n.sock"]
        #expect(HelperPaths.nodeSocketPath(environment: env) == "/x/n.sock")
        #expect(HelperPaths.guestSocketPath(environment: env) == "/x/n-guest.sock")
    }

    @Test func aValidPointerIsUsed() throws {
        let home = try tempHome(deep: true)
        let dir = try privateSocketDir()
        defer { cleanUp(home); cleanUp(dir) }
        let target = fallbackSocketPath(in: dir)
        try writePointer(home, target + "\n")
        #expect(HelperPaths.nodeSocketPointerPath(environment: ["PSYCHE_HOME": home]) == home + "/run/node-socket")
        #expect(HelperPaths.nodeSocketPath(environment: ["PSYCHE_HOME": home]) == target)
    }

    @Test func onlyTheFirstLineCountsAndItIsTrimmed() throws {
        let home = try tempHome()
        let dir = try privateSocketDir()
        defer { cleanUp(home); cleanUp(dir) }
        let target = fallbackSocketPath(in: dir)
        try writePointer(home, "  \(target) \r\n/other/path.sock\n")
        #expect(HelperPaths.nodeSocketPath(environment: ["PSYCHE_HOME": home]) == target)
    }

    @Test func aMissingPointerFallsBack() throws {
        let home = try tempHome()
        defer { cleanUp(home) }
        #expect(HelperPaths.readNodeSocketPointer(environment: ["PSYCHE_HOME": home]) == nil)
        #expect(HelperPaths.nodeSocketPath(environment: ["PSYCHE_HOME": home]) == home + "/run/node.sock")
        #expect(HelperPaths.guestSocketPath(environment: ["PSYCHE_HOME": home]) == home + "/run/guest.sock")
    }

    @Test func aSymlinkPointerIsIgnored() throws {
        let home = try tempHome()
        let dir = try privateSocketDir()
        defer { cleanUp(home); cleanUp(dir) }
        let real = home + "/elsewhere"
        try Data((fallbackSocketPath(in: dir) + "\n").utf8).write(to: URL(fileURLWithPath: real))
        chmod(real, 0o600)
        // The same contents as a regular file would be used, so only the symlink is refused.
        try writePointer(home, fallbackSocketPath(in: dir) + "\n")
        #expect(HelperPaths.readNodeSocketPointer(environment: ["PSYCHE_HOME": home]) != nil)
        try FileManager.default.removeItem(atPath: home + "/run/node-socket")
        try FileManager.default.createSymbolicLink(atPath: home + "/run/node-socket", withDestinationPath: real)
        #expect(HelperPaths.readNodeSocketPointer(environment: ["PSYCHE_HOME": home]) == nil)
        #expect(HelperPaths.nodeSocketPath(environment: ["PSYCHE_HOME": home]) == home + "/run/node.sock")
    }

    @Test func aDirectoryAtThePointerPathIsIgnored() throws {
        let home = try tempHome()
        defer { cleanUp(home) }
        try FileManager.default.createDirectory(atPath: home + "/run/node-socket", withIntermediateDirectories: false)
        #expect(HelperPaths.nodeSocketPath(environment: ["PSYCHE_HOME": home]) == home + "/run/node.sock")
    }

    @Test(arguments: [
        "relative/path.sock\n", // not absolute
        "psyche-501/abc.sock\n", // not absolute
        "\n", // empty first line
        "", // empty file
    ])
    func anUnusablePointerFallsBack(_ contents: String) throws {
        let home = try tempHome()
        defer { cleanUp(home) }
        try writePointer(home, contents)
        #expect(HelperPaths.readNodeSocketPointer(environment: ["PSYCHE_HOME": home]) == nil)
        #expect(HelperPaths.nodeSocketPath(environment: ["PSYCHE_HOME": home]) == home + "/run/node.sock")
    }

    @Test func aPathOfExactlyTheLimitIsUsed() throws {
        let home = try tempHome()
        let dir = try privateSocketDir()
        defer { cleanUp(home); cleanUp(dir) }
        let target = dir + "/" + String(repeating: "a", count: HelperPaths.maxSocketPathBytes - dir.utf8.count - 1)
        #expect(target.utf8.count == HelperPaths.maxSocketPathBytes)
        try writePointer(home, target + "\n")
        #expect(HelperPaths.nodeSocketPath(environment: ["PSYCHE_HOME": home]) == target)
    }

    @Test func theLengthAndNULChecksHoldInAPrivateDirectory() throws {
        // Same private directory for every case, so only the length or NUL check can reject.
        let home = try tempHome()
        let dir = try privateSocketDir()
        defer { cleanUp(home); cleanUp(dir) }
        let env = ["PSYCHE_HOME": home]
        let fits = dir + "/" + String(repeating: "a", count: HelperPaths.maxSocketPathBytes - dir.utf8.count - 1)
        #expect(fits.utf8.count == 103)
        try writePointer(home, fits + "\n")
        #expect(HelperPaths.readNodeSocketPointer(environment: env) == fits)

        let tooLong = fits + "a"
        #expect(tooLong.utf8.count == 104)
        try writePointer(home, tooLong + "\n")
        #expect(HelperPaths.readNodeSocketPointer(environment: env) == nil)
        #expect(HelperPaths.nodeSocketPath(environment: env) == home + "/run/node.sock")

        try writePointer(home, dir + "/a\0b.sock\n")
        #expect(HelperPaths.readNodeSocketPointer(environment: env) == nil)
        #expect(HelperPaths.nodeSocketPath(environment: env) == home + "/run/node.sock")
    }

    @Test func anOversizedPointerFileIsIgnored() throws {
        let home = try tempHome()
        let dir = try privateSocketDir()
        defer { cleanUp(home); cleanUp(dir) }
        try writePointer(home, fallbackSocketPath(in: dir) + "\n" + String(repeating: "x", count: 5000))
        #expect(HelperPaths.nodeSocketPath(environment: ["PSYCHE_HOME": home]) == home + "/run/node.sock")
    }

    @Test func theGuestSocketSitsNextToThePointedSocket() throws {
        // The Gateway derives the guest socket from the node socket it actually listens on
        // (`resolveGuestSocketPath`): `<hash>.sock` -> `<hash>-guest.sock` in the same directory.
        let home = try tempHome(deep: true)
        let dir = try privateSocketDir()
        defer { cleanUp(home); cleanUp(dir) }
        try writePointer(home, dir + "/0123456789abcdef.sock\n")
        #expect(HelperPaths.guestSocketPath(environment: ["PSYCHE_HOME": home]) == dir + "/0123456789abcdef-guest.sock")
        // An explicit guest socket still wins.
        #expect(HelperPaths.guestSocketPath(environment: ["PSYCHE_HOME": home, "PSYCHE_GUEST_SOCKET": "/g.sock"]) == "/g.sock")
    }

    @Test func theHelperConnectsThroughThePointerWhenTheHomeIsDeep() throws {
        let home = try tempHome(deep: true)
        defer { cleanUp(home) }
        // run/node.sock cannot fit in sun_path here; the Gateway would listen elsewhere.
        #expect((home + "/run/node.sock").utf8.count > HelperPaths.maxSocketPathBytes)
        let dir = try privateSocketDir()
        defer { cleanUp(dir) }
        let socketPath = dir + "/0123456789abcdef.sock"
        let listener = listenUnix(socketPath)
        #expect(listener >= 0)
        defer { close(listener) }
        try writePointer(home, socketPath + "\n")

        let resolved = HelperPaths.nodeSocketPath(environment: ["PSYCHE_HOME": home])
        #expect(resolved == socketPath)
        let conn = try UnixSocketConnection(path: resolved)
        conn.close()
    }

    @Test(arguments: [0o777 as mode_t, 0o755, 0o750, 0o701])
    func aPointerIntoASharedDirectoryFallsBack(_ mode: mode_t) throws {
        // A stale pointer into a temp dir someone else could have recreated is not followed.
        let home = try tempHome(deep: true)
        let dir = try privateSocketDir(mode: mode)
        defer { cleanUp(home); cleanUp(dir) }
        try writePointer(home, fallbackSocketPath(in: dir) + "\n")
        #expect(HelperPaths.readNodeSocketPointer(environment: ["PSYCHE_HOME": home]) == nil)
        #expect(HelperPaths.nodeSocketPath(environment: ["PSYCHE_HOME": home]) == home + "/run/node.sock")
    }

    @Test func aPointerThroughASymlinkedDirectoryFallsBack() throws {
        let home = try tempHome(deep: true)
        let dir = try privateSocketDir()
        let link = "/tmp/pptr-link-\(UInt32.random(in: 0...UInt32.max))"
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: dir)
        defer { cleanUp(home); cleanUp(dir); cleanUp(link) }
        try writePointer(home, link + "/0123456789abcdef.sock\n")
        #expect(HelperPaths.nodeSocketPath(environment: ["PSYCHE_HOME": home]) == home + "/run/node.sock")
    }

    @Test func aPointerIntoAMissingDirectoryFallsBack() throws {
        let home = try tempHome(deep: true)
        defer { cleanUp(home) }
        try writePointer(home, "/tmp/pptr-missing-\(UUID().uuidString)/0123456789abcdef.sock\n")
        #expect(HelperPaths.nodeSocketPath(environment: ["PSYCHE_HOME": home]) == home + "/run/node.sock")
    }

    @Test func aFIFOPointerIsIgnoredWithoutBlocking() throws {
        let home = try tempHome()
        defer { cleanUp(home) }
        #expect(mkfifo(home + "/run/node-socket", 0o600) == 0)
        #expect(HelperPaths.readNodeSocketPointer(environment: ["PSYCHE_HOME": home]) == nil)
        #expect(HelperPaths.nodeSocketPath(environment: ["PSYCHE_HOME": home]) == home + "/run/node.sock")
    }
}

@Suite("Node socket peer check (getpeereid)")
struct NodeSocketPeerTests {
    @Test func aPeerRunningAsThisUserIsAccepted() throws {
        let dir = try privateSocketDir()
        defer { cleanUp(dir) }
        let path = dir + "/n.sock"
        let listener = listenUnix(path)
        #expect(listener >= 0)
        defer { close(listener) }
        let conn = try UnixSocketConnection(path: path)
        conn.close()
        let explicit = try UnixSocketConnection(path: path, expectedPeerUID: getuid())
        explicit.close()
    }

    @Test func aPeerRunningAsAnotherUserIsRefused() throws {
        let dir = try privateSocketDir()
        defer { cleanUp(dir) }
        let path = dir + "/n.sock"
        let listener = listenUnix(path)
        #expect(listener >= 0)
        defer { close(listener) }
        let other = getuid() &+ 1
        #expect(throws: NodeSocketError.peerNotOwner(path: path, uid: getuid())) {
            try UnixSocketConnection(path: path, expectedPeerUID: other)
        }
        #expect(NodeSocketError.peerNotOwner(path: path, uid: 0).description.contains("owned by another user"))
    }
}
