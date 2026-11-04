import PsycheDesign
import SwiftUI

/// Where a row sits in a paper card, so rows of a `List` can be drawn as one card with swipe actions.
enum CardPosition {
    case only, first, middle, last

    init(index: Int, count: Int) {
        if count <= 1 { self = .only } else if index == 0 { self = .first } else if index == count - 1 { self = .last } else { self = .middle }
    }

    var isFirst: Bool { self == .only || self == .first }
    var isLast: Bool { self == .only || self == .last }
}

/// One horizontal slice of a paper card: sheet fill, a hairline on the outer edges only.
private struct CardSlice: View {
    let position: CardPosition

    var body: some View {
        let radius = PsycheMetrics.cardRadius
        UnevenRoundedRectangle(
            topLeadingRadius: position.isFirst ? radius : 0,
            bottomLeadingRadius: position.isLast ? radius : 0,
            bottomTrailingRadius: position.isLast ? radius : 0,
            topTrailingRadius: position.isFirst ? radius : 0,
            style: .continuous
        )
        .fill(PsycheColor.sheet)
        .overlay(CardEdges(first: position.isFirst, last: position.isLast, radius: radius).stroke(PsycheColor.hairline, lineWidth: 1))
    }
}

/// The open outline of a card slice: both sides always, the top only on the first row, the bottom only on the last.
private struct CardEdges: Shape {
    let first: Bool
    let last: Bool
    let radius: CGFloat

    func path(in bounds: CGRect) -> Path {
        let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let r = radius
        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: last ? rect.maxY - r : rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX, y: first ? rect.minY + r : rect.minY))
        if first {
            p.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.minY), tangent2End: CGPoint(x: rect.minX + r, y: rect.minY), radius: r)
            p.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
            p.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.minY), tangent2End: CGPoint(x: rect.maxX, y: rect.minY + r), radius: r)
        } else {
            p.move(to: CGPoint(x: rect.maxX, y: rect.minY))
        }
        p.addLine(to: CGPoint(x: rect.maxX, y: last ? rect.maxY - r : rect.maxY))
        if last {
            p.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.maxY), tangent2End: CGPoint(x: rect.maxX - r, y: rect.maxY), radius: r)
            p.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
            p.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.maxY), tangent2End: CGPoint(x: rect.minX, y: rect.maxY - r), radius: r)
        }
        return p
    }
}

extension View {
    /// Draws this row as a slice of a paper card inside a plain `List` (so `.swipeActions` work).
    /// `highlighted` washes the row in ink for a moment.
    func cardRow(_ position: CardPosition, highlighted: Bool = false) -> some View {
        frame(maxWidth: .infinity, alignment: .leading)
            .background {
                CardSlice(position: position)
                    .overlay {
                        if highlighted { PsycheColor.inkText.opacity(0.10) }
                    }
                    .animation(.default, value: highlighted)
            }
            .overlay(alignment: .bottom) {
                if !position.isLast { HairlineDivider().padding(.leading, 14) }
            }
            .listRowInsets(EdgeInsets(top: 0, leading: PsycheMetrics.pagePadding, bottom: 0, trailing: PsycheMetrics.pagePadding))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
    }

    /// A free-standing row in a `List` that has no card: headers, pickers, spacing.
    func plainRow(top: CGFloat = 0, bottom: CGFloat = 0) -> some View {
        listRowInsets(EdgeInsets(top: top, leading: PsycheMetrics.pagePadding, bottom: bottom, trailing: PsycheMetrics.pagePadding))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
    }
}

/// The standard List chrome for Memory's screens: paper, no separators, no system insets.
extension View {
    @MainActor
    func memoryListStyle() -> some View {
        listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 1)
            .psycheScreen()
    }
}

/// A quiet search field on paper, for "Search within Memory".
struct PaperSearchField: View {
    let prompt: String
    @Binding var text: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.subheadline).foregroundStyle(PsycheColor.muted)
                .accessibilityHidden(true)
            TextField(prompt, text: $text)
                .font(.callout)
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .autocorrectionDisabled()
                .submitLabel(.search)
            if !text.isEmpty {
                Button { text = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(PsycheColor.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 44)
        .background(PsycheColor.sheet, in: RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous)
                .strokeBorder(PsycheColor.rule, lineWidth: 1))
    }
}

/// The quiet note under pages that are read-mostly on the phone.
struct EditOnMacNote: View {
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "desktopcomputer").font(.footnote).accessibilityHidden(true)
            Text(text).font(.footnote)
        }
        .foregroundStyle(PsycheColor.muted)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// A paper card holding stacked rows. (`PaperCard` styles each child separately when handed a bare
/// `ForEach`, so rows go in one stack first.)
struct PaperStack<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        PaperCard {
            VStack(alignment: .leading, spacing: 0) { content }
        }
    }
}
