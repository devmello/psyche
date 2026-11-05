import SwiftUI

/// The persona, drawn flat as a moth (no breathing, no glow). Paths come from the mockup SVG
/// (a 32 x 32 viewBox), so the avatar scales at any size; 28 pt in nav bars.
public struct MothAvatar: View {
    private let size: CGFloat

    public init(size: CGFloat = 28) {
        self.size = size
    }

    public var body: some View {
        ZStack {
            MothShape(part: .lowerWings).fill(PsycheColor.inkSoft)
            MothShape(part: .upperWings).fill(PsycheColor.inkText)
            MothShape(part: .body).fill(PsycheColor.text)
            MothShape(part: .antennae)
                .stroke(PsycheColor.text, style: StrokeStyle(lineWidth: size > 40 ? 0.8 * size / 32 : size / 32, lineCap: .round))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

public struct MothShape: Shape {
    public enum Part: Sendable { case upperWings, lowerWings, body, antennae }
    let part: Part

    public init(part: Part) { self.part = part }

    public func path(in rect: CGRect) -> Path {
        var p = Path()
        switch part {
        case .upperWings:
            p.move(to: .init(x: 16, y: 14))
            p.addCurve(to: .init(x: 6, y: 13), control1: .init(x: 12, y: 7), control2: .init(x: 5, y: 7.5))
            p.addCurve(to: .init(x: 16, y: 15.5), control1: .init(x: 6.8, y: 17), control2: .init(x: 12, y: 17.5))
            p.closeSubpath()
            p.move(to: .init(x: 16, y: 14))
            p.addCurve(to: .init(x: 26, y: 13), control1: .init(x: 20, y: 7), control2: .init(x: 27, y: 7.5))
            p.addCurve(to: .init(x: 16, y: 15.5), control1: .init(x: 25.2, y: 17), control2: .init(x: 20, y: 17.5))
            p.closeSubpath()
        case .lowerWings:
            p.move(to: .init(x: 16, y: 17))
            p.addCurve(to: .init(x: 10.5, y: 24), control1: .init(x: 12.5, y: 18.5), control2: .init(x: 9, y: 21.5))
            p.addCurve(to: .init(x: 16, y: 19), control1: .init(x: 11.9, y: 26), control2: .init(x: 15, y: 22))
            p.closeSubpath()
            p.move(to: .init(x: 16, y: 17))
            p.addCurve(to: .init(x: 21.5, y: 24), control1: .init(x: 19.5, y: 18.5), control2: .init(x: 23, y: 21.5))
            p.addCurve(to: .init(x: 16, y: 19), control1: .init(x: 20.1, y: 26), control2: .init(x: 17, y: 22))
            p.closeSubpath()
        case .body:
            p.addRoundedRect(in: .init(x: 15, y: 11, width: 2, height: 12), cornerSize: .init(width: 1, height: 1))
        case .antennae:
            p.move(to: .init(x: 15.6, y: 11.5))
            p.addCurve(to: .init(x: 11.5, y: 7.2), control1: .init(x: 14.5, y: 8.5), control2: .init(x: 13, y: 7.5))
            p.move(to: .init(x: 16.4, y: 11.5))
            p.addCurve(to: .init(x: 20.5, y: 7.2), control1: .init(x: 17.5, y: 8.5), control2: .init(x: 19, y: 7.5))
        }
        let scale = min(rect.width, rect.height) / 32
        return p.applying(CGAffineTransform(scaleX: scale, y: scale)).offsetBy(dx: rect.minX, dy: rect.minY)
    }
}

/// The moth in fixed colors, for surfaces that draw their own background (the Lock Screen, the Dynamic Island),
/// where the asset colors would follow the system appearance instead of the card behind them.
public struct MothMark: View {
    private let size: CGFloat
    private let wings: Color
    private let lowerWings: Color
    private let body_: Color

    public init(size: CGFloat, wings: Color, lowerWings: Color, body: Color) {
        self.size = size
        self.wings = wings
        self.lowerWings = lowerWings
        body_ = body
    }

    public var body: some View {
        ZStack {
            MothShape(part: .lowerWings).fill(lowerWings)
            MothShape(part: .upperWings).fill(wings)
            MothShape(part: .body).fill(body_)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The moth in a 36 pt quiet circle, with the amber dot when something needs you.
public struct MothButtonLabel: View {
    private let needsYou: Bool

    public init(needsYou: Bool) {
        self.needsYou = needsYou
    }

    public var body: some View {
        MothAvatar(size: 26)
            .frame(width: 36, height: 36)
            .background(PsycheColor.fill, in: Circle())
            .overlay(alignment: .topTrailing) {
                if needsYou {
                    Circle().fill(PsycheColor.amber).frame(width: 10, height: 10)
                        .overlay(Circle().strokeBorder(PsycheColor.paper, lineWidth: 2))
                        .offset(x: 1, y: -1)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Circle())
    }
}

#Preview("Moth") {
    HStack(spacing: 20) {
        MothAvatar(size: 64)
        MothButtonLabel(needsYou: true)
        MothAvatar(size: 28)
    }
    .padding().psycheScreen()
}
