import Observation
import PsycheDesign
import PsycheStore
import SwiftUI

@MainActor @Observable
final class SearchModel {
    enum Phase: Equatable {
        case idle, searching, done, failed(String)
    }

    /// A follow-up under the answer and the answer it got.
    struct Turn: Identifiable, Equatable {
        enum State: Equatable { case loading, answered(SearchResults.Answer), none, failed(String) }
        let id = UUID()
        var question: String
        var state: State
    }

    /// A cited passage opened for reading.
    struct Viewer: Identifiable, Equatable {
        enum State: Equatable { case loading, document(SourceDocument), onYourMac, failed(String) }
        var passage: LifePassage
        var state: State
        var id: String { passage.id }
    }

    static let maxFollowUps = 5

    var query = ""
    var followUpText = ""
    var viewer: Viewer?
    /// The answer read from the owner's mail, messages and files, after they tapped the button. Never set by typing.
    private(set) var deepAnswer: SearchResults.Answer?
    private(set) var deepLoading = false
    private(set) var deepFailure: String?
    private(set) var turns: [Turn] = []
    /// The query `deepAnswer` and `turns` belong to: another query starts clean.
    private var conversationQuery = ""
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
            resetConversation()
            phase = .idle
            return
        }
        if text != conversationQuery { resetConversation() }
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

    private func resetConversation() {
        deepAnswer = nil
        deepLoading = false
        deepFailure = nil
        turns = []
        followUpText = ""
        viewer = nil
        conversationQuery = ""
    }

    /// The answer on the card: from passages once asked for, else the facts-only one.
    var shownAnswer: SearchResults.Answer? { deepAnswer ?? results.answer }

    /// The button is offered on a question, until it has been tapped.
    var offersDeep: Bool { deepAnswer == nil && (results.answer != nil || results.canAskLife) }

    var canAskFollowUp: Bool { shownAnswer != nil && turns.count < Self.maxFollowUps && !turns.contains { $0.state == .loading } }

    /// "Answer from my mail, messages and files": the only way passages are requested.
    func askDeep() async {
        let text = trimmed
        guard !text.isEmpty, !deepLoading else { return }
        deepLoading = true
        deepFailure = nil
        defer { deepLoading = false }
        do {
            let answer = try await store.lifeAnswer(question: text, passages: true, previous: nil)
            guard text == trimmed else { return }
            conversationQuery = text
            turns = []
            if let answer { deepAnswer = answer } else { deepFailure = "No answer from your mail, messages and files." }
        } catch {
            guard text == trimmed else { return }
            deepFailure = error.localizedDescription
        }
    }

    /// The follow-up box: sends the turn before it (the question, its answer and the ids it cited).
    func askFollowUp() async {
        let question = String(followUpText.trimmingCharacters(in: .whitespacesAndNewlines).prefix(LifeTurn.maxQuestion))
        let base = turns.reversed().lazy.compactMap { turn -> (String, SearchResults.Answer)? in
            if case .answered(let answer) = turn.state { return (turn.question, answer) }
            return nil
        }.first ?? shownAnswer.map { (trimmed, $0) }
        guard !question.isEmpty, canAskFollowUp, let base else { return }
        let text = trimmed
        followUpText = ""
        conversationQuery = text
        let turn = Turn(question: question, state: .loading)
        turns.append(turn)
        let state: Turn.State
        do {
            let answer = try await store.lifeAnswer(
                question: question, passages: deepAnswer != nil, previous: base.1.turn(question: base.0))
            state = answer.map { .answered($0) } ?? .none
        } catch {
            state = .failed(error.localizedDescription)
        }
        guard text == trimmed, let index = turns.firstIndex(where: { $0.id == turn.id }) else { return }
        turns[index].state = state
    }

    /// A chip: opens the passage in a sheet with `search.document`, or says "Open on your Mac".
    func open(_ passage: LifePassage) async {
        viewer = Viewer(passage: passage, state: .loading)
        let state: Viewer.State
        do {
            state = try await store.sourceDocument(id: passage.id).map { .document($0) } ?? .onYourMac
        } catch {
            state = .failed(error.localizedDescription)
        }
        guard viewer?.passage.id == passage.id else { return }
        viewer?.state = state
    }

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
    @Environment(\.horizontalSizeClass) private var sizeClass
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
                // The page title is drawn in the column like every other screen (the system's large title
                // sits at the window edge and ignores the readable column on iPad).
                PageHeader("Search")
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
        .sheet(item: $model.viewer) { viewer in PassageSheet(viewer: viewer) }
        .navigationTitle("")
        .psycheInlineTitle()
        // iPhone: the search tab's field sits at the bottom (system). iPad: a field that is always shown, not a
        // toolbar button, so the tab opens ready to type.
        .searchable(text: $model.query, placement: fieldPlacement, prompt: "Search or ask")
        .onSubmit(of: .search) { model.remember() }
        .task(id: model.query) {
            if !model.trimmed.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled else { return }
            await model.run()
        }
    }

    private var fieldPlacement: SearchFieldPlacement {
        #if os(iOS)
        sizeClass == .regular ? .navigationBarDrawer(displayMode: .always) : .automatic
        #else
        .automatic  // the package's macOS test build; the app is iOS only
        #endif
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
            answerCard(Optional(SearchResults.Answer(text: "Placeholder answer sentence that runs to two lines of text here.", emphasis: "", evidence: ["source"])))
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
        if model.shownAnswer != nil || model.results.canAskLife { answerCard(model.shownAnswer) }
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

    private func answerCard(_ answer: SearchResults.Answer?) -> some View {
        PaperCard(padding: 16, radius: PsycheMetrics.approvalRadius) {
            VStack(alignment: .leading, spacing: 10) {
                Text(answer == nil ? "Ask your life" : "From your memory").font(.psycheSection).foregroundStyle(PsycheColor.muted)
                if let answer {
                    claimsView(answer)
                    EvidenceLine("Sources", answer.evidence)
                } else {
                    Text("Nothing in your reviewed memory answers this yet.")
                        .font(.subheadline).foregroundStyle(PsycheColor.muted)
                }
                if model.offersDeep { deepButton }
                if answer != nil {
                    ForEach(model.turns) { turn in
                        HairlineDivider()
                        turnView(turn)
                    }
                    followUpBox
                }
            }
        }
    }

    /// Explicit: passages are read only after this tap, never by default.
    private var deepButton: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { Task { await model.askDeep() } } label: {
                HStack(spacing: 8) {
                    if model.deepLoading { ProgressView().controlSize(.small) }
                    Text("Answer from my mail, messages and files")
                }
            }
            .buttonStyle(.psycheOutline)
            .disabled(model.deepLoading)
            .accessibilityIdentifier("answer-from-passages")
            if let failure = model.deepFailure {
                Text(failure).font(.footnote).foregroundStyle(PsycheColor.muted)
            }
        }
    }

    /// The answer as claims; a claim that cites passages is followed by a chip for each.
    private func claimsView(_ answer: SearchResults.Answer) -> some View {
        let claims = answer.claims
        return VStack(alignment: .leading, spacing: 8) {
            if claims.isEmpty {
                Text(Self.attributed(answer.text, emphasis: answer.emphasis))
                    .font(.system(.title3, design: .serif)).foregroundStyle(PsycheColor.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(claims.enumerated()), id: \.offset) { _, claim in
                VStack(alignment: .leading, spacing: 6) {
                    Text(Self.attributed(claim.text, emphasis: answer.emphasis))
                        .font(.system(.title3, design: .serif)).foregroundStyle(PsycheColor.text)
                        .fixedSize(horizontal: false, vertical: true)
                    if !claim.passages.isEmpty {
                        PassageFlow(spacing: 6) {
                            ForEach(claim.passages) { passage in
                                PassageChip(passage: passage) { Task { await model.open(passage) } }
                            }
                        }
                    }
                }
            }
        }
    }

    private func turnView(_ turn: SearchModel.Turn) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(turn.question).font(.subheadline.weight(.semibold)).foregroundStyle(PsycheColor.text)
            switch turn.state {
            case .loading: ProgressView().controlSize(.small)
            case .answered(let answer):
                claimsView(answer)
                EvidenceLine("Sources", answer.evidence)
            case .none: Text("No answer to that.").font(.subheadline).foregroundStyle(PsycheColor.muted)
            case .failed(let message): Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
            }
        }
    }

    @ViewBuilder
    private var followUpBox: some View {
        if model.canAskFollowUp {
            HStack(spacing: 8) {
                TextField("Ask a follow-up", text: $model.followUpText)
                    .font(.callout)
                    .submitLabel(.send)
                    .onSubmit { Task { await model.askFollowUp() } }
                    .accessibilityIdentifier("follow-up-field")
                Button { Task { await model.askFollowUp() } } label: {
                    Image(systemName: "arrow.up").font(.callout.weight(.bold)).foregroundStyle(.white)
                        .frame(width: 32, height: 32).background(PsycheColor.ink, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(model.followUpText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .opacity(model.followUpText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
                .accessibilityLabel("Ask follow-up")
            }
            .padding(.leading, 14).padding(.trailing, 6).padding(.vertical, 6)
            .background(PsycheColor.fill, in: Capsule())
        } else if model.turns.count >= SearchModel.maxFollowUps {
            Text("That is as far as one answer goes. Ask Psyche in chat to keep going.")
                .font(.footnote).foregroundStyle(PsycheColor.muted)
        }
    }

    /// The answer in New York with the emphasised words in semibold.
    static func attributed(_ text: String, emphasis: String) -> AttributedString {
        var attributed = AttributedString(text)
        attributed.font = .system(.title3, design: .serif)
        if !emphasis.isEmpty, let range = attributed.range(of: emphasis) {
            attributed[range].font = .system(.title3, design: .serif).weight(.semibold)
        }
        return attributed
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

/// Wraps chips onto new lines.
private struct PassageFlow: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? .infinity, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (index, frame) in arrange(width: bounds.width, subviews: subviews).frames.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), proposal: ProposedViewSize(frame.size))
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, frames: [CGRect]) {
        var frames: [CGRect] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for subview in subviews {
            var size = subview.sizeThatFits(.unspecified)
            if width.isFinite { size.width = min(size.width, width) }
            if x > 0, x + size.width > width { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return (CGSize(width: width.isFinite ? width : x, height: y + rowHeight), frames)
    }
}

/// How a passage's source reads: "Mail", "Files", "Notes".
func passageSourceName(_ source: String) -> String {
    switch source {
    case "mail": "Mail"
    case "messages": "Messages"
    case "notes": "Notes"
    case "files", "library": "Files"
    case "calendar": "Calendar"
    case "reminders": "Reminders"
    case "contacts": "Contacts"
    case "memory": "Memory"
    case "": "Source"
    default: source.prefix(1).uppercased() + source.dropFirst()
    }
}

/// A citation `[Pn]`: a hairline capsule, mono, not filled.
private struct PassageChip: View {
    let passage: LifePassage
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: "text.quote").font(.caption2)
                Text(passageSourceName(passage.source) + " · " + passage.title)
                    .lineLimit(1)
            }
            .font(.psycheMono(.caption))
            .foregroundStyle(PsycheColor.inkText)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .overlay(Capsule().strokeBorder(PsycheColor.rule, lineWidth: 1))
            .frame(maxWidth: 260, alignment: .leading)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Source: \(passageSourceName(passage.source)), \(passage.title)")
        .accessibilityIdentifier("passage-chip")
    }
}

/// One cited passage, read-only. Text from mail and files is someone else's words: plain text, never rendered.
private struct PassageSheet: View {
    let viewer: SearchModel.Viewer
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(viewer.passage.title).font(.system(.title3, design: .serif)).foregroundStyle(PsycheColor.text)
                    EvidenceLine(
                        [passageSourceName(viewer.passage.source)]
                            + (viewer.passage.date.map { [$0.formatted(.dateTime.month(.abbreviated).day().year())] } ?? []))
                    switch viewer.state {
                    case .loading:
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
                    case .document(let document):
                        Text(document.text).font(.body).foregroundStyle(PsycheColor.text).textSelection(.enabled)
                        if document.truncated { EvidenceLine(["Only the start is shown"]) }
                        EvidenceLine(["Written by someone else. Shown as plain text."])
                    case .onYourMac:
                        PaperCard(padding: 14) {
                            HStack(spacing: 10) {
                                Image(systemName: "desktopcomputer").foregroundStyle(PsycheColor.muted)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Open on your Mac").font(.subheadline.weight(.semibold)).foregroundStyle(PsycheColor.text)
                                    Text("This one isn't opened on your phone. Read it in Psyche on your Mac.")
                                        .font(.footnote).foregroundStyle(PsycheColor.muted)
                                }
                            }
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("open-on-mac")
                    case .failed(let message):
                        Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
                    }
                }
                .padding(PsycheMetrics.pagePadding)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .psycheScreen()
            .navigationTitle("Source")
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
