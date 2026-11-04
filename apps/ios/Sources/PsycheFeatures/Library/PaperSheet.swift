#if os(iOS)
import PsycheDesign
import PsycheStore
import QuickLookThumbnailing
import SwiftUI
import UIKit

/// A sheet of paper with the top-right corner folded: the shape of every Library file
/// (docs/design/ios-app-2026.md §9), like the first-page thumbnails on the desktop.
struct PaperSheetShape: Shape {
    var radius: CGFloat = 5
    var fold: CGFloat = 12

    func path(in rect: CGRect) -> Path {
        let w = rect.width, h = rect.height, r = radius, f = min(fold, min(w, h) / 3)
        var p = Path()
        p.move(to: CGPoint(x: r, y: 0))
        p.addLine(to: CGPoint(x: w - f, y: 0))
        p.addLine(to: CGPoint(x: w, y: f))
        p.addLine(to: CGPoint(x: w, y: h - r))
        p.addArc(tangent1End: CGPoint(x: w, y: h), tangent2End: CGPoint(x: w - r, y: h), radius: r)
        p.addLine(to: CGPoint(x: r, y: h))
        p.addArc(tangent1End: CGPoint(x: 0, y: h), tangent2End: CGPoint(x: 0, y: h - r), radius: r)
        p.addLine(to: CGPoint(x: 0, y: r))
        p.addArc(tangent1End: CGPoint(x: 0, y: 0), tangent2End: CGPoint(x: r, y: 0), radius: r)
        p.closeSubpath()
        return p
    }
}

/// The folded flap: a small triangle in the quiet fill with a hairline on its two inner edges.
private struct FoldFlap: Shape {
    var fold: CGFloat

    func path(in rect: CGRect) -> Path {
        let f = min(fold, min(rect.width, rect.height) / 3)
        var p = Path()
        p.move(to: CGPoint(x: rect.width - f, y: 0))
        p.addLine(to: CGPoint(x: rect.width - f, y: f))
        p.addLine(to: CGPoint(x: rect.width, y: f))
        p.closeSubpath()
        return p
    }
}

/// White (or dark gray) paper with a hairline and a folded corner. The content is clipped to the sheet.
struct PaperSheet<Content: View>: View {
    var fold: CGFloat = 12
    var radius: CGFloat = 5
    @ViewBuilder var content: Content

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(PsycheColor.sheet)
            .clipShape(PaperSheetShape(radius: radius, fold: fold))
            .overlay(PaperSheetShape(radius: radius, fold: fold).stroke(PsycheColor.rule.opacity(0.7), lineWidth: 0.75))
            .overlay {
                ZStack {
                    FoldFlap(fold: fold).fill(PsycheColor.fill)
                    FoldFlap(fold: fold).stroke(PsycheColor.rule.opacity(0.7), lineWidth: 0.75)
                }
            }
            .shadow(color: .black.opacity(0.05), radius: 4, y: 1.5)
    }
}

/// What a file looks like on the shelf: the real first page from Quick Look when the phone has the file,
/// otherwise a typographic sheet with the file type and title.
struct LibraryThumbnail: View {
    enum Style { case tile, row }

    let item: PsycheStore.LibraryItem
    var style: Style = .tile
    @Environment(\.backend) private var store
    @State private var image: UIImage?

    var body: some View {
        PaperSheet(fold: style == .tile ? 16 : 9, radius: style == .tile ? 6 : 4) {
            if let image {
                Image(uiImage: image)
                    .resizable().scaledToFill()
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            } else {
                TypographicSheet(item: item, style: style)
            }
        }
        .aspectRatio(style == .tile ? 3.0 / 4.0 : 0.78, contentMode: .fit)
        .task(id: item.id) {
            guard !item.id.hasPrefix("sklib") else { return }
            image = await ThumbnailLoader.shared.thumbnail(for: item, store: store, side: style == .tile ? 220 : 80)
        }
        .accessibilityHidden(true)
    }
}

struct TypographicSheet: View {
    let item: PsycheStore.LibraryItem
    let style: LibraryThumbnail.Style

    var body: some View {
        switch style {
        case .row:
            Text(label)
                .font(.psycheMono(.caption2, weight: .semibold))
                .foregroundStyle(PsycheColor.muted)
                .minimumScaleFactor(0.6)
        case .tile:
            VStack(alignment: .leading, spacing: 0) {
                Text(label)
                    .font(.psycheMono(.caption2, weight: .semibold))
                    .foregroundStyle(PsycheColor.muted)
                Spacer(minLength: 6)
                Text(displayTitle)
                    .font(.system(.footnote, design: .serif, weight: .semibold))
                    .foregroundStyle(PsycheColor.text)
                    .lineLimit(4)
                    .multilineTextAlignment(.leading)
            }
            .padding(EdgeInsets(top: 14, leading: 12, bottom: 12, trailing: 12))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private var label: String { (item.fileType.isEmpty ? item.section.rawValue : item.fileType).uppercased() }

    /// The title without its extension, which the label already says.
    private var displayTitle: String {
        let ext = "." + item.fileType
        return item.title.lowercased().hasSuffix(ext.lowercased()) ? String(item.title.dropLast(ext.count)) : item.title
    }
}

/// Renders and remembers Quick Look thumbnails.
actor ThumbnailLoader {
    static let shared = ThumbnailLoader()
    private let cache = NSCache<NSString, UIImage>()

    func thumbnail(for item: PsycheStore.LibraryItem, store: any PsycheBackend, side: CGFloat) async -> UIImage? {
        let key = "\(item.id)-\(Int(side))" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        guard let url = try? await store.libraryFile(id: item.id) else { return nil }
        let scale = await MainActor.run { UIScreen.main.scale }
        let request = QLThumbnailGenerator.Request(
            fileAt: url, size: CGSize(width: side, height: side * 4 / 3), scale: scale, representationTypes: .thumbnail)
        guard let representation = try? await QLThumbnailGenerator.shared.generateBestRepresentation(for: request) else { return nil }
        let image = representation.uiImage
        cache.setObject(image, forKey: key)
        return image
    }

    func forget(_ id: String) {
        for side in [80, 220] { cache.removeObject(forKey: "\(id)-\(side)" as NSString) }
    }
}
#endif
