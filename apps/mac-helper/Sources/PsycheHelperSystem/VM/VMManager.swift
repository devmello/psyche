import Foundation
import PsycheHelperCore
import PsycheProtocol

/// Restore image found in Apple's catalog or a local IPSW.
public struct RestoreImageInfo: Sendable, Equatable {
    public var url: URL
    public var version: String
    public var build: String
    public var sizeBytes: Int64?

    public init(url: URL, version: String, build: String, sizeBytes: Int64? = nil) {
        self.url = url
        self.version = version
        self.build = build
        self.sizeBytes = sizeBytes
    }
}

/// First-boot provisioning (`VZMacGuestProvisioningOptions`, macOS 27 host and guest).
public struct GuestProvisioning: Sendable, Equatable {
    public var username: String
    public var fullName: String
    public var password: String
    public var autoLogin: Bool
    public var remoteLogin: Bool
}

/// Where the guest's admin password lives (needed again only for in-guest sudo).
public protocol VMSecretStore: Sendable {
    func store(name: String, secret: Data) async throws
    func read(name: String) async throws -> Data
    func delete(name: String) async throws
}

/// The keychain (no prompt: the helper needs it unattended for shutdown/mounts).
public struct KeychainVMSecretStore: VMSecretStore {
    let vault: KeychainVault
    public init(vault: KeychainVault = KeychainVault()) { self.vault = vault }
    public func store(name: String, secret: Data) async throws {
        _ = try await vault.store(name: "vm.\(name).password", value: secret, requireAuth: false, replace: true)
    }
    public func read(name: String) async throws -> Data {
        try await vault.retrieve(name: "vm.\(name).password", reason: "Psyche needs the sandbox Mac's admin password")
    }
    public func delete(name: String) async throws { try? await vault.delete(.item("vm.\(name).password")) }
}

/// Lifecycle of the one Psyche guest (L1–L5). Serialized per guest; long operations stream
/// progress; every state change is published on `events` (`vm.watch` → the Gateway's `vm.updated`).
public final class VMManager: @unchecked Sendable {
    let backend: any VMBackend
    let secrets: any VMSecretStore
    let shell: any GuestShell
    let permissions: any GuestPermissionWriter
    let environment: [String: String]
    let host: @Sendable () -> HostResources
    let log: HelperLog
    public let events = VMEventHub()
    private let lock = NSLock()
    private var busy: Set<String> = []
    private var relays: [String: [StreamRelay]] = [:]
    private var agents: [String: GuestAgentClient] = [:]
    private var agentStatus: [String: JSONValue] = [:]
    private var payloads: [String: URL] = [:]

    public init(
        backend: any VMBackend, secrets: any VMSecretStore = KeychainVMSecretStore(), shell: any GuestShell = SSHGuestShell(),
        permissions: any GuestPermissionWriter = OfflineTCCWriter(), environment: [String: String] = ProcessInfo.processInfo.environment,
        host: @escaping @Sendable () -> HostResources = { HostResources.current() }, log: HelperLog = HelperLog()
    ) {
        self.backend = backend
        self.secrets = secrets
        self.shell = shell
        self.permissions = permissions
        self.environment = environment
        self.host = host
        self.log = log
    }

    // MARK: Status

    public func status() -> JSONValue {
        let guests: [JSONValue] = VMBundle.all(environment: environment).compactMap { b in
            guard let c = try? b.loadConfig() else { return nil }
            return describe(b, c)
        }
        return [
            "guests": .array(guests), "active": .int(backend.activeCount),
            "supportsGuestProvisioning": .bool(backend.supportsGuestProvisioning), "maxActive": .int(GuestCap.frameworkMaxActive),
        ]
    }

    func describe(_ b: VMBundle, _ c: VMConfig) -> JSONValue {
        var state = b.loadState() ?? VMStateRecord(phase: .created)
        let running = backend.isRunning(c.name)
        // A helper restart loses running guests (they live in this process).
        if state.phase.isActive, !running { state.phase = state.provisioned ? .stopped : .failed }
        if running, backend.isPaused(c.name) { state.phase = .paused }
        let saved = FileManager.default.fileExists(atPath: b.savedStateURL.path)
        if !running, saved, state.phase == .stopped { state.phase = .saved }
        var o: [String: JSONValue] = [
            "name": .string(c.name), "phase": .string(state.phase.rawValue), "provisioned": .bool(state.provisioned),
            "cpus": .int(c.cpus), "memoryGB": .int(c.memoryGB), "diskGB": .int(c.diskGB), "guestOS": c.guestOS.map { .string($0) } ?? .null,
            "username": .string(c.username),
            "shares": .array(b.loadShares().map { ["name": .string($0.name), "hostPath": .string($0.hostPath), "readOnly": .bool($0.readOnly), "guestPath": .string($0.guestPath)] }),
            "vsock": ["gatewayNodePort": .int(Int(VsockPorts.gatewayNode)), "hostCid": 2],
            "display": ["width": .int(c.displayWidth), "height": .int(c.displayHeight), "visible": .bool(running && backend.isDisplayVisible(c.name))],
            "clipboard": .string(c.clipboard), "vault": .string(c.vault),
            "agent": lock.withLock { agentStatus[c.name] } ?? ["connected": false],
            "psycheInstalled": .bool(state.psycheInstalled), "permissionsGranted": .bool(state.permissionsGranted), "savedState": .bool(saved),
            "transfers": (try? JSONValue(encoding: Array(b.loadTransfers().suffix(20)))) ?? .array([]),
        ]
        if let e = state.lastError { o["lastError"] = .string(e) }
        return .object(o)
    }

    /// Persists a state change and publishes the guest (`vm.watch`).
    func setState(_ bundle: VMBundle, _ record: VMStateRecord) throws {
        var r = record
        if let old = bundle.loadState() {
            // Flags survive phase changes unless the caller set them.
            r.psycheInstalled = r.psycheInstalled || old.psycheInstalled
            r.permissionsGranted = r.permissionsGranted || old.permissionsGranted
            r.provisioned = r.provisioned || old.provisioned
        }
        try bundle.saveState(r)
        publish(bundle)
    }

    func publish(_ bundle: VMBundle) {
        guard let c = try? bundle.loadConfig() else { return }
        events.publish(["type": "vm.updated", "guest": describe(bundle, c), "at": .string(AppleDates.string(Date()))])
    }

    // MARK: Create + install (L1)

    public struct CreateParams: Decodable, Sendable {
        public var name: String?
        public var cpus: Int?
        public var memoryGB: Int?
        public var diskGB: Int?
        /// Local IPSW path; when absent the latest supported image is downloaded (needs `download: true`).
        public var ipsw: String?
        public var download: Bool?
        public var username: String?
    }

    public func create(_ p: CreateParams, emit: @escaping @Sendable (JSONValue) async -> Void) async throws -> JSONValue {
        let name = p.name ?? "sandbox"
        let existing = VMBundle.all(environment: environment).map { $0.root.lastPathComponent }
        try GuestCap.checkCreate(existing: existing)
        try GuestCap.checkStart(othersActive: backend.activeCount)  // installs count against the cap
        var config = VMConfig(
            name: name, cpus: p.cpus ?? VMConfig.defaultCPUs, memoryGB: p.memoryGB ?? VMConfig.defaultMemoryGB,
            diskGB: p.diskGB ?? VMConfig.defaultDiskGB, diskFormat: VZBackendInfo.asifAvailable ? "asif" : "raw",
            username: p.username ?? "psyche"
        )
        try config.validate(host: host())
        try claim(name)
        defer { release(name) }

        // The restore image: a local IPSW, or Apple's latest (26+ GB, shown before download).
        let image: URL
        let info: RestoreImageInfo
        if let path = p.ipsw {
            guard path.hasPrefix("/"), FileManager.default.fileExists(atPath: path) else {
                throw CapabilityError(.notFound, reason: "ipsw_not_found", "No IPSW at \(path)")
            }
            image = URL(fileURLWithPath: path)
            info = try await backend.loadRestoreImage(image)
        } else {
            let latest = try await backend.latestRestoreImage()
            guard p.download == true else {
                throw CapabilityError(.invalidParams, reason: "download_not_confirmed",
                                      "Creating the guest downloads macOS \(latest.version) (\(Self.gb(latest.sizeBytes))). Pass download: true to confirm.",
                                      details: ["version": .string(latest.version), "sizeBytes": latest.sizeBytes.map { .number(Double($0)) } ?? .null])
            }
            let cache = VMBundle.vmRoot(environment: environment).appendingPathComponent("cache", isDirectory: true)
            try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let file = cache.appendingPathComponent("\(latest.build).ipsw")
            if !FileManager.default.fileExists(atPath: file.path) {
                await emit(["type": "vm.download", "phase": "started", "version": .string(latest.version)])
                try await backend.download(latest, to: file) { f in _Concurrency.Task { await emit(["type": "vm.download", "phase": "progress", "fraction": .number(f)]) } }
                await emit(["type": "vm.download", "phase": "finished"])
            }
            image = file
            info = try await backend.loadRestoreImage(file)
        }
        config.guestOS = info.version

        let bundle = try VMBundle.named(name, environment: environment)
        try bundle.create()
        try bundle.saveConfig(config)
        try setState(bundle, VMStateRecord(phase: .created))
        do {
            try await backend.prepareBundle(bundle, config: config, image: image)
            try setState(bundle, VMStateRecord(phase: .installing))
            await emit(["type": "vm.install", "phase": "started", "version": .string(info.version)])
            try await backend.install(bundle, config: config, image: image) { f in
                _Concurrency.Task { await emit(["type": "vm.install", "phase": "progress", "fraction": .number(f)]) }
            }
            try setState(bundle, VMStateRecord(phase: .installed))
            await emit(["type": "vm.install", "phase": "finished"])
        } catch {
            try? setState(bundle, VMStateRecord(phase: .failed, lastError: Self.reason(error)))
            throw error
        }
        log.info("vm created name=\(name) guestOS=\(info.version) format=\(config.diskFormat)")
        return describe(bundle, config)
    }

    // MARK: Start / stop (L1, L2)

    public func start(name: String, emit: @escaping @Sendable (JSONValue) async -> Void) async throws -> JSONValue {
        let (bundle, config) = try load(name)
        var state = bundle.loadState() ?? VMStateRecord(phase: .created)
        if backend.isRunning(name) { return describe(bundle, config) }
        guard [.installed, .stopped, .failed, .saved].contains(state.phase) || (state.phase.isActive && !backend.isRunning(name)) else {
            throw CapabilityError(.conflict, reason: "vm_not_ready", "\(name) is \(state.phase.rawValue); install it first")
        }
        try GuestCap.checkStart(othersActive: backend.activeCount)
        try claim(name)
        defer { release(name) }

        var provisioning: GuestProvisioning?
        if !state.provisioned {
            guard backend.supportsGuestProvisioning, (config.guestOS.flatMap { Int($0.split(separator: ".").first ?? "") } ?? 0) >= 27 else {
                throw CapabilityError(.unavailable, reason: "provisioning_unsupported",
                                      "Unattended setup needs macOS 27 on this Mac and in the guest. Older guests need one guided step (turn on Remote Login).")
            }
            let password = Self.randomPassword()
            try await secrets.store(name: name, secret: Data(password.utf8))
            provisioning = GuestProvisioning(username: config.username, fullName: "Psyche", password: password, autoLogin: true, remoteLogin: true)
        }
        state.phase = provisioning == nil ? .starting : .provisioning
        try setState(bundle, state)
        await emit(["type": "vm.state", "phase": .string(state.phase.rawValue)])
        let socketPath = HelperPaths.nodeSocketPath(environment: environment)
        let saved = bundle.savedStateURL
        let restore = provisioning == nil && FileManager.default.fileExists(atPath: saved.path) ? saved : nil
        func boot(_ from: URL?) async throws {
            try await backend.start(
                bundle, config: config, shares: bundle.loadShares(), system: systemShares(bundle, name), provisioning: provisioning, restoreFrom: from,
                onGatewayConnection: { [weak self] fd in self?.forward(guestFD: fd, name: name, socketPath: socketPath) },
                onStop: { [weak self] error in self?.stopped(name: name, error: error) }
            )
        }
        do {
            do {
                try await boot(restore)
            } catch let e as CapabilityError where e.reason == "restore_failed" {
                // Warm start is unproven (spike 06): discard the state and boot cold.
                try? FileManager.default.removeItem(at: saved)
                await emit(["type": "vm.state", "phase": "starting"])
                try await boot(nil)
            }
            // The framework invalidates a restored state file once the disk moves on.
            if restore != nil { try? FileManager.default.removeItem(at: saved) }
        } catch {
            try? setState(bundle, VMStateRecord(phase: .failed, lastError: Self.reason(error), provisioned: state.provisioned))
            throw error
        }
        var running = VMStateRecord(phase: .running, provisioned: true)
        running.psycheInstalled = state.psycheInstalled
        running.permissionsGranted = state.permissionsGranted
        try setState(bundle, running)
        log.info("vm started name=\(name) provisioning=\(provisioning != nil) warm=\(restore != nil)")
        return describe(bundle, config)
    }

    /// Shutdown through the guest helper (`guest.shutdown`; `requestStop` is ignored by a logged-in
    /// macOS guest), then `requestStop`, then a forced stop when `force`.
    public func stop(name: String, force: Bool) async throws -> JSONValue {
        let (bundle, config) = try load(name)
        guard backend.isRunning(name) else { return describe(bundle, config) }
        var state = bundle.loadState() ?? VMStateRecord(phase: .running, provisioned: true)
        state.phase = .stopping
        try setState(bundle, state)
        var graceful = false
        if let password = try? await secrets.read(name: name), let agent = try? await agent(name) {
            graceful = (try? await Self.blocking { try agent.call(GuestAgentMethod.shutdown, ["password": .string(String(decoding: password, as: UTF8.self))], timeout: 20) }) != nil
        }
        let stoppedCleanly = try await backend.stop(name, force: force || graceful)
        graceful = graceful || stoppedCleanly
        state.phase = .stopped
        try setState(bundle, state)
        closeRelays(name)
        dropAgent(name)
        var out = describe(bundle, config).objectValue ?? [:]
        out["graceful"] = .bool(graceful)
        return .object(out)
    }

    public func pause(name: String) async throws -> JSONValue {
        let (bundle, config) = try load(name)
        guard backend.isRunning(name) else { throw CapabilityError(.conflict, reason: "vm_not_running", "\(name) is not running") }
        try await backend.pause(name)
        publish(bundle)
        return describe(bundle, config)
    }

    public func resume(name: String) async throws -> JSONValue {
        let (bundle, config) = try load(name)
        guard backend.isRunning(name) else { throw CapabilityError(.conflict, reason: "vm_not_running", "\(name) is not running") }
        try await backend.resume(name)
        publish(bundle)
        return describe(bundle, config)
    }

    /// Warm start: save the machine state and stop (spike 06 could not save on 27.0.1: re-test).
    public func suspend(name: String) async throws -> JSONValue {
        let (bundle, config) = try load(name)
        guard backend.isRunning(name) else { throw CapabilityError(.conflict, reason: "vm_not_running", "\(name) is not running") }
        try claim(name)
        defer { release(name) }
        try await backend.saveState(name, to: bundle.savedStateURL)
        closeRelays(name)
        dropAgent(name)
        var state = bundle.loadState() ?? VMStateRecord(phase: .running, provisioned: true)
        state.phase = .saved
        try setState(bundle, state)
        return describe(bundle, config)
    }

    func stopped(name: String, error: String?) {
        closeRelays(name)
        dropAgent(name)
        guard let bundle = try? VMBundle.named(name, environment: environment), var state = bundle.loadState() else { return }
        if state.phase != .saved { state.phase = error == nil ? .stopped : .failed }
        state.lastError = error
        try? setState(bundle, state)
    }

    // MARK: Settings (L1 resources, L4 display and clipboard, L5 credential placement)

    public struct ConfigureParams: Decodable, Sendable {
        public var name: String?
        public var cpus: Int?
        public var memoryGB: Int?
        public var displayWidth: Int?
        public var displayHeight: Int?
        public var clipboard: String?
        public var vault: String?
    }

    public func configure(_ p: ConfigureParams) throws -> JSONValue {
        let name = p.name ?? "sandbox"
        let (bundle, old) = try load(name)
        var c = old
        let hardware = p.cpus != nil || p.memoryGB != nil || p.displayWidth != nil || p.displayHeight != nil
        if hardware, backend.isRunning(name) || FileManager.default.fileExists(atPath: bundle.savedStateURL.path) {
            throw CapabilityError(.conflict, reason: "vm_running", "Stop \(name) (and discard any saved state) before changing CPUs, memory or display")
        }
        if let v = p.cpus { c.cpus = v }
        if let v = p.memoryGB { c.memoryGB = v }
        if let v = p.displayWidth { c.displayWidth = v }
        if let v = p.displayHeight { c.displayHeight = v }
        if let v = p.clipboard { c.clipboard = v }
        if let v = p.vault { c.vault = v }
        try c.validate(host: host())
        try bundle.saveConfig(c)
        publish(bundle)
        return describe(bundle, c)
    }

    public func setDisplay(name: String, visible: Bool) async throws -> JSONValue {
        let (bundle, config) = try load(name)
        guard backend.isRunning(name) else { throw CapabilityError(.conflict, reason: "vm_not_running", "\(name) is not running") }
        try await backend.setDisplay(name, visible: visible)
        publish(bundle)
        return describe(bundle, config)
    }

    // MARK: Teardown

    public func delete(name: String) async throws -> JSONValue {
        let (bundle, _) = try load(name)
        guard !backend.isRunning(name) else { throw CapabilityError(.conflict, reason: "vm_running", "Stop \(name) before deleting it") }
        try claim(name)
        defer { release(name) }
        try FileManager.default.removeItem(at: bundle.root)
        try? await secrets.delete(name: name)
        lock.withLock { _ = payloads.removeValue(forKey: name) }
        events.publish(["type": "vm.deleted", "name": .string(name)])
        log.info("vm deleted name=\(name)")
        return ["deleted": true, "name": .string(name)]
    }

    // MARK: Shares (L5)

    func systemShares(_ bundle: VMBundle, _ name: String) -> VMSystemShares {
        .of(bundle, payload: lock.withLock { payloads[name] })
    }

    public func addShare(name: String, share: String, path: String, readOnly: Bool, approvalId: String?) async throws -> JSONValue {
        let (bundle, config) = try load(name)
        var shares = bundle.loadShares()
        let grant = try SharePolicy.validate(
            name: share, path: path, readOnly: readOnly, approvalId: approvalId, existing: shares,
            psycheHome: HelperPaths.psycheHome(environment: environment)
        )
        shares.append(grant)
        if backend.isRunning(name) { try await backend.setShares(name, shares: shares, system: systemShares(bundle, name)) }
        try bundle.saveShares(shares)
        publish(bundle)
        return describe(bundle, config)
    }

    public func removeShare(name: String, share: String) async throws -> JSONValue {
        let (bundle, config) = try load(name)
        var shares = bundle.loadShares()
        guard shares.contains(where: { $0.name == share }) else { throw CapabilityError(.notFound, reason: "share_not_found", "No share named \(share)") }
        shares.removeAll { $0.name == share }
        if backend.isRunning(name) { try await backend.setShares(name, shares: shares, system: systemShares(bundle, name)) }
        try bundle.saveShares(shares)
        publish(bundle)
        return describe(bundle, config)
    }

    // MARK: Guest agent channel (L3)

    static func blocking<T: Sendable>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<T, Error>) in
            DispatchQueue.global(qos: .userInitiated).async { c.resume(with: Result { try body() }) }
        }
    }

    /// The connected guest helper (connects on first use; reconnects after a drop).
    func agent(_ name: String) async throws -> GuestAgentClient {
        if let a = lock.withLock({ agents[name] }) { return a }
        let fd = try await backend.connectGuestAgent(name)
        let client = GuestAgentClient(fd: fd)
        lock.withLock { agents[name] = client }
        return client
    }

    func dropAgent(_ name: String) {
        lock.withLock {
            agents[name] = nil
            agentStatus[name] = ["connected": false]
        }
    }

    /// `guest.ping`: version and the guest helper's own permission state.
    public func ping(name: String) async throws -> JSONValue {
        let (bundle, config) = try load(name)
        guard backend.isRunning(name) else { throw CapabilityError(.conflict, reason: "vm_not_running", "\(name) is not running") }
        do {
            let a = try await agent(name)
            let r = try await Self.blocking { try a.call(GuestAgentMethod.ping, timeout: 10) }
            var s: [String: JSONValue] = ["connected": true, "lastSeenAt": .string(AppleDates.string(Date()))]
            for k in ["version", "accessibility", "screenRecording"] { if let v = r[k] { s[k] = v } }
            lock.withLock { agentStatus[name] = .object(s) }
        } catch {
            dropAgent(name)
            throw error
        }
        publish(bundle)
        return describe(bundle, config)
    }

    // MARK: File transfer (security §13: explicit copies with receipts)

    static func transferId() -> String {
        String(UUID().uuidString.lowercased().prefix(13)).replacingOccurrences(of: "-", with: "")
    }

    /// Copies a host file or folder into `psyche-in/<id>/` (read-only in the guest at
    /// `/Volumes/My Shared Files/psyche-in/<id>/<name>`). Sensitive folders are refused.
    public func copyIn(name: String, hostPath: String) throws -> (VMTransferRecord, JSONValue) {
        let (bundle, config) = try load(name)
        let src = URL(fileURLWithPath: hostPath).resolvingSymlinksInPath().standardizedFileURL
        guard hostPath.hasPrefix("/"), FileManager.default.fileExists(atPath: src.path) else {
            throw CapabilityError(.notFound, reason: "not_found", "\(hostPath) does not exist")
        }
        try SharePolicy.checkSensitive(src.path, psycheHome: HelperPaths.psycheHome(environment: environment))
        let id = Self.transferId()
        let dir = bundle.transferInURL.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let dest = dir.appendingPathComponent(src.lastPathComponent)
        try FileManager.default.copyItem(at: src, to: dest)  // APFS clone when possible
        let record = VMTransferRecord(id: id, direction: "in", hostPath: src.path, guestPath: "/Volumes/My Shared Files/psyche-in/\(id)/\(src.lastPathComponent)",
                                      bytes: Self.size(dest))
        try bundle.saveTransfers(bundle.loadTransfers() + [record])
        publish(bundle)
        return (record, describe(bundle, config))
    }

    /// Asks the guest helper to copy a guest file into `_psyche-out/<id>/`, then moves it into a
    /// granted host folder (never overwriting).
    public func copyOut(name: String, guestPath: String, hostDir: String) async throws -> (VMTransferRecord, JSONValue) {
        let (bundle, config) = try load(name)
        guard backend.isRunning(name) else { throw CapabilityError(.conflict, reason: "vm_not_running", "\(name) is not running") }
        let dir = try FinderRoots.load(environment: environment).resolve(hostDir)
        let password = try await secrets.read(name: name)
        let id = Self.transferId()
        let a = try await agent(name)
        let pw = String(decoding: password, as: UTF8.self)
        _ = try await Self.blocking { try a.call(GuestAgentMethod.mountShares, ["password": .string(pw)], timeout: 30) }
        _ = try await Self.blocking { try a.call(GuestAgentMethod.export, ["path": .string(guestPath), "transferId": .string(id)], timeout: 600) }
        let staged = bundle.transferOutURL.appendingPathComponent(id, isDirectory: true)
        guard let file = try FileManager.default.contentsOfDirectory(at: staged, includingPropertiesForKeys: nil).first else {
            throw CapabilityError(.unavailable, reason: "copy_out_missing", "The guest did not produce the file")
        }
        var dest = URL(fileURLWithPath: dir).appendingPathComponent(file.lastPathComponent)
        var n = 2
        while FileManager.default.fileExists(atPath: dest.path) {
            dest = URL(fileURLWithPath: dir).appendingPathComponent("\(file.deletingPathExtension().lastPathComponent) \(n)" + (file.pathExtension.isEmpty ? "" : ".\(file.pathExtension)"))
            n += 1
        }
        try FileManager.default.moveItem(at: file, to: dest)
        try? FileManager.default.removeItem(at: staged)
        let record = VMTransferRecord(id: id, direction: "out", hostPath: dest.path, guestPath: guestPath, bytes: Self.size(dest))
        try bundle.saveTransfers(bundle.loadTransfers() + [record])
        publish(bundle)
        return (record, describe(bundle, config))
    }

    static func size(_ url: URL) -> Int {
        if let s = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) != true { return s }
        let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey])
        var total = 0
        while let f = e?.nextObject() as? URL { total += (try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0 }
        return total
    }

    // MARK: Guest Psyche install (L3)

    static let payloadGuestPath = "/Volumes/My Shared Files/psyche-payload"

    /// Shares a Psyche release or checkout read-only with the running guest and runs its
    /// `apps/node/scripts/guest-bootstrap.sh` over SSH (key installed with the provisioning
    /// password on first contact). psyche-node then connects over vsock 2:7980 through the guest
    /// helper's `vsock-bridge`, and the guest helper starts its vsock 7000 agent.
    public func installPsyche(name: String, payload: String, emit: @escaping @Sendable (JSONValue) async -> Void) async throws -> JSONValue {
        let (bundle, config) = try load(name)
        guard backend.isRunning(name), let state = bundle.loadState(), state.provisioned else {
            throw CapabilityError(.conflict, reason: "vm_not_running", "Start the provisioned guest first")
        }
        let root = URL(fileURLWithPath: payload).resolvingSymlinksInPath()
        guard FileManager.default.fileExists(atPath: root.appendingPathComponent("apps/node/scripts/guest-bootstrap.sh").path) else {
            throw CapabilityError.invalidParams("payload must be a Psyche release or checkout (apps/node/scripts/guest-bootstrap.sh missing)", field: "payload")
        }
        let hasHelper = FileManager.default.fileExists(atPath: root.appendingPathComponent("Psyche Helper.app").path)
        try claim(name)
        defer { release(name) }
        lock.withLock { payloads[name] = root }
        try await backend.setShares(name, shares: bundle.loadShares(), system: systemShares(bundle, name))
        await emit(["type": "vm.psyche_install", "phase": "started"])
        guard let ip = shell.address(mac: config.macAddress) else {
            throw CapabilityError(.unavailable, reason: "guest_ip_unknown", "The guest has no network address yet; wait for it to finish booting", retryable: true)
        }
        let password = String(decoding: try await secrets.read(name: name), as: UTF8.self)
        try FileManager.default.createDirectory(at: bundle.sshDirURL, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let pub = try shell.ensureKey(in: bundle.sshDirURL)
        let b64 = Data((pub + "\n").utf8).base64EncodedString()
        let installKey = "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo \(b64) | base64 -D >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
        let k = try await shell.run(host: ip, user: config.username, keyDir: bundle.sshDirURL, password: password, command: installKey, timeout: 60)
        guard k.status == 0 else { throw CapabilityError(.unavailable, reason: "ssh_failed", "Could not reach the guest over SSH (\(k.status))", retryable: true) }
        await emit(["type": "vm.psyche_install", "phase": "progress", "fraction": .number(0.3)])
        let helperApp = "/Users/\(config.username)/Applications/Psyche Helper.app"
        let bridge = #"["\#(helperApp)/Contents/MacOS/psyche-helper","vsock-bridge","{cid}:{port}"]"#
        var command = "PSYCHE_NODE_VSOCK_BRIDGE='\(bridge)' /bin/sh '\(Self.payloadGuestPath)/apps/node/scripts/guest-bootstrap.sh' --repo '\(Self.payloadGuestPath)' --vsock 2:\(VsockPorts.gatewayNode)"
        if hasHelper {
            command = "mkdir -p ~/Applications && /usr/bin/ditto '\(Self.payloadGuestPath)/Psyche Helper.app' '\(helperApp)' && " + command + " --helper-app '\(helperApp)'"
        }
        let r = try await shell.run(host: ip, user: config.username, keyDir: bundle.sshDirURL, password: nil, command: command, timeout: 900)
        guard r.status == 0 else {
            throw CapabilityError(.unavailable, reason: "guest_bootstrap_failed", "guest-bootstrap.sh failed in the guest (\(r.status))", details: ["output": .string(String(r.output.suffix(2000)))])
        }
        var st = state
        st.psycheInstalled = true
        try setState(bundle, st)
        await emit(["type": "vm.psyche_install", "phase": "finished"])
        log.info("vm psyche installed name=\(name) helper=\(hasHelper)")
        return describe(bundle, config)
    }

    /// Pre-grants Accessibility and Screen Recording to the guest helper by writing the guest's
    /// TCC.db offline (stopped guest; SIP blocks in-guest writes, spike 06).
    public func grantPermissions(name: String, payload: String, emit: @escaping @Sendable (JSONValue) async -> Void) async throws -> JSONValue {
        let (bundle, config) = try load(name)
        guard !backend.isRunning(name) else { throw CapabilityError(.conflict, reason: "vm_running", "Stop \(name) first; permissions are written offline") }
        guard let state = bundle.loadState(), state.psycheInstalled else {
            throw CapabilityError(.conflict, reason: "psyche_not_installed", "Install Psyche in the guest first (vm.install_psyche)")
        }
        let app = URL(fileURLWithPath: payload).appendingPathComponent("Psyche Helper.app")
        guard FileManager.default.fileExists(atPath: app.path) else {
            throw CapabilityError.invalidParams("payload has no Psyche Helper.app", field: "payload")
        }
        try claim(name)
        defer { release(name) }
        await emit(["type": "vm.permissions", "phase": "started"])
        let client = GuestTCC.Client(bundleId: "com.psyche.helper", csreq: try permissions.designatedRequirement(app: app))
        try await permissions.grant(bundle, config: config, client: client)
        var st = state
        st.permissionsGranted = true
        try setState(bundle, st)
        await emit(["type": "vm.permissions", "phase": "finished"])
        return describe(bundle, config)
    }

    // MARK: vsock → Gateway node socket (L3)

    /// Relays one guest psyche-node stream to the Gateway's node socket. The Gateway authenticates
    /// it like any node (signed handshake; a new guest is a pending pairing the owner approves).
    func forward(guestFD: Int32, name: String, socketPath: String) {
        do {
            guard let gwFD = try UnixSocketConnection(path: socketPath).releaseDescriptor() else { Darwin.close(guestFD); return }
            let relay = StreamRelay(guestFD, gwFD)
            lock.lock()
            relays[name, default: []].append(relay)
            lock.unlock()
            relay.start { [weak self] in
                guard let self else { return }
                self.lock.lock()
                self.relays[name]?.removeAll { $0 === relay }
                self.lock.unlock()
            }
            log.info("vm vsock relay opened name=\(name)")
        } catch {
            log.error("vm vsock relay: Gateway node socket unavailable")
            Darwin.close(guestFD)
        }
    }

    func closeRelays(_ name: String) {
        lock.lock()
        let rs = relays.removeValue(forKey: name) ?? []
        lock.unlock()
        for r in rs {
            Darwin.shutdown(r.a, SHUT_RDWR)
            Darwin.shutdown(r.b, SHUT_RDWR)
        }
    }

    // MARK: Helpers

    func load(_ name: String) throws -> (VMBundle, VMConfig) {
        let bundle = try VMBundle.named(name, environment: environment)
        guard bundle.exists, let config = try? bundle.loadConfig() else {
            throw CapabilityError(.notFound, reason: "vm_not_found", "No guest named \(name)")
        }
        return (bundle, config)
    }

    func claim(_ name: String) throws {
        lock.lock()
        defer { lock.unlock() }
        guard busy.insert(name).inserted else {
            throw CapabilityError(.conflict, reason: "vm_busy", "\(name) is busy with another operation", retryable: true)
        }
    }

    func release(_ name: String) {
        lock.lock()
        busy.remove(name)
        lock.unlock()
    }

    static func reason(_ error: Error) -> String {
        (error as? CapabilityError)?.reason ?? "backend_error"
    }

    static func gb(_ bytes: Int64?) -> String {
        guard let bytes else { return "size unknown" }
        return String(format: "%.1f GB", Double(bytes) / 1e9)
    }

    /// 24 characters from an unambiguous alphabet.
    static func randomPassword() -> String {
        let alphabet = Array("abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return String(bytes.map { alphabet[Int($0) % alphabet.count] })
    }
}
