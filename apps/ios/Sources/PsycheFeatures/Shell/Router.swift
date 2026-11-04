import Foundation
import Observation
import PsycheStore

/// What is presented over the tabs.
enum AppSheet: Identifiable {
    case approval(NeedsYouItem)
    case question(NeedsYouItem)
    case agent

    var id: String {
        switch self {
        case .approval(let item): "approval-\(item.id)"
        case .question(let item): "question-\(item.id)"
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
        case .inbox, .scheduled, .overview: tab = .home; homePath = [route]
        }
    }
}

#if DEBUG
extension Router {
    /// `simctl launch … -psycheOpen approval|question|agent|inbox|scheduled|overview` opens that screen at launch,
    /// for screenshots and demos in the simulator (which can't be tapped headlessly). Debug builds only.
    func openForScreenshot(store: any PsycheBackend) async {
        guard let name = UserDefaults.standard.string(forKey: "psycheOpen") else { return }
        let items = (try? await store.home())?.needsYou ?? []
        switch name {
        case "approval": sheet = items.first { $0.approval != nil }.map { .approval($0) }
        case "question": sheet = items.first { $0.question != nil }.map { .question($0) }
        case "agent": sheet = .agent
        default: open(appPath: "/" + name)
        }
    }
}
#endif
