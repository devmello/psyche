import CoreGraphics
import Foundation

/// A key chord such as `cmd+shift+t` or `return` (feature J2 "key chords"). Named keys and letters
/// map to ANSI virtual key codes: spike 04 found Chromium's typeahead ignores unicode-string events
/// (virtual key 0), so keys are always sent as keycode events.
public struct KeyChord: Sendable, Equatable {
    public var keyCode: CGKeyCode
    public var flags: CGEventFlags
    public var name: String

    public init(keyCode: CGKeyCode, flags: CGEventFlags, name: String) {
        self.keyCode = keyCode
        self.flags = flags
        self.name = name
    }

    public static func == (a: KeyChord, b: KeyChord) -> Bool {
        a.keyCode == b.keyCode && a.flags.rawValue == b.flags.rawValue && a.name == b.name
    }

    static let codes: [String: CGKeyCode] = {
        var m: [String: CGKeyCode] = [
            "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
            "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
            "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
            "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
            "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
            "forwarddelete": 117, "fwddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
            "left": 123, "right": 124, "down": 125, "up": 126, "keypadenter": 76, "help": 114,
        ]
        let fkeys: [CGKeyCode] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90]
        for (i, code) in fkeys.enumerated() { m["f\(i + 1)"] = code }
        return m
    }()

    /// Parses `mod+mod+key`. Modifiers: cmd/command, shift, opt/option/alt, ctrl/control, fn.
    public static func parse(_ text: String) throws -> KeyChord {
        let parts = text.lowercased().split(separator: "+", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        var flags = CGEventFlags()
        var key: String?
        for (i, part) in parts.enumerated() {
            // "cmd++" means cmd and the "+" key is not supported; "=" with shift is.
            switch part {
            case "cmd", "command", "⌘": flags.insert(.maskCommand)
            case "shift", "⇧": flags.insert(.maskShift)
            case "opt", "option", "alt", "⌥": flags.insert(.maskAlternate)
            case "ctrl", "control", "⌃": flags.insert(.maskControl)
            case "fn": flags.insert(.maskSecondaryFn)
            default:
                guard key == nil, i == parts.count - 1, !part.isEmpty else {
                    throw CapabilityError.invalidParams("invalid key chord \"\(text)\"", field: "keys")
                }
                key = part
            }
        }
        guard let key, let code = codes[key] else {
            throw CapabilityError.invalidParams("unknown key in \"\(text)\"", field: "keys")
        }
        return KeyChord(keyCode: code, flags: flags, name: text.lowercased())
    }

    /// True when the chord is plain Esc (the stop key is never injectable while a session runs).
    public var isBareEscape: Bool { keyCode == 53 && flags.isEmpty }

    /// Chords that close or quit apps, log out or lock: refused unless the call is approved.
    public var isHighRisk: Bool {
        guard flags.contains(.maskCommand) else { return false }
        let quitOrClose: Set<CGKeyCode> = [12, 13]  // cmd+q, cmd+w
        if quitOrClose.contains(keyCode) { return true }
        if flags.contains(.maskShift), keyCode == 12 { return true }  // log out
        if flags.contains(.maskControl), keyCode == 12 { return true }  // lock screen
        if keyCode == 51 { return true }  // cmd+delete: move to trash
        return false
    }
}

/// Keys that send in messaging and mail apps (#270): an interact grant on Messages or Mail must
/// not let Return send a message as an ordinary write. docs/05 §3.1 classes third-party sends as
/// destructive, so these need an approval of their own.
public enum SendKeys {
    static let apps = [
        "com.apple.MobileSMS", "com.apple.mail", "com.apple.iChat", "com.tinyspeck.slackmacgap", "net.whatsapp.WhatsApp",
        "desktop.WhatsApp", "ru.keepcoder.Telegram", "org.telegram.desktop", "com.hnc.Discord", "org.whispersystems.signal-desktop",
        "com.microsoft.teams2", "com.microsoft.teams", "com.microsoft.Outlook", "com.readdle.smartemail-Mac", "com.superhuman.electron",
        "com.facebook.archon", "com.google.Chrome.app.", "com.spark.desktop", "it.bloop.airmail2", "com.freron.MailMate",
    ]

    public static func isMessagingApp(_ bundleId: String?) -> Bool {
        guard let id = bundleId?.lowercased() else { return false }
        return apps.contains { p in
            let q = p.lowercased()
            return q.hasSuffix(".") ? id.hasPrefix(q) : id == q
        }
    }

    /// Return / keypad Enter with any modifiers, and Mail's cmd+shift+D.
    public static func isSendChord(_ c: KeyChord) -> Bool {
        if c.keyCode == 36 || c.keyCode == 76 { return true }
        return c.keyCode == 2 && c.flags.contains(.maskCommand) && c.flags.contains(.maskShift)
    }

    /// Typed text that contains a line break presses Return on the way.
    public static func textSends(_ text: String) -> Bool {
        text.unicodeScalars.contains { $0 == "\n" || $0 == "\r" || $0 == "\u{2028}" || $0 == "\u{2029}" }
    }
}

/// Splits text for unicode keyboard events (CGEvent carries at most ~20 UTF-16 units per event).
public enum TypingChunks {
    public static func split(_ text: String, maxUnits: Int = 16) -> [[UniChar]] {
        var out: [[UniChar]] = []
        var current: [UniChar] = []
        for ch in text {  // never split a grapheme (emoji, combining marks) across events
            let units = Array(String(ch).utf16)
            if current.count + units.count > maxUnits, !current.isEmpty {
                out.append(current)
                current = []
            }
            current.append(contentsOf: units)
        }
        if !current.isEmpty { out.append(current) }
        return out
    }
}
