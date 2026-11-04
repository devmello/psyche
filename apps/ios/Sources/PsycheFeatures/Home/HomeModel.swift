import Observation
import PsycheStore

@MainActor @Observable
final class HomeModel {
    private(set) var phase: LoadPhase<HomeSnapshot> = .idle
    private let store: any SnapshotStore

    init(store: any SnapshotStore) {
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

    /// Called when `stateVersion` moved while the screen is visible.
    func resync() async { await load() }
}
