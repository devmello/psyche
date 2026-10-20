import Foundation
import PsycheProtocol

/// The guest agent channel (L3; spike 06 "vsock"): Psyche Helper running inside the guest listens
/// on vsock port 7000 and answers the host helper's `guest.*` requests with ordinary `req` / `res`
/// frames (NDJSON, wire spec v1). Only the host can reach it: the guest side accepts peers whose
/// CID is 2 and nothing else. In-guest root work (shutdown, VirtioFS mounts) uses the provisioning
/// password the host sends per request, so no root daemon is installed.
public enum GuestAgentMethod {
    public static let ping = "guest.ping"
    public static let shutdown = "guest.shutdown"
    public static let mountShares = "guest.mount_shares"
    public static let export = "guest.export"
}

/// What the guest side can do; the live implementation runs inside the guest.
public protocol GuestOperations: Sendable {
    func status() -> JSONValue
    func shutdown(password: String) throws
    func mountShares(password: String) throws
    /// Copies `path` into the read-write `_psyche-out/<transferId>/` share and returns its byte count.
    func export(path: String, transferId: String) throws -> Int
}

/// Guest side: serves one host connection until it closes.
public struct GuestAgentServer: Sendable {
    public static let version = "1"
    let ops: any GuestOperations
    let log: HelperLog

    public init(ops: any GuestOperations, log: HelperLog) {
        self.ops = ops
        self.log = log
    }

    public func serve(_ channel: FrameChannel) {
        while let frame = try? channel.readFrame(before: .distantFuture) {
            guard case .req(let req) = frame else { continue }
            let res: WireResFrame
            do {
                res = WireResFrame(id: req.id, ok: true, payload: try handle(req.method, req.params ?? .null))
            } catch let e as CapabilityError {
                res = WireResFrame(id: req.id, ok: false, error: e.wire)
            } catch {
                res = WireResFrame(id: req.id, ok: false, error: WireError(code: ErrorCode.errorCodeInternal.rawValue, message: "guest agent error"))
            }
            try? channel.send(.res(res))
            log.info("guest agent \(req.method) ok=\(res.ok)")
        }
    }

    func string(_ params: JSONValue, _ key: String) throws -> String {
        guard let v = params[key]?.stringValue, !v.isEmpty else { throw CapabilityError.invalidParams("\(key) is required", field: key) }
        return v
    }

    public func handle(_ method: String, _ params: JSONValue) throws -> JSONValue {
        switch method {
        case GuestAgentMethod.ping:
            var s = ops.status().objectValue ?? [:]
            s["version"] = .string(Self.version)
            return .object(s)
        case GuestAgentMethod.shutdown:
            try ops.shutdown(password: try string(params, "password"))
            return ["ok": true]
        case GuestAgentMethod.mountShares:
            try ops.mountShares(password: try string(params, "password"))
            return ["ok": true]
        case GuestAgentMethod.export:
            let id = try string(params, "transferId")
            guard id.utf8.allSatisfy({ (48...57).contains($0) || (97...122).contains($0) || $0 == 45 }) else {
                throw CapabilityError.invalidParams("bad transferId", field: "transferId")
            }
            return ["bytes": .int(try ops.export(path: try string(params, "path"), transferId: id))]
        default:
            throw CapabilityError(.notFound, reason: "unknown_method", "Unknown guest method \(method)")
        }
    }
}

/// Host side: one request at a time over a connected descriptor (`VZVirtioSocketDevice.connect`).
public final class GuestAgentClient: @unchecked Sendable {
    let channel: FrameChannel
    private let lock = NSLock()
    private var next = 0

    public init(fd: Int32) {
        channel = FrameChannel(socket: UnixSocketConnection(fd: fd))
    }

    deinit { channel.close() }

    /// Sends `method` and waits up to `timeout` for its answer (blocking; call off the main thread).
    public func call(_ method: String, _ params: JSONValue = [:], timeout: TimeInterval = 30) throws -> JSONValue {
        lock.lock()
        defer { lock.unlock() }
        next += 1
        let id = "g\(next)"
        try channel.send(.req(WireReqFrame(id: id, method: method, params: params)))
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            guard let frame = try channel.readFrame(before: deadline) else {
                throw CapabilityError(.unavailable, reason: "guest_agent_closed", "The guest helper closed the connection", retryable: true)
            }
            guard case .res(let res) = frame, res.id == id else { continue }
            if res.ok { return res.payload ?? .null }
            let reason = res.error?.details?["reason"]?.stringValue ?? res.error?.code ?? "guest_error"
            throw CapabilityError(ErrorCode(rawValue: res.error?.code ?? "") ?? .unavailable, reason: reason, res.error?.message ?? "Guest error")
        }
    }
}
