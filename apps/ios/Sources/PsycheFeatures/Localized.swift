import Foundation

/// Text the Gateway client and the store produce in English (a card's "needs your Mac" note, "Couldn't
/// answer"), looked up in the app's string catalog where it is shown. An unknown text falls through as is.
func notice(_ text: String) -> String {
    String(localized: String.LocalizationValue(text), bundle: .module)
}
