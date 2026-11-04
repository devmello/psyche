import Observation
import PsycheDesign
import PsycheStore
import SwiftUI

@MainActor @Observable
final class SearchModel {
    var query = ""
    private(set) var results = SearchResults(answer: nil, hits: [])
    private let store: any SnapshotStore

    init(store: any SnapshotStore) {
        self.store = store
    }

    func run() async {
        results = (try? await store.search(query: query)) ?? SearchResults(answer: nil, hits: [])
    }
}

/// Search (docs/design/ios-app-2026.md §4.6), simplified until I7: results grouped like ⌘K, and the
/// "From your memory" answer.
struct SearchView: View {
    @State private var model: SearchModel

    init(store: any SnapshotStore) {
        _model = State(initialValue: SearchModel(store: store))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if model.query.trimmingCharacters(in: .whitespaces).isEmpty {
                    Text("Search your chats, files, people and to-dos, or ask about your life.")
                        .font(.subheadline).foregroundStyle(PsycheColor.muted)
                } else if model.results.hits.isEmpty && model.results.answer == nil {
                    Text("Nothing matches \u{201C}\(model.query)\u{201D}.")
                        .font(.subheadline).foregroundStyle(PsycheColor.muted)
                }
                if let answer = model.results.answer { answerCard(answer) }
                ForEach(SearchResults.Hit.Group.allCases, id: \.self) { group in
                    let hits = model.results.hits.filter { $0.group == group }
                    if !hits.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            SectionHeader(group.rawValue)
                            PaperCard {
                                ForEach(Array(hits.enumerated()), id: \.element.id) { index, hit in
                                    if index > 0 { HairlineDivider() }
                                    hitRow(hit)
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
        }
        .psycheScreen()
        .navigationTitle("Search")
        .searchable(text: $model.query, prompt: "Search or ask")
        .task(id: model.query) { await model.run() }
    }

    private func answerCard(_ answer: SearchResults.Answer) -> some View {
        PaperCard(padding: 16, radius: PsycheMetrics.approvalRadius) {
            VStack(alignment: .leading, spacing: 8) {
                Text("From your memory").font(.psycheSection).foregroundStyle(PsycheColor.muted)
                Text(attributed(answer))
                    .font(.system(.title3, design: .serif))
                    .foregroundStyle(PsycheColor.text)
                EvidenceLine("Sources", answer.evidence)
            }
        }
    }

    private func attributed(_ answer: SearchResults.Answer) -> AttributedString {
        var text = AttributedString(answer.text)
        if let range = text.range(of: answer.emphasis) { text[range].font = .system(.title3, design: .serif).weight(.semibold) }
        return text
    }

    private func hitRow(_ hit: SearchResults.Hit) -> some View {
        HStack(spacing: 12) {
            if hit.group == .people {
                InitialsAvatar(String(hit.title.split(separator: " ").compactMap(\.first).prefix(2)), size: 32)
            } else {
                Image(systemName: hit.symbol)
                    .font(.footnote)
                    .foregroundStyle(PsycheColor.text)
                    .frame(width: 32, height: 32)
                    .background(PsycheColor.fill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(hit.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                EvidenceLine([hit.detail])
            }
            Spacer(minLength: 0)
        }
        .padding(PsycheMetrics.rowPadding)
    }
}
