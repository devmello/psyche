import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import Testing

@testable import PsycheClient

/// The machine line on approval cards and the read-only "Computers Psyche can use" list
/// (docs/design/linux-helper-only-2026.md §8.1, §8.3).
struct MachineLineTests {
    static func approval(machine: JSONValue?) -> JSONValue {
        var fields: [String: JSONValue] = [
            "id": "ap1", "kind": "exec_host", "summary": "Run a command", "status": "pending",
            "details": .object(["argv": "ls -la"]), "requestedAt": "2030-01-01T09:12:00Z",
        ]
        if let machine { fields["machine"] = machine }
        return .object(fields)
    }

    @Test func anApprovalOnAMachineCarriesItsName() throws {
        let item = GatewayBackend.needsYou(approval: Self.approval(
            machine: .object(["deviceId": "dev_1", "name": "lab-box"])))
        #expect(try #require(item?.approval).machineName == "lab-box")
    }

    @Test(arguments: [
        JSONValue?.none, .some(.object([:])), .some(.object(["name": ""])), .some(.object(["name": "   "])),
        .some(.string("lab-box")), .some(.object(["name": .number(3)])),
    ])
    func noUsableMachineMeansThisMac(_ machine: JSONValue?) throws {
        let item = GatewayBackend.needsYou(approval: Self.approval(machine: machine))
        #expect(try #require(item?.approval).machineName == nil)
    }

    @Test func machinesMapToNameAndStatusAndUnknownStatusReadsOffline() {
        let result: JSONValue = .object(["machines": .array([
            .object(["id": "m1", "name": "lab-box", "status": "online"]),
            .object(["id": "m2", "name": " nuc ", "status": "offline"]),
            .object(["id": "m3", "name": "pi", "status": "degraded"]),
            .object(["id": "m4", "name": "future", "status": "sleeping"]),
            .object(["id": "m5", "name": ""]),
            .object(["name": "no-id", "status": "online"]),
        ])])
        let machines = GatewayBackend.machineSummaries(result)
        #expect(machines == [
            MachineSummary(id: "m1", name: "lab-box", status: .online),
            MachineSummary(id: "m2", name: "nuc", status: .offline),
            MachineSummary(id: "m3", name: "pi", status: .degraded),
            MachineSummary(id: "m4", name: "future", status: .offline),
        ])
    }

    @Test func machinesListIsReadOnlyAndAGatewayWithoutItShowsNone() async throws {
        let gateway = FakeGateway()
        gateway.on("machines.list") { _ in .success(.object(["machines": .array([
            .object(["id": "m1", "name": "lab-box", "status": "online"]),
        ])])) }
        let h = GatewayClientTests.Harness(gateway: gateway)
        await h.client.beginPairing(try GatewayClientTests.link())
        #expect(await GatewayClientTests.wait(h.client) { $0 == .live } == .live)
        let backend = GatewayBackend(client: h.client)
        #expect(try await backend.machines().map(\.name) == ["lab-box"])
        #expect(gateway.received.map(\.method).filter { $0.hasPrefix("machines.") } == ["machines.list"])

        let bare = FakeGateway()
        let h2 = GatewayClientTests.Harness(gateway: bare)
        await h2.client.beginPairing(try GatewayClientTests.link())
        #expect(await GatewayClientTests.wait(h2.client) { $0 == .live } == .live)
        #expect(try await GatewayBackend(client: h2.client).machines().isEmpty)
    }
}
