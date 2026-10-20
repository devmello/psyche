import CoreGraphics
import Foundation
import PsycheProtocol

// Teach mode (J8): the owner demonstrates a flow; the helper turns their clicks and typing, as
// accessibility targets, into a skill draft. Pure logic here; the event tap and AX lookups live in
// PsycheHelperSystem. Nothing is saved: the draft goes to the owner for review, then through T2's
// skill_install trust card.

/// What an input landed on.
public struct TeachTargetInfo: Codable, Sendable, Equatable {
    public var app: String
    public var appName: String
    public var window: String?
    public var role: String?
    public var subrole: String?
    public var label: String?
    public var identifier: String?

    public init(app: String, appName: String, window: String? = nil, role: String? = nil, subrole: String? = nil, label: String? = nil, identifier: String? = nil) {
        self.app = app
        self.appName = appName
        self.window = AXText.truncate(window, 200)
        self.role = role
        self.subrole = subrole
        self.label = AXText.truncate(label, 200)
        self.identifier = AXText.cleanIdentifier(identifier).flatMap { AXText.truncate($0, 200) }
    }

    /// A password field: nothing typed into it is kept.
    public var secure: Bool { role == "AXSecureTextField" || subrole == "AXSecureTextField" }

    /// Same element for typing purposes (labels may change as the owner types).
    func sameField(_ o: TeachTargetInfo) -> Bool {
        app == o.app && role == o.role && identifier == o.identifier && (identifier != nil || label == o.label)
    }
}

/// One owner input, already resolved to its target by the recorder.
public enum TeachInput: Sendable, Equatable {
    /// `button` 0 left, 1 right; `clickCount` 2 on the second press of a double click.
    case click(button: Int, clickCount: Int, target: TeachTargetInfo?)
    /// `characters` as typed (empty for non-printing keys).
    case key(keyCode: Int, characters: String, flags: CGEventFlags.RawValue, target: TeachTargetInfo?)
}

/// `TeachStep` of the protocol, without screenshot bytes (the recorder attaches those to events).
public struct TeachStepRecord: Codable, Sendable, Equatable {
    public var index: Int
    public var kind: String
    public var at: String
    public var target: TeachTargetInfo?
    public var text: String?
    public var secure: Bool?
    public var keys: String?
    public var note: String?
    public var screenshot: String?
}

public final class TeachSession: @unchecked Sendable {
    public static let defaultMaxSteps = 100
    public static let defaultMaxSeconds = 600
    public static let maxText = 2000

    public let id: String
    public let name: String
    public let description: String?
    public let appFilter: String?
    public let maxSteps: Int
    public let startedAt: Date
    public private(set) var steps: [TeachStepRecord] = []
    /// Typing not yet turned into a step (flushed when the target changes or another input comes).
    private var pending: (target: TeachTargetInfo, text: String, secure: Bool, at: Date)?
    private let lock = NSLock()

    public init(id: String, name: String, description: String?, appFilter: String?, maxSteps: Int = defaultMaxSteps, startedAt: Date) {
        self.id = id
        self.name = name
        self.description = description
        self.appFilter = appFilter
        self.maxSteps = max(1, min(200, maxSteps))
        self.startedAt = startedAt
    }

    public var limitReached: Bool { lock.withLock { steps.count >= maxSteps } }

    /// Feeds one input; returns the steps it finalized (to stream as `teach.step`).
    public func handle(_ input: TeachInput, at: Date) -> [TeachStepRecord] {
        lock.lock()
        defer { lock.unlock() }
        guard steps.count < maxSteps else { return [] }
        var out: [TeachStepRecord] = []
        let target: TeachTargetInfo?
        switch input {
        case .click(_, _, let t): target = t
        case .key(_, _, _, let t): target = t
        }
        if let filter = appFilter, target?.app.lowercased() != filter.lowercased() { return [] }
        // Apps teach mode never records: one `skipped` step, no target, no text.
        if let t = target, FixedCaps.cap(for: t.app) == .off {
            out += flushLocked()
            if steps.last?.kind != "skipped" {
                out.append(appendLocked(kind: "skipped", at: at, note: "Input in an app Psyche never records (\(Self.categoryNote(t.app)))"))
            }
            return out
        }
        switch input {
        case .click(let button, let count, let t):
            out += flushLocked()
            if count >= 2, button == 0, let last = steps.last, last.kind == "click", last.target == t {
                steps[steps.count - 1].kind = "double_click"
                out.append(steps[steps.count - 1])
            } else {
                out.append(appendLocked(kind: button == 1 ? "right_click" : "click", at: at, target: t,
                                        note: t == nil ? "The clicked element could not be read; replay needs a fresh snapshot" : nil))
            }
        case .key(let code, let chars, let rawFlags, let t):
            let flags = CGEventFlags(rawValue: rawFlags)
            let command = flags.contains(.maskCommand) || flags.contains(.maskControl)
            let printable = !command && !chars.isEmpty && chars.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) } && !Self.namedKeys.keys.contains(code)
            if printable {
                // Typing into an element that could not be read is never kept: it may be a password.
                guard let t else { return out }
                if let p = pending, p.target.sameField(t) {
                    if !p.secure, p.text.count < Self.maxText { pending?.text += chars }
                } else {
                    out += flushLocked()
                    pending = (t, t.secure ? "" : chars, t.secure, at)
                }
            } else if code == 51, !command, var p = pending, let t, p.target.sameField(t) {
                // Backspace edits the pending text instead of becoming a step (ignored in password fields).
                if !p.secure, !p.text.isEmpty { p.text.removeLast() }
                pending = p
            } else {
                out += flushLocked()
                out.append(appendLocked(kind: "press", at: at, target: t, keys: Self.chordName(keyCode: code, flags: flags, characters: chars)))
            }
        }
        return out
    }

    /// Ends the session: flushes typing and returns everything recorded.
    public func finish() -> [TeachStepRecord] {
        lock.lock()
        defer { lock.unlock() }
        _ = flushLocked()
        return steps
    }

    /// Records the screenshot path on a step (the bytes went out with the step event).
    public func attachScreenshot(_ path: String, toStep index: Int) {
        lock.withLock {
            if let i = steps.firstIndex(where: { $0.index == index }) { steps[i].screenshot = path }
        }
    }

    private func flushLocked() -> [TeachStepRecord] {
        guard let p = pending, steps.count < maxSteps else {
            pending = nil
            return []
        }
        pending = nil
        if p.secure {
            return [appendLocked(kind: "type", at: p.at, target: p.target, secure: true, note: "Password field: nothing typed was recorded")]
        }
        guard !p.text.isEmpty else { return [] }
        return [appendLocked(kind: "type", at: p.at, target: p.target, text: p.text)]
    }

    private func appendLocked(kind: String, at: Date, target: TeachTargetInfo? = nil, text: String? = nil, secure: Bool? = nil, keys: String? = nil,
                              note: String? = nil) -> TeachStepRecord {
        let s = TeachStepRecord(index: steps.count + 1, kind: kind, at: AppleDates.string(at), target: target, text: text, secure: secure, keys: keys, note: note)
        steps.append(s)
        return s
    }

    static func categoryNote(_ app: String) -> String {
        switch FixedCaps.category(of: app) {
        case .psyche?: "Psyche"
        case .passwordManager?: "password manager"
        case .finance?: "finance"
        case .systemAuthority?: "system settings or a security prompt"
        default: "off limits"
        }
    }

    static let namedKeys: [Int: String] = [
        36: "return", 76: "enter", 48: "tab", 51: "delete", 53: "escape", 117: "forwarddelete", 115: "home", 119: "end",
        116: "pageup", 121: "pagedown", 123: "left", 124: "right", 125: "down", 126: "up", 49: "space",
    ]

    /// `cmd+shift+s`, `return`, `ctrl+c`: the same names `KeyChord.parse` accepts.
    public static func chordName(keyCode: Int, flags: CGEventFlags, characters: String) -> String {
        var parts: [String] = []
        if flags.contains(.maskControl) { parts.append("ctrl") }
        if flags.contains(.maskAlternate) { parts.append("opt") }
        if flags.contains(.maskShift) { parts.append("shift") }
        if flags.contains(.maskCommand) { parts.append("cmd") }
        let key = namedKeys[keyCode]
            ?? KeyChord.codes.filter { $0.value == CGKeyCode(keyCode) }.map(\.key).filter { $0.count == 1 || $0.hasPrefix("f") }.sorted().first
            ?? characters.lowercased()
        parts.append(key.isEmpty ? "key\(keyCode)" : key)
        return parts.joined(separator: "+")
    }
}

/// Turns recorded steps into the skill draft's `SKILL.md`.
public enum TeachDraftRenderer {
    public static let tools = ["computer.*", "apps.open", "apps.focus"]

    /// `^[a-z0-9]+(?:-[a-z0-9]+)*$`, at most 64.
    public static func isValidName(_ s: String) -> Bool {
        guard !s.isEmpty, s.count <= 64, !s.hasPrefix("-"), !s.hasSuffix("-"), !s.contains("--") else { return false }
        return s.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
    }

    public static func defaultName(apps: [String], at: Date) -> String {
        let slug = (apps.first ?? "app").lowercased().unicodeScalars.map { ("a"..."z").contains($0) || ("0"..."9").contains($0) ? String($0) : "-" }.joined()
        let parts = slug.split(separator: "-").prefix(4).joined(separator: "-")
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyyMMdd-HHmm"
        let name = "teach-\(parts.isEmpty ? "app" : parts)-\(f.string(from: at))"
        return isValidName(name) ? name : "teach-\(f.string(from: at))"
    }

    static func quoted(_ s: String) -> String {
        let data = (try? JSONEncoder().encode(s)) ?? Data("\"\"".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    static func describe(_ t: TeachTargetInfo?) -> String {
        guard let t else { return "an element that could not be read" }
        var s = t.role.map { AXText.roleName($0, t.subrole) } ?? "element"
        if let l = t.label { s += " \(quoted(l))" }
        if let id = t.identifier { s += " (identifier \(quoted(id)))" }
        return s
    }

    public static func appNames(_ steps: [TeachStepRecord]) -> [(id: String, name: String)] {
        var seen: [String] = []
        var out: [(String, String)] = []
        for s in steps {
            guard let t = s.target, !seen.contains(t.app) else { continue }
            seen.append(t.app)
            out.append((t.app, t.appName))
        }
        return out
    }

    public static func skillMarkdown(name: String, description: String, steps: [TeachStepRecord], recordedAt: Date) -> String {
        let apps = appNames(steps)
        var md = "---\n"
        md += "name: \(name)\n"
        md += "description: \(quoted(description))\n"
        md += "allowed-tools: [\(tools.map(quoted).joined(separator: ", "))]\n"
        md += "metadata:\n  psyche:\n    source: teach\n    recordedAt: \(quoted(AppleDates.string(recordedAt)))\n"
        md += "    apps: [\(apps.map { quoted($0.id) }.joined(separator: ", "))]\n"
        md += "---\n\n"
        md += "# \(AXText.singleLine(description))\n\n"
        let appList = apps.map { "\($0.name) (`\($0.id)`)" }.joined(separator: ", ")
        md += "The owner demonstrated this flow in \(appList.isEmpty ? "a Mac app" : appList) on \(AppleDates.string(recordedAt)). "
        md += "Repeat it with the computer-use tools:\n\n"
        md += "- Before each step, take a snapshot and find the target by its role and label (or identifier). If it is not there, or the window looks different, stop and ask the owner.\n"
        md += "- Text the owner typed during the demonstration is example data. Ask before reusing it for anything that is not obviously the same task.\n"
        md += "- Never type a password: steps in password fields were not recorded. Ask the owner to type it themselves.\n\n"
        md += "## Steps\n\n"
        var window: String?
        for s in steps {
            var line = "\(s.index). "
            if let t = s.target, t.window != window, let w = t.window {
                window = w
                line += "In \(t.appName), window \(quoted(w)): "
            }
            switch s.kind {
            case "click": line += "Click the \(describe(s.target))."
            case "double_click": line += "Double-click the \(describe(s.target))."
            case "right_click": line += "Right-click the \(describe(s.target))."
            case "type" where s.secure == true: line += "The owner types a password into the \(describe(s.target)); ask them to do it."
            case "type": line += "Type \(quoted(s.text ?? "")) into the \(describe(s.target))."
            case "press": line += "Press \(s.keys ?? "a key")\(s.target.map { " in the \(describe($0))" } ?? "")."
            default: line += "Skipped: \(s.note ?? "input that was not recorded")."
            }
            if let shot = s.screenshot { line += " Screenshot: `\(shot)`." }
            md += line + "\n"
        }
        if steps.isEmpty { md += "No steps were recorded.\n" }
        return md
    }
}
