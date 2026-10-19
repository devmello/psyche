import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

private let allKinds: [NotificationKind] = [.approval, .inputNeeded, .taskDone, .taskFailed, .proactive, .briefing, .reminder, .system]

private func params(_ kind: NotificationKind, id: String = "ntf_1", title: String = "Title", body: String = "Body") -> NotifyShowParams {
    NotifyShowParams(id: id, kind: kind, title: title, body: body)
}

private func reason(_ body: () throws -> Void) -> String? {
    do {
        try body()
        return nil
    } catch let e as CapabilityError {
        return e.code == .invalidParams ? e.reason + ":" + (e.details["field"]?.stringValue ?? "") : "\(e)"
    } catch {
        return "\(error)"
    }
}

@Suite("notification plan: categories and actions")
struct NotificationCategoryTests {
    @Test func approvalHasApproveAndDestructiveDeny() throws {
        let plan = try NotificationPlan.make(params(.approval))
        #expect(plan.category.identifier == "psyche.approval")
        #expect(plan.category.actions.map(\.id) == ["approve", "deny"])
        #expect(plan.category.actions.map(\.destructive) == [false, true])
        #expect(plan.userInfo.destructiveActionIds == ["deny"])
    }

    @Test func inputNeededHasTextReply() throws {
        let plan = try NotificationPlan.make(params(.inputNeeded))
        #expect(plan.category.identifier == "psyche.input_needed")
        #expect(plan.category.actions.count == 1)
        #expect(plan.category.actions[0].id == "reply")
        #expect(plan.category.actions[0].textInput != nil)
    }

    @Test func perKindDefaults() throws {
        let expected: [NotificationKind: (String, [String])] = [
            .approval: ("psyche.approval", ["approve", "deny"]),
            .inputNeeded: ("psyche.input_needed", ["reply"]),
            .taskFailed: ("psyche.task_failed", ["open", "retry"]),
            .reminder: ("psyche.reminder", ["open", "snooze"]),
            .taskDone: ("psyche.open", ["open"]),
            .proactive: ("psyche.open", ["open"]),
            .briefing: ("psyche.open", ["open"]),
            .system: ("psyche.open", ["open"]),
        ]
        for kind in allKinds {
            let plan = try NotificationPlan.make(params(kind))
            #expect(plan.category.identifier == expected[kind]?.0, "\(kind)")
            #expect(plan.category.actions.map(\.id) == expected[kind]?.1, "\(kind)")
        }
    }

    @Test func defaultCategoryIdsAreUnique() {
        let ids = NotificationPlan.defaultCategories.map(\.identifier)
        #expect(Set(ids).count == ids.count)
    }

    @Test func explicitActionsEqualToDefaultsReuseTheDefaultCategory() throws {
        var p = params(.approval)
        p.actions = [NotifyActionParams(id: "approve", label: "Approve"), NotifyActionParams(id: "deny", label: "Deny", destructive: true)]
        #expect(try NotificationPlan.make(p).category.identifier == "psyche.approval")
    }

    @Test func customActionsGetDeterministicCategoryIds() throws {
        var a = params(.approval)
        a.actions = [NotifyActionParams(id: "buy", label: "Buy", requiresAuth: true), NotifyActionParams(id: "skip", label: "Skip", destructive: true)]
        let first = try NotificationPlan.make(a).category
        let again = try NotificationPlan.make(a).category
        #expect(first.identifier.hasPrefix("psyche.custom."))
        #expect(first.identifier.count == "psyche.custom.".count + 16)
        #expect(first == again)
        // Same actions on another kind share the category.
        var other = a
        other.kind = .reminder
        #expect(try NotificationPlan.make(other).category.identifier == first.identifier)

        // Any change to the action set changes the id.
        var variants: [[NotifyActionParams]] = [
            [NotifyActionParams(id: "buy", label: "Buy"), NotifyActionParams(id: "skip", label: "Skip", destructive: true)],
            [NotifyActionParams(id: "buy", label: "Buy now", requiresAuth: true), NotifyActionParams(id: "skip", label: "Skip", destructive: true)],
            [NotifyActionParams(id: "skip", label: "Skip", destructive: true), NotifyActionParams(id: "buy", label: "Buy", requiresAuth: true)],
            [NotifyActionParams(id: "buy", label: "Buy", requiresAuth: true)],
        ]
        variants.append([NotifyActionParams(id: "buy", label: "Buy", requiresAuth: true), NotifyActionParams(id: "skip", label: "Skip")])
        var seen: Set<String> = [first.identifier]
        for v in variants {
            var p = a
            p.actions = v
            seen.insert(try NotificationPlan.make(p).category.identifier)
        }
        #expect(seen.count == variants.count + 1)
    }

    @Test func customReplyLabelMakesACustomCategory() throws {
        var p = params(.inputNeeded)
        p.reply = NotifyReplyParams(label: "Answer", placeholder: "Which folder?")
        let plan = try NotificationPlan.make(p)
        #expect(plan.category.identifier.hasPrefix("psyche.custom."))
        #expect(plan.category.actions[0].label == "Answer")
        #expect(plan.category.actions[0].textInput?.placeholder == "Which folder?")
    }

    @Test func replyComesBeforeButtons() throws {
        var p = params(.taskFailed)
        p.reply = NotifyReplyParams(label: "Tell Psyche")
        #expect(try NotificationPlan.make(p).category.actions.map(\.id) == ["reply", "open", "retry"])
    }

    @Test func emptyCustomActionsMeanNoButtons() throws {
        var p = params(.taskDone)
        p.actions = []
        let plan = try NotificationPlan.make(p)
        #expect(plan.category.actions.isEmpty)
        #expect(plan.category.identifier.hasPrefix("psyche.custom."))
    }

    @Test func actionValidation() {
        var p = params(.approval)
        p.actions = (1...5).map { NotifyActionParams(id: "a\($0)", label: "A\($0)") }
        #expect(reason { _ = try NotificationPlan.make(p) } == "invalid_params:actions")

        // Four buttons plus a reply is five.
        var q = params(.inputNeeded)
        q.actions = (1...4).map { NotifyActionParams(id: "a\($0)", label: "A\($0)") }
        #expect(reason { _ = try NotificationPlan.make(q) } == "invalid_params:actions")
        q.actions = Array(q.actions!.prefix(3))
        #expect(reason { _ = try NotificationPlan.make(q) } == nil)

        for bad in ["default", "dismiss", "has space", "", String(repeating: "x", count: 129)] {
            p.actions = [NotifyActionParams(id: bad, label: "X")]
            #expect(reason { _ = try NotificationPlan.make(p) } == "invalid_params:actions", "\(bad)")
        }
        p.actions = [NotifyActionParams(id: "same", label: "A"), NotifyActionParams(id: "same", label: "B")]
        #expect(reason { _ = try NotificationPlan.make(p) } == "invalid_params:actions")
        q.actions = [NotifyActionParams(id: "reply", label: "Reply")]
        #expect(reason { _ = try NotificationPlan.make(q) } == "invalid_params:actions")
        p.actions = [NotifyActionParams(id: "ok", label: "  ")]
        #expect(reason { _ = try NotificationPlan.make(p) } == "invalid_params:actions")
    }
}

@Suite("notification plan: interruption, limits, ids")
struct NotificationLimitsTests {
    @Test func interruptionDefaults() throws {
        let expected: [NotificationKind: NotifyInterruptionLevel] = [
            .approval: .timeSensitive, .inputNeeded: .timeSensitive, .proactive: .passive, .briefing: .passive,
            .taskDone: .active, .taskFailed: .active, .reminder: .active, .system: .active,
        ]
        for kind in allKinds {
            let plan = try NotificationPlan.make(params(kind))
            #expect(plan.interruption == expected[kind], "\(kind)")
            #expect(plan.requestedInterruption == expected[kind])
            #expect(plan.playSound == (expected[kind] != .passive))
            #expect(!plan.quietHoursApplied)
        }
    }

    @Test func explicitInterruptionAndSoundWin() throws {
        var p = params(.briefing)
        p.interruption = .timeSensitive
        p.sound = false
        let plan = try NotificationPlan.make(p)
        #expect(plan.interruption == .timeSensitive)
        #expect(!plan.playSound)
    }

    @Test func truncatesTitleSubtitleAndBody() throws {
        var p = params(.system, title: String(repeating: "t", count: 500), body: String(repeating: "b", count: 5000))
        p.subtitle = String(repeating: "s", count: 121)
        let plan = try NotificationPlan.make(p)
        #expect(plan.title.count == 120 && plan.title.hasSuffix("…"))
        #expect(plan.body.count == 1000 && plan.body.hasSuffix("…"))
        #expect(plan.subtitle?.count == 120)

        let exact = try NotificationPlan.make(params(.system, title: String(repeating: "t", count: 120), body: String(repeating: "b", count: 1000)))
        #expect(exact.title.count == 120 && !exact.title.hasSuffix("…"))
        #expect(exact.body.count == 1000 && !exact.body.hasSuffix("…"))
    }

    @Test func truncationCountsCharactersNotBytes() {
        let emoji = String(repeating: "👩‍👩‍👧", count: 10)
        #expect(NotificationLimits.truncate(emoji, max: 5) == String(repeating: "👩‍👩‍👧", count: 4) + "…")
        #expect(NotificationLimits.truncate("abc", max: 3) == "abc")
        #expect(NotificationLimits.truncate("abcd", max: 3) == "ab…")
    }

    @Test func idValidation() {
        for good in ["ntf_01JAX4", "a", "x.y:z-1_2", String(repeating: "a", count: 128)] {
            #expect(NotificationLimits.isValidId(good), "\(good)")
        }
        for bad in ["", "a b", "ntf/1", "é", "a\n", String(repeating: "a", count: 129)] {
            #expect(!NotificationLimits.isValidId(bad), "\(bad)")
        }
    }

    @Test func rejectsBadIdsAndEmptyTitle() {
        #expect(reason { _ = try NotificationPlan.make(params(.system, id: "bad id")) } == "invalid_params:id")
        #expect(reason { _ = try NotificationPlan.make(params(.system, title: " \n")) } == "invalid_params:title")
        var p = params(.approval)
        p.approvalId = "apr 1"
        #expect(reason { _ = try NotificationPlan.make(p) } == "invalid_params:approvalId")
        p.approvalId = nil
        p.threadId = "thr/1"
        #expect(reason { _ = try NotificationPlan.make(p) } == "invalid_params:threadId")
    }

    @Test func userInfoCarriesIdsOnly() throws {
        var p = params(.approval, title: "Approve purchase", body: "Secret details")
        p.approvalId = "apr_1"
        p.requireBiometry = true
        let info = try NotificationPlan.make(p).userInfo
        #expect(info == NotificationUserInfo(notificationId: "ntf_1", kind: "approval", approvalId: "apr_1", requireBiometry: true, destructiveActionIds: ["deny"]))
        let dict = info.dictionary
        for value in dict.values {
            if let s = value as? String { #expect(!s.contains("Secret") && !s.contains("purchase")) }
        }
        #expect(NotificationUserInfo(dict) == info)
    }

    @Test func decodesFromJSONParams() throws {
        let json: JSONValue = [
            "id": "ntf_9", "kind": "input_needed", "title": "Need a folder", "body": "Where should I save it?",
            "interruption": "active", "quietHours": ["start": "22:00", "end": "07:00"],
            "actions": [["id": "skip", "label": "Skip", "destructive": true]],
        ]
        let p = try json.decode(as: NotifyShowParams.self)
        #expect(p.kind == .inputNeeded && p.interruption == .active && p.quietHours?.start == "22:00")
        #expect(p.actions?.first?.destructive == true)
    }
}

@Suite("notify.show S15 wire shape")
struct NotifyShowS15ShapeTests {
    @Test func acceptsTheNotifierParams() throws {
        // packages/notifications/src/surfaces.ts toNotifyShowParams()
        let json = #"""
        {"id":"ntf_1","category":"input_needed","title":"Question","body":"Which file?","interruptionLevel":"timeSensitive",
         "threadId":null,"route":"/tasks/t1","actions":[{"id":"reply","label":"Answer","destructive":false,
         "authenticationRequired":false,"textInput":true},{"id":"open","label":"Open","destructive":false,
         "authenticationRequired":true,"textInput":false}]}
        """#
        let p = try JSONDecoder().decode(NotifyShowParams.self, from: Data(json.utf8))
        #expect(p.kind == .inputNeeded && p.interruption == .timeSensitive && p.threadId == nil)
        #expect(p.reply == NotifyReplyParams(label: "Answer"))
        #expect(p.actions == [NotifyActionParams(id: "open", label: "Open", destructive: false, requiresAuth: true)])
        let roundTrip = try JSONDecoder().decode(NotifyShowParams.self, from: JSONEncoder().encode(p))
        #expect(roundTrip == p)
    }

    @Test func emptyActionsMeanKindDefaults() throws {
        let json = #"{"id":"n","category":"approval","title":"t","body":"b","interruptionLevel":"active","threadId":"t1","route":null,"actions":[]}"#
        let p = try JSONDecoder().decode(NotifyShowParams.self, from: Data(json.utf8))
        #expect(p.actions == nil && p.kind == .approval)
    }
}
