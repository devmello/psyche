import Foundation

// Spaces: lasting workspaces for a project, its chats, trackers, files and links (docs/design/spaces-2026.md §4, §7.2).
// Gateway methods: spaces.list/get/open/update, spaces.trackers.refresh, spaces.threads.move, and `spaceId` on
// threads.newChat and threads.list. Read-mostly on the phone: instructions can be edited here, folders and Space
// settings are Mac things. The app never picks a Space for the owner: a chat is in a Space only when the owner
// chose it (SP5).

public protocol SpacesBackend: Sendable {
    func spaces() async throws -> [SpaceItem]
    /// One Space with its parts (`spaces.get`).
    func space(id: String) async throws -> SpaceDetailItem
    /// Called when the Space page opens (`spaces.open`): the Gateway recomputes stale query trackers for free.
    func openSpace(id: String) async throws -> [SpaceTrackerStatus]
    /// The owner's Refresh on a tracker (`spaces.trackers.refresh`).
    func refreshTracker(spaceID: String, widgetID: String) async throws -> SpaceTrackerStatus
    /// Writes the instructions (`spaces.update`); they apply from the Space's next run.
    func setSpaceInstructions(id: String, _ text: String) async throws
    /// The chats in one Space (`threads.list { spaceId }`).
    func spaceThreads(id: String) async throws -> [ChatThreadSummary]
    /// A new chat that starts in the Space (`threads.newChat { spaceId }`).
    func newThread(inSpace id: String) async throws -> ChatThreadSummary
    /// Moves a chat into a Space, or out with nil (`spaces.threads.move`).
    func moveThread(id: String, toSpace spaceID: String?) async throws
    /// The Space linked to a Memory project, if there is one (`spaces.list` entityId).
    func spaceID(forProject projectID: String) async throws -> String?
    /// "Make a Space" on a project's page: one Space linked to the project (`spaces.create { entityId }`), made by the
    /// owner's tap. Returns its id.
    func makeSpace(forProject projectID: String, named name: String) async throws -> String
    /// Archived Spaces (`spaces.list { archived: true }`), listed at the end of Home's Spaces section.
    func archivedSpaces() async throws -> [SpaceItem]
    /// Archives (`spaces.archive`) or restores (`spaces.restore`) a Space.
    func setSpaceArchived(id: String, _ archived: Bool) async throws
    /// Puts a tracker from a template on the shelf (`spaces.trackers.add { template }`).
    func addTracker(spaceID: String, template: SpaceTrackerTemplateItem) async throws
    /// Takes a tracker off the shelf (`spaces.trackers.remove`); its widget returns to its chat.
    func removeTracker(spaceID: String, widgetID: String) async throws
    /// The whole shelf order (`spaces.trackers.reorder`).
    func reorderTrackers(spaceID: String, widgetIDs: [String]) async throws
    /// Adds an owner link (`spaces.links.add`, kind url). The label is the title, or the address without one.
    func addLink(spaceID: String, url: String, title: String) async throws
    /// Removes a link from a Space (`spaces.links.remove`).
    func removeLink(spaceID: String, linkID: String) async throws
    /// The open suggested Spaces (`spaces.proposals.list`).
    func spaceProposals() async throws -> [SpaceProposalItem]
    /// Creates the suggested Space and moves its chats in (`spaces.proposals.accept`). Returns the Space's id.
    func acceptProposal(id: String) async throws -> String
    /// Dismisses a suggested Space (`spaces.proposals.dismiss`).
    func dismissProposal(id: String) async throws
}

/// The templates the shelf's Add menu offers (`SpaceTrackerTemplate` in the protocol).
public enum SpaceTrackerTemplateItem: String, Sendable, CaseIterable, Identifiable {
    case workDue = "work_due"
    case nextEvents = "next_events"
    case recentFiles = "recent_files"
    case mailOnThis = "mail_on_this"
    case checklist
    case automationStatus = "automation_status"
    public var id: String { rawValue }
}

/// A Space the agent suggested (`SpaceProposal`). `untrusted` means outside content (a web page, a mail) was read
/// while the suggestion was made; the owner sees that before creating it.
public struct SpaceProposalItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var reason: String
    /// The chats Create would move now, by title.
    public var chatTitles: [String]
    public var projectName: String?
    public var untrusted: Bool
    public init(
        id: String, name: String, reason: String = "", chatTitles: [String] = [], projectName: String? = nil,
        untrusted: Bool = false
    ) {
        self.id = id
        self.name = name
        self.reason = reason
        self.chatTitles = chatTitles
        self.projectName = projectName
        self.untrusted = untrusted
    }
}

public struct SpaceItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var description: String
    public var chats: Int
    public var trackers: Int
    public var due: Int
    public var lastActivityAt: Date?
    /// The Memory project this Space is linked to, if any.
    public var entityID: String?
    /// Archived Spaces come from `archivedSpaces()`; the Home list leaves them out.
    public var archived: Bool

    public init(
        id: String, name: String, description: String = "", chats: Int = 0, trackers: Int = 0, due: Int = 0,
        lastActivityAt: Date? = nil, entityID: String? = nil, archived: Bool = false
    ) {
        self.archived = archived
        self.id = id
        self.name = name
        self.description = description
        self.chats = chats
        self.trackers = trackers
        self.due = due
        self.lastActivityAt = lastActivityAt
        self.entityID = entityID
    }
}

public struct SpaceFolderItem: Sendable, Equatable, Identifiable {
    public var path: String
    public var writable: Bool
    public var id: String { path }
    public init(path: String, writable: Bool = false) {
        self.path = path
        self.writable = writable
    }
}

public struct SpaceLinkItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var label: String
    public var kind: String
    /// The label came from outside the owner and the agent (a web page, a mail): shown as text, never acted on.
    public var untrusted: Bool
    public init(id: String, label: String, kind: String, untrusted: Bool = false) {
        self.id = id
        self.label = label
        self.kind = kind
        self.untrusted = untrusted
    }
}

public struct SpaceTrackerItem: Sendable, Equatable, Identifiable {
    public enum Kind: String, Sendable { case bound, query, agent }
    public var widgetID: String
    public var kind: Kind
    public var refreshedAt: Date?
    public var id: String { widgetID }
    /// A bound tracker follows its task by itself; the others have a Refresh button.
    public var canRefresh: Bool { kind != .bound }
    public init(widgetID: String, kind: Kind, refreshedAt: Date? = nil) {
        self.widgetID = widgetID
        self.kind = kind
        self.refreshedAt = refreshedAt
    }
}

public struct SpaceTrackerStatus: Sendable, Equatable {
    public var widgetID: String
    public var refreshedAt: Date?
    public var stale: Bool
    public var unavailable: Bool
    public init(widgetID: String, refreshedAt: Date? = nil, stale: Bool = false, unavailable: Bool = false) {
        self.widgetID = widgetID
        self.refreshedAt = refreshedAt
        self.stale = stale
        self.unavailable = unavailable
    }
}

public struct SpaceDetailItem: Sendable, Equatable {
    public var space: SpaceItem
    public var instructions: String
    public var folders: [SpaceFolderItem]
    public var links: [SpaceLinkItem]
    public var trackers: [SpaceTrackerItem]
    public var automations: Int

    public init(
        space: SpaceItem, instructions: String = "", folders: [SpaceFolderItem] = [], links: [SpaceLinkItem] = [],
        trackers: [SpaceTrackerItem] = [], automations: Int = 0
    ) {
        self.space = space
        self.instructions = instructions
        self.folders = folders
        self.links = links
        self.trackers = trackers
        self.automations = automations
    }
}
