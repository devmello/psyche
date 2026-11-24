import Foundation
import PsycheStore
import Testing

@testable import PsycheFeatures

/// The merge navigation decision and the split rules, as pure functions: no view, no backend.
struct PeopleActionsTests {
    @Test func aMergeThatKeepsTheCurrentPersonStaysOnThePage() {
        #expect(PersonMergeNavigation.decide(current: "pe1", survivor: "pe1") == .stay)
    }

    @Test func aMergeThatNamesAnotherSurvivorReplacesThePage() {
        #expect(PersonMergeNavigation.decide(current: "pe1", survivor: "pe9") == .replace(with: "pe9"))
    }

    @Test func aBlankSurvivorNeverNavigates() {
        #expect(PersonMergeNavigation.decide(current: "pe1", survivor: "  ") == .stay)
        #expect(PersonMergeNavigation.decide(current: "pe1", survivor: "") == .stay)
    }

    private let email = EntityIdentifier(kind: "email", value: "sam@example.com")
    private let phone = EntityIdentifier(kind: "phone", value: "+1 555 0142")

    @Test func aSplitNeedsTwoDetailsSomePickedAndNotAllOfThem() {
        #expect(PersonSplitRules.canSplit(held: [email, phone], picked: [phone], name: "Sam O.", saving: false))
    }

    @Test func aSplitIsOffWhileDetailsLoadOrForOnlyOneDetail() {
        #expect(!PersonSplitRules.canSplit(held: nil, picked: [phone], name: "Sam", saving: false))
        #expect(!PersonSplitRules.canSplit(held: [email], picked: [email], name: "Sam", saving: false))
    }

    @Test func aSplitMustKeepOneDetailHereAndMoveAtLeastOne() {
        #expect(!PersonSplitRules.canSplit(held: [email, phone], picked: [], name: "Sam", saving: false))
        #expect(!PersonSplitRules.canSplit(held: [email, phone], picked: [email, phone], name: "Sam", saving: false))
    }

    @Test func aSplitNeedsANameAndIsOffWhileSaving() {
        #expect(!PersonSplitRules.canSplit(held: [email, phone], picked: [phone], name: "   ", saving: false))
        #expect(!PersonSplitRules.canSplit(held: [email, phone], picked: [phone], name: "Sam", saving: true))
    }
}
