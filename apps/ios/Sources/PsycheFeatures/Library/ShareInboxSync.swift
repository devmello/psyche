import PsycheShared
import PsycheStore
import SwiftUI

extension View {
    /// Picks up what the share extension queued, on launch and every time the app comes to the front, and
    /// keeps the extension's list of recent threads current.
    func syncsShareInbox(store: any PsycheBackend) -> some View {
        modifier(ShareInboxSync(store: store))
    }
}

/// Fixture mode ("Try it without a Mac", `-psycheScenario`) runs on made-up data and must not touch the real
/// share inbox or the thread list the share sheet reads.
enum ShareInboxPolicy {
    static func touchesRealInbox(backend: any PsycheBackend) -> Bool { !(backend is FixtureBackend) }
}

private struct ShareInboxSync: ViewModifier {
    let store: any PsycheBackend
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .task { await sync() }
            .task {
                for await event in store.events() {
                    switch event {
                    case .changed(.threads), .resynced: await writeRecents()
                    default: break
                    }
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await sync() } }
            }
    }

    private func sync() async {
        guard ShareInboxPolicy.touchesRealInbox(backend: store), let inbox = ShareInbox.shared else { return }
        await writeRecents()
        await ShareInboxDrain.run(inbox: inbox, backend: store)
    }

    private func writeRecents() async {
        guard ShareInboxPolicy.touchesRealInbox(backend: store), let inbox = ShareInbox.shared else { return }
        await ShareInboxDrain.writeRecents(inbox: inbox, backend: store)
    }
}
