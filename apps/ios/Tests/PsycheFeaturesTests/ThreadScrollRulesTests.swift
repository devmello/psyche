import Testing

@testable import PsycheFeatures

struct ThreadScrollRulesTests {
    @Test func contentGrowingUnderANonScrollingReaderKeepsThePin() {
        #expect(ThreadScrollRules.pinned(true, reading: false, nearBottom: false) == true)
    }

    @Test func aReaderWhoDragsAwayFromTheBottomUnpins() {
        #expect(ThreadScrollRules.pinned(true, reading: true, nearBottom: false) == false)
    }

    @Test func arrivingAtTheBottomAlwaysPins() {
        #expect(ThreadScrollRules.pinned(false, reading: false, nearBottom: true) == true)
        #expect(ThreadScrollRules.pinned(false, reading: true, nearBottom: true) == true)
    }

    @Test func aReaderWhoIsUpStaysUnpinnedWhileNotScrolling() {
        #expect(ThreadScrollRules.pinned(false, reading: false, nearBottom: false) == false)
    }

    @Test func olderMessagesLoadOnlyForAnUnpinnedReaderAtTheTop() {
        #expect(ThreadScrollRules.shouldLoadOlder(nearTop: true, pinned: false, hasOlder: true, loading: false))
        // A reader pinned at the bottom never loads older on open, even at the top of a short layout pass.
        #expect(!ThreadScrollRules.shouldLoadOlder(nearTop: true, pinned: true, hasOlder: true, loading: false))
        #expect(!ThreadScrollRules.shouldLoadOlder(nearTop: false, pinned: false, hasOlder: true, loading: false))
        #expect(!ThreadScrollRules.shouldLoadOlder(nearTop: true, pinned: false, hasOlder: false, loading: false))
        #expect(!ThreadScrollRules.shouldLoadOlder(nearTop: true, pinned: false, hasOlder: true, loading: true))
    }
}
