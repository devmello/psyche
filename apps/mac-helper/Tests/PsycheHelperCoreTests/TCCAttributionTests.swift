import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

@Suite("TCC attribution to the enclosing app (#570)")
struct TCCAttributionTests {
    @Test func theEnclosingAppIsFound() {
        #expect(TCCAttribution.enclosingApp(of: "/Applications/Psyche.app/Contents/Resources/PsycheHelper.app") == "/Applications/Psyche.app")
        #expect(TCCAttribution.enclosingApp(of: "/Applications/Psyche.app/Contents/Library/LoginItems/PsycheHelper.app/") == "/Applications/Psyche.app")
        #expect(TCCAttribution.enclosingApp(of: "/Users/me/Applications/Psyche Helper.app") == nil)
        #expect(TCCAttribution.enclosingApp(of: "/tmp/x/PsycheHelper.app") == nil)
    }

    /// Psyche.app as shipped in #570: microphone string only; hardened runtime with allow-jit and audio-input.
    let desktopInfo: [String: Any] = ["CFBundleIdentifier": "com.psyche.desktop", "NSMicrophoneUsageDescription": "Psyche uses the microphone…"]
    let desktopEntitlements: [String: Any] = ["com.apple.security.cs.allow-jit": true, "com.apple.security.device.audio-input": true]

    @Test func whatTheShippedDesktopLacks() {
        let r = TCCAttribution.missing(.reminders, hostInfo: desktopInfo, hostEntitlements: desktopEntitlements, hardened: true)
        #expect(r.usageKeys == ["NSRemindersUsageDescription", "NSRemindersFullAccessUsageDescription"])
        #expect(r.entitlement == "com.apple.security.personal-information.calendars")
        #expect(TCCAttribution.missing(.automation, hostInfo: desktopInfo, hostEntitlements: desktopEntitlements, hardened: true).entitlement == "com.apple.security.automation.apple-events")
        #expect(TCCAttribution.missing(.microphone, hostInfo: desktopInfo, hostEntitlements: desktopEntitlements, hardened: true).isEmpty)
        #expect(TCCAttribution.missing(.accessibility, hostInfo: [:], hostEntitlements: [:], hardened: true).isEmpty)
        // Either key of a pair is enough; entitlements matter only under the hardened runtime.
        #expect(TCCAttribution.missing(.calendars, hostInfo: ["NSCalendarsFullAccessUsageDescription": "x"], hostEntitlements: [:], hardened: false).isEmpty)
    }

    @Test func theRefusalNamesTheHostAndWhatIsMissing() {
        let m = TCCAttribution.missing(.reminders, hostInfo: desktopInfo, hostEntitlements: desktopEntitlements, hardened: true)
        let e = TCCAttribution.refusal(.reminders, hostName: "Psyche", hostId: "com.psyche.desktop", missing: m)
        #expect(e.code == .forbidden && e.reason == "prompt_refused_by_macos")
        #expect(e.message.contains("Psyche (com.psyche.desktop)") && e.message.contains("NSRemindersUsageDescription"))
        #expect(e.details["attributedTo"] == "com.psyche.desktop" && e.details["missingEntitlement"] == "com.apple.security.personal-information.calendars")
    }
}
