import Darwin
import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import PsycheProtocol
import Testing

final class FakeVMBackend: VMBackend, @unchecked Sendable {
    let lock = NSLock()
    var supportsGuestProvisioning = true
    var running: Set<String> = []
    var calls: [String] = []
    var lastProvisioning: GuestProvisioning?
    var lastShares: [ShareGrant] = []
    var gatewayHandler: (@Sendable (Int32) -> Void)?
    var installFails = false
    var latest = RestoreImageInfo(url: URL(string: "https://updates.cdn-apple.com/x/UniversalMac_27.0.1_26A434_Restore.ipsw")!, version: "27.0.1", build: "26A434", sizeBytes: 26_600_000_000)

    func record(_ s: String) { lock.withLock { calls.append(s) } }
    var activeCount: Int { lock.withLock { running.count } }
    func isRunning(_ name: String) -> Bool { lock.withLock { running.contains(name) } }
    func latestRestoreImage() async throws -> RestoreImageInfo { record("latest"); return latest }
    func loadRestoreImage(_ url: URL) async throws -> RestoreImageInfo { record("load"); return RestoreImageInfo(url: url, version: latest.version, build: latest.build) }
    func download(_ image: RestoreImageInfo, to file: URL, progress: @escaping @Sendable (Double) -> Void) async throws {
        record("download")
        progress(0.5)
        FileManager.default.createFile(atPath: file.path, contents: Data("ipsw".utf8))
        progress(1)
    }
    func prepareBundle(_ bundle: VMBundle, config: VMConfig, image: URL) async throws {
        record("prepare")
        // Stand-ins for the files VZ writes, so snapshots and image export have something to copy.
        try Data("hw".utf8).write(to: bundle.hardwareModelURL)
        try Data("machine".utf8).write(to: bundle.machineIdentifierURL)
        try Data("aux".utf8).write(to: bundle.auxiliaryStorageURL)
        try Data("disk".utf8).write(to: bundle.diskURL(format: config.diskFormat))
    }
    func prepareImported(_ bundle: VMBundle, config: VMConfig) async throws {
        record("prepareImported")
        try Data(UUID().uuidString.utf8).write(to: bundle.machineIdentifierURL)
    }
    func install(_ bundle: VMBundle, config: VMConfig, image: URL, progress: @escaping @Sendable (Double) -> Void) async throws {
        record("install")
        if installFails { throw CapabilityError(.unavailable, reason: "vz_error", "boom") }
        progress(1)
    }
    var lastRestore: URL?
    var lastSystem: VMSystemShares?
    var restoreFails = false
    var paused: Set<String> = []
    var display: Set<String> = []
    /// Serves guest.* like the guest helper (nil: no agent listening).
    var agentOps: (any GuestOperations)?

    func start(_ bundle: VMBundle, config: VMConfig, shares: [ShareGrant], system: VMSystemShares, provisioning: GuestProvisioning?,
               restoreFrom: URL?, onGatewayConnection: @escaping @Sendable (Int32) -> Void, onStop: @escaping @Sendable (String?) -> Void) async throws {
        if restoreFrom != nil, restoreFails { throw CapabilityError(.unavailable, reason: "restore_failed", "x") }
        lock.withLock {
            calls.append(restoreFrom == nil ? "start" : "restore")
            lastProvisioning = provisioning
            lastShares = shares
            lastSystem = system
            lastRestore = restoreFrom
            gatewayHandler = onGatewayConnection
            running.insert(config.name)
        }
    }
    func stop(_ name: String, force: Bool) async throws -> Bool {
        lock.withLock { calls.append("stop force=\(force)"); running.remove(name) }
        return !force
    }
    func pause(_ name: String) async throws { _ = lock.withLock { paused.insert(name) } }
    func resume(_ name: String) async throws { _ = lock.withLock { paused.remove(name) } }
    func saveState(_ name: String, to url: URL) async throws {
        FileManager.default.createFile(atPath: url.path, contents: Data("state".utf8))
        lock.withLock { calls.append("save"); running.remove(name) }
    }
    func setShares(_ name: String, shares: [ShareGrant], system: VMSystemShares) async throws {
        lock.withLock { calls.append("setShares \(shares.count)"); lastShares = shares; lastSystem = system }
    }
    func setDisplay(_ name: String, visible: Bool) async throws { _ = lock.withLock { visible ? display.insert(name).inserted : display.remove(name) != nil } }
    func connectGuestAgent(_ name: String) async throws -> Int32 {
        guard let ops = agentOps else { throw CapabilityError(.unavailable, reason: "guest_agent_unreachable", "no agent", retryable: true) }
        var fds: [Int32] = [0, 0]
        _ = socketpair(AF_UNIX, SOCK_STREAM, 0, &fds)
        let server = GuestAgentServer(ops: ops, log: HelperLog(echo: { _ in }))
        let guestFD = fds[1]
        Thread.detachNewThread { server.serve(FrameChannel(socket: UnixSocketConnection(fd: guestFD))) }
        return fds[0]
    }
    func isPaused(_ name: String) -> Bool { lock.withLock { paused.contains(name) } }
    func isDisplayVisible(_ name: String) -> Bool { lock.withLock { display.contains(name) } }

}

final class MemorySecrets: VMSecretStore, @unchecked Sendable {
    let lock = NSLock()
    var items: [String: Data] = [:]
    func store(name: String, secret: Data) async throws { lock.withLock { items[name] = secret } }
    func read(name: String) async throws -> Data {
        guard let d = lock.withLock({ items[name] }) else { throw CapabilityError(.notFound, reason: "item_not_found", "none") }
        return d
    }
    func delete(name: String) async throws { _ = lock.withLock { items.removeValue(forKey: name) } }
}

private func manager(_ backend: FakeVMBackend, home: URL, secrets: MemorySecrets = MemorySecrets()) -> VMManager {
    VMManager(backend: backend, secrets: secrets, environment: ["PSYCHE_HOME": home.appendingPathComponent(".psyche").path, "PSYCHE_NODE_SOCKET": home.appendingPathComponent("n.sock").path],
              host: { HostResources(cpuCount: 10, memoryGB: 16, freeDiskGB: 200, osMajor: 27) }, log: HelperLog(echo: { _ in }))
}

private func tempHome() -> URL {
    // Short path: AF_UNIX paths are limited to 104 bytes.
    let u = URL(fileURLWithPath: "/tmp/pvm-\(UInt32.random(in: 0...UInt32.max))", isDirectory: true)
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u
}

/// A stand-in Gateway node socket.
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
    guard rc == 0, listen(fd, 4) == 0 else { return -1 }
    return fd
}

private final class Events: @unchecked Sendable {
    let lock = NSLock()
    var items: [JSONValue] = []
    func add(_ e: JSONValue) { lock.withLock { items.append(e) } }
    var types: [String] { lock.withLock { items.compactMap { $0["type"]?.stringValue } } }
}

@Suite("VM manager (L1–L5) against a fake backend", .serialized)
struct VMManagerTests {
    @Test func createNeedsADownloadConfirmationThenInstalls() async throws {
        let home = tempHome()
        let backend = FakeVMBackend()
        let vm = manager(backend, home: home)
        do {
            _ = try await vm.create(.init(), emit: { _ in })
            Issue.record("expected download_not_confirmed")
        } catch let e as CapabilityError {
            #expect(e.reason == "download_not_confirmed" && e.message.contains("27.0.1") && e.message.contains("26.6 GB"))
        }
        let events = Events()
        let out = try await vm.create(.init(download: true), emit: { events.add($0) })
        #expect(out["phase"] == "installed" && out["guestOS"] == "27.0.1" && out["cpus"] == 4)
        #expect(backend.calls == ["latest", "latest", "download", "load", "prepare", "install"])
        #expect(events.types.contains("vm.download") && events.types.contains("vm.install"))
        // One guest per user.
        do {
            _ = try await vm.create(.init(name: "second", download: true), emit: { _ in })
            Issue.record("expected guest_exists")
        } catch let e as CapabilityError {
            #expect(e.reason == "guest_exists")
        }
    }

    @Test func failedInstallIsRecorded() async throws {
        let home = tempHome()
        let backend = FakeVMBackend()
        backend.installFails = true
        let vm = manager(backend, home: home)
        let ipsw = home.appendingPathComponent("local.ipsw")
        FileManager.default.createFile(atPath: ipsw.path, contents: Data())
        await #expect(throws: CapabilityError.self) { _ = try await vm.create(.init(ipsw: ipsw.path), emit: { _ in }) }
        #expect(vm.status()["guests"]?.arrayValue?.first?["phase"] == "failed")
    }

    @Test func firstStartProvisionsAndStoresThePassword() async throws {
        let home = tempHome()
        let backend = FakeVMBackend()
        let secrets = MemorySecrets()
        let vm = manager(backend, home: home, secrets: secrets)
        _ = try await vm.create(.init(download: true), emit: { _ in })
        let out = try await vm.start(name: "sandbox", emit: { _ in })
        #expect(out["phase"] == "running" && out["provisioned"] == true)
        let p = try #require(backend.lastProvisioning)
        #expect(p.username == "psyche" && p.autoLogin && p.remoteLogin && p.password.count == 24)
        #expect(secrets.items["sandbox"] == Data(p.password.utf8))
        // A second boot does not provision again.
        _ = try await vm.stop(name: "sandbox", force: false)
        _ = try await vm.start(name: "sandbox", emit: { _ in })
        #expect(backend.lastProvisioning == nil)
        let stopped = try await vm.stop(name: "sandbox", force: true)
        #expect(stopped["graceful"] == false && stopped["phase"] == "stopped")
        _ = try await vm.delete(name: "sandbox")
        #expect(secrets.items.isEmpty && vm.status()["guests"]?.arrayValue?.isEmpty == true)
    }

    @Test func provisioningNeedsMacOS27() async throws {
        let home = tempHome()
        let backend = FakeVMBackend()
        backend.supportsGuestProvisioning = false
        let vm = manager(backend, home: home)
        _ = try await vm.create(.init(download: true), emit: { _ in })
        do {
            _ = try await vm.start(name: "sandbox", emit: { _ in })
            Issue.record("expected provisioning_unsupported")
        } catch let e as CapabilityError {
            #expect(e.reason == "provisioning_unsupported")
        }
    }

    @Test func sharesApplyLiveAndReadWriteNeedsApproval() async throws {
        let home = tempHome()
        let folder = home.appendingPathComponent("Projects")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let backend = FakeVMBackend()
        let vm = manager(backend, home: home)
        _ = try await vm.create(.init(download: true), emit: { _ in })
        _ = try await vm.addShare(name: "sandbox", share: "projects", path: folder.path, readOnly: true, approvalId: nil)
        _ = try await vm.start(name: "sandbox", emit: { _ in })
        #expect(backend.lastShares.map(\.name) == ["projects"])  // persisted grants are attached at boot
        await #expect(throws: CapabilityError.self) {
            _ = try await vm.addShare(name: "sandbox", share: "rw", path: folder.path, readOnly: false, approvalId: nil)
        }
        let out = try await vm.addShare(name: "sandbox", share: "rw", path: folder.path, readOnly: false, approvalId: "appr_1")
        #expect(out["shares"]?.arrayValue?.count == 2 && backend.calls.last == "setShares 2")
        _ = try await vm.removeShare(name: "sandbox", share: "projects")
        #expect(backend.calls.last == "setShares 1")
    }

    @Test func guestNodeStreamsAreRelayedToTheGatewaySocket() async throws {
        let home = tempHome()
        let listenFD = listenUnix(home.appendingPathComponent("n.sock").path)
        #expect(listenFD >= 0)
        defer { Darwin.close(listenFD) }

        let backend = FakeVMBackend()
        let vm = manager(backend, home: home)
        _ = try await vm.create(.init(download: true), emit: { _ in })
        _ = try await vm.start(name: "sandbox", emit: { _ in })
        // The "guest" side of a vsock connection.
        var pair: [Int32] = [0, 0]
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0)
        let handler = try #require(backend.gatewayHandler)
        handler(pair[1])
        let accepted = await withCheckedContinuation { (c: CheckedContinuation<Int32, Never>) in
            DispatchQueue.global().async { c.resume(returning: accept(listenFD, nil, nil)) }
        }
        let gateway = UnixSocketConnection(fd: accepted)
        let guest = UnixSocketConnection(fd: pair[0])
        let connect = Data(#"{"type":"req","id":"connect","method":"connect"}"#.utf8 + [0x0A])
        try guest.write(connect)
        #expect(try gateway.read(before: Date().addingTimeInterval(2)) == connect)
        try gateway.write(Data("ok\n".utf8))
        #expect(try guest.read(before: Date().addingTimeInterval(2)) == Data("ok\n".utf8))
        _ = try await vm.stop(name: "sandbox", force: false)  // closes relays
        #expect(try guest.read(before: Date().addingTimeInterval(2)) == nil)
    }

    @Test func statusMatchesTheProtocolSchema() async throws {
        let home = tempHome()
        let folder = home.appendingPathComponent("Projects")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let vm = manager(FakeVMBackend(), home: home)
        _ = try await vm.create(.init(download: true), emit: { _ in })
        _ = try await vm.addShare(name: "sandbox", share: "projects", path: folder.path, readOnly: true, approvalId: nil)
        _ = try await vm.start(name: "sandbox", emit: { _ in })
        // packages/protocol schemas/vm.ts VmStatus, through the generated Swift model.
        let decoded = try JSONDecoder().decode(VMStatus.self, from: JSONEncoder().encode(vm.status()))
        #expect(decoded.guests.first?.phase == .running && decoded.guests.first?.shares.first?.readOnly == true)
        #expect(decoded.guests.first?.vsock.gatewayNodePort == 7980 && decoded.maxActive == 2)
    }

    @Test func capabilitiesDeclareSideEffects() {
        let caps = VMCapabilities.make(manager(FakeVMBackend(), home: tempHome()))
        let specs = Dictionary(uniqueKeysWithValues: caps.map { ($0.spec.name, $0.spec) })
        #expect(Set(specs.keys) == [
            "vm.status", "vm.restore_image", "vm.create", "vm.start", "vm.stop", "vm.delete", "vm.share_add", "vm.share_remove", "vm.pause",
            "vm.resume", "vm.suspend", "vm.configure", "vm.display", "vm.agent_status", "vm.copy_in", "vm.copy_out", "vm.install_psyche",
            "vm.grant_permissions", "vm.watch", "vm.snapshot", "vm.restore", "vm.reset", "vm.snapshot_delete", "vm.export_image",
        ])
        #expect(specs["vm.reset"]?.sideEffect == .destructive && specs["vm.restore"]?.sideEffect == .destructive)
        #expect(specs["vm.snapshot"]?.sideEffect == .write && specs["vm.snapshot_delete"]?.sideEffect == .destructive)
        #expect(specs["vm.watch"]?.streaming == true && specs["vm.watch"]?.sideEffect == .read)
        #expect(specs["vm.copy_out"]?.targetKind == .path && specs["vm.copy_out"]?.receiptKind == "vm_transfer")
        for (name, spec) in specs where spec.sideEffect == .write || spec.sideEffect == .destructive { #expect(spec.receiptKind != nil, "\(name)") }
        #expect(specs["vm.delete"]?.sideEffect == .destructive && specs["vm.status"]?.sideEffect == .read)
        #expect(specs["vm.create"]?.streaming == true && specs["vm.share_add"]?.targetKind == .path)
    }
}

/// Real Virtualization.framework, read-only: never downloads or boots. Opt in with
/// PSYCHE_VM_LIVE_TESTS=1 on a helper signed with com.apple.security.virtualization;
/// set PSYCHE_VM_IPSW to also load a local IPSW's requirements.
@Suite("VM live (PSYCHE_VM_LIVE_TESTS=1)", .enabled(if: ProcessInfo.processInfo.environment["PSYCHE_VM_LIVE_TESTS"] == "1"))
struct VMLiveTests {
    @Test func catalogAndLocalImage() async throws {
        let backend = VZBackend()
        let latest = try await backend.latestRestoreImage()
        #expect(!latest.version.isEmpty && !latest.build.isEmpty)
        if let path = ProcessInfo.processInfo.environment["PSYCHE_VM_IPSW"] {
            let info = try await backend.loadRestoreImage(URL(fileURLWithPath: path))
            #expect(!info.version.isEmpty)
        }
    }
}
