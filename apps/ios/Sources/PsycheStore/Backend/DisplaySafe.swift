import Foundation

/// Text the phone shows from the model's own questions, made safe the way the desktop card makes it
/// (`sanitizeDisplay` in `@psyche/permissions/cards`): line breaks become ⏎, hidden format characters (bidi
/// overrides, zero-width joiners) show as ⟨U+XXXX⟩, and other control characters as �. A model-written string
/// can't then hide or reorder what the owner reads.
public enum DisplaySafe {
    public static func text(_ value: String) -> String {
        var out = ""
        for scalar in value.replacingOccurrences(of: "\r\n", with: "\n").unicodeScalars {
            switch scalar {
            case "\n", "\r", "\u{85}":
                // NEL (U+0085) is a line break in iOS text layout, so it gets the same marker as LF and CR.
                out += "⏎"
            case "\u{2028}", "\u{2029}", "\u{115F}", "\u{1160}", "\u{3164}", "\u{FFA0}", "\u{180E}":
                out += marker(scalar)
            default:
                if scalar.properties.generalCategory == .format {
                    out += marker(scalar)
                } else if scalar.value <= 0x08 || scalar.value == 0x0B || scalar.value == 0x0C
                    || (0x0E...0x1F).contains(scalar.value) || (0x7F...0x9F).contains(scalar.value) {
                    out += "\u{FFFD}"
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out
    }

    private static func marker(_ scalar: Unicode.Scalar) -> String {
        let hex = String(scalar.value, radix: 16, uppercase: true)
        return "⟨U+" + String(repeating: "0", count: max(0, 4 - hex.count)) + hex + "⟩"
    }
}
