import Foundation
import PsycheHelperCore
import PsycheProtocol

/// Fans `vm.updated` / `vm.deleted` events out to `vm.watch` subscribers (the Gateway re-broadcasts
/// them as its `vm.updated` event; the protocol has no unsolicited node event).
public final class VMEventHub: @unchecked Sendable {
    private let lock = NSLock()
    private var subscribers: [UUID: AsyncStream<JSONValue>.Continuation] = [:]

    public init() {}

    public func subscribe() -> (UUID, AsyncStream<JSONValue>) {
        let (stream, cont) = AsyncStream<JSONValue>.makeStream(bufferingPolicy: .bufferingNewest(100))
        let id = UUID()
        lock.withLock { subscribers[id] = cont }
        cont.onTermination = { [weak self] _ in self?.lock.withLock { _ = self?.subscribers.removeValue(forKey: id) } }
        return (id, stream)
    }

    public func unsubscribe(_ id: UUID) {
        lock.withLock { subscribers.removeValue(forKey: id) }?.finish()
    }

    public func publish(_ event: JSONValue) {
        for c in lock.withLock({ Array(subscribers.values) }) { c.yield(event) }
    }

    public var subscriberCount: Int { lock.withLock { subscribers.count } }
}

/// Runs a tool by absolute path and captures its output (VM plumbing: ssh, ssh-keygen, diskutil,
/// hdiutil, sqlite3, codesign, csreq). Never through a shell.
enum Tool {
    static func run(_ path: String, _ args: [String], stdin: Data? = nil, env: [String: String] = [:], timeout: TimeInterval = 120) throws -> (status: Int32, out: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        var e = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        for (k, v) in env { e[k] = v }
        p.environment = e
        let out = Pipe()
        p.standardOutput = out
        p.standardError = out
        let input = Pipe()
        p.standardInput = stdin == nil ? FileHandle.nullDevice : input
        try p.run()
        if let stdin {
            input.fileHandleForWriting.write(stdin)
            try? input.fileHandleForWriting.close()
        }
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning, Date() < deadline { usleep(50_000) }
        if p.isRunning {
            p.terminate()
            throw CapabilityError(.timeout, reason: "timeout", "\(URL(fileURLWithPath: path).lastPathComponent) timed out")
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        return (p.terminationStatus, String(decoding: data, as: UTF8.self))
    }
}

/// SSH with a per-guest ed25519 key (`<bundle>/ssh/`); first contact authenticates with the
/// provisioning password through `SSH_ASKPASS` (the password travels in the child's environment,
/// never on a command line or in a file).
public struct SSHGuestShell: GuestShell {
    public init() {}

    public func address(mac: String) -> String? {
        guard let text = try? String(contentsOfFile: "/var/db/dhcpd_leases", encoding: .utf8) else { return nil }
        return DHCPLeases.address(mac: mac, leases: text)
    }

    public func ensureKey(in dir: URL) throws -> String {
        let key = dir.appendingPathComponent("id_ed25519")
        if !FileManager.default.fileExists(atPath: key.path) {
            let r = try Tool.run("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "psyche-helper", "-f", key.path])
            guard r.status == 0 else { throw CapabilityError.unavailable("ssh_keygen", "Could not create the guest SSH key") }
        }
        return try String(contentsOf: key.appendingPathExtension("pub"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public func run(host: String, user: String, keyDir: URL, password: String?, command: String, timeout: TimeInterval) async throws -> (status: Int32, output: String) {
        var args = ["-o", "UserKnownHostsFile=\(keyDir.appendingPathComponent("known_hosts").path)", "-o", "StrictHostKeyChecking=accept-new",
                    "-o", "ConnectTimeout=10"]
        var env: [String: String] = [:]
        if let password {
            let askpass = keyDir.appendingPathComponent("askpass.sh")
            try "#!/bin/sh\nprintf '%s\\n' \"$PSYCHE_SSH_PASSWORD\"\n".write(to: askpass, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: askpass.path)
            args += ["-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no"]
            env = ["SSH_ASKPASS": askpass.path, "SSH_ASKPASS_REQUIRE": "force", "DISPLAY": ":0", "PSYCHE_SSH_PASSWORD": password]
        } else {
            args += ["-i", keyDir.appendingPathComponent("id_ed25519").path, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"]
        }
        args += ["\(user)@\(host)", command]
        let a = args, e = env
        return try await withCheckedThrowingContinuation { c in
            DispatchQueue.global(qos: .userInitiated).async { c.resume(with: Result { try Tool.run("/usr/bin/ssh", a, env: e, timeout: timeout) }.map { ($0.status, $0.out) }) }
        }
    }
}

/// Writes the guest helper's TCC rows into the stopped guest's system TCC.db (spike 06 step 9):
/// attach the disk without mounting, mount the APFS Data volume `noowners`, edit with sqlite3,
/// unmount and detach. About 5 s; needs no root.
public struct OfflineTCCWriter: GuestPermissionWriter {
    public init() {}

    public func designatedRequirement(app: URL) throws -> Data {
        let r = try Tool.run("/usr/bin/codesign", ["-d", "-r-", app.path])
        guard r.status == 0, let line = r.out.split(separator: "\n").first(where: { $0.hasPrefix("designated => ") }) else {
            throw CapabilityError(.unavailable, reason: "codesign", "Could not read the guest helper's designated requirement")
        }
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("psyche-csreq-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: out) }
        let c = try Tool.run("/usr/bin/csreq", ["-r-", "-b", out.path], stdin: Data(line.dropFirst("designated => ".count).utf8))
        guard c.status == 0, let data = FileManager.default.contents(atPath: out.path) else {
            throw CapabilityError(.unavailable, reason: "csreq", "Could not compile the designated requirement")
        }
        return data
    }

    public func grant(_ bundle: VMBundle, config: VMConfig, client: GuestTCC.Client) async throws {
        let disk = bundle.diskURL(format: config.diskFormat)
        let attach = config.diskFormat == "asif"
            ? try Tool.run("/usr/sbin/diskutil", ["image", "attach", "--noMount", "--plist", disk.path])
            : try Tool.run("/usr/bin/hdiutil", ["attach", "-nomount", "-plist", disk.path])
        guard attach.status == 0, let whole = Self.wholeDisk(attach.out) else {
            throw CapabilityError(.unavailable, reason: "disk_attach", "Could not attach the guest disk")
        }
        defer { _ = try? Tool.run("/usr/sbin/diskutil", ["eject", whole]) }
        guard let data = Self.dataVolume(try Tool.run("/usr/sbin/diskutil", ["apfs", "list", "-plist"]).out, whole: whole) else {
            throw CapabilityError(.unavailable, reason: "data_volume", "The guest's Data volume was not found")
        }
        let mnt = FileManager.default.temporaryDirectory.appendingPathComponent("psyche-guest-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: mnt, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: mnt) }
        let m = try Tool.run("/usr/sbin/diskutil", ["mount", "-mountOptions", "noowners", "-mountPoint", mnt.path, data])
        guard m.status == 0 else { throw CapabilityError(.unavailable, reason: "data_mount", "Could not mount the guest's Data volume") }
        defer { _ = try? Tool.run("/usr/sbin/diskutil", ["unmount", mnt.path]) }
        let db = mnt.appendingPathComponent(GuestTCC.dbPath).path
        let info = try Tool.run("/usr/bin/sqlite3", [db, "PRAGMA table_info(access);"])
        let columns = Set(info.out.split(separator: "\n").compactMap { $0.split(separator: "|").dropFirst().first.map(String.init) })
        let sql = try GuestTCC.statements(client: client, columns: columns).joined(separator: "\n")
        let w = try Tool.run("/usr/bin/sqlite3", [db], stdin: Data(sql.utf8))
        guard w.status == 0 else { throw CapabilityError(.unavailable, reason: "tcc_write", "Writing the guest's TCC.db failed") }
    }

    /// `/dev/diskN` from an attach plist (`system-entities`).
    static func wholeDisk(_ plist: String) -> String? {
        guard let obj = try? PropertyListSerialization.propertyList(from: Data(plist.utf8), format: nil) as? [String: Any],
              let entities = obj["system-entities"] as? [[String: Any]]
        else { return nil }
        return entities.compactMap { $0["dev-entry"] as? String }.min { $0.count < $1.count }
    }

    /// Device of the APFS volume with the Data role whose container sits on `whole`.
    static func dataVolume(_ plist: String, whole: String) -> String? {
        guard let obj = try? PropertyListSerialization.propertyList(from: Data(plist.utf8), format: nil) as? [String: Any],
              let containers = obj["Containers"] as? [[String: Any]]
        else { return nil }
        let base = whole.replacingOccurrences(of: "/dev/", with: "")
        for c in containers {
            let stores = (c["PhysicalStores"] as? [[String: Any]] ?? []).compactMap { $0["DeviceIdentifier"] as? String }
            guard stores.contains(where: { $0.hasPrefix(base + "s") || $0 == base }) else { continue }
            for v in c["Volumes"] as? [[String: Any]] ?? [] where (v["Roles"] as? [String] ?? []).contains("Data") {
                return (v["DeviceIdentifier"] as? String).map { "/dev/" + $0 }
            }
        }
        return nil
    }
}
