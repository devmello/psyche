import CryptoKit
import Foundation

/// Offline edits to a stopped guest's APFS Data volume, mounted on the host.
///
/// This is the technique Lume uses for unattended setup of pre-27 guests (MIT, trycua/cua,
/// libs/lume/src/Unattended/MacOSOfflineSetupPatcher.swift); this is an independent
/// re-implementation for the spike. It needs no root: `diskutil image attach` by the
/// console user mounts the volume `noowners`, so root-owned guest files are writable.
/// Existing system plists are rewritten in place (same inode, same owner), because
/// launchd/loginwindow are known to ignore atomically-replaced files.
final class DataVolume {
    let image: URL
    var wholeDisk = ""
    var mountPoint: URL!

    init(image: URL) { self.image = image }

    @discardableResult
    static func run(_ tool: String, _ args: [String], input: Data? = nil) throws -> Data {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        let out = Pipe(), err = Pipe(), inp = Pipe()
        p.standardOutput = out
        p.standardError = err
        if input != nil { p.standardInput = inp }
        try p.run()
        if let input { inp.fileHandleForWriting.write(input); try inp.fileHandleForWriting.close() }
        let o = out.fileHandleForReading.readDataToEndOfFile()
        let e = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else {
            throw msg("\(tool) \(args.joined(separator: " ")) → \(p.terminationStatus): \(String(decoding: e, as: UTF8.self))\(String(decoding: o, as: UTF8.self))")
        }
        return o
    }

    static func plist(_ d: Data) throws -> [String: Any] {
        guard let p = try PropertyListSerialization.propertyList(from: d, format: nil) as? [String: Any] else { throw msg("bad plist") }
        return p
    }

    func attach() throws {
        let t = now()
        let out = try DataVolume.run("/usr/sbin/diskutil", ["image", "attach", "--noMount", "--nobrowse", "--plist", image.path])
        let p = try DataVolume.plist(out)
        // diskutil image attach --plist: {"devices": [...]} — be tolerant about the shape.
        let text = String(decoding: out, as: UTF8.self)
        if let ents = p["system-entities"] as? [[String: Any]], let dev = ents.compactMap({ $0["dev-entry"] as? String }).min(by: { $0.count < $1.count }) {
            wholeDisk = dev
        } else if let m = text.range(of: #"/dev/disk[0-9]+"#, options: .regularExpression) {
            wholeDisk = String(text[m])
        } else {
            throw msg("could not parse attach output: \(text)")
        }
        // Find the APFS Data volume by role in any container on this disk.
        let list = try DataVolume.plist(try DataVolume.run("/usr/sbin/diskutil", ["apfs", "list", "-plist"]))
        let diskName = wholeDisk.replacingOccurrences(of: "/dev/", with: "")
        var dataDev: String?
        for c in list["Containers"] as? [[String: Any]] ?? [] {
            let stores = (c["PhysicalStores"] as? [[String: Any]] ?? []).compactMap { $0["DeviceIdentifier"] as? String }
            guard stores.contains(where: { $0.hasPrefix(diskName + "s") || $0 == diskName }) else { continue }
            for v in c["Volumes"] as? [[String: Any]] ?? [] where (v["Roles"] as? [String] ?? []).contains("Data") {
                dataDev = v["DeviceIdentifier"] as? String
            }
        }
        guard let dataDev else { throw msg("no APFS Data volume on \(wholeDisk) — has the guest booted once?") }
        try DataVolume.run("/usr/sbin/diskutil", ["mount", dataDev])
        let info = try DataVolume.plist(try DataVolume.run("/usr/sbin/diskutil", ["info", "-plist", dataDev]))
        guard let mp = info["MountPoint"] as? String, !mp.isEmpty else { throw msg("Data volume did not mount") }
        mountPoint = URL(fileURLWithPath: mp)
        log("attached \(wholeDisk), Data volume \(dataDev) at \(mp) (owners: \(info["GlobalPermissionsEnabled"] as? Bool ?? false ? "enabled" : "ignored"), encrypted: \(info["Encryption"] as? Bool ?? false)) in \(String(format: "%.1f", now() - t)) s")
    }

    func detach() {
        if !wholeDisk.isEmpty { _ = try? DataVolume.run("/usr/sbin/diskutil", ["eject", wholeDisk]) }
    }

    func path(_ rel: String) -> URL { mountPoint.appendingPathComponent(rel) }

    // MARK: file helpers

    func readPlist(_ rel: String) -> [String: Any] {
        guard let d = try? Data(contentsOf: path(rel)), let p = try? DataVolume.plist(d) else { return [:] }
        return p
    }

    /// Writes in place when the file exists (keeps inode and guest owner), else creates it.
    func write(_ data: Data, _ rel: String, mode: Int = 0o644) throws {
        let u = path(rel)
        try FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: u.path) {
            try? FileManager.default.setAttributes([.posixPermissions: mode | 0o200], ofItemAtPath: u.path)
            let h = try FileHandle(forWritingTo: u)
            try h.truncate(atOffset: 0)
            try h.write(contentsOf: data)
            try h.close()
        } else {
            try data.write(to: u)
        }
        try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: u.path)
    }

    func writePlist(_ p: [String: Any], _ rel: String, mode: Int = 0o644, xml: Bool = false) throws {
        try write(PropertyListSerialization.data(fromPropertyList: p, format: xml ? .xml : .binary, options: 0), rel, mode: mode)
    }

    // MARK: unattended user (pre-27 guests)

    func provisionUser(username: String, fullName: String, password: String, uid: Int = 501,
                       guestBuild: String, guestVersion: String) throws {
        // dslocal/nodes/Default ships as 0600 (no search bit); add u+x for the edit, restore after.
        let nodeDir = path("private/var/db/dslocal/nodes/Default").path
        let fm = FileManager.default
        let originalMode = (try? fm.attributesOfItem(atPath: nodeDir)[.posixPermissions] as? Int) ?? 0o600
        try fm.setAttributes([.posixPermissions: originalMode | 0o100], ofItemAtPath: nodeDir)
        defer { try? fm.setAttributes([.posixPermissions: originalMode], ofItemAtPath: nodeDir) }
        let usersDir = "private/var/db/dslocal/nodes/Default/users"
        let userRel = "\(usersDir)/\(username).plist"
        var rec = readPlist(userRel)
        let guid = (rec["generateduid"] as? [String])?.first ?? UUID().uuidString.uppercased()
        if rec.isEmpty {
            rec = ["_writers_passwd": [username], "_writers_realname": [username], "_writers_hint": [username],
                   "_writers_picture": [username], "_writers_jpegphoto": [username], "_writers_UserCertificate": [username],
                   "record_daemon_version": ["9040000"], "unlockOptions": ["0"]]
        }
        rec["name"] = [username]; rec["realname"] = [fullName]; rec["uid"] = ["\(uid)"]; rec["gid"] = ["20"]
        rec["home"] = ["/Users/\(username)"]; rec["shell"] = ["/bin/zsh"]; rec["passwd"] = ["********"]
        rec["generateduid"] = [guid]
        rec["authentication_authority"] = [";ShadowHash;HASHLIST:<SALTED-SHA512-PBKDF2>"]
        rec["ShadowHashData"] = [try DataVolume.shadowHash(password)]
        try writePlist(rec, userRel, mode: 0o600)

        for g in ["admin", "staff"] {
            let rel = "private/var/db/dslocal/nodes/Default/groups/\(g).plist"
            var grp = readPlist(rel)
            guard !grp.isEmpty else { continue }
            var users = grp["users"] as? [String] ?? []; if !users.contains(username) { users.append(username) }
            var members = grp["groupmembers"] as? [String] ?? []; if !members.contains(guid) { members.append(guid) }
            grp["users"] = users; grp["groupmembers"] = members
            try writePlist(grp, rel)
        }

        // Home directory skeleton; loginwindow fills the rest from the user template on first login.
        for d in ["Library/Preferences/ByHost", "Desktop", "Documents", "Downloads"] {
            try FileManager.default.createDirectory(at: path("Users/\(username)/\(d)"), withIntermediateDirectories: true)
        }

        // Setup Assistant: system marker plus per-user "already seen" keys.
        try write(Data(), "private/var/db/.AppleSetupDone")
        // Every per-user pane marked seen, plus the build/version keys: without LastSeen* the
        // per-user Setup Assistant still runs on first login (observed on 26.6.2).
        var seen: [String: Any] = ["GestureMovieSeen": "none", "LastSeenBuddyBuildVersion": guestBuild,
                                   "LastSeenCloudProductVersion": guestVersion,
                                   "LastPreLoginTasksPerformedBuild": guestBuild, "LastPreLoginTasksPerformedVersion": guestVersion]
        for k in ["CloudSetup", "Privacy", "SiriSetup", "TouchIDSetup", "TrueToneSetup", "ScreenTime", "AppearanceSetup",
                  "Accessibility", "ApplePaySetup", "Intelligence", "ActivationLock", "AppStore", "iCloudLoginForStorageServices",
                  "LockdownMode", "SyncSetup", "SyncSetup2", "TermsOfAddress", "Welcome", "FileVault", "AppAnalytics"] {
            seen["DidSee\(k)"] = true
        }
        try writePlist(seen, "Users/\(username)/Library/Preferences/com.apple.SetupAssistant.plist")

        // Auto-login: loginwindow pref + kcpassword (XOR-obfuscated, padded *before* XOR).
        var lw = readPlist("Library/Preferences/com.apple.loginwindow.plist")
        var acct = lw["AccountInfo"] as? [String: Any] ?? [:]
        acct.removeValue(forKey: "FirstLogins")      // a FirstLogins entry re-triggers Setup Assistant
        lw["AccountInfo"] = acct
        lw["autoLoginUser"] = username
        lw["GuestEnabled"] = false
        try writePlist(lw, "Library/Preferences/com.apple.loginwindow.plist")
        try write(DataVolume.kcpassword(password), "private/etc/kcpassword", mode: 0o600)

        // SSH: launchd's persistent enable/disable overrides.
        // Without this marker launchd "migrates" disabled.plist on first boot and drops our key.
        if !FileManager.default.fileExists(atPath: path("private/var/db/com.apple.xpc.launchd/disabled.migrated").path) {
            try write(Data(), "private/var/db/com.apple.xpc.launchd/disabled.migrated")
        }
        var disabled = readPlist("private/var/db/com.apple.xpc.launchd/disabled.plist")
        disabled["com.openssh.sshd"] = false
        try writePlist(disabled, "private/var/db/com.apple.xpc.launchd/disabled.plist", xml: true)
        log("wrote user \(username) (uid \(uid), admin), .AppleSetupDone, autoLoginUser + kcpassword, sshd enabled")
    }

    static func shadowHash(_ password: String) throws -> Data {
        var salt = Data(count: 32)
        _ = salt.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        let iterations = 50_000
        let key = SymmetricKey(data: Data(password.utf8))
        var derived = Data()
        for block in 1...2 {     // 128 bytes = 2 × SHA-512 blocks
            var s = salt; s.append(contentsOf: [0, 0, 0, UInt8(block)])
            var u = Data(HMAC<SHA512>.authenticationCode(for: s, using: key))
            var t = [UInt8](u)
            for _ in 1..<iterations {
                u = Data(HMAC<SHA512>.authenticationCode(for: u, using: key))
                for i in 0..<t.count { t[i] ^= u[i] }
            }
            derived.append(contentsOf: t)
        }
        let shadow: [String: Any] = ["SALTED-SHA512-PBKDF2": ["entropy": derived, "iterations": iterations, "salt": salt]]
        return try PropertyListSerialization.data(fromPropertyList: shadow, format: .binary, options: 0)
    }

    static func kcpassword(_ password: String) -> Data {
        let key: [UInt8] = [0x7d, 0x89, 0x52, 0x23, 0xd2, 0xbc, 0xdd, 0xea, 0xa3, 0xb9, 0x1f]
        var p = Array(password.utf8)
        p.append(contentsOf: [UInt8](repeating: 0, count: 12 - p.count % 12))
        return Data(p.enumerated().map { $0.element ^ key[$0.offset % key.count] })
    }

    // MARK: TCC pre-grant

    /// Inserts "allowed" rows into the guest's system TCC.db for a path-identified client.
    /// `csreqHex` is the client's designated requirement compiled with csreq(1).
    func grantTCC(client: String, csreqHex: String?, services: [String]) throws -> String {
        let db = path("Library/Application Support/com.apple.TCC/TCC.db").path
        guard FileManager.default.fileExists(atPath: db) else { throw msg("no system TCC.db at \(db)") }
        let schema = String(decoding: try DataVolume.run("/usr/bin/sqlite3", [db, "PRAGMA table_info(access);"]), as: UTF8.self)
        let cols = Set(schema.split(separator: "\n").compactMap { $0.split(separator: "|").dropFirst().first.map(String.init) })
        var sql = ""
        for s in services {
            var row: [String: String] = [
                "service": "'\(s)'", "client": "'\(client)'", "client_type": "1", "auth_value": "2",
                "auth_reason": "4", "auth_version": "1", "csreq": csreqHex.map { "X'\($0)'" } ?? "NULL",
                "indirect_object_identifier": "'UNUSED'", "flags": "0", "last_modified": "CAST(strftime('%s','now') AS INTEGER)",
            ]
            if cols.contains("boot_uuid") { row["boot_uuid"] = "'UNUSED'" }
            if cols.contains("last_reminded") { row["last_reminded"] = "CAST(strftime('%s','now') AS INTEGER)" }
            if cols.contains("pid_version") { row["pid_version"] = "NULL" }
            let keys = row.keys.filter { cols.contains($0) }.sorted()
            sql += "INSERT OR REPLACE INTO access (\(keys.joined(separator: ","))) VALUES (\(keys.map { row[$0]! }.joined(separator: ",")));\n"
        }
        try DataVolume.run("/usr/bin/sqlite3", [db], input: Data(sql.utf8))
        let check = String(decoding: try DataVolume.run("/usr/bin/sqlite3", [db,
            "SELECT service,client,auth_value,auth_reason FROM access WHERE client='\(client)';"]), as: UTF8.self)
        return "columns: \(cols.sorted().joined(separator: ","))\nrows:\n\(check)"
    }
}
