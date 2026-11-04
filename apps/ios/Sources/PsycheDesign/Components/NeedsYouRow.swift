import SwiftUI

/// A row in the "Needs you" card: a title, a mono evidence line, and a chevron when it can be opened.
/// The amber lives on the section header, not on every row.
public struct NeedsYouRow: View {
    private let title: String
    private let evidence: [String]
    private let showsChevron: Bool

    public init(title: String, evidence: [String], showsChevron: Bool = true) {
        self.title = title
        self.evidence = evidence
        self.showsChevron = showsChevron
    }

    public var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                    .multilineTextAlignment(.leading)
                EvidenceLine(evidence)
            }
            Spacer(minLength: 0)
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(PsycheColor.muted.opacity(0.7))
                    .accessibilityHidden(true)
            }
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

#Preview("Needs you") {
    VStack(alignment: .leading, spacing: 8) {
        SectionHeader("Needs you", count: 2, needsYou: true)
        PaperCard {
            NeedsYouRow(title: "Pay the electricity bill, $84.20", evidence: ["Approval", "Bills automation", "9:12"])
            HairlineDivider()
            NeedsYouRow(title: "Which deck should I send to Dana?", evidence: ["Question", "Q3 review", "8:40"])
        }
    }
    .padding().psycheScreen()
}
