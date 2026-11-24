import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

@MainActor
struct InboxRecoveryTests {
    static func notice(
        state: String = "requested", op: String = "grant", device: String = "Work laptop", key: String = "0123456789abcdef"
    ) -> InboxItem {
        InboxItem(
            id: "n_rc", title: "A command on this Mac asked for a security change", body: "Give Work laptop operator.admin.",
            kindLabel: "Update", time: "9:00",
            message: InboxNoticeKeys(
                titleKey: "notice.security.recovery.title", bodyKey: "notice.security.recovery.body",
                params: ["state": state, "op": op, "device": device, "key": key, "scopes": "operator.admin", "when": "none", "reason": "none"]))
    }

    @Test func onlyARequestedRecoveryNoticeCanBeCancelled() {
        #expect(InboxModel.recoveryNotice(for: Self.notice()) == RecoveryNotice(op: "grant", device: "Work laptop", key: "0123456789abcdef"))
        // Applied, cancelled and failed notices have nothing left to cancel.
        for state in ["applied", "cancelled", "failed"] {
            #expect(InboxModel.recoveryNotice(for: Self.notice(state: state)) == nil)
        }
        // Another op word, a notice of another kind, and a notice with no ids at all.
        #expect(InboxModel.recoveryNotice(for: Self.notice(op: "other")) == nil)
        let other = InboxItem(
            id: "n", title: "t", body: "b", kindLabel: "Update", time: "9:00",
            message: InboxNoticeKeys(titleKey: "notice.security.changed.title", bodyKey: "notice.security.changed.body", params: ["state": "requested", "op": "grant"]))
        #expect(InboxModel.recoveryNotice(for: other) == nil)
        #expect(InboxModel.recoveryNotice(for: InboxItem(id: "n", title: "t", body: "b", kindLabel: "Update", time: "9:00")) == nil)
    }

    @Test func theGatewaysPlaceholdersForNoDeviceAndNoKeyBecomeNil() {
        let presence = InboxModel.recoveryNotice(for: Self.notice(op: "presence", device: "?", key: "none"))
        #expect(presence == RecoveryNotice(op: "presence", device: nil, key: nil))
    }

    @Test func theDemoPhoneHoldsAdminAndShowsTheResult() async {
        let model = InboxModel(store: FixtureBackend())
        await model.load()
        #expect(model.canCancelRecoveries)
        await model.cancelRecovery(Self.notice())
        #expect(model.recoveryResult != nil)
        #expect(model.actionError == nil)
    }

    @Test func aNoticeThatIsNotARecoveryRequestDoesNothing() async {
        let model = InboxModel(store: FixtureBackend())
        await model.load()
        await model.cancelRecovery(Self.notice(state: "applied"))
        #expect(model.recoveryResult == nil)
    }
}
