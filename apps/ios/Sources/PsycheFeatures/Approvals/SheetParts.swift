import PsycheDesign
import SwiftUI

/// The ink button of a sheet. While `progress` < 1 it is still arming (the Gateway enforces a 400 ms delay
/// on Allow): the ink fills in from the left so the wait is visible, and taps are ignored.
struct ArmingInkButton: View {
    let title: String
    var progress: Double = 1
    var isBusy = false
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isBusy { ProgressView().tint(.white) }
                Text(title)
            }
            .font(.callout.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background {
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        PsycheColor.ink.opacity(0.4)
                        PsycheColor.ink.frame(width: proxy.size.width * min(max(progress, 0), 1))
                    }
                }
                .clipShape(Capsule())
            }
            .opacity(isEnabled ? 1 : 0.4)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(progress < 1 || isBusy)
        .accessibilityHint(progress < 1 ? "Available in a moment" : "")
    }
}

/// A secondary answer (Deny, Not now) on Liquid Glass: the button row of a sheet is chrome, so it is glass.
struct GlassTextButton: View {
    let title: String
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.callout.weight(.semibold))
                .foregroundStyle(PsycheColor.text)
                .frame(maxWidth: .infinity, minHeight: 52)
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .background(PsycheColor.sheet.opacity(0.6), in: Capsule())
        .glassEffect(.regular.interactive(), in: .capsule)
        .overlay(Capsule().strokeBorder(PsycheColor.rule, lineWidth: 1))
        .opacity(isEnabled ? 1 : 0.4)
    }
}

/// The line that replaces the buttons once the Gateway took the answer.
struct AnsweredLine: View {
    let text: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.title3)
                .foregroundStyle(PsycheColor.green)
            Text(text).font(.callout.weight(.medium)).foregroundStyle(PsycheColor.text)
        }
        .frame(maxWidth: .infinity, minHeight: 52)
        .transition(.opacity)
        .accessibilityElement(children: .combine)
    }
}

/// The Gateway's own message after a failed answer, with "Try again".
struct AnswerError: View {
    let message: String
    let retry: () -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            StatusDot(.failed, message, textColor: PsycheColor.text, font: .footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 10) {
                GlassTextButton(title: "Not now", action: cancel)
                ArmingInkButton(title: "Try again", action: retry)
            }
        }
    }
}
