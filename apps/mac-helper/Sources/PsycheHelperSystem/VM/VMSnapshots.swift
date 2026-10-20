import Darwin
import Foundation
import PsycheHelperCore
import PsycheProtocol

/// `clonefile(2)`: an APFS copy-on-write clone, instant for an 80 GB disk (L6 "reset under 30 s").
public struct APFSCloner: FileCloner {
    public init() {}

    public func clone(_ from: URL, to: URL) throws {
        guard clonefile(from.path, to.path, 0) == 0 else {
            let code = errno
            if code == ENOTSUP || code == EXDEV {
                throw CapabilityError(.unavailable, reason: "clone_unsupported",
                                      "Snapshots need the Psyche home on an APFS volume (copy-on-write clones)")
            }
            if code == ENOSPC { throw CapabilityError(.unavailable, reason: "disk_full", "Not enough free space for the snapshot") }
            throw CapabilityError(.unavailable, reason: "clone_failed", "Could not clone \(from.lastPathComponent) (errno \(code))")
        }
    }
}

// MARK: - L6 on the manager

extension VMManager {
    public struct SnapshotParams: Decodable, Sendable {
        public var name: String?
        public var label: String?
        public var kind: String?
        public var taskId: String?
    }

    /// Phases a snapshot or restore may run in: nothing is booted or being installed. A booted
    /// phase without a running guest is stale (the helper restarted) and counts as stopped.
    static let restingPhases: Set<VMPhase> = [.stopped, .saved, .installed, .failed]
    static let staleIfNotRunning: Set<VMPhase> = [.provisioning, .starting, .running, .stopping, .paused]

    func requireResting(_ bundle: VMBundle, _ name: String) throws {
        let phase = bundle.loadState()?.phase ?? .created
        guard !backend.isRunning(name), Self.restingPhases.contains(phase) || Self.staleIfNotRunning.contains(phase) else {
            throw CapabilityError(.conflict, reason: "vm_running", "\(name) must be installed and stopped (or saved) for snapshots and resets")
        }
    }

    public func snapshot(_ p: SnapshotParams, emit: @escaping @Sendable (JSONValue) async -> Void) async throws -> JSONValue {
        let name = p.name ?? "sandbox"
        let (bundle, config) = try load(name)
        try requireResting(bundle, name)
        try claim(name)
        defer { release(name) }
        await emit(["type": "vm.snapshot", "phase": "started"])
        let store = snapshotStore
        let record = try await Self.blocking {
            try store.create(bundle, config: config, kind: p.kind ?? "manual", label: p.label, taskId: p.taskId)
        }
        await emit(["type": "vm.snapshot", "phase": "finished"])
        log.info("vm snapshot name=\(name) kind=\(record.kind)")
        publish(bundle)
        return ["snapshot": try JSONValue(encoding: record), "guest": describe(bundle, config)]
    }

    public func restore(name: String, snapshot id: String, emit: @escaping @Sendable (JSONValue) async -> Void) async throws -> JSONValue {
        let (bundle, config) = try load(name)
        try requireResting(bundle, name)
        try claim(name)
        defer { release(name) }
        let started = Date()
        await emit(["type": "vm.reset", "phase": "started"])
        let store = snapshotStore
        let record = try await Self.blocking { try store.restore(bundle, config: config, id: id) }
        dropAgent(name)
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        await emit(["type": "vm.reset", "phase": "finished"])
        log.info("vm restored name=\(name) kind=\(record.kind) ms=\(ms)")
        publish(bundle)
        return ["guest": describe(bundle, config), "snapshot": .string(record.id), "durationMs": .int(ms)]
    }

    /// "Fresh Mac": back to the base snapshot.
    public func reset(name: String, emit: @escaping @Sendable (JSONValue) async -> Void) async throws -> JSONValue {
        let (bundle, _) = try load(name)
        guard let base = bundle.loadSnapshots().first(where: { $0.kind == "base" }) else {
            throw CapabilityError(.notFound, reason: "no_base_snapshot", "\(name) has no base snapshot; take one with kind \"base\" first")
        }
        return try await restore(name: name, snapshot: base.id, emit: emit)
    }

    public func deleteSnapshot(name: String, snapshot id: String) async throws -> JSONValue {
        let (bundle, config) = try load(name)
        try claim(name)
        defer { release(name) }
        let store = snapshotStore
        try await Self.blocking { try store.delete(bundle, id: id) }
        publish(bundle)
        return describe(bundle, config)
    }
}
