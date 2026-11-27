import Foundation
import Observation
import PsycheStore

/// How long a burst of change events must be quiet before a reload runs. A single event reloads after this wait;
/// a resync reloads at once. Shared by the Home, Night shift and Scheduled models.
let liveReloadDelay: Duration = .milliseconds(400)

@MainActor @Observable
final class HomeModel {
    private(set) var phase: LoadPhase<HomeSnapshot> = .idle
    private(set) var unreadInbox = 0
    /// A quiet line shown for a moment (a failed follow-up, "Live Activities arrive…").
    private(set) var notice: String?
    private let store: any PsycheBackend
    private var noticeTask: Task<Void, Never>?
    private let homeReloads: ReloadDebouncer

    init(store: any PsycheBackend, reloadDelay: Duration = liveReloadDelay) {
        self.store = store
        homeReloads = ReloadDebouncer(delay: reloadDelay)
    }

    /// Everything Home shows, on appear and after a resync. A failed refresh keeps what is on screen.
    func load() async {
        await loadHome()
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

    /// Refetches only what changed, debounced, until the view goes away. A resync reloads everything at once.
    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.home): homeReloads.schedule { await self.loadHome() }
            case .resynced:
                homeReloads.cancel()
                await load()
            default: break
            }
        }
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
