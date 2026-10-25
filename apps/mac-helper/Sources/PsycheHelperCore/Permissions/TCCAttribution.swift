import Foundation
import PsycheProtocol

/// Who macOS asks on the helper's behalf (#570). When the helper runs nested in another app
/// (`Psyche.app/Contents/Resources/PsycheHelper.app`), tccd attributes its requests to the
/// enclosing app: that app's Info.plist must carry the usage string, and its hardened-runtime
/// signature the resource entitlement, or tccd refuses without showing a prompt (logged as
/// "Refusing authorization request … without NSRemindersUsageDescription key").
public enum TCCAttribution {
    /// Usage-description keys tccd accepts per permission (either key of a pair is enough: which
    /// one it reads depends on the SDK the host was built with).
    public static let usageKeys: [TCCPermission: [String]] = [
        .reminders: ["NSRemindersUsageDescription", "NSRemindersFullAccessUsageDescription"],
        .calendars: ["NSCalendarsUsageDescription", "NSCalendarsFullAccessUsageDescription"],
        .contacts: ["NSContactsUsageDescription"],
        .automation: ["NSAppleEventsUsageDescription"],
        .microphone: ["NSMicrophoneUsageDescription"],
        .speechRecognition: ["NSSpeechRecognitionUsageDescription"],
    ]

    /// Hardened-runtime entitlements tccd requires of the app it asks for.
    public static let entitlements: [TCCPermission: String] = [
        .reminders: "com.apple.security.personal-information.calendars",
        .calendars: "com.apple.security.personal-information.calendars",
        .contacts: "com.apple.security.personal-information.addressbook",
        .automation: "com.apple.security.automation.apple-events",
        .microphone: "com.apple.security.device.audio-input",
    ]

    /// The outermost `.app` that contains `bundlePath`, or nil when the helper is not nested.
    public static func enclosingApp(of bundlePath: String) -> String? {
        let parts = (bundlePath as NSString).standardizingPath.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard let own = parts.lastIndex(where: { $0.hasSuffix(".app") }),
              let outer = parts[..<own].firstIndex(where: { $0.hasSuffix(".app") })
        else { return nil }
        return "/" + parts[...outer].joined(separator: "/")
    }

    public struct Missing: Sendable, Equatable {
        public var usageKeys: [String]
        public var entitlement: String?
        public var isEmpty: Bool { usageKeys.isEmpty && entitlement == nil }
    }

    /// What the attributed app lacks for `permission` (nothing for permissions without such rules).
    /// `hardened`: whether the host is signed with the hardened runtime (only then is the
    /// entitlement required).
    public static func missing(_ permission: TCCPermission, hostInfo: [String: Any], hostEntitlements: [String: Any], hardened: Bool) -> Missing {
        var m = Missing(usageKeys: [], entitlement: nil)
        if let keys = usageKeys[permission] {
            let present = keys.contains { (hostInfo[$0] as? String)?.isEmpty == false }
            if !present { m.usageKeys = keys }
        }
        if hardened, let e = entitlements[permission], hostEntitlements[e] as? Bool != true { m.entitlement = e }
        return m
    }

    /// The error a request answers instead of a silent denial.
    public static func refusal(_ permission: TCCPermission, hostName: String, hostId: String, missing: Missing) -> CapabilityError {
        var why: [String] = []
        if !missing.usageKeys.isEmpty { why.append("its Info.plist has no \(missing.usageKeys.joined(separator: " or "))") }
        if let e = missing.entitlement { why.append("its signature lacks the \(e) entitlement") }
        return CapabilityError(
            .forbidden, reason: "prompt_refused_by_macos",
            "macOS will not show the \(permission.rawValue) prompt: it asks on behalf of \(hostName) (\(hostId)), and \(why.joined(separator: " and ")). Rebuild \(hostName) with them.",
            details: [
                "permission": .string(permission.rawValue), "attributedTo": .string(hostId),
                "missingUsageKeys": .array(missing.usageKeys.map { .string($0) }),
                "missingEntitlement": missing.entitlement.map { .string($0) } ?? .null,
            ]
        )
    }
}
