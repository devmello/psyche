import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import PsycheHelperCore
import PsycheProtocol

/// AF_VSOCK sockets (macOS guests; `sys/vsock.h`).
public enum Vsock {
    public static let hostCID: UInt32 = 2

    static func address(cid: UInt32, port: UInt32) -> sockaddr_vm {
        var a = sockaddr_vm()
        a.svm_len = UInt8(MemoryLayout<sockaddr_vm>.size)
        a.svm_family = sa_family_t(AF_VSOCK)
        a.svm_cid = cid
        a.svm_port = port
        return a
    }

    public static func connect(cid: UInt32, port: UInt32) throws -> Int32 {
        let fd = socket(AF_VSOCK, SOCK_STREAM, 0)
        guard fd >= 0 else { throw CapabilityError.unavailable("vsock_unavailable", "This system has no vsock") }
        var a = address(cid: cid, port: port)
        let rc = withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_vm>.size)) } }
        guard rc == 0 else {
            Darwin.close(fd)
            throw CapabilityError(.unavailable, reason: "vsock_connect", "Could not reach \(cid):\(port) over vsock", retryable: true)
        }
        return fd
    }

    /// Listens on `port` for any CID and calls `onAccept` for connections from the host only.
    public static func listen(port: UInt32, onAccept: @escaping @Sendable (Int32) -> Void) throws {
        let fd = socket(AF_VSOCK, SOCK_STREAM, 0)
        guard fd >= 0 else { throw CapabilityError.unavailable("vsock_unavailable", "This system has no vsock") }
        var a = address(cid: UInt32(bitPattern: -1), port: port)  // VMADDR_CID_ANY
        let rc = withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_vm>.size)) } }
        guard rc == 0, Darwin.listen(fd, 4) == 0 else {
            Darwin.close(fd)
            throw CapabilityError.unavailable("vsock_listen", "Could not listen on vsock port \(port)")
        }
        Thread.detachNewThread {
            while true {
                var peer = sockaddr_vm()
                var len = socklen_t(MemoryLayout<sockaddr_vm>.size)
                let c = withUnsafeMutablePointer(to: &peer) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { accept(fd, $0, &len) } }
                if c < 0 { if errno == EINTR { continue } else { return } }
                // Only the host may drive the guest agent (a process inside the guest must not).
                guard peer.svm_cid == hostCID else { Darwin.close(c); continue }
                onAccept(c)
            }
        }
    }

    /// `psyche-helper vsock-bridge CID:PORT`: relays stdin/stdout to a vsock stream, the bridge
    /// psyche-node needs in a macOS guest (apps/node `PSYCHE_NODE_VSOCK_BRIDGE`).
    public static func bridge(cid: UInt32, port: UInt32) throws -> Never {
        let fd = try connect(cid: cid, port: port)
        let done = DispatchSemaphore(value: 0)
        @Sendable func pump(_ from: Int32, _ to: Int32) {
            var buf = [UInt8](repeating: 0, count: 64 * 1024)
            while true {
                let n = read(from, &buf, buf.count)
                if n < 0, errno == EINTR { continue }
                if n <= 0 { break }
                var off = 0
                while off < n {
                    let w = buf.withUnsafeBytes { write(to, $0.baseAddress!.advanced(by: off), n - off) }
                    if w <= 0 { done.signal(); return }
                    off += w
                }
            }
            done.signal()
        }
        Thread.detachNewThread { pump(0, fd) }
        Thread.detachNewThread { pump(fd, 1) }
        done.wait()
        exit(0)
    }
}

/// The guest helper (runs inside the macOS guest).
public enum GuestAgent {
    public static func isGuest() -> Bool {
        var v: Int32 = 0
        var size = MemoryLayout<Int32>.size
        return sysctlbyname("kern.hv_vmm_present", &v, &size, nil, 0) == 0 && v == 1
    }

    /// Starts the vsock 7000 listener when this helper runs inside a VM; no-op on a host.
    public static func startIfGuest(log: HelperLog) {
        guard isGuest() else { return }
        let server = GuestAgentServer(ops: LiveGuestOperations(), log: log)
        do {
            try Vsock.listen(port: VsockPorts.guestControl) { fd in
                Thread.detachNewThread { server.serve(FrameChannel(socket: UnixSocketConnection(fd: fd))) }
            }
            log.info("guest agent listening on vsock \(VsockPorts.guestControl)")
        } catch {
            log.error("guest agent: vsock listen failed")
        }
    }
}

/// Live guest operations. Root work goes through `sudo -S` with the provisioning password the
/// host sends (never stored in the guest).
struct LiveGuestOperations: GuestOperations {
    static let sharesMount = "/Volumes/Psyche Shares"

    func status() -> JSONValue {
        ["accessibility": .bool(AXIsProcessTrusted()), "screenRecording": .bool(CGPreflightScreenCaptureAccess()),
         "sharesMounted": .bool(FileManager.default.fileExists(atPath: Self.sharesMount + "/_psyche-out"))]
    }

    func sudo(_ password: String, _ argv: [String]) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/sudo")
        p.arguments = ["-S", "-p", ""] + argv
        p.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        let input = Pipe()
        p.standardInput = input
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
        input.fileHandleForWriting.write(Data((password + "\n").utf8))
        try? input.fileHandleForWriting.close()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else {
            throw CapabilityError(.unavailable, reason: "guest_sudo_failed", "\(argv.first ?? "command") failed in the guest (\(p.terminationStatus))")
        }
    }

    func shutdown(password: String) throws { try sudo(password, ["/sbin/shutdown", "-h", "now"]) }

    func mountShares(password: String) throws {
        if FileManager.default.fileExists(atPath: Self.sharesMount + "/_psyche-out") { return }
        try sudo(password, ["/bin/mkdir", "-p", Self.sharesMount])
        try sudo(password, ["/sbin/mount_virtiofs", ShareGrant.userTag, Self.sharesMount])
    }

    func export(path: String, transferId: String) throws -> Int {
        let src = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        let values = try? src.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values?.isRegularFile == true, let size = values?.fileSize else {
            throw CapabilityError(.notFound, reason: "not_a_file", "\(path) is not a file in the guest")
        }
        guard size <= 1 << 30 else { throw CapabilityError.invalidParams("files over 1 GB are not copied out", field: "guestPath") }
        let dir = URL(fileURLWithPath: Self.sharesMount).appendingPathComponent("_psyche-out").appendingPathComponent(transferId)
        guard FileManager.default.fileExists(atPath: dir.deletingLastPathComponent().path) else {
            throw CapabilityError(.unavailable, reason: "shares_not_mounted", "The transfer share is not mounted in the guest", retryable: true)
        }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: src, to: dir.appendingPathComponent(src.lastPathComponent))
        return size
    }
}
