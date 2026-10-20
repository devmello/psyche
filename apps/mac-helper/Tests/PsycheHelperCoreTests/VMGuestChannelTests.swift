import Darwin
import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

final class RecordingGuestOps: GuestOperations, @unchecked Sendable {
    let lock = NSLock()
    var calls: [String] = []
    var exportDir: URL?
    func status() -> JSONValue { ["accessibility": true, "screenRecording": false] }
    func shutdown(password: String) throws { lock.withLock { calls.append("shutdown:\(password)") } }
    func mountShares(password: String) throws { lock.withLock { calls.append("mount:\(password)") } }
    func export(path: String, transferId: String) throws -> Int {
        lock.withLock { calls.append("export:\(path)") }
        guard let dir = exportDir else { return 0 }
        let d = dir.appendingPathComponent(transferId)
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        try Data("guest data".utf8).write(to: d.appendingPathComponent(URL(fileURLWithPath: path).lastPathComponent))
        return 10
    }
}

private func pair(_ ops: any GuestOperations) -> GuestAgentClient {
    var fds: [Int32] = [0, 0]
    precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
    let server = GuestAgentServer(ops: ops, log: HelperLog(echo: { _ in }))
    let guestFD = fds[1]
    Thread.detachNewThread { server.serve(FrameChannel(socket: UnixSocketConnection(fd: guestFD))) }
    return GuestAgentClient(fd: fds[0])
}

@Suite("VM guest agent channel and offline helpers (L3)", .serialized)
struct VMGuestChannelTests {
    @Test func agentAnswersPingShutdownMountAndExport() throws {
        let ops = RecordingGuestOps()
        let client = pair(ops)
        let ping = try client.call(GuestAgentMethod.ping, timeout: 5)
        #expect(ping["version"] == "1" && ping["accessibility"] == true)
        _ = try client.call(GuestAgentMethod.mountShares, ["password": "pw"], timeout: 5)
        _ = try client.call(GuestAgentMethod.shutdown, ["password": "pw"], timeout: 5)
        #expect(try client.call(GuestAgentMethod.export, ["path": "/Users/psyche/report.pdf", "transferId": "abc123"], timeout: 5)["bytes"] == 0)
        #expect(ops.calls == ["mount:pw", "shutdown:pw", "export:/Users/psyche/report.pdf"])
        do {
            _ = try client.call(GuestAgentMethod.export, ["path": "/x", "transferId": "../../etc"], timeout: 5)
            Issue.record("accepted a path-like transfer id")
        } catch let e as CapabilityError {
            #expect(e.code == .invalidParams)
        }
        #expect(throws: CapabilityError.self) { try client.call(GuestAgentMethod.shutdown, [:], timeout: 5) }
        #expect(throws: CapabilityError.self) { try client.call("guest.exec", ["cmd": "id"], timeout: 5) }
    }

    @Test func tccRowsFollowTheGuestSchema() throws {
        let client = GuestTCC.Client(bundleId: "com.psyche.helper", csreq: Data([0xFA, 0xDE, 0x0C, 0x00]))
        let cols: Set = ["service", "client", "client_type", "auth_value", "auth_reason", "auth_version", "csreq", "indirect_object_identifier",
                         "flags", "last_modified", "boot_uuid", "last_reminded"]
        let sql = try GuestTCC.statements(client: client, columns: cols, now: Date(timeIntervalSince1970: 1_700_000_000))
        #expect(sql.count == 2)
        #expect(sql[0].hasPrefix("INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq"))
        #expect(sql[0].contains("'kTCCServiceAccessibility', 'com.psyche.helper', 0, 2, 4, 1, X'FADE0C00'"))
        #expect(sql[1].contains("'kTCCServiceScreenCapture'") && sql[0].contains("1700000000") && sql[0].contains("last_reminded"))
        #expect(!sql[0].contains("pid_version"))  // only columns the schema has
        #expect(throws: CapabilityError.self) { try GuestTCC.statements(client: client, columns: ["service"]) }
        #expect(throws: CapabilityError.self) {
            try GuestTCC.statements(client: .init(bundleId: "x'); DROP TABLE access; --", csreq: Data()), columns: cols)
        }
    }

    @Test func dhcpLeasesPickTheNewestLeaseForTheMAC() {
        let leases = """
        {
            name=psyche
            ip_address=192.168.64.4
            hw_address=1,2:a:3b:4:5:6
            lease=0x6700aa00
        }
        {
            name=psyche
            ip_address=192.168.65.2
            hw_address=1,2:a:3b:4:5:6
            lease=0x6700bb00
        }
        {
            ip_address=192.168.64.9
            hw_address=1,de:ad:be:ef:0:1
            lease=0x6800bb00
        }
        """
        #expect(DHCPLeases.address(mac: "02:0a:3b:04:05:06", leases: leases) == "192.168.65.2")
        #expect(DHCPLeases.address(mac: "02:00:00:00:00:00", leases: leases) == nil)
    }

    @Test func sensitivePathsAreRefusedButTempAndDrivesAreFine() throws {
        let home = "/Users/someone", psyche = "/Users/someone/.psyche"
        for bad in ["/", "/System/Library", "/usr/bin", "/etc", "/private", "/Volumes", home, home + "/Library/Mail", psyche + "/vault", "/Users"] {
            #expect(throws: CapabilityError.self, "\(bad)") { try SharePolicy.checkSensitive(bad, home: home, psycheHome: psyche) }
        }
        for ok in ["/Volumes/External/Photos", "/private/var/folders/x/T/drop", home + "/Projects"] {
            try SharePolicy.checkSensitive(ok, home: home, psycheHome: psyche)
        }
    }

    @Test func preM3BundlesStillDecode() throws {
        let config = #"{"name":"sandbox","cpus":4,"memoryGB":8,"diskGB":80,"displayWidth":1920,"displayHeight":1200,"macAddress":"02:00:00:00:00:01","diskFormat":"raw","username":"psyche","createdAt":"2026-10-19T00:00:00Z"}"#
        let c = try JSONDecoder().decode(VMConfig.self, from: Data(config.utf8))
        #expect(c.clipboard == "paste_only" && c.vault == "host")
        let state = #"{"phase":"stopped","updatedAt":"x","provisioned":true}"#
        let s = try JSONDecoder().decode(VMStateRecord.self, from: Data(state.utf8))
        #expect(s.provisioned && !s.psycheInstalled && !s.permissionsGranted)
        #expect(VMPhase.running.canMove(to: .paused) && VMPhase.paused.canMove(to: .saved) && VMPhase.saved.canMove(to: .starting))
        #expect(VMPhase.paused.isActive && !VMPhase.saved.isActive)
        #expect(throws: CapabilityError.self) {
            var bad = c
            bad.clipboard = "always"
            try bad.validate(host: HostResources(cpuCount: 10, memoryGB: 16, freeDiskGB: 200, osMajor: 27))
        }
    }
}
