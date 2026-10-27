import Foundation
import Virtualization
import DiskImageKit

/// One share exposed to the guest through a VirtioFS device. Shares with the
/// same tag are grouped into one VZMultipleDirectoryShare (the guest sees one
/// directory per `name` under the mount point).
struct ShareSpec: Codable, Equatable {
    var tag: String
    var name: String
    var path: String
    var readOnly: Bool
}

struct VMConfig: Codable {
    var cpus: Int
    var memoryGB: Int
    var diskGB: Int
    var diskFormat: String          // "asif" (DiskImageKit) or "raw"
    var macAddress: String
    var ipswPath: String
    var ipswBuild: String
    var guestOS: String
    var createdOnHost: String
    var shares: [ShareSpec] = []
    /// Frozen overlay layers above the base disk, bottom to top (relative paths).
    var layers: [String] = []
    /// Writable overlay on top of `layers`; nil means the base disk is written directly.
    var topOverlay: String? = nil
    var username: String? = nil
}

struct SnapshotRecord: Codable {
    var mode: String                // "overlay" or "apfs"
    var layers: [String]            // overlay mode: frozen layers that make up this snapshot
    var disk: String?               // apfs mode: cloned base disk
    var aux: String                 // cloned auxiliary storage (NVRAM) — never restore one without the other
    var created: Date
}

/// A VM bundle on disk:
///   HardwareModel, MachineIdentifier, AuxiliaryStorage, Disk.asif|Disk.img, config.json,
///   overlays/, snapshots/, snapshots.json, State.vzvmsave, control.sock, timings.jsonl
struct VMBundle {
    let root: URL

    init(_ path: String) { root = URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL }

    var hardwareModelURL: URL { root.appendingPathComponent("HardwareModel") }
    var machineIdentifierURL: URL { root.appendingPathComponent("MachineIdentifier") }
    var auxStorageURL: URL { root.appendingPathComponent("AuxiliaryStorage") }
    var configURL: URL { root.appendingPathComponent("config.json") }
    var snapshotsURL: URL { root.appendingPathComponent("snapshots.json") }
    var stateURL: URL { root.appendingPathComponent("State.vzvmsave") }
    var controlSocket: String { root.appendingPathComponent("control.sock").path }
    var timingsURL: URL { root.appendingPathComponent("timings.jsonl") }
    func url(_ rel: String) -> URL { root.appendingPathComponent(rel) }

    func baseDiskURL(_ cfg: VMConfig) -> URL {
        root.appendingPathComponent(cfg.diskFormat == "asif" ? "Disk.asif" : "Disk.img")
    }

    func loadConfig() throws -> VMConfig {
        try JSONDecoder().decode(VMConfig.self, from: Data(contentsOf: configURL))
    }

    func saveConfig(_ cfg: VMConfig) throws {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(cfg).write(to: configURL, options: .atomic)
    }

    func loadSnapshots() -> [String: SnapshotRecord] {
        guard let data = try? Data(contentsOf: snapshotsURL) else { return [:] }
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        return (try? dec.decode([String: SnapshotRecord].self, from: data)) ?? [:]
    }

    func saveSnapshots(_ s: [String: SnapshotRecord]) throws {
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(s).write(to: snapshotsURL, options: .atomic)
    }

    /// Append one JSON line to timings.jsonl so every measurement in the write-up is reproducible.
    func recordTiming(_ event: String, seconds: Double, extra: [String: String] = [:]) {
        var obj: [String: Any] = ["event": event, "seconds": (seconds * 1000).rounded() / 1000,
                                  "at": ISO8601DateFormatter().string(from: Date())]
        for (k, v) in extra { obj[k] = v }
        guard let line = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
        log("timing \(String(data: line, encoding: .utf8)!)")
        if let h = try? FileHandle(forWritingTo: timingsURL) {
            h.seekToEndOfFile(); h.write(line); h.write("\n".data(using: .utf8)!); try? h.close()
        } else {
            try? (line + "\n".data(using: .utf8)!).write(to: timingsURL)
        }
    }
}

/// Holds the DiskImageKit objects alive for as long as the VM uses them.
final class DiskHandle {
    let attachment: VZStorageDeviceAttachment
    let image: DiskImage?
    init(attachment: VZStorageDeviceAttachment, image: DiskImage?) { self.attachment = attachment; self.image = image }
}

enum Disk {
    static let blockSize = 512

    /// Creates an empty base disk. ASIF through DiskImageKit (macOS 27), RAW through ftruncate.
    static func createBase(_ url: URL, gb: Int, format: String) throws {
        let bytes = gb * 1024 * 1024 * 1024
        if format == "asif" {
            _ = try DiskImage(creating: .asif(url: url, blockCount: bytes / blockSize, blockSize: .bytes512))
        } else {
            FileManager.default.createFile(atPath: url.path, contents: nil)
            let h = try FileHandle(forWritingTo: url)
            try h.truncate(atOffset: UInt64(bytes))
            try h.close()
        }
    }

    /// Opens base (+ frozen layers read-only) (+ writable top overlay) and returns a storage attachment.
    static func attachment(bundle: VMBundle, cfg: VMConfig, readOnly: Bool = false) throws -> DiskHandle {
        let base = bundle.baseDiskURL(cfg)
        if cfg.diskFormat != "asif" {
            precondition(cfg.layers.isEmpty && cfg.topOverlay == nil, "overlays need an ASIF base")
            let a = try VZDiskImageStorageDeviceAttachment(url: base, readOnly: readOnly,
                                                           cachingMode: .automatic, synchronizationMode: .full)
            return DiskHandle(attachment: a, image: nil)
        }
        let stacked = cfg.topOverlay != nil || !cfg.layers.isEmpty
        var image: DiskImage = try DiskImage(opening: .open(url: base, mode: (stacked || readOnly) ? .readOnly : .readWrite))
        for layer in cfg.layers {
            let l = try DiskImage(opening: .open(url: bundle.url(layer), mode: .readOnly))
            image = try image.appending(l)
        }
        if let top = cfg.topOverlay {
            let t = try DiskImage(opening: .open(url: bundle.url(top), mode: readOnly ? .readOnly : .readWrite))
            image = try image.appending(t)
        }
        let a = try VZDiskImageStorageDeviceAttachment(diskImage: image, cachingMode: .automatic, synchronizationMode: .full)
        return DiskHandle(attachment: a, image: image)
    }

    /// Creates a new, empty overlay layer on top of base + `layers`. Returns its relative path.
    static func createOverlay(bundle: VMBundle, cfg: VMConfig) throws -> String {
        try FileManager.default.createDirectory(at: bundle.url("overlays"), withIntermediateDirectories: true)
        let rel = "overlays/\(UUID().uuidString.prefix(8)).asif"
        var image: DiskImage = try DiskImage(opening: .open(url: bundle.baseDiskURL(cfg), mode: .readOnly))
        for layer in cfg.layers {
            image = try image.appending(DiskImage(opening: .open(url: bundle.url(layer), mode: .readOnly)))
        }
        _ = try image.appending(.asifLayer(url: bundle.url(rel), type: .overlay))
        return rel
    }

    /// APFS clonefile(2): O(metadata) copy that shares blocks until written.
    static func clone(_ src: URL, _ dst: URL) throws {
        try? FileManager.default.removeItem(at: dst)
        try FileManager.default.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard clonefile(src.path, dst.path, 0) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno),
                          userInfo: [NSLocalizedDescriptionKey: "clonefile \(src.path) -> \(dst.path): \(String(cString: strerror(errno)))"])
        }
    }

    /// Allocated (not logical) size of a file, which is what a sparse ASIF layer or a clone actually costs.
    static func allocatedBytes(_ url: URL) -> Int64 {
        var st = stat()
        guard stat(url.path, &st) == 0 else { return 0 }
        return Int64(st.st_blocks) * 512
    }
}

func log(_ s: String) {
    let ts = String(format: "%.3f", Date().timeIntervalSince1970.truncatingRemainder(dividingBy: 100000))
    FileHandle.standardError.write("[\(ts)] \(s)\n".data(using: .utf8)!)
}

func fail(_ s: String) -> Never {
    log("error: \(s)")
    exit(1)
}

func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }
