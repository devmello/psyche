import Observation
import PsycheBlocks
import PsycheDesign
import PsycheStore
import SwiftUI

/// "Why do you believe this?" on a fact: the claim behind it, how sure Psyche is, and the sources it rests on.
/// Loaded when the owner opens it (memory.explain), not when the page loads.
@MainActor @Observable
final class FactExplainModel {
    private(set) var phase: LoadPhase<FactExplanation> = .idle
    private let claimID: String
    private let store: any PsycheBackend

    init(claimID: String, store: any PsycheBackend) {
        self.claimID = claimID
        self.store = store
    }

    func load() async {
        phase = .loading
        do {
            phase = .loaded(try await store.explainFact(claimID: claimID))
        } catch {
            // The Gateway's refusal reaches the owner in its own words (BackendError.refused).
            phase = .failed(error.localizedDescription)
        }
    }
}

/// The explain sheet: the sentence, the confidence, then the sources as chips (each opens its file, as a search or
/// widget chip does). No sources is said plainly.
struct FactExplainSheet: View {
    @State private var model: FactExplainModel
    @Environment(\.dismiss) private var dismiss

    init(claimID: String, store: any PsycheBackend) {
        _model = State(initialValue: FactExplainModel(claimID: claimID, store: store))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    switch model.phase {
                    case .idle, .loading:
                        ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40)
                    case .loaded(let explanation):
                        loaded(explanation)
                    case .failed(let message):
                        VStack(spacing: 12) {
                            Text("Couldn't load this", bundle: .module).font(.headline)
                            Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
                                .accessibilityIdentifier("factExplain.error")
                            Button(String(localized: "Try again", bundle: .module)) { Task { await model.load() } }
                                .buttonStyle(.psycheOutline).frame(maxWidth: 220)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 40)
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
            .task { await model.load() }
            .accessibilityIdentifier("factExplain.sheet")
        }
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private func loaded(_ explanation: FactExplanation) -> some View {
        Text(explanation.text)
            .font(.psycheRow).foregroundStyle(PsycheColor.text)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        if let confidence = explanation.confidence {
            Text("Confidence \(Int((confidence * 100).rounded()))%", bundle: .module)
                .font(.caption).foregroundStyle(PsycheColor.muted)
                .accessibilityIdentifier("factExplain.confidence")
        }
        if explanation.sources.isEmpty {
            Text("No sources recorded", bundle: .module)
                .font(.subheadline).foregroundStyle(PsycheColor.muted)
                .accessibilityIdentifier("factExplain.empty")
        } else {
            SourceChipRow(sources: explanation.sources)
                .accessibilityIdentifier("factExplain.sources")
        }
    }
}
