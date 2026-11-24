import Observation
import PsycheDesign
import PsycheStore
import SwiftUI

/// "History" on a fact: the values its attribute has had, newest first, each with its source and date. Loaded when
/// the owner opens it (memory.entities.history), not when the page loads.
@MainActor @Observable
final class FactHistoryModel {
    private(set) var phase: LoadPhase<[FactVersion]> = .idle
    private let entityID: String
    private let fact: MemoryFact
    private let store: any PsycheBackend

    init(entityID: String, fact: MemoryFact, store: any PsycheBackend) {
        self.entityID = entityID
        self.fact = fact
        self.store = store
    }

    func load() async {
        // A fact without an attribute has no history on the Gateway: nothing earlier to show.
        guard let attribute = fact.attribute else {
            phase = .loaded([])
            return
        }
        phase = .loading
        do {
            phase = .loaded(try await store.entityHistory(entityID: entityID, attribute: attribute))
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}

/// The history sheet: the current value marked, earlier values under it, each with its source and date.
struct FactHistorySheet: View {
    @State private var model: FactHistoryModel
    @Environment(\.dismiss) private var dismiss

    init(entityID: String, fact: MemoryFact, store: any PsycheBackend) {
        _model = State(initialValue: FactHistoryModel(entityID: entityID, fact: fact, store: store))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    switch model.phase {
                    case .idle, .loading:
                        ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40)
                    case .loaded(let versions):
                        if versions.isEmpty {
                            Text("No earlier values.", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
                        } else {
                            PaperStack {
                                ForEach(Array(versions.enumerated()), id: \.element.id) { index, version in
                                    if index > 0 { HairlineDivider() }
                                    versionRow(version)
                                }
                            }
                            if versions.allSatisfy(\.isCurrent) {
                                Text("No earlier values.", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
                            }
                        }
                    case .failed(let message):
                        VStack(spacing: 12) {
                            Text("Couldn't load this", bundle: .module).font(.headline)
                            Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
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
            .navigationTitle(String(localized: "Earlier values", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Done", bundle: .module)) { dismiss() }
                }
            }
            .task { await model.load() }
        }
        .presentationDragIndicator(.visible)
    }

    private func versionRow(_ version: FactVersion) -> some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(version.value).font(.psycheRow).foregroundStyle(PsycheColor.text)
                    .multilineTextAlignment(.leading)
                EvidenceLine(version.evidence)
            }
            Spacer(minLength: 0)
            if version.isCurrent {
                Text("Current", bundle: .module).font(.caption).foregroundStyle(PsycheColor.muted)
            }
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
