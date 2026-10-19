import CoreGraphics
import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

private final class Clock: @unchecked Sendable {
    var now = Date(timeIntervalSince1970: 1_000_000)
}

@Suite("computer-use tiers, session lock, stop")
struct ComputerPolicyTests {
    @Test func fixedCapsCannotBeRaised() {
        #expect(FixedCaps.cap(for: "com.apple.Safari") == .read)
        #expect(FixedCaps.cap(for: "com.googlecode.iterm2") == .click)
        #expect(FixedCaps.cap(for: "com.jetbrains.intellij") == .click)
        #expect(FixedCaps.cap(for: "com.1password.1password") == .off)
        #expect(FixedCaps.cap(for: "com.robinhood.desktop") == .off)
        #expect(FixedCaps.cap(for: "com.psyche.desktop") == .off)
        #expect(FixedCaps.cap(for: "com.apple.Notes") == .interact)

        let policy = TierPolicy(settings: TierSettings(defaultValue: .interact, apps: ["com.apple.Safari": .interact]))
        #expect(throws: CapabilityError.self) {
            try policy.authorize(.type, bundleId: "com.apple.Safari", appName: "Safari", approvalId: "a")
        }
        #expect((try? policy.authorize(.read, bundleId: "com.apple.Safari", appName: "Safari", approvalId: nil)) != nil)
        // Terminals: clicks yes, typing no.
        #expect((try? policy.authorize(.click, bundleId: "com.apple.Terminal", appName: "Terminal", approvalId: nil)) != nil)
        do {
            try policy.authorize(.type, bundleId: "com.apple.Terminal", appName: "Terminal", approvalId: "a")
            Issue.record("typing into a terminal must be refused")
        } catch let e as CapabilityError {
            #expect(e.code == .policyDenied && e.reason == "tier_click" && e.details["fixedCap"] == true)
            #expect(e.message.contains("click only"))
        } catch { Issue.record("unexpected \(error)") }
    }

    @Test func readOnlyAppRefusesAClickWithAVisibleReason() {
        let policy = TierPolicy(settings: TierSettings(apps: ["com.apple.finder": .read]))
        do {
            try policy.authorize(.click, bundleId: "com.apple.finder", appName: "Finder", approvalId: nil)
            Issue.record("expected refusal")
        } catch let e as CapabilityError {
            #expect(e.code == .policyDenied && e.reason == "tier_read" && e.message.contains("Read only"))
        } catch { Issue.record("unexpected \(error)") }
    }

    @Test func askNeedsAnApprovalThenAllowsForThirtyMinutes() throws {
        let clock = Clock()
        let policy = TierPolicy(settings: TierSettings(defaultValue: .ask), now: { [clock] in clock.now })
        do {
            try policy.authorize(.click, bundleId: "com.apple.Notes", appName: "Notes", approvalId: nil)
            Issue.record("expected approval_required")
        } catch let e as CapabilityError {
            #expect(e.code == .approvalRequired && e.details["tierRequired"] == "click")
        }
        try policy.authorize(.click, bundleId: "com.apple.Notes", appName: "Notes", approvalId: "appr_1")
        try policy.authorize(.type, bundleId: "com.apple.Notes", appName: "Notes", approvalId: nil)
        #expect(policy.effectiveTier(for: "com.apple.Notes") == .interact)
        clock.now = clock.now.addingTimeInterval(31 * 60)
        #expect(policy.effectiveTier(for: "com.apple.Notes") == .off)
        #expect(throws: CapabilityError.self) {
            try policy.authorize(.click, bundleId: "com.apple.Notes", appName: "Notes", approvalId: nil)
        }
    }

    @Test func settingsFileParses() throws {
        let json = #"{"version":1,"default":"read","apps":{"com.apple.Notes":"interact","com.apple.Mail":"off"}}"#
        let s = try JSONDecoder().decode(TierSettings.self, from: Data(json.utf8))
        #expect(s.value(for: "com.apple.Notes") == .interact && s.value(for: "com.apple.mail") == .off)
        #expect(s.value(for: "com.example.Other") == .read)
        #expect(TierSettings.load(path: "/nonexistent/x.json") == TierSettings())
        #expect(TierSettings.path(environment: ["PSYCHE_HOME": "/h"]) == "/h/config/computer-use.json")
    }

    @Test func oneSessionAtATime() throws {
        let clock = Clock()
        let lock = ComputerSessionLock(idleTimeout: 60, now: { [clock] in clock.now })
        try lock.acquire("run_a")
        #expect(throws: CapabilityError.self) { try lock.acquire("run_b") }
        try lock.acquire("run_a")
        clock.now = clock.now.addingTimeInterval(61)
        try lock.acquire("run_b")
        #expect(lock.activeSession == "run_b")
        lock.release("run_b")
        #expect(lock.activeSession == nil)
    }

    @Test func stopSignalTripsAndResets() throws {
        let stop = StopSignal()
        _ = stop.begin()
        try stop.check()
        stop.trip()
        #expect(throws: CapabilityError.stopped) { try stop.check() }
        _ = stop.begin()
        try stop.check()
    }

    @Test func keyChordsParse() throws {
        let c = try KeyChord.parse("cmd+shift+T")
        #expect(c.keyCode == 17 && c.flags.contains(.maskCommand) && c.flags.contains(.maskShift))
        #expect(try KeyChord.parse("return").keyCode == 36)
        #expect(try KeyChord.parse("f12").keyCode == 111)
        #expect(try KeyChord.parse("escape").isBareEscape)
        #expect(try KeyChord.parse("cmd+q").isHighRisk && !(try KeyChord.parse("cmd+c").isHighRisk))
        #expect(throws: CapabilityError.self) { try KeyChord.parse("cmd+") }
        #expect(throws: CapabilityError.self) { try KeyChord.parse("hyper+x") }
        #expect(throws: CapabilityError.self) { try KeyChord.parse("a+b") }
    }

    @Test func typingChunksNeverSplitGraphemes() {
        let text = String(repeating: "ab", count: 10) + "👩‍👩‍👧‍👦" + "é"
        let chunks = TypingChunks.split(text, maxUnits: 16)
        #expect(chunks.allSatisfy { $0.count <= 16 || String(utf16CodeUnits: $0, count: $0.count).count == 1 })
        #expect(chunks.map { String(utf16CodeUnits: $0, count: $0.count) }.joined() == text)
    }

    @Test func captureExcludesPsycheTerminalsAndOffApps() {
        let policy = TierPolicy(settings: TierSettings(defaultValue: .ask, apps: ["com.apple.Notes": .read]))
        let running: [CaptureHygiene.AppRef] = [
            .init(bundleId: "com.psyche.desktop", pid: 10), .init(bundleId: "com.apple.Terminal", pid: 11),
            .init(bundleId: "com.1password.1password", pid: 12), .init(bundleId: "com.apple.Notes", pid: 13),
            .init(bundleId: "com.apple.dock", pid: 14), .init(bundleId: "com.example.Unknown", pid: 15),
        ]
        let excluded = CaptureHygiene.excludedPids(running: running, ownPid: 99, policy: policy)
        #expect(excluded == [99, 10, 11, 12, 15])
    }

    @Test func capturesAreDownscaledNotUpscaled() {
        #expect(CaptureHygiene.scaledSize(width: 3456, height: 2234) == (1372, 887))
        #expect(CaptureHygiene.scaledSize(width: 800, height: 600) == (800, 600))
        #expect(CaptureHygiene.scaledSize(width: 5120, height: 1440) == (1372, 386))
    }

    @Test func permissionOrderStartsWithAccessibility() {
        #expect(PermissionCatalog.order.first == .accessibility)
        #expect(PermissionCatalog.next(granted: [], wanted: [.screenRecording, .accessibility]) == .accessibility)
        #expect(PermissionCatalog.next(granted: [.accessibility], wanted: [.accessibility]) == nil)
        for p in TCCPermission.allCases {
            let e = PermissionCatalog.entry(p)
            #expect(e.settingsURL.hasPrefix("x-apple.systempreferences:"))
            #expect(!e.explanation.isEmpty)
        }
        #expect(PermissionCatalog.entry(.fullDiskAccess).style == .settingsOnly)
        #expect(PermissionCatalog.order.count == TCCPermission.allCases.count)
    }
}
