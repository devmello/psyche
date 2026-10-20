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
            try policy.authorize(.type, bundleId: "com.apple.Safari", appName: "Safari", approval: ApprovalBinding(id: "a", app: "com.apple.Safari", tier: .interact))
        }
        #expect((try? policy.authorize(.read, bundleId: "com.apple.Safari", appName: "Safari", approval: nil)) != nil)
        // Terminals: clicks yes, typing no.
        #expect((try? policy.authorize(.click, bundleId: "com.apple.Terminal", appName: "Terminal", approval: nil)) != nil)
        do {
            try policy.authorize(.type, bundleId: "com.apple.Terminal", appName: "Terminal", approval: ApprovalBinding(id: "a", app: "com.apple.Terminal", tier: .interact))
            Issue.record("typing into a terminal must be refused")
        } catch let e as CapabilityError {
            #expect(e.code == .policyDenied && e.reason == "tier_click" && e.details["fixedCap"] == true)
            #expect(e.message.contains("click only"))
        } catch { Issue.record("unexpected \(error)") }
    }

    @Test func readOnlyAppRefusesAClickWithAVisibleReason() {
        let policy = TierPolicy(settings: TierSettings(apps: ["com.apple.finder": .read]))
        do {
            try policy.authorize(.click, bundleId: "com.apple.finder", appName: "Finder", approval: nil)
            Issue.record("expected refusal")
        } catch let e as CapabilityError {
            #expect(e.code == .policyDenied && e.reason == "tier_read" && e.message.contains("Read only"))
        } catch { Issue.record("unexpected \(error)") }
    }

    @Test func askNeedsAnApprovalThenAllowsForThirtyMinutes() throws {
        let clock = Clock()
        let policy = TierPolicy(settings: TierSettings(defaultValue: .ask), now: { [clock] in clock.now })
        do {
            try policy.authorize(.click, bundleId: "com.apple.Notes", appName: "Notes", approval: nil)
            Issue.record("expected approval_required")
        } catch let e as CapabilityError {
            #expect(e.code == .approvalRequired && e.details["tierRequired"] == "click")
        }
        try policy.authorize(.click, bundleId: "com.apple.Notes", appName: "Notes", approval: ApprovalBinding(id: "appr_1", app: "com.apple.Notes", tier: .interact))
        try policy.authorize(.type, bundleId: "com.apple.Notes", appName: "Notes", approval: nil)
        #expect(policy.effectiveTier(for: "com.apple.Notes") == .interact)
        clock.now = clock.now.addingTimeInterval(31 * 60)
        #expect(policy.effectiveTier(for: "com.apple.Notes") == .off)
        #expect(throws: CapabilityError.self) {
            try policy.authorize(.click, bundleId: "com.apple.Notes", appName: "Notes", approval: nil)
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
        try lock.acquire("run_c")
        #expect(lock.stopActive() == "run_c")
        #expect(throws: CapabilityError.stopped) { try lock.acquire("run_c") }
        try lock.acquire("run_d")
    }

    @Test func stopSignalStopsOnlyInvocationsIssuedBeforeEsc() async throws {
        let stop = StopSignal()
        try await stop.run {
            try stop.check()
            stop.trip()
            #expect(throws: CapabilityError.stopped) { try stop.check() }
        }
        // A later invocation starts clean.
        try await stop.run { try stop.check() }
        // An invocation that was in flight when Esc was pressed stays stopped.
        let (started, release) = AsyncStream<Void>.makeStream()
        let inflight = _Concurrency.Task {
            try await stop.run {
                release.yield()
                try await _Concurrency.Task.sleep(nanoseconds: 50_000_000)
                try stop.check()
            }
        }
        for await _ in started { break }
        stop.trip()
        await #expect(throws: CapabilityError.stopped) { try await inflight.value }
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

@Suite("risky labels")
struct RiskLabelTests {
    @Test func destructiveAndDataCreatingLabelsAreRisky() {
        #expect(RiskLabels.isRisky(label: "Move to Trash"))
        #expect(RiskLabels.isRisky(label: nil, customAction: "trash"))
        #expect(RiskLabels.isRisky(label: "Add List: Groceries"))
        #expect(RiskLabels.isRisky(label: "Send"))
        #expect(!RiskLabels.isRisky(label: "New Note"))
        #expect(!RiskLabels.isRisky(label: "Sender details"))  // whole words only
        #expect(!RiskLabels.isRisky(label: "Add Reminder"))
    }
}

@Suite("threat-model fixes: caps, approval binding, menu tier (#266, #267, #269)")
struct ThreatModelTierTests {
    @Test func psycheApprovalSurfacesAndSystemAgentsAreOff() {
        // #269: Notification Center draws Psyche's approval banners; never pressable by the agent.
        for id in ["com.apple.notificationcenterui", "com.apple.UserNotificationCenter", "com.apple.SecurityAgent",
                   "com.apple.systempreferences", "com.apple.SystemSettings", "com.apple.LocalAuthentication.UIAgent", "com.apple.loginwindow"] {
            #expect(FixedCaps.cap(for: id) == .off, "\(id)")
        }
        // Parity with the broker's LOCKED_OFF_APPS (packages/permissions/src/apps.ts).
        for id in ["com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop", "com.lastpass.LastPass",
                   "com.dashlane.Dashlane", "com.apple.Passwords", "com.apple.keychainaccess", "com.robinhood.app", "com.coinbase.pro",
                   "com.schwab.app", "com.fidelity.app", "com.etrade.app", "com.webull.app", "com.interactivebrokers.tws", "com.paypal.app",
                   "com.chase.app", "com.psyche.desktop", "com.psyche.helper"] {
            #expect(FixedCaps.cap(for: id) == .off, "\(id)")
        }
        let policy = TierPolicy(settings: TierSettings(defaultValue: .interact))
        do {
            try policy.authorize(.click, bundleId: "com.apple.notificationcenterui", appName: "Notification Center",
                                 approval: ApprovalBinding(id: "apr_1", app: "com.apple.notificationcenterui", tier: .click))
            Issue.record("clicked Notification Center")
        } catch let e as CapabilityError {
            #expect(e.code == .policyDenied && e.details["fixedCap"] == true)
        } catch { Issue.record("unexpected \(error)") }
    }

    @Test func approvalsBindToTheNamedAppAndTier() throws {
        let policy = TierPolicy(settings: TierSettings(defaultValue: .ask))
        // #267: an approval for Notes does not authorize the app under the point.
        do {
            try policy.authorize(.click, bundleId: "com.apple.MobileSMS", appName: "Messages",
                                 approval: ApprovalBinding(id: "apr_1", app: "com.apple.Notes", tier: .click))
            Issue.record("approval for Notes reached Messages")
        } catch let e as CapabilityError {
            #expect(e.reason == "approval_app_mismatch")
        }
        #expect(throws: CapabilityError.self) {
            try policy.authorize(.click, bundleId: "com.apple.systempreferences", appName: "System Settings",
                                 approval: ApprovalBinding(id: "apr_1", app: "com.apple.systempreferences", tier: .click))
        }
        // An approval for click grants click only, not 30 minutes of interact.
        try policy.authorize(.click, bundleId: "com.apple.Notes", appName: "Notes", approval: ApprovalBinding(id: "apr_2", app: "com.apple.Notes", tier: .click))
        #expect(policy.effectiveTier(for: "com.apple.Notes") == .click)
        do {
            try policy.authorize(.type, bundleId: "com.apple.Notes", appName: "Notes", approval: nil)
            Issue.record("typing without a fresh approval")
        } catch let e as CapabilityError {
            #expect(e.code == .approvalRequired)
        }
        // A click-tier approval cannot authorize typing either.
        do {
            try policy.authorize(.type, bundleId: "com.apple.Notes", appName: "Notes", approval: ApprovalBinding(id: "apr_3", app: "com.apple.Notes", tier: .click))
            Issue.record("click approval authorized typing")
        } catch let e as CapabilityError {
            #expect(e.reason == "approval_tier_too_low")
        }
        // An approvalId without a binding approves nothing.
        #expect(ApprovalBinding.from(approvalId: "apr_4", params: ["x": 1]) == nil)
        #expect(ApprovalBinding.from(approvalId: "apr_4", params: ["approval": ["app": "com.apple.Notes", "tier": "interact"]])
            == ApprovalBinding(id: "apr_4", app: "com.apple.Notes", tier: .interact))
        #expect(ApprovalBinding.from(approvalId: nil, params: ["approval": ["app": "com.apple.Notes", "tier": "interact"]]) == nil)
    }

    @Test func clicksOnMenuItemsNeedInteract() {
        // #266: AXPress on a menu item runs an app command (Terminal Shell>New Command…).
        #expect(ComputerIntent.click.escalated(forRole: "AXMenuItem") == .menu)
        #expect(ComputerIntent.press.escalated(forRole: "AXMenuBarItem") == .menu)
        #expect(ComputerIntent.click.escalated(forRole: "AXPopUpButton") == .menu)
        #expect(ComputerIntent.click.escalated(forRole: "AXButton") == .click)
        #expect(ComputerIntent.scroll.escalated(forRole: "AXMenuItem") == .scroll)
        let policy = TierPolicy(settings: TierSettings(defaultValue: .interact))
        do {
            try policy.authorize(ComputerIntent.click.escalated(forRole: "AXMenuItem"), bundleId: "com.apple.Terminal", appName: "Terminal", approval: nil)
            Issue.record("menu command in a click-only app")
        } catch let e as CapabilityError {
            #expect(e.code == .policyDenied && e.reason == "tier_click")
        } catch { Issue.record("unexpected \(error)") }
        #expect((try? policy.authorize(.click, bundleId: "com.apple.Terminal", appName: "Terminal", approval: nil)) != nil)
    }
}

@Suite("send-equivalent keys (#270)")
struct SendKeysTests {
    @Test func returnAndMailSendChordsSendInMessagingApps() throws {
        for app in ["com.apple.MobileSMS", "com.apple.mail", "com.tinyspeck.slackmacgap", "net.whatsapp.WhatsApp", "com.microsoft.Outlook"] {
            #expect(SendKeys.isMessagingApp(app), "\(app)")
        }
        #expect(!SendKeys.isMessagingApp("com.apple.Notes") && !SendKeys.isMessagingApp(nil))
        for chord in ["return", "enter", "cmd+return", "shift+return", "keypadenter", "cmd+shift+d"] {
            #expect(SendKeys.isSendChord(try KeyChord.parse(chord)), "\(chord)")
        }
        for chord in ["tab", "cmd+d", "shift+d", "escape"] {
            #expect(!SendKeys.isSendChord(try KeyChord.parse(chord)), "\(chord)")
        }
        #expect(SendKeys.textSends("see you\n") && SendKeys.textSends("a\rb") && SendKeys.textSends("x\u{2028}"))
        #expect(!SendKeys.textSends("no line break"))
    }
}

private final class OwnerInput: @unchecked Sendable {
    var last: Date?
}

@Suite("pause-when-unwatched (#272)")
struct AttentionTests {
    private func policy(_ clock: Clock, _ input: OwnerInput, settings: TierSettings = TierSettings(defaultValue: .interact)) -> TierPolicy {
        TierPolicy(settings: settings, now: { clock.now }, ownerInput: { input.last })
    }

    private func reason(_ body: () throws -> Void) -> String? {
        do {
            try body()
            return nil
        } catch let e as CapabilityError {
            return e.reason
        } catch { return "\(error)" }
    }

    @Test func sensitiveAppsWaitWithoutOwnerInputForFiveMinutes() {
        let clock = Clock()
        let input = OwnerInput()
        let p = policy(clock, input)
        // No owner input on record: a click in Terminal parks; reading and scrolling do not.
        do {
            try p.authorize(.click, bundleId: "com.apple.Terminal", appName: "Terminal", approval: nil)
            Issue.record("expected awaiting_attention")
        } catch let e as CapabilityError {
            #expect(e.code == .presenceRequired && e.reason == "awaiting_attention" && e.retryable)
            #expect(e.details["windowSeconds"] == .number(300))
        } catch { Issue.record("unexpected \(error)") }
        #expect(reason { try p.authorize(.read, bundleId: "com.apple.Terminal", appName: "Terminal", approval: nil) } == nil)
        #expect(reason { try p.authorize(.scroll, bundleId: "com.apple.Terminal", appName: "Terminal", approval: nil) } == nil)

        input.last = clock.now.addingTimeInterval(-299)
        #expect(reason { try p.authorize(.click, bundleId: "com.apple.Terminal", appName: "Terminal", approval: nil) } == nil)
        #expect(reason { try p.authorize(.key, bundleId: "com.apple.MobileSMS", appName: "Messages", approval: nil) } == nil)
        clock.now = clock.now.addingTimeInterval(2)
        #expect(reason { try p.authorize(.click, bundleId: "com.apple.Terminal", appName: "Terminal", approval: nil) } == "awaiting_attention")
        #expect(reason { try p.authorize(.type, bundleId: "com.apple.mail", appName: "Mail", approval: nil) } == "awaiting_attention")
        // Other apps never wait.
        #expect(reason { try p.authorize(.type, bundleId: "com.apple.Notes", appName: "Notes", approval: nil) } == nil)
    }

    @Test func anApprovalIsNotAttention() {
        let clock = Clock()
        let input = OwnerInput()
        let p = policy(clock, input, settings: TierSettings(defaultValue: .ask))
        let approval = ApprovalBinding(id: "a", app: "com.apple.mail", tier: .interact)
        // It parks before asking, so no card is shown for an action that cannot run.
        #expect(reason { try p.authorize(.type, bundleId: "com.apple.mail", appName: "Mail", approval: nil) } == "awaiting_attention")
        #expect(reason { try p.authorize(.type, bundleId: "com.apple.mail", appName: "Mail", approval: approval) } == "awaiting_attention")
        input.last = clock.now
        #expect(reason { try p.authorize(.type, bundleId: "com.apple.mail", appName: "Mail", approval: nil) } == "tier_ask")
        #expect(reason { try p.authorize(.type, bundleId: "com.apple.mail", appName: "Mail", approval: approval) } == nil)
    }

    @Test func refusalsComeFirstAndTheOwnerListCounts() {
        let clock = Clock()
        let input = OwnerInput()
        let settings = TierSettings(defaultValue: .interact, apps: ["com.apple.Notes": .read], sensitive: ["com.apple.Notes", "com.example.Health"])
        let p = policy(clock, input, settings: settings)
        #expect(reason { try p.authorize(.type, bundleId: "com.apple.Notes", appName: "Notes", approval: nil) } == "tier_read")
        #expect(reason { try p.authorize(.type, bundleId: "com.apple.Terminal", appName: "Terminal", approval: nil) } == "tier_click")
        #expect(reason { try p.authorize(.click, bundleId: "com.example.health", appName: "Health", approval: nil) } == "awaiting_attention")
        let decoded = try? JSONDecoder().decode(TierSettings.self, from: Data(#"{"default":"ask","sensitive":["com.example.Health"]}"#.utf8))
        #expect(decoded?.sensitive == ["com.example.Health"])
        #expect(Attention.isSensitive("com.jetbrains.intellij", settings: TierSettings()))
        #expect(!Attention.isSensitive("com.apple.Notes", settings: TierSettings()))
    }
}
