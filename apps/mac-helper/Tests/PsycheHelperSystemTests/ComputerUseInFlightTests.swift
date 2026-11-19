import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import Testing

@Suite("a running action keeps the session and its taps (review 1402)")
struct ComputerUseInFlightTests {
    @Test func theActionScopeMarksTheSessionInFlightUntilItEnds() throws {
        let installer = FakeTapInstaller()
        let cu = makeComputerUse(installer: installer)
        let scope = InvocationScope()
        try InvocationScope.$current.withValue(scope) { try cu.beginAction(session: "run-1") }
        #expect(scope.session == "run-1")
        cu.taps.release("run-1")  // end_session mid-action
        #expect(cu.taps.isInstalled)
        cu.endInvocation(scope)
        #expect(!cu.taps.isInstalled)
        #expect(scope.session == nil)
    }

    @Test func aSecondBeginActionInTheSameInvocationCountsOnce() throws {
        let installer = FakeTapInstaller()
        let cu = makeComputerUse(installer: installer)
        let scope = InvocationScope()
        try InvocationScope.$current.withValue(scope) {
            try cu.beginAction(session: "run-1")
            try cu.beginAction(session: "run-1")
        }
        cu.taps.release("run-1")
        cu.endInvocation(scope)
        #expect(!cu.taps.isInstalled)
    }
}
