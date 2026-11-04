import SwiftUI

/// The one filled control per screen: Send, Allow. Ink fill, white label, a capsule.
public struct InkButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(PsycheColor.ink, in: Capsule())
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.4)
    }
}

/// Everything else that is a button-shaped answer: Deny, Cancel. Sheet fill, rule border.
public struct OutlineButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .foregroundStyle(PsycheColor.text)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(PsycheColor.sheet, in: Capsule())
            .overlay(Capsule().strokeBorder(PsycheColor.rule, lineWidth: 1))
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
    }
}

extension ButtonStyle where Self == InkButtonStyle {
    public static var psycheInk: InkButtonStyle { InkButtonStyle() }
}

extension ButtonStyle where Self == OutlineButtonStyle {
    public static var psycheOutline: OutlineButtonStyle { OutlineButtonStyle() }
}
