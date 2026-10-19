import Foundation
import PsycheProtocol

/// Per-app computer-use tier (feature F6, J5; architecture §6; security §12). Ordered: a higher tier
/// includes everything below it. `click` is the terminals/IDEs cap: plain clicks and scrolling,
/// no typing, keys, right-clicks, modifier-clicks, drags or value writes.
public enum ComputerTier: String, Codable, Sendable, Comparable, CaseIterable {
    case off
    case read
    case click
    case interact

    private var rank: Int {
        switch self {
        case .off: 0
        case .read: 1
        case .click: 2
        case .interact: 3
        }
    }

    public static func < (a: ComputerTier, b: ComputerTier) -> Bool { a.rank < b.rank }
}

/// What a `computer.*` call needs.
public enum ComputerIntent: String, Sendable {
    case read  // ax_tree, ax_value, screenshot
    case click  // left click / double click without modifiers
    case scroll
    case rightClick
    case modifierClick
    case type
    case key
    case drag
    case setValue
    case press  // semantic AX action (AXPress, custom actions, menu items)

    public var requiredTier: ComputerTier {
        switch self {
        case .read: .read
        case .click, .scroll, .press: .click
        case .rightClick, .modifierClick, .type, .key, .drag, .setValue: .interact
        }
    }
}

/// Fixed caps that no user setting or chat instruction can raise (architecture §6). Bundle ids are
/// matched exactly, or by prefix for families (`com.jetbrains.`).
public enum FixedCaps {
    public enum Category: String, Sendable {
        case psyche, browser, terminalOrIDE, passwordManager, finance
    }

    /// Psyche's own UI: the agent must never click its own approval cards or settings.
    static let psyche = ["com.psyche.desktop", "com.psyche.helper"]

    static let browsers = [
        "com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.google.Chrome", "com.google.Chrome.beta",
        "com.google.Chrome.dev", "com.google.Chrome.canary", "org.chromium.Chromium", "org.mozilla.firefox",
        "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly", "com.microsoft.edgemac", "com.brave.Browser",
        "company.thebrowser.Browser", "company.thebrowser.dia", "com.operasoftware.Opera", "com.vivaldi.Vivaldi",
        "com.kagi.kagimacOS", "app.zen-browser.zen", "org.torproject.torbrowser", "com.openai.atlas",
    ]

    static let terminalsAndIDEs = [
        "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "net.kovidgoyal.kitty", "io.alacritty",
        "org.alacritty", "com.mitchellh.ghostty", "com.github.wez.wezterm", "co.zeit.hyper", "com.microsoft.VSCode",
        "com.microsoft.VSCodeInsiders", "com.vscodium", "com.todesktop.230313mzl4w4u92", "com.exafunction.windsurf",
        "com.apple.dt.Xcode", "com.jetbrains.", "com.google.android.studio", "com.sublimetext.", "dev.zed.Zed",
        "com.panic.Nova", "com.barebones.bbedit", "com.apple.ScriptEditor2", "com.apple.Automator",
    ]

    static let passwordManagers = [
        "com.1password.1password", "com.agilebits.onepassword7", "com.agilebits.onepassword-osx", "com.bitwarden.desktop",
        "com.lastpass.LastPass", "com.dashlane.dashlanephonefinal", "com.apple.Passwords", "com.apple.keychainaccess",
        "org.keepassxc.keepassxc", "com.enpass.Enpass-Desktop", "com.nordpass.macos.NordPass", "me.proton.pass.electron",
        "com.keepersecurity.passwordmanager",
    ]

    /// Banking, trading and crypto apps (Claude blocks investment/trading/crypto by default).
    static let finance = [
        "com.robinhood.", "com.webull.", "com.interactivebrokers.", "com.tdameritrade.", "com.schwab.", "com.fidelity.",
        "com.etrade.", "com.coinbase.", "com.binance.", "com.kraken.", "com.ledger.live", "com.exodus.", "com.revolut.",
        "com.paypal.", "com.venmo.", "com.squareup.cash", "com.tradingview.tradingviewapp.desktop", "com.metaquotes.",
        "com.wise.", "com.monzo.", "com.chase.", "com.bankofamerica.", "com.wellsfargo.",
    ]

    public static func category(of bundleId: String?) -> Category? {
        guard let id = bundleId?.lowercased() else { return nil }
        func matches(_ list: [String]) -> Bool {
            list.contains { pattern in
                let p = pattern.lowercased()
                return p.hasSuffix(".") ? id.hasPrefix(p) : id == p
            }
        }
        if matches(psyche) { return .psyche }
        if matches(passwordManagers) { return .passwordManager }
        if matches(finance) { return .finance }
        if matches(browsers) { return .browser }
        if matches(terminalsAndIDEs) { return .terminalOrIDE }
        return nil
    }

    /// The highest tier an app can ever get.
    public static func cap(for bundleId: String?) -> ComputerTier {
        switch category(of: bundleId) {
        case .psyche, .passwordManager, .finance: .off
        case .browser: .read
        case .terminalOrIDE: .click
        case nil: .interact
        }
    }
}

/// User tiers from Settings → Computer use, read from `$PSYCHE_HOME/config/computer-use.json`:
///
/// ```json
/// { "version": 1, "default": "ask", "apps": { "com.apple.Notes": "interact", "com.apple.finder": "read" } }
/// ```
///
/// Values: `off`, `read`, `click`, `interact`, or `ask` (prompt on first use: the Gateway asks the
/// user and the invocation carries an `approvalId`). The file is written by the Gateway / desktop
/// settings, never through `node.invoke` (security settings are not reachable that way, §10).
public struct TierSettings: Codable, Sendable, Equatable {
    public enum Value: String, Codable, Sendable {
        case off, read, click, interact, ask
    }

    public var version: Int = 1
    public var defaultValue: Value = .ask
    public var apps: [String: Value] = [:]

    enum CodingKeys: String, CodingKey {
        case version
        case defaultValue = "default"
        case apps
    }

    public init(defaultValue: Value = .ask, apps: [String: Value] = [:]) {
        self.defaultValue = defaultValue
        self.apps = apps
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        defaultValue = try c.decodeIfPresent(Value.self, forKey: .defaultValue) ?? .ask
        apps = try c.decodeIfPresent([String: Value].self, forKey: .apps) ?? [:]
    }

    public func value(for bundleId: String?) -> Value {
        guard let bundleId else { return defaultValue }
        return apps[bundleId] ?? apps.first { $0.key.lowercased() == bundleId.lowercased() }?.value ?? defaultValue
    }

    public static func load(path: String) -> TierSettings {
        guard let data = FileManager.default.contents(atPath: path),
              let settings = try? JSONDecoder().decode(TierSettings.self, from: data)
        else { return TierSettings() }
        return settings
    }

    public static func path(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        (HelperPaths.psycheHome(environment: environment) as NSString).appendingPathComponent("config/computer-use.json")
    }
}

/// Decides whether a `computer.*` call may touch an app: fixed cap ∧ user tier ∧ "Allow for this
/// session" allowances (30 minutes, recorded when the Gateway sends an approved invocation for an
/// app set to `ask`). Thread-safe.
public final class TierPolicy: @unchecked Sendable {
    public static let sessionAllowance: TimeInterval = 30 * 60

    private let lock = NSLock()
    private var settings: TierSettings
    private var allowances: [String: (tier: ComputerTier, until: Date)] = [:]
    private let now: @Sendable () -> Date

    public init(settings: TierSettings = TierSettings(), now: @escaping @Sendable () -> Date = { Date() }) {
        self.settings = settings
        self.now = now
    }

    public func update(_ settings: TierSettings) {
        lock.lock()
        self.settings = settings
        lock.unlock()
    }

    /// The tier in effect now, without considering an approval on the current call.
    public func effectiveTier(for bundleId: String?) -> ComputerTier {
        lock.lock()
        defer { lock.unlock() }
        return effectiveLocked(bundleId)
    }

    private func effectiveLocked(_ bundleId: String?) -> ComputerTier {
        let cap = FixedCaps.cap(for: bundleId)
        let user: ComputerTier
        switch settings.value(for: bundleId) {
        case .off: user = .off
        case .read: user = .read
        case .click: user = .click
        case .interact: user = .interact
        case .ask:
            if let key = bundleId?.lowercased(), let a = allowances[key], a.until > now() {
                user = a.tier
            } else {
                user = .off
            }
        }
        return min(cap, user)
    }

    /// Checks `intent` on `bundleId`. When the user setting is `ask` and the call carries an
    /// approval, records an "Allow for this session" allowance for the approved tier (capped).
    public func authorize(_ intent: ComputerIntent, bundleId: String?, appName: String, approvalId: String?) throws {
        lock.lock()
        defer { lock.unlock() }
        let needed = intent.requiredTier
        let cap = FixedCaps.cap(for: bundleId)
        if cap < needed {
            throw Self.refusal(needed: needed, have: cap, appName: appName, bundleId: bundleId, fixed: true)
        }
        var have = effectiveLocked(bundleId)
        if have < needed, settings.value(for: bundleId) == .ask, approvalId != nil, let key = bundleId?.lowercased() {
            // The Gateway asked the user ("Allow for this session") and approved this call.
            let granted = min(cap, needed == .read ? .read : .interact)
            allowances[key] = (granted, now().addingTimeInterval(Self.sessionAllowance))
            have = granted
        }
        if have < needed {
            if settings.value(for: bundleId) == .ask {
                throw CapabilityError(
                    .approvalRequired, reason: "tier_ask",
                    "\(appName) needs your permission for computer use. Approve it once to allow it for 30 minutes.",
                    details: ["app": .string(bundleId ?? appName), "tierRequired": .string(needed.rawValue)]
                )
            }
            throw Self.refusal(needed: needed, have: have, appName: appName, bundleId: bundleId, fixed: false)
        }
    }

    public func clearAllowances() {
        lock.lock()
        allowances.removeAll()
        lock.unlock()
    }

    static func refusal(needed: ComputerTier, have: ComputerTier, appName: String, bundleId: String?, fixed: Bool) -> CapabilityError {
        let why: String
        switch (have, FixedCaps.category(of: bundleId)) {
        case (.off, .psyche?): why = "Psyche never drives its own windows."
        case (.off, .passwordManager?): why = "Password managers are off limits for computer use."
        case (.off, .finance?): why = "Banking, trading and crypto apps are off limits for computer use."
        case (.read, .browser?): why = "Browsers are read only; use the agent browser to act on the web."
        case (.click, .terminalOrIDE?): why = "Terminals and IDEs are click only (equivalent to shell access)."
        case (.off, _): why = "Computer use is off for this app."
        case (.read, _): why = "This app is set to Read only."
        default: why = "This app is limited to plain clicks."
        }
        return CapabilityError(
            .policyDenied, reason: "tier_\(have.rawValue)",
            "\(appName): \(why)",
            details: [
                "app": .string(bundleId ?? appName), "tier": .string(have.rawValue), "tierRequired": .string(needed.rawValue),
                "fixedCap": .bool(fixed),
            ]
        )
    }
}

/// One computer-use session at a time (J5). A session is identified by the Gateway-supplied
/// `session` param (run id); it lapses after `idleTimeout` without actions.
public final class ComputerSessionLock: @unchecked Sendable {
    private let lock = NSLock()
    private var holder: (id: String, lastUse: Date)?
    public let idleTimeout: TimeInterval
    private let now: @Sendable () -> Date

    public init(idleTimeout: TimeInterval = 120, now: @escaping @Sendable () -> Date = { Date() }) {
        self.idleTimeout = idleTimeout
        self.now = now
    }

    /// Takes or refreshes the lock for `session`; throws `conflict/computer_busy` if another session
    /// holds it.
    public func acquire(_ session: String) throws {
        lock.lock()
        defer { lock.unlock() }
        let t = now()
        if let h = holder, h.id != session, t.timeIntervalSince(h.lastUse) < idleTimeout {
            throw CapabilityError(
                .conflict, reason: "computer_busy", "Another task is using the computer. Try again when it finishes.",
                retryable: true
            )
        }
        holder = (session, t)
    }

    public func release(_ session: String) {
        lock.lock()
        if holder?.id == session { holder = nil }
        lock.unlock()
    }

    public var activeSession: String? {
        lock.lock()
        defer { lock.unlock() }
        guard let h = holder, now().timeIntervalSince(h.lastUse) < idleTimeout else { return nil }
        return h.id
    }
}

/// Global Esc stop (J5: "Esc stops an in-flight action within 200 ms"). The event tap calls
/// `trip()`; long-running actions poll `check()` between steps (each step ≤ ~50 ms).
public final class StopSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var generation = 0
    private var tripped = false

    public init() {}

    /// Marks the start of an action; returns a token for `check`.
    public func begin() -> Int {
        lock.lock()
        defer { lock.unlock() }
        tripped = false
        generation += 1
        return generation
    }

    public func trip() {
        lock.lock()
        tripped = true
        lock.unlock()
    }

    public var isTripped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return tripped
    }

    /// Throws `cancelled/user_stopped` once the user pressed Esc.
    public func check() throws {
        if isTripped { throw CapabilityError.stopped }
        if _Concurrency.Task.isCancelled { throw CapabilityError.cancelled }
    }
}
