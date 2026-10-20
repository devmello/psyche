import Darwin
import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

private let host = HostResources(cpuCount: 10, memoryGB: 16, freeDiskGB: 200, osMajor: 27)

private func tempDir() -> URL {
    let u = FileManager.default.temporaryDirectory.appendingPathComponent("psyche-vm-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u.resolvingSymlinksInPath()
}

@Suite("VM model (L1, L5)")
struct VMModelTests {
    @Test func defaultsFitAndLimitsAreEnforced() throws {
        try VMConfig(name: "sandbox").validate(host: host)
        #expect(VMConfig(name: "x").cpus == 4 && VMConfig(name: "x").memoryGB == 8 && VMConfig(name: "x").diskGB == 80)
        #expect(throws: CapabilityError.self) { try VMConfig(name: "Bad Name").validate(host: host) }
        #expect(throws: CapabilityError.self) { try VMConfig(name: "a", cpus: 1).validate(host: host) }
        #expect(throws: CapabilityError.self) { try VMConfig(name: "a", cpus: 9).validate(host: host) }  // leaves the host 2
        #expect(throws: CapabilityError.self) { try VMConfig(name: "a", memoryGB: 13).validate(host: host) }  // leaves the host 4 GB
        #expect(throws: CapabilityError.self) { try VMConfig(name: "a", memoryGB: 3).validate(host: host) }
        let small = HostResources(cpuCount: 10, memoryGB: 16, freeDiskGB: 10, osMajor: 27)
        #expect(throws: CapabilityError.self) { try VMConfig(name: "a").validate(host: small) }
        let mac = VMConfig.randomMAC()
        let first = UInt8(mac.prefix(2), radix: 16)!
        #expect(first & 0x02 == 0x02 && first & 0x01 == 0)  // locally administered, unicast
    }

    @Test func phasesFollowTheLifecycleAndCountInstalls() {
        #expect(VMPhase.created.canMove(to: .installing) && !VMPhase.created.canMove(to: .running))
        #expect(VMPhase.installed.canMove(to: .provisioning) && VMPhase.running.canMove(to: .stopping))
        #expect(VMPhase.installing.isActive && VMPhase.running.isActive && !VMPhase.stopped.isActive)
        #expect(throws: CapabilityError.self) { try GuestCap.checkCreate(existing: ["sandbox"]) }
        #expect(throws: CapabilityError.self) { try GuestCap.checkStart(othersActive: 2) }
        #expect((try? GuestCap.checkStart(othersActive: 1)) != nil)
    }

    @Test func bundleIsPrivateAndRoundTrips() throws {
        let home = tempDir()
        let env = ["PSYCHE_HOME": home.path]
        let b = try VMBundle.named("sandbox", environment: env)
        try b.create()
        try b.saveConfig(VMConfig(name: "sandbox"))
        try b.saveState(VMStateRecord(phase: .installed))
        #expect(try b.loadConfig().name == "sandbox" && b.loadState()?.phase == .installed)
        let mode = try FileManager.default.attributesOfItem(atPath: b.root.path)[.posixPermissions] as? Int
        let fmode = try FileManager.default.attributesOfItem(atPath: b.configURL.path)[.posixPermissions] as? Int
        #expect(mode == 0o700 && fmode == 0o600)
        #expect(VMBundle.all(environment: env).map(\.root.lastPathComponent) == ["sandbox"])
        #expect(throws: CapabilityError.self) { try VMBundle.named("../etc", environment: env) }
    }

    @Test func sharePolicyRefusesSensitiveFolders() throws {
        let home = tempDir()
        let psyche = home.appendingPathComponent(".psyche")
        let projects = home.appendingPathComponent("Projects")
        for d in [psyche, projects, home.appendingPathComponent("Library/Mail")] {
            try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        }
        func check(_ path: String, ro: Bool = true, approval: String? = nil) throws -> ShareGrant {
            try SharePolicy.validate(name: "work", path: path, readOnly: ro, approvalId: approval, existing: [], home: home.path, psycheHome: psyche.path)
        }
        let g = try check(projects.path)
        #expect(g.readOnly && g.tag == "psyche" && g.guestPath == "/Volumes/Psyche Shares/work")
        for bad in ["/", home.path, home.appendingPathComponent("Library").path, home.appendingPathComponent("Library/Mail").path, psyche.path] {
            do {
                _ = try check(bad)
                Issue.record("shared \(bad)")
            } catch let e as CapabilityError {
                #expect(e.reason == "share_forbidden")
            }
        }
        // A symlink to the home folder resolves and is refused.
        let link = projects.appendingPathComponent("homelink")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: home)
        #expect(throws: CapabilityError.self) { try check(link.path) }
        // Read-write needs an approval.
        do {
            _ = try check(projects.path, ro: false)
            Issue.record("rw without approval")
        } catch let e as CapabilityError {
            #expect(e.code == .approvalRequired)
        }
        #expect(try check(projects.path, ro: false, approval: "appr_1").readOnly == false)
        #expect(throws: CapabilityError.self) { try check("relative/path") }
        #expect(throws: CapabilityError.self) {
            try SharePolicy.validate(name: "../x", path: projects.path, readOnly: true, approvalId: nil, existing: [], home: home.path, psycheHome: psyche.path)
        }
        #expect(throws: CapabilityError.self) {
            try SharePolicy.validate(name: "work", path: projects.path, readOnly: true, approvalId: nil, existing: [g], home: home.path, psycheHome: psyche.path)
        }
    }

    @Test func relayCopiesBothWaysAndClosesTogether() async throws {
        var left: [Int32] = [0, 0]
        var right: [Int32] = [0, 0]
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &left) == 0 && socketpair(AF_UNIX, SOCK_STREAM, 0, &right) == 0)
        let relay = StreamRelay(left[1], right[0])
        let (closed, done) = AsyncStream<Void>.makeStream()
        relay.start { done.yield() }
        let guest = UnixSocketConnection(fd: left[0])
        let gateway = UnixSocketConnection(fd: right[1])
        try guest.write(Data("hello\n".utf8))
        #expect(try gateway.read(before: Date().addingTimeInterval(2)) == Data("hello\n".utf8))
        try gateway.write(Data("world\n".utf8))
        #expect(try guest.read(before: Date().addingTimeInterval(2)) == Data("world\n".utf8))
        guest.close()
        for await _ in closed { break }
        #expect(try gateway.read(before: Date().addingTimeInterval(2)) == nil)  // EOF propagated
        #expect(relay.bytesAToB == 6 && relay.bytesBToA == 6)
    }
}
