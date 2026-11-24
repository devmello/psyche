import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// Spaces over `spaces.*` (docs/design/spaces-2026.md §4.2). The phone reads Spaces, opens one (the Gateway recomputes
// stale query trackers for free), refreshes a tracker on request, edits instructions, starts a chat in a Space and
// moves a chat in or out. Folders and Space settings are admin scope and stay on the Mac.
/// Mirrors `SPACE_LIMITS` in the protocol.
enum SpaceLimits { static let name = 60, linkLabel = 120 }

extension GatewayBackend {
    public func spaces() async throws -> [SpaceItem] {
        let result = try await call("spaces.list", .obj([:]))
        return (result["spaces"]?.array ?? []).compactMap(Self.spaceItem(from:))
    }

    public func space(id: String) async throws -> SpaceDetailItem {
        let result = try await call("spaces.get", .obj(["spaceId": .string(id)]))
        guard let detail = Self.spaceDetail(from: result) else { throw BackendError.notFound }
        return detail
    }

    public func openSpace(id: String) async throws -> [SpaceTrackerStatus] {
        let result = try await call("spaces.open", .obj(["spaceId": .string(id)]))
        return (result["trackers"]?.array ?? []).compactMap(Self.trackerStatus(from:))
    }

    public func refreshTracker(spaceID: String, widgetID: String) async throws -> SpaceTrackerStatus {
        // Side-effecting: an agent tracker starts its one run. A retried tap must not start a second.
        let key = "spaces.trackers.refresh.\(spaceID).\(widgetID).\(Int(Date.now.timeIntervalSince1970 / 30))"
        let result = try await call(
            "spaces.trackers.refresh", .obj(["spaceId": .string(spaceID), "widgetId": .string(widgetID)]), key: key)
        guard let wire = result["tracker"], let status = Self.trackerStatus(from: wire) else {
            throw BackendError.refused(String(localized: "The Gateway didn't refresh that tracker.", bundle: .module))
        }
        return status
    }

    public func setSpaceInstructions(id: String, _ text: String) async throws {
        _ = try await call("spaces.update", .obj(["spaceId": .string(id), "instructions": .string(text)]))
    }

    public func spaceThreads(id: String) async throws -> [ChatThreadSummary] {
        let result = try await call("threads.list", .obj(["spaceId": .string(id), "limit": .number(60)]))
        return (result["threads"]?.array ?? []).compactMap(Self.summary(from:))
    }

    public func newThread(inSpace id: String) async throws -> ChatThreadSummary {
        let result = try await call("threads.newChat", .obj(["kind": "side", "spaceId": .string(id)]))
        guard let thread = result["thread"], let summary = Self.summary(from: .obj(["thread": thread, "activity": nil])) else {
            throw BackendError.refused(String(localized: "The Gateway didn't create a chat.", bundle: .module))
        }
        return summary
    }

    public func moveThread(id: String, toSpace spaceID: String?) async throws {
        _ = try await call(
            "spaces.threads.move",
            .obj(["threadIds": .array([.string(id)]), "spaceId": spaceID.map { .string($0) } ?? .null]))
    }

    public func spaceID(forProject projectID: String) async throws -> String? {
        let result = try await call("spaces.list", .obj([:]))
        return (result["spaces"]?.array ?? []).first { $0["entityId"]?.string == projectID }?["id"]?.string
    }

    public func makeSpace(forProject projectID: String, named name: String) async throws -> String {
        // Side-effecting: a retried tap returns the same Space (and the Gateway refuses a second one per project).
        let result = try await call(
            "spaces.create", .obj(["name": .string(String(name.prefix(SpaceLimits.name))), "entityId": .string(projectID)]),
            key: "spaces.create.project.\(projectID)")
        guard let id = result.at("space", "id")?.string else {
            throw BackendError.refused(String(localized: "The Gateway didn't make that Space.", bundle: .module))
        }
        return id
    }

    // MARK: Wire to model

    static func spaceItem(from wire: JSONValue) -> SpaceItem? {
        guard let id = wire["id"]?.string, let name = wire["name"]?.string else { return nil }
        return SpaceItem(
            id: id, name: name, description: wire["description"]?.string ?? "",
            chats: wire.at("counts", "chats")?.int ?? 0, trackers: wire.at("counts", "trackers")?.int ?? 0,
            due: wire.at("counts", "due")?.int ?? 0, lastActivityAt: WireFormat.date(wire["lastActivityAt"]?.string),
            entityID: wire["entityId"]?.string, archived: wire["archivedAt"]?.string != nil)
    }

    static func spaceDetail(from wire: JSONValue) -> SpaceDetailItem? {
        guard var space = wire["space"].flatMap(Self.spaceItem(from:)) else { return nil }
        // `spaces.get` carries the counts and last activity beside the Space row.
        space.chats = wire.at("counts", "chats")?.int ?? 0
        space.trackers = wire.at("counts", "trackers")?.int ?? 0
        space.due = wire.at("counts", "due")?.int ?? 0
        space.lastActivityAt = WireFormat.date(wire["lastActivityAt"]?.string)
        let folders: [SpaceFolderItem] = (wire["folders"]?.array ?? []).compactMap { folder in
            guard let path = folder["path"]?.string else { return nil }
            return SpaceFolderItem(path: path, writable: folder["mode"]?.string == "rw")
        }
        let links: [SpaceLinkItem] = (wire["links"]?.array ?? []).compactMap { link in
            guard let id = link["id"]?.string, let label = link["label"]?.string else { return nil }
            return SpaceLinkItem(
                id: id, label: label, kind: link["kind"]?.string ?? "url", untrusted: link["labelProvenance"]?.string == "untrusted")
        }
        let trackers: [SpaceTrackerItem] = (wire["trackers"]?.array ?? [])
            .sorted { ($0["position"]?.int ?? 0) < ($1["position"]?.int ?? 0) }
            .compactMap { tracker in
                guard let widgetID = tracker["widgetId"]?.string else { return nil }
                return SpaceTrackerItem(
                    widgetID: widgetID, kind: tracker["kind"]?.string.flatMap(SpaceTrackerItem.Kind.init(rawValue:)) ?? .query,
                    refreshedAt: WireFormat.date(tracker["refreshedAt"]?.string))
            }
        return SpaceDetailItem(
            space: space, instructions: wire.at("space", "instructions")?.string ?? "", folders: folders, links: links,
            trackers: trackers, automations: wire["automationIds"]?.array?.count ?? 0)
    }

    static func trackerStatus(from wire: JSONValue) -> SpaceTrackerStatus? {
        guard let widgetID = wire["widgetId"]?.string else { return nil }
        return SpaceTrackerStatus(
            widgetID: widgetID, refreshedAt: WireFormat.date(wire["refreshedAt"]?.string),
            stale: wire["stale"]?.bool ?? false, unavailable: wire["unavailable"]?.bool ?? false)
    }
}
