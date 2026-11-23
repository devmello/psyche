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
    /// The skeleton holds its place from the first frame (no layout shift) but is only drawn after
    /// `PsycheMotion.Duration.skeletonDelay`: a load faster than that shows nothing at all.
    @State private var skeletonVisible = false

    private enum Stage { case loading, loaded, failed }
    private var stage: Stage {
        switch phase {
        case .idle, .loading: .loading
        case .loaded: .loaded
        case .failed: .failed
        }
    }

    var body: some View {
        // Skeleton → content is a 150 ms fade-in (spec §4.7); the stage change is the only thing that animates.
        // A Group, not a ZStack: the content is often several siblings (Home's sections) or List rows, which
        // must join the parent's stack or list. The outgoing stage leaves at once so it never stacks beside
        // the incoming one.
        Group { stageBody }
            .psycheFade(PsycheMotion.Duration.short, value: stage)
            .task(id: stage == .loading) {
                guard stage == .loading else { return }
                skeletonVisible = false
                try? await Task.sleep(for: .seconds(PsycheMotion.Duration.skeletonDelay))
                skeletonVisible = true
            }
    }

    private static var stageTransition: AnyTransition { .asymmetric(insertion: .opacity, removal: .identity) }

    @ViewBuilder
    private var stageBody: some View {
        switch phase {
        case .idle, .loading:
            content(skeleton).redacted(reason: .placeholder).allowsHitTesting(false)
                .opacity(skeletonVisible ? 1 : 0)
                .transition(Self.stageTransition)
        case .loaded(let value):
            content(value).transition(Self.stageTransition)
        case .failed(let message):
            VStack(spacing: 12) {
                Text("Couldn't load this", bundle: .module).font(.headline).foregroundStyle(PsycheColor.text)
                Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
                Button(String(localized: "Try again", bundle: .module)) { Task { await retry() } }
                    .buttonStyle(.psycheOutline)
                    .frame(maxWidth: 220)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
            .transition(Self.stageTransition)
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
