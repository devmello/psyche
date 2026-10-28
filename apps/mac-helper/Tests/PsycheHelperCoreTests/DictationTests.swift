import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

/// Scripted AX / typing side: records what the inserter tried, never touches the system.
final class FakeDictationBackend: DictationBackend, @unchecked Sendable {
    private let lock = NSLock()
    var focusQueue: [DictationFocus?]
    var lastFocus: DictationFocus?
    var secure = false
    var selectedTextWorks = true
    var rangeWorks = true
    var typeError: Error?
    private(set) var calls: [String] = []
    private(set) var inserted: [String] = []

    init(_ focus: DictationFocus?) {
        focusQueue = []
        lastFocus = focus
    }

    func focus() -> DictationFocus? {
        lock.withLock {
            if !focusQueue.isEmpty { lastFocus = focusQueue.removeFirst() }
            return lastFocus
        }
    }

    func secureInputActive() -> Bool { secure }

    func setSelectedText(_ text: String) -> Bool {
        lock.withLock { calls.append("selectedText") }
        if selectedTextWorks { lock.withLock { inserted.append(text) } }
        return selectedTextWorks
    }

    func replaceSelectedRange(_ text: String) -> Bool {
        lock.withLock { calls.append("range") }
        if rangeWorks { lock.withLock { inserted.append(text) } }
        return rangeWorks
    }

    func type(_ text: String, guardChunk: @escaping () throws -> Void) throws {
        lock.withLock { calls.append("type") }
        try guardChunk()
        if let typeError { throw typeError }
        lock.withLock { inserted.append(text) }
    }
}

let textEdit = DictationFocus(
    pid: 42, bundleId: "com.apple.TextEdit", appName: "TextEdit", role: "AXTextArea",
    element: DictationElementInfo(selectedTextSettable: true, valueSettable: true, hasSelectedRange: true))

@Suite("dictation (J9, Q2)")
struct DictationTests {
    @Test func sanitizeCollapsesControlCharacters() {
        #expect(DictationPolicy.sanitize("hello\nworld") == "hello world")
        #expect(DictationPolicy.sanitize("  a\t\tb \r\n c  ") == "a b c")
        #expect(DictationPolicy.sanitize("rm -rf ~\n") == "rm -rf ~")  // never presses Return
        #expect(DictationPolicy.sanitize("\u{0}\u{7}") == "")
        #expect(DictationPolicy.sanitize("José 👍🏽 ok") == "José 👍🏽 ok")
    }

    @Test func refusals() {
        #expect(DictationPolicy.refusal(nil, secureInput: false) == .noFocus)
        var own = textEdit
        own.bundleId = "com.psyche.desktop"
        #expect(DictationPolicy.refusal(own, secureInput: false) == .ownWindow)
        var pw = textEdit
        pw.secure = true
        #expect(DictationPolicy.refusal(pw, secureInput: false) == .secureField)
        #expect(DictationPolicy.refusal(textEdit, secureInput: true) == nil)
        #expect(DictationPolicy.refusal(textEdit, secureInput: false, expectPid: 7) == .focusChanged)
        let button = DictationFocus(
            pid: 42, bundleId: "com.apple.finder", appName: "Finder", role: "AXButton",
            element: DictationElementInfo(selectedTextSettable: false, valueSettable: false, hasSelectedRange: false))
        #expect(DictationPolicy.refusal(button, secureInput: false) == .notEditable)
        // Chromium web areas and apps without an AX tree fall through to typing.
        let web = DictationFocus(
            pid: 9, bundleId: "com.tinyspeck.slackmacgap", appName: "Slack", role: "AXWebArea",
            element: DictationElementInfo(selectedTextSettable: false, valueSettable: false, hasSelectedRange: false, isWebArea: true))
        #expect(DictationPolicy.refusal(web, secureInput: false) == nil)
        #expect(DictationPolicy.refusal(DictationFocus(pid: 9, bundleId: "com.tinyspeck.slackmacgap", appName: "Slack"), secureInput: false) == nil)
        #expect(DictationPolicy.refusal(textEdit, secureInput: false, expectPid: 42) == nil)
    }

    @Test func targetWireKeepsNullsAndNeverCarriesContents() {
        let t = DictationPolicy.target(DictationFocus(pid: 3, bundleId: nil, appName: "X"), secureInput: true)!
        #expect(t.wire == ["pid": 3, "bundleId": .null, "appName": "X", "role": .null, "insertable": false, "refusal": "secure_field"])
    }

    @Test func insertsThroughSelectedTextFirst() throws {
        let b = FakeDictationBackend(textEdit)
        let r = try DictationInserter.insert("hello\nthere", expectPid: 42, backend: b)
        #expect(r.method == .ax && r.chars == 11 && r.target.appName == "TextEdit")
        #expect(b.calls == ["selectedText"] && b.inserted == ["hello there"])
    }

    @Test func fallsBackToRangeThenTyping() throws {
        let b = FakeDictationBackend(textEdit)
        b.selectedTextWorks = false
        #expect(try DictationInserter.insert("hi", expectPid: nil, backend: b).method == .ax)
        #expect(b.calls == ["selectedText", "range"])

        let c = FakeDictationBackend(textEdit)
        c.selectedTextWorks = false
        c.rangeWorks = false
        #expect(try DictationInserter.insert("hi", expectPid: nil, backend: c).method == .typed)
        #expect(c.calls == ["selectedText", "range", "type"] && c.inserted == ["hi"])

        let slack = FakeDictationBackend(DictationFocus(pid: 9, bundleId: "com.tinyspeck.slackmacgap", appName: "Slack"))
        #expect(try DictationInserter.insert("hi", expectPid: 9, backend: slack).method == .typed)
        #expect(slack.calls == ["type"])
    }

    @Test func refusesBeforeTouchingAnything() {
        for (focus, secure, expect, reason) in [
            (DictationFocus?.none, false, Int?.none, "no_focus"),
            (DictationFocus(pid: 5, bundleId: "com.psyche.helper", appName: "Psyche"), false, nil, "own_window"),
            (DictationFocus(pid: 42, bundleId: "com.apple.TextEdit", appName: "TextEdit", role: "AXTextField", secure: true), false, nil, "secure_field"),
            (textEdit, false, 99, "focus_changed"),
        ] {
            let b = FakeDictationBackend(focus)
            b.secure = secure
            do {
                _ = try DictationInserter.insert("x", expectPid: expect, backend: b)
                Issue.record("expected \(reason)")
            } catch let e as CapabilityError {
                #expect(e.code == .policyDenied && e.reason == reason && e.details["refusal"] == .string(reason))
            } catch { Issue.record("unexpected \(error)") }
            #expect(b.calls.isEmpty)
        }
    }

    // Mocked AX facts for the focused element, as the live backend reads them.
    @Test func chromiumContenteditableAllowedUnderGlobalSecureInput() throws {
        // Electron chat box: role AXTextArea/unknown, no secure subrole; some other app holds secure input.
        #expect(!DictationPolicy.isSecureElement(role: "AXTextArea", subrole: nil))
        let claude = DictationFocus(
            pid: 77, bundleId: "com.anthropic.claudefordesktop", appName: "Claude", role: "AXTextArea",
            element: DictationElementInfo(selectedTextSettable: false, valueSettable: false, hasSelectedRange: false))
        let b = FakeDictationBackend(claude)
        b.secure = true
        let out = try DictationInserter.insert("hello", expectPid: nil, backend: b)
        #expect(out.method == .typed && b.inserted == ["hello"])
    }

    @Test func secureTextFieldRefusedByRoleOrSubrole() {
        #expect(DictationPolicy.isSecureElement(role: "AXTextField", subrole: "AXSecureTextField"))
        #expect(DictationPolicy.isSecureElement(role: "AXSecureTextField", subrole: nil))
        let f = DictationFocus(pid: 77, bundleId: "com.google.Chrome", appName: "Chrome", role: "AXTextField", secure: true)
        #expect(DictationPolicy.refusal(f, secureInput: false) == .secureField)
        #expect(DictationInserter.refusalError(.secureField, target: DictationPolicy.target(f, secureInput: false)).message.contains("Chrome"))
    }

    @Test func unknownRoleAllowed() {
        #expect(!DictationPolicy.isSecureElement(role: nil, subrole: nil))
        #expect(!DictationPolicy.isSecureElement(role: "AXUnknown", subrole: "AXUnknown"))
        #expect(DictationPolicy.refusal(DictationFocus(pid: 9, bundleId: nil, appName: "X", role: nil), secureInput: false) == nil)
    }

    @Test func passwordLabelledAncestorDoesNotMatter() {
        // Only the focused element's own role/subrole count; labels and ancestors are never inputs.
        let f = DictationFocus(
            pid: 9, bundleId: "com.apple.Safari", appName: "Safari", role: "AXTextArea",
            element: DictationElementInfo(selectedTextSettable: true, valueSettable: true, hasSelectedRange: true))
        #expect(DictationPolicy.refusal(f, secureInput: false) == nil)
    }

    @Test func typingStopsWhenFocusMovesIntoAPasswordField() {
        let b = FakeDictationBackend(DictationFocus(pid: 9, bundleId: "com.tinyspeck.slackmacgap", appName: "Slack"))
        b.focusQueue = [b.lastFocus, DictationFocus(pid: 9, bundleId: "com.tinyspeck.slackmacgap", appName: "Slack", secure: true)]
        #expect(throws: CapabilityError.self) { _ = try DictationInserter.insert("secret words", expectPid: nil, backend: b) }
        #expect(b.inserted.isEmpty)
    }

    @Test func rejectsEmptyAndOversizedText() {
        let b = FakeDictationBackend(textEdit)
        #expect(throws: CapabilityError.self) { _ = try DictationInserter.insert("\n\n", expectPid: nil, backend: b) }
        #expect(throws: CapabilityError.self) {
            _ = try DictationInserter.insert(String(repeating: "a", count: DictationPolicy.maxChars + 1), expectPid: nil, backend: b)
        }
        #expect(b.calls.isEmpty)
    }

    @Test func keyTrackerHoldAndChord() {
        var fn = DictationKeyTracker(key: .fn)
        #expect(fn.flagsChanged(keyCode: 63, flags: 0x80_0000) == true)
        #expect(fn.flagsChanged(keyCode: 63, flags: 0x80_0000) == nil)  // repeated flags: no change
        #expect(fn.flagsChanged(keyCode: 56, flags: 0x80_0000 | 0x2) == nil)  // another modifier
        #expect(fn.flagsChanged(keyCode: 63, flags: 0) == false)

        // fn+arrow is a chord: it releases at once and the real release is swallowed.
        #expect(fn.flagsChanged(keyCode: 63, flags: 0x80_0000) == true)
        #expect(fn.keyDown() == false)
        #expect(fn.keyDown() == nil)
        #expect(fn.flagsChanged(keyCode: 63, flags: 0) == nil)
        #expect(!fn.isDown)
        #expect(fn.keyDown() == nil)  // typing while not held is ignored

        // Right Option uses its device bit, so Left Option held alongside does not confuse it.
        var ro = DictationKeyTracker(key: .rightOption)
        #expect(ro.flagsChanged(keyCode: 58, flags: 0x20 | 0x80000) == nil)  // left option
        #expect(ro.flagsChanged(keyCode: 61, flags: 0x40 | 0x20 | 0x80000) == true)
        #expect(ro.flagsChanged(keyCode: 61, flags: 0x20 | 0x80000) == false)
        var rc = DictationKeyTracker(key: .rightCommand)
        #expect(rc.flagsChanged(keyCode: 54, flags: 0x10 | 0x100000) == true)
    }

    // MARK: Two-key watch (voice mode V-H H1)

    @Test func twoKeysHoldIndependently() {
        var set = DictationKeySet([DictationWatchedKey(key: .fn, role: .dictation), DictationWatchedKey(key: .rightOption, role: .voice)])
        #expect(set.flagsChanged(keyCode: 61, flags: 0x40) == [DictationKeyChange(key: .rightOption, role: .voice, down: true)])
        #expect(set.flagsChanged(keyCode: 63, flags: 0x40 | 0x80_0000) == [DictationKeyChange(key: .fn, role: .dictation, down: true)])
        #expect(set.flagsChanged(keyCode: 61, flags: 0x80_0000) == [DictationKeyChange(key: .rightOption, role: .voice, down: false)])
        // A key press while fn is still held chords only fn (Right Option is already up).
        #expect(set.keyDown() == [DictationKeyChange(key: .fn, role: .dictation, down: false)])
        #expect(set.flagsChanged(keyCode: 63, flags: 0) == [])
        #expect(set.keyDown() == [])
    }

    @Test func chordWhileBothHeldReleasesBoth() {
        var set = DictationKeySet([DictationWatchedKey(key: .rightCommand, role: .dictation), DictationWatchedKey(key: .rightOption, role: .voice)])
        _ = set.flagsChanged(keyCode: 54, flags: 0x10)
        _ = set.flagsChanged(keyCode: 61, flags: 0x10 | 0x40)
        #expect(set.keyDown().map(\.down) == [false, false])
    }

    @Test func singleKeyHasNoRole() {
        var set = DictationKeySet([DictationWatchedKey(key: .fn)])
        #expect(set.flagsChanged(keyCode: 63, flags: 0x80_0000) == [DictationKeyChange(key: .fn, role: nil, down: true)])
    }

    @Test func watchPlan() throws {
        #expect(try DictationWatchPlan.keys(DictationWatchParams(key: .fn, keys: nil)) == [DictationWatchedKey(key: .fn)])
        #expect(try DictationWatchPlan.keys(DictationWatchParams(key: nil, keys: nil)).isEmpty)
        // keys wins over key.
        let two = try DictationWatchPlan.keys(DictationWatchParams(key: .fn, keys: [Key(key: .rightOption, role: .voice), Key(key: .fn, role: .dictation)]))
        #expect(two == [DictationWatchedKey(key: .rightOption, role: .voice), DictationWatchedKey(key: .fn, role: .dictation)])
        #expect(throws: CapabilityError.self) { try DictationWatchPlan.keys(DictationWatchParams(key: nil, keys: [Key(key: .fn, role: .voice), Key(key: .fn, role: .dictation)])) }
        #expect(throws: CapabilityError.self) { try DictationWatchPlan.keys(DictationWatchParams(key: nil, keys: [Key(key: .fn, role: .voice), Key(key: .rightOption, role: .voice)])) }
        #expect(throws: CapabilityError.self) { try DictationWatchPlan.keys(DictationWatchParams(key: nil, keys: [])) }
    }
}
