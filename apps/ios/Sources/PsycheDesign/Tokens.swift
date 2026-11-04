import SwiftUI

/// The "ink" palette (docs/design/ios-app-2026.md §9): paper and ink, amber for "needs you".
/// Every color lives in Resources/Colors.xcassets with a light and a dark variant.
///
/// Rules: one ink fill per screen; amber means needs-you and nothing else; green and red are
/// status dots only; no gradients, no glows.
public enum PsycheColor {
    /// Screen background.
    public static let paper = Color("paper", bundle: .module)
    /// Cards and grouped rows.
    public static let sheet = Color("sheet", bundle: .module)
    /// Borders of inputs and outline buttons, the grabber.
    public static let rule = Color("rule", bundle: .module)
    /// Hairlines between rows and around cards (lighter than `rule`).
    public static let hairline = Color("hairline", bundle: .module)
    /// Quiet fills: avatars, segmented tracks, user bubbles.
    public static let fill = Color("fill", bundle: .module)
    public static let text = Color("text", bundle: .module)
    /// Evidence lines, timestamps, section headers.
    public static let muted = Color("muted", bundle: .module)
    /// The one filled control per screen (Send, Allow). Light #2C5AA0, dark #3766AD.
    public static let ink = Color("ink", bundle: .module)
    /// Ink as text, links and the moth's wings. Light #2C5AA0, dark #9AB9E9.
    public static let inkText = Color("inkText", bundle: .module)
    /// The moth's lower wings.
    public static let inkSoft = Color("inkSoft", bundle: .module)
    /// The needs-you dot and the approval hairline.
    public static let amber = Color("amber", bundle: .module)
    /// Amber as text.
    public static let amberText = Color("amberText", bundle: .module)
    /// Done (status dots only).
    public static let green = Color("green", bundle: .module)
    /// Failed (status dots only).
    public static let red = Color("red", bundle: .module)
}

/// Spacing and radii used across the components.
public enum PsycheMetrics {
    /// The widest a reading screen gets; wider windows center the column.
    public static let readableWidth: CGFloat = 720
    public static let pagePadding: CGFloat = 20
    public static let sectionSpacing: CGFloat = 22
    public static let cardRadius: CGFloat = 14
    public static let approvalRadius: CGFloat = 16
    public static let rowPadding = EdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 14)
}
