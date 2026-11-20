import Foundation

/// Spaces fixtures: two Spaces whose trackers are fixture widgets. A chat is in a Space only after it was moved or
/// started there; moving updates the chat list, as the Gateway does.
struct SpacesState: Sendable {
    var details = FixtureData.spaceDetails
    var refreshes: [String] = []
}

extension FixtureBackend: SpacesBackend {
    public func spaces() async throws -> [SpaceItem] {
        await pause()
        return spacesState.details.map { counted($0).space }
    }

    public func space(id: String) async throws -> SpaceDetailItem {
        await pause()
        guard let detail = spacesState.details.first(where: { $0.space.id == id }) else { throw BackendError.notFound }
        return counted(detail)
    }

    public func openSpace(id: String) async throws -> [SpaceTrackerStatus] {
        await pause()
        guard let detail = spacesState.details.first(where: { $0.space.id == id }) else { throw BackendError.notFound }
        return detail.trackers.filter(\.canRefresh).map { SpaceTrackerStatus(widgetID: $0.widgetID, refreshedAt: $0.refreshedAt) }
    }

    public func refreshTracker(spaceID: String, widgetID: String) async throws -> SpaceTrackerStatus {
        guard let index = spacesState.details.firstIndex(where: { $0.space.id == spaceID }),
            let tracker = spacesState.details[index].trackers.firstIndex(where: { $0.widgetID == widgetID })
        else { throw BackendError.notFound }
        let now = Date.now
        spacesState.details[index].trackers[tracker].refreshedAt = now
        spacesState.refreshes.append(widgetID)
        publish(.changed(.spaces))
        return SpaceTrackerStatus(widgetID: widgetID, refreshedAt: now)
    }

    public func setSpaceInstructions(id: String, _ text: String) async throws {
        guard let index = spacesState.details.firstIndex(where: { $0.space.id == id }) else { throw BackendError.notFound }
        spacesState.details[index].instructions = text
        publish(.changed(.spaces))
    }

    public func spaceThreads(id: String) async throws -> [ChatThreadSummary] {
        await pause()
        return chatState.summaries.filter { $0.spaceID == id }
    }

    public func newThread(inSpace id: String) async throws -> ChatThreadSummary {
        guard spacesState.details.contains(where: { $0.space.id == id }) else { throw BackendError.notFound }
        var summary = try await newThread()
        guard let index = chatState.summaries.firstIndex(where: { $0.id == summary.id }) else { return summary }
        chatState.summaries[index].spaceID = id
        summary.spaceID = id
        publish(.changed(.spaces))
        return summary
    }

    public func moveThread(id: String, toSpace spaceID: String?) async throws {
        if let spaceID, !spacesState.details.contains(where: { $0.space.id == spaceID }) { throw BackendError.notFound }
        guard let index = chatState.summaries.firstIndex(where: { $0.id == id }), !chatState.summaries[index].isMain
        else { throw BackendError.notFound }
        chatState.summaries[index].spaceID = spaceID
        publish(.changed(.threads))
        publish(.changed(.spaces))
    }

    /// The counts come from the live state, as `spaces.list` computes them.
    private func counted(_ detail: SpaceDetailItem) -> SpaceDetailItem {
        var detail = detail
        detail.space.chats = chatState.summaries.filter { $0.spaceID == detail.space.id }.count
        detail.space.trackers = detail.trackers.count
        return detail
    }
}

extension FixtureData {
    static let spaceDetails: [SpaceDetailItem] = [
        SpaceDetailItem(
            space: SpaceItem(id: "spc_kitchen", name: "Kitchen remodel", description: "Budget $25k, cc Sam", due: 2),
            instructions: "Budget is $25k. Copy Sam on anything about the contractor. Prefer quotes in writing.",
            folders: [SpaceFolderItem(path: "~/Documents/Kitchen", writable: false)],
            links: [
                SpaceLinkItem(id: "lnk_1", label: "Contractor shortlist", kind: "note"),
                SpaceLinkItem(id: "lnk_2", label: "Tile supplier page", kind: "url", untrusted: true),
            ],
            trackers: [
                SpaceTrackerItem(widgetID: "wdg_progress", kind: .query, refreshedAt: Date(timeIntervalSince1970: 1_900_000_000)),
                SpaceTrackerItem(widgetID: "wdg_bound", kind: .bound),
            ],
            automations: 1),
        SpaceDetailItem(
            space: SpaceItem(id: "spc_taxes", name: "Taxes 2026"),
            instructions: "",
            automations: 0),
    ]
}
