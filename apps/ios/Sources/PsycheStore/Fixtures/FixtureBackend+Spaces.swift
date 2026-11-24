import Foundation

/// Spaces fixtures: two live Spaces and one archived, whose trackers are fixture widgets, plus one suggested Space.
/// A chat is in a Space only after it was moved or started there; moving updates the chat list, as the Gateway does.
/// Every edit the phone can make (archive, restore, trackers, links, suggestions) changes this state and publishes
/// the same events the Gateway's would.
struct SpacesState: Sendable {
    var details = FixtureData.spaceDetails
    var refreshes: [String] = []
    var proposals = FixtureData.spaceProposals
}

extension FixtureBackend: SpacesBackend {
    public func spaces() async throws -> [SpaceItem] {
        await pause()
        return spacesState.details.filter { !$0.space.archived }.map { counted($0).space }
    }

    public func archivedSpaces() async throws -> [SpaceItem] {
        await pause()
        return spacesState.details.filter(\.space.archived).map { counted($0).space }
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

    public func setSpaceArchived(id: String, _ archived: Bool) async throws {
        await pause()
        guard let index = spacesState.details.firstIndex(where: { $0.space.id == id }) else { throw BackendError.notFound }
        spacesState.details[index].space.archived = archived
        publish(.changed(.spaces))
    }

    public func addTracker(spaceID: String, template: SpaceTrackerTemplateItem) async throws {
        await pause()
        guard let index = spacesState.details.firstIndex(where: { $0.space.id == spaceID }) else { throw BackendError.notFound }
        guard spacesState.details[index].trackers.count < 12 else {
            throw BackendError.refused("A Space holds up to 12 trackers. Remove one to add another.")
        }
        // The demo has a fixed set of widgets: the template takes the first one not already on this shelf.
        let onShelf = Set(spacesState.details[index].trackers.map(\.widgetID))
        guard let widgetID = widgetState.widgets.keys.sorted().first(where: { !onShelf.contains($0) }) else {
            throw BackendError.refused("There is no widget left to put on this shelf.")
        }
        spacesState.details[index].trackers.append(SpaceTrackerItem(widgetID: widgetID, kind: .query))
        publish(.changed(.spaces))
    }

    public func removeTracker(spaceID: String, widgetID: String) async throws {
        await pause()
        guard let index = spacesState.details.firstIndex(where: { $0.space.id == spaceID }) else { throw BackendError.notFound }
        spacesState.details[index].trackers.removeAll { $0.widgetID == widgetID }
        publish(.changed(.spaces))
    }

    public func reorderTrackers(spaceID: String, widgetIDs: [String]) async throws {
        await pause()
        guard let index = spacesState.details.firstIndex(where: { $0.space.id == spaceID }) else { throw BackendError.notFound }
        let current = spacesState.details[index].trackers
        // The whole order, or nothing: an id the shelf does not hold is refused, as the Gateway refuses it.
        guard Set(widgetIDs) == Set(current.map(\.widgetID)), widgetIDs.count == current.count else {
            throw BackendError.refused("The shelf changed. Refresh the Space and try again.")
        }
        spacesState.details[index].trackers = widgetIDs.compactMap { id in current.first { $0.widgetID == id } }
        publish(.changed(.spaces))
    }

    public func addLink(spaceID: String, url: String, title: String) async throws {
        await pause()
        guard let index = spacesState.details.firstIndex(where: { $0.space.id == spaceID }) else { throw BackendError.notFound }
        let label = title.trimmingCharacters(in: .whitespacesAndNewlines)
        spacesState.details[index].links.append(
            SpaceLinkItem(id: "lnk_\(UUID().uuidString.prefix(8))", label: label.isEmpty ? url : label, kind: "url"))
        publish(.changed(.spaces))
    }

    public func removeLink(spaceID: String, linkID: String) async throws {
        await pause()
        guard let index = spacesState.details.firstIndex(where: { $0.space.id == spaceID }) else { throw BackendError.notFound }
        spacesState.details[index].links.removeAll { $0.id == linkID }
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

    public func spaceID(forProject projectID: String) async throws -> String? {
        await pause()
        return spacesState.details.first { $0.space.entityID == projectID }?.space.id
    }

    public func makeSpace(forProject projectID: String, named name: String) async throws -> String {
        await pause()
        if let existing = spacesState.details.first(where: { $0.space.entityID == projectID }) { return existing.space.id }
        let id = "spc_\(projectID)"
        spacesState.details.append(SpaceDetailItem(space: SpaceItem(id: id, name: name, entityID: projectID)))
        publish(.changed(.spaces))
        return id
    }

    public func spaceProposals() async throws -> [SpaceProposalItem] {
        await pause()
        return spacesState.proposals
    }

    public func acceptProposal(id: String) async throws -> String {
        await pause()
        guard let proposal = spacesState.proposals.first(where: { $0.id == id }) else { throw BackendError.notFound }
        let spaceID = "spc_\(id)"
        if !spacesState.details.contains(where: { $0.space.id == spaceID }) {
            spacesState.details.append(SpaceDetailItem(space: SpaceItem(id: spaceID, name: proposal.name)))
        }
        spacesState.proposals.removeAll { $0.id == id }
        // The chats it names move in, as Create does on the Mac.
        for index in chatState.summaries.indices where proposal.chatTitles.contains(chatState.summaries[index].title) {
            chatState.summaries[index].spaceID = spaceID
        }
        publish(.changed(.spaces))
        publish(.changed(.threads))
        return spaceID
    }

    public func dismissProposal(id: String) async throws {
        await pause()
        spacesState.proposals.removeAll { $0.id == id }
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
        SpaceDetailItem(
            space: SpaceItem(id: "spc_house", name: "House sale 2025", description: "Closed in March", archived: true),
            instructions: "Keep the closing statement."),
    ]

    static let spaceProposals: [SpaceProposalItem] = [
        SpaceProposalItem(
            id: "prp_lisbon", name: "Lisbon trip", reason: "Three chats about flights and a hotel.",
            chatTitles: ["Flights to Lisbon", "Hotel near Alfama"]),
    ]
}
