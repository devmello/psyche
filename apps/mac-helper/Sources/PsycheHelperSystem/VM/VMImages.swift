import Foundation
import PsycheHelperCore
import PsycheProtocol

// L7: export a provisioned guest as a prebuilt image, create a guest from one, and rotate the
// image's bootstrap password at first start.
extension VMManager {
    public struct ExportImageParams: Decodable, Sendable {
        public var name: String?
        public var outDir: String
        public var id: String?
    }

    /// `outDir/<id>/`: disk, auxiliary storage and hardware model (copied: APFS clones on the same
    /// volume), `bootstrap.json` with the current guest password, and `manifest.json` with every
    /// file's SHA-256. Never the MachineIdentifier, MAC, SSH keys, shares or saved state.
    public func exportImage(_ p: ExportImageParams, emit: @escaping @Sendable (JSONValue) async -> Void) async throws -> JSONValue {
        let name = p.name ?? "sandbox"
        let (bundle, config) = try load(name)
        try requireResting(bundle, name)
        guard let state = bundle.loadState(), state.provisioned else {
            throw CapabilityError(.conflict, reason: "vm_not_provisioned", "Only a provisioned guest can become an image (start it once first)")
        }
        guard !state.passwordRotationPending else {
            throw CapabilityError(.conflict, reason: "password_rotation_pending", "Start the guest once so its bootstrap password is rotated first")
        }
        guard p.outDir.hasPrefix("/") else { throw CapabilityError.invalidParams("outDir must be absolute", field: "outDir") }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: p.outDir, isDirectory: &isDir), isDir.boolValue else {
            throw CapabilityError(.notFound, reason: "out_dir_not_found", "No folder at \(p.outDir)")
        }
        let guestOS = config.guestOS ?? "unknown"
        let id = p.id ?? "macos-\(guestOS)-\(Self.dayStamp())".lowercased()
        guard GuestImage.isValidId(id) else { throw CapabilityError.invalidParams("id must match ^[a-z0-9][a-z0-9.-]{0,63}$", field: "id") }
        let dest = URL(fileURLWithPath: p.outDir).appendingPathComponent(id, isDirectory: true)
        guard !FileManager.default.fileExists(atPath: dest.path) else {
            throw CapabilityError(.conflict, reason: "image_exists", "\(dest.path) already exists")
        }
        let password = String(decoding: try await secrets.read(name: name), as: UTF8.self)
        guard GuestImage.Bootstrap.isValidPassword(password) else {
            throw CapabilityError(.unavailable, reason: "image_invalid", "The guest password cannot be carried in an image")
        }
        try claim(name)
        defer { release(name) }
        await emit(["type": "vm.export", "phase": "started"])
        let log = self.log
        let manifest: GuestImage.Manifest
        let manifestSha: String
        do {
            (manifest, manifestSha) = try await Self.blocking {
                let fm = FileManager.default
                try fm.createDirectory(at: dest, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                let disk = bundle.diskURL(format: config.diskFormat)
                let sources: [(String, URL)] = [
                    (disk.lastPathComponent, disk), ("AuxiliaryStorage", bundle.auxiliaryStorageURL), ("HardwareModel", bundle.hardwareModelURL),
                ]
                for (fileName, src) in sources { try fm.copyItem(at: src, to: dest.appendingPathComponent(fileName)) }
                let bootstrap = try GuestImage.encoder().encode(GuestImage.Bootstrap(username: config.username, password: password))
                try bootstrap.write(to: dest.appendingPathComponent("bootstrap.json"))
                var files: [GuestImage.File] = []
                for fileName in (sources.map(\.0) + ["bootstrap.json"]).sorted() {
                    let url = dest.appendingPathComponent(fileName)
                    try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
                    let size = (try fm.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
                    files.append(GuestImage.File(name: fileName, bytes: size, sha256: try GuestImage.sha256(file: url)))
                }
                let m = GuestImage.Manifest(
                    id: id, guestOS: guestOS, diskFormat: config.diskFormat, diskGB: config.diskGB, username: config.username,
                    createdAt: AppleDates.string(Date()), provisioned: true, psycheInstalled: state.psycheInstalled,
                    permissionsGranted: state.permissionsGranted, psycheVersion: HelperVersion.current, files: files
                )
                return (m, try GuestImage.writeManifest(m, to: dest))
            }
        } catch {
            try? FileManager.default.removeItem(at: dest)
            throw error
        }
        await emit(["type": "vm.export", "phase": "finished"])
        log.info("vm image exported name=\(name) id=\(id)")
        return ["path": .string(dest.path), "manifest": try JSONValue(encoding: manifest), "manifestSha256": .string(manifestSha)]
    }

    /// `vm.create {image}`: verify every checksum first, then copy the files into a new bundle,
    /// mint a new MachineIdentifier and MAC, and keep the bootstrap password in the keychain until
    /// the first start rotates it. One guest per user still applies.
    func importImage(_ p: CreateParams, emit: @escaping @Sendable (JSONValue) async -> Void) async throws -> JSONValue {
        let name = p.name ?? "sandbox"
        guard let path = p.image, path.hasPrefix("/") else { throw CapabilityError.invalidParams("image must be an absolute path", field: "image") }
        try GuestCap.checkCreate(existing: VMBundle.all(environment: environment).map { $0.root.lastPathComponent })
        try claim(name)
        defer { release(name) }
        await emit(["type": "vm.import", "phase": "started"])
        let (dir, cleanup) = try await Self.imageDirectory(path, cache: VMBundle.vmRoot(environment: environment).appendingPathComponent("cache", isDirectory: true))
        defer { cleanup() }
        let expected = p.imageSha256
        let manifest = try await Self.blocking {
            try GuestImage.verify(dir, expectedManifestSha256: expected) { f in
                _Concurrency.Task { await emit(["type": "vm.import", "phase": "progress", "fraction": .number(f * 0.8)]) }
            }
        }
        let bootstrap = try JSONDecoder().decode(GuestImage.Bootstrap.self, from: Data(contentsOf: dir.appendingPathComponent("bootstrap.json")))
        var config = VMConfig(
            name: name, cpus: p.cpus ?? VMConfig.defaultCPUs, memoryGB: p.memoryGB ?? VMConfig.defaultMemoryGB, diskGB: manifest.diskGB,
            diskFormat: manifest.diskFormat, username: manifest.username, guestOS: manifest.guestOS
        )
        try config.validate(host: host())
        let bundle = try VMBundle.named(name, environment: environment)
        try bundle.create()
        let diskTarget = bundle.diskURL(format: config.diskFormat)
        do {
            try await Self.blocking {
                let fm = FileManager.default
                for (from, to) in [(manifest.diskName, diskTarget), ("AuxiliaryStorage", bundle.auxiliaryStorageURL),
                                   ("HardwareModel", bundle.hardwareModelURL)] {
                    try fm.copyItem(at: dir.appendingPathComponent(from), to: to)
                    try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: to.path)
                }
            }
            config.macAddress = VMConfig.randomMAC()
            try bundle.saveConfig(config)
            try await backend.prepareImported(bundle, config: config)
            try await secrets.store(name: name, secret: Data(bootstrap.password.utf8))
            var state = VMStateRecord(phase: .stopped, provisioned: true)
            state.psycheInstalled = manifest.psycheInstalled
            state.permissionsGranted = manifest.permissionsGranted
            state.passwordRotationPending = true
            state.image = .init(id: manifest.id, guestOS: manifest.guestOS, createdAt: manifest.createdAt)
            try bundle.saveState(state)
        } catch {
            try? FileManager.default.removeItem(at: bundle.root)
            try? await secrets.delete(name: name)
            throw error
        }
        await emit(["type": "vm.import", "phase": "finished"])
        log.info("vm imported name=\(name) image=\(manifest.id) guestOS=\(manifest.guestOS)")
        publish(bundle)
        return describe(bundle, config)
    }

    /// A directory as is, or a `.aar` (Apple Archive) extracted into the VM cache.
    static func imageDirectory(_ path: String, cache: URL) async throws -> (URL, @Sendable () -> Void) {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir) else {
            throw CapabilityError(.notFound, reason: "image_not_found", "No guest image at \(path)")
        }
        if isDir.boolValue { return (URL(fileURLWithPath: path), {}) }
        guard path.hasSuffix(".aar") else { throw CapabilityError.invalidParams("image must be a directory or a .aar archive", field: "image") }
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let out = cache.appendingPathComponent("import-\(UInt32.random(in: 0...UInt32.max))", isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let r = try await DisclaimedProcess.run("/usr/bin/aa", ["extract", "-i", path, "-d", out.path], timeout: 3600)
        guard r.status == 0 else {
            try? FileManager.default.removeItem(at: out)
            throw CapabilityError(.invalidParams, reason: "image_invalid", "Could not extract the image archive")
        }
        // `aa archive -d <image>` stores the directory's contents; accept one top-level folder too.
        var dir = out
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: out.path)) ?? []
        if !entries.contains("manifest.json"), entries.count == 1 { dir = out.appendingPathComponent(entries[0], isDirectory: true) }
        return (dir, { try? FileManager.default.removeItem(at: out) })
    }

    /// First start of an imported guest: replace the image's bootstrap password (account, login
    /// keychain, auto-login) and its SSH keys with this helper's own. Failure leaves the guest
    /// running and the rotation pending for the next start.
    func rotateBootstrapPassword(name: String, emit: @escaping @Sendable (JSONValue) async -> Void, attempts: Int = 60, interval: TimeInterval = 3) async {
        guard let (bundle, config) = try? load(name), let oldData = try? await secrets.read(name: name) else { return }
        let old = String(decoding: oldData, as: UTF8.self)
        let new = Self.randomPassword()
        guard GuestImage.Bootstrap.isValidPassword(old), GuestImage.Bootstrap.isValidPassword(new) else { return }
        await emit(["type": "vm.import", "phase": "rotating"])
        var ip: String?
        for i in 0..<attempts {
            ip = shell.address(mac: config.macAddress)
            if ip != nil { break }
            if i < attempts - 1 { try? await _Concurrency.Task.sleep(nanoseconds: UInt64(interval * 1e9)) }
        }
        guard let ip else {
            log.error("vm password rotation: no guest address name=\(name)")
            return
        }
        do {
            try FileManager.default.createDirectory(at: bundle.sshDirURL, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let pub = try shell.ensureKey(in: bundle.sshDirURL)
            let command = Self.rotationCommand(user: config.username, old: old, new: new, publicKey: pub)
            var result: (status: Int32, output: String) = (-1, "")
            for i in 0..<max(1, attempts / 6) {
                result = try await shell.run(host: ip, user: config.username, keyDir: bundle.sshDirURL, password: old, command: command, timeout: 120)
                if result.status == 0 { break }
                if i < attempts / 6 - 1 { try? await _Concurrency.Task.sleep(nanoseconds: UInt64(interval * 1e9)) }
            }
            guard result.status == 0 else { throw CapabilityError(.unavailable, reason: "password_rotation_failed", "status \(result.status)") }
            try await secrets.store(name: name, secret: Data(new.utf8))
            if var state = bundle.loadState() {
                state.passwordRotationPending = false
                try bundle.saveState(state)
            }
            publish(bundle)
            await emit(["type": "vm.import", "phase": "finished"])
            log.info("vm bootstrap password rotated name=\(name)")
        } catch {
            log.error("vm password rotation failed name=\(name) reason=\(Self.reason(error))")
        }
    }

    /// One SSH command as the guest user (password auth with the old password): change the account
    /// password, the login keychain's, and auto-login's; then make this helper's key the only one.
    /// Passwords are alphanumeric (checked), so single quotes are safe.
    static func rotationCommand(user: String, old: String, new: String, publicKey: String) -> String {
        let b64 = Data((publicKey + "\n").utf8).base64EncodedString()
        return [
            "dscl . -passwd /Users/\(user) '\(old)' '\(new)'",
            "security set-keychain-password -o '\(old)' -p '\(new)' ~/Library/Keychains/login.keychain-db",
            "echo '\(new)' | sudo -S -p '' sysadminctl -autologin set -userName \(user) -password '\(new)'",
            "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo \(b64) | base64 -D > ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys",
        ].joined(separator: " && ")
    }

    static func dayStamp() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyyMMdd"
        return f.string(from: Date())
    }
}
