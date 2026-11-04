import SwiftUI

/// A horizontal stack that wraps onto new lines (`stack` with `direction: horizontal`).
struct WidgetFlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? .infinity, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(width: bounds.width, subviews: subviews)
        for (index, frame) in result.frames.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                proposal: ProposedViewSize(frame.size))
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, frames: [CGRect]) {
        var frames: [CGRect] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var usedWidth: CGFloat = 0
        for subview in subviews {
            var size = subview.sizeThatFits(.unspecified)
            if width.isFinite { size.width = min(size.width, width) }
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            usedWidth = max(usedWidth, x - spacing)
        }
        // Fill the proposed width, so the parent places us in exactly the width we wrapped for.
        return (CGSize(width: width.isFinite ? width : usedWidth, height: y + rowHeight), frames)
    }
}

/// An equal-width grid of at most `columns` columns. Columns shrink until each is at least
/// `minimumColumnWidth` wide, so a 3-column stat row becomes 2 columns on a phone and 4 stays 4 on an iPad.
struct WidgetGridLayout: Layout {
    var columns: Int
    var spacing: CGFloat
    var minimumColumnWidth: CGFloat = 132

    private func columnCount(for width: CGFloat) -> Int {
        guard width.isFinite else { return columns }
        let fit = Int((width + spacing) / (minimumColumnWidth + spacing))
        return max(1, min(columns, fit))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 320
        let count = columnCount(for: width)
        let cell = (width - spacing * CGFloat(count - 1)) / CGFloat(count)
        return CGSize(width: width, height: rows(subviews, count: count, cell: cell).reduce(0) { $0 + $1 } + spacing * CGFloat(max(0, rowCount(subviews.count, count) - 1)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let count = columnCount(for: bounds.width)
        let cell = (bounds.width - spacing * CGFloat(count - 1)) / CGFloat(count)
        let heights = rows(subviews, count: count, cell: cell)
        var y = bounds.minY
        for (row, height) in heights.enumerated() {
            for column in 0..<count {
                let index = row * count + column
                guard index < subviews.count else { break }
                subviews[index].place(
                    at: CGPoint(x: bounds.minX + CGFloat(column) * (cell + spacing), y: y),
                    anchor: .topLeading, proposal: ProposedViewSize(width: cell, height: height))
            }
            y += height + spacing
        }
    }

    private func rowCount(_ items: Int, _ count: Int) -> Int { (items + count - 1) / count }

    private func rows(_ subviews: Subviews, count: Int, cell: CGFloat) -> [CGFloat] {
        (0..<rowCount(subviews.count, count)).map { row in
            (0..<count).compactMap { column -> CGFloat? in
                let index = row * count + column
                return index < subviews.count ? subviews[index].sizeThatFits(ProposedViewSize(width: cell, height: nil)).height : nil
            }.max() ?? 0
        }
    }
}
