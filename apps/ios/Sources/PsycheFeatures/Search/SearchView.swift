import Observation
import PsycheDesign
import PsycheStore
import SwiftUI

@MainActor @Observable
final class SearchModel {
    enum Phase: Equatable {
        case idle, searching, done, failed(String)
    }

    var query = ""
    private(set) var phase: Phase = .idle
    private(set) var results = SearchResults(answer: nil, hits: [])
    private(set) var recents: [String]
    private let store: any PsycheBackend
    private let recentStore: RecentSearches

    init(store: any PsycheBackend, recentStore: RecentSearches = RecentSearches()) {
        self.store = store
        self.recentStore = recentStore
        recents = recentStore.items
    }

    var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Debounced by the view (about 250 ms); an empty query clears at once.
    func run() async {
        let text = trimmed
        guard !text.isEmpty else {
            results = SearchResults(answer: nil, hits: [])
            phase = .idle
            return
        }
        phase = .searching
        do {
            let found = try await store.search(query: text)
            guard !Task.isCancelled, text == trimmed else { return }
            results = found
            phase = .done
        } catch {
            guard !Task.isCancelled else { return }
            phase = .failed(error.localizedDescription)
        }
    }

    func remember() {
        recentStore.add(query)
        recents = recentStore.items
    }

    func forget(_ recent: String) {
        recentStore.remove(recent)
        recents = recentStore.items
    }

    func clearRecents() {
        recentStore.clear()
        recents = []
    }

    var hasAnything: Bool { results.answer != nil || !results.hits.isEmpty }

    /// The matched words of the query, for highlighting inside titles.
    var terms: [String] {
        let words = trimmed.split(separator: " ").map(String.init).filter { $0.count >= 3 }
        return words.isEmpty ? [trimmed] : words
    }
}

/// Search (docs/design/ios-app-2026.md §4.6): results grouped like ⌘K, and the "From your memory" answer.
/// The field is the system's (at the bottom on iPhone); the results are paper.
struct SearchView: View {
    @State private var model: SearchModel
    @Environment(Router.self) private var router

    init(store: any PsycheBackend) {
        let model = SearchModel(store: store)
        #if DEBUG
        if let query = UserDefaults.standard.string(forKey: "psycheSearchQuery") { model.query = query }
        #endif
        _model = State(initialValue: model)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if model.trimmed.isEmpty {
                    idle
                } else {
                    switch model.phase {
                    case .idle, .searching:
                        if model.hasAnything { results } else { skeleton }
                    case .done:
                        if model.hasAnything { results } else { noResults }
                    case .failed(let message):
                        failed(message)
                    }
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .psycheScreen()
        .navigationTitle("Search")
        .searchable(text: $model.query, prompt: "Search or ask")
        .onSubmit(of: .search) { model.remember() }
        .task(id: model.query) {
            if !model.trimmed.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled else { return }
            await model.run()
        }
    }

    // MARK: States

    @ViewBuilder
    private var idle: some View {
        if model.recents.isEmpty {
            Text("Search your chats, files, people and to-dos, or ask about your life.")
                .font(.subheadline).foregroundStyle(PsycheColor.muted)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    SectionHeader("Recent searches")
                    Spacer()
                    Button("Clear") { model.clearRecents() }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(PsycheColor.inkText)
                }
                PaperStack {
                    ForEach(Array(model.recents.enumerated()), id: \.element) { index, recent in
                        if index > 0 { HairlineDivider() }
                        recentRow(recent)
                    }
                }
            }
            Text("Kept on this phone only.").font(.footnote).foregroundStyle(PsycheColor.muted)
        }
    }

    private func recentRow(_ recent: String) -> some View {
        HStack(spacing: 12) {
            Button { model.query = recent } label: {
                HStack(spacing: 12) {
                    Image(systemName: "clock.arrow.circlepath").font(.footnote).foregroundStyle(PsycheColor.muted)
                        .frame(width: 32, height: 32)
                    Text(recent).font(.psycheRow).foregroundStyle(PsycheColor.text)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Button { model.forget(recent) } label: {
                Image(systemName: "xmark").font(.caption.weight(.semibold)).foregroundStyle(PsycheColor.muted)
                    .frame(width: 32, height: 32).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(recent) from recent searches")
        }
        .padding(PsycheMetrics.rowPadding)
    }

    private var skeleton: some View {
        VStack(alignment: .leading, spacing: 20) {
            answerCard(.init(text: "Placeholder answer sentence that runs to two lines of text here.", emphasis: "", evidence: ["source"]))
            group(.todo, hits: (1...2).map { .init(id: "sk\($0)", group: .todo, symbol: "circle", title: "Placeholder result title", detail: "Placeholder detail") })
        }
        .redacted(reason: .placeholder)
        .allowsHitTesting(false)
    }

    private var noResults: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Nothing matches \u{201C}\(model.trimmed)\u{201D}.")
                .font(.psycheRow.weight(.semibold)).foregroundStyle(PsycheColor.text)
            Text("Try fewer words, or ask Psyche in chat.")
                .font(.subheadline).foregroundStyle(PsycheColor.muted)
            Button("Ask Psyche") { router.askPsyche(model.trimmed) }
                .buttonStyle(.psycheOutline)
                .frame(maxWidth: 220)
        }
        .padding(.top, 24)
    }

    private func failed(_ message: String) -> some View {
        VStack(spacing: 12) {
            Text("Couldn't search").font(.headline).foregroundStyle(PsycheColor.text)
            Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
            Button("Try again") { Task { await model.run() } }
                .buttonStyle(.psycheOutline).frame(maxWidth: 220)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }

    // MARK: Results

    @ViewBuilder
    private var results: some View {
        if let answer = model.results.answer { answerCard(answer) }
        ForEach(SearchResults.Hit.Group.allCases, id: \.self) { kind in
            let hits = model.results.hits.filter { $0.group == kind }
            if !hits.isEmpty { group(kind, hits: hits) }
        }
    }

    private func group(_ kind: SearchResults.Hit.Group, hits: [SearchResults.Hit]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(kind.rawValue)
            PaperStack {
                ForEach(Array(hits.enumerated()), id: \.element.id) { index, hit in
                    if index > 0 { HairlineDivider() }
                    Button { open(hit) } label: { hitRow(hit) }
                        .buttonStyle(.plain)
                        .disabled(hit.target == nil)
                }
            }
        }
    }

    private func answerCard(_ answer: SearchResults.Answer) -> some View {
        PaperCard(padding: 16, radius: PsycheMetrics.approvalRadius) {
            VStack(alignment: .leading, spacing: 8) {
                Text("From your memory").font(.psycheSection).foregroundStyle(PsycheColor.muted)
                Text(Self.attributed(answer))
                    .font(.system(.title3, design: .serif))
                    .foregroundStyle(PsycheColor.text)
                    .fixedSize(horizontal: false, vertical: true)
                EvidenceLine("Sources", answer.evidence)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// The answer in New York with the emphasised words in semibold.
    static func attributed(_ answer: SearchResults.Answer) -> AttributedString {
        var text = AttributedString(answer.text)
        text.font = .system(.title3, design: .serif)
        if !answer.emphasis.isEmpty, let range = text.range(of: answer.emphasis) {
            text[range].font = .system(.title3, design: .serif).weight(.semibold)
        }
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
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(highlighted(hit.title)).font(.psycheRow).foregroundStyle(PsycheColor.text)
                    .multilineTextAlignment(.leading)
                Text(highlighted(hit.detail)).font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted)
                    .multilineTextAlignment(.leading)
            }
            Spacer(minLength: 0)
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// Marks where the query matched, in a quiet ink wash.
    private func highlighted(_ text: String) -> AttributedString {
        var attributed = AttributedString(text)
        for term in model.terms where !term.isEmpty {
            var searchStart = attributed.startIndex
            while let range = attributed[searchStart...].range(of: term, options: .caseInsensitive) {
                attributed[range].backgroundColor = PsycheColor.inkText.opacity(0.14)
                searchStart = range.upperBound
            }
        }
        return attributed
    }

    private func open(_ hit: SearchResults.Hit) {
        model.remember()
        switch hit.target {
        case .todo(let id): router.openTodo(id)
        case .chat(let id): router.openThread(id)
        case .file(let id): router.openFile(id)
        case .person(let id): router.openPerson(id)
        case nil: break
        }
    }
}
