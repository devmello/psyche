import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

/// The local note and the routes for Night shift (docs/design/night-shift-2026.md §5.2): one note per review, saying
/// nothing of what is inside, opening the review on tap. There is no APNs: it is posted from a background check or a
/// foreground read, best effort.
@MainActor
struct NightShiftAlertsTests {
    @Test func theNoteIsOnePerReviewAndSaysNothingOfItsContents() async {
        let first = AlertPolicy.nightShiftReady(reviewID: "n1")
        let again = AlertPolicy.nightShiftReady(reviewID: "n1")
        #expect(first == again)
        #expect(first.id == "nightshift-n1")
        #expect(first.category == .review)
        #expect(first.route == "/home?review=n1")
        // Neither a summary nor a recipient reaches a lock screen.
        for item in FixtureData.nightShiftReview.items {
            #expect(!first.title.contains(item.summary) && !first.body.contains(item.summary))
        }
        // The ledger claims an id once: the second background check posts nothing.
        let ledger = NotifiedLedger(directory: nil)
        #expect(await ledger.claim(first.id))
        #expect(await !ledger.claim(AlertPolicy.nightShiftReady(reviewID: "n1").id))
        // A new review is a new note.
        #expect(await ledger.claim(AlertPolicy.nightShiftReady(reviewID: "n2").id))
    }

    @Test func theReviewCategoryHasNoButtonsAndIsNotWaitingOnTheOwnerAsAnApproval() {
        #expect(AlertPolicy.actions(for: .review).isEmpty)
        #expect(!AlertPolicy.isWaitingOnOwner(.review))
        #expect(AlertCategory(rawValue: "psyche.review") == .review)
    }

    @Test func theReviewRouteParsesAndOpensTheReviewOnHome() {
        #expect(Route(appPath: "/home?review=n1") == .nightShift(id: "n1"))
        // A plain /home, and an empty or missing review id, still open Home.
        #expect(Route(appPath: "/home") == .tab(.home))
        #expect(Route(appPath: "/home?review=") == .tab(.home))
        #expect(Route(appPath: "/home?other=1") == .tab(.home))
        let router = Router()
        router.open(appPath: "/home?review=n1")
        #expect(router.tab == .home)
        #expect(router.homePath == [.nightShift(id: "n1")])
    }

    @Test func theStatusThePhoneReadsDrivesTheCard() async throws {
        let model = NightShiftCardModel(store: FixtureBackend())
        await model.load()
        #expect(model.reviewID == FixtureData.nightShiftReviewID)
        #expect(model.status?.counts == NightShiftCounts(mail: 3, calendar: 1, reminders: 2, files: 1))
        // The first lines are ready items only (the stale one is not offered), at most three.
        #expect(model.firstLines.count == 3)
        #expect(!model.firstLines.contains("Add the design review"))
    }

    @Test func theCardIsGoneOnceTheReviewIsDismissed() async throws {
        let store = FixtureBackend()
        let model = NightShiftCardModel(store: store)
        await model.load()
        try await store.dismissNightShift(reviewID: FixtureData.nightShiftReviewID, itemIDs: nil)
        await model.load()
        #expect(model.reviewID == nil)
        #expect(model.firstLines.isEmpty)
    }
}
