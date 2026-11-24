import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheShared
@testable import PsycheStore

private struct Quiet: LocalNotifier {
    func authorization() async -> NotifierAuthorization { .denied }
    func requestAuthorization() async -> Bool { false }
    func post(_ payload: AlertPayload) async {}
    func removeDelivered(ids: [String]) async {}
    func delivered() async -> [DeliveredAlert] { [] }
}

/// A chat-activity host that records what the engine asks of it, and refuses a second activity for a chat.
@MainActor
private final class RecordingChatHost: ChatTurnActivityHost {
    var enabled = true
    /// iOS refusing `Activity.request` (the app is in the background): `start` returns false.
    var refuseStarts = false
    var live: [String: ChatTurnContent] = [:]
    var starts: [(id: String, content: ChatTurnContent, stale: Date?)] = []
    var updates: [(id: String, content: ChatTurnContent, stale: Date?)] = []
    var ends: [(id: String, final: ChatTurnContent?, dismissAfter: TimeInterval)] = []
    var isEnabled: Bool { enabled }
    var activeThreadIDs: [String] { Array(live.keys) }
    func start(threadID: String, content: ChatTurnContent, staleDate: Date?) -> Bool {
        guard enabled, !refuseStarts else { return false }
        if live[threadID] != nil { return true }
        live[threadID] = content
        starts.append((threadID, content, staleDate))
        return true
    }
    func update(threadID: String, content: ChatTurnContent, staleDate: Date?) async {
        live[threadID] = content
        updates.append((threadID, content, staleDate))
    }
    func end(threadID: String, final: ChatTurnContent?, dismissAfter: TimeInterval) async {
        live[threadID] = nil
        ends.append((threadID, final, dismissAfter))
    }
}

/// A task-activity host that starts whatever it is asked to.
@MainActor
private final class TaskHost: ActivityHost {
    var live: Set<String> = []
    var ends: [String] = []
    var isEnabled: Bool { true }
    var activeTaskIDs: [String] { Array(live) }
    func start(taskID: String, content: TaskActivityContent, staleDate: Date?) -> Bool {
        live.insert(taskID)
        return true
    }
    func update(taskID: String, content: TaskActivityContent, staleDate: Date?) async {}
    func end(taskID: String, final: TaskActivityContent?, dismissAfter: TimeInterval) async {
        live.remove(taskID)
        ends.append(taskID)
    }
}

@MainActor
private final class FakeAudio: SilentAudio {
    var isPlaying = false
    var onEvent: (@MainActor (SilentAudioEvent) -> Void)?
    func start() -> Bool { isPlaying = true; return true }
    func pause() { isPlaying = false }
    func resume() -> Bool { isPlaying = true; return true }
    func stop() { isPlaying = false }
}

/// A clock the test moves by hand. Nothing in these tests waits on the wall clock, so machine load cannot change
/// what they see.
@MainActor
private final class ManualClock {
    private(set) var current = Date(timeIntervalSince1970: 1_800_000_000)
    private var sleepers: [(wake: Date, continuation: CheckedContinuation<Void, Never>)] = []

    var pendingWakes: [Date] { sleepers.map(\.wake) }

    var chatClock: ChatClock {
        ChatClock(now: { [self] in current }, sleepUntil: { [self] date in try await sleep(until: date) })
    }

    /// A cancelled sleeper stays parked until the clock passes its time; it then throws, as `Task.sleep` would.
    private func sleep(until date: Date) async throws {
        if date > current {
            await withCheckedContinuation { continuation in sleepers.append((date, continuation)) }
        }
        try Task.checkCancellation()
    }

    func move(to date: Date) {
        current = date
        let due = sleepers.filter { $0.wake <= date }
        sleepers.removeAll { $0.wake <= date }
        for sleeper in due { sleeper.continuation.resume() }
    }
}

@MainActor
private struct Rig {
    let backend: FixtureBackend
    let chat: RecordingChatHost
    let tasks: TaskHost
    let audio: FakeAudio
    let alerts: AlertCenter
    let clock = ManualClock()
    let threshold: TimeInterval

    init(threshold: TimeInterval = 0.2, chat: RecordingChatHost? = nil) {
        let host = chat ?? RecordingChatHost()
        let tasks = TaskHost()
        let audio = FakeAudio()
        let backend = FixtureBackend()
        self.backend = backend
        self.chat = host
        self.tasks = tasks
        self.audio = audio
        self.threshold = threshold
        alerts = AlertCenter(
            store: backend, notifier: Quiet(), activities: tasks, connection: FixtureAlertConnection(),
            ledger: NotifiedLedger(directory: nil), isFixture: true, awakeAudio: audio,
            chatActivities: host, chatThreshold: threshold, clock: clock.chatClock)
        alerts.chatMinInterval = 0.15
    }

    func run(_ thread: String, _ state: RunUpdate.State, chat: Bool = true, task: String? = nil) async {
        await alerts.handleChat(.run(threadID: thread, update: RunUpdate(state: state, isChat: chat, taskID: task)))
    }

    /// Moves the clock forward. Each reply's start timer that falls due on the way fires at its own moment, and
    /// this returns once its work (loading the title, starting the activity) is finished.
    func advance(_ seconds: Double) async {
        let target = clock.current.addingTimeInterval(seconds)
        while let next = (startWakes() + clock.pendingWakes).filter({ $0 <= target }).min() {
            clock.move(to: max(next, clock.current))
            await fireDueStartTimers()
        }
        clock.move(to: target)
        await fireDueStartTimers()
    }

    private func startWakes() -> [Date] {
        alerts.chatTracker.turns.values.compactMap { turn in
            alerts.chatStartTimers[turn.threadID] == nil ? nil : turn.startedAt.addingTimeInterval(threshold)
        }
    }

    private func fireDueStartTimers() async {
        for turn in alerts.chatTracker.turns.values where turn.startedAt.addingTimeInterval(threshold) <= clock.current {
            if let timer = alerts.chatStartTimers[turn.threadID] { await timer.value }
        }
    }

    /// The work the last foreground or background change started.
    func settleAppActive() async { await alerts.appActiveWork?.value }

    /// Waits for something an event stream delivers (no clock involved). It returns as soon as the condition
    /// holds; the long bound only keeps a broken test from hanging.
    func until(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<3000 {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }
}

@MainActor
struct ChatTurnActivityTests {
    @Test func aShortReplyNeverGetsAnActivity() async {
        let rig = Rig()
        await rig.run("thr_q3", .running)
        await rig.advance(0.05)
        await rig.run("thr_q3", .done)
        await rig.advance(0.4)
        #expect(rig.chat.starts.isEmpty)
        #expect(rig.chat.ends.isEmpty)
    }

    @Test func aLongReplyStartsOneActivityWithItsTitleAndNoDuplicates() async throws {
        let rig = Rig()
        await rig.run("thr_q3", .running)
        #expect(rig.chat.starts.isEmpty)  // not yet: the reply is young
        await rig.advance(0.5)
        let start = try #require(rig.chat.starts.first)
        #expect(start.id == "thr_q3")
        #expect(start.content.islandTitle == "Q3 review")
        #expect(start.content.title == nil)  // Lock Screen titles are opt-in
        #expect(start.content.phase == .thinking)
        // The same reply announced again, and text streaming in: still one activity.
        await rig.run("thr_q3", .running)
        await rig.alerts.handleChat(.item(threadID: "thr_q3", item: .assistant(id: "m", text: "Hi", streaming: true)))
        await rig.advance(0.4)
        #expect(rig.chat.starts.count == 1)
        #expect(rig.alerts.chatWatching == ["thr_q3"])
    }

    @Test func theLockScreenTitleAppearsOnlyWhenTheOwnerOptedIn() async throws {
        let rig = Rig()
        rig.alerts.settings.taskTitlesOnLockScreen = true
        await rig.run("thr_q3", .running)
        await rig.advance(0.5)
        let start = try #require(rig.chat.starts.first)
        #expect(start.content.title == "Q3 review")
    }

    @Test func theLatestStatusFollowsTheReplyWithoutFlooding() async throws {
        let rig = Rig()
        rig.alerts.chatMinInterval = 0.8
        await rig.run("thr_q3", .running)
        await rig.advance(0.5)
        let tool = ChatItem.toolCall(id: "c1", symbol: "doc", summary: "Reading 12 files")
        await rig.alerts.handleChat(.item(threadID: "thr_q3", item: tool))
        await rig.advance(0.05)
        // Inside the minimum interval: held back, then sent once.
        #expect(rig.chat.updates.isEmpty)
        await rig.advance(0.9)
        #expect(await rig.until { !rig.chat.updates.isEmpty })  // the held-back status goes out once
        let update = try #require(rig.chat.updates.last)
        #expect(update.content.phase == .working)
        #expect(update.content.detail == "Reading 12 files")
        #expect(rig.chat.updates.count == 1)
    }

    @Test func aFinishedReplyEndsWithABriefDoneState() async throws {
        let rig = Rig()
        await rig.run("thr_q3", .running)
        await rig.advance(0.5)
        await rig.run("thr_q3", .done)
        let end = try #require(rig.chat.ends.first)
        #expect(end.id == "thr_q3")
        #expect(end.final?.phase == .done)
        #expect(end.final?.endedAt != nil)
        #expect(end.dismissAfter == AlertCenter.doneLinger)
        #expect(rig.alerts.chatWatching.isEmpty)
        #expect(rig.chat.live.isEmpty)
    }

    @Test func aFailedReplyEndsFailedAndLingersLonger() async throws {
        let rig = Rig()
        await rig.run("thr_q3", .running)
        await rig.advance(0.5)
        await rig.run("thr_q3", .failed)
        let end = try #require(rig.chat.ends.first)
        #expect(end.final?.phase == .failed)
        #expect(end.dismissAfter == AlertCenter.failedLinger)
    }

    @Test func aCancelledReplyLeavesAtOnceWithoutAFinalState() async throws {
        let rig = Rig()
        await rig.run("thr_q3", .running)
        await rig.advance(0.5)
        await rig.run("thr_q3", .cancelled)
        let end = try #require(rig.chat.ends.first)
        #expect(end.final == nil && end.dismissAfter == 0)
    }

    @Test func eachChatGetsItsOwnActivity() async {
        let rig = Rig()
        await rig.run("thr_q3", .running)
        await rig.run("thr_trip", .running)
        await rig.advance(0.5)
        #expect(Set(rig.chat.starts.map(\.id)) == ["thr_q3", "thr_trip"])
    }

    @Test func theActivityCarriesTheTaskActivitysStaleDateRule() async throws {
        let rig = Rig()
        await rig.run("thr_q3", .running)
        await rig.advance(0.5)
        let stale = try #require(rig.chat.starts.first?.stale)
        // The app is not awake (not open, no live connection): the short fuse.
        let delay = stale.timeIntervalSince(rig.clock.current)
        #expect(delay > ActivityFreshness.staleAfterAsleep - 5 && delay <= ActivityFreshness.staleAfterAsleep)
    }

    @Test func nothingStartsWithLiveActivitiesOffOrDisallowedBySystem() async {
        let off = Rig()
        off.alerts.settings.liveActivities = false
        await off.run("thr_q3", .running)
        await off.advance(0.5)
        #expect(off.chat.starts.isEmpty)

        let blocked = Rig()
        blocked.chat.enabled = false
        await blocked.run("thr_q3", .running)
        await blocked.advance(0.5)
        #expect(blocked.chat.starts.isEmpty)
        #expect(blocked.alerts.chatWatching.isEmpty)
    }

    @Test func turningLiveActivitiesOffEndsTheChatActivities() async {
        let rig = Rig()
        await rig.run("thr_q3", .running)
        await rig.advance(0.5)
        #expect(rig.chat.live.count == 1)
        rig.alerts.start()
        // The settings change reaches the center through the backend's event stream, which subscribes
        // asynchronously: send the change until the center has seen one.
        let off = PhoneSettings(
            notifications: true, liveActivities: false, taskTitlesOnLockScreen: false, faceIDForApprovals: true)
        for _ in 0..<3000 where !rig.chat.live.isEmpty {
            try? await rig.backend.updateSettings(off)
            try? await Task.sleep(for: .milliseconds(10))
        }
        #expect(rig.chat.live.isEmpty)
        #expect(rig.alerts.chatWatching.isEmpty)
    }

    // MARK: No duplicates with the task activity

    @Test func aChatWhoseTaskIsWatchedGetsNoActivityOfItsOwn() async throws {
        let rig = Rig()
        let task = try #require(try await rig.backend.home().running.first)
        #expect(await rig.alerts.watch(task) == nil)
        #expect(rig.alerts.watching == [task.id])
        // The Gateway ties the task to its chat; the chat's reply then runs long.
        await rig.run("thr_q3", .running, chat: false, task: task.id)
        await rig.run("thr_q3", .running)
        await rig.advance(0.5)
        #expect(rig.chat.starts.isEmpty)
    }

    @Test func watchingATaskEndsItsChatsActivity() async throws {
        let rig = Rig()
        let task = try #require(try await rig.backend.home().running.first)
        await rig.run("thr_q3", .running, chat: false, task: task.id)  // linked, task not watched yet
        await rig.run("thr_q3", .running)
        await rig.advance(0.5)
        #expect(rig.chat.starts.count == 1)
        #expect(await rig.alerts.watch(task) == nil)
        #expect(rig.chat.live.isEmpty)
        #expect(rig.chat.ends.first?.final == nil)
        #expect(rig.alerts.chatWatching.isEmpty)
    }

    @Test func aTasksOwnRunIsNotAChatReply() async {
        let rig = Rig()
        await rig.run("thr_q3", .running, chat: false, task: "task_q3")
        await rig.advance(0.5)
        #expect(rig.chat.starts.isEmpty)
    }

    // MARK: Staying connected

    @Test func aChatActivityKeepsTheAppAwakeWhenTheOptInIsOn() async {
        let rig = Rig()
        rig.alerts.setAppActive(true)
        await rig.settleAppActive()
        rig.alerts.awake?.setSwitch(true)
        rig.alerts.awake?.setGateway(live: true)
        await rig.run("thr_q3", .running)
        #expect(rig.alerts.awake?.isRunning != true)  // nothing watched yet: no reason to hold the phone awake
        await rig.advance(0.5)
        #expect(rig.alerts.awake?.isRunning == true)
        #expect(rig.audio.isPlaying)
        await rig.run("thr_q3", .done)
        #expect(rig.alerts.awake?.isRunning != true)
    }

    @Test func withTheOptInOffNothingKeepsTheAppAwake() async {
        let rig = Rig()
        rig.alerts.setAppActive(true)
        await rig.settleAppActive()
        await rig.run("thr_q3", .running)
        await rig.advance(0.5)
        #expect(rig.chat.starts.count == 1)
        #expect(rig.alerts.awake?.isRunning != true)
        #expect(!rig.audio.isPlaying)
    }

    // MARK: Leaving and returning

    @Test func leavingTheAppMidReplyStartsTheActivityBeforeTheThreshold() async throws {
        let rig = Rig(threshold: 30)
        rig.alerts.setAppActive(true)
        await rig.settleAppActive()
        await rig.run("thr_q3", .running)
        await rig.advance(0.05)
        #expect(rig.chat.starts.isEmpty)  // in the foreground a young reply gets none
        rig.alerts.setAppActive(false)
        await rig.settleAppActive()
        let start = try #require(rig.chat.starts.first)
        #expect(start.id == "thr_q3")
        #expect(rig.alerts.chatWatching == ["thr_q3"])
        // The reply finishes fast: it ends the way a finished one does.
        await rig.run("thr_q3", .done)
        let end = try #require(rig.chat.ends.first)
        #expect(end.dismissAfter == AlertCenter.doneLinger)
        #expect(rig.alerts.chatWatching.isEmpty)
    }

    @Test func leavingWithAnActivityKeepsTheGatewayHeldForWatchedWork() async {
        let rig = Rig(threshold: 30)
        rig.alerts.setAppActive(true)
        await rig.settleAppActive()
        rig.alerts.awake?.setSwitch(true)
        rig.alerts.awake?.setGateway(live: true)
        await rig.run("thr_q3", .running)
        rig.alerts.setAppActive(false)
        await rig.settleAppActive()
        #expect(rig.alerts.awake?.isRunning == true)
    }

    @Test func aShortReplyInTheForegroundNeverGetsAnActivity() async {
        let rig = Rig(threshold: 30)
        rig.alerts.setAppActive(true)
        await rig.settleAppActive()
        await rig.run("thr_q3", .running)
        await rig.advance(0.2)
        await rig.run("thr_q3", .done)
        await rig.advance(0.1)
        #expect(rig.chat.starts.isEmpty)
        #expect(rig.chat.ends.isEmpty)
    }

    @Test func leavingWithNoReplyInFlightStartsNothing() async {
        let rig = Rig(threshold: 30)
        rig.alerts.setAppActive(true)
        await rig.settleAppActive()
        rig.alerts.setAppActive(false)
        await rig.settleAppActive()
        #expect(rig.chat.starts.isEmpty)
    }

    @Test func comingBackMidReplyStartsTheActivityForAReplyPastTheThreshold() async throws {
        let chat = RecordingChatHost()
        chat.enabled = false  // nothing could start while away
        let rig = Rig(chat: chat)
        await rig.run("thr_q3", .running)
        await rig.advance(0.5)  // past the threshold
        #expect(chat.starts.isEmpty)
        chat.enabled = true
        rig.alerts.setAppActive(true)
        await rig.settleAppActive()
        #expect(chat.starts.first?.id == "thr_q3")
        #expect(rig.alerts.chatWatching == ["thr_q3"])
    }

    @Test func aRefusedRequestIsRetriedOnReturn() async throws {
        let chat = RecordingChatHost()
        chat.refuseStarts = true
        let rig = Rig(chat: chat)
        await rig.run("thr_q3", .running)
        await rig.advance(0.5)  // the timer fires and iOS refuses
        #expect(rig.alerts.chatWatching.isEmpty)
        chat.refuseStarts = false
        rig.alerts.setAppActive(true)
        await rig.settleAppActive()
        #expect(chat.starts.first?.id == "thr_q3")
        #expect(rig.alerts.chatWatching == ["thr_q3"])
    }

    // MARK: Relaunch

    @Test func anActivityTheSystemKeptForAnEndedReplyIsClosed() async {
        let chat = RecordingChatHost()
        chat.live["thr_lease"] = ChatTurnContent(phase: .writing, startedAt: .now - 60, islandTitle: "Lease renewal questions")
        let rig = Rig(chat: chat)
        #expect(rig.alerts.chatWatching == ["thr_lease"])  // adopted, not duplicated
        // The thread list shows that chat idle.
        await rig.alerts.reconcileChatTurns()
        #expect(chat.live.isEmpty)
        #expect(rig.alerts.chatWatching.isEmpty)
    }
}
