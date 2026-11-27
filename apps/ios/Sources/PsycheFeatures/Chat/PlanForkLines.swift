import Foundation
import PsycheStore

/// One drawable line of a report: a cost, a date, a person, a trade-off, a risk or an open question, as plain text with
/// the tags the Plans view puts beside it (Estimate, No source, where it came from).
struct PlanForkLine: Identifiable, Equatable {
    var id: String
    var title: String
    var detail: String?
    var estimate = false
    var unsourced = false
    var sources: [PlanForkSource] = []
}

extension PlanForkReport {
    /// The lines of one dimension. `ids` picks and orders them (a comparison cell); nil takes every item (a lane).
    func lines(_ dimension: PlanComparisonDimension, ids: [String]? = nil) -> [PlanForkLine] {
        let all: [PlanForkLine]
        switch dimension {
        case .cost:
            all = costs.map { cost in
                PlanForkLine(
                    id: cost.id, title: cost.label, detail: PlanForkText.cost(cost), estimate: cost.estimate,
                    unsourced: cost.unsourced, sources: cost.sources)
            }
        case .dates:
            all = dates.map { date in
                PlanForkLine(
                    id: date.id, title: date.label, detail: PlanForkText.date(date.date), estimate: date.estimate,
                    unsourced: date.unsourced, sources: date.sources)
            }
        case .people:
            all = people.map { PlanForkLine(id: $0.id, title: $0.name, detail: $0.effect, unsourced: $0.unsourced, sources: $0.sources) }
        case .tradeoffs:
            all = tradeoffs.map { item in
                let give = String(localized: "Give up: \(item.giveUp)", bundle: .module)
                let gain = item.gain.map { String(localized: "Gain: \($0)", bundle: .module) }
                return PlanForkLine(id: item.id, title: give, detail: gain, unsourced: item.unsourced, sources: item.sources)
            }
        case .risks:
            all = risks.map {
                PlanForkLine(
                    id: $0.id, title: $0.text, detail: PlanForkText.likelihood($0.likelihood), unsourced: $0.unsourced,
                    sources: $0.sources)
            }
        case .open:
            all = questions.map { PlanForkLine(id: $0.id, title: $0.text) }
        }
        guard let ids else { return all }
        let byID = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return ids.compactMap { byID[$0] }
    }
}

extension PlanForkDetail {
    /// The rows the Compare tab shows: every row, or only the ones that differ. A row whose cells all lost their items
    /// to the phone's scrub still shows, with its count line, so a gap never reads as "nothing here".
    func comparisonRows(showAll: Bool) -> [PlanComparisonRow] {
        let rows = fork.comparison?.rows ?? []
        return showAll ? rows : rows.filter(\.differs)
    }

    /// The text of a branch's total for the Totals row: its computed lines, "Total on your Mac" when the Gateway
    /// withheld a cost that is part of it, or nothing when it has no costs.
    func totalLines(_ branch: PlanForkBranch) -> [String] {
        if branch.scrub.totalsHidden { return [PlanForkText.totalOnMac] }
        return (branch.report?.totals ?? []).map(PlanForkText.total)
    }
}
