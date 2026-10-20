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

/// Virtualization.framework behind a seam, so lifecycle, caps, shares and forwarding are tested
/// with a fake (no restore images are downloaded and no guest boots in CI or on dev machines).
public protocol VMBackend: AnyObject, Sendable {
    /// GUI-free provisioning is available (macOS 27 host; the guest must be 27 too).
    var supportsGuestProvisioning: Bool { get }
    func latestRestoreImage() async throws -> RestoreImageInfo
    func loadRestoreImage(_ url: URL) async throws -> RestoreImageInfo
    func download(_ image: RestoreImageInfo, to file: URL, progress: @escaping @Sendable (Double) -> Void) async throws
    /// Writes HardwareModel, MachineIdentifier, AuxiliaryStorage and the empty disk.
    func prepareBundle(_ bundle: VMBundle, config: VMConfig, image: URL) async throws
    func install(_ bundle: VMBundle, config: VMConfig, image: URL, progress: @escaping @Sendable (Double) -> Void) async throws
    /// Boots the guest headless. Every guest connection to `VsockPorts.gatewayNode` is handed to
    /// `onGatewayConnection` as a descriptor the callee owns.
    func start(_ bundle: VMBundle, config: VMConfig, shares: [ShareGrant], provisioning: GuestProvisioning?,
               onGatewayConnection: @escaping @Sendable (Int32) -> Void, onStop: @escaping @Sendable (String?) -> Void) async throws
    /// Asks the guest helper (vsock control port) to shut down; falls back to `requestStop`,
    /// then a forced stop when `force`. Returns whether the stop was graceful.
    func stop(_ name: String, force: Bool) async throws -> Bool
    /// Replaces the `psyche` share set of a running guest (live, no reboot).
    func setShares(_ name: String, shares: [ShareGrant]) async throws
    func isRunning(_ name: String) -> Bool
    var activeCount: Int { get }
}

/// Where the guest's admin password lives (needed again only for in-guest sudo).
public protocol VMSecretStore: Sendable {
    func store(name: String, secret: Data) async throws
    func delete(name: String) async throws
}

/// The keychain (no prompt: the helper needs it unattended for shutdown/mounts).
public struct KeychainVMSecretStore: VMSecretStore {
    let vault: KeychainVault
    public init(vault: KeychainVault = KeychainVault()) { self.vault = vault }
    public func store(name: String, secret: Data) async throws {
        _ = try await vault.store(name: "vm.\(name).password", value: secret, requireAuth: false, replace: true)
    }
    public func delete(name: String) async throws { try? await vault.delete(.item("vm.\(name).password")) }
}

/// Lifecycle of the one Psyche guest (L1–L5). Serialized per call; long operations stream progress.
public final class VMManager: @unchecked Sendable {
    let backend: any VMBackend
    let secrets: any VMSecretStore
    let environment: [String: String]
    let host: @Sendable () -> HostResources
    let log: HelperLog
    private let lock = NSLock()
    private var busy: Set<String> = []
    private var relays: [String: [StreamRelay]] = [:]

    public init(
        backend: any VMBackend, secrets: any VMSecretStore = KeychainVMSecretStore(),
        environment: [String: String] = ProcessInfo.processInfo.environment,
        host: @escaping @Sendable () -> HostResources = { HostResources.current() }, log: HelperLog = HelperLog()
    ) {
        self.backend = backend
        self.secrets = secrets
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
        // A helper restart loses running guests (they live in this process).
        if state.phase.isActive, !backend.isRunning(c.name) { state.phase = state.provisioned ? .stopped : .failed }
        var o: [String: JSONValue] = [
            "name": .string(c.name), "phase": .string(state.phase.rawValue), "provisioned": .bool(state.provisioned),
            "cpus": .int(c.cpus), "memoryGB": .int(c.memoryGB), "diskGB": .int(c.diskGB), "guestOS": c.guestOS.map { .string($0) } ?? .null,
            "username": .string(c.username),
            "shares": .array(b.loadShares().map { ["name": .string($0.name), "hostPath": .string($0.hostPath), "readOnly": .bool($0.readOnly), "guestPath": .string($0.guestPath)] }),
            "vsock": ["gatewayNodePort": .int(Int(VsockPorts.gatewayNode)), "hostCid": 2],
        ]
        if let e = state.lastError { o["lastError"] = .string(e) }
        return .object(o)
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
        try bundle.saveState(VMStateRecord(phase: .created))
        do {
            try await backend.prepareBundle(bundle, config: config, image: image)
            try bundle.saveState(VMStateRecord(phase: .installing))
            await emit(["type": "vm.install", "phase": "started", "version": .string(info.version)])
            try await backend.install(bundle, config: config, image: image) { f in
                _Concurrency.Task { await emit(["type": "vm.install", "phase": "progress", "fraction": .number(f)]) }
            }
            try bundle.saveState(VMStateRecord(phase: .installed))
            await emit(["type": "vm.install", "phase": "finished"])
        } catch {
            try? bundle.saveState(VMStateRecord(phase: .failed, lastError: Self.reason(error)))
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
        guard [.installed, .stopped, .failed].contains(state.phase) || (state.phase.isActive && !backend.isRunning(name)) else {
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
        try bundle.saveState(state)
        await emit(["type": "vm.state", "phase": .string(state.phase.rawValue)])
        let socketPath = HelperPaths.nodeSocketPath(environment: environment)
        do {
            try await backend.start(
                bundle, config: config, shares: bundle.loadShares(), provisioning: provisioning,
                onGatewayConnection: { [weak self] fd in self?.forward(guestFD: fd, name: name, socketPath: socketPath) },
                onStop: { [weak self] error in self?.stopped(name: name, error: error) }
            )
        } catch {
            try? bundle.saveState(VMStateRecord(phase: .failed, lastError: Self.reason(error), provisioned: state.provisioned))
            throw error
        }
        try bundle.saveState(VMStateRecord(phase: .running, provisioned: true))
        log.info("vm started name=\(name) provisioning=\(provisioning != nil)")
        return describe(bundle, config)
    }

    public func stop(name: String, force: Bool) async throws -> JSONValue {
        let (bundle, config) = try load(name)
        guard backend.isRunning(name) else { return describe(bundle, config) }
        var state = bundle.loadState() ?? VMStateRecord(phase: .running, provisioned: true)
        state.phase = .stopping
        try bundle.saveState(state)
        let graceful = try await backend.stop(name, force: force)
        state.phase = .stopped
        try bundle.saveState(state)
        closeRelays(name)
        var out = describe(bundle, config).objectValue ?? [:]
        out["graceful"] = .bool(graceful)
        return .object(out)
    }

    func stopped(name: String, error: String?) {
        closeRelays(name)
        guard let bundle = try? VMBundle.named(name, environment: environment), var state = bundle.loadState() else { return }
        state.phase = error == nil ? .stopped : .failed
        state.lastError = error
        try? bundle.saveState(state)
    }

    public func delete(name: String) async throws -> JSONValue {
        let (bundle, _) = try load(name)
        guard !backend.isRunning(name) else { throw CapabilityError(.conflict, reason: "vm_running", "Stop \(name) before deleting it") }
        try claim(name)
        defer { release(name) }
        try FileManager.default.removeItem(at: bundle.root)
        try? await secrets.delete(name: name)
        log.info("vm deleted name=\(name)")
        return ["deleted": true, "name": .string(name)]
    }

    // MARK: Shares (L5)

    public func addShare(name: String, share: String, path: String, readOnly: Bool, approvalId: String?) async throws -> JSONValue {
        let (bundle, config) = try load(name)
        var shares = bundle.loadShares()
        let grant = try SharePolicy.validate(
            name: share, path: path, readOnly: readOnly, approvalId: approvalId, existing: shares,
            psycheHome: HelperPaths.psycheHome(environment: environment)
        )
        shares.append(grant)
        if backend.isRunning(name) { try await backend.setShares(name, shares: shares) }
        try bundle.saveShares(shares)
        return describe(bundle, config)
    }

    public func removeShare(name: String, share: String) async throws -> JSONValue {
        let (bundle, config) = try load(name)
        var shares = bundle.loadShares()
        guard shares.contains(where: { $0.name == share }) else { throw CapabilityError(.notFound, reason: "share_not_found", "No share named \(share)") }
        shares.removeAll { $0.name == share }
        if backend.isRunning(name) { try await backend.setShares(name, shares: shares) }
        try bundle.saveShares(shares)
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
