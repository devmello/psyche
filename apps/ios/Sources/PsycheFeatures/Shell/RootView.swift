import PsycheBlocks
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
        // Generative-UI widgets (chat blocks and Home's Pinned section): same backend, and the host's
        // routes and composer for the actions that leave a widget.
        .environment(\.widgetBackend, store)
        .environment(
            \.widgetHandlers,
            WidgetHandlers(
                openRoute: { [router] path in
                    guard Route(appPath: path) != nil else { return false }
                    router.open(appPath: path)
                    return true
                },
                prefillReply: { [router] text in router.askPsyche(text) }))
        // psyche://<route> only, never a Gateway URL or key (docs/design/ios-app-2026.md §4).
        #if DEBUG
        // `simctl launch … -psycheOpen /chat/thr_q3` opens a route without a tap (screenshots, demos).
        .task {
            if let path = UserDefaults.standard.string(forKey: "psycheOpen") { router.open(appPath: path) }
        }
        #endif
        .onOpenURL { url in
            guard url.scheme == "psyche", let host = url.host else { return }
            router.open(appPath: "/" + host + url.path)
        }
        .animation(.default, value: session.state.needsPairing)
    }
}

struct MainTabs: View {
    let store: any PsycheBackend
    @Environment(Router.self) private var router

    /// Outline symbols on inactive tabs and a filled one on the selected tab. The system would otherwise fill them all,
    /// so the symbol variant is pinned and the filled name is chosen here.
    private func tabLabel(_ title: String, symbol: String, tab: AppTab) -> some View {
        Label {
            Text(title)
        } icon: {
            Image(systemName: router.tab == tab ? symbol + ".fill" : symbol)
        }
        .environment(\.symbolVariants, .none)
    }

    var body: some View {
        @Bindable var router = router
        TabView(selection: $router.tab) {
            Tab(value: AppTab.home) {
                NavigationStack(path: $router.homePath) {
                    HomeView(store: store).routeDestinations()
                }
            } label: {
                tabLabel("Home", symbol: "house", tab: .home)
            }
            Tab(value: AppTab.chat) {
                ChatTab()
            } label: {
                tabLabel("Chat", symbol: "bubble.left", tab: .chat)
            }
            Tab(value: AppTab.library) {
                NavigationStack(path: $router.libraryPath) {
                    LibraryView().routeDestinations()
                }
            } label: {
                tabLabel("Library", symbol: "books.vertical", tab: .library)
            }
            Tab(value: AppTab.memory) {
                NavigationStack(path: $router.memoryPath) {
                    MemoryView(store: store).routeDestinations()
                }
            } label: {
                tabLabel("Memory", symbol: "bookmark", tab: .memory)
            }
            Tab(value: AppTab.search, role: .search) {
                NavigationStack(path: $router.searchPath) {
                    SearchView(store: store).routeDestinations()
                }
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        // The outline variant holds from the first frame: pinned on the TabView itself, so the tab bar never
        // gets a first render in the system's automatic filled variant (seen right after pairing).
        .environment(\.symbolVariants, .none)
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
            case .settings:
                SettingsSheet(store: store)
            }
        }
    }
}
