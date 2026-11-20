import AppKit
import Carbon
import Foundation
import OSAKit
import PsycheHelperCore
import PsycheProtocol
import Security
import UniformTypeIdentifiers

/// `apps.*` (J2 open/focus, J4 Apple Events and Shortcuts). AppleScript and JXA run in-process so
/// the Automation prompt names Psyche Helper and each target app is asked once (security §12).
public enum AppsCapabilities {
    public static func make(_ cu: ComputerUse) -> [any CapabilityHandler] {
        [list(cu), resolve(), open(cu), focus(cu), applescript(cu), jxa(cu), shortcutRun(cu), shortcutsList()]
    }

    // MARK: Running apps

    static func list(_ cu: ComputerUse) -> Capability {
        Capability(CapabilitySpec(
            name: "apps.list", description: "Running apps with a Dock presence: bundle id, name, pid, frontmost, and the computer-use tier in effect.",
            sideEffect: .read, inputSchema: Schema.object(["all": Schema.boolean("Include background agents")])
        )) { ctx in
            struct P: Decodable { var all: Bool? }
            let p = try ctx.decode(P.self)
            cu.reloadSettings()
            let apps = NSWorkspace.shared.runningApplications.filter { p.all == true || $0.activationPolicy == .regular }
            return CapabilityOutput(["apps": .array(apps.map { a in
                [
                    "bundleId": a.bundleIdentifier.map { .string($0) } ?? .null, "name": .string(a.localizedName ?? ""),
                    "pid": .int(Int(a.processIdentifier)), "active": .bool(a.isActive), "hidden": .bool(a.isHidden),
                    "tier": .string(cu.policy.effectiveTier(for: a.bundleIdentifier).rawValue),
                    "fixedCap": .string(cu.policy.fixedCap(for: a.bundleIdentifier).rawValue),
                ]
            })])
        }
    }

    struct AppRefParams: Decodable {
        var app: String?
        var bundleId: String?
        var name: String?
        var url: String?
        var expectPath: String?
    }

    static let appFolders = AppLaunchPolicy.appFolders(home: NSHomeDirectory())

    /// Resolves an installed app. Names are plain names (no `/`, no `..`); a bundle id must name
    /// exactly one bundle on disk. Either way the bundle must sit in an Applications folder, not
    /// inside another app, carry the id it was asked for, and an Apple id must be Apple's own
    /// signed copy (`AppLaunchPolicy`), so an agent-written bundle or a lookalike never launches.
    static func applicationURL(_ p: AppRefParams, lookups: AppLaunchPolicy.Lookups = LiveAppLookups.lookups) throws -> URL {
        let home = NSHomeDirectory()
        if let id = p.bundleId ?? p.app, id.contains("."), !id.contains("/"), !lookups.candidates(id).isEmpty {
            return try AppLaunchPolicy.resolve(bundleId: id, home: home, lookups: lookups)
        }
        if let name = p.name ?? p.app {
            guard !name.contains("/"), !name.contains(".."), !name.isEmpty else {
                throw CapabilityError.invalidParams("app name must be a plain name", field: "name")
            }
            for dir in appFolders {
                let candidate = URL(fileURLWithPath: dir).appendingPathComponent(name.hasSuffix(".app") ? name : name + ".app")
                if FileManager.default.fileExists(atPath: candidate.path) {
                    let url = URL(fileURLWithPath: AppLaunchPolicy.canonical(candidate))
                    try AppLaunchPolicy.check(url, requestedId: nil, home: home, lookups: lookups)
                    return url
                }
            }
        }
        throw CapabilityError(.notFound, reason: "app_not_found", "No installed app matches \(p.bundleId ?? p.name ?? p.app ?? "")")
    }

    /// Document types that run code when opened (`AppLaunchPolicy.executableExtensions`).
    static var executableExtensions: Set<String> { AppLaunchPolicy.executableExtensions }

    /// What the item a `file:` URL leads to is, read from the file system (resource values and
    /// the system's type database; nothing is registered or opened).
    static func documentFacts(_ resolved: URL) -> AppLaunchPolicy.DocumentFacts {
        let path = resolved.path
        let keys: Set<URLResourceKey> = [.isDirectoryKey, .isPackageKey, .isExecutableKey, .isAliasFileKey, .isRegularFileKey, .contentTypeKey]
        guard let v = try? resolved.resourceValues(forKeys: keys) else { return .init(path: path, exists: false) }
        let fm = FileManager.default
        let isDirectory = v.isDirectory ?? false
        let bundleShaped = isDirectory
            && (fm.fileExists(atPath: resolved.appendingPathComponent("Contents/Info.plist").path)
                || fm.fileExists(atPath: resolved.appendingPathComponent("Info.plist").path))
        let type = v.contentType
        let conforms = { (ids: [String]) in
            guard let type else { return false }
            return ids.contains { id in UTType(id).map { type.conforms(to: $0) } ?? (type.identifier == id) }
        }
        return .init(
            path: path, exists: true, isDirectory: isDirectory, isPackage: v.isPackage ?? false,
            isExecutable: (v.isRegularFile ?? false) && (v.isExecutable ?? false), isAlias: v.isAliasFile ?? false,
            bundleShaped: bundleShaped, contentType: type?.identifier,
            executableType: conforms(AppLaunchPolicy.executableTypes), documentPackage: conforms(AppLaunchPolicy.documentPackageTypes)
        )
    }

    /// The URL a document is opened from: resolved first (symlinks, `.` and `..`), checked as the
    /// item it is (`AppLaunchPolicy.checkDocument`), and that resolved URL is what opens.
    static func checkedDocumentURL(_ u: URL, facts: (URL) -> AppLaunchPolicy.DocumentFacts = documentFacts) throws -> URL {
        let resolved = URL(fileURLWithPath: AppLaunchPolicy.canonical(u))
        try AppLaunchPolicy.checkDocument(facts(resolved), requested: u.path)
        return resolved
    }

    static func resolve() -> Capability {
        Capability(CapabilitySpec(
            name: "apps.resolve",
            description: "Which installed app a bundle id opens, without opening it: its bundle id, name and real path, or why apps.open would refuse it.",
            sideEffect: .read, targetKind: .app,
            inputSchema: Schema.object(["bundleId": Schema.string("Bundle id")], required: ["bundleId"])
        )) { ctx in
            let p = try ctx.decode(AppRefParams.self)
            guard let id = p.bundleId, !id.isEmpty else { throw CapabilityError.invalidParams("bundleId is required", field: "bundleId") }
            let url = try applicationURL(AppRefParams(bundleId: id))
            let bundle = Bundle(url: url)
            let name = (bundle?.localizedInfoDictionary?["CFBundleDisplayName"] as? String)
                ?? (bundle?.infoDictionary?["CFBundleDisplayName"] as? String)
                ?? (bundle?.infoDictionary?["CFBundleName"] as? String)
                ?? url.deletingPathExtension().lastPathComponent
            return CapabilityOutput([
                "bundleId": .string(bundle?.bundleIdentifier ?? id), "name": .string(name), "path": .string(url.path),
                "fixedCap": .string(min(FixedCaps.cap(for: id), LiveAppLookups.infoCap(id)).rawValue),
            ])
        }
    }

    static func open(_ cu: ComputerUse) -> Capability {
        Capability(CapabilitySpec(
            name: "apps.open", description: "Open (launch or bring forward) an app by bundle id or name, optionally with a document or URL.",
            sideEffect: .write, targetKind: .app,
            inputSchema: Schema.object([
                "app": Schema.string("Bundle id or name"), "bundleId": Schema.string(), "name": Schema.string(),
                "url": Schema.string("file:// or https:// URL to open with the app"),
                "expectPath": Schema.string("The bundle path apps.resolve gave; the call is refused when the id now opens another bundle"),
            ]),
            receiptKind: "app_open"
        )) { ctx in
            try cu.refuseWhileRecording()
            let p = try ctx.decode(AppRefParams.self)
            let appURL = try applicationURL(p)
            if let expected = p.expectPath, AppLaunchPolicy.canonical(URL(fileURLWithPath: expected)) != appURL.path {
                throw CapabilityError(.conflict, reason: "app_changed", "\(p.bundleId ?? p.app ?? "The app") now opens \(appURL.path), not \(expected)",
                                      details: ["path": .string(appURL.path), "expected": .string(expected)])
            }
            let bundleId = Bundle(url: appURL)?.bundleIdentifier
            let category = FixedCaps.category(of: bundleId)
            if category == .passwordManager || category == .finance {
                throw CapabilityError(.policyDenied, reason: "tier_off", "Psyche does not open password managers or finance apps")
            }
            // LaunchServices brings a running instance forward instead of the bundle named here.
            if let bundleId { try CheckedLaunch.refuseRunningElsewhere(bundleId, expected: appURL) }
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            let running: NSRunningApplication
            if let s = p.url {
                guard let u = URL(string: s), ["file", "https", "http", "mailto"].contains(u.scheme?.lowercased() ?? "") else {
                    throw CapabilityError.invalidParams("url must be file, http(s) or mailto", field: "url")
                }
                var target = u
                if u.isFileURL {
                    // Opening a document in a terminal, IDE or script runner runs it.
                    let shellLike = category == .terminalOrIDE || bundleId.map { LiveAppLookups.infoCap($0) < .interact } == true
                    if shellLike {
                        throw CapabilityError(.policyDenied, reason: "executable_document", "Psyche does not open documents in terminals, IDEs or script runners")
                    }
                    target = try checkedDocumentURL(u)
                }
                running = try await NSWorkspace.shared.open([target], withApplicationAt: appURL, configuration: config)
            } else {
                running = try await NSWorkspace.shared.openApplication(at: appURL, configuration: config)
            }
            try AppLaunchPolicy.checkLaunched(bundleId: bundleId ?? appURL.path, expected: appURL, launched: running.bundleURL)
            let name = running.localizedName ?? appURL.deletingPathExtension().lastPathComponent
            return CapabilityOutput(
                [
                    "bundleId": running.bundleIdentifier.map { .string($0) } ?? .null, "name": .string(name),
                    "pid": .int(Int(running.processIdentifier)), "path": .string(appURL.path),
                ],
                receipt: ReceiptDraft(outcome: .ok, summary: "Opened \(name)", externalRefs: ["app": .string(running.bundleIdentifier ?? name)])
            )
        }
    }

    static func focus(_ cu: ComputerUse) -> Capability {
        Capability(ComputerCapabilities.withApprovalParam(CapabilitySpec(
            name: "apps.focus", description: "Bring a running app to the front, optionally raising one of its windows by index.",
            sideEffect: .write, targetKind: .app,
            inputSchema: Schema.object(["app": Schema.string(), "window": Schema.integer(min: 0)], required: ["app"]),
            receiptKind: "computer_action"
        ))) { ctx in
            struct P: Decodable {
                var app: String
                var window: Int?
            }
            let p = try ctx.decode(P.self)
            try cu.refuseWhileRecording()
            let app = try AXEngine.findApp(p.app)
            let target = AXEngine.target(app)
            try cu.policy.authorize(.read, bundleId: target.bundleId, appName: target.name, approval: ComputerCapabilities.binding(ctx))
            app.unhide()
            app.activate()
            if let w = p.window {
                let pid = target.pid
                _ = try await cu.engine.run { _ in
                    let ae = AXUIElementCreateApplication(pid)
                    if let win = AXEngine.window(ae, index: w) { AXUIElementPerformAction(win, kAXRaiseAction as CFString) }
                }
            }
            return CapabilityOutput(["focused": true, "app": .string(target.bundleId ?? target.name)],
                                    receipt: ReceiptDraft(outcome: .ok, summary: "Focused \(target.name)"))
        }
    }

    // MARK: Apple Events

    struct ScriptParams: Decodable {
        var source: String
        var target: String?
        var timeoutSeconds: Int?
    }

    static func scriptSchema(_ language: String) -> JSONValue {
        Schema.object([
            "source": Schema.string("\(language) source", maxLength: 50_000),
            "target": Schema.string("Bundle id of the app the script controls (Automation is asked for it first); every app the script addresses must be this one"),
            "timeoutSeconds": Schema.integer(min: 1, max: 300),
        ], required: ["source", "target"])
    }

    static func applescript(_ cu: ComputerUse) -> Capability {
        Capability(CapabilitySpec(
            name: "apps.applescript",
            description: "Run AppleScript against one target app (osascript, out of process, without the helper's permissions). Destructive, device-only, approved per exact source; shell, ObjC and other apps are refused.",
            sideEffect: .destructive, targetKind: .app, inputSchema: scriptSchema("AppleScript"),
            permissions: [], receiptKind: "apple_event"
        )) { ctx in
            try cu.refuseWhileRecording()
            let p = try ctx.decode(ScriptParams.self)
            try ScriptGuard.check(p.source, language: .appleScript, target: p.target, resolve: AppResolver.bundleId,
                                  cap: { cu.policy.fixedCap(for: $0) })
            let t = p.target ?? ""
            let id = AppResolver.bundleId(t) ?? t
            try CheckedLaunch.checkScriptTarget(id)
            try await AutomationPermission.ensure(bundleId: id, ask: true)
            try CheckedLaunch.checkScriptTarget(id)
            let out = try await OutOfProcessScript.run(source: p.source, language: .appleScript, timeout: TimeInterval(min(300, max(1, p.timeoutSeconds ?? 60))))
            return scriptOutput(out, target: p.target, kind: "AppleScript")
        }
    }

    static func jxa(_ cu: ComputerUse) -> Capability {
        Capability(CapabilitySpec(
            name: "apps.jxa",
            description: "Run JavaScript for Automation against one target app (osascript, out of process, without the helper's permissions). Destructive, device-only, approved per exact source; shell, ObjC bridging and other apps are refused.",
            sideEffect: .destructive, targetKind: .app, inputSchema: scriptSchema("JavaScript for Automation"),
            receiptKind: "apple_event"
        )) { ctx in
            try cu.refuseWhileRecording()
            let p = try ctx.decode(ScriptParams.self)
            try ScriptGuard.check(p.source, language: .javaScript, target: p.target, resolve: AppResolver.bundleId,
                                  cap: { cu.policy.fixedCap(for: $0) })
            let t = p.target ?? ""
            let id = AppResolver.bundleId(t) ?? t
            try CheckedLaunch.checkScriptTarget(id)
            try await AutomationPermission.ensure(bundleId: id, ask: true)
            try CheckedLaunch.checkScriptTarget(id)
            let out = try await OutOfProcessScript.run(source: p.source, language: .javaScript, timeout: TimeInterval(min(300, max(1, p.timeoutSeconds ?? 60))))
            return scriptOutput(out, target: p.target, kind: "JXA")
        }
    }

    static func scriptOutput(_ out: String?, target: String?, kind: String) -> CapabilityOutput {
        let text = out.map { $0.count > 100_000 ? String($0.prefix(100_000)) : $0 }
        return CapabilityOutput(
            ["output": text.map { .string($0) } ?? .null, "provenance": "untrusted"],
            receipt: ReceiptDraft(outcome: .ok, summary: "\(kind) ran\(target.map { " against \($0)" } ?? "")",
                                  externalRefs: target.map { ["app": .string($0)] } ?? [:])
        )
    }

    // MARK: Shortcuts

    static func shortcutRun(_ cu: ComputerUse) -> Capability {
        Capability(CapabilitySpec(
            name: "apps.shortcut_run",
            description: "Run one of the user's Shortcuts by name with optional text input; returns its text output. Runs /usr/bin/shortcuts with responsibility disclaimed, so it does not inherit the helper's permissions.",
            sideEffect: .destructive, targetKind: .app,
            inputSchema: Schema.object([
                "name": Schema.string(maxLength: 256), "input": Schema.string(maxLength: 100_000), "timeoutSeconds": Schema.integer(min: 1, max: 600),
            ], required: ["name"]),
            receiptKind: "shortcut_run"
        )) { ctx in
            struct P: Decodable {
                var name: String
                var input: String?
                var timeoutSeconds: Int?
            }
            try cu.refuseWhileRecording()
            let p = try ctx.decode(P.self)
            // The same runner as shortcuts.run (apple-apps-2026 K2); this name stays for older Gateways.
            let output = try await LiveShortcutsBackend().run(p.name, input: p.input, timeout: TimeInterval(p.timeoutSeconds ?? 120))
            return CapabilityOutput(
                ["output": .string(String(output.prefix(100_000))), "provenance": "untrusted"],
                receipt: ReceiptDraft(outcome: .ok, summary: "Ran shortcut \(p.name)", externalRefs: ["shortcut": .string(p.name)])
            )
        }
    }

    static func shortcutsList() -> Capability {
        Capability(CapabilitySpec(name: "apps.shortcuts_list", description: "Names of the user's Shortcuts (shortcuts.list has ids, folders and inputs).", sideEffect: .read)) { _ in
            let names = try await LiveShortcutsBackend().list().map(\.name)
            return CapabilityOutput(["shortcuts": .array(names.prefix(2000).map { .string($0) })])
        }
    }
}

// MARK: - Live app lookups

/// LaunchServices, Info.plist and code-signing lookups for `AppLaunchPolicy`. All read-only:
/// nothing is registered, launched or prompted for.
enum LiveAppLookups {
    static let lookups = AppLaunchPolicy.Lookups(
        candidates: { NSWorkspace.shared.urlsForApplications(withBundleIdentifier: $0) },
        info: { infoPlist($0) },
        exists: { url in
            var dir: ObjCBool = false
            return FileManager.default.fileExists(atPath: url.path, isDirectory: &dir) && dir.boolValue
        },
        appleSigned: appleSigned
    )

    /// A bundle's Info.plist, read fresh (not `Bundle`'s cache, which outlives a replaced file).
    static func infoPlist(_ url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url.appendingPathComponent("Contents/Info.plist")),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return nil }
        return plist
    }

    /// Apple's own code (`anchor apple`) or Apple's App Store signature, checked statically on
    /// the bundle's executable (resources are not hashed: the bundle sits in a folder no agent
    /// writes). Never prompts.
    @Sendable static func appleSigned(_ url: URL) -> Bool {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code else { return false }
        var requirement: SecRequirement?
        let text = "anchor apple or (anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.9] exists)"
        guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess, let requirement else { return false }
        return SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSDoNotValidateResources), requirement) == errSecSuccess
    }

    private static let cacheLock = NSLock()
    nonisolated(unsafe) private static var capCache: [String: (cap: ComputerTier, at: Date)] = [:]

    /// `click` when any bundle LaunchServices knows for the id says it is a terminal, shell or
    /// developer tool (`FixedCaps.isShellLike`), else `interact`. Cached for a minute.
    @Sendable static func infoCap(_ bundleId: String) -> ComputerTier {
        let key = bundleId.lowercased()
        cacheLock.lock()
        if let hit = capCache[key], Date().timeIntervalSince(hit.at) < 60 {
            cacheLock.unlock()
            return hit.cap
        }
        cacheLock.unlock()
        let shellLike = NSWorkspace.shared.urlsForApplications(withBundleIdentifier: bundleId)
            .contains { infoPlist($0).map(FixedCaps.isShellLike(info:)) ?? false }
        let cap: ComputerTier = shellLike ? .click : .interact
        cacheLock.lock()
        if capCache.count > 512 { capCache.removeAll() }
        capCache[key] = (cap, Date())
        cacheLock.unlock()
        return cap
    }
}

// MARK: - Script execution

/// Resolves an app name or bundle id to an installed bundle id.
/// The id is only a name here: `CheckedLaunch.checkScriptTarget` resolves it to a checked bundle
/// (`AppLaunchPolicy`) before any script runs against it.
enum AppResolver {
    static func bundleId(_ nameOrId: String) -> String? {
        // An agent's script target: judged as an app it could open (`.open`), never a CoreServices agent.
        if nameOrId.contains("."), (try? CheckedLaunch.url(for: nameOrId, purpose: .open)) != nil { return nameOrId }
        let name = nameOrId.hasSuffix(".app") ? nameOrId : nameOrId + ".app"
        guard !name.contains("/"), !name.contains("..") else { return nil }
        for dir in AppsCapabilities.appFolders {
            let url = URL(fileURLWithPath: dir).appendingPathComponent(name)
            if let id = LiveAppLookups.infoPlist(url)?["CFBundleIdentifier"] as? String { return id }
        }
        return nameOrId.contains(".") ? nameOrId : nil
    }
}

/// Every place the helper launches an app, or sends one Apple Events, goes through here: the
/// bundle is resolved and checked (`AppLaunchPolicy`), that exact bundle is what launches, and a
/// running instance must be that bundle. Never "whatever LaunchServices prefers".
enum CheckedLaunch {
    /// The checked bundle for an id. `.scriptTarget` (the default) is for the helper's own
    /// backends; an agent's AppleScript or JXA target is judged `.open`.
    static func url(for bundleId: String, purpose: AppLaunchPolicy.Purpose = .scriptTarget) throws -> URL {
        try AppLaunchPolicy.resolve(bundleId: bundleId, home: NSHomeDirectory(), lookups: LiveAppLookups.lookups, purpose: purpose)
    }

    static func runningURLs(_ bundleId: String) -> [URL?] {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).map(\.bundleURL)
    }

    static func refuseRunningElsewhere(_ bundleId: String, expected: URL) throws {
        try AppLaunchPolicy.checkRunning(bundleId: bundleId, expected: expected, running: runningURLs(bundleId))
    }

    /// Before an agent's script addresses `bundleId`: it resolves to a checked bundle it could
    /// open (`.open`: no CoreServices agents), and a running instance (which receives the Apple
    /// Events) is that bundle.
    static func checkScriptTarget(_ bundleId: String) throws {
        let url = try url(for: bundleId, purpose: .open)
        try refuseRunningElsewhere(bundleId, expected: url)
    }

    /// Launches the checked bundle when the id is not running (hidden in the background when
    /// `hidden`), and checks what runs. Returns true when it launched.
    @discardableResult
    static func ensureRunning(_ bundleId: String, hidden: Bool) async throws -> Bool {
        let url = try url(for: bundleId)
        let running = runningURLs(bundleId)
        if !running.isEmpty {
            try AppLaunchPolicy.checkRunning(bundleId: bundleId, expected: url, running: running)
            return false
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = !hidden
        config.hides = hidden
        let app = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
        try AppLaunchPolicy.checkLaunched(bundleId: bundleId, expected: url, launched: app.bundleURL)
        return true
    }
}

/// Runs a checked script out of process (#268): `/usr/bin/osascript` spawned with responsibility
/// disclaimed and a minimal environment, the source on stdin, with a timeout. The script never
/// holds the helper's Accessibility or Full Disk Access, and a hung script cannot block the
/// helper's main thread.
enum OutOfProcessScript {
    static func run(source: String, language: ScriptGuard.Language, timeout: TimeInterval) async throws -> String {
        let lang = language == .appleScript ? "AppleScript" : "JavaScript"
        let r = try await DisclaimedProcess.run("/usr/bin/osascript", ["-l", lang, "-"], stdin: Data(source.utf8), timeout: timeout)
        guard r.status == 0 else {
            if r.stderr.contains("-1743") {
                throw CapabilityError(.forbidden, reason: "automation_denied", "Automation was denied for the target app. Allow it in System Settings › Privacy & Security › Automation.")
            }
            throw CapabilityError(.unavailable, reason: "script_error", "The script failed", details: ["stderr": .string(String(r.stderr.prefix(500)))])
        }
        return r.stdout.hasSuffix("\n") ? String(r.stdout.dropLast()) : r.stdout
    }
}

/// NSAppleScript / OSAScript are not thread-safe; run on the main thread with a timeout.
enum MainThreadScript {
    static func run(source: String, language: String) async throws -> String? {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String?, Error>) in
            DispatchQueue.main.async {
                guard let lang = OSALanguage(forName: language) else {
                    cont.resume(throwing: CapabilityError.unavailable("osa_language_missing", "\(language) is not available"))
                    return
                }
                let script = OSAScript(source: source, language: lang)
                var error: NSDictionary?
                let result = script.executeAndReturnError(&error)
                if let error {
                    let number = (error[OSAScriptErrorNumberKey] as? NSNumber)?.intValue ?? 0
                    let message = (error[OSAScriptErrorMessageKey] as? String) ?? "script error"
                    if number == -1743 {
                        cont.resume(throwing: CapabilityError(.forbidden, reason: "automation_denied", "Automation was denied for the target app. Allow it in System Settings › Privacy & Security › Automation."))
                    } else {
                        cont.resume(throwing: CapabilityError(.unavailable, reason: "script_error", String(message.prefix(500)), details: ["osaError": .int(number)]))
                    }
                    return
                }
                cont.resume(returning: result?.stringValue ?? result.map { String(describing: $0) })
            }
        }
    }
}

/// Per-target Automation preflight (`AEDeterminePermissionToAutomateTarget`).
public enum AutomationPermission {
    public enum State: String, Sendable { case granted, denied, notDetermined, notRunning, unknown }

    public static func state(bundleId: String, ask: Bool) -> State {
        let target = NSAppleEventDescriptor(bundleIdentifier: bundleId)
        guard let desc = target.aeDesc else { return .unknown }
        let status = AEDeterminePermissionToAutomateTarget(desc, typeWildCard, typeWildCard, ask)
        switch status {
        case noErr: return .granted
        case OSStatus(errAEEventNotPermitted): return .denied
        case OSStatus(errAEEventWouldRequireUserConsent): return .notDetermined
        case OSStatus(procNotFound): return .notRunning
        default: return .unknown
        }
    }

    /// Asks (off the main thread; the call blocks while the prompt is up) and throws unless granted.
    static func ensure(bundleId: String, ask: Bool) async throws {
        if ask, Self.state(bundleId: bundleId, ask: false) == .notDetermined { try HostAttribution.check(.automation) }  // #570
        let current = await withCheckedContinuation { (cont: CheckedContinuation<State, Never>) in
            DispatchQueue.global(qos: .userInitiated).async { cont.resume(returning: Self.state(bundleId: bundleId, ask: ask)) }
        }
        switch current {
        case .granted: return
        case .notRunning:
            throw CapabilityError(.unavailable, reason: "app_not_running", "\(bundleId) must be running before Automation can be asked; open it with apps.open")
        case .denied:
            throw CapabilityError(.forbidden, reason: "automation_denied", "Automation of \(bundleId) is denied. Allow it in System Settings › Privacy & Security › Automation.",
                                  details: ["permission": "automation", "target": .string(bundleId)])
        default:
            throw CapabilityError(.forbidden, reason: "automation_not_granted", "Automation of \(bundleId) is not granted",
                                  details: ["permission": "automation", "target": .string(bundleId)])
        }
    }
}
