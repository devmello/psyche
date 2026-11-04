import SwiftUI

/// A muted semibold header above a card. `needsYou` puts the amber dot in front; `count` follows a dot.
public struct SectionHeader: View {
    private let title: String
    private let count: Int?
    private let needsYou: Bool

    public init(_ title: String, count: Int? = nil, needsYou: Bool = false) {
        self.title = title
        self.count = count
        self.needsYou = needsYou
    }

    public var body: some View {
        HStack(spacing: 6) {
            if needsYou { Circle().fill(PsycheColor.amber).frame(width: 8, height: 8).accessibilityHidden(true) }
            Text(count.map { "\(title) · \($0)" } ?? title)
        }
        .font(.psycheSection)
        .foregroundStyle(PsycheColor.muted)
        .accessibilityAddTraits(.isHeader)
    }
}
