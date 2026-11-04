import Observation
import PsycheStore

@MainActor @Observable
final class AgentModel {
    private(set) var phase: LoadPhase<AgentActivity> = .idle
    private(set) var persona: PersonaSummary?
    private(set) var error: String?
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        async let persona = try? store.persona()
        do {
            phase = .loaded(try await store.activity())
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
        self.persona = await persona ?? self.persona
    }

    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.activity), .changed(.home), .resynced: await load()
            default: break
            }
        }
    }

    func cancel(taskID: String) async {
        do {
            try await store.cancelTask(id: taskID)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        await load()
    }
}

extension AgentActivity {
    static let skeleton = AgentActivity(
        needsYou: HomeSnapshot.skeleton.needsYou, now: HomeSnapshot.skeleton.running,
        nextUp: (1...2).map { UpcomingItem(id: "sku\($0)", title: "Placeholder upcoming title", when: "Tomorrow 7:00") },
        recent: (1...2).map { RecentRun(id: "skr\($0)", title: "Placeholder recent title", outcome: .done, time: "Yesterday") })
}
