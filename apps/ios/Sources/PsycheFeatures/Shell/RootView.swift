import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// The window's content: pairing until a Gateway is paired, then the tabs.
public struct RootView: View {
    @Environment(Session.self) private var session
    @State private var router = Router()
    private let store: any PsycheBackend

    public init(store: any PsycheBackend = FixtureBackend.shared) {
        self.store = store
    }

    public var body: some View {
        Group {
            switch session.state {
            case .unpaired, .pending, .revoked:
                PairingFlow()
            case .refused:
                RefusedView()
            case .connecting, .live, .unreachable:
                MainTabs(store: store)
            }
        }
        .environment(router)
        .environment(\.backend, store)
        .animation(.default, value: session.state.needsPairing)
    }
}

struct MainTabs: View {
    let store: any PsycheBackend
    @Environment(Router.self) private var router

    var body: some View {
        @Bindable var router = router
        TabView(selection: $router.tab) {
            Tab("Home", systemImage: "house", value: AppTab.home) {
                NavigationStack(path: $router.homePath) {
                    HomeView(store: store).routeDestinations()
                }
            }
            Tab("Chat", systemImage: "bubble.left", value: AppTab.chat) {
                ChatTab()
            }
            Tab("Library", systemImage: "books.vertical", value: AppTab.library) {
                NavigationStack(path: $router.libraryPath) {
                    LibraryView().routeDestinations()
                }
            }
            Tab("Memory", systemImage: "bookmark", value: AppTab.memory) {
                NavigationStack(path: $router.memoryPath) {
                    MemoryView(store: store).routeDestinations()
                }
            }
            Tab(value: AppTab.search, role: .search) {
                NavigationStack(path: $router.searchPath) {
                    SearchView(store: store).routeDestinations()
                }
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .tabViewSidebarHeader {
            HStack(spacing: 10) {
                MothAvatar(size: 28)
                Text("Psyche").psycheTitle(.title3)
            }
            .padding(.vertical, 4)
        }
        .tint(PsycheColor.inkText)
        .syncsShareInbox(store: store)
        #if DEBUG
        .task { await router.openForScreenshot(store: store) }
        #endif
        .sheet(item: $router.sheet) { sheet in
            switch sheet {
            case .approval(let item):
                if let detail = item.approval {
                    ApprovalSheet(item: item, detail: detail)
                }
            case .question(let item):
                if let detail = item.question {
                    QuestionSheet(item: item, detail: detail)
                }
            case .agent:
                AgentSheet(store: store)
            }
        }
    }
}
