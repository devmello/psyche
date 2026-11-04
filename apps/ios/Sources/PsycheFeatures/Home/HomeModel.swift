import Observation
import PsycheStore

@MainActor @Observable
final class HomeModel {
    private(set) var phase: LoadPhase<HomeSnapshot> = .idle
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
    }

    /// Cached snapshot first, then live data; I2 splits the two.
    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(try await store.home())
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Refetches when Home's data changed or the connection resynced, until the view goes away.
    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.home), .resynced: await load()
            default: break
            }
        }
    }
}
