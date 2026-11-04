import PsycheDesign
import PsycheStore
import SwiftUI

/// Draws a loadable value: the redacted skeleton while it loads (matching the loaded layout), the value
/// when it arrives, and "Try again" when it fails (docs/design/ios-app-2026.md §4).
struct PhaseView<Value: Sendable, Content: View>: View {
    let phase: LoadPhase<Value>
    let skeleton: Value
    let retry: () async -> Void
    @ViewBuilder let content: (Value) -> Content

    var body: some View {
        switch phase {
        case .idle, .loading:
            content(skeleton).redacted(reason: .placeholder).allowsHitTesting(false)
        case .loaded(let value):
            content(value)
        case .failed(let message):
            VStack(spacing: 12) {
                Text("Couldn't load this").font(.headline).foregroundStyle(PsycheColor.text)
                Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
                Button("Try again") { Task { await retry() } }
                    .buttonStyle(.psycheOutline)
                    .frame(maxWidth: 220)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
        }
    }
}

/// A quiet progress bar: a track and a muted fill. Not a sparkline, not a gradient.
struct ProgressBar: View {
    let fraction: Double

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(PsycheColor.fill)
                Capsule().fill(PsycheColor.muted).frame(width: proxy.size.width * min(max(fraction, 0), 1))
            }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }
}
