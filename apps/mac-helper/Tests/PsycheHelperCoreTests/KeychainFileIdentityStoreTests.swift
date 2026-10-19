import Foundation
import PsycheHelperCore
import Testing

@Suite("FileDeviceIdentityStore")
struct KeychainFileIdentityStoreTests {
    /// A fresh `$PSYCHE_HOME` under the temp directory.
    static func tempHome() throws -> String {
        let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("psyche-identity-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir
    }

    static func mode(_ path: String) throws -> Int {
        (try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber)?.intValue ?? -1
    }

    @Test func defaultPathIsUnderPsycheHome() {
        #expect(FileDeviceIdentityStore.defaultPath(environment: ["PSYCHE_HOME": "/x/home"]) == "/x/home/helper/device.key")
    }

    @Test func createsOnFirstUseWithTightPermissionsAndReloads() throws {
        let home = try Self.tempHome()
        defer { try? FileManager.default.removeItem(atPath: home) }
        let store = FileDeviceIdentityStore(environment: ["PSYCHE_HOME": home])
        #expect(store.kind == "file")
        #expect(try store.load() == nil)

        let created = try store.loadOrCreate()
        #expect(try Self.mode(store.path) == 0o600)
        #expect(try Self.mode((store.path as NSString).deletingLastPathComponent) == 0o700)

        let again = try FileDeviceIdentityStore(environment: ["PSYCHE_HOME": home]).loadOrCreate()
        #expect(again.publicKey == created.publicKey)
        #expect(again.deviceId == created.deviceId)

        // File content: one base64url raw 32-byte key, no temp files left behind.
        let text = try String(contentsOfFile: store.path, encoding: .utf8)
        #expect(Base64URL.decode(text)?.count == 32)
        let dir = (store.path as NSString).deletingLastPathComponent
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir) == ["device.key"])
    }

    @Test func saveRefusesToOverwrite() throws {
        let home = try Self.tempHome()
        defer { try? FileManager.default.removeItem(atPath: home) }
        let store = FileDeviceIdentityStore(environment: ["PSYCHE_HOME": home])
        let first = try store.loadOrCreate()
        #expect(throws: DeviceIdentityStoreError.alreadyExists) { try store.save(DeviceIdentity()) }
        #expect(try store.load()?.publicKey == first.publicKey)
    }

    @Test(arguments: [0o640, 0o644, 0o604, 0o700, 0o666])
    func refusesWideModes(mode: Int) throws {
        let home = try Self.tempHome()
        defer { try? FileManager.default.removeItem(atPath: home) }
        let store = FileDeviceIdentityStore(environment: ["PSYCHE_HOME": home])
        _ = try store.loadOrCreate()
        #expect(chmod(store.path, mode_t(mode)) == 0)
        #expect(throws: DeviceIdentityStoreError.insecurePermissions(path: store.path, mode: UInt16(mode))) { try store.load() }
        #expect(throws: DeviceIdentityStoreError.self) { try store.loadOrCreate() }
    }

    @Test func acceptsOwnerReadOnly() throws {
        let home = try Self.tempHome()
        defer { try? FileManager.default.removeItem(atPath: home) }
        let store = FileDeviceIdentityStore(environment: ["PSYCHE_HOME": home])
        let created = try store.loadOrCreate()
        #expect(chmod(store.path, 0o400) == 0)
        #expect(try store.load()?.publicKey == created.publicKey)
    }

    @Test func refusesAnotherOwner() throws {
        let home = try Self.tempHome()
        defer { try? FileManager.default.removeItem(atPath: home) }
        let path = (home as NSString).appendingPathComponent("helper/device.key")
        _ = try FileDeviceIdentityStore(path: path).loadOrCreate()
        let other = FileDeviceIdentityStore(path: path, expectedOwner: geteuid() &+ 1)
        #expect(throws: DeviceIdentityStoreError.wrongOwner(path: path)) { try other.load() }
    }

    @Test func refusesSymlinks() throws {
        let home = try Self.tempHome()
        defer { try? FileManager.default.removeItem(atPath: home) }
        let real = FileDeviceIdentityStore(path: (home as NSString).appendingPathComponent("real/device.key"))
        _ = try real.loadOrCreate()
        let linkPath = (home as NSString).appendingPathComponent("helper/device.key")
        try FileManager.default.createDirectory(atPath: (linkPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        #expect(symlink(real.path, linkPath) == 0)
        #expect(throws: DeviceIdentityStoreError.notRegularFile(path: linkPath)) { try FileDeviceIdentityStore(path: linkPath).load() }
    }

    @Test func rejectsMalformedKeys() throws {
        let home = try Self.tempHome()
        defer { try? FileManager.default.removeItem(atPath: home) }
        let store = FileDeviceIdentityStore(environment: ["PSYCHE_HOME": home])
        _ = try store.loadOrCreate()
        try store.remove()
        #expect(FileManager.default.createFile(atPath: store.path, contents: Data("AAAA".utf8), attributes: [.posixPermissions: 0o600]))
        #expect(throws: DeviceIdentityStoreError.malformed) { try store.load() }
    }

    @Test func tightensAnExistingWideDirectory() throws {
        let home = try Self.tempHome()
        defer { try? FileManager.default.removeItem(atPath: home) }
        let dir = (home as NSString).appendingPathComponent("helper")
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        let store = FileDeviceIdentityStore(environment: ["PSYCHE_HOME": home])
        _ = try store.loadOrCreate()
        #expect(try Self.mode(dir) == 0o700)
    }

    @Test func removeIsIdempotent() throws {
        let home = try Self.tempHome()
        defer { try? FileManager.default.removeItem(atPath: home) }
        let store = FileDeviceIdentityStore(environment: ["PSYCHE_HOME": home])
        try store.remove()
        _ = try store.loadOrCreate()
        try store.remove()
        #expect(try store.load() == nil)
    }

    @Test func encodingRoundTrips() throws {
        let identity = DeviceIdentity()
        let decoded = try FileDeviceIdentityStore.decode(Data((FileDeviceIdentityStore.encode(identity) + "\n").utf8))
        #expect(decoded.publicKey == identity.publicKey)
    }
}
