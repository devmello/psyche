import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

@MainActor
struct SpacesModelTests {
    @Test func spaceRoutesMapAndSpaceHeadIsNotAGoal() {
        #expect(Route(appPath: "/spaces/spc_kitchen") == .space(id: "spc_kitchen"))
        #expect(Route(appPath: "/spaces") == nil)
    }

    @Test func homeListShowsTheSpacesWithLiveCounts() async throws {
        let store = FixtureBackend()
        let model = SpacesListModel(store: store)
        await model.load()
        #expect(model.spaces.map(\.id) == ["spc_kitchen", "spc_taxes"])
        #expect(model.spaces[0].trackers == 2 && model.spaces[0].chats == 0)
        _ = try await store.newThread(inSpace: "spc_kitchen")
        await model.load()
        #expect(model.spaces[0].chats == 1)
    }

    @Test func aNewChatIsInNoSpaceUnlessTheOwnerChoseOne() async throws {
        let store = FixtureBackend()
        let menu = SpaceMenuModel(store: store)
        await menu.load()
        #expect(menu.target == nil)
        let plain = try #require(await menu.newChat())
        #expect(try await store.threads().first { $0.id == plain }?.spaceID == nil)

        menu.choose("spc_taxes")
        let inSpace = try #require(await menu.newChat())
        #expect(try await store.threads().first { $0.id == inSpace }?.spaceID == "spc_taxes")
        #expect(menu.targetName == "Taxes 2026")

        menu.choose(nil)
        let again = try #require(await menu.newChat())
        #expect(try await store.threads().first { $0.id == again }?.spaceID == nil)
    }

    @Test func aTargetThatWentAwayIsForgotten() async {
        let store = FixtureBackend()
        let menu = SpaceMenuModel(store: store)
        menu.choose("spc_gone")
        await menu.load()
        #expect(menu.target == nil)
    }

    @Test func movingAChatInAndOutUpdatesTheSpacesChats() async throws {
        let store = FixtureBackend()
        let menu = SpaceMenuModel(store: store)
        let thread = try #require(try await store.threads().first { !$0.isMain })
        await menu.move(thread, to: "spc_kitchen")
        #expect(try await store.spaceThreads(id: "spc_kitchen").map(\.id) == [thread.id])
        await menu.move(thread, to: nil)
        #expect(try await store.spaceThreads(id: "spc_kitchen").isEmpty)
        // The main thread never moves, and an unknown Space is refused with a message.
        let main = try #require(try await store.threads().first { $0.isMain })
        await menu.move(main, to: "spc_kitchen")
        #expect(menu.actionError != nil)
    }

    @Test func openingASpaceLoadsTrackersWidgetsAndRefreshStampsTheTime() async throws {
        let store = FixtureBackend()
        let model = SpaceModel(id: "spc_kitchen", store: store)
        await model.load(opening: true)
        let detail = try #require(model.phase.value)
        #expect(detail.trackers.map(\.widgetID) == ["wdg_progress", "wdg_bound"])
        #expect(model.widgets.keys.sorted() == ["wdg_bound", "wdg_progress"])
        #expect(model.status["wdg_progress"] != nil)

        // A bound tracker follows its task and has no Refresh; a query tracker does.
        await model.refresh(detail.trackers[1])
        #expect(model.status["wdg_bound"] == nil)
        await model.refresh(detail.trackers[0])
        #expect(model.status["wdg_progress"]?.refreshedAt != nil)
    }

    @Test func savingInstructionsReloadsThem() async throws {
        let model = SpaceModel(id: "spc_taxes", store: FixtureBackend())
        await model.load()
        #expect(model.phase.value?.instructions == "")
        #expect(await model.saveInstructions("File by April."))
        #expect(model.phase.value?.instructions == "File by April.")
    }

    @Test func aMissingSpaceFailsTheLoadWithAMessage() async {
        let model = SpaceModel(id: "spc_nope", store: FixtureBackend())
        await model.load()
        if case .failed = model.phase {} else { Issue.record("expected a failed phase") }
    }

    @Test func trackerLineSaysWhenItIsStaleOrGone() {
        let tracker = SpaceTrackerItem(widgetID: "w", kind: .query)
        #expect(SpacesText.trackerLine(tracker, nil).isEmpty)
        #expect(SpacesText.trackerLine(tracker, SpaceTrackerStatus(widgetID: "w", stale: true)).count == 1)
        #expect(SpacesText.trackerLine(tracker, SpaceTrackerStatus(widgetID: "w", stale: true, unavailable: true)).count == 1)
    }
}
