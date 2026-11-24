import PsycheDesign
import PsycheStore
import SwiftUI

/// "Why do you believe this?" on a fact: who it came from in plain words, how sure Psyche is, the quoted span it
/// came from and the kinds of source it was read from. Everything comes from the fact the page already shows; nothing
/// is fetched. Quoted and source text is untrusted and drawn as plain text, never as markup.
struct FactExplainSheet: View {
    let fact: MemoryFact
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(verbatim: fact.text)
                        .font(.psycheRow).foregroundStyle(PsycheColor.text)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let provenance = fact.provenance {
                        provenanceBody(provenance)
                    } else {
                        emptyState
                    }
                }
                .padding(.horizontal, PsycheMetrics.pagePadding)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .psycheScreen()
            .navigationTitle(String(localized: "Why you believe this", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Done", bundle: .module)) { dismiss() }
                }
            }
            .accessibilityIdentifier("factExplain.sheet")
        }
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private func provenanceBody(_ provenance: FactProvenance) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(Self.originText(provenance.origin))
                .font(.subheadline).foregroundStyle(PsycheColor.text)
                .accessibilityIdentifier("factExplain.origin")
            if let confidence = provenance.confidence {
                Text("Confidence \(Int((confidence * 100).rounded()))%", bundle: .module)
                    .font(.caption).foregroundStyle(PsycheColor.muted)
                    .accessibilityIdentifier("factExplain.confidence")
            }
            if let first = provenance.firstSeen {
                Text("First seen \(first.formatted(.dateTime.month(.abbreviated).day()))", bundle: .module)
                    .font(.caption).foregroundStyle(PsycheColor.muted)
            }
            if let last = provenance.lastSeen {
                Text("Last seen \(last.formatted(.dateTime.month(.abbreviated).day()))", bundle: .module)
                    .font(.caption).foregroundStyle(PsycheColor.muted)
            }
        }
        if let evidence = provenance.evidence {
            VStack(alignment: .leading, spacing: 6) {
                Text("Evidence", bundle: .module)
                    .font(.footnote.weight(.semibold)).foregroundStyle(PsycheColor.muted)
                HStack(alignment: .top, spacing: 10) {
                    Rectangle().fill(PsycheColor.rule).frame(width: 3)
                    Text(verbatim: evidence)
                        .font(.subheadline).italic().foregroundStyle(PsycheColor.text)
                        .multilineTextAlignment(.leading)
                }
                .accessibilityIdentifier("factExplain.evidence")
            }
        }
        if !provenance.sourceKinds.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Sources", bundle: .module)
                    .font(.footnote.weight(.semibold)).foregroundStyle(PsycheColor.muted)
                HStack(spacing: 6) {
                    ForEach(provenance.sourceKinds, id: \.self) { kind in
                        Text(verbatim: kind)
                            .font(.footnote).foregroundStyle(PsycheColor.text)
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(PsycheColor.fill, in: Capsule())
                    }
                }
                .accessibilityIdentifier("factExplain.sources")
            }
        }
        if provenance.evidence == nil, provenance.sourceKinds.isEmpty {
            emptyState
        }
    }

    private var emptyState: some View {
        Text("No sources recorded", bundle: .module)
            .font(.subheadline).foregroundStyle(PsycheColor.muted)
            .accessibilityIdentifier("factExplain.empty")
    }

    /// The wording the Mac person page uses for the same origins (packages/ui people.provenance.*).
    static func originText(_ origin: FactProvenance.Origin) -> String {
        switch origin {
        case .owner: String(localized: "From you", bundle: .module)
        case .agent: String(localized: "Psyche inferred this", bundle: .module)
        case .untrusted: String(localized: "A claim in someone else's message", bundle: .module)
        case .system: String(localized: "From your data", bundle: .module)
        }
    }
}
