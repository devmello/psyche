import CoreGraphics
import Foundation
import PsycheHelperCore
import Testing

@Suite("screen ask")
struct ScreenAskTests {
    typealias W = ScreenAsk.WindowRef

    @Test func excludesNeverCaptureAppsAndExplicitOffOnly() {
        let settings = TierSettings(defaultValue: .off, apps: ["com.example.Secret": .off, "com.example.Fine": .read])
        #expect(ScreenAsk.isExcluded(bundleId: "com.psyche.desktop", settings: settings))
        #expect(ScreenAsk.isExcluded(bundleId: "com.agilebits.onepassword7", settings: settings) == (FixedCaps.category(of: "com.agilebits.onepassword7") == .passwordManager))
        #expect(ScreenAsk.isExcluded(bundleId: "com.example.secret", settings: settings))
        #expect(!ScreenAsk.isExcluded(bundleId: "com.example.Fine", settings: settings))
        // The default tier is about the agent acting; it does not hide an app from its owner.
        #expect(!ScreenAsk.isExcluded(bundleId: "com.example.Other", settings: settings))
        #expect(!ScreenAsk.isExcluded(bundleId: nil, settings: settings))
    }

    @Test func targetSkipsPsycheAndChrome() {
        let windows = [
            W(id: 1, pid: 10, layer: 25, bounds: CGRect(x: 0, y: 0, width: 1000, height: 24)),  // menu bar
            W(id: 2, pid: 99, layer: 0, bounds: CGRect(x: 100, y: 0, width: 480, height: 360)),  // the ask panel
            W(id: 3, pid: 20, layer: 0, bounds: CGRect(x: 0, y: 0, width: 20, height: 20)),  // a badge
            W(id: 4, pid: 21, layer: 0, bounds: CGRect(x: 0, y: 0, width: 800, height: 600), alpha: 0),
            W(id: 5, pid: 30, layer: 0, bounds: CGRect(x: 0, y: 0, width: 800, height: 600)),
            W(id: 6, pid: 40, layer: 0, bounds: CGRect(x: 0, y: 0, width: 800, height: 600)),
        ]
        #expect(ScreenAsk.targetWindow(windows, psychePids: [99])?.id == 5)
        #expect(ScreenAsk.targetWindow([], psychePids: []) == nil)
        #expect(ScreenAsk.window(at: CGPoint(x: 200, y: 100), windows, psychePids: [99])?.id == 5)
    }

    @Test func regionPicksTheDisplayWithMostOfTheBox() {
        let displays = [CGRect(x: 0, y: 0, width: 1440, height: 900), CGRect(x: 1440, y: 0, width: 1920, height: 1080)]
        let r = ScreenAsk.region(CGRect(x: 1400, y: 100, width: 400, height: 200), displays: displays)
        #expect(r?.index == 1)
        #expect(r?.local == CGRect(x: 0, y: 100, width: 360, height: 200))
        // A box dragged right to left is standardised first.
        #expect(ScreenAsk.region(CGRect(x: 300, y: 300, width: -200, height: -100), displays: displays)?.local == CGRect(x: 100, y: 200, width: 200, height: 100))
        #expect(ScreenAsk.region(CGRect(x: 5000, y: 0, width: 100, height: 100), displays: displays) == nil)
        #expect(ScreenAsk.region(CGRect(x: 10, y: 10, width: 4, height: 100), displays: displays) == nil)
    }

    @Test func textIsTrimmedAndBounded() {
        #expect(ScreenAsk.selection("  hi \n") == "hi")
        #expect(ScreenAsk.selection("   ") == nil)
        #expect(ScreenAsk.selection(nil) == nil)
        #expect(ScreenAsk.selection(String(repeating: "a", count: 5000))?.count == ScreenAsk.maxSelectedText)
        #expect(ScreenAsk.title("  Inbox  ") == "Inbox")
        #expect(ScreenAsk.title("") == nil)
    }

    @Test func urlsAreHttpWithoutCredentials() {
        #expect(ScreenAsk.url("https://example.com/a?b=1") == "https://example.com/a?b=1")
        #expect(ScreenAsk.url("https://me:pw@example.com/x") == "https://example.com/x")
        #expect(ScreenAsk.url("file:///Users/me/secret.txt") == nil)
        #expect(ScreenAsk.url("javascript:alert(1)") == nil)
        #expect(ScreenAsk.url("about:blank") == nil)
        #expect(ScreenAsk.url("https://example.com/" + String(repeating: "a", count: 3000)) == nil)
    }
}
