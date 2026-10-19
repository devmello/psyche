import Foundation
import PsycheProtocol

/// Serves the node protocol on a paired connection (architecture §7, wire spec v1):
///
/// - Gateway → node `req node.invoke {invocationId, capability, params, approvalId?}` → node answers
///   `res {accepted: true}` once the work is queued (or an error `res`).
/// - Node → Gateway `req node.event {invocationId, data}` (zero or more), then exactly one
///   `req node.result {invocationId, ok, result?, error?, receipt?}`.
///
/// Logs carry capability names, ids, sizes and outcomes only, never params or results (ADR-017).
public final class NodeSession: @unchecked Sendable {
    public let channel: FrameChannel
    public let registry: CapabilityRegistry
    public let preflight: any PermissionPreflight
    public let log: HelperLog

    private let lock = NSLock()
    private var inFlight: [String: _Concurrency.Task<Void, Never>] = [:]
    private var reserved: Set<String> = []
    private var nextRequest = 0

    public init(channel: FrameChannel, registry: CapabilityRegistry, preflight: any PermissionPreflight, log: HelperLog) {
        self.channel = channel
        self.registry = registry
        self.preflight = preflight
        self.log = log
    }

    /// Blocks reading frames until the Gateway closes the connection. In-flight invocations are
    /// cancelled when it returns.
    public func serve() throws {
        defer { cancelAll() }
        while let frame = try channel.readFrame(before: .distantFuture) {
            switch frame {
            case .req(let req): handle(req)
            case .res(let res):
                // Answers to our node.event / node.result requests.
                if !res.ok { log.error("gateway rejected \(res.id): \(res.error?.code ?? "unknown")") }
            case .event:
                break
            }
        }
    }

    /// Number of invocations currently running (tests, diagnostics).
    public var inFlightCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return inFlight.count
    }

    public func cancelAll() {
        lock.lock()
        let tasks = Array(inFlight.values)
        inFlight.removeAll()
        lock.unlock()
        tasks.forEach { $0.cancel() }
    }

    // MARK: - Gateway → node

    func handle(_ req: WireReqFrame) {
        switch req.method {
        case "node.invoke":
            handleInvoke(req)
        case "node.cancel":
            // Not in protocol v1 yet (requested in docs/status/s14.md); honoured when the Gateway sends it.
            if let id = req.params?["invocationId"]?.stringValue {
                lock.lock()
                let task = inFlight[id]
                lock.unlock()
                task?.cancel()
                respond(req.id, ok: ["ok": true])
            } else {
                respondError(req.id, WireError(code: ErrorCode.invalidParams.rawValue, message: "invocationId is required"))
            }
        default:
            respondError(req.id, WireError(code: ErrorCode.unknownMethod.rawValue, message: "Unknown method \(req.method)"))
        }
    }

    private struct InvokeParams: Decodable {
        var invocationId: String
        var capability: String
        var params: JSONValue?
        var approvalId: String?
    }

    private func handleInvoke(_ req: WireReqFrame) {
        guard let p = try? (req.params ?? .null).decode(as: InvokeParams.self), !p.invocationId.isEmpty,
              p.invocationId.count <= 128
        else {
            respondError(req.id, WireError(code: ErrorCode.invalidParams.rawValue, message: "node.invoke needs invocationId and capability"))
            return
        }
        guard let handler = registry[p.capability] else {
            log.info("invoke capability=\(p.capability) outcome=not_found")
            respondError(req.id, WireError(code: ErrorCode.notFound.rawValue, message: "Unknown capability \(p.capability)"))
            return
        }
        lock.lock()
        if inFlight[p.invocationId] != nil || reserved.contains(p.invocationId) {
            lock.unlock()
            respondError(req.id, WireError(code: ErrorCode.conflict.rawValue, message: "Invocation \(p.invocationId) is already running"))
            return
        }
        reserved.insert(p.invocationId)
        lock.unlock()
        // `accepted` goes out before the work starts, so it always precedes node.event / node.result.
        respond(req.id, ok: ["accepted": true])
        log.info("invoke capability=\(p.capability) approval=\(p.approvalId == nil ? "no" : "yes")")

        let context = InvocationContext(
            invocationId: p.invocationId, capability: p.capability, params: p.params ?? .null, approvalId: p.approvalId,
            emit: { [weak self] data in self?.sendEvent(invocationId: p.invocationId, data: data) }
        )
        lock.lock()
        reserved.remove(p.invocationId)
        inFlight[p.invocationId] = _Concurrency.Task { [weak self] in
            guard let self else { return }
            let outcome = await self.run(handler, context)
            self.finish(context, outcome)
        }
        lock.unlock()
    }

    private func run(_ handler: any CapabilityHandler, _ context: InvocationContext) async -> Result<CapabilityOutput, CapabilityError> {
        for permission in handler.spec.permissions where !preflight.isGranted(permission) {
            return .failure(.permissionMissing(permission))
        }
        do {
            let output = try await handler.invoke(context)
            if _Concurrency.Task.isCancelled { return .failure(.cancelled) }
            return .success(output)
        } catch let error as CapabilityError {
            return .failure(error)
        } catch is CancellationError {
            return .failure(.cancelled)
        } catch {
            return .failure(CapabilityError(.errorCodeInternal, reason: "internal", "Internal error in \(context.capability)"))
        }
    }

    private func finish(_ context: InvocationContext, _ outcome: Result<CapabilityOutput, CapabilityError>) {
        lock.lock()
        inFlight[context.invocationId] = nil
        lock.unlock()
        let spec = registry[context.capability]?.spec
        var params: [String: JSONValue] = ["invocationId": .string(context.invocationId)]
        switch outcome {
        case .success(let output):
            params["ok"] = true
            params["result"] = output.result
            if let receipt = output.receipt {
                params["receipt"] = receipt.wire(kind: spec?.receiptKind ?? context.capability, approvalId: context.approvalId)
            }
            log.info("result capability=\(context.capability) ok=true receipt=\(output.receipt?.outcome.rawValue ?? "none")")
        case .failure(let error):
            params["ok"] = false
            params["error"] = (try? JSONValue(encoding: error.wire)) ?? .null
            // A refused side effect still gets a failed receipt so the audit trail is complete.
            if let spec, spec.sideEffect != .none, spec.sideEffect != .read, error.code != .invalidParams {
                params["receipt"] = ReceiptDraft(outcome: .failed, summary: "\(context.capability) failed: \(error.reason)")
                    .wire(kind: spec.receiptKind ?? context.capability, approvalId: context.approvalId)
            }
            log.info("result capability=\(context.capability) ok=false code=\(error.code.rawValue) reason=\(error.reason)")
        }
        sendRequest("node.result", .object(params))
    }

    // MARK: - Node → Gateway

    func sendEvent(invocationId: String, data: JSONValue) {
        sendRequest("node.event", ["invocationId": .string(invocationId), "data": data])
    }

    private func sendRequest(_ method: String, _ params: JSONValue) {
        lock.lock()
        nextRequest += 1
        let id = "h\(nextRequest)"
        lock.unlock()
        do {
            try channel.send(.req(WireReqFrame(id: id, method: method, params: params)))
        } catch NDJSONLineBuffer.FramingError.frameTooLarge {
            log.error("\(method) frame over 1 MiB dropped")
            if method == "node.result", let invocationId = params["invocationId"] {
                let error = CapabilityError(.errorCodeInternal, reason: "result_too_large", "The result exceeded the 1 MiB frame limit")
                let fallback: JSONValue = ["invocationId": invocationId, "ok": false, "error": (try? JSONValue(encoding: error.wire)) ?? .null]
                try? channel.send(.req(WireReqFrame(id: id, method: method, params: fallback)))
            }
        } catch {
            log.error("\(method) send failed")
        }
    }

    private func respond(_ id: String, ok payload: JSONValue) {
        try? channel.send(.res(WireResFrame(id: id, ok: true, payload: payload)))
    }

    private func respondError(_ id: String, _ error: WireError) {
        try? channel.send(.res(WireResFrame(id: id, ok: false, error: error)))
    }
}
