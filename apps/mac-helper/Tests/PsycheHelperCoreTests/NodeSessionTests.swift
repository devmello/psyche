import Darwin
import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

private struct AllGranted: PermissionPreflight {
    var denied: Set<TCCPermission> = []
    func isGranted(_ permission: TCCPermission) -> Bool { !denied.contains(permission) }
}

/// The Gateway end of a socketpair, driven synchronously by the test.
private final class FakeGatewayEnd: @unchecked Sendable {
    let channel: FrameChannel
    init(fd: Int32) { channel = FrameChannel(socket: UnixSocketConnection(fd: fd)) }

    func invoke(_ id: String, _ capability: String, _ params: JSONValue = [:], approvalId: String? = nil) throws {
        var p: [String: JSONValue] = ["invocationId": .string(id), "capability": .string(capability), "params": params]
        if let approvalId { p["approvalId"] = .string(approvalId) }
        try channel.send(.req(WireReqFrame(id: "g-\(id)", method: "node.invoke", params: .object(p))))
    }

    /// Reads frames until `predicate` matches, answering node.event / node.result requests with ok.
    func next(where predicate: (WireFrame) -> Bool) throws -> WireFrame {
        let deadline = Date().addingTimeInterval(5)
        while let frame = try channel.readFrame(before: deadline) {
            if case .req(let req) = frame {
                try channel.send(.res(WireResFrame(id: req.id, ok: true, payload: ["ok": true])))
            }
            if predicate(frame) { return frame }
        }
        throw NodeSocketError.closedByPeer
    }

    func response(_ id: String) throws -> WireResFrame {
        guard case .res(let res) = try next(where: { if case .res(let r) = $0 { return r.id == id } else { return false } }) else {
            throw NodeSocketError.closedByPeer
        }
        return res
    }

    func request(_ method: String) throws -> WireReqFrame {
        guard case .req(let req) = try next(where: { if case .req(let r) = $0 { return r.method == method } else { return false } }) else {
            throw NodeSocketError.closedByPeer
        }
        return req
    }
}

private func makeSession(_ handlers: [any CapabilityHandler], denied: Set<TCCPermission> = []) -> (NodeSession, FakeGatewayEnd) {
    var fds: [Int32] = [0, 0]
    precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
    let session = NodeSession(
        channel: FrameChannel(socket: UnixSocketConnection(fd: fds[0])),
        registry: CapabilityRegistry(handlers),
        preflight: AllGranted(denied: denied),
        log: HelperLog(echo: { _ in })
    )
    Thread.detachNewThread { try? session.serve() }
    return (session, FakeGatewayEnd(fd: fds[1]))
}

private let echo = Capability(CapabilitySpec(name: "test.echo", description: "echo", sideEffect: .read)) { ctx in
    await ctx.emit(["step": 1])
    return CapabilityOutput(ctx.params)
}

private let write = Capability(CapabilitySpec(name: "test.write", description: "w", sideEffect: .write, receiptKind: "computer_action")) { _ in
    CapabilityOutput(["done": true], receipt: ReceiptDraft(outcome: .ok, summary: "wrote"))
}

private let failing = Capability(CapabilitySpec(name: "test.fail", description: "f", sideEffect: .write)) { _ in
    throw CapabilityError(.conflict, reason: "stale_ref", "stale")
}

private let needsAX = Capability(CapabilitySpec(name: "test.ax", description: "a", sideEffect: .read, permissions: [.accessibility])) { _ in
    CapabilityOutput(true)
}

@Suite("node session")
struct NodeSessionTests {
    @Test func acceptsThenStreamsEventsThenResult() throws {
        let (_, gw) = makeSession([echo])
        try gw.invoke("i1", "test.echo", ["x": "y"])
        let accepted = try gw.response("g-i1")
        #expect(accepted.ok && accepted.payload == ["accepted": true])
        let event = try gw.request("node.event")
        #expect(event.params?["invocationId"] == "i1" && event.params?["data"] == ["step": 1])
        let result = try gw.request("node.result")
        #expect(result.params?["ok"] == true && result.params?["result"] == ["x": "y"])
        #expect(result.params?["receipt"] == nil)
    }

    @Test func sideEffectsCarryAReceipt() throws {
        let (_, gw) = makeSession([write])
        try gw.invoke("i2", "test.write", approvalId: "appr_1")
        let result = try gw.request("node.result")
        let receipt = try #require(result.params?["receipt"])
        #expect(receipt["kind"] == "computer_action" && receipt["outcome"] == "ok" && receipt["approvalId"] == "appr_1")
        #expect(receipt["id"]?.stringValue?.hasPrefix("rcpt_") == true)
        #expect(receipt["taskId"] == .null && receipt["payload"] == .null)
    }

    @Test func errorsCarryAReasonAndAFailedReceipt() throws {
        let (_, gw) = makeSession([failing])
        try gw.invoke("i3", "test.fail")
        let result = try gw.request("node.result")
        #expect(result.params?["ok"] == false)
        #expect(result.params?["error"]?["code"] == "conflict")
        #expect(result.params?["error"]?["details"]?["reason"] == "stale_ref")
        #expect(result.params?["receipt"]?["outcome"] == "failed")
    }

    @Test func unknownCapabilityIsNotFound() throws {
        let (_, gw) = makeSession([echo])
        try gw.invoke("i4", "nope.nothing")
        let res = try gw.response("g-i4")
        #expect(!res.ok && res.error?.code == "not_found")
    }

    @Test func missingPermissionIsReportedWithoutRunningTheHandler() throws {
        let (_, gw) = makeSession([needsAX], denied: [.accessibility])
        try gw.invoke("i5", "test.ax")
        let result = try gw.request("node.result")
        #expect(result.params?["error"]?["details"]?["reason"] == "permission_missing")
        #expect(result.params?["error"]?["details"]?["permission"] == "accessibility")
    }

    @Test func unknownGatewayMethodIsRejected() throws {
        let (_, gw) = makeSession([echo])
        try gw.channel.send(.req(WireReqFrame(id: "x", method: "shell.exec")))
        #expect(try gw.response("x").error?.code == "unknown_method")
    }

    @Test func manifestDeclaresSideEffects() {
        let registry = CapabilityRegistry([echo, write])
        let manifest = registry.manifest(version: "1.2.3")
        #expect(manifest["platform"] == "macos" && manifest["version"] == "1.2.3")
        let entries = manifest["capabilities"]?.arrayValue ?? []
        #expect(entries.map { $0["name"] } == ["test.echo", "test.write"])
        #expect(entries.map { $0["sideEffect"] } == ["read", "write"])
        #expect(entries[0]["inputSchema"]?["type"] == "object")
    }

    @Test func paramsDecodeErrorsBecomeInvalidParams() throws {
        struct P: Decodable { var app: String }
        let ctx = InvocationContext(invocationId: "i", capability: "c", params: ["app": 3], approvalId: nil, emit: { _ in })
        #expect(throws: CapabilityError.self) { try ctx.decode(P.self) }
        do {
            _ = try ctx.decode(P.self)
        } catch let error as CapabilityError {
            #expect(error.code == .invalidParams && error.details["field"] == "app")
        }
        let missing = InvocationContext(invocationId: "i", capability: "c", params: .null, approvalId: nil, emit: { _ in })
        do {
            _ = try missing.decode(P.self)
        } catch let error as CapabilityError {
            #expect(error.message.contains("app"))
        }
    }
}
