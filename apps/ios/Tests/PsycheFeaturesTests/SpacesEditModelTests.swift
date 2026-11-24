import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

@MainActor
struct SpacesEditModelTests {
    @Test func archivingHidesASpaceFromTheListAndRestoringBringsItBack() async throws {
        let store = FixtureBackend()
        let model = SpaceModel(id: "spc_kitchen", store: store)
        await model.load()
        #expect(await model.setArchived(true))
        #expect(try await store.spaces().map(\.id) == ["spc_taxes"])
        #expect(try await store.archivedSpaces().map(\.id).contains("spc_kitchen"))
        #expect(model.phase.value?.space.archived == true)

        #expect(await model.setArchived(false))
        #expect(try await store.spaces().map(\.id).contains("spc_kitchen"))
        #expect(model.phase.value?.space.archived == false)
    }

    @Test func archivedSpacesAreListedApartFromTheSuggestions() async {
        let list = SpacesListModel(store: FixtureBackend())
        await list.load()
        #expect(list.spaces.map(\.id) == ["spc_kitchen", "spc_taxes"])
        #expect(list.archived.map(\.id) == ["spc_house"])
        #expect(list.proposals.map(\.id) == ["prp_lisbon"])
    }

    @Test func aSuggestionCreatesASpaceOnceAndLeavesTheList() async throws {
        let store = FixtureBackend()
        let list = SpacesListModel(store: store)
        await list.load()
        let proposal = try #require(list.proposals.first)
        let id = try #require(await list.accept(proposal))
        #expect(id == "spc_prp_lisbon")
        #expect(list.proposals.isEmpty)
        #expect(list.spaces.map(\.id).contains(id))
        #expect(try await store.spaceProposals().isEmpty)
    }

    @Test func dismissingASuggestionRemovesItWithoutCreatingASpace() async throws {
        let store = FixtureBackend()
        let list = SpacesListModel(store: store)
        await list.load()
        let proposal = try #require(list.proposals.first)
        await list.dismiss(proposal)
        #expect(list.proposals.isEmpty)
        #expect(try await store.spaces().map(\.id) == ["spc_kitchen", "spc_taxes"])
    }

    @Test func aTrackerIsAddedFromATemplateAndRemovedAfterwards() async throws {
        let model = SpaceModel(id: "spc_taxes", store: FixtureBackend())
        await model.load()
        #expect(model.phase.value?.trackers.isEmpty == true)
        #expect(await model.addTracker(.checklist))
        let added = try #require(model.phase.value?.trackers.first)
        await model.removeTracker(added)
        #expect(model.phase.value?.trackers.isEmpty == true)
        #expect(model.actionError == nil)
    }

    @Test func reorderingShowsTheNewOrderAndKeepsIt() async throws {
        let store = FixtureBackend()
        let model = SpaceModel(id: "spc_kitchen", store: store)
        await model.load(opening: true)
        await model.reorderTrackers(["wdg_bound", "wdg_progress"])
        #expect(model.phase.value?.trackers.map(\.widgetID) == ["wdg_bound", "wdg_progress"])
        #expect(model.actionError == nil)
    }

    @Test func aRefusedReorderRollsBackToTheShelfAsItWas() async {
        let model = SpaceModel(id: "spc_kitchen", store: FixtureBackend())
        await model.load(opening: true)
        // An id the shelf does not hold: the optimistic order drops it, the Gateway refuses, and the shelf returns.
        await model.reorderTrackers(["wdg_bound", "wdg_nope"])
        #expect(model.phase.value?.trackers.map(\.widgetID) == ["wdg_progress", "wdg_bound"])
        #expect(model.actionError != nil)
    }

    @Test func aLinkIsAddedAndRemovedOnTheSpace() async throws {
        let model = SpaceModel(id: "spc_taxes", store: FixtureBackend())
        await model.load()
        #expect(await model.addLink(url: "https://example.com/receipts", title: "Receipts"))
        let link = try #require(model.phase.value?.links.first)
        #expect(link.label == "Receipts")
        #expect(link.untrusted == false)
        await model.removeLink(link)
        #expect(model.phase.value?.links.isEmpty == true)
    }

    @Test func onlyHttpAndHttpsAddressesAreLinkable() {
        #expect(SpaceLinkAddress.parse("https://example.com/a") == "https://example.com/a")
        #expect(SpaceLinkAddress.parse("  http://example.com  ") == "http://example.com")
        #expect(SpaceLinkAddress.parse("HTTPS://Example.com") == "HTTPS://Example.com")
        #expect(SpaceLinkAddress.parse("example.com") == nil)
        #expect(SpaceLinkAddress.parse("ftp://example.com/file") == nil)
        #expect(SpaceLinkAddress.parse("javascript:alert(1)") == nil)
        #expect(SpaceLinkAddress.parse("https://") == nil)
        #expect(SpaceLinkAddress.parse("   ") == nil)
    }
}
