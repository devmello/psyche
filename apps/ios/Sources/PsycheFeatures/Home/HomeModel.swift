import Foundation
import Observation
import PsycheStore

/// How long a burst of change events must be quiet before a reload runs. A single event reloads after this wait;
/// a resync reloads at once. Shared by the Home, Night shift, Followups and Agent models.
let liveReloadDelay: Duration = .milliseconds(400)

@MainActor @Observable
final class HomeModel {
    private(set) var phase: LoadPhase<HomeSnapshot> = .idle
    /// From Memory (read-only here): due this week, and the rest.
    private(set) var comingUp: [TodoItem] = []
    private(set) var laterTodos: [TodoItem] = []
    private(set) var unreadInbox = 0
    /// Home's Pinned section (§4.1 item 7): up to 6 widgets, empty when nothing is pinned.
    private(set) var pinnedWidgets: [WidgetSnapshot] = []
    /// A quiet line shown for a moment (a failed nudge, "Live Activities arrive…").
    private(set) var notice: String?
    private let store: any PsycheBackend
    private var noticeTask: Task<Void, Never>?
    /// Each topic has its own debounce: a Home event never refetches Memory, and a Memory event never refetches Home.
    private let homeReloads: ReloadDebouncer
    private let memoryReloads: ReloadDebouncer
    private let pinReloads: ReloadDebouncer

    init(store: any PsycheBackend, reloadDelay: Duration = liveReloadDelay) {
        self.store = store
        homeReloads = ReloadDebouncer(delay: reloadDelay)
        memoryReloads = ReloadDebouncer(delay: reloadDelay)
        pinReloads = ReloadDebouncer(delay: reloadDelay)
    }

    /// Everything Home shows, on appear and after a resync. A failed refresh keeps what is on screen.
    func load() async {
        async let memory: Void = loadMemory()
        async let pins: Void = loadPins()
        await loadHome()
        await memory
        await pins
    }

    /// The Gateway's Home snapshot and the unread count.
    private func loadHome() async {
        if phase.value == nil { phase = .loading }
        async let inbox = try? store.inbox()
        do {
            phase = .loaded(try await store.home())
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
        if let inbox = await inbox { unreadInbox = inbox.filter { !$0.read }.count }
    }

    /// The to-dos come from Memory: only the Memory topic reads it.
    private func loadMemory() async {
        guard let memory = try? await store.memory() else { return }
        let open = memory.todos.filter { !$0.done }
        comingUp = Array(open.filter { $0.bucket == .thisWeek }.prefix(4))
        laterTodos = Array(open.filter { $0.bucket == .later }.prefix(3))
    }

    private func loadPins() async {
        if let pinned = try? await store.pinnedWidgets() { pinnedWidgets = Array(pinned.prefix(6)) }
    }

    /// Refetches only what changed, debounced, until the view goes away. A resync reloads everything at once.
    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.home): homeReloads.schedule { await self.loadHome() }
            case .changed(.memory): memoryReloads.schedule { await self.loadMemory() }
            case .changed(.widgets): pinReloads.schedule { await self.loadPins() }
            case .resynced:
                cancelReloads()
                await load()
            default: break
            }
        }
    }

    private func cancelReloads() {
        homeReloads.cancel()
        memoryReloads.cancel()
        pinReloads.cancel()
    }

    /// Today follow-ups whose Done, Snooze or Dismiss is in flight: their buttons wait.
    private(set) var followupsBusy: Set<String> = []

    /// Done, snooze or dismiss on a Today follow-up. The row leaves Today once the Gateway accepts it; a refusal keeps
    /// the row and shows the Gateway's words. A snooze without `until` comes back tomorrow morning.
    func actOnFollowup(_ item: BriefItem, _ action: FollowupAction, until: Date? = nil) async {
        guard !followupsBusy.contains(item.id) else { return }
        followupsBusy.insert(item.id)
        defer { followupsBusy.remove(item.id) }
        do {
            try await store.actOnFollowup(id: item.id, action: action, until: until)
            if case .loaded(var snapshot) = phase {
                snapshot.today.removeAll { $0.id == item.id }
                phase = .loaded(snapshot)
            }
        } catch {
            show(error.localizedDescription)
        }
    }

    func act(on nudge: Nudge, _ action: NudgeAction) async {
        do {
            try await store.actOnNudge(id: nudge.id, action: action)
        } catch {
            show(error.localizedDescription)
        }
    }

    /// A quiet toast. Something that didn't work (Watch with Live Activities off) stays longer than a confirmation.
    func show(_ message: String, seconds: Double = 2.5) {
        notice = message
        noticeTask?.cancel()
        noticeTask = Task {
            try? await Task.sleep(for: .seconds(seconds))
            if !Task.isCancelled { notice = nil }
        }
    }
}
