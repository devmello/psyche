import Foundation
import PsycheProtocol

/// System-wide dictation (features J9, Q2): the pure half of `dictation.target`, `dictation.insert`
/// and `dictation.watch`. The live AX / CGEvent adapter is `LiveDictationBackend` in
/// PsycheHelperSystem; everything here is tested without TCC grants.
///
/// Inserted text is keystrokes into another app, never owner input to the agent. The helper
/// refuses secure text fields and Psyche's own windows, and collapses control characters
/// (newlines and tabs included) to spaces so dictation can never press Return or Tab.
public enum DictationPolicy {
    /// Psyche's own UI: the desktop composer dictates there itself.
    public static let ownBundleIds: Set<String> = ["com.psyche.desktop", "com.psyche.helper"]
    public static let maxChars = 4000

    /// Roles that take text through AX.
    public static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]

    /// Control characters (newlines, tabs, NUL, …) become one space; runs of spaces they create
    /// collapse; the ends are trimmed.
    public static func sanitize(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count)
        var pendingSpace = false
        for ch in text {
            let control = ch.isNewline || ch.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
            if control || ch == " " {
                pendingSpace = !out.isEmpty
                continue
            }
            if pendingSpace { out.append(" ") }
            pendingSpace = false
            out.append(ch)
        }
        return out
    }

    /// Why `focus` cannot take dictated text, or nil when it can.
    public static func refusal(_ focus: DictationFocus?, secureInput: Bool, expectPid: Int? = nil) -> DictationRefusal? {
        guard let focus else { return .noFocus }
        if let bundle = focus.bundleId, ownBundleIds.contains(bundle) { return .ownWindow }
        if let expectPid, expectPid != Int(focus.pid) { return .focusChanged }
        // Only the focused element decides. `secureInput` (global Secure Event Input) is true
        // whenever any app holds it (Terminal's Secure Keyboard Entry, a password manager, a
        // password field in another window), so it must not block ordinary fields; it only
        // means synthesized key events may be swallowed, so `insert` prefers AX writes then.
        if focus.secure { return .secureField }
        if let element = focus.element, !element.canTakeText, focus.role.map({ !textRoles.contains($0) }) ?? false {
            // A focused button, list or web area with no caret: typing would trigger shortcuts.
            return element.isWebArea ? nil : .notEditable
        }
        return nil
    }

    /// True only for the focused element itself being a password field: AX role or subrole
    /// `AXSecureTextField` (Chromium reports `input[type=password]` that way). Unknown or missing
    /// roles (Chromium/Electron web content) are not secure.
    public static func isSecureElement(role: String?, subrole: String?) -> Bool {
        role == "AXSecureTextField" || subrole == "AXSecureTextField"
    }

    public static func target(_ focus: DictationFocus?, secureInput: Bool, expectPid: Int? = nil) -> DictationTarget? {
        guard let focus else { return nil }
        let refusal = refusal(focus, secureInput: secureInput, expectPid: expectPid)
        return DictationTarget(
            appName: focus.appName, bundleID: focus.bundleId, insertable: refusal == nil, pid: Int(focus.pid),
            refusal: refusal, role: focus.role)
    }
}

extension DictationTarget {
    /// Wire form: `bundleId` and `role` are present as null rather than omitted (the schema
    /// declares them nullable, not optional).
    public var wire: JSONValue {
        var o: [String: JSONValue] = [
            "pid": .int(pid),
            "bundleId": bundleID.map { .string($0) } ?? .null,
            "appName": .string(appName),
            "role": role.map { .string($0) } ?? .null,
            "insertable": .bool(insertable),
        ]
        if let refusal { o["refusal"] = .string(refusal.rawValue) }
        return .object(o)
    }
}

/// The focused app and, when AX exposes one, its focused element.
public struct DictationFocus: Sendable, Equatable {
    public var pid: Int32
    public var bundleId: String?
    public var appName: String
    public var role: String?
    public var secure: Bool
    public var element: DictationElementInfo?

    public init(pid: Int32, bundleId: String?, appName: String, role: String? = nil, secure: Bool = false, element: DictationElementInfo? = nil) {
        self.pid = pid
        self.bundleId = bundleId
        self.appName = appName
        self.role = role
        self.secure = secure
        self.element = element
    }
}

/// What AX says the focused element accepts (never its contents).
public struct DictationElementInfo: Sendable, Equatable {
    public var selectedTextSettable: Bool
    public var valueSettable: Bool
    public var hasSelectedRange: Bool
    public var isWebArea: Bool

    public init(selectedTextSettable: Bool, valueSettable: Bool, hasSelectedRange: Bool, isWebArea: Bool = false) {
        self.selectedTextSettable = selectedTextSettable
        self.valueSettable = valueSettable
        self.hasSelectedRange = hasSelectedRange
        self.isWebArea = isWebArea
    }

    public var canTakeText: Bool { selectedTextSettable || (valueSettable && hasSelectedRange) }
}

/// The live side `DictationInserter` drives (a fake in tests).
public protocol DictationBackend: Sendable {
    /// Where keyboard input goes now: the AX system-wide focused element, else the frontmost app.
    func focus() -> DictationFocus?
    /// Carbon `IsSecureEventInputEnabled()`.
    func secureInputActive() -> Bool
    /// Sets `kAXSelectedTextAttribute`; true when the element's value then changed (or cannot be read).
    func setSelectedText(_ text: String) -> Bool
    /// Replaces the selected range in `kAXValueAttribute` and moves the caret after the text.
    func replaceSelectedRange(_ text: String) -> Bool
    /// Unicode CGEvent typing; `guardChunk` runs before every chunk and throws to stop.
    func type(_ text: String, guardChunk: @escaping () throws -> Void) throws
}

public struct DictationInsertOutcome: Sendable {
    public var method: DictationInsertMethod
    public var chars: Int
    public var target: DictationTarget
}

public enum DictationInserter {
    public static func refusalError(_ r: DictationRefusal, target: DictationTarget?) -> CapabilityError {
        let message: String
        switch r {
        case .noFocus: message = "No app has keyboard focus."
        case .ownWindow: message = "Psyche's own windows dictate through the composer."
        case .secureField:
            let app = target?.appName.isEmpty == false ? target!.appName : "this app"
            message = "The focused field in \(app) is a password field. Psyche never types into password fields."
        case .notEditable: message = "The focused element does not take text."
        case .focusChanged: message = "Focus moved to another app while you were dictating; nothing was inserted."
        }
        var details: [String: JSONValue] = ["refusal": .string(r.rawValue)]
        if let target, let app = target.bundleID { details["bundleId"] = .string(app) }
        return CapabilityError(.policyDenied, reason: r.rawValue, message, details: details)
    }

    /// Inserts `text` into the focused element: `kAXSelectedTextAttribute`, then the value with
    /// the selected range replaced, then unicode typing. Every step re-checks the policy.
    public static func insert(_ raw: String, expectPid: Int?, backend: any DictationBackend) throws -> DictationInsertOutcome {
        let text = DictationPolicy.sanitize(raw)
        guard !text.isEmpty else { throw CapabilityError.invalidParams("nothing to insert after removing control characters", field: "text") }
        guard text.count <= DictationPolicy.maxChars else { throw CapabilityError.invalidParams("text is longer than \(DictationPolicy.maxChars) characters", field: "text") }
        let focus = backend.focus()
        let secure = backend.secureInputActive()
        let target = DictationPolicy.target(focus, secureInput: secure, expectPid: expectPid)
        if let r = DictationPolicy.refusal(focus, secureInput: secure, expectPid: expectPid) { throw refusalError(r, target: target) }
        guard let focus, let target else { throw refusalError(.noFocus, target: nil) }

        if let el = focus.element {
            if el.selectedTextSettable, backend.setSelectedText(text) {
                return DictationInsertOutcome(method: .ax, chars: text.count, target: target)
            }
            if el.valueSettable, el.hasSelectedRange, backend.replaceSelectedRange(text) {
                return DictationInsertOutcome(method: .ax, chars: text.count, target: target)
            }
        }
        try backend.type(text) {
            // Focus must stay in the same app and out of password fields for every chunk.
            let now = backend.focus()
            if let r = DictationPolicy.refusal(now, secureInput: backend.secureInputActive(), expectPid: Int(focus.pid)) {
                throw refusalError(r, target: DictationPolicy.target(now, secureInput: false))
            }
        }
        return DictationInsertOutcome(method: .typed, chars: text.count, target: target)
    }
}

/// Turns raw `flagsChanged` / `keyDown` events into hold-to-talk transitions for one modifier.
/// A key pressed while the modifier is held (fn+arrow, ⌥+letter) is a chord, not dictation: it
/// ends the hold at once and the release that follows is swallowed.
public struct DictationKeyTracker: Sendable {
    public let key: DictationKey
    public private(set) var isDown = false
    private var chorded = false

    public init(key: DictationKey) { self.key = key }

    /// Virtual key code of the watched modifier (kVK_Function, kVK_RightOption, kVK_RightCommand).
    public var keyCode: Int64 {
        switch key {
        case .fn: 63
        case .rightOption: 61
        case .rightCommand: 54
        }
    }

    /// Device-dependent flag bit that is set while this exact key is held.
    public var flagMask: UInt64 {
        switch key {
        case .fn: 0x0080_0000  // NX_SECONDARYFNMASK
        case .rightOption: 0x0000_0040  // NX_DEVICERALTKEYMASK
        case .rightCommand: 0x0000_0010  // NX_DEVICERCMDKEYMASK
        }
    }

    /// Feeds one `flagsChanged`; returns the new state when it changed.
    public mutating func flagsChanged(keyCode: Int64, flags: UInt64) -> Bool? {
        guard keyCode == self.keyCode else { return nil }
        let held = flags & flagMask != 0
        if held == isDown && !chorded { return nil }
        if !held && chorded {
            chorded = false
            isDown = false
            return nil
        }
        isDown = held
        return held
    }

    /// Feeds one `keyDown`; returns false (released) when it turned the hold into a chord.
    public mutating func keyDown() -> Bool? {
        guard isDown, !chorded else { return nil }
        chorded = true
        isDown = false
        return false
    }
}

/// One watched key and, for a two-key watch, its role (V-H H1: `dictation.watch {keys}`).
public struct DictationWatchedKey: Sendable, Equatable {
    public var key: DictationKey
    public var role: DictationKeyRole?

    public init(key: DictationKey, role: DictationKeyRole? = nil) {
        self.key = key
        self.role = role
    }
}

/// A hold-to-talk transition of one watched key.
public struct DictationKeyChange: Sendable, Equatable {
    public var key: DictationKey
    public var role: DictationKeyRole?
    public var down: Bool

    public init(key: DictationKey, role: DictationKeyRole?, down: Bool) {
        self.key = key
        self.role = role
        self.down = down
    }
}

public enum DictationWatchPlan {
    /// The keys a `dictation.watch` call asks for; empty means stop. `keys` wins over `key`; its
    /// keys and roles must differ. A single `key` has no role, so its events stay as before.
    public static func keys(_ p: DictationWatchParams) throws -> [DictationWatchedKey] {
        guard let keys = p.keys else { return p.key.map { [DictationWatchedKey(key: $0)] } ?? [] }
        guard (1...2).contains(keys.count) else {
            throw CapabilityError.invalidParams("keys holds one or two keys", field: "keys")
        }
        guard Set(keys.map(\.key.rawValue)).count == keys.count else {
            throw CapabilityError.invalidParams("each key is watched once", field: "keys")
        }
        guard Set(keys.map(\.role.rawValue)).count == keys.count else {
            throw CapabilityError.invalidParams("each role is used once", field: "keys")
        }
        return keys.map { DictationWatchedKey(key: $0.key, role: $0.role) }
    }
}

/// Trackers for one or two watched keys. Each key holds independently; a key press during any
/// hold is a chord for every held key (so fn+arrow never starts voice or dictation).
public struct DictationKeySet: Sendable {
    public private(set) var trackers: [DictationKeyTracker]
    public let watched: [DictationWatchedKey]

    public init(_ watched: [DictationWatchedKey]) {
        self.watched = watched
        trackers = watched.map { DictationKeyTracker(key: $0.key) }
    }

    public mutating func flagsChanged(keyCode: Int64, flags: UInt64) -> [DictationKeyChange] {
        var out: [DictationKeyChange] = []
        for i in trackers.indices {
            if let down = trackers[i].flagsChanged(keyCode: keyCode, flags: flags) {
                out.append(DictationKeyChange(key: watched[i].key, role: watched[i].role, down: down))
            }
        }
        return out
    }

    public mutating func keyDown() -> [DictationKeyChange] {
        var out: [DictationKeyChange] = []
        for i in trackers.indices {
            if let down = trackers[i].keyDown() {
                out.append(DictationKeyChange(key: watched[i].key, role: watched[i].role, down: down))
            }
        }
        return out
    }
}
