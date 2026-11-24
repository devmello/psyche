import SwiftUI

/// The end of a list that loads a page at a time (`PagedRows`). While it is on screen it asks for the next page, and
/// it asks again after each page that lands while it stays visible: `.task(id:)` restarts on every new cursor, so a
/// short list keeps filling until the end shows a page-less cursor or a retry row. Put it inside a lazy container
/// (`LazyVStack`, `List`), or it is created at once and loads every page without being scrolled to.
///
/// A failed page shows the retry row instead; that row loads again only when the owner taps it.
struct PagedRowsEnd: View {
    let moreFailed: Bool
    let nextCursor: String?
    let loadingMore: Bool
    let label: String
    let loadMore: () async -> Void
    let retryMore: () async -> Void

    var body: some View {
        if moreFailed {
            FailedNotice { Task { await retryMore() } }
        } else if let cursor = nextCursor {
            PageSentinel(loading: loadingMore, label: label)
                .task(id: cursor) { await loadMore() }
        }
    }
}
