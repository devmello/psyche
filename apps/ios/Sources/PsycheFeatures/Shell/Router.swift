import Foundation
import Observation
import PsycheStore

/// What is presented over the tabs.
enum AppSheet: Identifiable {
    case approval(NeedsYouItem)
    case agent
    case settings

    var id: String {
        switch self {
        case .settings: "settings"
        case .approval(let item): "approval-\(item.id)"
        case .agent: "agent"
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

    public init() {}

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

    func openThread(_ id: String) {
        selectedThread = id
        tab = .chat
    }

    /// A notification route or deep link: unknown routes open Home.
    public func open(appPath: String) {
        guard let route = Route(appPath: appPath) else {
            tab = .home
            return
        }
        switch route {
        case .thread(let id): openThread(id)
        case .project, .person: tab = .memory; memoryPath = [route]
        case .file: tab = .library; libraryPath = [route]
        }
    }
}
