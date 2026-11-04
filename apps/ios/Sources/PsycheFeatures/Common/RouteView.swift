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
        case .project(let id): placeholder("Project", id)
        case .person(let id): placeholder("Person", id)
        case .file(let id): LibraryItemView(id: id)
        }
    }

    private func placeholder(_ kind: String, _ id: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(kind).psycheTitle()
            EvidenceLine([id])
            Text("Read-mostly on the phone. Edit on your Mac.")
                .font(.subheadline).foregroundStyle(PsycheColor.muted)
            Spacer()
        }
        .padding(PsycheMetrics.pagePadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .psycheScreen()
        .psycheInlineTitle()
    }
}
