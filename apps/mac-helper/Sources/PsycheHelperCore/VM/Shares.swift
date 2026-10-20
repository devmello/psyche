import Foundation
import PsycheProtocol

/// One host folder shared with the guest (L5; security §13; spike 06 "Shared folders").
/// User folders go on the `psyche` VirtioFS tag (mounted by the guest helper at
/// `/Volumes/Psyche Shares/<name>`); the read-only installer payload uses the automount tag.
public struct ShareGrant: Codable, Sendable, Equatable {
    public var name: String
    public var hostPath: String
    public var readOnly: Bool
    public var tag: String
    public var grantedAt: String
    /// Set for read-write grants: the approval that allowed write access.
    public var approvalId: String?

    public static let userTag = "psyche"
    public static let automountTag = "com.apple.virtio-fs.automount"

    public init(name: String, hostPath: String, readOnly: Bool, tag: String = ShareGrant.userTag,
                grantedAt: String = ISO8601DateFormatter().string(from: Date()), approvalId: String? = nil) {
        self.name = name
        self.hostPath = hostPath
        self.readOnly = readOnly
        self.tag = tag
        self.grantedAt = grantedAt
        self.approvalId = approvalId
    }

    public var guestPath: String {
        tag == Self.automountTag ? "/Volumes/My Shared Files/\(name)" : "/Volumes/Psyche Shares/\(name)"
    }
}

public enum SharePolicy {
    public static let maxShares = 16

    /// `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$`, no `..`.
    public static func isValidName(_ s: String) -> Bool {
        guard let first = s.unicodeScalars.first, s.count <= 64, !s.contains(".."),
              CharacterSet.alphanumerics.contains(first), first.isASCII else { return false }
        return s.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || " ._-".unicodeScalars.contains($0)) }
    }

    /// Validates a folder grant: an existing directory (symlinks resolved), never `/`, the home
    /// root, `~/Library`, `$PSYCHE_HOME` or anything containing them; read-write needs an approval.
    public static func validate(
        name: String, path: String, readOnly: Bool, approvalId: String?, existing: [ShareGrant],
        home: String = NSHomeDirectory(), psycheHome: String = HelperPaths.psycheHome(),
        fileManager: FileManager = .default
    ) throws -> ShareGrant {
        guard isValidName(name) else { throw CapabilityError.invalidParams("share name must be letters, digits, space, . _ -", field: "name") }
        guard path.hasPrefix("/") else { throw CapabilityError.invalidParams("path must be absolute", field: "path") }
        let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
        var isDir: ObjCBool = false
        guard fileManager.fileExists(atPath: resolved, isDirectory: &isDir), isDir.boolValue else {
            throw CapabilityError(.notFound, reason: "not_a_directory", "\(path) is not an existing folder")
        }
        let canon: (String) -> String = { URL(fileURLWithPath: $0).resolvingSymlinksInPath().standardizedFileURL.path }
        let homeC = canon(home), psycheC = canon(psycheHome), libraryC = canon(home + "/Library")
        func inside(_ p: String, _ root: String) -> Bool { p == root || p.hasPrefix(root.hasSuffix("/") ? root : root + "/") }
        let refused: String? =
            resolved == "/" ? "the root of the disk"
            : resolved == homeC ? "your whole home folder"
            : inside(resolved, libraryC) ? "~/Library"
            : inside(resolved, psycheC) || inside(psycheC, resolved) ? "Psyche's own data"
            : inside(libraryC, resolved) ? "a folder containing ~/Library"
            : ["/System", "/Library", "/private", "/usr", "/bin", "/sbin", "/etc", "/var", "/Volumes"].contains(resolved) ? "a system folder"
            : nil
        if let refused {
            throw CapabilityError(.policyDenied, reason: "share_forbidden", "Sharing \(refused) with the guest is not allowed", details: ["path": .string(path)])
        }
        if !readOnly, approvalId == nil {
            throw CapabilityError(.approvalRequired, reason: "share_rw_needs_approval",
                                  "Read-write access to \(path) needs your approval", details: ["path": .string(resolved), "name": .string(name)])
        }
        if existing.contains(where: { $0.name == name }) {
            throw CapabilityError(.conflict, reason: "share_exists", "A share named \(name) already exists")
        }
        guard existing.count < maxShares else {
            throw CapabilityError(.conflict, reason: "too_many_shares", "At most \(maxShares) folders can be shared")
        }
        return ShareGrant(name: name, hostPath: resolved, readOnly: readOnly, approvalId: readOnly ? nil : approvalId)
    }
}

/// vsock ports (spike 06 "vsock"; apps/node `guest-bootstrap.sh`). Host CID is 2.
public enum VsockPorts {
    /// Guest psyche-node → host Gateway node socket (relayed by the helper).
    public static let gatewayNode: UInt32 = 7980
    /// Host → guest helper control (shutdown, share mounts, status).
    public static let guestControl: UInt32 = 7000
    /// Guest → host capabilities (host vault fills, security §13).
    public static let hostCapabilities: UInt32 = 5000
}

/// Copies bytes both ways between two connected descriptors until either side closes. Used to
/// relay a guest's vsock stream to the Gateway's node socket: the Gateway still runs the full
/// signed handshake, and a guest node is a pending pairing until the owner approves it.
public final class StreamRelay: @unchecked Sendable {
    public let a: Int32
    public let b: Int32
    private let lock = NSLock()
    private var closed = false
    public private(set) var bytesAToB = 0
    public private(set) var bytesBToA = 0

    public init(_ a: Int32, _ b: Int32) {
        self.a = a
        self.b = b
    }

    /// Starts both pumps; `onClose` runs once when the relay ends.
    public func start(onClose: @escaping @Sendable () -> Void = {}) {
        let group = DispatchGroup()
        for (from, to, aToB) in [(a, b, true), (b, a, false)] {
            group.enter()
            Thread.detachNewThread { [self] in
                pump(from: from, to: to, aToB: aToB)
                shutdownBoth()
                group.leave()
            }
        }
        group.notify(queue: .global()) { [self] in
            closeBoth()
            onClose()
        }
    }

    private func pump(from: Int32, to: Int32, aToB: Bool) {
        var buf = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = Darwin.read(from, &buf, buf.count)
            if n < 0, errno == EINTR { continue }
            if n <= 0 { return }
            var off = 0
            while off < n {
                let w = buf.withUnsafeBytes { Darwin.write(to, $0.baseAddress!.advanced(by: off), n - off) }
                if w < 0, errno == EINTR { continue }
                if w <= 0 { return }
                off += w
            }
            lock.lock()
            if aToB { bytesAToB += n } else { bytesBToA += n }
            lock.unlock()
        }
    }

    private func shutdownBoth() {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        Darwin.shutdown(a, SHUT_RDWR)
        Darwin.shutdown(b, SHUT_RDWR)
    }

    private func closeBoth() {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        closed = true
        Darwin.close(a)
        Darwin.close(b)
    }
}
