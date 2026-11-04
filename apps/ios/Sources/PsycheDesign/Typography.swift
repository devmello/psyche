import SwiftUI

// Type (docs/design/ios-app-2026.md §9): page titles in New York (the system serif, weight at most 600),
// everything else SF Pro, ids, times and amounts in SF Mono. Every style is a text style, so Dynamic Type
// scales it.

extension Font {
    /// Ids, times, amounts, evidence lines.
    public static func psycheMono(_ style: Font.TextStyle = .caption, weight: Font.Weight = .regular) -> Font {
        .system(style, design: .monospaced, weight: weight)
    }

    /// Page titles: New York, semibold.
    public static func psycheTitle(_ style: Font.TextStyle = .largeTitle) -> Font {
        .system(style, design: .serif, weight: .semibold)
    }

    /// Row titles.
    public static var psycheRow: Font { .subheadline }
    /// Section headers.
    public static var psycheSection: Font { .footnote.weight(.semibold) }
}

extension View {
    /// A page title: serif, semibold, a touch of negative tracking at the large size.
    public func psycheTitle(_ style: Font.TextStyle = .largeTitle) -> some View {
        font(.psycheTitle(style)).accessibilityAddTraits(.isHeader)
    }
}
