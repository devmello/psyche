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
        case .claims: ClaimsView(store: store)
        case .entity(let id): EntityRouteView(id: id, store: store)
        case .inbox: InboxView(store: store)
        case .feedItem(let id): FeedItemView(id: id, store: store)
        case .scheduled: ScheduledView(store: store)
        case .space(let id): SpaceView(id: id, store: store)
        case .nightShift(let id): NightShiftReviewView(reviewID: id, store: store)
        case .task(let id): TaskRunView(store: store, taskID: id)
        case .tab, .settings: EmptyView()  // the router opens these, never pushed
        }
    }
}
