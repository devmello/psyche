import PsycheDesign
import PsycheStore
import SwiftUI

/// The sources under a widget or a document: one chip per source, each with its passage in plain text. A chip
/// opens the source's in-app route through the host's `widgetHandlers.openRoute` (the same closure the widget's
/// own `open` controls use). A chip whose route isn't a plain in-app path is disabled. Renders nothing when the
/// list is empty, so payloads from before citations look exactly as they did.
public struct SourceChipRow: View {
    private let sources: [SourceRef]
    @Environment(\.widgetHandlers) private var handlers

    public init(sources: [SourceRef]) {
        self.sources = sources
    }

    public var body: some View {
        if !sources.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Sources", bundle: .module)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(PsycheColor.muted)
                    .accessibilityAddTraits(.isHeader)
                ForEach(sources) { source in
                    VStack(alignment: .leading, spacing: 4) {
                        Button { _ = Self.open(source, with: handlers.openRoute) } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "doc.text")
                                    .font(.footnote)
                                    .foregroundStyle(PsycheColor.muted)
                                Text(verbatim: source.title.isEmpty ? source.source : source.title)
                                    .font(.footnote)
                                    .foregroundStyle(PsycheColor.text)
                                    .lineLimit(1)
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(PsycheColor.fill, in: Capsule())
                            .overlay(Capsule().strokeBorder(source.isUntrusted ? PsycheColor.rule : PsycheColor.hairline,
                                                            style: StrokeStyle(lineWidth: 1, dash: source.isUntrusted ? [4, 2] : [])))
                        }
                        .buttonStyle(.plain)
                        .disabled(!source.canOpen || handlers.openRoute == nil)
                        .accessibilityLabel(String(localized: "Open \(source.title)", bundle: .module))
                        if !source.span.isEmpty {
                            Text(verbatim: source.span)
                                .font(.footnote)
                                .foregroundStyle(PsycheColor.muted)
                                .lineLimit(3)
                                .padding(.leading, 10)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Opens a source's route through `open`. Returns false and calls nothing when the route isn't a plain in-app
    /// path, or when there is no handler. This is what a chip tap runs.
    @MainActor
    public static func open(_ source: SourceRef, with open: (@MainActor (String) -> Bool)?) -> Bool {
        guard source.canOpen, let route = source.route, let open else { return false }
        return open(route)
    }
}
