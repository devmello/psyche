import Foundation
import PsycheProtocol

// L6 snapshots and resets: APFS clones of a stopped guest's disk, auxiliary storage, state record
// and (when saved) machine state, under `$PSYCHE_HOME/vm/<name>/snapshots/<id>/`. The guest's
// identity (HardwareModel, MachineIdentifier, MAC) is never copied, so a restore keeps the same Mac.

/// `snapshot.json` in a snapshot directory; encodes as the protocol's `VmSnapshot`.
public struct VMSnapshotRecord: Codable, Sendable, Equatable {
    public var id: String
    public var label: String
    public var kind: String
    public var taskId: String?
    public var createdAt: String
    public var guestOS: String?
    public var bytes: Int
    public var savedState: Bool
    public var provisioned: Bool
    public var psycheInstalled: Bool
    public var method: String

    public static let kinds: Set = ["base", "manual", "task"]

    enum CodingKeys: String, CodingKey {
        case id, label, kind, taskId, createdAt, guestOS, bytes, savedState, provisioned, psycheInstalled, method
    }

    /// `guestOS` is written as null when unknown (the protocol field is required and nullable).
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(label, forKey: .label)
        try c.encode(kind, forKey: .kind)
        try c.encodeIfPresent(taskId, forKey: .taskId)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(guestOS, forKey: .guestOS)
        try c.encode(bytes, forKey: .bytes)
        try c.encode(savedState, forKey: .savedState)
        try c.encode(provisioned, forKey: .provisioned)
        try c.encode(psycheInstalled, forKey: .psycheInstalled)
        try c.encode(method, forKey: .method)
    }
}

/// Copy-on-write file copy. Live: `clonefile(2)`; tests: a plain copy.
public protocol FileCloner: Sendable {
    func clone(_ from: URL, to: URL) throws
}

public struct CopyCloner: FileCloner {
    public init() {}
    public func clone(_ from: URL, to: URL) throws { try FileManager.default.copyItem(at: from, to: to) }
}

public enum SnapshotPolicy {
    public static let maxManual = 10
    public static let keepTasks = 3

    /// `^[a-z0-9][a-z0-9-]{0,63}$`
    public static func isValidId(_ s: String) -> Bool {
        guard let first = s.utf8.first, s.utf8.count <= 64, (97...122).contains(first) || (48...57).contains(first) else { return false }
        return s.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
    }

    public static func newId(kind: String, now: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyyMMdd-HHmmss"
        let suffix = String(UInt32.random(in: 0...UInt32.max), radix: 36)
        return "\(kind)-\(f.string(from: now))-\(suffix)"
    }

    /// Task snapshots beyond the newest `keepTasks` (records newest first).
    public static func tasksToPrune(_ records: [VMSnapshotRecord]) -> [String] {
        Array(records.filter { $0.kind == "task" }.dropFirst(keepTasks).map(\.id))
    }
}

extension VMBundle {
    public var snapshotsURL: URL { root.appendingPathComponent("snapshots", isDirectory: true) }
    public func snapshotURL(_ id: String) -> URL { snapshotsURL.appendingPathComponent(id, isDirectory: true) }

    /// Newest first.
    public func loadSnapshots() -> [VMSnapshotRecord] {
        let ids = (try? FileManager.default.contentsOfDirectory(atPath: snapshotsURL.path)) ?? []
        return ids.filter(SnapshotPolicy.isValidId).compactMap { id in
            try? read(VMSnapshotRecord.self, from: snapshotURL(id).appendingPathComponent("snapshot.json"))
        }.sorted { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) }
    }
}

/// Snapshot, restore and delete over a bundle. The caller checks the guest is not active and holds
/// the bundle's busy claim.
public struct VMSnapshotStore: Sendable {
    let cloner: any FileCloner
    let method: String

    public init(cloner: any FileCloner, method: String = "apfs-clone") {
        self.cloner = cloner
        self.method = method
    }

    static let disk = "Disk"
    static let aux = "AuxiliaryStorage"
    static let state = "state.json"
    static let saved = "SavedState.vzvmsave"

    public func create(
        _ bundle: VMBundle, config: VMConfig, kind: String, label: String?, taskId: String?, now: Date = Date()
    ) throws -> VMSnapshotRecord {
        guard VMSnapshotRecord.kinds.contains(kind) else { throw CapabilityError.invalidParams("kind is base, manual or task", field: "kind") }
        var existing = bundle.loadSnapshots()
        if kind == "manual", existing.filter({ $0.kind == "manual" }).count >= SnapshotPolicy.maxManual {
            throw CapabilityError(.conflict, reason: "snapshot_limit",
                                  "\(config.name) already has \(SnapshotPolicy.maxManual) snapshots; delete one first")
        }
        let fm = FileManager.default
        let diskURL = bundle.diskURL(format: config.diskFormat)
        guard fm.fileExists(atPath: diskURL.path), fm.fileExists(atPath: bundle.auxiliaryStorageURL.path) else {
            throw CapabilityError(.conflict, reason: "vm_not_installed", "\(config.name) has no installed disk to snapshot")
        }
        let id = SnapshotPolicy.newId(kind: kind, now: now)
        try fm.createDirectory(at: bundle.snapshotsURL, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let tmp = bundle.snapshotsURL.appendingPathComponent(".tmp-\(id)", isDirectory: true)
        try fm.createDirectory(at: tmp, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        do {
            try cloner.clone(diskURL, to: tmp.appendingPathComponent(diskURL.lastPathComponent))
            try cloner.clone(bundle.auxiliaryStorageURL, to: tmp.appendingPathComponent(Self.aux))
            let state = bundle.loadState() ?? VMStateRecord(phase: .stopped)
            try bundle.write(state, to: tmp.appendingPathComponent(Self.state))
            let hasSaved = fm.fileExists(atPath: bundle.savedStateURL.path)
            if hasSaved { try cloner.clone(bundle.savedStateURL, to: tmp.appendingPathComponent(Self.saved)) }
            let record = VMSnapshotRecord(
                id: id, label: label?.isEmpty == false ? String(label!.prefix(120)) : Self.defaultLabel(kind), kind: kind, taskId: taskId,
                createdAt: AppleDates.string(now), guestOS: config.guestOS, bytes: Self.allocated(tmp), savedState: hasSaved,
                provisioned: state.provisioned, psycheInstalled: state.psycheInstalled, method: method
            )
            try bundle.write(record, to: tmp.appendingPathComponent("snapshot.json"))
            try fm.moveItem(at: tmp, to: bundle.snapshotURL(id))
            // One base per guest: the previous one becomes a manual snapshot.
            if kind == "base" {
                for var old in existing where old.kind == "base" {
                    old.kind = "manual"
                    try? bundle.write(old, to: bundle.snapshotURL(old.id).appendingPathComponent("snapshot.json"))
                }
            }
            existing.insert(record, at: 0)
            for prune in SnapshotPolicy.tasksToPrune(existing) { try? fm.removeItem(at: bundle.snapshotURL(prune)) }
            return record
        } catch {
            try? fm.removeItem(at: tmp)
            throw error
        }
    }

    /// Replaces the guest's disk, auxiliary storage, state and saved state with the snapshot's.
    /// New files are cloned beside the old ones first, then swapped in, so a failed clone leaves
    /// the guest as it was.
    public func restore(_ bundle: VMBundle, config: VMConfig, id: String) throws -> VMSnapshotRecord {
        let record = try find(bundle, id: id)
        let fm = FileManager.default
        let dir = bundle.snapshotURL(id)
        let diskURL = bundle.diskURL(format: config.diskFormat)
        let staging = bundle.root.appendingPathComponent(".restore", isDirectory: true)
        try? fm.removeItem(at: staging)
        try fm.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: staging) }
        let newDisk = staging.appendingPathComponent(diskURL.lastPathComponent)
        let newAux = staging.appendingPathComponent(Self.aux)
        try cloner.clone(dir.appendingPathComponent(diskURL.lastPathComponent), to: newDisk)
        try cloner.clone(dir.appendingPathComponent(Self.aux), to: newAux)
        let newSaved = staging.appendingPathComponent(Self.saved)
        if record.savedState { try cloner.clone(dir.appendingPathComponent(Self.saved), to: newSaved) }

        _ = try fm.replaceItemAt(diskURL, withItemAt: newDisk)
        _ = try fm.replaceItemAt(bundle.auxiliaryStorageURL, withItemAt: newAux)
        try? fm.removeItem(at: bundle.savedStateURL)
        if record.savedState { try fm.moveItem(at: newSaved, to: bundle.savedStateURL) }
        var state = (try? bundle.read(VMStateRecord.self, from: dir.appendingPathComponent(Self.state))) ?? VMStateRecord(phase: .stopped)
        state.phase = record.savedState ? .saved : (state.provisioned ? .stopped : .installed)
        state.lastError = nil
        state.updatedAt = AppleDates.string(Date())
        try bundle.saveState(state)
        return record
    }

    public func delete(_ bundle: VMBundle, id: String) throws {
        _ = try find(bundle, id: id)
        try FileManager.default.removeItem(at: bundle.snapshotURL(id))
    }

    public func find(_ bundle: VMBundle, id: String) throws -> VMSnapshotRecord {
        guard SnapshotPolicy.isValidId(id), let r = bundle.loadSnapshots().first(where: { $0.id == id }) else {
            throw CapabilityError(.notFound, reason: "snapshot_not_found", "No snapshot \(id)")
        }
        return r
    }

    static func defaultLabel(_ kind: String) -> String {
        switch kind {
        case "base": "Fresh Mac"
        case "task": "Before a task"
        default: "Snapshot"
        }
    }

    /// Allocated bytes of the files in a directory (clones count their own allocation).
    static func allocated(_ dir: URL) -> Int {
        let keys: Set<URLResourceKey> = [.totalFileAllocatedSizeKey, .fileAllocatedSizeKey]
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: Array(keys))) ?? []
        return files.reduce(0) { sum, url in
            let v = try? url.resourceValues(forKeys: keys)
            return sum + (v?.totalFileAllocatedSize ?? v?.fileAllocatedSize ?? 0)
        }
    }
}
