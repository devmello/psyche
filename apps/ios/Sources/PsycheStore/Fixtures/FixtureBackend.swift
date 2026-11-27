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
    var voiceMemoState = VoiceMemoFixtureState()
    var receiptsState = ReceiptsState()
    var memoryState = MemoryState()
    var agentState = AgentState()
    var settingsState = SettingsState()
    var modelsState = ModelsState()
    var widgetState = WidgetState()
    var proactiveState = ProactiveState()
    var spacesState = SpacesState()
    var followupsState = FollowupsState()
    var grantsState = GrantsState()
    var nightShiftState = NightShiftState()
    var planForkState = PlanForkState()
    /// The scripted run of the watched task (`startRunningDemo`).
    var demoTask: Task<Void, Never>?
    /// Search returns no hits (tests: a question whose answer is the only result).
    var searchHitsHidden = false
    public func hideSearchHits(_ hidden: Bool) { searchHitsHidden = hidden }

    let latency: Duration
    /// How many times each read was answered, by name (tests count a screen's reloads with it).
    nonisolated let reads = ReadCounter()
    /// Registered synchronously in `events()`, so an event published right after `events()` returns is never missed.
    private nonisolated let subscribers = LiveSubscribers()

    public init(latency: Duration = .zero) {
        self.latency = latency
    }

    func pause() async {
        guard latency > .zero else { return }
        try? await Task.sleep(for: latency)
    }

    func publish(_ event: LiveEvent) {
        subscribers.yield(event)
    }
}

/// Counts the fixture's reads by name. A lock guards it, so a read never waits on the actor to be counted.
final class ReadCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]

    func hit(_ name: String) {
        lock.lock(); defer { lock.unlock() }
        counts[name, default: 0] += 1
    }

    func count(_ name: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return counts[name, default: 0]
    }
}

/// The fixture's live-event subscribers. A lock, not the actor, guards them so that subscribing is immediate.
final class LiveSubscribers: @unchecked Sendable {
    private let lock = NSLock()
    private var continuations: [UUID: AsyncStream<LiveEvent>.Continuation] = [:]

    func add(_ id: UUID, _ continuation: AsyncStream<LiveEvent>.Continuation) {
        lock.lock(); defer { lock.unlock() }
        continuations[id] = continuation
    }

    func remove(_ id: UUID) {
        lock.lock(); defer { lock.unlock() }
        continuations[id] = nil
    }

    func yield(_ event: LiveEvent) {
        lock.lock()
        let all = Array(continuations.values)
        lock.unlock()
        for continuation in all { continuation.yield(event) }
    }
}

extension FixtureBackend: LiveUpdates {
    public nonisolated func events() -> AsyncStream<LiveEvent> {
        let (stream, continuation) = AsyncStream<LiveEvent>.makeStream(bufferingPolicy: .bufferingNewest(256))
        let id = UUID()
        let subscribers = subscribers
        continuation.onTermination = { _ in subscribers.remove(id) }
        subscribers.add(id, continuation)
        return stream
    }
}

/// Static fixture data, split across the feature files.
public enum FixtureData {
    public static let mainThreadID = "thr_main"
}
