import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

@MainActor
struct ChatThreadActionsModelTests {
    @Test func aRefusedAnswerUnmarksTheChosenOptionAndShowsTheError() async throws {
        let store = FixtureBackend()
        await store.failNextAnswer(with: "That question is closed.")
        let model = ThreadModel(id: "thr_1", store: store)
        model.choose(option: "yes", for: "q_closed")
        #expect(model.chosen["q_closed"] == "yes")
        for _ in 0..<200 where model.actionError == nil {
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(model.actionError == "That question is closed.")
        #expect(model.chosen["q_closed"] == nil)
        model.clearActionError()
        #expect(model.actionError == nil)
    }

    @Test func anAcceptedAnswerKeepsTheChosenOption() async throws {
        let store = FixtureBackend()
        let needsYou = try #require(FixtureData.home.needsYou.first)
        let model = ThreadModel(id: "thr_1", store: store)
        model.choose(option: "yes", for: needsYou.id)
        try await Task.sleep(for: .milliseconds(100))
        #expect(model.actionError == nil)
        #expect(model.chosen[needsYou.id] == "yes")
    }

    @Test func renameTrimsTheTitleAndTheListShowsIt() async throws {
        let store = FixtureBackend()
        let model = ThreadListModel(store: store)
        await model.load()
        let side = try #require(model.phase.value?.first { !$0.isMain })
        await model.rename(side, to: "  Trip plans  ")
        #expect(model.phase.value?.first { $0.id == side.id }?.title == "Trip plans")
        #expect(model.actionError == nil)
    }

    @Test func aBlankRenameDoesNothing() async throws {
        let store = FixtureBackend()
        let model = ThreadListModel(store: store)
        await model.load()
        let side = try #require(model.phase.value?.first { !$0.isMain })
        await model.rename(side, to: "   ")
        #expect(model.phase.value?.first { $0.id == side.id }?.title == side.title)
    }

    @Test func exportPresentsTheMarkdownUntilItIsCleared() async throws {
        let store = FixtureBackend()
        let model = ThreadListModel(store: store)
        await model.load()
        let side = try #require(model.phase.value?.first { !$0.isMain })
        await model.export(side)
        let exported = try #require(model.exported)
        #expect(exported.id == side.id)
        #expect(exported.markdown.hasPrefix("# \(side.title)"))
        model.clearExport()
        #expect(model.exported == nil)
    }

    @Test func deleteRemovesTheRowFromTheList() async throws {
        let store = FixtureBackend()
        let model = ThreadListModel(store: store)
        await model.load()
        let side = try #require(model.phase.value?.first { !$0.isMain })
        await model.delete(side)
        #expect(model.phase.value?.contains { $0.id == side.id } == false)
        #expect(model.actionError == nil)
        #expect(try await store.threads().contains { $0.id == side.id } == false)
    }
}
