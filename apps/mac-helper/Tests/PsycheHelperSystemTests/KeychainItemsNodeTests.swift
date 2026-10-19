import Darwin
import Foundation
import PsycheHelperCore
import PsycheHelperSystem
import PsycheProtocol
import Testing

private struct Granted: PermissionPreflight {
    func isGranted(_ permission: TCCPermission) -> Bool { true }
}

/// The Gateway's end of a node socket: sends `node.invoke` the way `packages/vault`'s
/// `KeychainItemStore` does through `nodes.invoke`, and collects `node.result`. Blocking reads run on
/// a GCD thread so they never starve the session's handler tasks.
private final class GatewayEnd: @unchecked Sendable {
    let channel: FrameChannel
    init(fd: Int32) { channel = FrameChannel(socket: UnixSocketConnection(fd: fd)) }

    func invoke(_ id: String, _ capability: String, _ params: JSONValue) async throws -> JSONValue {
        try channel.send(.req(WireReqFrame(id: "g-\(id)", method: "node.invoke", params: [
            "invocationId": .string(id), "capability": .string(capability), "params": params,
        ])))
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<JSONValue, Error>) in
            DispatchQueue.global().async {
                cont.resume(with: Result {
                    let deadline = Date().addingTimeInterval(5)
                    while let frame = try self.channel.readFrame(before: deadline) {
                        if case .req(let req) = frame {
                            try self.channel.send(.res(WireResFrame(id: req.id, ok: true, payload: ["ok": true])))
                            if req.method == "node.result", req.params?["invocationId"] == .string(id) { return req.params ?? .null }
                        }
                    }
                    throw NodeSocketError.closedByPeer
                })
            }
        }
    }
}

@Suite("keychain items over the node protocol (system keychain mode)", .serialized)
struct KeychainItemsNodeTests {
    let backend = FakeKeychainBackend()

    fileprivate func session() -> GatewayEnd {
        var fds: [Int32] = [0, 0]
        precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
        let vault = KeychainVault(backend: backend, accessGroup: nil, biometry: fakeBiometry)
        let s = NodeSession(
            channel: FrameChannel(socket: UnixSocketConnection(fd: fds[0])),
            registry: CapabilityRegistry(KeychainCapabilities.make(vault: vault)), preflight: Granted(), log: HelperLog(echo: { _ in })
        )
        Thread.detachNewThread { try? s.serve() }
        return GatewayEnd(fd: fds[1])
    }

    @Test func storeRetrieveDeleteItemAsTheVaultCallsThem() async throws {
        let gw = session()
        let secret = Data("correct horse battery staple".utf8)
        // packages/vault/src/slots/KeychainItems.ts put(): name, value (base64url), requireAuth, replace, reason
        let stored = try await gw.invoke("s1", "keychain.store", [
            "name": "psyche.item.01jabc", "value": .string(Base64URL.encode(secret)), "requireAuth": true, "replace": false,
            "reason": "Save a Psyche credential",
        ])
        #expect(stored["ok"] == true && stored["result"]?["stored"] == true)
        #expect(stored["result"]?["value"] == nil)  // never echoed
        #expect(stored["receipt"]?["kind"] == "keychain_item")
        let item = try #require(backend.snapshot()[.init(service: "com.psyche.helper.items", account: "psyche.item.01jabc")])
        #expect(item.protection == .accessControl(.whenPasscodeSetThisDeviceOnly, [.biometryCurrentSet, .or, .devicePasscode]))

        // get(): name, reason → {value} base64url
        let got = try await gw.invoke("r1", "keychain.retrieve", ["name": "psyche.item.01jabc", "reason": "Fill your GitHub password"])
        #expect(got["result"]?["value"] == .string(Base64URL.encode(secret)))
        #expect(backend.prompts.last == "Fill your GitHub password")

        // A second put without replace is a conflict; with replace it succeeds.
        let dup = try await gw.invoke("s2", "keychain.store", ["name": "psyche.item.01jabc", "value": .string(Base64URL.encode(secret))])
        #expect(dup["ok"] == false && dup["error"]?["details"]?["reason"] == "duplicate_item")

        // remove(): name, reason; a second delete is not_found (the vault treats it as removed).
        let del = try await gw.invoke("d1", "keychain.delete_item", ["name": "psyche.item.01jabc", "reason": "Delete a Psyche credential"])
        #expect(del["ok"] == true && del["result"]?["deleted"] == true)
        let again = try await gw.invoke("d2", "keychain.delete_item", ["name": "psyche.item.01jabc"])
        #expect(again["error"]?["code"] == "not_found")
        let gone = try await gw.invoke("r2", "keychain.retrieve", ["name": "psyche.item.01jabc", "reason": "x"])
        #expect(gone["error"]?["code"] == "not_found")
    }

    @Test func missingEntitlementReachesTheVaultAsUnavailable() async throws {
        backend.failMutationsWith = -34018
        let gw = session()
        let res = try await gw.invoke("s1", "keychain.store", ["name": "psyche.item.x", "value": "AAAA"])
        #expect(res["error"]?["code"] == "unavailable" && res["error"]?["details"]?["reason"] == "missing_entitlement")
        let status = try await gw.invoke("st", "keychain.status", [:])
        #expect(status["result"]?["dataProtectionKeychain"] == "missing_entitlement")
    }
}
