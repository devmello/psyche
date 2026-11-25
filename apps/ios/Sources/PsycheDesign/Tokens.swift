import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The "ink" palette (docs/design/ios-app-2026.md §9): paper and ink, amber for "needs you".
/// Neutrals map to system semantic colors, so dark mode and Increase Contrast follow the system. Ink, amber and
/// the status colors live in Resources/Colors.xcassets with a light and a dark variant.
///
/// Rules: one ink fill per screen; amber means needs-you and nothing else; green and red are
/// status dots only; no gradients, no glows.
public enum PsycheColor {
    /// Screen background: the system grouped background.
    public static let paper = Color(platform: .systemGroupedBackground)
    /// Cards and grouped rows: the secondary grouped background.
    public static let sheet = Color(platform: .secondarySystemGroupedBackground)
    /// Borders of inputs and outline buttons, the grabber.
    public static let rule = Color(platform: .separator)
    /// Hairlines between rows and around cards.
    public static let hairline = Color(platform: .separator)
    /// Quiet fills: avatars, segmented tracks, user bubbles.
    public static let fill = Color(platform: .tertiarySystemFill)
    public static let text = Color.primary
    /// Evidence lines, timestamps, section headers.
    public static let muted = Color.secondary
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

extension Color {
    fileprivate enum Semantic {
        case systemGroupedBackground, secondarySystemGroupedBackground, separator, tertiarySystemFill
    }

    /// A system semantic color. On macOS (package tests only) the nearest AppKit equivalent.
    fileprivate init(platform semantic: Semantic) {
        #if canImport(UIKit)
        switch semantic {
        case .systemGroupedBackground: self.init(uiColor: .systemGroupedBackground)
        case .secondarySystemGroupedBackground: self.init(uiColor: .secondarySystemGroupedBackground)
        case .separator: self.init(uiColor: .separator)
        case .tertiarySystemFill: self.init(uiColor: .tertiarySystemFill)
        }
        #else
        switch semantic {
        case .systemGroupedBackground: self.init(nsColor: .windowBackgroundColor)
        case .secondarySystemGroupedBackground: self.init(nsColor: .controlBackgroundColor)
        case .separator: self.init(nsColor: .separatorColor)
        case .tertiarySystemFill: self.init(nsColor: .quaternarySystemFill)
        }
        #endif
    }
}
