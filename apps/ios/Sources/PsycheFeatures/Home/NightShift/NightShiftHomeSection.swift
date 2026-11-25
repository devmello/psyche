import PsycheDesign
import PsycheStore
import SwiftUI

/// Home's "Prepared overnight" card: what Night shift got ready, in counts and the first lines, and one Review button
/// (the screen's one accent). Drawn only while a review is waiting. It changes nothing: Review opens the screen where
/// every change is read before anything is ticked.
struct NightShiftHomeSection: View {
    @State private var model: NightShiftCardModel
    @Environment(Router.self) private var router

    init(store: any PsycheBackend) {
        _model = State(initialValue: NightShiftCardModel(store: store))
    }

    var body: some View {
        // A stack, not a Group: a Group with nothing in it has no view to hang `.task` on, and the card would never load.
        VStack(alignment: .leading, spacing: 0) {
            if let reviewID = model.reviewID, let status = model.status {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader(String(localized: "Prepared overnight", bundle: .module))
                    PaperCard {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(verbatim: NightShiftText.countsLine(status.counts))
                                .font(.psycheRow)
                                .foregroundStyle(PsycheColor.text)
                            if !model.firstLines.isEmpty {
                                VStack(alignment: .leading, spacing: 4) {
                                    ForEach(Array(model.firstLines.enumerated()), id: \.offset) { _, line in
                                        Text(verbatim: line)
                                            .font(.subheadline)
                                            .foregroundStyle(PsycheColor.muted)
                                            .lineLimit(1)
                                    }
                                }
                            }
                            Button(String(localized: "Review", bundle: .module)) {
                                router.homePath.append(.nightShift(id: reviewID))
                            }
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(PsycheColor.inkText)
                            .buttonStyle(.plain)
                        }
                        .padding(PsycheMetrics.rowPadding)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .task {
            await model.load()
            await model.observe()
        }
    }
}

/// Words for the card and the screen. Counts are written with plural forms in each language's catalog.
enum NightShiftText {
    /// "3 reply drafts · 2 calendar fixes · 1 filed document", only the kinds that have something.
    static func countsLine(_ counts: NightShiftCounts) -> String {
        var parts: [String] = []
        if counts.mail > 0 { parts.append(String(localized: "\(counts.mail) reply drafts", bundle: .module)) }
        if counts.calendar > 0 { parts.append(String(localized: "\(counts.calendar) calendar fixes", bundle: .module)) }
        if counts.reminders > 0 { parts.append(String(localized: "\(counts.reminders) reminders", bundle: .module)) }
        if counts.files > 0 { parts.append(String(localized: "\(counts.files) filed documents", bundle: .module)) }
        return parts.joined(separator: " · ")
    }

    static func title(_ domain: NightShiftDomain) -> String {
        switch domain {
        case .mail: String(localized: "Replies", bundle: .module)
        case .calendar: String(localized: "Calendar", bundle: .module)
        case .reminders: String(localized: "Reminders", bundle: .module)
        case .files: String(localized: "Files", bundle: .module)
        }
    }
}
