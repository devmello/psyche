import SwiftUI

extension View {
    /// The paper under a screen.
    public func psycheScreen() -> some View {
        background(PsycheColor.paper.ignoresSafeArea())
    }
}

/// A 1 pt line between rows.
public struct HairlineDivider: View {
    public init() {}
    public var body: some View {
        Rectangle().fill(PsycheColor.hairline).frame(height: 1)
            .accessibilityHidden(true)
    }
}

/// A sheet of paper: white (or dark gray) with a hairline border. Rows inside separate with `HairlineDivider`.
public struct PaperCard<Content: View>: View {
    private let padding: EdgeInsets
    private let radius: CGFloat
    private let border: Color
    private let content: Content

    public init(
        padding: EdgeInsets = EdgeInsets(),
        radius: CGFloat = PsycheMetrics.cardRadius,
        border: Color = PsycheColor.hairline,
        @ViewBuilder content: () -> Content
    ) {
        self.padding = padding
        self.radius = radius
        self.border = border
        self.content = content()
    }

    /// Uniform padding for cards that hold free content rather than rows.
    public init(
        padding: CGFloat, radius: CGFloat = PsycheMetrics.cardRadius, border: Color = PsycheColor.hairline,
        @ViewBuilder content: () -> Content
    ) {
        self.init(
            padding: EdgeInsets(top: padding, leading: padding, bottom: padding, trailing: padding),
            radius: radius, border: border, content: content)
    }

    public var body: some View {
        // One stack, so several rows share one card instead of each getting its own.
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(PsycheColor.sheet)
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(border, lineWidth: 1))
    }
}

/// The header of a screen: an optional muted line above a serif title, and a trailing control.
public struct PageHeader<Trailing: View>: View {
    private let title: String
    private let eyebrow: String?
    private let trailing: Trailing

    public init(_ title: String, eyebrow: String? = nil, @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.eyebrow = eyebrow
        self.trailing = trailing()
    }

    public var body: some View {
        HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 2) {
                if let eyebrow {
                    Text(eyebrow).font(.footnote).foregroundStyle(PsycheColor.muted)
                }
                Text(title).psycheTitle().foregroundStyle(PsycheColor.text)
            }
            Spacer(minLength: 12)
            trailing
        }
    }
}

extension PageHeader where Trailing == EmptyView {
    public init(_ title: String, eyebrow: String? = nil) {
        self.init(title, eyebrow: eyebrow) { EmptyView() }
    }
}

/// A round avatar with initials, for people and nudges.
public struct InitialsAvatar: View {
    private let initials: String
    private let size: CGFloat

    public init(_ initials: String, size: CGFloat = 32) {
        self.initials = initials
        self.size = size
    }

    public var body: some View {
        Text(initials)
            .font(.system(size: size * 0.4, weight: .semibold))
            .foregroundStyle(PsycheColor.muted)
            .frame(width: size, height: size)
            .background(PsycheColor.fill, in: Circle())
            .accessibilityHidden(true)
    }
}
