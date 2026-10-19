import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

@Suite("notification responses")
struct NotificationResponseTests {
    @Test func payloadMapping() {
        let approve = NotificationResponse(notificationId: "ntf_1", actionId: "approve", approvalId: "apr_1", authenticated: true)
        #expect(
            approve.payload
                == ["type": "notify.response", "notificationId": "ntf_1", "actionId": "approve", "approvalId": "apr_1", "authenticated": true]
        )

        let reply = NotificationResponse(notificationId: "ntf_2", actionId: "reply", replyText: "Use ~/Documents")
        #expect(reply.payload == ["type": "notify.response", "notificationId": "ntf_2", "actionId": "reply", "replyText": "Use ~/Documents", "text": "Use ~/Documents", "authenticated": false])

        let refused = NotificationResponse(notificationId: "ntf_1", actionId: "approve", approvalId: "apr_1", authenticated: false, authError: "user_cancelled")
        #expect(refused.payload["authenticated"] == false)
        #expect(refused.payload["authError"] == "user_cancelled")
    }

    @Test func mapsSystemActionIdentifiers() {
        let d = "com.apple.UNNotificationDefaultActionIdentifier"
        let x = "com.apple.UNNotificationDismissActionIdentifier"
        #expect(NotificationResponse.actionId(system: d, systemDefault: d, systemDismiss: x) == "default")
        #expect(NotificationResponse.actionId(system: x, systemDefault: d, systemDismiss: x) == "dismiss")
        #expect(NotificationResponse.actionId(system: "approve", systemDefault: d, systemDismiss: x) == "approve")
    }

    @Test func authenticationOnlyForNonDestructiveDecisions() {
        let info = NotificationUserInfo(notificationId: "ntf_1", kind: "approval", approvalId: "apr_1", requireBiometry: true, destructiveActionIds: ["deny"])
        #expect(info.needsAuthentication(actionId: "approve"))
        #expect(!info.needsAuthentication(actionId: "deny"))
        #expect(!info.needsAuthentication(actionId: "dismiss"))
        #expect(!info.needsAuthentication(actionId: "default"))
        var off = info
        off.requireBiometry = false
        #expect(!off.needsAuthentication(actionId: "approve"))
    }

    @Test func userInfoRoundTripAndForeignPayloads() {
        let info = NotificationUserInfo(notificationId: "ntf_1", kind: "reminder", approvalId: nil, requireBiometry: false, destructiveActionIds: [])
        let back = NotificationUserInfo(info.dictionary.reduce(into: [AnyHashable: Any]()) { $0[$1.key] = $1.value })
        #expect(back == info)
        #expect(NotificationUserInfo([:]) == nil)
        #expect(NotificationUserInfo(["psyche.notificationId": "bad id"]) == nil)
        #expect(NotificationUserInfo(["aps": ["alert": "x"]]) == nil)
    }
}

@Suite("notification response hub")
struct NotificationResponseHubTests {
    private func response(_ n: Int) -> NotificationResponse {
        NotificationResponse(notificationId: "ntf_\(n)", actionId: "open")
    }

    @Test func buffersWithoutSubscriberAndDropsOldest() async {
        let hub = NotificationResponseHub(capacity: 100)
        for n in 0..<105 { hub.publish(response(n)) }
        #expect(hub.pendingCount == 100)
        #expect(hub.droppedCount == 5)

        var it = hub.subscribe().makeAsyncIterator()
        #expect(hub.pendingCount == 0)
        #expect(await it.next()?.notificationId == "ntf_5")
        for _ in 6..<104 { _ = await it.next() }
        #expect(await it.next()?.notificationId == "ntf_104")

        hub.publish(response(200))
        #expect(await it.next()?.notificationId == "ntf_200")
        #expect(hub.pendingCount == 0)
    }

    @Test func liveResponsesReachEverySubscriber() async {
        let hub = NotificationResponseHub()
        var a = hub.subscribe().makeAsyncIterator()
        var b = hub.subscribe().makeAsyncIterator()
        #expect(hub.subscriberCount == 2)
        hub.publish(response(1))
        #expect(await a.next()?.notificationId == "ntf_1")
        #expect(await b.next()?.notificationId == "ntf_1")
        #expect(hub.pendingCount == 0)
    }

    @Test func cancelledSubscriberFallsBackToBuffering() async {
        let hub = NotificationResponseHub()
        let started = AsyncStream.makeStream(of: Void.self)
        let consumer = _Concurrency.Task {
            var got: [String] = []
            started.continuation.yield()
            for await r in hub.subscribe() { got.append(r.notificationId) }
            return got
        }
        var it = started.stream.makeAsyncIterator()
        _ = await it.next()
        while hub.subscriberCount == 0 { await _Concurrency.Task.yield() }
        hub.publish(response(1))
        consumer.cancel()
        _ = await consumer.value
        while hub.subscriberCount > 0 { await _Concurrency.Task.yield() }

        hub.publish(response(2))
        #expect(hub.pendingCount == 1)
        var next = hub.subscribe().makeAsyncIterator()
        #expect(await next.next()?.notificationId == "ntf_2")
    }
}
