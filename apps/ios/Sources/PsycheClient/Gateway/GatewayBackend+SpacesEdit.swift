import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// Editing Spaces from the phone (`spaces.*` in packages/protocol/src/methods/spaces.ts): archive and restore, the
// shelf's trackers (add from a template, remove, reorder), owner links, and suggested Spaces (accept or dismiss).
// Folders and Space settings stay on the Mac.
extension GatewayBackend {
    public func archivedSpaces() async throws -> [SpaceItem] {
        let result = try await call("spaces.list", .obj(["archived": .bool(true)]))
        return (result["spaces"]?.array ?? []).compactMap(Self.spaceItem(from:))
    }

    public func setSpaceArchived(id: String, _ archived: Bool) async throws {
        _ = try await call(archived ? "spaces.archive" : "spaces.restore", .obj(["spaceId": .string(id)]))
    }

    public func addTracker(spaceID: String, template: SpaceTrackerTemplateItem) async throws {
        _ = try await call(
            "spaces.trackers.add", .obj(["spaceId": .string(spaceID), "template": .string(template.rawValue)]))
    }

    public func removeTracker(spaceID: String, widgetID: String) async throws {
        _ = try await call("spaces.trackers.remove", .obj(["spaceId": .string(spaceID), "widgetId": .string(widgetID)]))
    }

    public func reorderTrackers(spaceID: String, widgetIDs: [String]) async throws {
        _ = try await call(
            "spaces.trackers.reorder",
            .obj(["spaceId": .string(spaceID), "widgetIds": .array(widgetIDs.map { JSONValue.string($0) })]))
    }

    public func addLink(spaceID: String, url: String, title: String) async throws {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = trimmedTitle.isEmpty ? url : trimmedTitle
        _ = try await call(
            "spaces.links.add",
            .obj([
                "spaceId": .string(spaceID), "kind": "url", "ref": .string(url),
                "label": .string(String(label.prefix(SpaceLimits.linkLabel))),
            ]))
    }

    public func removeLink(spaceID: String, linkID: String) async throws {
        _ = try await call("spaces.links.remove", .obj(["spaceId": .string(spaceID), "linkId": .string(linkID)]))
    }

    public func spaceProposals() async throws -> [SpaceProposalItem] {
        let result = try await call("spaces.proposals.list", .obj([:]))
        return (result["proposals"]?.array ?? []).compactMap(Self.proposalItem(from:))
    }

    public func acceptProposal(id: String) async throws -> String {
        // Side-effecting: a retried tap must not make a second Space.
        let result = try await call(
            "spaces.proposals.accept", .obj(["proposalId": .string(id)]), key: "spaces.proposals.accept.\(id)")
        guard let spaceID = result.at("space", "id")?.string else {
            throw BackendError.refused(String(localized: "The Gateway didn't make that Space.", bundle: .module))
        }
        return spaceID
    }

    public func dismissProposal(id: String) async throws {
        _ = try await call("spaces.proposals.dismiss", .obj(["proposalId": .string(id)]))
    }

    // MARK: Wire to model

    static func proposalItem(from wire: JSONValue) -> SpaceProposalItem? {
        guard let id = wire["id"]?.string, let name = wire["name"]?.string else { return nil }
        let chats: [String] = (wire["chats"]?.array ?? []).compactMap { $0["title"]?.string }
        return SpaceProposalItem(
            id: id, name: name, reason: wire["reason"]?.string ?? "", chatTitles: chats,
            projectName: wire["projectName"]?.string, untrusted: !(wire["taint"]?.array ?? []).isEmpty)
    }
}
