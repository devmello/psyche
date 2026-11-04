import Foundation

/// An in-memory backend that behaves like a small Gateway, for previews, screenshots, UI tests and
/// running the app with no Mac: answering an approval removes it from Home, a sent message streams a
/// reply, and changes fan out as `LiveEvent`s. Fixtures are a general mix (bills, work, family), not
/// school-first (docs/design/ios-app-2026.md §6).
///
/// Each feature keeps its state in its own struct (`HomeState`, `ChatState`, …), defined with its
/// conformance in `FixtureBackend+<Feature>.swift`, so sessions building different screens never
/// edit the same file.
public actor FixtureBackend {
    /// The app's instance. Reads wait a little so loading states show in the running app.
    public static let shared = FixtureBackend(latency: .milliseconds(250))

    var homeState = HomeState()
    var chatState = ChatState()
    var libraryState = LibraryState()
    var memoryState = MemoryState()
    var agentState = AgentState()
    var settingsState = SettingsState()

    private let latency: Duration
    private var subscribers: [UUID: AsyncStream<LiveEvent>.Continuation] = [:]

    public init(latency: Duration = .zero) {
        self.latency = latency
    }

    func pause() async {
        guard latency > .zero else { return }
        try? await Task.sleep(for: latency)
    }

    func publish(_ event: LiveEvent) {
        for continuation in subscribers.values { continuation.yield(event) }
    }

    private func subscribe(_ id: UUID, _ continuation: AsyncStream<LiveEvent>.Continuation) {
        subscribers[id] = continuation
    }

    private func unsubscribe(_ id: UUID) {
        subscribers[id] = nil
    }
}

extension FixtureBackend: LiveUpdates {
    public nonisolated func events() -> AsyncStream<LiveEvent> {
        let (stream, continuation) = AsyncStream<LiveEvent>.makeStream(bufferingPolicy: .bufferingNewest(256))
        let id = UUID()
        continuation.onTermination = { _ in Task { await self.unsubscribe(id) } }
        Task { await self.subscribe(id, continuation) }
        return stream
    }
}

/// Static fixture data, split across the feature files.
public enum FixtureData {
    public static let mainThreadID = "thr_main"
}
