import PsycheDesign
import SwiftUI

/// The primary answer of a sheet (Allow, Send answer, Try again): the standard prominent button. While `isArmed` is
/// false the Gateway's 400 ms arming delay on Allow is still running, so the button is off and says so to VoiceOver.
struct PrimaryAnswerButton: View {
    let title: String
    var isArmed = true
    var isBusy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isBusy { ProgressView() }
                Text(title)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(!isArmed || isBusy)
        .accessibilityHint(isArmed ? "" : String(localized: "Available in a moment", bundle: .module))
    }
}

/// A secondary answer (Deny, Not now): the standard bordered button.
struct SecondaryAnswerButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title).frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
    }
}

/// Deny and Allow side by side; stacked at accessibility text sizes so neither label wraps mid-word.
struct AnswerButtonRow<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @ViewBuilder let content: Content

    var body: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 10)) : AnyLayout(HStackLayout(spacing: 10))
        layout { content }
    }
}

/// The line that replaces the buttons once the Gateway took the answer.
struct AnsweredLine: View {
    let text: String
    /// A denied answer is a neutral mark: green and red are status colours, and Deny is a decision.
    var denied = false

    var body: some View {
        Label {
            Text(text).font(.callout.weight(.medium))
        } icon: {
            Image(systemName: denied ? "xmark.circle.fill" : "checkmark.circle.fill")
                .foregroundStyle(denied ? Color.secondary : PsycheColor.green)
        }
        .frame(maxWidth: .infinity, minHeight: 44)
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
            StatusDot(.failed, notice(message), textColor: .primary, font: .footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
            AnswerButtonRow {
                SecondaryAnswerButton(title: String(localized: "Not now", bundle: .module), action: cancel)
                PrimaryAnswerButton(title: String(localized: "Try again", bundle: .module), action: retry)
            }
        }
    }
}
