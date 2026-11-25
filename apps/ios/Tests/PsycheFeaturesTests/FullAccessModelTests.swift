import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

/// The Full access toggle and bar on the thread model, over the fixture.
@MainActor
struct FullAccessModelTests {
    @Test func turningItOnShowsTheBarAndTurningItOffHidesIt() async throws {
        let model = ThreadModel(id: "thr_trip", store: FixtureBackend())
        await model.load()
        #expect(!model.isFullAccess)
        #expect(model.canToggleFullAccess)
        await model.setFullAccess(true)
        #expect(model.isFullAccess)
        await model.setFullAccess(false)
        #expect(!model.isFullAccess)
        #expect(model.actionError == nil)
    }

    @Test func aRefusalShowsTheGatewaysReasonAndDoesNotFakeSuccess() async throws {
        let reason = "Only the Mac app or a device paired as admin can turn on Full access."
        let store = FixtureBackend()
        await store.failNextThreadAction(with: reason)
        let model = ThreadModel(id: "thr_trip", store: store)
        await model.load()
        await model.setFullAccess(true)
        #expect(!model.isFullAccess)
        #expect(model.actionError == reason)
    }

    @Test func theToggleIsHiddenWhereTheGatewayWouldRefuseAndShownWhereItWouldNot() {
        var thread = ChatThread(id: "t", title: "T", status: "", statusKind: .neutral, items: [])
        #expect(ThreadModel.offersFullAccess(thread))  // positive control: an ordinary chat offers it
        thread.fullAccessAllowed = false
        #expect(!ThreadModel.offersFullAccess(thread))
        // A chat already in Full access keeps the toggle so it can be turned off.
        thread.permissionMode = "full"
        #expect(ThreadModel.offersFullAccess(thread))
    }
}
