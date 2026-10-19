import Foundation
import PsycheHelperCore
import PsycheProtocol

/// `notify.*` capability group (architecture §6, feature O10).
///
/// Responses to notifications are delivered as `notify.response` events on the long-lived
/// `notify.subscribe` invocation, because the protocol has no unsolicited node→Gateway event yet.
public enum NotifyCapabilities {
    public static func make(bridge: NotificationCenterBridge, now: @escaping @Sendable () -> Date = { Date() }, calendar: Calendar = .current) -> [any CapabilityHandler] {
        [show(bridge, now: now, calendar: calendar), withdraw(bridge), authorizationStatus(bridge), requestAuthorization(bridge), subscribe(bridge)]
    }

    static func idSchema(_ description: String) -> JSONValue {
        var o = Schema.string(description, maxLength: NotificationLimits.maxIdLength).objectValue ?? [:]
        o["pattern"] = .string(NotificationLimits.idPattern)
        return .object(o)
    }

    static let kinds = ["approval", "input_needed", "task_done", "task_failed", "proactive", "briefing", "reminder", "system"]

    static let showSchema: JSONValue = Schema.object(
        [
            "id": idSchema("Gateway notification id; reusing it replaces the shown notification"),
            "kind": Schema.string("NotificationKind", enum: kinds),
            "title": Schema.string("Truncated to \(NotificationLimits.maxTitle) characters"),
            "body": Schema.string("Truncated to \(NotificationLimits.maxBody) characters"),
            "subtitle": Schema.string("Truncated to \(NotificationLimits.maxSubtitle) characters"),
            "actions": Schema.array(
                Schema.object(
                    [
                        "id": idSchema("Action id returned as actionId (not default, dismiss or reply)"),
                        "label": Schema.string(nil, maxLength: NotificationLimits.maxActionLabel),
                        "destructive": Schema.boolean(),
                        "requiresAuth": Schema.boolean("Device must be unlocked"),
                    ], required: ["id", "label"]
                ),
                description: "Replaces the kind's default buttons", maxItems: NotificationLimits.maxActions
            ),
            "reply": Schema.object(
                ["label": Schema.string(nil, maxLength: NotificationLimits.maxActionLabel), "placeholder": Schema.string()],
                required: ["label"], description: "Inline text reply (input_needed has one by default)"
            ),
            "threadId": idSchema("Groups notifications in Notification Center"),
            "route": Schema.string("Deep link inside the app (not stored in the OS notification)"),
            "interruption": Schema.string("Overrides the kind's default level", enum: NotifyInterruptionLevel.allCases.map(\.rawValue)),
            "approvalId": idSchema("Approval answered by this notification"),
            "requireBiometry": Schema.boolean("Run device-owner authentication before forwarding a non-destructive action"),
            "quietHours": Schema.object(
                ["start": Schema.string("HH:mm"), "end": Schema.string("HH:mm")], required: ["end", "start"],
                description: "Local-time window during which the notification is passive and silent"
            ),
            "sound": Schema.boolean("Defaults to true unless the level is passive"),
        ],
        required: ["body", "id", "kind", "title"]
    )

    static func show(_ bridge: NotificationCenterBridge, now: @escaping @Sendable () -> Date, calendar: Calendar) -> Capability {
        Capability(
            CapabilitySpec(
                name: "notify.show",
                description: "Show a macOS notification with per-kind actions, an optional text reply, an interruption level and quiet hours.",
                sideEffect: .write, inputSchema: showSchema, receiptKind: "notification"
            )
        ) { ctx in
            let plan = try NotificationPlan.make(ctx.decode(NotifyShowParams.self), now: now(), calendar: calendar)
            let outcome = try await bridge.show(plan)
            return CapabilityOutput(
                [
                    "delivered": true,
                    "interruptionLevel": .string(outcome.interruptionLevel.rawValue),
                    "quietHoursApplied": .bool(plan.quietHoursApplied),
                    "category": .string(plan.category.identifier),
                    "authorization": .string(outcome.authorization),
                ],
                receipt: ReceiptDraft(
                    outcome: .ok, summary: "Showed a \(plan.kind.rawValue) notification",
                    externalRefs: ["notificationId": .string(plan.id)]
                )
            )
        }
    }

    static func withdraw(_ bridge: NotificationCenterBridge) -> Capability {
        Capability(
            CapabilitySpec(
                name: "notify.withdraw", description: "Remove a delivered or pending notification by id.",
                sideEffect: .write, inputSchema: Schema.object(["id": idSchema("Gateway notification id")], required: ["id"]),
                receiptKind: "notification"
            )
        ) { ctx in
            let p = try ctx.decode(NotifyWithdrawParams.self)
            guard NotificationLimits.isValidId(p.id) else {
                throw CapabilityError.invalidParams("id must match \(NotificationLimits.idPattern)", field: "id")
            }
            try bridge.withdraw(id: p.id)
            return CapabilityOutput(
                ["withdrawn": true],
                receipt: ReceiptDraft(outcome: .ok, summary: "Withdrew a notification", externalRefs: ["notificationId": .string(p.id)])
            )
        }
    }

    static func authorizationStatus(_ bridge: NotificationCenterBridge) -> Capability {
        Capability(
            CapabilitySpec(
                name: "notify.authorization_status",
                description: "Notification authorization (notDetermined, denied, authorized, provisional) and alert/sound/badge/time-sensitive settings.",
                sideEffect: .read
            )
        ) { _ in
            CapabilityOutput(try await bridge.authorizationStatus())
        }
    }

    static func requestAuthorization(_ bridge: NotificationCenterBridge) -> Capability {
        Capability(
            CapabilitySpec(
                name: "notify.request_authorization",
                description: "Request notification authorization: provisional (quiet, no prompt) by default, explicit prompt when provisional is false.",
                sideEffect: .write,
                inputSchema: Schema.object(["provisional": Schema.boolean("Default true (security §12: provisional first)")]),
                receiptKind: "notification"
            )
        ) { ctx in
            let provisional = try ctx.decode(NotifyRequestAuthorizationParams.self).provisional ?? true
            let result = try await bridge.requestAuthorization(provisional: provisional)
            return CapabilityOutput(
                result,
                receipt: ReceiptDraft(outcome: .ok, summary: provisional ? "Requested provisional notification authorization" : "Requested notification authorization")
            )
        }
    }

    static func subscribe(_ bridge: NotificationCenterBridge) -> Capability {
        Capability(
            CapabilitySpec(
                name: "notify.subscribe",
                description:
                    "Stream notify.response events (notificationId, actionId, replyText, approvalId, authenticated) until cancelled. Responses received while no subscriber is open are buffered (up to 100).",
                sideEffect: .read, streaming: true
            )
        ) { ctx in
            _ = try bridge.requireCenter()
            for await response in bridge.hub.subscribe() {
                await ctx.emit(response.payload)
            }
            // The stream only ends when this invocation is cancelled.
            throw CapabilityError.cancelled
        }
    }
}
