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

/// A short absolute path that fits `sun_path`, shaped like the Gateway's fallback
/// (`<tmp>/psyche-<uid>/<16 hex>.sock`).
private func fallbackSocketPath() -> String {
    let hash = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(16))
    return "/tmp/psyche-\(getuid())/\(hash).sock"
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
        defer { cleanUp(home) }
        try writePointer(home, fallbackSocketPath() + "\n")
        let env = ["PSYCHE_HOME": home, "PSYCHE_NODE_SOCKET": "/x/n.sock"]
        #expect(HelperPaths.nodeSocketPath(environment: env) == "/x/n.sock")
        #expect(HelperPaths.guestSocketPath(environment: env) == "/x/n-guest.sock")
    }

    @Test func aValidPointerIsUsed() throws {
        let home = try tempHome(deep: true)
        defer { cleanUp(home) }
        let target = fallbackSocketPath()
        try writePointer(home, target + "\n")
        #expect(HelperPaths.nodeSocketPointerPath(environment: ["PSYCHE_HOME": home]) == home + "/run/node-socket")
        #expect(HelperPaths.nodeSocketPath(environment: ["PSYCHE_HOME": home]) == target)
    }

    @Test func onlyTheFirstLineCountsAndItIsTrimmed() throws {
        let home = try tempHome()
        defer { cleanUp(home) }
        let target = fallbackSocketPath()
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
        defer { cleanUp(home) }
        let real = home + "/elsewhere"
        try Data((fallbackSocketPath() + "\n").utf8).write(to: URL(fileURLWithPath: real))
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
        "/" + String(repeating: "a", count: 103) + "\n", // 104 bytes: too long for sun_path
        "/tmp/a\0b.sock\n", // embedded NUL
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
        defer { cleanUp(home) }
        let target = "/" + String(repeating: "a", count: HelperPaths.maxSocketPathBytes - 1)
        #expect(target.utf8.count == HelperPaths.maxSocketPathBytes)
        try writePointer(home, target + "\n")
        #expect(HelperPaths.nodeSocketPath(environment: ["PSYCHE_HOME": home]) == target)
    }

    @Test func anOversizedPointerFileIsIgnored() throws {
        let home = try tempHome()
        defer { cleanUp(home) }
        try writePointer(home, fallbackSocketPath() + "\n" + String(repeating: "x", count: 5000))
        #expect(HelperPaths.nodeSocketPath(environment: ["PSYCHE_HOME": home]) == home + "/run/node.sock")
    }

    @Test func theGuestSocketSitsNextToThePointedSocket() throws {
        // The Gateway derives the guest socket from the node socket it actually listens on
        // (`resolveGuestSocketPath`): `<hash>.sock` -> `<hash>-guest.sock` in the same directory.
        let home = try tempHome(deep: true)
        defer { cleanUp(home) }
        try writePointer(home, "/tmp/psyche-501/0123456789abcdef.sock\n")
        #expect(HelperPaths.guestSocketPath(environment: ["PSYCHE_HOME": home]) == "/tmp/psyche-501/0123456789abcdef-guest.sock")
        // An explicit guest socket still wins.
        #expect(HelperPaths.guestSocketPath(environment: ["PSYCHE_HOME": home, "PSYCHE_GUEST_SOCKET": "/g.sock"]) == "/g.sock")
    }

    @Test func theHelperConnectsThroughThePointerWhenTheHomeIsDeep() throws {
        let home = try tempHome(deep: true)
        defer { cleanUp(home) }
        // run/node.sock cannot fit in sun_path here; the Gateway would listen elsewhere.
        #expect((home + "/run/node.sock").utf8.count > HelperPaths.maxSocketPathBytes)
        let dir = "/tmp/pptr-\(UInt32.random(in: 0...UInt32.max))"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
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
}
