import Foundation
import PsycheStore
import Testing

@testable import PsycheFeatures

/// The learning screens' model over the demo backend: the lists load, writes reload them, and a note is only
/// saved when it has words in it.
@MainActor
struct LearningModelTests {
    private func model() -> LearningModel {
        LearningModel(store: FixtureBackend(latency: .zero))
    }

    @Test(arguments: [
        ("", false), ("   \n\t", false), ("Dentist on Friday", true), ("  Dentist  ", true),
        (String(repeating: "a", count: LearningModel.noteLimit), true),
        (String(repeating: "a", count: LearningModel.noteLimit + 1), false),
    ] as [(String, Bool)])
    func aNoteNeedsWordsAndFitsTheLimit(text: String, expected: Bool) {
        #expect(LearningModel.canRemember(text) == expected)
    }

    @Test func notNowHidesAClaimForThisSessionOnly() async {
        let model = model()
        await model.loadClaims()
        guard let claims = model.claims.value, let claim = claims.first else {
            Issue.record("no claims loaded")
            return
        }
        model.hideForNow(claim)
        #expect(model.shownClaims(claims).contains(claim) == false)
        #expect(model.shownClaims(claims).count == claims.count - 1)
        // Still waiting in the store: a reload shows it again in the unfiltered list.
        await model.loadClaims()
        #expect(model.claims.value?.contains(claim) == true)
    }

    @Test func confirmingAClaimRemovesItFromTheWaitingList() async {
        let model = model()
        await model.loadClaims()
        let before = model.claims.value?.count ?? 0
        guard let claim = model.claims.value?.first else {
            Issue.record("no claims loaded")
            return
        }
        await model.confirm(claim)
        #expect(model.claims.value?.count == before - 1)
    }

    @Test func aNoteIsSavedThroughTheBackend() async throws {
        let model = model()
        try await model.remember("  Dentist on Friday  ")
    }
}
