import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

/// The backend `-psycheScenario live` runs (`AppModel.fixtures` uses `FixtureBackend.shared`): the Home Spaces section
/// must load its Spaces, Suggested group and Archived group from it, or the section stays hidden.
@MainActor
struct SpacesLiveScenarioTests {
    @Test func theLiveScenarioBackendLoadsEverythingTheHomeSectionShows() async {
        let list = SpacesListModel(store: FixtureBackend.shared)
        await list.load()
        #expect(list.spaces.map(\.id).contains("spc_kitchen"))
        #expect(list.spaces.allSatisfy { !$0.archived })
        #expect(list.archived.map(\.id) == ["spc_house"])
        #expect(list.proposals.map(\.id) == ["prp_lisbon"])
    }
}
