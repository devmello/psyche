import PsycheStore
import PsycheDesign
import SwiftUI

/// Destinations for pushed routes. Thread pages live in Chat; person, project and file pages arrive with
/// I6 and I7, so they name what they will hold.
struct RouteView: View {
    let route: Route
    @Environment(\.backend) private var store

    var body: some View {
        switch route {
        case .thread(let id):
            ThreadView(id: id, store: store)
        case .project(let id): ProjectPage(id: id, store: store)
        case .person(let id): PersonPage(id: id, store: store)
        case .file(let id): LibraryItemView(id: id)
        case .memoryFiles: MemoryFilesView(store: store)
        case .memoryFile(let path): MemoryFileView(path: path, store: store)
        case .entity(let id): EntityRouteView(id: id, store: store)
        case .inbox: InboxView(store: store)
        case .scheduled: ScheduledView(store: store)
        case .overview: OverviewView(store: store)
        case .feed: FeedView(store: store)
        case .ideas: IdeasView(store: store)
        case .goals: GoalsView(store: store)
        case .space(let id): SpaceView(id: id, store: store)
        case .task: EmptyView()  // opens the agent sheet through the router, never pushed
        }
    }
}
