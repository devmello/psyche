import SwiftUI

/// Status is a dot plus words, never a colored pill.
public struct StatusDot: View {
    public enum Kind: Sendable {
        case neutral
        /// Amber means "needs you" and nothing else.
        case needsYou
        case done
        case failed

        var dot: Color {
            switch self {
            case .neutral: PsycheColor.muted
            case .needsYou: PsycheColor.amber
            case .done: PsycheColor.green
            case .failed: PsycheColor.red
            }
        }
    }

    private let kind: Kind
    private let text: String
    private let textColor: Color
    private let font: Font

    public init(_ kind: Kind, _ text: String, textColor: Color? = nil, font: Font = .footnote) {
        self.kind = kind
        self.text = text
        self.textColor = textColor ?? (kind == .needsYou ? PsycheColor.amberText : PsycheColor.muted)
        self.font = font
    }

    public var body: some View {
        HStack(spacing: 6) {
            Circle().fill(kind.dot).frame(width: 8, height: 8).accessibilityHidden(true)
            Text(text).font(font).foregroundStyle(textColor)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A bare dot for rows that already say the words elsewhere.
public struct NeedsYouDot: View {
    public init() {}
    public var body: some View {
        Circle().fill(PsycheColor.amber).frame(width: 8, height: 8)
            .accessibilityLabel("Needs you")
    }
}
