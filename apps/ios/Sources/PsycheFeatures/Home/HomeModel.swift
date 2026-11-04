import Foundation
import Observation
import PsycheStore

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

    init(store: any PsycheBackend) {
        self.store = store
    }

    /// Cached snapshot first, then live data; I2 splits the two. A failed refresh keeps what is on screen.
    func load() async {
        if phase.value == nil { phase = .loading }
        async let memory = try? store.memory()
        async let inbox = try? store.inbox()
        async let pinned = try? store.pinnedWidgets()
        do {
            phase = .loaded(try await store.home())
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
        if let memory = await memory {
            let open = memory.todos.filter { !$0.done }
            comingUp = Array(open.filter { $0.bucket == .thisWeek }.prefix(4))
            laterTodos = Array(open.filter { $0.bucket == .later }.prefix(3))
        }
        if let inbox = await inbox { unreadInbox = inbox.filter { !$0.read }.count }
        if let pinned = await pinned { pinnedWidgets = Array(pinned.prefix(6)) }
    }

    /// Refetches when Home's data changed or the connection resynced, until the view goes away.
    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.home), .changed(.memory), .resynced: await load()
            default: break
            }
        }
    }

    func act(on nudge: Nudge, _ action: NudgeAction) async {
        do {
            try await store.actOnNudge(id: nudge.id, action: action)
        } catch {
            show(error.localizedDescription)
        }
    }

    func show(_ message: String) {
        notice = message
        noticeTask?.cancel()
        noticeTask = Task {
            try? await Task.sleep(for: .seconds(2.5))
            if !Task.isCancelled { notice = nil }
        }
    }
}
