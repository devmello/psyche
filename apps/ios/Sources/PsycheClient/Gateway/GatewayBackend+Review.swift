import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// The review queue over the Gateway: held-back items (memory.quarantine.list, memory.quarantine.decide) and sender
// offers (memory.senders.list, memory.senders.decide). Every write sends an idempotency key, so a retried tap does
// not repeat the change.
extension GatewayBackend {
    /// Held items per page, the Mac's size.
    static let heldPageSize = 20

    /// One page of the items still waiting for the owner (includeDecided is off), newest first.
    public func heldItemsPage(cursor: String?) async throws -> HeldItemsPage {
        var params: [String: JSONValue] = ["limit": .number(Double(Self.heldPageSize))]
        if let cursor { params["cursor"] = .string(cursor) }
        let result = try await call("memory.quarantine.list", .object(params))
        let items = (result["items"]?.array ?? []).compactMap(Self.heldItem)
        return HeldItemsPage(items: items, nextCursor: result["nextCursor"]?.string)
    }

    public func decideHeldItem(id: String, action: HeldItemAction) async throws {
        _ = try await call(
            "memory.quarantine.decide", .obj(["id": .string(id), "action": .string(action.rawValue)]),
            key: "quarantine-decide-\(UUID().uuidString)")
    }

    public func senderTrust() async throws -> [SenderTrustRow] {
        let result = try await call("memory.senders.list")
        return (result["senders"]?.array ?? []).compactMap(Self.senderTrustRow)
    }

    public func decideSender(entityID: String, decision: SenderDecision) async throws {
        _ = try await call(
            "memory.senders.decide", .obj(["entityId": .string(entityID), "decision": .string(decision.rawValue)]),
            key: "sender-decide-\(UUID().uuidString)")
    }

    // MARK: - Mapping (static, so the wire shapes can be tested without a connection)

    static func heldItem(_ row: JSONValue) -> HeldItem? {
        guard let id = row["id"]?.string, !id.isEmpty, let source = row["source"]?.string,
            let excerpt = row["excerpt"]?.string
        else { return nil }
        // A decided item is not waiting for the owner; the list asks for the undecided ones, this is a second guard.
        if row["decided"]?.string != nil { return nil }
        return HeldItem(
            id: id, source: source, createdAt: row["createdAt"]?.string ?? "",
            reasons: (row["reasons"]?.array ?? []).compactMap { $0.string }, excerpt: excerpt,
            senderEntityID: row["senderEntityId"]?.string)
    }

    static func senderTrustRow(_ row: JSONValue) -> SenderTrustRow? {
        guard let entityID = row["entityId"]?.string, !entityID.isEmpty, let name = row["name"]?.string,
            let state = SenderState(rawValue: row["state"]?.string ?? "")
        else { return nil }
        var confirmed = 0
        if case .number(let number)? = row["confirmed"] { confirmed = Int(number) }
        return SenderTrustRow(entityID: entityID, name: name, confirmed: confirmed, state: state)
    }
}
