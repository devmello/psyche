import PsycheDesign
import PsycheStore
import SwiftUI

// Shared plumbing for the widget renderer: where a widget is drawn, how a control posts through the
// backend, the tone vocabulary and the compact control styles. Widget content never uses raw colors
// or Liquid Glass; everything maps onto `PsycheColor` (docs/design/ios-app-2026.md §9).

/// Where a widget is drawn. The Feed shows a static snapshot, and Home's Pinned section (`overview`)
/// a live one, both with `open` and `reply` controls only; chat draws every control.
public enum WidgetSurface: Sendable, Equatable {
    case chat, feed, overview
}

/// The backend widgets in chat load and act through. The app injects its own; the default is the fixture.
extension EnvironmentValues {
    @Entry public var widgetBackend: any WidgetBackend = FixtureBackend.shared
}

/// What the host app lends a widget for actions that leave it.
public struct WidgetHandlers {
    /// Opens an app route an `open` action names (`/chat/<id>`, `/library/<id>`; the host maps it with
    /// `Route(appPath:)`) and says whether it could. Without one those controls explain they aren't available.
    public var openRoute: (@MainActor (String) -> Bool)?
    /// Puts text in the composer (Feed and Home, which have no open chat of their own).
    public var prefillReply: (@MainActor (String) -> Void)?

    public init(openRoute: (@MainActor (String) -> Bool)? = nil, prefillReply: (@MainActor (String) -> Void)? = nil) {
        self.openRoute = openRoute
        self.prefillReply = prefillReply
    }
}

extension EnvironmentValues {
    @Entry public var widgetHandlers = WidgetHandlers()
}

/// What a widget's controls need: the widget, its backend and where it is shown. One per `WidgetView`.
@MainActor @Observable
final class WidgetRuntime {
    let widgetID: String
    let backend: any WidgetBackend
    let surface: WidgetSurface
    var isLive: Bool
    var isUntrusted: Bool
    /// The one control drawn with the ink fill (its primary button), or nil.
    var primaryControlID: String?
    /// Called with the new snapshot when an action changed the widget.
    var onUpdate: (WidgetSnapshot) -> Void = { _ in }

    init(widgetID: String, backend: any WidgetBackend, surface: WidgetSurface, snapshot: WidgetSnapshot?) {
        self.widgetID = widgetID
        self.backend = backend
        self.surface = surface
        self.isLive = snapshot?.isLive ?? true
        self.isUntrusted = snapshot?.isUntrusted ?? true
    }

    /// Feed snapshots draw open and reply controls only; frozen widgets draw no live controls.
    func allows(_ action: WidgetAction?) -> Bool {
        guard let action else { return false }
        switch action {
        case .open, .reply: return true
        case .answer, .tool: return surface == .chat
        }
    }
}

extension EnvironmentValues {
    @Entry var widgetRuntime: WidgetRuntime? = nil
}

/// One control's state while it posts an action: idle, working, sent (briefly), or an inline error.
/// One action per tap, with a 1 s cool-down so a widget can't become a message cannon (§7.5).
@MainActor @Observable
final class ActionRunner {
    enum Phase: Equatable { case idle, working, sent }
    private(set) var phase: Phase = .idle
    private(set) var error: String?
    @ObservationIgnored private var cooling = false

    var isBusy: Bool { phase != .idle }

    func run(
        _ action: WidgetAction, nodeID: String, itemID: String? = nil, values: [String: JSONValue] = [:],
        runtime: WidgetRuntime?, handlers: WidgetHandlers, openURL: (URL) -> Void
    ) async {
        guard let runtime, !cooling else { return }
        cooling = true
        error = nil
        phase = .working
        defer {
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1))
                cooling = false
                if phase == .sent { phase = .idle }
            }
        }
        do {
            switch action {
            case .open(let route, let artifactID, let fileID, let url):
                if let url {
                    guard let parsed = WidgetLink.safeURL(url) else { throw ActionFailure.unavailable }
                    openURL(parsed)
                } else if let route = route ?? artifactID.map({ "/library/\($0)" }) ?? fileID.map({ "/library/\($0)" }) {
                    guard let open = handlers.openRoute, open(route) else { throw ActionFailure.unavailable }
                } else {
                    throw ActionFailure.unavailable
                }
            case .reply(let text) where runtime.surface != .chat:
                guard let prefill = handlers.prefillReply else { throw ActionFailure.unavailable }
                prefill(text)
            default:
                guard runtime.allows(action) else { throw ActionFailure.unavailable }
                if let snapshot = try await runtime.backend.act(
                    widgetID: runtime.widgetID, nodeID: nodeID, itemID: itemID, action: action, values: values)
                {
                    runtime.onUpdate(snapshot)
                }
            }
            phase = .sent
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "That didn't go through."
            phase = .idle
        }
    }

    func clearError() { error = nil }

    private enum ActionFailure: LocalizedError {
        case unavailable
        var errorDescription: String? { "This control isn't available here." }
    }
}

// MARK: Links

enum WidgetLink {
    /// http, https and mailto only: anything else is drawn as plain text.
    static func safeURL(_ string: String) -> URL? {
        guard let url = URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines)),
            let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme)
        else { return nil }
        return url
    }
}

// MARK: Tone

extension WidgetTone {
    /// The icon that pairs with the tone, so color is never the only signal. nil for neutral.
    var symbol: String? {
        switch self {
        case .neutral: nil
        case .info: "info.circle"
        case .success: "checkmark.circle"
        case .warning: "exclamationmark.circle"
        case .danger: "xmark.octagon"
        }
    }

    /// Semantic tokens only. A widget's `warning` is never amber: amber is the host's "needs you".
    var tint: Color {
        switch self {
        case .neutral, .warning: PsycheColor.muted
        case .info: PsycheColor.inkText
        case .success: PsycheColor.green
        case .danger: PsycheColor.red
        }
    }
}

/// A tone's icon with its spoken word. Draws nothing for neutral.
struct ToneMark: View {
    let tone: WidgetTone

    var body: some View {
        if let symbol = tone.symbol {
            Image(systemName: symbol)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(tone.tint)
                .accessibilityLabel(tone.spokenName ?? "")
        }
    }
}

extension WidgetItemState {
    var symbol: String {
        switch self {
        case .todo: "circle"
        case .active: "circle.dotted.circle"
        case .done: "checkmark.circle.fill"
        case .skipped: "minus.circle"
        case .failed: "xmark.circle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .done: PsycheColor.green
        case .failed: PsycheColor.red
        case .active: PsycheColor.text
        case .todo, .skipped: PsycheColor.muted
        }
    }
}

// MARK: Controls

/// Compact capsule buttons for widget content: at most one ink fill per widget, the rest outlined.
struct WidgetButtonStyle: ButtonStyle {
    var prominent = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(prominent ? Color.white : PsycheColor.text)
            .padding(.horizontal, 18)
            .frame(minHeight: 44)
            .background(prominent ? PsycheColor.ink : PsycheColor.sheet, in: Capsule())
            .overlay(Capsule().strokeBorder(prominent ? Color.clear : PsycheColor.rule, lineWidth: 1))
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
            .contentShape(Capsule())
    }
}

/// The inline error under a control.
struct ControlError: View {
    let message: String?

    var body: some View {
        if let message {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(PsycheColor.red)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.updatesFrequently)
        }
    }
}
