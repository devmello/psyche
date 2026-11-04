import PsycheDesign
import PsycheStore
import SwiftUI

/// A generative-UI widget (docs/design/ios-app-2026.md A7): loads the snapshot through the backend
/// (`widgets.get`), draws it natively in a host-owned frame, posts control taps through `widgets.act`
/// and refetches when the backend says something changed. The frame is deliberately not an approval
/// card: paper, a hairline, no elevation, no amber, no ink except one primary button.
///
///     WidgetView(widgetID: id, backend: backend)
public struct WidgetView: View {
    private let widgetID: String
    private let surface: WidgetSurface
    @State private var model: WidgetModel

    public init(widgetID: String, backend: any WidgetBackend = FixtureBackend.shared, surface: WidgetSurface = .chat) {
        self.widgetID = widgetID
        self.surface = surface
        _model = State(initialValue: WidgetModel(widgetID: widgetID, backend: backend, surface: surface))
    }

    public var body: some View {
        Group {
            switch model.phase {
            case .loading:
                WidgetFrameSkeleton()
            case .failed(let message):
                WidgetFrameMessage(message: message) { Task { await model.load() } }
            case .loaded(let snapshot):
                WidgetFrame(snapshot: snapshot, surface: surface)
                    .environment(\.widgetRuntime, model.runtime)
            }
        }
        .task { await model.load() }
        .task { await model.observe() }
    }
}

@MainActor @Observable
final class WidgetModel {
    enum Phase { case loading, loaded(WidgetSnapshot), failed(String) }

    private(set) var phase: Phase = .loading
    let runtime: WidgetRuntime
    private let widgetID: String
    private let backend: any WidgetBackend

    init(widgetID: String, backend: any WidgetBackend, surface: WidgetSurface) {
        self.widgetID = widgetID
        self.backend = backend
        runtime = WidgetRuntime(widgetID: widgetID, backend: backend, surface: surface, snapshot: nil)
        runtime.onUpdate = { [weak self] in self?.apply($0) }
    }

    func load() async {
        if case .loaded = phase {} else { phase = .loading }
        do {
            apply(try await backend.widget(id: widgetID))
        } catch {
            if case .loaded = phase { return }  // keep what's on screen over a failed refresh
            phase = .failed((error as? LocalizedError)?.errorDescription ?? "Psyche couldn't load this widget.")
        }
    }

    /// Something changed under the widget's topic (a bound task moved, another device acted): refetch quietly.
    func observe() async {
        guard let live = backend as? any LiveUpdates else { return }
        for await event in live.events() {
            switch event {
            case .changed, .resynced: await load()
            case .chat: break
            }
        }
    }

    func apply(_ snapshot: WidgetSnapshot) {
        runtime.isLive = snapshot.isLive
        runtime.isUntrusted = snapshot.isUntrusted
        // An untrusted widget never wears the ink fill: a filled call to action is what an approval looks like.
        runtime.primaryControlID = snapshot.isUntrusted ? nil : snapshot.root.findPrimaryControl()
        phase = .loaded(snapshot)
    }
}

/// The frame around a loaded widget. Also usable on its own for a snapshot in hand (Feed, Home pins).
public struct WidgetFrame: View {
    let snapshot: WidgetSnapshot
    let surface: WidgetSurface
    @State private var announcedRev: Int

    public init(snapshot: WidgetSnapshot, surface: WidgetSurface = .chat) {
        self.snapshot = snapshot
        self.surface = surface
        _announcedRev = State(initialValue: snapshot.rev)
    }

    private var stateLabel: String {
        surface == .feed ? "Snapshot" : (snapshot.isLive ? "Live" : "Frozen")
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(snapshot.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(PsycheColor.text)
                        .lineLimit(2)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                    HStack(spacing: 5) {
                        Circle()
                            .fill(snapshot.isLive && surface == .chat ? PsycheColor.muted : PsycheColor.rule)
                            .frame(width: 6, height: 6)
                        Text(stateLabel).font(.footnote).foregroundStyle(PsycheColor.muted)
                    }
                    .accessibilityElement(children: .combine)
                    .fixedSize()
                }
                if snapshot.isUntrusted {
                    Label("Built from untrusted content", systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(PsycheColor.muted)
                        .accessibilityHint(snapshot.untrustedSources.joined(separator: ", "))
                }
            }
            WidgetNodeView(node: snapshot.root)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PsycheColor.sheet, in: RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous)
                .strokeBorder(
                    snapshot.isUntrusted ? PsycheColor.rule : PsycheColor.hairline,
                    style: StrokeStyle(lineWidth: 1, dash: snapshot.isUntrusted ? [5, 3] : [])))
        .contextMenu {
            Button("Copy as text", systemImage: "doc.on.doc") { copy("\(snapshot.title)\n\(snapshot.spec.fallbackText)") }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(snapshot.title)
        .onChange(of: snapshot.rev) { _, rev in
            guard rev != announcedRev else { return }
            announcedRev = rev
            announce("\(snapshot.title): \(snapshot.spec.fallbackText)")
        }
    }

    private func copy(_ text: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #endif
    }

    private func announce(_ text: String) {
        #if canImport(UIKit)
        UIAccessibility.post(notification: .announcement, argument: text)
        #endif
    }
}

private struct WidgetFrameSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            RoundedRectangle(cornerRadius: 4).frame(width: 140, height: 14)
            RoundedRectangle(cornerRadius: 4).frame(height: 10)
            RoundedRectangle(cornerRadius: 4).frame(width: 220, height: 10)
        }
        .foregroundStyle(PsycheColor.fill)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PsycheColor.sheet, in: RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous).strokeBorder(PsycheColor.hairline, lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading widget")
    }
}

private struct WidgetFrameMessage: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
            Button("Try again", action: retry).buttonStyle(WidgetButtonStyle())
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PsycheColor.sheet, in: RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous).strokeBorder(PsycheColor.hairline, lineWidth: 1))
    }
}
