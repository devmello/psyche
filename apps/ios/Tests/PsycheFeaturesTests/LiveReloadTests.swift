import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

/// How often the Home, alert and task screens refetch on change events. Each screen reloads once per burst
/// of events, still reloads for a single event, and reloads at once on a resync. Counts come from the fixture's read
/// counter (`FixtureBackend.reads`), so a regression that fans events out again shows as an extra read.
@MainActor
struct LiveReloadTests {
    /// Waits until `ok` holds, up to about three seconds.
    static func eventually(_ ok: () -> Bool) async -> Bool {
        for _ in 0..<300 {
            if ok() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return ok()
    }

    /// Long enough for a debounced reload to have run or to have been coalesced (the tests use a 200 ms debounce).
    static func settle() async {
        try? await Task.sleep(for: .milliseconds(600))
    }

    /// Starts `observe` and waits until its event stream is registered, so a published event is not lost.
    static func observing(_ body: @escaping @MainActor () async -> Void) async -> Task<Void, Never> {
        let task = Task { await body() }
        try? await Task.sleep(for: .milliseconds(50))
        return task
    }

    // MARK: Home

    @Test func aBurstOfHomeEventsReloadsHomeOnce() async {
        let store = FixtureBackend()
        let model = HomeModel(store: store, reloadDelay: .milliseconds(200))
        await model.load()
        let before = store.reads.count("home")
        let task = await Self.observing { await model.observe() }
        defer { task.cancel() }
        for _ in 0..<5 { await store.publish(.changed(.home)) }
        await Self.settle()
        #expect(store.reads.count("home") == before + 1)
    }

    @Test func aSingleHomeEventStillReloadsWithinTheDebounce() async {
        let store = FixtureBackend()
        let model = HomeModel(store: store, reloadDelay: .milliseconds(200))
        await model.load()
        let before = store.reads.count("home")
        let task = await Self.observing { await model.observe() }
        defer { task.cancel() }
        await store.publish(.changed(.home))
        #expect(await Self.eventually { store.reads.count("home") == before + 1 })
    }

    @Test func aResyncReloadsHomeAtOnce() async {
        let store = FixtureBackend()
        let model = HomeModel(store: store, reloadDelay: .seconds(30))
        await model.load()
        let home = store.reads.count("home")
        let task = await Self.observing { await model.observe() }
        defer { task.cancel() }
        await store.publish(.resynced)
        // The debounce is 30 s: the read can only come from the resync itself.
        #expect(await Self.eventually { store.reads.count("home") == home + 1 })
    }

    @Test func homeEventsDoNotReadMemoryOrPins() async {
        let store = FixtureBackend()
        let model = HomeModel(store: store, reloadDelay: .milliseconds(200))
        await model.load()
        let memory = store.reads.count("memory")
        let pins = store.reads.count("pinnedWidgets")
        let home = store.reads.count("home")
        let task = await Self.observing { await model.observe() }
        defer { task.cancel() }
        await store.publish(.changed(.home))
        // Positive control: the home read fires for that event.
        #expect(await Self.eventually { store.reads.count("home") == home + 1 })
        await Self.settle()
        #expect(store.reads.count("memory") == memory)
        #expect(store.reads.count("pinnedWidgets") == pins)
    }

    // MARK: Alert center

    @Test func aBurstOfThreadEventsReconcilesChatTurnsOnce() async {
        let store = FixtureBackend()
        let center = AlertCenter(
            store: store, notifier: RecordingNotifier(), activities: Hosts(), connection: FixtureAlertConnection(),
            ledger: NotifiedLedger(directory: nil), isFixture: true, threadReloadDelay: .milliseconds(200))
        center.start()
        // Start reconciles once, after its settings and baseline sync. Wait for that read, so only the events below count.
        #expect(await Self.eventually { store.reads.count("threads") >= 1 })
        let before = store.reads.count("threads")
        for _ in 0..<5 { await store.publish(.changed(.threads)) }
        await Self.settle()
        #expect(store.reads.count("threads") == before + 1)

        await store.publish(.changed(.threads))
        #expect(await Self.eventually { store.reads.count("threads") == before + 2 })

        // A resync reconciles at once, without waiting out the debounce.
        await store.publish(.resynced)
        #expect(await Self.eventually { store.reads.count("threads") >= before + 3 })
    }

    // MARK: Task run page

    @Test func aFinishedTaskIsNotPolled() async {
        let store = FixtureBackend()
        let model = TaskRunModel(store: store, taskID: "r1", pollInterval: .milliseconds(5), maxPollInterval: .milliseconds(5))
        await model.load()
        let before = store.reads.count("taskRun")
        let poll = Task { await model.pollWhileLive() }
        defer { poll.cancel() }
        try? await Task.sleep(for: .milliseconds(150))
        #expect(store.reads.count("taskRun") == before)
    }

    @Test func aLiveTaskWithNoEventsIsPolled() async {
        let store = FixtureBackend()
        let model = TaskRunModel(
            store: store, taskID: "task_q3", pollInterval: .milliseconds(5), maxPollInterval: .milliseconds(20),
            quietWindow: .zero)
        await model.load()
        let before = store.reads.count("taskRun")
        let poll = Task { await model.pollWhileLive() }
        defer { poll.cancel() }
        #expect(await Self.eventually { store.reads.count("taskRun") >= before + 3 })
    }

    @Test func recentEventsSuppressThePollAndTheLoopStopsWhenCancelled() async {
        let store = FixtureBackend()
        let model = TaskRunModel(
            store: store, taskID: "task_q3", pollInterval: .milliseconds(5), maxPollInterval: .milliseconds(5),
            quietWindow: .seconds(30))
        await model.load()
        let observe = await Self.observing { await model.observe() }
        defer { observe.cancel() }
        let before = store.reads.count("taskRun")
        // The event comes first: the poll is only started once it has been seen, so no poll runs before it.
        await store.publish(.changed(.activity))
        #expect(await Self.eventually { store.reads.count("taskRun") == before + 1 })
        let poll = Task { await model.pollWhileLive() }
        // The event reloaded the page once. While events are recent, the poll itself reads nothing.
        try? await Task.sleep(for: .milliseconds(150))
        #expect(store.reads.count("taskRun") == before + 1)

        poll.cancel()
        let stopped = store.reads.count("taskRun")
        try? await Task.sleep(for: .milliseconds(100))
        #expect(store.reads.count("taskRun") == stopped)
    }
}
