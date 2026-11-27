import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// One feed post, read only: the morning brief, a mail digest or meeting prep, opened from its notification
/// (`/feed/<id>`). Title, time and the body as plain text. The Gateway's text is drawn verbatim: no Markdown, no links.
@MainActor @Observable
final class FeedItemModel {
    private(set) var phase: LoadPhase<FeedCard?> = .idle
    private let id: String
    private let store: any PsycheBackend
    /// Pages searched for the post before giving up (30 posts each); a notification points at a recent one.
    static let maxPages = 4

    init(id: String, store: any PsycheBackend) {
        self.id = id
        self.store = store
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            var cursor: String?
            for _ in 0..<Self.maxPages {
                let page = try await store.feedPage(cursor: cursor)
                if let card = page.cards.first(where: { $0.id == id }) {
                    phase = .loaded(card)
                    return
                }
                guard let next = page.nextCursor else { break }
                cursor = next
            }
            phase = .loaded(nil)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}

struct FeedItemView: View {
    @State private var model: FeedItemModel

    init(id: String, store: any PsycheBackend) {
        _model = State(initialValue: FeedItemModel(id: id, store: store))
    }

    var body: some View {
        ScrollView {
            PhaseView(phase: model.phase, skeleton: Self.skeleton, retry: model.load) { card in
                content(card)
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .psycheScreen()
        .navigationTitle(String(localized: "Today", bundle: .module))
        .psycheInlineTitle()
        .psycheShowsNavigationBar()
        .task { await model.load() }
        .refreshable { await model.load() }
    }

    private static let skeleton: FeedCard? = FeedCard(
        id: "", title: "Placeholder title for a post", body: "Placeholder text for the body of a post that wraps onto a second line.")

    @ViewBuilder
    private func content(_ card: FeedCard?) -> some View {
        if let card {
            VStack(alignment: .leading, spacing: 12) {
                Text(verbatim: card.title).font(.title3.weight(.semibold))
                if let createdAt = card.createdAt {
                    Text(createdAt.formatted(.dateTime.weekday().month().day().hour().minute()))
                        .font(.footnote).foregroundStyle(PsycheColor.muted)
                }
                Text(verbatim: card.body).font(.body)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text("This one is no longer available.", bundle: .module)
                .font(.subheadline).foregroundStyle(PsycheColor.muted)
        }
    }
}
