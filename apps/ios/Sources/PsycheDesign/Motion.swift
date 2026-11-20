import SwiftUI

/// Psyche's motion tokens (docs/design/motion.md §2). Every duration, spring and transition in the app
/// comes from this file: no view types a number. The rules in short: motion explains a change and never
/// decorates; typing, scrolling, selection and sending get none; springs are critically damped (bounce 0)
/// with two emphasis moments allowed a little (≤ 0.15); every animation has a Reduce Motion form.
public enum PsycheMotion {
    // MARK: Durations (tweens: opacity and colour only; things that move use springs)

    public enum Duration {
        public static let instant: TimeInterval = 0
        /// Press and focus colour, icon tint.
        public static let micro: TimeInterval = 0.1
        /// Fades in and out, skeleton → content, reduced-motion crossfades.
        public static let short: TimeInterval = 0.15
        /// Card opacity on enter, toast enter, route crossfade.
        public static let medium: TimeInterval = 0.22
        /// Backdrops and other large fades only.
        public static let long: TimeInterval = 0.32
        /// Exits run at 70 % of the enter duration: they should finish early.
        public static let exitFactor: Double = 0.7
        /// No loading UI at all before this.
        public static let skeletonDelay: TimeInterval = 0.15
        /// Per-item stagger on the first load, capped at `staggerLimit` items.
        public static let staggerStep: TimeInterval = 0.02
        public static let staggerLimit = 5
        /// "Jump to latest" scrolls for at most this long.
        public static let jumpScroll: TimeInterval = 0.3
        /// Allow's arming fill follows the Gateway's own 400 ms delay, so it is that wait made visible,
        /// not a design duration.
        public static let arming: TimeInterval = 0.4
        /// The working pulse (spec §4.6): one shared 1.2 s opacity pulse, linear.
        public static let pulse: TimeInterval = 1.2
    }

    // MARK: Distances

    public enum Distance {
        /// Cards and rows rise this far as they fade in.
        public static let rise: CGFloat = 8
        /// Popovers and dialogs scale in from here.
        public static let popScale: CGFloat = 0.97
        /// Small glass controls (Jump to latest) scale in from here.
        public static let controlScale: CGFloat = 0.9
        /// The approval receipt settles from here.
        public static let receiptScale: CGFloat = 0.96
    }

    // MARK: Springs (anything that moves or resizes)

    /// SwiftUI's perceptual `duration` and `bounce`.
    public enum Spring: CaseIterable, Sendable {
        /// Segmented-control and tab indicators.
        case micro
        /// Rows and cards entering, disclosure chevrons.
        case snappy
        /// The default: layout moves, list inserts and removals.
        case smooth
        /// Sheets, the agent sheet, screen swaps.
        case gentle
        /// Approval card → receipt, a milestone completing. The only two places with bounce.
        case emphasis
        /// Pointer- and finger-driven drags that follow the hand.
        case interactive

        public var duration: TimeInterval {
            switch self {
            case .micro: 0.20
            case .snappy: 0.30
            case .smooth: 0.35
            case .gentle: 0.50
            case .emphasis: 0.45
            case .interactive: 0.15
            }
        }

        public var bounce: Double {
            switch self {
            case .micro, .smooth, .gentle: 0
            case .snappy: 0.10
            case .emphasis: 0.15
            case .interactive: 0.14
            }
        }

        public var animation: Animation { .spring(duration: duration, bounce: bounce) }
    }

    // MARK: Tweens

    /// `ease.standard`, `ease.enter` and `ease.exit` from the spec, for opacity and colour only.
    public enum Ease: Sendable {
        case standard, enter, exit

        func animation(duration: TimeInterval) -> Animation {
            switch self {
            case .standard: .timingCurve(0.2, 0.8, 0.2, 1, duration: duration)
            case .enter: .timingCurve(0.16, 1, 0.3, 1, duration: duration)
            case .exit: .timingCurve(0.4, 0, 1, 1, duration: duration)
            }
        }
    }

    /// A fade in (colour or opacity).
    public static func fade(_ duration: TimeInterval = Duration.short, ease: Ease = .enter) -> Animation {
        ease.animation(duration: duration)
    }

    /// A fade out: 70 % of the enter duration, accelerating away, no movement.
    public static func fadeOut(_ duration: TimeInterval = Duration.short) -> Animation {
        Ease.exit.animation(duration: duration * Duration.exitFactor)
    }

    /// Progress bars and the working pulse.
    public static func linear(_ duration: TimeInterval) -> Animation { .linear(duration: duration) }

    /// The working pulse: opacity 40 % → 100 %, linear, forever. Callers stop it under Reduce Motion.
    public static let pulse: Animation = .linear(duration: Duration.pulse).repeatForever(autoreverses: true)
    public static let pulseLow: Double = 0.4

    // MARK: Transitions

    public enum Kind: Sendable {
        /// A card or row appears: fade plus an 8 pt rise. It leaves with a fade and no movement.
        case rise
        /// A popover or dialog: scale from 0.97 plus fade. It leaves with a fade.
        case pop
        /// A small control appearing: scale from 0.9 plus fade.
        case control
        /// A bar rising from the bottom edge (toasts, offers).
        case toast
        /// The approval receipt: settles in from a little smaller.
        case receipt
        /// Opacity only.
        case fade
    }

    static func transition(_ kind: Kind, reduced: Bool) -> AnyTransition {
        if reduced || kind == .fade { return .opacity }
        let enter: AnyTransition
        switch kind {
        case .rise: enter = .opacity.combined(with: .offset(y: Distance.rise))
        case .pop: enter = .opacity.combined(with: .scale(scale: Distance.popScale))
        case .control: enter = .opacity.combined(with: .scale(scale: Distance.controlScale))
        case .toast: enter = .opacity.combined(with: .move(edge: .bottom))
        case .receipt: enter = .opacity.combined(with: .scale(scale: Distance.receiptScale))
        case .fade: enter = .opacity
        }
        return .asymmetric(insertion: enter, removal: .opacity)
    }
}

/// How the current environment wants motion. Hold one as a stored property of a view
/// (`private let motion = MotionContext()`); it reads Reduce Motion from the environment, so a view never
/// touches `accessibilityReduceMotion` itself.
///
/// Reduced form (spec §6): anything that moves becomes a crossfade of at most 150 ms; layout changes
/// are instant.
public struct MotionContext: DynamicProperty {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init() {}

    public var reduced: Bool { reduceMotion }

    /// A spring, or in the reduced form a 150 ms ease (for state changes whose transition is opacity only).
    public func animation(_ spring: PsycheMotion.Spring) -> Animation {
        reduceMotion ? PsycheMotion.fade() : spring.animation
    }

    /// For layout moves that have no opacity change to fall back on: instant when reduced.
    public func layout(_ spring: PsycheMotion.Spring = .smooth) -> Animation? {
        reduceMotion ? nil : spring.animation
    }

    /// A tween that is the same either way (it only changes opacity or colour).
    public func fade(_ duration: TimeInterval = PsycheMotion.Duration.short) -> Animation {
        PsycheMotion.fade(duration)
    }

    public func transition(_ kind: PsycheMotion.Kind) -> AnyTransition {
        PsycheMotion.transition(kind, reduced: reduceMotion)
    }

    /// Runs `body` inside an animation (the reduced form under Reduce Motion).
    public func perform<Result>(_ spring: PsycheMotion.Spring, _ body: () throws -> Result) rethrows -> Result {
        try withAnimation(animation(spring), body)
    }

    /// Runs `body` with a layout animation, or at once when reduced.
    public func performLayout<Result>(_ spring: PsycheMotion.Spring = .smooth, _ body: () throws -> Result) rethrows -> Result {
        try withAnimation(layout(spring), body)
    }

    /// The delay for the n-th item of a first load: 20 ms apart, the first five only.
    public func stagger(_ index: Int) -> TimeInterval {
        reduceMotion ? 0 : Double(min(index, PsycheMotion.Duration.staggerLimit)) * PsycheMotion.Duration.staggerStep
    }
}

// MARK: - View helpers

private struct SpringAnimation<Value: Equatable>: ViewModifier {
    let spring: PsycheMotion.Spring
    let value: Value
    private let motion = MotionContext()

    func body(content: Content) -> some View {
        content.animation(motion.animation(spring), value: value)
    }
}

private struct LayoutAnimation<Value: Equatable>: ViewModifier {
    let spring: PsycheMotion.Spring
    let value: Value
    private let motion = MotionContext()

    func body(content: Content) -> some View {
        content.animation(motion.layout(spring), value: value)
    }
}

private struct FadeAnimation<Value: Equatable>: ViewModifier {
    let duration: TimeInterval
    let value: Value

    func body(content: Content) -> some View {
        content.animation(PsycheMotion.fade(duration), value: value)
    }
}

extension View {
    /// Animates changes of `value` on a spring token (a short fade under Reduce Motion).
    public func psycheAnimation<Value: Equatable>(_ spring: PsycheMotion.Spring = .smooth, value: Value) -> some View {
        modifier(SpringAnimation(spring: spring, value: value))
    }

    /// Animates a layout change of `value` on a spring token; instant under Reduce Motion.
    public func psycheLayoutAnimation<Value: Equatable>(_ spring: PsycheMotion.Spring = .smooth, value: Value) -> some View {
        modifier(LayoutAnimation(spring: spring, value: value))
    }

    /// Animates an opacity or colour change of `value` with a fade token.
    public func psycheFade<Value: Equatable>(_ duration: TimeInterval = PsycheMotion.Duration.short, value: Value) -> some View {
        modifier(FadeAnimation(duration: duration, value: value))
    }
}

// MARK: - Zoom navigation (iOS)

/// The namespace the root view owns, so a list in one place and the page it opens in another can share a
/// zoom transition (Library thumbnail → file, avatar → agent sheet).
private struct ZoomNamespaceKey: EnvironmentKey {
    static let defaultValue: Namespace.ID? = nil
}

extension EnvironmentValues {
    public var psycheZoomNamespace: Namespace.ID? {
        get { self[ZoomNamespaceKey.self] }
        set { self[ZoomNamespaceKey.self] = newValue }
    }
}

extension View {
    /// Marks this view as where a zoom transition starts. A no-op without a namespace (previews, tests).
    @ViewBuilder
    public func psycheZoomSource(id: some Hashable, in namespace: Namespace.ID?) -> some View {
        #if os(iOS)
        if let namespace { matchedTransitionSource(id: id, in: namespace) } else { self }
        #else
        self
        #endif
    }

    /// Makes this page (or sheet) zoom out of the source with the same id.
    @ViewBuilder
    public func psycheZoomDestination(id: some Hashable, in namespace: Namespace.ID?) -> some View {
        #if os(iOS)
        if let namespace { navigationTransition(.zoom(sourceID: id, in: namespace)) } else { self }
        #else
        self
        #endif
    }
}
