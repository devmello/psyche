import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

/// Search is plain search: typing finds matches and never asks a model. Asking is the "Ask Psyche" row (Chat).
@MainActor
struct SearchAskTests {
    @Test func typingFindsMatches() async {
        let model = SearchModel(store: FixtureBackend())
        for text in ["r", "re", "rent"] {
            model.query = text
            await model.run()
        }
        #expect(model.phase == .done)
        #expect(model.hasHits)
        #expect(model.results.hits.contains { $0.title == "Pay rent for November" })
    }

    @Test func aQuestionSearchesItsWords() async {
        let model = SearchModel(store: FixtureBackend())
        model.query = "when is rent due"
        await model.run()
        #expect(model.hasHits)
    }

    @Test func nothingMatchingIsEmptyNotFailed() async {
        let model = SearchModel(store: FixtureBackend())
        model.query = "zzzzqq"
        await model.run()
        #expect(model.phase == .done)
        #expect(!model.hasHits)
    }

    @Test func clearingTheQueryClearsTheResults() async {
        let model = SearchModel(store: FixtureBackend())
        model.query = "rent"
        await model.run()
        #expect(model.hasHits)
        model.query = "  "
        await model.run()
        #expect(model.phase == .idle)
        #expect(!model.hasHits)
    }

    @Test func noHitsIsAnEmptyResultNotAFailure() async {
        let store = FixtureBackend()
        await store.hideSearchHits(true)
        let model = SearchModel(store: store)
        model.query = "rent"
        await model.run()
        #expect(model.phase == .done && !model.hasHits)
    }
}
