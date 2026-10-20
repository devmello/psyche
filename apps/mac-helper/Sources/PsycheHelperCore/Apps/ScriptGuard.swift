import Foundation
import PsycheProtocol

/// Checks AppleScript / JXA for `apps.applescript` and `apps.jxa` (#268). The script also runs out
/// of process (`osascript`, responsibility disclaimed), so it never holds the helper's TCC grants;
/// this guard is the second layer:
///
/// - Tokens are matched on the source lowercased with all whitespace and invisible characters
///   removed, so `ObjC .import` or `$ .NSTask` cannot split a banned token.
/// - Shell and code-loading routes are banned: `do shell script`, `do script`, `run script`,
///   AppleScriptObjC (`use framework`, `current application`), raw event codes (`«event`),
///   JXA's ObjC bridge (`ObjC`, `$`), `eval`, `Function`, computed member calls (`a['x']`, `a[n](`),
///   arrow functions and template strings, and UI waits that block (`delay`, `display dialog`).
/// - A `target` is required, must be scriptable (not Finder, System Events, terminals, editors or
///   any app whose fixed cap is below Read and interact), and every app the script addresses must be
///   that target. A dynamic `application x` / `Application(x)` is refused.
public enum ScriptGuard {
    public enum Language: Sendable { case appleScript, javaScript }

    static let appleScriptBanned = [
        "doshellscript", "doscript", "runscript", "loadscript", "storescript", "useframework", "usescriptingadditions",
        "currentapplication", "nstask", "nsapplescript", "nsworkspace", "nsfilemanager", "nsurl", "«event", "«class", "«data",
        "delay", "displaydialog", "displayalert", "choosefromlist", "choosefile", "choosefolder", "chooseapplication",
        "keystroke", "keycode", "pathtome", "systemattribute", "openlocation", "clipboard", "mountvolume", "dojavascript",
        // Standard Additions file I/O runs in osascript itself, not in the target.
        "openforaccess", "closeaccess", "seteof", "geteof", "readfile", "readalias", "readposixfile", "read(", "tofile", "toalias",
        "toposixfile",
    ]

    static let javaScriptBanned = [
        "doshellscript", "doscript", "runscript", "objc", "$", "eval(", "library(", "function(", "function*", "=>", "['", "[\"",
        "`", "\\u", "\\x", "fromcharcode", "](", ".call(", ".apply(", ".bind(", "constructor", "prototype", "__proto__", "require(",
        "import(", "currentapplication", "includestandardadditions", "delay(", "displaydialog", "displayalert", "choosefromlist",
        "choosefile", "choosefolder", "keystroke", "keycode", "systemattribute", "openlocation", "clipboard",
    ]

    /// Apps a script may never drive: they run commands or files, inject input, or edit scripts.
    static let neverTargets = [
        "com.apple.finder", "com.apple.systemevents", "com.apple.ScriptEditor2", "com.apple.Automator", "com.apple.shortcuts",
        "com.apple.shortcuts.events", "com.apple.Terminal", "com.googlecode.iterm2", "com.apple.osascript",
    ]

    /// Lowercased, without whitespace, line continuations or invisible format characters.
    public static func normalized(_ source: String) -> String {
        var out = String.UnicodeScalarView()
        for u in source.lowercased().unicodeScalars {
            if u.properties.isWhitespace || u == "¬" || u.properties.generalCategory == .format || u.properties.generalCategory == .control {
                continue
            }
            out.append(u)
        }
        return String(out)
    }

    /// Token checks only.
    public static func check(_ source: String, language: Language) throws {
        guard source.count <= 50_000 else { throw CapabilityError.invalidParams("script too long", field: "source") }
        let n = normalized(source)
        let banned = language == .appleScript ? appleScriptBanned : javaScriptBanned
        if let hit = banned.first(where: { n.contains($0) }) {
            throw CapabilityError(.policyDenied, reason: "shell_escape", "Scripts may not use \(hit); shell commands run in the sandbox")
        }
    }

    /// Full check: tokens, the declared target, and every addressed app equal to it.
    /// `resolve` maps an app name or bundle id to a bundle id (nil when unknown).
    public static func check(_ source: String, language: Language, target: String?, resolve: (String) -> String?) throws {
        try check(source, language: language)
        guard let target, !target.isEmpty else {
            throw CapabilityError.invalidParams("target (the bundle id the script controls) is required", field: "target")
        }
        let targetId = try checkTarget(target, resolve: resolve)
        for addressed in addressedApps(source, language: language) {
            guard addressed != dynamicMarker else {
                throw CapabilityError(.policyDenied, reason: "script_dynamic_target", "Scripts must name their app literally")
            }
            guard let id = resolve(addressed), id.lowercased() == targetId.lowercased() else {
                throw CapabilityError(.policyDenied, reason: "script_target_mismatch", "The script addresses \(addressed), not \(target)",
                                      details: ["addressed": .string(addressed), "target": .string(target)])
            }
        }
    }

    /// Refuses System Events and other never-targets, and apps whose fixed cap is below interact.
    @discardableResult
    public static func checkTarget(_ nameOrId: String, resolve: (String) -> String?) throws -> String {
        let lower = nameOrId.lowercased()
        if lower.contains("system events") {
            throw CapabilityError(.policyDenied, reason: "system_events", "Scripts may not drive System Events; use computer.* so tiers and Esc apply")
        }
        guard let id = resolve(nameOrId) else {
            throw CapabilityError(.notFound, reason: "script_target_unknown", "No installed app named \(nameOrId)")
        }
        if neverTargets.contains(where: { $0.lowercased() == id.lowercased() }) || FixedCaps.cap(for: id) < .interact {
            throw CapabilityError(.policyDenied, reason: "script_target_capped", "Scripts may not control \(nameOrId)")
        }
        return id
    }

    static let dynamicMarker = "\u{0}dynamic"

    /// App names or bundle ids a script addresses; a non-literal application reference yields a
    /// marker that `check` refuses. AppleScript: `application "X"`, `app "X"`, `application id "X"`,
    /// `app id "X"`; any other use of the `app` / `application` keyword (a variable, an expression,
    /// `application file id …`) is dynamic. JXA: `Application('X')`; any other use of `Application`
    /// (a variable argument, an alias such as `var A = Application`) is dynamic.
    public static func addressedApps(_ source: String, language: Language = .appleScript) -> [String] {
        let literal: [String]
        let dynamic: [String]
        switch language {
        case .appleScript:
            literal = [#"\b(?:application|app)\s+id\s+"([^"]+)""#, #"\b(?:application|app)\s+"([^"]+)""#]
            dynamic = [#"\b(?:application|app)\b(?!\s+(?:id\s+)?")"#]
        case .javaScript:
            // JXA is case-sensitive.
            literal = [#"(?<![A-Za-z0-9_$])Application\s*\(\s*['"]([^'"]+)['"]\s*\)"#]
            dynamic = [#"(?<![A-Za-z0-9_$])Application(?!\s*\(\s*['"][^'"]+['"]\s*\))"#]
        }
        var out: [String] = []
        let ns = source as NSString
        let all = NSRange(location: 0, length: ns.length)
        let options: NSRegularExpression.Options = language == .appleScript ? [.caseInsensitive] : []
        for pattern in literal {
            guard let re = try? NSRegularExpression(pattern: pattern, options: options) else { continue }
            for m in re.matches(in: source, range: all) where m.numberOfRanges > 1 {
                out.append(ns.substring(with: m.range(at: 1)))
            }
        }
        for pattern in dynamic {
            guard let re = try? NSRegularExpression(pattern: pattern, options: options) else { continue }
            if re.firstMatch(in: source, range: all) != nil { out.append(dynamicMarker) }
        }
        return out
    }
}
