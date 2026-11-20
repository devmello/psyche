import Foundation
import Observation
import PsycheStore

/// Home's Spaces section: the Spaces in sort order. A failed load leaves the section out rather than breaking Home.
@MainActor @Observable
final class SpacesListModel {
    private(set) var spaces: [SpaceItem] = []
    private let store: any PsycheBackend

    init(store: any PsycheBackend) { self.store = store }

    func load() async {
        if let loaded = try? await store.spaces() { spaces = loaded }
    }

    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.spaces), .changed(.threads), .resynced: await load()
            default: break
            }
        }
    }
}

/// One Space page: the Space with its parts, the widget behind each tracker, and the chats in it.
@MainActor @Observable
final class SpaceModel {
    private(set) var phase: LoadPhase<SpaceDetailItem> = .idle
    private(set) var widgets: [String: WidgetSnapshot] = [:]
    private(set) var status: [String: SpaceTrackerStatus] = [:]
    private(set) var chats: [ChatThreadSummary] = []
    private(set) var refreshing: Set<String> = []
    private(set) var actionError: String?
    let id: String
    private let store: any PsycheBackend

    init(id: String, store: any PsycheBackend) {
        self.id = id
        self.store = store
    }

    /// Opening the page calls `spaces.open` once (the Gateway recomputes stale query trackers, rate-limited).
    func load(opening: Bool = false) async {
        if phase.value == nil { phase = .loading }
        do {
            let detail = try await store.space(id: id)
            phase = .loaded(detail)
            async let chats = try? store.spaceThreads(id: id)
            if opening, let statuses = try? await store.openSpace(id: id) {
                for item in statuses { status[item.widgetID] = item }
            }
            await loadWidgets(detail.trackers)
            if let chats = await chats { self.chats = chats }
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }

    private func loadWidgets(_ trackers: [SpaceTrackerItem]) async {
        var loaded: [String: WidgetSnapshot] = [:]
        for tracker in trackers {
            if let snapshot = try? await store.widget(id: tracker.widgetID) { loaded[tracker.widgetID] = snapshot }
        }
        widgets = loaded
    }

    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.spaces), .changed(.threads), .resynced: await load()
            default: break
            }
        }
    }

    func refresh(_ tracker: SpaceTrackerItem) async {
        guard tracker.canRefresh, !refreshing.contains(tracker.widgetID) else { return }
        refreshing.insert(tracker.widgetID)
        defer { refreshing.remove(tracker.widgetID) }
        do {
            status[tracker.widgetID] = try await store.refreshTracker(spaceID: id, widgetID: tracker.widgetID)
            if let snapshot = try? await store.widget(id: tracker.widgetID) { widgets[tracker.widgetID] = snapshot }
        } catch {
            actionError = error.localizedDescription
        }
    }

    func saveInstructions(_ text: String) async -> Bool {
        do {
            try await store.setSpaceInstructions(id: id, text)
            await load()
            return true
        } catch {
            actionError = error.localizedDescription
            return false
        }
    }

    /// Starts a chat in this Space and returns its id so the page can open it.
    func newChat() async -> String? {
        do {
            return try await store.newThread(inSpace: id).id
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    func clearError() { actionError = nil }
}

/// The Chat tab's Space menu. The app never guesses a Space (SP5): new chats start in a Space only while the owner
/// has chosen one here, and the choice is forgotten when the app restarts.
@MainActor @Observable
final class SpaceMenuModel {
    private(set) var spaces: [SpaceItem] = []
    /// nil is "No Space".
    private(set) var target: String?
    private(set) var actionError: String?
    private let store: any PsycheBackend

    init(store: any PsycheBackend) { self.store = store }

    var targetName: String? { spaces.first { $0.id == target }?.name }

    func load() async {
        if let loaded = try? await store.spaces() { spaces = loaded }
        // A Space that went away (archived, deleted) can no longer be the target.
        if let target, !spaces.contains(where: { $0.id == target }) { self.target = nil }
    }

    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.spaces), .resynced: await load()
            default: break
            }
        }
    }

    func choose(_ id: String?) { target = id }

    /// A new chat in the chosen Space, or a plain one when none is chosen.
    func newChat() async -> String? {
        do {
            if let target { return try await store.newThread(inSpace: target).id }
            return try await store.newThread().id
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    func move(_ thread: ChatThreadSummary, to spaceID: String?) async {
        do { try await store.moveThread(id: thread.id, toSpace: spaceID) } catch {
            actionError = error.localizedDescription
        }
    }

    func clearError() { actionError = nil }
}
