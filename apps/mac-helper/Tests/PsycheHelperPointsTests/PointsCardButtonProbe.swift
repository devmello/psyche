import AppKit

@testable import PsycheHelperPoints

@MainActor
extension PointsCardView {
    /// Every button on the card (the buttons are hand-drawn views, so walk the subviews).
    private func allButtons(_ v: NSView) -> [PointsCardButton] {
        v.subviews.flatMap { sub -> [PointsCardButton] in
            (sub as? PointsCardButton).map { [$0] } ?? allButtons(sub)
        }
    }

    /// The accessibility labels of the eye badges on the card.
    var eyeLabelsForTests: [String] {
        func walk(_ v: NSView) -> [String] {
            v.subviews.flatMap { sub -> [String] in
                if sub is PointsEyeBadge { return [sub.accessibilityLabel() ?? ""] }
                return walk(sub)
            }
        }
        return walk(self)
    }

    var buttonTitlesForTests: [String] { allButtons(self).map(\.title) }

    func pressForTests(_ title: String) { allButtons(self).first { $0.title == title }?.onClick?() }
}
