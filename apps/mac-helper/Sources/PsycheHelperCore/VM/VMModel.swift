import Foundation
import PsycheProtocol

// VM mode (features L1–L5; architecture §10; security §13; ADR-009; spike 06). Pure model:
// configuration, bundle layout, lifecycle, guest cap. Virtualization.framework lives behind
// `VMBackend` in PsycheHelperSystem.

/// Host resources the defaults and limits are checked against.
public struct HostResources: Sendable, Equatable {
    public var cpuCount: Int
    public var memoryGB: Int
    public var freeDiskGB: Int
    public var osMajor: Int

    public init(cpuCount: Int, memoryGB: Int, freeDiskGB: Int, osMajor: Int) {
        self.cpuCount = cpuCount
        self.memoryGB = memoryGB
        self.freeDiskGB = freeDiskGB
        self.osMajor = osMajor
    }

    public static func current() -> HostResources {
        let p = ProcessInfo.processInfo
        let free = (try? URL(fileURLWithPath: NSHomeDirectory())
            .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage)
            .flatMap { $0 }.map { Int($0 / 1_000_000_000) } ?? 0
        return HostResources(cpuCount: p.activeProcessorCount, memoryGB: Int(p.physicalMemory / 1_073_741_824), freeDiskGB: free,
                             osMajor: p.operatingSystemVersion.majorVersion)
    }
}

/// One guest's settings (`config.json` in the bundle). Defaults: 4 vCPU / 8 GB / 80 GB (L1).
public struct VMConfig: Codable, Sendable, Equatable {
    enum CodingKeys: String, CodingKey {
        case name, cpus, memoryGB, diskGB, displayWidth, displayHeight, macAddress, diskFormat, username, guestOS, createdAt, clipboard, vault
    }

    /// Bundles written before M3 have no clipboard / vault keys.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        cpus = try c.decode(Int.self, forKey: .cpus)
        memoryGB = try c.decode(Int.self, forKey: .memoryGB)
        diskGB = try c.decode(Int.self, forKey: .diskGB)
        displayWidth = try c.decodeIfPresent(Int.self, forKey: .displayWidth) ?? 1920
        displayHeight = try c.decodeIfPresent(Int.self, forKey: .displayHeight) ?? 1200
        macAddress = try c.decode(String.self, forKey: .macAddress)
        diskFormat = try c.decodeIfPresent(String.self, forKey: .diskFormat) ?? "raw"
        username = try c.decodeIfPresent(String.self, forKey: .username) ?? "psyche"
        guestOS = try c.decodeIfPresent(String.self, forKey: .guestOS)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        clipboard = try c.decodeIfPresent(String.self, forKey: .clipboard) ?? "paste_only"
        vault = try c.decodeIfPresent(String.self, forKey: .vault) ?? "host"
    }

    public var name: String
    public var cpus: Int
    public var memoryGB: Int
    public var diskGB: Int
    public var displayWidth: Int
    public var displayHeight: Int
    /// Locally administered MAC, fixed per guest (the NAT lease still moves; never used for control).
    public var macAddress: String
    /// `asif` (DiskImageKit, macOS 27 host) or `raw` (sparse file).
    public var diskFormat: String
    public var username: String
    /// Guest macOS version from the restore image, e.g. "27.0.1".
    public var guestOS: String?
    public var createdAt: String
    /// Host ↔ guest clipboard (security §13): `paste_only` (into the guest) by default.
    public var clipboard: String = "paste_only"
    /// Credential placement (L5): the host vault as a node capability by default.
    public var vault: String = "host"

    public static let clipboardModes: Set = ["off", "paste_only", "bidirectional"]
    public static let vaultPlacements: Set = ["host", "guest"]

    public static let defaultCPUs = 4
    public static let defaultMemoryGB = 8
    public static let defaultDiskGB = 80
    /// macOS 27 guests need at least 2 CPUs and 4 GB (spike 06).
    public static let minCPUs = 2
    public static let minMemoryGB = 4
    public static let minDiskGB = 40

    public init(
        name: String, cpus: Int = defaultCPUs, memoryGB: Int = defaultMemoryGB, diskGB: Int = defaultDiskGB,
        displayWidth: Int = 1920, displayHeight: Int = 1200, macAddress: String = VMConfig.randomMAC(), diskFormat: String = "raw",
        username: String = "psyche", guestOS: String? = nil, createdAt: String = ISO8601DateFormatter().string(from: Date())
    ) {
        self.name = name
        self.cpus = cpus
        self.memoryGB = memoryGB
        self.diskGB = diskGB
        self.displayWidth = displayWidth
        self.displayHeight = displayHeight
        self.macAddress = macAddress
        self.diskFormat = diskFormat
        self.username = username
        self.guestOS = guestOS
        self.createdAt = createdAt
    }

    /// `^[a-z0-9][a-z0-9-]{0,31}$`
    public static func isValidName(_ s: String) -> Bool {
        guard let first = s.utf8.first, s.utf8.count <= 32, (97...122).contains(first) || (48...57).contains(first) else { return false }
        return s.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
    }

    /// Validates against the host: the guest leaves the host at least 2 CPUs and 4 GB, and the
    /// disk fits in free space (ASIF / RAW are sparse, but the install alone is ~35 GB).
    public func validate(host: HostResources) throws {
        guard Self.isValidName(name) else { throw CapabilityError.invalidParams("name must match ^[a-z0-9][a-z0-9-]{0,31}$", field: "name") }
        guard cpus >= Self.minCPUs, cpus <= max(Self.minCPUs, host.cpuCount - 2) else {
            throw CapabilityError.invalidParams("cpus must be \(Self.minCPUs)–\(max(Self.minCPUs, host.cpuCount - 2)) on this Mac", field: "cpus")
        }
        guard memoryGB >= Self.minMemoryGB, memoryGB <= max(Self.minMemoryGB, host.memoryGB - 4) else {
            throw CapabilityError.invalidParams("memoryGB must be \(Self.minMemoryGB)–\(max(Self.minMemoryGB, host.memoryGB - 4)) on this Mac", field: "memoryGB")
        }
        guard diskGB >= Self.minDiskGB, diskGB <= 2048 else {
            throw CapabilityError.invalidParams("diskGB must be \(Self.minDiskGB)–2048", field: "diskGB")
        }
        guard host.freeDiskGB >= 40 else {
            throw CapabilityError(.unavailable, reason: "disk_full", "At least 40 GB free disk space is needed for a guest", details: ["freeDiskGB": .int(host.freeDiskGB)])
        }
        guard (640...3840).contains(displayWidth), (480...2400).contains(displayHeight) else {
            throw CapabilityError.invalidParams("display must be 640×480 to 3840×2400", field: "display")
        }
        guard Self.clipboardModes.contains(clipboard) else { throw CapabilityError.invalidParams("clipboard is off, paste_only or bidirectional", field: "clipboard") }
        guard Self.vaultPlacements.contains(vault) else { throw CapabilityError.invalidParams("vault is host or guest", field: "vault") }
        guard !username.isEmpty, username.count <= 32, username.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) }) else {
            throw CapabilityError.invalidParams("username must be lowercase letters and digits", field: "username")
        }
    }

    /// A locally administered, unicast MAC (`x2:…`).
    public static func randomMAC() -> String {
        var b = (0..<6).map { _ in UInt8.random(in: 0...255) }
        b[0] = (b[0] & 0xFC) | 0x02
        return b.map { String(format: "%02x", $0) }.joined(separator: ":")
    }
}

/// Lifecycle (L1). `VMPhase` is the generated protocol enum (`packages/protocol` `VmPhase`); the
/// helper adds the transition rules. Persisted in `state.json` so a helper restart knows where a
/// guest stands.
extension VMPhase: CaseIterable {
    public static let allCases: [VMPhase] = [.created, .installing, .installed, .provisioning, .stopped, .starting, .running, .stopping, .failed, .paused, .saved]

    /// Phases that count against the framework's two-active-guests cap (installs count, spike 06).
    public var isActive: Bool { [.installing, .provisioning, .starting, .running, .stopping, .paused].contains(self) }

    static let transitions: [VMPhase: Set<VMPhase>] = [
        .created: [.installing, .failed],
        .installing: [.installed, .failed, .created],
        .installed: [.provisioning, .starting, .failed],
        .provisioning: [.running, .stopped, .failed],
        .stopped: [.starting, .failed],
        .starting: [.running, .stopped, .failed],
        .running: [.stopping, .stopped, .failed, .paused],
        .paused: [.running, .saved, .stopping, .stopped, .failed],
        .saved: [.starting, .stopped, .failed],
        .stopping: [.stopped, .failed],
        .failed: [.created, .installed, .stopped, .starting, .installing],
    ]

    public func canMove(to next: VMPhase) -> Bool { Self.transitions[self]?.contains(next) ?? false }
}

public struct VMStateRecord: Codable, Sendable, Equatable {
    public var phase: VMPhase
    public var updatedAt: String
    public var lastError: String?
    /// Whether the first (provisioning) boot completed; later boots skip provisioning.
    public var provisioned: Bool
    /// Guest Psyche payload installed over SSH (L3).
    public var psycheInstalled: Bool = false
    /// Accessibility / Screen Recording rows written into the guest's TCC.db offline (L3).
    public var permissionsGranted: Bool = false

    enum CodingKeys: String, CodingKey { case phase, updatedAt, lastError, provisioned, psycheInstalled, permissionsGranted }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        phase = try c.decode(VMPhase.self, forKey: .phase)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
        lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
        provisioned = try c.decodeIfPresent(Bool.self, forKey: .provisioned) ?? false
        psycheInstalled = try c.decodeIfPresent(Bool.self, forKey: .psycheInstalled) ?? false
        permissionsGranted = try c.decodeIfPresent(Bool.self, forKey: .permissionsGranted) ?? false
    }

    public init(phase: VMPhase, updatedAt: String = ISO8601DateFormatter().string(from: Date()), lastError: String? = nil, provisioned: Bool = false) {
        self.phase = phase
        self.updatedAt = updatedAt
        self.lastError = lastError
        self.provisioned = provisioned
    }
}

/// `$PSYCHE_HOME/vm/<name>/` (architecture §10): disk, auxiliary storage, hardware model, machine
/// identifier, config and state. Directories 0700, files 0600.
public struct VMBundle: Sendable, Equatable {
    public let root: URL

    public init(root: URL) { self.root = root }

    public static func vmRoot(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        URL(fileURLWithPath: HelperPaths.psycheHome(environment: environment)).appendingPathComponent("vm", isDirectory: true)
    }

    public static func named(_ name: String, environment: [String: String] = ProcessInfo.processInfo.environment) throws -> VMBundle {
        guard VMConfig.isValidName(name) else { throw CapabilityError.invalidParams("bad VM name", field: "name") }
        return VMBundle(root: vmRoot(environment: environment).appendingPathComponent(name, isDirectory: true))
    }

    public var configURL: URL { root.appendingPathComponent("config.json") }
    public var stateURL: URL { root.appendingPathComponent("state.json") }
    public var sharesURL: URL { root.appendingPathComponent("shares.json") }
    public var hardwareModelURL: URL { root.appendingPathComponent("HardwareModel") }
    public var machineIdentifierURL: URL { root.appendingPathComponent("MachineIdentifier") }
    public var auxiliaryStorageURL: URL { root.appendingPathComponent("AuxiliaryStorage") }
    public func diskURL(format: String) -> URL { root.appendingPathComponent(format == "asif" ? "Disk.asif" : "Disk.img") }

    public var exists: Bool { FileManager.default.fileExists(atPath: configURL.path) }
    /// Machine state for warm start (`saveMachineStateTo`; unproven on 27.0.1, spike 06).
    public var savedStateURL: URL { root.appendingPathComponent("SavedState.vzvmsave") }
    /// Host → guest staging, shared read-only on the automount tag as `psyche-in`.
    public var transferInURL: URL { root.appendingPathComponent("transfer/in", isDirectory: true) }
    /// Guest → host staging, shared read-write on the `psyche` tag as `_psyche-out` (only the guest helper writes it).
    public var transferOutURL: URL { root.appendingPathComponent("transfer/out", isDirectory: true) }
    public var transfersURL: URL { root.appendingPathComponent("transfers.json") }
    public var sshDirURL: URL { root.appendingPathComponent("ssh", isDirectory: true) }
    public func saveTransfers(_ t: [VMTransferRecord]) throws { try write(t, to: transfersURL) }
    public func loadTransfers() -> [VMTransferRecord] { (try? read([VMTransferRecord].self, from: transfersURL)) ?? [] }

    public func create() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
    }

    func write<T: Encodable>(_ value: T, to url: URL) throws {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(value).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    func read<T: Decodable>(_ type: T.Type, from url: URL) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }

    public func saveConfig(_ c: VMConfig) throws { try write(c, to: configURL) }
    public func loadConfig() throws -> VMConfig { try read(VMConfig.self, from: configURL) }
    public func saveState(_ s: VMStateRecord) throws { try write(s, to: stateURL) }
    public func loadState() -> VMStateRecord? { try? read(VMStateRecord.self, from: stateURL) }
    public func saveShares(_ s: [ShareGrant]) throws { try write(s, to: sharesURL) }
    public func loadShares() -> [ShareGrant] { (try? read([ShareGrant].self, from: sharesURL)) ?? [] }

    /// All bundles under the VM root.
    public static func all(environment: [String: String] = ProcessInfo.processInfo.environment) -> [VMBundle] {
        let root = vmRoot(environment: environment)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        return names.sorted().filter(VMConfig.isValidName).map { VMBundle(root: root.appendingPathComponent($0, isDirectory: true)) }.filter(\.exists)
    }
}

/// Guest-count rules: one guest per user (ADR-009) and the framework's two active macOS guests.
public enum GuestCap {
    public static let frameworkMaxActive = 2

    public static func checkCreate(existing: [String]) throws {
        if let other = existing.first {
            throw CapabilityError(.conflict, reason: "guest_exists", "Psyche keeps one sandbox Mac per user; \(other) already exists",
                                  details: ["name": .string(other)])
        }
    }

    /// `othersActive` counts macOS guests this helper knows about; guests started by other apps
    /// still surface as the framework's Code 6 at start.
    public static func checkStart(othersActive: Int) throws {
        if othersActive >= frameworkMaxActive {
            throw CapabilityError(.unavailable, reason: "guest_limit",
                                  "The maximum supported number of active virtual machines has been reached (two macOS guests, installs included).",
                                  retryable: true)
        }
    }
}

/// One copy in or out of the guest (security §13: write-back is an explicit copy with a receipt).
public struct VMTransferRecord: Codable, Sendable, Equatable {
    public var id: String
    public var direction: String
    public var hostPath: String
    public var guestPath: String
    public var bytes: Int
    public var createdAt: String

    public init(id: String, direction: String, hostPath: String, guestPath: String, bytes: Int, createdAt: String = ISO8601DateFormatter().string(from: Date())) {
        self.id = id
        self.direction = direction
        self.hostPath = hostPath
        self.guestPath = guestPath
        self.bytes = bytes
        self.createdAt = createdAt
    }
}
