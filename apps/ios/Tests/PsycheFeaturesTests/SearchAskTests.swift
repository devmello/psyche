import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

/// Typing searches; it does not spend the model budget. A question is asked on Return or after a pause, once.
@MainActor
struct SearchAskTests {
    private func model(_ store: FixtureBackend, _ text: String) async -> SearchModel {
        let model = SearchModel(store: store)
        model.query = text
        await model.run()
        return model
    }

    @Test func typingAsksNothing() async {
        let store = FixtureBackend()
        let model = SearchModel(store: store)
        for text in ["w", "wh", "when is", "when is rent", "when is rent due?"] {
            model.query = text
            await model.run()
        }
        #expect(await store.lifeAnswerCalls == 0)
        #expect(model.results.canAskLife)
        #expect(model.shownAnswer == nil)
    }

    @Test func aQuestionIsAskedOncePerNormalisedQuestion() async {
        let store = FixtureBackend()
        let model = await model(store, "When is rent due?")
        await model.ask()
        await model.ask()
        #expect(await store.lifeAnswerCalls == 1)
        #expect(model.shownAnswer != nil)
        // Case, spacing and the closing mark are not a new question, even after other text in between.
        model.query = "when  is rent   due"
        await model.run()
        await model.ask()
        model.query = "rent"
        await model.run()
        model.query = "WHEN IS RENT DUE??"
        await model.run()
        await model.ask()
        #expect(await store.lifeAnswerCalls == 1)
        #expect(model.shownAnswer != nil)
    }

    @Test func aTextThatIsNotAQuestionIsNeverAsked() async {
        let store = FixtureBackend()
        let model = await model(store, "sam")
        await model.ask()
        #expect(await store.lifeAnswerCalls == 0)
    }

    @Test func aSpentBudgetShowsTheSlowDownTextAndIsNotCached() async {
        let store = FixtureBackend()
        await store.failLifeAnswers(with: .slowDown(minutes: 3))
        let model = await model(store, "When is rent due?")
        await model.ask()
        #expect(model.askFailure?.contains("3") == true)
        #expect(model.shownAnswer == nil)
        // Once the budget has room, asking again works (a refusal is not remembered as an answer).
        await store.failLifeAnswers(with: nil)
        await model.ask()
        #expect(model.askFailure == nil)
        #expect(model.shownAnswer != nil)
        #expect(await store.lifeAnswerCalls == 2)
    }

    @Test func normalisingIgnoresCaseSpacingAndTheClosingMark() {
        #expect(SearchModel.normalised("  When is   Rent due?! ") == "when is rent due")
        #expect(SearchModel.normalised("when is rent due") == "when is rent due")
        #expect(SearchModel.normalised("when is rent due today") != "when is rent due")
    }
}

@MainActor
struct SearchAskNoHitsTests {
    @Test func aQuestionWithNoHitsStillShowsItsAnswerAfterAsking() async {
        let store = FixtureBackend()
        await store.hideSearchHits(true)
        let model = SearchModel(store: store)
        model.query = "When is rent due?"
        await model.run()
        #expect(model.results.hits.isEmpty)
        // Not "No results": the answer card is the result.
        #expect(model.hasAnything)
        await model.ask()
        #expect(model.shownAnswer != nil)
        #expect(model.hasAnything)
    }

    @Test func plainTextWithNoHitsIsStillNoResults() async {
        let store = FixtureBackend()
        await store.hideSearchHits(true)
        let model = SearchModel(store: store)
        model.query = "sam"
        await model.run()
        #expect(!model.hasAnything)
    }
}
