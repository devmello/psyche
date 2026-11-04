import Foundation

/// What the UI reads. The real store (I2) serves the cached snapshot first and then live data
/// (docs/design/ios-app-2026.md §4); until then `FixtureSnapshotStore` answers.
public protocol SnapshotStore: Sendable {
    func home() async throws -> HomeSnapshot
    func threads() async throws -> [ChatThreadSummary]
    func thread(id: String) async throws -> ChatThread
    func memory() async throws -> MemorySnapshot
    func search(query: String) async throws -> SearchResults
}
