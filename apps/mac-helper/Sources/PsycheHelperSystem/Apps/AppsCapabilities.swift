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

    static func applicationURL(_ p: AppRefParams) throws -> URL {
        let ws = NSWorkspace.shared
        if let id = p.bundleId ?? p.app, let url = ws.urlForApplication(withBundleIdentifier: id) { return url }
        let name = p.name ?? p.app
        if let name {
            for dir in ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities",
                        NSHomeDirectory() + "/Applications"] {
                let candidate = URL(fileURLWithPath: dir).appendingPathComponent(name.hasSuffix(".app") ? name : name + ".app")
                if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            }
        }
        throw CapabilityError(.notFound, reason: "app_not_found", "No installed app matches \(p.bundleId ?? p.name ?? p.app ?? "")")
    }

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
            if let c = FixedCaps.category(of: bundleId), c == .passwordManager || c == .finance {
                throw CapabilityError(.policyDenied, reason: "tier_off", "Psyche does not open password managers or finance apps")
            }
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            let running: NSRunningApplication
            if let s = p.url {
                guard let u = URL(string: s), ["file", "https", "http", "mailto"].contains(u.scheme?.lowercased() ?? "") else {
                    throw CapabilityError.invalidParams("url must be file, http(s) or mailto", field: "url")
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
        Capability(CapabilitySpec(
            name: "apps.focus", description: "Bring a running app to the front, optionally raising one of its windows by index.",
            sideEffect: .write, targetKind: .app,
            inputSchema: Schema.object(["app": Schema.string(), "window": Schema.integer(min: 0)], required: ["app"]),
            receiptKind: "computer_action"
        )) { ctx in
            struct P: Decodable {
                var app: String
                var window: Int?
            }
            let p = try ctx.decode(P.self)
            let app = try AXEngine.findApp(p.app)
            let target = AXEngine.target(app)
            try cu.policy.authorize(.read, bundleId: target.bundleId, appName: target.name, approvalId: ctx.approvalId)
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
    }

    static func scriptSchema(_ language: String) -> JSONValue {
        Schema.object([
            "source": Schema.string("\(language) source", maxLength: 50_000),
            "target": Schema.string("Bundle id of the app the script controls (Automation is asked for it first)"),
        ], required: ["source"])
    }

    static func applescript() -> Capability {
        Capability(CapabilitySpec(
            name: "apps.applescript",
            description: "Run AppleScript in the helper (Automation prompt per target app on first use). Arbitrary scripts can change anything the targets allow, so this is destructive and approved per exact source. `do shell script` is refused.",
            sideEffect: .destructive, targetKind: .app, inputSchema: scriptSchema("AppleScript"),
            permissions: [], receiptKind: "apple_event"
        )) { ctx in
            let p = try ctx.decode(ScriptParams.self)
            try ScriptGuard.check(p.source, language: .appleScript)
            if let t = p.target { try await AutomationPermission.ensure(bundleId: t, ask: true) }
            let out = try await MainThreadScript.run(source: p.source, language: "AppleScript")
            return scriptOutput(out, target: p.target, kind: "AppleScript")
        }
    }

    static func jxa() -> Capability {
        Capability(CapabilitySpec(
            name: "apps.jxa",
            description: "Run JavaScript for Automation in the helper (Automation prompt per target app). Destructive and approved per exact source; doShellScript and ObjC bridging are refused.",
            sideEffect: .destructive, targetKind: .app, inputSchema: scriptSchema("JavaScript for Automation"),
            receiptKind: "apple_event"
        )) { ctx in
            let p = try ctx.decode(ScriptParams.self)
            try ScriptGuard.check(p.source, language: .javaScript)
            if let t = p.target { try await AutomationPermission.ensure(bundleId: t, ask: true) }
            let out = try await MainThreadScript.run(source: p.source, language: "JavaScript")
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

/// Defense in depth for script capabilities: the binding approval is the real control (the source
/// is approved verbatim), but the helper never runs host shell commands for a script (security §5.4:
/// no host-shell fallback). This is a denylist, not a sandbox.
public enum ScriptGuard {
    public enum Language { case appleScript, javaScript }

    public static func check(_ source: String, language: Language) throws {
        let s = source.lowercased().replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        let banned: [String] = switch language {
        case .appleScript: ["do shell script", "run script", "load script", "«event sysoexec»", "«event sysodsct»"]
        case .javaScript: ["doshellscript", "objc.import", "objc.bindfunction", "$.nstask", "$.nsfilemanager", "app.runscript", "eval("]
        }
        if let hit = banned.first(where: { s.contains($0) }) {
            throw CapabilityError(.policyDenied, reason: "shell_escape", "Scripts may not use \(hit); shell commands run in the sandbox")
        }
        if source.count > 50_000 { throw CapabilityError.invalidParams("script too long", field: "source") }
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
        let state = await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async { cont.resume(returning: state(bundleId: bundleId, ask: ask)) }
        }
        switch state {
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
