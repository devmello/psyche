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
    private(set) var results = SearchResults(hits: [])
    private(set) var recents: [String]
    private let store: any PsycheBackend
    private let recentStore: RecentSearches

    init(store: any PsycheBackend, recentStore: RecentSearches = RecentSearches()) {
        self.store = store
        self.recentStore = recentStore
        recents = recentStore.items
    }

    var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Debounced by the view (about 250 ms); an empty query clears at once. Never asks a model.
    func run() async {
        let text = trimmed
        guard !text.isEmpty else {
            results = SearchResults(hits: [])
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

    var hasHits: Bool { !results.hits.isEmpty }

    /// The matched words of the query, for highlighting inside titles.
    var terms: [String] {
        let words = trimmed.split(separator: " ").map(String.init).filter { $0.count >= 3 }
        return words.isEmpty ? [trimmed] : words
    }
}

/// Search (docs/design/ios-app-2026.md §4.6): results grouped like ⌘K, and one "Ask Psyche" row that opens Chat.
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
                    askRow
                    // Loading, results, nothing and failed trade places with a 150 ms crossfade. Results
                    // themselves update in place, with no animation per keystroke (spec §4.2).
                    ZStack(alignment: .top) {
                        switch model.phase {
                        case .idle, .searching:
                            if model.hasHits { results.transition(.opacity) } else { skeleton.transition(.opacity) }
                        case .done:
                            if model.hasHits { results.transition(.opacity) } else { noResults.transition(.opacity) }
                        case .failed(let message):
                            failed(message).transition(.opacity)
                        }
                    }
                    .psycheFade(PsycheMotion.Duration.short, value: stage)
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .psycheScreen()
        .navigationTitle(String(localized: "Search", bundle: .module))
        .psycheLargeTitle()
        // A field that is always shown under the title, not a toolbar button, so the tab opens ready to type.
        .searchable(text: $model.query, placement: fieldPlacement, prompt: String(localized: "Search or ask", bundle: .module))
        .onSubmit(of: .search) { model.remember() }
        .task(id: model.query) {
            if !model.trimmed.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled else { return }
            await model.run()
        }
    }

    private enum Stage { case loading, results, empty, failed }

    /// Which state is on screen; only a change of this crossfades.
    private var stage: Stage {
        switch model.phase {
        case .idle, .searching: return model.hasHits ? .results : .loading
        case .done: return model.hasHits ? .results : .empty
        case .failed: return .failed
        }
    }

    private var fieldPlacement: SearchFieldPlacement {
        #if os(iOS)
        // Always shown, under the large title: the default hides the field until the page is pulled down.
        .navigationBarDrawer(displayMode: .always)
        #else
        .automatic  // the package's macOS test build; the app is iOS only
        #endif
    }

    // MARK: States

    /// Questions any owner can ask: wording only, no data. A tap fills the field.
    private var suggestions: [String] {
        [
            String(localized: "What did I promise this week?", bundle: .module),
            String(localized: "What is on my plate today?", bundle: .module),
            String(localized: "Who did I talk to recently?", bundle: .module),
        ]
    }

    /// Plain text on paper, not a `ContentUnavailableView`: it grows with Dynamic Type and scrolls with the page.
    private var idle: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Search your chats, files, people and to-dos, or ask about your life.", bundle: .module)
                .font(.subheadline).foregroundStyle(PsycheColor.muted)
                .fixedSize(horizontal: false, vertical: true)
            if !model.recents.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        SectionHeader(String(localized: "Recent searches", bundle: .module))
                        Spacer()
                        Button(String(localized: "Clear", bundle: .module)) { model.clearRecents() }
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(PsycheColor.inkText)
                    }
                    PaperStack {
                        ForEach(Array(model.recents.enumerated()), id: \.element) { index, recent in
                            if index > 0 { HairlineDivider() }
                            recentRow(recent)
                        }
                    }
                    Text("Kept on this phone only.", bundle: .module).font(.footnote).foregroundStyle(PsycheColor.muted)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(String(localized: "Try asking", bundle: .module))
                PaperStack {
                    ForEach(Array(suggestions.enumerated()), id: \.offset) { index, suggestion in
                        if index > 0 { HairlineDivider() }
                        suggestionRow(suggestion)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func suggestionRow(_ text: String) -> some View {
        Button { model.query = text } label: {
            HStack(spacing: 12) {
                Image(systemName: "sparkle.magnifyingglass").font(.footnote).foregroundStyle(PsycheColor.muted)
                    .frame(width: 32, height: 32)
                Text(text).font(.psycheRow).foregroundStyle(PsycheColor.text).multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(PsycheMetrics.rowPadding)
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
                    .frame(width: 44, height: 44).contentShape(Rectangle())
                    // The tap target is 44 pt; the negative padding keeps the row as tall and the icon where it was.
                    .padding(-6)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("search.forget-recent")
            .accessibilityLabel(String(localized: "Remove \(recent) from recent searches", bundle: .module))
        }
        .padding(PsycheMetrics.rowPadding)
    }

    /// The one way to ask: opens Chat with what was typed.
    private var askRow: some View {
        PaperStack {
            Button {
                model.remember()
                router.askPsyche(model.trimmed)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "sparkle").font(.footnote).foregroundStyle(PsycheColor.inkText)
                        .frame(width: 32, height: 32)
                        .background(PsycheColor.fill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Ask Psyche", bundle: .module).font(.psycheRow).foregroundStyle(PsycheColor.text)
                        Text(model.trimmed).font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted).lineLimit(2)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(PsycheColor.muted)
                }
                .padding(PsycheMetrics.rowPadding)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("ask-psyche-row")
        }
    }

    private var skeleton: some View {
        group(.todo, hits: (1...2).map { .init(id: "sk\($0)", group: .todo, symbol: "circle", title: "Placeholder result title", detail: "Placeholder detail") })
            .redacted(reason: .placeholder)
            .allowsHitTesting(false)
    }

    private var noResults: some View {
        ContentUnavailableView {
            Label {
                Text("Nothing matches \u{201C}\(model.trimmed)\u{201D}.", bundle: .module)
            } icon: {
                Image(systemName: "magnifyingglass")
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func failed(_ message: String) -> some View {
        ContentUnavailableView {
            Label(String(localized: "Couldn't search", bundle: .module), systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button(String(localized: "Try again", bundle: .module)) { Task { await model.run() } }
                .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: Results

    /// One column: inside the states' `ZStack` loose siblings would draw on top of each other.
    private var results: some View {
        VStack(alignment: .leading, spacing: 20) {
            ForEach(SearchResults.Hit.Group.allCases, id: \.self) { kind in
                let hits = model.results.hits.filter { $0.group == kind }
                if !hits.isEmpty { group(kind, hits: hits) }
            }
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
        case .project(let id): router.openProject(id)
        case .task(let id): router.openTask(id)
        case nil: break
        }
    }
}
