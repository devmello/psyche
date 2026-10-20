import CryptoKit
import Foundation
import PsycheProtocol

/// L7 prebuilt guest images: an installed, provisioned guest (Psyche installed, Accessibility and
/// Screen Recording pre-granted) as a directory of checksummed files plus `manifest.json`. An image
/// never carries the machine identity: import mints a new MachineIdentifier and MAC, and rotates
/// the bootstrap password at first start.
///
///     <id>/manifest.json      the protocol's VmImageManifest
///     <id>/Disk.asif|Disk.img
///     <id>/AuxiliaryStorage
///     <id>/HardwareModel
///     <id>/bootstrap.json     {username, password}: the guest admin before rotation
public enum GuestImage {
    public static let format = "psyche-guest-image"
    public static let formatVersion = 1

    public struct File: Codable, Sendable, Equatable {
        public var name: String
        public var bytes: Int
        public var sha256: String

        public init(name: String, bytes: Int, sha256: String) {
            self.name = name
            self.bytes = bytes
            self.sha256 = sha256
        }
    }

    public struct Manifest: Codable, Sendable, Equatable {
        public var format: String = GuestImage.format
        public var formatVersion: Int = GuestImage.formatVersion
        public var id: String
        public var guestOS: String
        public var diskFormat: String
        public var diskGB: Int
        public var username: String
        public var createdAt: String
        public var provisioned: Bool
        public var psycheInstalled: Bool
        public var permissionsGranted: Bool
        public var psycheVersion: String?
        public var files: [File]

        public init(
            id: String, guestOS: String, diskFormat: String, diskGB: Int, username: String, createdAt: String, provisioned: Bool,
            psycheInstalled: Bool, permissionsGranted: Bool, psycheVersion: String? = nil, files: [File]
        ) {
            self.id = id
            self.guestOS = guestOS
            self.diskFormat = diskFormat
            self.diskGB = diskGB
            self.username = username
            self.createdAt = createdAt
            self.provisioned = provisioned
            self.psycheInstalled = psycheInstalled
            self.permissionsGranted = permissionsGranted
            self.psycheVersion = psycheVersion
            self.files = files
        }

        public var diskName: String { diskFormat == "asif" ? "Disk.asif" : "Disk.img" }
        /// Exactly these files, no more and no fewer.
        public var expectedFiles: Set<String> { [diskName, "AuxiliaryStorage", "HardwareModel", "bootstrap.json"] }
    }

    public struct Bootstrap: Codable, Sendable, Equatable {
        public var username: String
        public var password: String

        public init(username: String, password: String) {
            self.username = username
            self.password = password
        }

        /// Alphanumeric only: the password is passed to `dscl` and `sysadminctl` in the guest.
        public static func isValidPassword(_ s: String) -> Bool {
            (12...64).contains(s.count) && s.unicodeScalars.allSatisfy { ($0.value < 128) && CharacterSet.alphanumerics.contains($0) }
        }
    }

    /// `^[a-z0-9][a-z0-9.-]{0,63}$`
    public static func isValidId(_ s: String) -> Bool {
        guard let first = s.utf8.first, s.utf8.count <= 64, (97...122).contains(first) || (48...57).contains(first) else { return false }
        return s.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 46 }
    }

    public static func hex(_ digest: SHA256.Digest) -> String { digest.map { String(format: "%02x", $0) }.joined() }

    public static func sha256(_ data: Data) -> String { hex(SHA256.hash(data: data)) }

    /// Streams the file in 8 MiB chunks; `progress` gets the bytes hashed so far.
    public static func sha256(file url: URL, progress: ((Int) -> Void)? = nil) throws -> String {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        var hasher = SHA256()
        var done = 0
        while let chunk = try h.read(upToCount: 8 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
            done += chunk.count
            progress?(done)
        }
        return hex(hasher.finalize())
    }

    public static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }

    /// Writes `manifest.json` (0600) and returns its SHA-256, the value a publisher lists.
    @discardableResult
    public static func writeManifest(_ m: Manifest, to dir: URL) throws -> String {
        let data = try encoder().encode(m)
        let url = dir.appendingPathComponent("manifest.json")
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return sha256(data)
    }

    /// Checks an image directory before anything is copied: the manifest (against
    /// `expectedManifestSha256` when the publisher gave one), the format, exactly the expected
    /// regular files (no symlinks, no extras), sizes and SHA-256 of every file.
    public static func verify(_ dir: URL, expectedManifestSha256: String?, progress: ((Double) -> Void)? = nil) throws -> Manifest {
        let fm = FileManager.default
        let manifestURL = dir.appendingPathComponent("manifest.json")
        guard let data = fm.contents(atPath: manifestURL.path) else {
            throw CapabilityError(.notFound, reason: "image_not_found", "No guest image (manifest.json) at \(dir.path)")
        }
        let manifestSha = sha256(data)
        if let expected = expectedManifestSha256?.lowercased(), expected != manifestSha {
            throw CapabilityError(.policyDenied, reason: "image_checksum_mismatch", "The image manifest does not match the published checksum",
                                  details: ["expected": .string(expected), "actual": .string(manifestSha)])
        }
        guard let m = try? JSONDecoder().decode(Manifest.self, from: data), m.format == format else {
            throw CapabilityError(.invalidParams, reason: "image_invalid", "manifest.json is not a Psyche guest image")
        }
        guard m.formatVersion == formatVersion else {
            throw CapabilityError(.unavailable, reason: "image_version_unsupported", "Guest image format \(m.formatVersion) is not supported by this helper")
        }
        guard isValidId(m.id), ["asif", "raw"].contains(m.diskFormat), m.diskGB >= VMConfig.minDiskGB, m.provisioned else {
            throw CapabilityError(.invalidParams, reason: "image_invalid", "The image manifest is incomplete")
        }
        let listed = Set(m.files.map(\.name))
        guard listed == m.expectedFiles, m.files.count == listed.count else {
            throw CapabilityError(.invalidParams, reason: "image_invalid", "The image must list exactly \(m.expectedFiles.sorted().joined(separator: ", "))")
        }
        let present = Set(((try? fm.contentsOfDirectory(atPath: dir.path)) ?? []).filter { !$0.hasPrefix(".") })
        guard present == listed.union(["manifest.json"]) else {
            throw CapabilityError(.invalidParams, reason: "image_invalid", "The image directory has missing or unexpected files")
        }
        let total = max(1, m.files.reduce(0) { $0 + $1.bytes })
        var hashed = 0
        for f in m.files.sorted(by: { $0.name < $1.name }) {
            let url = dir.appendingPathComponent(f.name)
            let attrs = try fm.attributesOfItem(atPath: url.path)
            guard attrs[.type] as? FileAttributeType == .typeRegular, (attrs[.size] as? NSNumber)?.intValue == f.bytes else {
                throw CapabilityError(.policyDenied, reason: "image_checksum_mismatch", "\(f.name) is not the file the manifest describes")
            }
            let base = hashed
            let actual = try sha256(file: url) { progress?(Double(base + $0) / Double(total)) }
            guard actual == f.sha256.lowercased() else {
                throw CapabilityError(.policyDenied, reason: "image_checksum_mismatch", "\(f.name) does not match its checksum",
                                      details: ["file": .string(f.name)])
            }
            hashed += f.bytes
        }
        let bootstrap = try? JSONDecoder().decode(Bootstrap.self, from: Data(contentsOf: dir.appendingPathComponent("bootstrap.json")))
        guard let bootstrap, bootstrap.username == m.username, Bootstrap.isValidPassword(bootstrap.password) else {
            throw CapabilityError(.invalidParams, reason: "image_invalid", "bootstrap.json is missing or malformed")
        }
        return m
    }
}
