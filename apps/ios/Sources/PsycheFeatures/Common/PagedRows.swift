import Observation
import PsycheStore

/// A list that loads one page at a time: the first page on `reload()`, the next when the owner reaches the end
/// (`loadMore()`). Rows are kept by id, so a page that repeats a row adds nothing. A reload starts again at page one
/// and drops any page still in flight. A failed next page is kept as `moreFailed`, so the list shows a retry row
/// instead of asking again in a loop.
@MainActor @Observable
final class PagedRows<Row: Identifiable & Sendable> where Row.ID: Hashable & Sendable {
    typealias Page = (rows: [Row], nextCursor: String?)

    private(set) var phase: LoadPhase<[Row]> = .idle
    /// Where the next page starts; nil once the last page is loaded.
    private(set) var nextCursor: String?
    /// True while a page after the first is being fetched.
    private(set) var loadingMore = false
    /// True when the last page after the first failed. Cleared by `retryMore()` or a reload.
    private(set) var moreFailed = false

    private let fetch: @Sendable (String?) async throws -> Page
    /// Bumped by every reload, so an answer to an older request is dropped.
    private var generation = 0

    init(fetch: @escaping @Sendable (String?) async throws -> Page) {
        self.fetch = fetch
    }

    var rows: [Row] { phase.value ?? [] }

    /// Loads page one again and replaces the rows. A failure keeps the rows already shown.
    func reload() async {
        generation += 1
        let current = generation
        loadingMore = false
        moreFailed = false
        if phase.value == nil { phase = .loading }
        do {
            let page = try await fetch(nil)
            guard current == generation else { return }
            nextCursor = page.nextCursor
            phase = .loaded(Self.appending([], page.rows))
        } catch {
            guard current == generation, phase.value == nil else { return }
            phase = .failed(error.localizedDescription)
        }
    }

    /// Fetches the next page, if there is one and none is in flight or failed. Rows already shown are kept; new
    /// rows go on the end.
    func loadMore() async {
        guard !loadingMore, !moreFailed, let cursor = nextCursor, let shown = phase.value else { return }
        loadingMore = true
        let current = generation
        do {
            let page = try await fetch(cursor)
            guard current == generation else { return }
            nextCursor = page.nextCursor
            phase = .loaded(Self.appending(shown, page.rows))
            loadingMore = false
        } catch {
            guard current == generation else { return }
            loadingMore = false
            moreFailed = true
        }
    }

    /// The retry row: clears the failure and asks for the same page again.
    func retryMore() async {
        moreFailed = false
        await loadMore()
    }

    /// Changes shown rows in place (a row marked read), without a fetch.
    func edit(_ change: (inout [Row]) -> Void) {
        guard var shown = phase.value else { return }
        change(&shown)
        phase = .loaded(shown)
    }

    /// `shown` followed by the rows of `page` it does not already have. A row id seen twice keeps its first row.
    static func appending(_ shown: [Row], _ page: [Row]) -> [Row] {
        var known = Set(shown.map(\.id))
        var out = shown
        for row in page where known.insert(row.id).inserted {
            out.append(row)
        }
        return out
    }
}
