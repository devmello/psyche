import AppKit
import Carbon
import Foundation
import OSAKit
import PsycheHelperCore
import PsycheProtocol

/// `apps.*` (J2 open/focus, J4 Apple Events and Shortcuts). AppleScript and JXA run in-process so
/// the Automation prompt names Psyche Helper and each target app is asked once (security §12).
public enum AppsCapabilities {
    public static func make(_ cu: ComputerUse) -> [any CapabilityHandler] {
        [list(cu), open(), focus(cu), applescript(), jxa(), shortcutRun(), shortcutsList()]
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
                    "fixedCap": .string(FixedCaps.cap(for: a.bundleIdentifier).rawValue),
                ]
            })])
        }
    }

    struct AppRefParams: Decodable {
        var app: String?
        var bundleId: String?
        var name: String?
        var url: String?
    }

    static let appFolders = ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities",
                             NSHomeDirectory() + "/Applications"]

    /// Resolves an installed app. Names are plain names (no `/`, no `..`) and the result must sit
    /// in an Applications folder, so an agent-written bundle in the workspace is never launched.
    static func applicationURL(_ p: AppRefParams) throws -> URL {
        let ws = NSWorkspace.shared
        var found: URL?
        if let id = p.bundleId ?? p.app, let url = ws.urlForApplication(withBundleIdentifier: id) { found = url }
        if found == nil, let name = p.name ?? p.app {
            guard !name.contains("/"), !name.contains(".."), !name.isEmpty else {
                throw CapabilityError.invalidParams("app name must be a plain name", field: "name")
            }
            for dir in appFolders {
                let candidate = URL(fileURLWithPath: dir).appendingPathComponent(name.hasSuffix(".app") ? name : name + ".app")
                if FileManager.default.fileExists(atPath: candidate.path) {
                    found = candidate
                    break
                }
            }
        }
        guard let url = found?.standardizedFileURL.resolvingSymlinksInPath() else {
            throw CapabilityError(.notFound, reason: "app_not_found", "No installed app matches \(p.bundleId ?? p.name ?? p.app ?? "")")
        }
        guard appFolders.contains(where: { url.path.hasPrefix($0 + "/") }) else {
            throw CapabilityError(.policyDenied, reason: "app_outside_applications", "Only apps installed in an Applications folder can be opened")
        }
        return url
    }

    /// Document types that run code when opened.
    static let executableExtensions: Set = ["app", "command", "tool", "sh", "zsh", "bash", "scpt", "scptd", "applescript",
                                            "workflow", "terminal", "shortcut", "pkg", "mpkg", "dmg", "jar", "py", "rb", "pl"]

    static func open() -> Capability {
        Capability(CapabilitySpec(
            name: "apps.open", description: "Open (launch or bring forward) an app by bundle id or name, optionally with a document or URL.",
            sideEffect: .write, targetKind: .app,
            inputSchema: Schema.object([
                "app": Schema.string("Bundle id or name"), "bundleId": Schema.string(), "name": Schema.string(),
                "url": Schema.string("file:// or https:// URL to open with the app"),
            ]),
            receiptKind: "app_open"
        )) { ctx in
            let p = try ctx.decode(AppRefParams.self)
            let appURL = try applicationURL(p)
            let bundleId = Bundle(url: appURL)?.bundleIdentifier
            let category = FixedCaps.category(of: bundleId)
            if category == .passwordManager || category == .finance {
                throw CapabilityError(.policyDenied, reason: "tier_off", "Psyche does not open password managers or finance apps")
            }
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            let running: NSRunningApplication
            if let s = p.url {
                guard let u = URL(string: s), ["file", "https", "http", "mailto"].contains(u.scheme?.lowercased() ?? "") else {
                    throw CapabilityError.invalidParams("url must be file, http(s) or mailto", field: "url")
                }
                if u.isFileURL {
                    // Opening a document in a terminal, IDE or script runner runs it.
                    if category == .terminalOrIDE || executableExtensions.contains(u.pathExtension.lowercased()) {
                        throw CapabilityError(.policyDenied, reason: "executable_document", "Psyche does not open scripts or apps as documents")
                    }
                }
                running = try await NSWorkspace.shared.open([u], withApplicationAt: appURL, configuration: config)
            } else {
                running = try await NSWorkspace.shared.openApplication(at: appURL, configuration: config)
            }
            let name = running.localizedName ?? appURL.deletingPathExtension().lastPathComponent
            return CapabilityOutput(
                ["bundleId": running.bundleIdentifier.map { .string($0) } ?? .null, "name": .string(name), "pid": .int(Int(running.processIdentifier))],
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

    static func applescript() -> Capability {
        Capability(CapabilitySpec(
            name: "apps.applescript",
            description: "Run AppleScript against one target app (osascript, out of process, without the helper's permissions). Destructive, device-only, approved per exact source; shell, ObjC and other apps are refused.",
            sideEffect: .destructive, targetKind: .app, inputSchema: scriptSchema("AppleScript"),
            permissions: [], receiptKind: "apple_event"
        )) { ctx in
            let p = try ctx.decode(ScriptParams.self)
            try ScriptGuard.check(p.source, language: .appleScript, target: p.target, resolve: AppResolver.bundleId)
            let t = p.target ?? ""
            try await AutomationPermission.ensure(bundleId: AppResolver.bundleId(t) ?? t, ask: true)
            let out = try await OutOfProcessScript.run(source: p.source, language: .appleScript, timeout: TimeInterval(min(300, max(1, p.timeoutSeconds ?? 60))))
            return scriptOutput(out, target: p.target, kind: "AppleScript")
        }
    }

    static func jxa() -> Capability {
        Capability(CapabilitySpec(
            name: "apps.jxa",
            description: "Run JavaScript for Automation against one target app (osascript, out of process, without the helper's permissions). Destructive, device-only, approved per exact source; shell, ObjC bridging and other apps are refused.",
            sideEffect: .destructive, targetKind: .app, inputSchema: scriptSchema("JavaScript for Automation"),
            receiptKind: "apple_event"
        )) { ctx in
            let p = try ctx.decode(ScriptParams.self)
            try ScriptGuard.check(p.source, language: .javaScript, target: p.target, resolve: AppResolver.bundleId)
            let t = p.target ?? ""
            try await AutomationPermission.ensure(bundleId: AppResolver.bundleId(t) ?? t, ask: true)
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

    static func shortcutRun() -> Capability {
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
            let p = try ctx.decode(P.self)
            guard !p.name.isEmpty, !p.name.hasPrefix("-") else { throw CapabilityError.invalidParams("bad shortcut name", field: "name") }
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("psyche-shortcut-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            defer { try? FileManager.default.removeItem(at: dir) }
            var args = ["run", p.name]
            if let input = p.input {
                let inFile = dir.appendingPathComponent("input.txt")
                try Data(input.utf8).write(to: inFile, options: .atomic)
                args += ["--input-path", inFile.path]
            }
            let outFile = dir.appendingPathComponent("output.txt")
            args += ["--output-path", outFile.path, "--output-type", "public.plain-text"]
            let r = try await DisclaimedProcess.run("/usr/bin/shortcuts", args, timeout: TimeInterval(p.timeoutSeconds ?? 120))
            guard r.status == 0 else {
                let notFound = r.stderr.lowercased().contains("couldn’t find") || r.stderr.lowercased().contains("couldn't find")
                throw CapabilityError(notFound ? .notFound : .unavailable, reason: notFound ? "shortcut_not_found" : "shortcut_failed",
                                      notFound ? "No shortcut named \(p.name)" : "The shortcut failed (exit \(r.status))",
                                      details: ["stderr": .string(String(r.stderr.prefix(2000)))])
            }
            let output = (try? String(contentsOf: outFile, encoding: .utf8)) ?? r.stdout
            return CapabilityOutput(
                ["output": .string(String(output.prefix(100_000))), "provenance": "untrusted"],
                receipt: ReceiptDraft(outcome: .ok, summary: "Ran shortcut \(p.name)", externalRefs: ["shortcut": .string(p.name)])
            )
        }
    }

    static func shortcutsList() -> Capability {
        Capability(CapabilitySpec(name: "apps.shortcuts_list", description: "Names of the user's Shortcuts.", sideEffect: .read)) { _ in
            let r = try await DisclaimedProcess.run("/usr/bin/shortcuts", ["list"], timeout: 30)
            let names = r.stdout.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
            return CapabilityOutput(["shortcuts": .array(names.prefix(2000).map { .string($0) })])
        }
    }
}

// MARK: - Script execution

/// Resolves an app name or bundle id to an installed bundle id.
enum AppResolver {
    static func bundleId(_ nameOrId: String) -> String? {
        if nameOrId.contains("."), NSWorkspace.shared.urlForApplication(withBundleIdentifier: nameOrId) != nil { return nameOrId }
        let name = nameOrId.hasSuffix(".app") ? nameOrId : nameOrId + ".app"
        guard !name.contains("/"), !name.contains("..") else { return nil }
        for dir in AppsCapabilities.appFolders {
            if let id = Bundle(url: URL(fileURLWithPath: dir).appendingPathComponent(name))?.bundleIdentifier { return id }
        }
        return nameOrId.contains(".") ? nameOrId : nil
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
