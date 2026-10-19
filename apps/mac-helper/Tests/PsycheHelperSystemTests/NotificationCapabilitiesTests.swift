import Foundation
import PsycheHelperCore
import PsycheHelperSystem
import PsycheProtocol
import Testing

// These tests never touch UNUserNotificationCenter: the bridge is built as "not bundled".
@Suite("notify capabilities")
struct NotificationCapabilitiesTests {
    let bridge = NotificationCenterBridge(bundleIdentifier: nil, log: HelperLog(echo: { _ in }))

    var registry: CapabilityRegistry { CapabilityRegistry(NotifyCapabilities.make(bridge: bridge)) }

    private func invoke(_ name: String, _ params: JSONValue) async -> CapabilityError? {
        let ctx = InvocationContext(invocationId: "inv_1", capability: name, params: params, approvalId: nil, emit: { _ in })
        do {
            _ = try await registry[name]!.invoke(ctx)
            return nil
        } catch let e as CapabilityError {
            return e
        } catch {
            return CapabilityError(.errorCodeInternal, reason: "unexpected", "\(error)")
        }
    }

    @Test func manifestEntries() {
        let specs = Dictionary(uniqueKeysWithValues: registry.ordered.map { ($0.spec.name, $0.spec) })
        #expect(Set(specs.keys) == ["notify.show", "notify.withdraw", "notify.authorization_status", "notify.request_authorization", "notify.subscribe"])
        #expect(specs["notify.show"]?.sideEffect == .write)
        #expect(specs["notify.show"]?.receiptKind == "notification")
        #expect(specs["notify.withdraw"]?.sideEffect == .write)
        #expect(specs["notify.authorization_status"]?.sideEffect == .read)
        #expect(specs["notify.request_authorization"]?.sideEffect == .write)
        #expect(specs["notify.subscribe"]?.sideEffect == .read)
        #expect(specs["notify.subscribe"]?.streaming == true)
        #expect(specs.values.filter { $0.name != "notify.subscribe" }.allSatisfy { !$0.streaming })
        let required = specs["notify.show"]?.inputSchema["required"]
        #expect(required == ["body", "id", "kind", "title"])
    }

    @Test func unbundledBridgeIsUnavailable() async {
        #expect(!bridge.isAvailable)
        bridge.start()  // no-op without a bundle
        let show: JSONValue = ["id": "ntf_1", "kind": "task_done", "title": "Done", "body": "Report ready"]
        for (name, params) in [
            ("notify.show", show), ("notify.withdraw", ["id": "ntf_1"] as JSONValue), ("notify.authorization_status", .null),
            ("notify.request_authorization", .null), ("notify.subscribe", .null),
        ] {
            let e = await invoke(name, params)
            #expect(e?.code == .unavailable, "\(name)")
            #expect(e?.reason == "not_bundled", "\(name)")
        }
    }

    @Test func paramsAreValidatedBeforeTheCenterIsTouched() async {
        let e = await invoke("notify.show", ["id": "bad id", "kind": "approval", "title": "T", "body": "B"])
        #expect(e?.code == .invalidParams)
        let missing = await invoke("notify.show", ["id": "ntf_1", "kind": "approval", "title": "T"])
        #expect(missing?.code == .invalidParams && missing?.details["field"] == "body")
        let kind = await invoke("notify.show", ["id": "ntf_1", "kind": "nope", "title": "T", "body": "B"])
        #expect(kind?.code == .invalidParams)
        let withdraw = await invoke("notify.withdraw", ["id": "a/b"])
        #expect(withdraw?.code == .invalidParams)
    }
}
