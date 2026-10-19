import Foundation

/// Labels and custom actions that create, send or destroy data while looking like ordinary buttons
/// (spike 04 guidance 6: `trash`, `Delete`, `Send`, "Add List: Groceries"). Pressing one needs an
/// approved invocation even when the app's tier allows interaction.
public enum RiskLabels {
    static let words = [
        "delete", "trash", "remove", "erase", "clear", "discard", "empty", "send", "submit", "purchase", "buy", "pay",
        "transfer", "unsubscribe", "sign out", "log out", "reset", "uninstall", "format", "quit", "move to trash",
        "add list",
    ]

    /// True when `label` or `customAction` contains a risky word as a whole word or phrase.
    public static func isRisky(label: String?, customAction: String? = nil) -> Bool {
        for text in [label, customAction].compactMap({ $0?.lowercased() }) {
            let tokens = " " + text.map { $0.isLetter || $0.isNumber ? $0 : " " }.reduce(into: "") { $0.append($1) } + " "
            if words.contains(where: { tokens.contains(" \($0) ") }) { return true }
        }
        return false
    }
}
