import Darwin
import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import PsycheProtocol
import Testing

private final class FakeShell: GuestShell, @unchecked Sendable {
    let lock = NSLock()
    var runs: [(password: Bool, command: String)] = []
    var ip: String? = "192.168.64.4"
    var bootstrapStatus: Int32 = 0
    func address(mac: String) -> String? { ip }
    func ensureKey(in dir: URL) throws -> String { "ssh-ed25519 AAAAC3Nz psyche-helper" }
    func run(host: String, user: String, keyDir: URL, password: String?, command: String, timeout: TimeInterval) async throws -> (status: Int32, output: String) {
        lock.withLock { runs.append((password != nil, command)) }
        return (password == nil ? bootstrapStatus : 0, "")
    }
}

private final class FakeWriter: GuestPermissionWriter, @unchecked Sendable {
    let lock = NSLock()
    var granted: [GuestTCC.Client] = []
    func designatedRequirement(app: URL) throws -> Data { Data([0xFA, 0xDE]) }
    func grant(_ bundle: VMBundle, config: VMConfig, client: GuestTCC.Client) async throws { lock.withLock { granted.append(client) } }
}

/// Guest helper stand-in: writes exports straight into the host's `_psyche-out` staging folder,
/// as the VirtioFS share would.
private final class Ops: GuestOperations, @unchecked Sendable {
    let lock = NSLock()
    var calls: [String] = []
    let out: URL
    init(out: URL) { self.out = out }
    func status() -> JSONValue { ["accessibility": true, "screenRecording": true] }
    func shutdown(password: String) throws { lock.withLock { calls.append("shutdown") } }
    func mountShares(password: String) throws { lock.withLock { calls.append("mount") } }
    func export(path: String, transferId: String) throws -> Int {
        lock.withLock { calls.append("export") }
        let d = out.appendingPathComponent(transferId)
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        try Data("from the guest".utf8).write(to: d.appendingPathComponent(URL(fileURLWithPath: path).lastPathComponent))
        return 14
    }
}

private struct Rig {
    let home: URL
    let psyche: URL
    let backend = FakeVMBackend()
    let secrets = MemorySecrets()
    let shell = FakeShell()
    let writer = FakeWriter()
    let vm: VMManager

    init(grantedFolder: URL? = nil) {
        home = URL(fileURLWithPath: "/tmp/pvm3-\(UInt32.random(in: 0...UInt32.max))", isDirectory: true)
        psyche = home.appendingPathComponent(".psyche")
        try? FileManager.default.createDirectory(at: psyche, withIntermediateDirectories: true)
        if let g = grantedFolder {
            let cfg = #"{"permissions":{"folders":[{"path":"\#(g.path)","mode":"rw"}]}}"#
            try? Data(cfg.utf8).write(to: psyche.appendingPathComponent("config.json"))
        }
        vm = VMManager(backend: backend, secrets: secrets, shell: shell, permissions: writer,
                       environment: ["PSYCHE_HOME": psyche.path, "PSYCHE_NODE_SOCKET": home.appendingPathComponent("n.sock").path],
                       host: { HostResources(cpuCount: 10, memoryGB: 16, freeDiskGB: 200, osMajor: 27) }, log: HelperLog(echo: { _ in }))
    }

    func running() async throws {
        _ = try await vm.create(.init(download: true), emit: { _ in })
        _ = try await vm.start(name: "sandbox", emit: { _ in })
    }

    var bundle: VMBundle { try! VMBundle.named("sandbox", environment: ["PSYCHE_HOME": psyche.path]) }
}

private final class Collected: @unchecked Sendable {
    let lock = NSLock()
    var items: [JSONValue] = []
    func add(_ v: JSONValue) { lock.withLock { items.append(v) } }
    var phases: [String] { lock.withLock { items.compactMap { $0["guest"]?["phase"]?.stringValue } } }
}

@Suite("VM manager M3 (L1–L5) against fakes", .serialized)
struct VMManagerM3Tests {
    @Test func pauseResumeSuspendAndWarmStart() async throws {
        let r = Rig()
        try await r.running()
        #expect(try await r.vm.pause(name: "sandbox")["phase"] == "paused")
        #expect(try await r.vm.resume(name: "sandbox")["phase"] == "running")
        let saved = try await r.vm.suspend(name: "sandbox")
        #expect(saved["phase"] == "saved" && saved["savedState"] == true)
        _ = try await r.vm.start(name: "sandbox", emit: { _ in })
        #expect(r.backend.lastRestore == r.bundle.savedStateURL && r.backend.calls.last == "restore")
        #expect(!FileManager.default.fileExists(atPath: r.bundle.savedStateURL.path))  // consumed
        // A failed restore falls back to a cold boot and discards the state.
        _ = try await r.vm.suspend(name: "sandbox")
        r.backend.restoreFails = true
        let cold = try await r.vm.start(name: "sandbox", emit: { _ in })
        #expect(cold["phase"] == "running" && r.backend.calls.last == "start" && cold["savedState"] == false)
    }

    @Test func configureAndDisplay() async throws {
        let r = Rig()
        try await r.running()
        do {
            _ = try r.vm.configure(.init(cpus: 6))
            Issue.record("changed CPUs while running")
        } catch let e as CapabilityError {
            #expect(e.reason == "vm_running")
        }
        let clip = try r.vm.configure(.init(clipboard: "off", vault: "guest"))
        #expect(clip["clipboard"] == "off" && clip["vault"] == "guest")
        #expect(throws: CapabilityError.self) { try r.vm.configure(.init(clipboard: "everything")) }
        #expect(try await r.vm.setDisplay(name: "sandbox", visible: true)["display"]?["visible"] == true)
        _ = try await r.vm.stop(name: "sandbox", force: true)
        let bigger = try r.vm.configure(.init(cpus: 6, memoryGB: 10, displayWidth: 2560, displayHeight: 1600))
        #expect(bigger["cpus"] == 6 && bigger["display"]?["width"] == 2560)
        #expect(throws: CapabilityError.self) { try r.vm.configure(.init(memoryGB: 15)) }  // leaves the host < 4 GB
    }

    @Test func stopGoesThroughTheGuestAgent() async throws {
        let r = Rig()
        try await r.running()
        let ops = Ops(out: r.bundle.transferOutURL)
        r.backend.agentOps = ops
        let status = try await r.vm.ping(name: "sandbox")
        #expect(status["agent"]?["connected"] == true && status["agent"]?["version"] == "1" && status["agent"]?["accessibility"] == true)
        let stopped = try await r.vm.stop(name: "sandbox", force: false)
        #expect(stopped["graceful"] == true && ops.calls == ["shutdown"])
        #expect(stopped["agent"]?["connected"] == false)
    }

    @Test func copyInAndOutLeaveReceiptsAndStayInBounds() async throws {
        let granted = URL(fileURLWithPath: "/tmp/pvm3-out-\(UInt32.random(in: 0...UInt32.max))")
        try FileManager.default.createDirectory(at: granted, withIntermediateDirectories: true)
        let r = Rig(grantedFolder: granted)
        try await r.running()
        let file = r.home.appendingPathComponent("brief.txt")
        try Data("hello guest".utf8).write(to: file)
        let (inT, _) = try r.vm.copyIn(name: "sandbox", hostPath: file.path)
        #expect(inT.direction == "in" && inT.bytes == 11 && inT.guestPath.hasPrefix("/Volumes/My Shared Files/psyche-in/"))
        #expect(FileManager.default.fileExists(atPath: r.bundle.transferInURL.appendingPathComponent("\(inT.id)/brief.txt").path))
        #expect(throws: CapabilityError.self) { try r.vm.copyIn(name: "sandbox", hostPath: r.psyche.path) }  // Psyche's own data
        #expect(throws: CapabilityError.self) { try r.vm.copyIn(name: "sandbox", hostPath: "/etc/hosts") }

        r.backend.agentOps = Ops(out: r.bundle.transferOutURL)
        let (outT, guest) = try await r.vm.copyOut(name: "sandbox", guestPath: "/Users/psyche/report.txt", hostDir: granted.path)
        #expect(outT.direction == "out" && outT.hostPath == granted.appendingPathComponent("report.txt").path)
        #expect(try String(contentsOfFile: outT.hostPath, encoding: .utf8) == "from the guest")
        let (second, _) = try await r.vm.copyOut(name: "sandbox", guestPath: "/Users/psyche/report.txt", hostDir: granted.path)
        #expect(second.hostPath.hasSuffix("report 2.txt"))  // never overwrites
        #expect(guest["transfers"]?.arrayValue?.count == 2)
        await #expect(throws: CapabilityError.self) {
            _ = try await r.vm.copyOut(name: "sandbox", guestPath: "/x", hostDir: "/Users")  // outside granted folders
        }
    }

    @Test func installPsycheThenGrantPermissionsOffline() async throws {
        let r = Rig()
        try await r.running()
        let payload = r.home.appendingPathComponent("psyche-release")
        try FileManager.default.createDirectory(at: payload.appendingPathComponent("apps/node/scripts"), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: payload.appendingPathComponent("apps/node/scripts/guest-bootstrap.sh").path, contents: Data())
        try FileManager.default.createDirectory(at: payload.appendingPathComponent("Psyche Helper.app"), withIntermediateDirectories: true)
        await #expect(throws: CapabilityError.self) { _ = try await r.vm.installPsyche(name: "sandbox", payload: r.home.path, emit: { _ in }) }
        let out = try await r.vm.installPsyche(name: "sandbox", payload: payload.path, emit: { _ in })
        #expect(out["psycheInstalled"] == true)
        #expect(r.backend.lastSystem?.payload?.path == payload.resolvingSymlinksInPath().path)
        let runs = r.shell.runs
        #expect(runs.count == 2 && runs[0].password && !runs[1].password)
        #expect(runs[0].command.contains("authorized_keys") && !runs[0].command.contains("ssh-ed25519"))  // the key travels base64-encoded
        #expect(runs[1].command.contains("guest-bootstrap.sh") && runs[1].command.contains("--vsock 2:7980") && runs[1].command.contains("vsock-bridge"))
        await #expect(throws: CapabilityError.self) { _ = try await r.vm.grantPermissions(name: "sandbox", payload: payload.path, emit: { _ in }) }  // running
        _ = try await r.vm.stop(name: "sandbox", force: true)
        let granted = try await r.vm.grantPermissions(name: "sandbox", payload: payload.path, emit: { _ in })
        #expect(granted["permissionsGranted"] == true && r.writer.granted.first?.bundleId == "com.psyche.helper")
        // Flags survive the next boot.
        let again = try await r.vm.start(name: "sandbox", emit: { _ in })
        #expect(again["psycheInstalled"] == true && again["permissionsGranted"] == true)
    }

    @Test func watchStreamsStateChangesAndTeardown() async throws {
        let r = Rig()
        let seen = Collected()
        let (id, stream) = r.vm.events.subscribe()
        let reader = _Concurrency.Task {
            for await e in stream {
                seen.add(e)
                if e["type"] == "vm.deleted" { break }
            }
        }
        try await r.running()
        _ = try await r.vm.stop(name: "sandbox", force: true)
        _ = try await r.vm.delete(name: "sandbox")
        await reader.value
        r.vm.events.unsubscribe(id)
        #expect(seen.phases.contains("installed") && seen.phases.contains("running") && seen.phases.contains("stopped"))
        #expect(seen.items.last?["type"] == "vm.deleted")
        #expect(!FileManager.default.fileExists(atPath: r.bundle.root.path) && r.secrets.items.isEmpty)
        // The payload decodes as the protocol's VmUpdatedPayload guest.
        let updated = try #require(seen.items.first { $0["type"] == "vm.updated" })
        _ = try JSONDecoder().decode(VMGuest.self, from: JSONEncoder().encode(try #require(updated["guest"])))
    }
}
