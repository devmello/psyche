import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import PsycheProtocol
import Testing

private final class Shell: GuestShell, @unchecked Sendable {
    let lock = NSLock()
    var runs: [(password: String?, command: String)] = []
    var ip: String? = "192.168.64.9"
    func address(mac: String) -> String? { ip }
    func ensureKey(in dir: URL) throws -> String { "ssh-ed25519 AAAAnew psyche-helper" }
    func run(host: String, user: String, keyDir: URL, password: String?, command: String, timeout: TimeInterval) async throws -> (status: Int32, output: String) {
        lock.withLock { runs.append((password, command)) }
        return (0, "")
    }
}

private final class Writer: GuestPermissionWriter, @unchecked Sendable {
    func designatedRequirement(app: URL) throws -> Data { Data([1]) }
    func grant(_ bundle: VMBundle, config: VMConfig, client: GuestTCC.Client) async throws {}
}

private struct Rig {
    let root = URL(fileURLWithPath: "/tmp/pvi-\(UInt32.random(in: 0...UInt32.max))", isDirectory: true)
    let backend = FakeVMBackend()
    let secrets = MemorySecrets()
    let shell = Shell()
    var vm: VMManager

    init(home: String = "a") {
        let psyche = root.appendingPathComponent(home)
        try? FileManager.default.createDirectory(at: psyche, withIntermediateDirectories: true)
        vm = VMManager(backend: backend, secrets: secrets, shell: shell, permissions: Writer(),
                       environment: ["PSYCHE_HOME": psyche.path, "PSYCHE_NODE_SOCKET": root.appendingPathComponent("n.sock").path],
                       host: { HostResources(cpuCount: 10, memoryGB: 16, freeDiskGB: 200, osMajor: 27) }, log: HelperLog(echo: { _ in }), cloner: CopyCloner())
    }

    /// A Psyche checkout stand-in with the helper app.
    func payload() throws -> String {
        let p = root.appendingPathComponent("payload")
        try FileManager.default.createDirectory(at: p.appendingPathComponent("apps/node/scripts"), withIntermediateDirectories: true)
        try Data("#!/bin/sh".utf8).write(to: p.appendingPathComponent("apps/node/scripts/guest-bootstrap.sh"))
        try FileManager.default.createDirectory(at: p.appendingPathComponent("Psyche Helper.app"), withIntermediateDirectories: true)
        return p.path
    }

    func outDir() throws -> String {
        let o = root.appendingPathComponent("out")
        try FileManager.default.createDirectory(at: o, withIntermediateDirectories: true)
        return o.path
    }
}

private func reason(_ body: () async throws -> Void) async -> String? {
    do { try await body(); return nil } catch let e as CapabilityError { return e.reason } catch { return "\(error)" }
}

@Suite("prebuilt guest images (L7) against a fake backend", .serialized)
struct VMImageTests {
    @Test func buildPipelineThenImportWithAFreshIdentityAndRotatedPassword() async throws {
        let builder = Rig(home: "build")
        defer { try? FileManager.default.removeItem(at: builder.root) }
        try Data("ipsw".utf8).write(to: builder.root.appendingPathComponent("x.ipsw"))
        let events = Box<[String]>([])
        let result = try await GuestImageBuilder.build(
            builder.vm, .init(ipsw: builder.root.appendingPathComponent("x.ipsw").path, download: false, payload: try builder.payload(), outDir: try builder.outDir(), id: "macos-27.0.1-test"),
            attempts: 2, interval: 0.01, emit: { e in events.mutate { $0.append(e["type"]?.stringValue ?? "") } }
        )
        let path = try #require(result["path"]?.stringValue)
        let sha = try #require(result["manifestSha256"]?.stringValue)
        #expect(result["manifest"]?["permissionsGranted"] == true && result["manifest"]?["psycheInstalled"] == true)
        #expect(events.value.contains("vm.export") && events.value.contains("vm.psyche_install"))
        let files = Set(try FileManager.default.contentsOfDirectory(atPath: path))
        #expect(!files.contains("MachineIdentifier") && files.contains("bootstrap.json") && files.contains("manifest.json"))
        let builtConfig = try builder.vm.load(GuestImageBuilder.guestName).1
        let builtPassword = String(decoding: try await builder.secrets.read(name: GuestImageBuilder.guestName), as: UTF8.self)

        // Another Mac imports it.
        let owner = Rig(home: "owner")
        let created = try await owner.vm.create(.init(image: path, imageSha256: sha), emit: { _ in })
        #expect(created["phase"] == "stopped" && created["provisioned"] == true && created["psycheInstalled"] == true)
        #expect(created["passwordRotationPending"] == true && created["image"]?["id"] == "macos-27.0.1-test")
        let (bundle, config) = try owner.vm.load("sandbox")
        #expect(config.macAddress != builtConfig.macAddress)
        #expect(owner.backend.calls.contains("prepareImported"))
        #expect(String(decoding: try await owner.secrets.read(name: "sandbox"), as: UTF8.self) == builtPassword)
        // One guest per user still holds.
        #expect(await reason { _ = try await owner.vm.create(.init(name: "second", image: path), emit: { _ in }) } == "guest_exists")

        // First start rotates the bootstrap password and replaces the SSH keys.
        _ = try await owner.vm.start(name: "sandbox", emit: { _ in })
        let run = try #require(owner.shell.runs.last)
        #expect(run.password == builtPassword)
        #expect(run.command.hasPrefix("dscl . -passwd /Users/psyche '\(builtPassword)' '"))
        #expect(run.command.contains("sysadminctl -autologin set") && run.command.contains("base64 -D > ~/.ssh/authorized_keys"))
        let rotated = String(decoding: try await owner.secrets.read(name: "sandbox"), as: UTF8.self)
        #expect(rotated != builtPassword && GuestImage.Bootstrap.isValidPassword(rotated) && run.command.contains("'\(rotated)'"))
        #expect(bundle.loadState()?.passwordRotationPending == false)
        #expect(bundle.loadState()?.image?.id == "macos-27.0.1-test")  // kept through later state changes
    }

    @Test func badImagesLeaveNothingBehind() async throws {
        let builder = Rig(home: "build")
        defer { try? FileManager.default.removeItem(at: builder.root) }
        try Data("ipsw".utf8).write(to: builder.root.appendingPathComponent("x.ipsw"))
        let r = try await GuestImageBuilder.build(
            builder.vm, .init(ipsw: builder.root.appendingPathComponent("x.ipsw").path, download: false, payload: try builder.payload(), outDir: try builder.outDir()),
            attempts: 1, interval: 0, emit: { _ in }
        )
        let path = try #require(r["path"]?.stringValue)
        let owner = Rig(home: "owner")
        #expect(await reason { _ = try await owner.vm.create(.init(image: path, imageSha256: String(repeating: "a", count: 64)), emit: { _ in }) } == "image_checksum_mismatch")
        #expect(await reason { _ = try await owner.vm.create(.init(image: "relative/path"), emit: { _ in }) } == "invalid_params")
        #expect(await reason { _ = try await owner.vm.create(.init(image: "/nope/x.aar"), emit: { _ in }) } == "image_not_found")
        #expect(VMBundle.all(environment: ["PSYCHE_HOME": owner.root.appendingPathComponent("owner").path]).isEmpty)
        #expect(await reason { _ = try await owner.vm.exportImage(.init(outDir: "/tmp"), emit: { _ in }) } == "vm_not_found")
        // An exported image cannot overwrite an existing folder.
        #expect(await reason { _ = try await builder.vm.exportImage(.init(name: GuestImageBuilder.guestName, outDir: try builder.outDir(), id: URL(fileURLWithPath: path).lastPathComponent), emit: { _ in }) } == "image_exists")
    }

    @Test func rotationCommandQuotesOnlyCheckedPasswords() {
        let c = VMManager.rotationCommand(user: "psyche", old: "Old123456789abc", new: "New123456789abc", publicKey: "ssh-ed25519 AAA k")
        #expect(c.contains("dscl . -passwd /Users/psyche 'Old123456789abc' 'New123456789abc'"))
        #expect(c.contains("set-keychain-password -o 'Old123456789abc' -p 'New123456789abc'"))
        #expect(!c.contains("ssh-ed25519"))  // the key travels base64-encoded
    }
}

private final class Box<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T
    init(_ v: T) { self.v = v }
    var value: T { lock.withLock { v } }
    func mutate(_ f: (inout T) -> Void) { lock.withLock { f(&v) } }
}
