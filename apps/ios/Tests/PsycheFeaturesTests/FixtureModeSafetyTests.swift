import Testing

@testable import PsycheFeatures
@testable import PsycheStore

struct FixtureModeSafetyTests {
    /// "Try it without a Mac" and `-psycheScenario` run on made-up data: they must not drain the real share
    /// inbox or write the thread list the share sheet reads.
    @Test func fixtureModeNeverTouchesTheRealShareInbox() {
        #expect(!ShareInboxPolicy.touchesRealInbox(backend: FixtureBackend()))
    }
}
