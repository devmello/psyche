import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

@Suite("presence assertions (issue #84)")
struct PresenceTests {
    static let challenge = String(repeating: "ab", count: 32)

    @Test func messageMatchesTheGatewayDomain() {
        // apps/gateway/src/compose/helper.ts helperPresenceMessage
        #expect(PresenceMessage.bytes(challenge: "c0ffee") == Data("psyche.presence.helper.v1|c0ffee".utf8))
        #expect(PresenceMessage.isValidChallenge(Self.challenge))
        #expect(!PresenceMessage.isValidChallenge("abc"))
        #expect(!PresenceMessage.isValidChallenge(String(repeating: "zz", count: 32)))
        #expect(PresenceMessage.keyId(x963: Data()) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }

    @Test func challengeTravelsThroughUserInfoOnlyWhenBiometryIsRequired() throws {
        let json = #"{"id":"apr_1","category":"approval","title":"Buy","body":"$5","interruptionLevel":"timeSensitive","threadId":null,"route":"/approvals/apr_1","actions":[{"id":"approve","label":"Approve","destructive":false,"authenticationRequired":true,"textInput":false},{"id":"deny","label":"Deny","destructive":true,"authenticationRequired":false,"textInput":false}],"approvalId":"apr_1","requireBiometry":true,"presenceChallenge":"\#(Self.challenge)"}"#
        let p = try JSONDecoder().decode(NotifyShowParams.self, from: Data(json.utf8))
        #expect(p.presenceChallenge == Self.challenge)
        let plan = try NotificationPlan.make(p, now: Date(), calendar: Calendar(identifier: .gregorian))
        let info = try #require(NotificationUserInfo(plan.userInfo.dictionary))
        #expect(info.presenceChallenge == Self.challenge && info.needsAuthentication(actionId: "approve"))
        #expect(!info.needsAuthentication(actionId: "deny"))
        var noBio = p
        noBio.requireBiometry = false
        let plain = try NotificationPlan.make(noBio, now: Date(), calendar: Calendar(identifier: .gregorian))
        #expect(plain.userInfo.presenceChallenge == nil)
    }

    @Test func malformedChallengesAreRejected() {
        let json = #"{"id":"a","category":"approval","title":"t","body":"b","requireBiometry":true,"presenceChallenge":"nothex"}"#
        #expect(throws: (any Error).self) { try JSONDecoder().decode(NotifyShowParams.self, from: Data(json.utf8)) }
    }

    @Test func responsePayloadCarriesTheAssertion() {
        var r = NotificationResponse(notificationId: "apr_1", actionId: "approve", approvalId: "apr_1", authenticated: true)
        r.presence = PresenceSignature(signature: "c2ln", keyId: "k1")
        #expect(r.payload["presence"] == ["signature": "c2ln", "keyId": "k1"])
        #expect(r.payload["authenticated"] == true)
        r.presence = nil
        r.presenceError = "missing_entitlement"
        #expect(r.payload["presence"] == nil && r.payload["presenceError"] == "missing_entitlement")
    }
}
