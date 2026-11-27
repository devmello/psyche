import Foundation
import Observation
import PsycheStore

/// What is presented over the tabs.
enum AppSheet: Identifiable {
    case approval(NeedsYouItem)
    case question(NeedsYouItem)
    case settings

    var id: String {
        switch self {
        case .settings: "settings"
        case .approval(let item): "approval-\(item.id)"
        case .question(let item): "question-\(item.id)"
        }
    }
}

/// Selection and navigation state for the whole shell: one typed path per tab.
@MainActor @Observable
public final class Router {
    public var tab: AppTab = .home
    public var homePath: [Route] = []
    public var libraryPath: [Route] = []
    public var memoryPath: [Route] = []
    public var searchPath: [Route] = []
    /// Chat's detail column has its own stack; the thread list drives `selectedThread`.
    public var chatPath: [Route] = []
    public var selectedThread: String?
    var sheet: AppSheet?
    /// A to-do to show in Memory (set by a Search hit); Memory scrolls to it and clears this.
    public var memoryFocusTodo: String?
    /// Set by "Ask Psyche anything" on Home; the thread consumes it and focuses the composer.
    var pendingDraft: String?
    /// An open held back until the sheet that asked for it has finished dismissing (see `deferOpen`).
    private(set) var deferredOpen: DeferredOpen?

    /// A route or a Needs-you item to open once the presenting sheet has gone. Held by `deferOpen`, run by
    /// `runDeferredOpen`.
    enum DeferredOpen {
        case appPath(String)
        case item(NeedsYouItem)
    }

    public init() {
        #if DEBUG
        // Screenshots and demos: `-psycheTab library` and `-psycheOpen library/lib_91c0` on the launch line.
        // Screenshots without taps: simctl launch ... -psycheTab memory -psycheSheet settings
        let defaults = UserDefaults.standard
        switch defaults.string(forKey: "psycheTab") {
        case "chat": tab = .chat
        case "library": tab = .library
        case "memory": tab = .memory
        case "search": tab = .search
        default: break
        }
        if defaults.string(forKey: "psycheSheet") == "settings" { sheet = .settings }
        // -psycheRoute people/pe1 opens that page in People.
        if let path = defaults.string(forKey: "psycheRoute"), let route = Route(appPath: path) {
            tab = .memory
            memoryPath = [route]
        }
        // Queued, not applied: the root view applies it once, after its first layout (`applyQueuedLaunchRoute`).
        queuedLaunchRoute = defaults.string(forKey: "psycheOpen")
        #endif
    }

    #if DEBUG
    /// `-psycheOpen <path>` from the launch line, waiting for the root view. Applied once, then cleared.
    var queuedLaunchRoute: String?

    /// The single place the DEBUG launch route is applied. The root view calls it once after its first layout, so a
    /// route can't be applied before the tabs exist, or twice.
    func applyQueuedLaunchRoute() {
        guard let path = queuedLaunchRoute else { return }
        queuedLaunchRoute = nil
        open(appPath: path)
    }
    #endif

    /// Home's Ask field: open the main thread with the composer focused.
    func askPsyche(_ text: String) {
        pendingDraft = text
        selectedThread = FixtureData.mainThreadID
        tab = .chat
    }

    /// The thread a running task belongs to. Fixture mapping until the snapshot carries it (I5).
    func runningThread(for taskID: String) -> String? {
        taskID == "task_q3" ? "thr_q3" : nil
    }

    /// Search hits: a to-do opens Memory's To-do list; a file opens its Library page; a person opens theirs.
    func openTodo(_ id: String) {
        memoryPath = []
        memoryFocusTodo = id
        tab = .memory
    }

    func openFile(_ id: String) {
        libraryPath = [.file(id: id)]
        tab = .library
    }

    func openPerson(_ id: String) {
        memoryPath = [.person(id: id)]
        tab = .memory
    }

    func openProject(_ id: String) {
        memoryPath = [.project(id: id)]
        tab = .memory
    }

    /// A task hit, a Live Activity tap or a task link opens that task's run page, pushed on Home.
    func openTask(_ id: String) {
        sheet = nil
        tab = .home
        homePath = [.task(id: id)]
    }

    /// Holds an open until the sheet that is going away calls `runDeferredOpen` from its `onDismiss`. SwiftUI drops a
    /// presentation started while another sheet is still dismissing, so a sheet that dismisses and then opens one
    /// must not open it in the same pass (the payment approval handoff went missing that way).
    func deferOpen(appPath: String) {
        deferredOpen = .appPath(appPath)
    }

    func deferOpen(_ item: NeedsYouItem) {
        deferredOpen = .item(item)
    }

    /// Runs the held open, if any. Call it from the `onDismiss` of the sheet that deferred it.
    func runDeferredOpen() {
        guard let pending = deferredOpen else { return }
        deferredOpen = nil
        switch pending {
        case .appPath(let path): open(appPath: path)
        case .item(let item): open(item)
        }
    }

    /// Opens what a Needs-you item asks for: the approval or question sheet, or the thread for a task.
    func open(_ item: NeedsYouItem) {
        if item.approval != nil {
            sheet = .approval(item)
        } else if item.question != nil {
            sheet = .question(item)
        } else if let thread = item.threadID {
            openThread(thread)
        }
    }

    /// The Plans view of one fork, pushed over its chat. From the fork card the chat is already open and the view is pushed
    /// on top; from a link, the chat opens first. A view already on top is not pushed twice.
    func showPlanFork(threadID: String, forkID: String) {
        sheet = nil
        if selectedThread != threadID {
            selectedThread = threadID
            chatPath = []
        }
        tab = .chat
        let route = Route.planFork(threadID: threadID, forkID: forkID)
        if chatPath.last != route { chatPath.append(route) }
    }

    func openThread(_ id: String) {
        sheet = nil
        selectedThread = id
        tab = .chat
    }

    /// A notification route or deep link: unknown routes open Home. Any settings or approval sheet still up is
    /// dismissed first, so the tap is what the owner sees.
    public func open(appPath: String) {
        sheet = nil
        guard let route = Route(appPath: appPath) else {
            tab = .home
            homePath = []  // an unknown route lands on Home itself, not on whatever page was pushed there
            return
        }
        switch route {
        case .thread(let id): openThread(id)
        case .planFork(let threadID, let forkID): showPlanFork(threadID: threadID, forkID: forkID)
        case .project, .person, .entity, .claims: tab = .memory; memoryPath = [route]
        case .file, .artifact: tab = .library; libraryPath = [route]
        case .inbox, .scheduled, .space, .nightShift, .feedItem: tab = .home; homePath = [route]
        case .task(let id): openTask(id)
        case .tab(let root):
            tab = root
            if root == .home { homePath = [] }  // `/agent/approvals`: Home, where Needs you lists them
        case .settings: sheet = .settings
        }
    }
}

#if DEBUG
extension Router {
    /// `simctl launch … -psycheOpen approval|question|inbox|scheduled` opens that screen at launch,
    /// for screenshots and demos in the simulator (which can't be tapped headlessly). Debug builds only.
    func openForScreenshot(store: any PsycheBackend) async {
        guard let name = UserDefaults.standard.string(forKey: "psycheOpen") else { return }
        let items = (try? await store.home())?.needsYou ?? []
        switch name {
        case "approval": sheet = items.first { $0.approval != nil }.map { .approval($0) }
        case "question": sheet = items.first { $0.question != nil }.map { .question($0) }
        default: break  // a route: applied once by `applyQueuedLaunchRoute`, never here
        }
    }
}
#endif
