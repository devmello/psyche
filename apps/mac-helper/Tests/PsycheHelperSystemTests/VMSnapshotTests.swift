import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import PsycheProtocol
import Testing

private struct FailingCloner: FileCloner {
    func clone(_ from: URL, to: URL) throws {
        if from.lastPathComponent == "AuxiliaryStorage" { throw CapabilityError(.unavailable, reason: "clone_failed", "x") }
        try FileManager.default.copyItem(at: from, to: to)
    }
}

private func home() -> URL {
    let u = URL(fileURLWithPath: "/tmp/pvs-\(UInt32.random(in: 0...UInt32.max))", isDirectory: true)
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u
}

private func manager(_ backend: FakeVMBackend, _ h: URL, cloner: any FileCloner = APFSCloner()) -> VMManager {
    VMManager(backend: backend, secrets: MemorySecrets(), environment: ["PSYCHE_HOME": h.appendingPathComponent(".psyche").path],
              host: { HostResources(cpuCount: 10, memoryGB: 16, freeDiskGB: 200, osMajor: 27) }, log: HelperLog(echo: { _ in }), cloner: cloner)
}

/// An installed, stopped guest whose disk says `content`.
private func installedGuest(_ vm: VMManager, content: String = "v1") async throws -> VMBundle {
    _ = try await vm.create(.init(ipsw: "/tmp/x.ipsw"), emit: { _ in })
    let (bundle, config) = try vm.load("sandbox")
    try Data(content.utf8).write(to: bundle.diskURL(format: config.diskFormat))
    try Data("aux-\(content)".utf8).write(to: bundle.auxiliaryStorageURL)
    var s = bundle.loadState() ?? VMStateRecord(phase: .installed)
    s.phase = .stopped
    s.provisioned = true
    try bundle.saveState(s)
    return bundle
}

private func disk(_ b: VMBundle) throws -> String {
    try String(contentsOf: b.diskURL(format: (try b.loadConfig()).diskFormat), encoding: .utf8)
}

private func reason(_ body: () async throws -> Void) async -> String? {
    do { try await body(); return nil } catch let e as CapabilityError { return e.reason } catch { return "\(error)" }
}

@Suite("VM snapshots and resets (L6) against a fake backend", .serialized)
struct VMSnapshotTests {
    @Test func baseSnapshotThenResetBringsBackTheFreshMac() async throws {
        let h = home()
        defer { try? FileManager.default.removeItem(at: h) }
        try? Data("ipsw".utf8).write(to: URL(fileURLWithPath: "/tmp/x.ipsw"))
        let backend = FakeVMBackend()
        let vm = manager(backend, h)
        let bundle = try await installedGuest(vm)

        let snap = try await vm.snapshot(.init(label: "Clean 27.0.1", kind: "base"), emit: { _ in })
        let base = try #require(snap["snapshot"])
        #expect(base["kind"] == "base" && base["label"] == "Clean 27.0.1" && base["method"] == "apfs-clone")
        #expect(base["provisioned"] == true && base["savedState"] == false)
        #expect(base["guestOS"] != nil)  // present (null or a version), never omitted
        #expect(snap["guest"]?["baseSnapshot"] == base["id"])

        // The task dirties the disk; reset returns it.
        try Data("dirty".utf8).write(to: bundle.diskURL(format: (try bundle.loadConfig()).diskFormat))
        try Data("ss".utf8).write(to: bundle.savedStateURL)
        let events = Locked<[String]>([])
        let r = try await vm.reset(name: "sandbox", emit: { e in events.mutate { $0.append("\(e["type"]?.stringValue ?? "") \(e["phase"]?.stringValue ?? "")") } })
        #expect(try disk(bundle) == "v1")
        #expect(!FileManager.default.fileExists(atPath: bundle.savedStateURL.path))  // the dirty saved state is gone
        #expect(r["guest"]?["phase"] == "stopped" && r["snapshot"] == base["id"])
        guard case .number(let ms)? = r["durationMs"] else { Issue.record("no durationMs"); return }
        #expect(ms >= 0 && ms < 30_000)
        #expect(events.value == ["vm.reset started", "vm.reset finished"])
        // The snapshot is kept for the next reset.
        #expect(bundle.loadSnapshots().count == 1)
    }

    @Test func runningGuestsAndMissingBaseAreRefused() async throws {
        let h = home()
        defer { try? FileManager.default.removeItem(at: h) }
        try? Data("ipsw".utf8).write(to: URL(fileURLWithPath: "/tmp/x.ipsw"))
        let backend = FakeVMBackend()
        let vm = manager(backend, h)
        _ = try await installedGuest(vm)
        #expect(await reason { _ = try await vm.reset(name: "sandbox", emit: { _ in }) } == "no_base_snapshot")
        backend.lock.withLock { _ = backend.running.insert("sandbox") }
        #expect(await reason { _ = try await vm.snapshot(.init(), emit: { _ in }) } == "vm_running")
        #expect(await reason { _ = try await vm.restore(name: "sandbox", snapshot: "x", emit: { _ in }) } == "vm_running")
        backend.lock.withLock { _ = backend.running.remove("sandbox") }
        #expect(await reason { _ = try await vm.restore(name: "sandbox", snapshot: "../../etc", emit: { _ in }) } == "snapshot_not_found")
        #expect(await reason { _ = try await vm.snapshot(.init(kind: "weekly"), emit: { _ in }) } == "invalid_params")
    }

    @Test func savedStateRestoresToSavedAndManualRestoreKeepsIdentity() async throws {
        let h = home()
        defer { try? FileManager.default.removeItem(at: h) }
        try? Data("ipsw".utf8).write(to: URL(fileURLWithPath: "/tmp/x.ipsw"))
        let vm = manager(FakeVMBackend(), h)
        let bundle = try await installedGuest(vm)
        try Data("machine-id".utf8).write(to: bundle.machineIdentifierURL)
        try Data("warm".utf8).write(to: bundle.savedStateURL)
        var s = try #require(bundle.loadState())
        s.phase = .saved
        try bundle.saveState(s)
        let snap = try await vm.snapshot(.init(label: "warm"), emit: { _ in })
        let id = try #require(snap["snapshot"]?["id"]?.stringValue)
        #expect(snap["snapshot"]?["savedState"] == true && snap["snapshot"]?["kind"] == "manual")
        // Not part of a snapshot: the machine identity.
        #expect(!FileManager.default.fileExists(atPath: bundle.snapshotURL(id).appendingPathComponent("MachineIdentifier").path))

        try FileManager.default.removeItem(at: bundle.savedStateURL)
        try Data("v2".utf8).write(to: bundle.diskURL(format: (try bundle.loadConfig()).diskFormat))
        let r = try await vm.restore(name: "sandbox", snapshot: id, emit: { _ in })
        #expect(r["guest"]?["phase"] == "saved")
        #expect(try String(contentsOf: bundle.savedStateURL, encoding: .utf8) == "warm")
        #expect(try disk(bundle) == "v1")
        #expect(try String(contentsOf: bundle.machineIdentifierURL, encoding: .utf8) == "machine-id")

        _ = try await vm.deleteSnapshot(name: "sandbox", snapshot: id)
        #expect(bundle.loadSnapshots().isEmpty)
    }

    @Test func retentionBaseDemotionAndFailedClonesLeaveNoTrace() async throws {
        let h = home()
        defer { try? FileManager.default.removeItem(at: h) }
        try? Data("ipsw".utf8).write(to: URL(fileURLWithPath: "/tmp/x.ipsw"))
        let vm = manager(FakeVMBackend(), h, cloner: CopyCloner())
        let bundle = try await installedGuest(vm)
        let config = try bundle.loadConfig()
        let store = VMSnapshotStore(cloner: CopyCloner(), method: "apfs-clone")
        var t = Date(timeIntervalSince1970: 2_000_000_000)
        for _ in 0..<5 {
            t += 60
            _ = try store.create(bundle, config: config, kind: "task", label: nil, taskId: "t", now: t)
        }
        #expect(bundle.loadSnapshots().filter { $0.kind == "task" }.count == SnapshotPolicy.keepTasks)
        t += 60
        let first = try store.create(bundle, config: config, kind: "base", label: nil, taskId: nil, now: t)
        t += 60
        let second = try store.create(bundle, config: config, kind: "base", label: nil, taskId: nil, now: t)
        let all = bundle.loadSnapshots()
        #expect(all.filter { $0.kind == "base" }.map(\.id) == [second.id])
        #expect(all.first { $0.id == first.id }?.kind == "manual")
        #expect(all.first?.id == second.id)  // newest first
        for _ in 0..<(SnapshotPolicy.maxManual - 1) {
            t += 60
            _ = try store.create(bundle, config: config, kind: "manual", label: nil, taskId: nil, now: t)
        }
        #expect(throws: CapabilityError.self) { try store.create(bundle, config: config, kind: "manual", label: nil, taskId: nil, now: t + 60) }

        // A clone that fails half way: no partial snapshot, and a failed restore leaves the disk alone.
        let failing = VMSnapshotStore(cloner: FailingCloner())
        let before = bundle.loadSnapshots().count
        #expect(throws: CapabilityError.self) { try failing.create(bundle, config: config, kind: "task", label: nil, taskId: nil, now: t + 120) }
        #expect(bundle.loadSnapshots().count == before)
        #expect(((try? FileManager.default.contentsOfDirectory(atPath: bundle.snapshotsURL.path)) ?? []).allSatisfy { !$0.hasPrefix(".tmp") })
        try Data("current".utf8).write(to: bundle.diskURL(format: (try bundle.loadConfig()).diskFormat))
        #expect(throws: CapabilityError.self) { try failing.restore(bundle, config: config, id: second.id) }
        #expect(try disk(bundle) == "current")
    }
}

private final class Locked<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T
    init(_ v: T) { self.v = v }
    var value: T { lock.withLock { v } }
    func mutate(_ f: (inout T) -> Void) { lock.withLock { f(&v) } }
}
