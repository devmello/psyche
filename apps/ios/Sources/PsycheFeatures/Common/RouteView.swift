import PsycheStore
import PsycheDesign
import SwiftUI

/// Destinations for pushed routes. Thread pages live in Chat; person, project and file pages arrive with
/// I6 and I7, so they name what they will hold.
struct RouteView: View {
    let route: Route
    @Environment(\.backend) private var store

    var body: some View {
        // One identity per route: when a stack's only entry is replaced (a source chip opening another file
        // while the Library already shows one), the page must start fresh, not keep the old page's state.
        page.id(route)
    }

    @ViewBuilder private var page: some View {
        switch route {
        case .thread(let id):
            ThreadView(id: id, store: store)
        case .planFork(_, let forkID): PlanForkView(forkID: forkID, store: store)
        case .project(let id): ProjectPage(id: id, store: store)
        case .person(let id): PersonPage(id: id, store: store)
        case .file(let id): LibraryItemView(id: id)
        case .artifact(let id): ArtifactViewerView(artifactID: id)
        case .memoryFiles: MemoryFilesView(store: store)
        case .learning: LessonsView(store: store)
        case .claims: ClaimsView(store: store)
        case .recentChanges: RecentChangesView(store: store)
        case .reviewQueue: HeldBackView(store: store)
        case .memoryFile(let path): MemoryFileView(path: path, store: store)
        case .entity(let id): EntityRouteView(id: id, store: store)
        case .inbox: InboxView(store: store)
        case .scheduled: ScheduledView(store: store)
        case .overview: OverviewView(store: store)
        case .feed: FeedView(store: store)
        case .ideas: IdeasView(store: store)
        case .goals: GoalsView(store: store)
        case .goal(let id): GoalsView(store: store, openGoalID: id)
        case .feedPost(let id): FeedView(store: store, focusPostID: id)
        case .space(let id): SpaceView(id: id, store: store)
        case .nightShift(let id): NightShiftReviewView(reviewID: id, store: store)
        case .task, .agentApprovals, .tab, .settings: EmptyView()  // the router opens these, never pushed
        }
    }
}
