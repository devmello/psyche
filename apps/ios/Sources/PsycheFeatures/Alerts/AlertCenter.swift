import Foundation
import Observation
import PsycheClient
import PsycheShared
import PsycheStore
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Live Activities and local notifications, driven by the app itself (docs/design/mobile-companion-2026.md
/// "M2-lite"). With no Apple Developer account there is no APNs, so everything here runs from the live Gateway
/// connection, or from a short background check iOS grants now and then. It reads the same snapshots the
/// screens read, so it can say nothing the owner could not see in the app.
@MainActor @Observable
public final class AlertCenter {
    enum SyncMode { case baseline, live, background }

    /// A screen to open, set by a notification tap and consumed by the shell.
    enum OpenRequest: Equatable {
        /// An approval or question by id: its sheet.
        case item(String)
        /// A desktop route the router maps.
        case path(String)
    }

    /// Task ids with a Live Activity running.
    public private(set) var watching: Set<String> = []
    /// A task the owner just started from this phone; the shell offers to watch it.
    public private(set) var offer: RunningTask?
    var pendingOpen: OpenRequest?
    /// The thread on screen, so a foreground banner skips it.
    var visibleThread: @MainActor () -> String? = { nil }

    let store: any PsycheBackend
    private let notifier: any LocalNotifier
    private let activities: any ActivityHost
    private let connection: any AlertConnection
    private let ledger: NotifiedLedger
    private let isFixture: Bool
    var isFixtureMode: Bool { isFixture }
    var settings = PhoneSettings(
        notifications: true, liveActivities: true, taskTitlesOnLockScreen: false, faceIDForApprovals: true)
    private var coalescer = UpdateCoalescer(interval: 1)
    /// Live Activity updates: a change goes out at most every few seconds, an unchanged one never.
    private let gate = ActivityUpdateGate(minInterval: 5)
    private var lastPush: [String: Date] = [:]
    /// The stale date each activity was last given.
    private var staleDates: [String: Date] = [:]
    private var deferredPush: Task<Void, Never>?
    private var staleRefresh: Task<Void, Never>?
    /// Task ids the Gateway said were running or waiting at the last sync.
    private var activeIDs: Set<String> = []
    /// Whether the Gateway connection is live right now. False until the connection says so: nothing vouches for
    /// the state before that.
    var connectionLive = false
    /// The next sync must give every activity a fresh stale date from fresh Gateway data (the app just opened).
    var refreshStaleOnNextSync = false
    /// `setKeepConnected` calls, applied one at a time in the order they were made.
    private let keepConnectedChanges: AsyncStream<Bool>.Continuation
    private var connectionWatcher: Task<Void, Never>?
    private(set) var awake: StayAwakeController?
    /// Debug builds only: `-psycheStaleSeconds 20` makes every stale date that many seconds out, to see the stale
    /// state without waiting minutes.
    private let staleOverride: TimeInterval?
    private var observer: Task<Void, Never>?
    private var scheduledSync: Task<Void, Never>?
    private var baselined = false
    private var appActive = false
    private var sentFromPhoneAt: Date?
    /// What each activity last showed, so an unchanged state is not pushed again.
    private var lastContent: [String: TaskActivityContent] = [:]
    private var titles: [String: String] = [:]
    private var delegate: NotificationDelegate?

    // Chat replies that run long (AlertCenter+ChatTurns.swift).
    let chatActivities: any ChatTurnActivityHost
    /// How long a reply must have been going before it gets an activity.
    let chatThreshold: TimeInterval
    var chatTracker = ChatTurnTracker()
    /// A changed status goes out at most this often.
    var chatMinInterval: TimeInterval = 5
    /// Chats with a Live Activity running.
    var chatWatching: Set<String> = []
    var chatContents: [String: ChatTurnContent] = [:]
    var chatPushes: [String: Date] = [:]
    var chatStaleDates: [String: Date] = [:]
    var chatTitles: [String: String] = [:]
    var chatStartTimers: [String: Task<Void, Never>] = [:]
    var chatCatchUp: Task<Void, Never>?
    /// Which chat each task belongs to, learned from the Gateway's runs and approvals: a chat whose task has its
    /// own activity gets none of its own.
    var taskThreads: [String: String] = [:]

    init(
        store: any PsycheBackend, notifier: any LocalNotifier, activities: any ActivityHost,
        connection: any AlertConnection, ledger: NotifiedLedger, isFixture: Bool = false,
        awakeAudio: any SilentAudio = NoSilentAudio(), deviceConditions: any DeviceConditions = NoDeviceConditions(),
        awakeLedger: AwakeTimeLedger = AwakeTimeLedger(directory: nil),
        awakeCap: AwakeCapStore = AwakeCapStore(directory: nil), staleOverride: TimeInterval? = nil,
        chatActivities: any ChatTurnActivityHost = NoChatTurnActivityHost(),
        chatThreshold: TimeInterval = ChatTurnTracker.longRunning
    ) {
        self.chatActivities = chatActivities
        self.chatThreshold = chatThreshold
        chatWatching = Set(chatActivities.activeThreadIDs)
        let (changes, continuation) = AsyncStream<Bool>.makeStream(bufferingPolicy: .unbounded)
        keepConnectedChanges = continuation
        Task { [connection] in for await keep in changes { await connection.setKeepConnected(keep) } }
        self.staleOverride = staleOverride
        self.store = store
        self.notifier = notifier
        self.activities = activities
        self.connection = connection
        self.ledger = ledger
        self.isFixture = isFixture
        watching = Set(activities.activeTaskIDs)
        awake = StayAwakeController(
            audio: awakeAudio, conditions: deviceConditions, ledger: awakeLedger, capStore: awakeCap,
            setKeepConnected: { [keepConnectedChanges] keep in keepConnectedChanges.yield(keep) },
            onStopped: { [weak self] reason in self?.awakeStopped(reason) })
        activities.observeChanges { [weak self] in self?.activitiesChangedBySystem() }
        chatActivities.observeChanges { [weak self] in self?.chatActivitiesChangedBySystem() }
    }

    /// The real wiring. `client` is nil in fixture mode (`-psycheScenario`, "Try it without a Mac").
    public static func make(store: any PsycheBackend, client: GatewayClient?) -> AlertCenter {
        #if os(iOS)
        let host: any ActivityHost = SystemActivityHost()
        let chatHost: any ChatTurnActivityHost = SystemChatTurnActivityHost()
        #else
        let host: any ActivityHost = NoActivityHost()
        let chatHost: any ChatTurnActivityHost = NoChatTurnActivityHost()
        #endif
        // Fixtures keep their own ledger in memory: made-up data must not touch the real one.
        let ledger = NotifiedLedger(directory: client == nil ? nil : AppGroup.dataDirectory)
        let awakeLedger = AwakeTimeLedger(directory: client == nil ? nil : AppGroup.dataDirectory)
        let awakeCap = AwakeCapStore(directory: client == nil ? nil : AppGroup.dataDirectory)
        #if os(iOS)
        // Fixtures (no Gateway) never play audio: nothing real is being kept alive.
        let audio: any SilentAudio = client == nil ? NoSilentAudio() : SystemSilentAudio()
        let conditions: any DeviceConditions = SystemDeviceConditions()
        #else
        let audio: any SilentAudio = NoSilentAudio()
        let conditions: any DeviceConditions = NoDeviceConditions()
        #endif
        var staleOverride: TimeInterval?
        #if DEBUG
        let seconds = UserDefaults.standard.double(forKey: "psycheStaleSeconds")
        if seconds > 0 { staleOverride = seconds }
        #endif
        var chatThreshold = ChatTurnTracker.longRunning
        #if DEBUG
        // `-psycheChatTurnSeconds 4`: a chat reply earns its Live Activity after 4 seconds, to see it without waiting.
        let turnSeconds = UserDefaults.standard.double(forKey: "psycheChatTurnSeconds")
        if turnSeconds > 0 { chatThreshold = turnSeconds }
        #endif
        return AlertCenter(
            store: store, notifier: SystemNotifier(),
            activities: host,
            connection: client.map { GatewayAlertConnection(client: $0) } ?? FixtureAlertConnection(),
            ledger: ledger, isFixture: client == nil, awakeAudio: audio, deviceConditions: conditions,
            awakeLedger: awakeLedger, awakeCap: awakeCap, staleOverride: staleOverride, chatActivities: chatHost,
            chatThreshold: chatThreshold)
    }

    // MARK: - App hooks

    /// Installs the notification delegate and the categories. Call once, early in launch (no permission needed).
    public func installSystemHooks() {
        guard delegate == nil else { return }
        let delegate = NotificationDelegate(center: self)
        self.delegate = delegate
        #if os(iOS)
        let center = UNUserNotificationCenter.current()
        center.delegate = delegate
        center.setNotificationCategories(SystemNotifier.categories())
        #endif
        IslandAnswers.handler = { [weak self] id, approve in
            await self?.answerFromIsland(id, approve: approve)
        }
    }

    public func setAppActive(_ active: Bool) {
        let changed = appActive != active
        appActive = active
        guard changed else { return }
        // Leaving: the app stays "in front" for the stay-awake audio until the early start below has run, because
        // iOS refuses to start audio from the background.
        if active { awake?.setForeground(true) }
        Task {
            if active {
                // Open again: ask for fresh data. Each activity gets a fresh, longer fuse only from what the Gateway
                // says now, and only with a live connection (never by re-pushing what was shown before).
                refreshStaleOnNextSync = true
                requestSync()
                await reconcileChatTurns()
                // A reply past the threshold whose request was refused in the background (or never made) gets it now.
                await startDueChatActivities()
            } else {
                // Leaving: iOS refuses a request once the app is in the background, so start any in-flight reply's now.
                await startChatActivitiesOnLeaving()
                awake?.setForeground(appActive)
            }
            if !active, awake?.isRunning != true {
                // Leaving with nothing keeping the app awake: nothing can refresh the activity, so shorten its fuse.
                await shortenStaleDates()
            }
        }
    }

    /// Seconds Psyche has kept itself awake today, for Settings.
    public func awakeSecondsToday() async -> TimeInterval { await awake?.secondsToday() ?? 0 }

    /// Starts watching the backend's events. Safe to call again; the shell calls it once the phone is paired.
    public func start() {
        guard observer == nil else { return }
        connectionWatcher = Task { [weak self] in
            guard let self else { return }
            for await live in self.connection.liveStates() {
                self.connectionLive = live
                self.awake?.setGateway(live: live)
                if live { self.requestSync() }
            }
        }
        observer = Task { [weak self] in
            guard let self else { return }
            // Subscribed first: what happens while the first read is in flight (a reply started right at launch)
            // must not be lost.
            let events = self.store.events()
            await self.loadSettings()
            await self.sync(.baseline)
            await self.reconcileChatTurns()
            for await event in events {
                switch event {
                case .chat(let chat): await self.handleChat(chat)
                case .changed(.threads): await self.reconcileChatTurns()
                case .resynced:
                    self.requestSync()
                    await self.reconcileChatTurns()
                case .changed(.home), .changed(.activity): self.requestSync()
                case .changed(.settings):
                    await self.loadSettings()
                    await self.applySettings()
                default: break
                }
            }
        }
    }

    func noteSentFromPhone() {
        sentFromPhoneAt = .now
    }

    public func dismissOffer() {
        offer = nil
    }

    // MARK: - Settings

    private func loadSettings() async {
        if let loaded = try? await store.settings() { settings = loaded }
        awake?.setSwitch(settings.stayConnectedWhileRunning && liveActivitiesOn)
    }

    var liveActivitiesOn: Bool { settings.notifications && settings.liveActivities }

    /// The owner flipped a toggle: end activities that are no longer allowed, and redraw the rest with or
    /// without the title.
    private func applySettings() async {
        if !liveActivitiesOn {
            for id in watching { await activities.end(taskID: id, final: nil, dismissAfter: 0) }
            await endAllChatActivities()
            watching = []
            lastContent = [:]
            lastPush = [:]
            staleDates = [:]
            offer = nil
            updateAwake()
        } else {
            lastContent = [:]
            await sync(.live)
            await startDueChatActivities()
        }
    }

    /// Settings' Notifications toggle: asks iOS the first time. Returns false (so the toggle goes back off)
    /// when permission is refused.
    public func requestNotificationPermission() async -> Bool {
        switch await notifier.authorization() {
        case .allowed: return true
        case .denied: return false
        case .notDetermined: return await notifier.requestAuthorization()
        }
    }

    public var liveActivitiesAllowedBySystem: Bool { activities.isEnabled }

    // MARK: - Live Activity

    /// Home's Watch button and the offer. Returns a quiet message when it could not start.
    public func watch(_ task: RunningTask) async -> String? {
        await loadSettings()
        guard liveActivitiesOn else { return "Live Activities are off. Turn them on in Settings." }
        guard activities.isEnabled else { return "Live Activities are off for Psyche in the iOS Settings app." }
        if watching.contains(task.id) { return nil }
        // An approval the task is already waiting on shows from the start: the island must not wait for the next
        // sync, which may not come before the app is suspended.
        let waiting = (try? await store.home())?.needsYou ?? []
        let content = activityContent(task: task, needsYou: waiting, fallbackStart: nil)
        let now = Date.now
        let stale = staleDate(from: now)
        guard activities.start(taskID: task.id, content: content, staleDate: stale) else { return "Couldn't start the Live Activity." }
        watching.insert(task.id)
        lastContent[task.id] = content
        lastPush[task.id] = now
        staleDates[task.id] = stale
        updateAwake()
        scheduleStaleRefresh()
        titles[task.id] = task.title
        if offer?.id == task.id { offer = nil }
        if let fixtures = store as? FixtureBackend { await fixtures.startRunningDemo(taskID: task.id) }
        // The task's own activity now shows this work: its chat must not show it a second time.
        await endChatActivitiesCoveredByTasks()
        return nil
    }

    func requestSync() {
        switch coalescer.request(at: .now) {
        case .runNow:
            Task { await sync(.live) }
        case .runAfter(let delay):
            scheduledSync = Task { [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled, let self else { return }
                self.coalescer.fire(at: .now)
                await self.sync(.live)
            }
        case .alreadyScheduled:
            break
        }
    }

    /// One pass: read Home, announce what is new, clear what was answered elsewhere, update the activities.
    func sync(_ mode: SyncMode) async {
        guard let home = try? await store.home() else { return }
        let running = Set(home.running.map(\.id))
        let previous = Set(await ledger.knownRunning())

        let effective: SyncMode = mode == .background ? .background : (baselined ? .live : .baseline)
        // The Live Activity first: announcing can wait on the system's notification prompt, and a backgrounded
        // app may be suspended right after it, which would leave the island showing the old state.
        let vanished = previous.union(watching).subtracting(running)
        let recent = vanished.isEmpty ? [] : ((try? await store.activity())?.recent ?? [])
        for item in home.needsYou {
            if let task = item.taskID, let thread = item.threadID { taskThreads[task] = thread }
        }
        activeIDs = running.union(home.needsYou.compactMap(\.taskID))
        await updateActivities(home: home, recent: recent)
        updateAwake()

        await announce(home.needsYou, mode: effective)
        await clearStale(pending: Set(home.needsYou.map(\.id)))
        if effective != .baseline {
            await announceFinished(vanished: vanished, recent: recent)
            if effective == .live { considerOffer(home.running, previous: previous) }
        }
        await ledger.setRunning(home.running.map(\.id))
        if mode != .background { baselined = true }
    }

    /// What a task's Live Activity shows: its step, and the approval it is waiting on, if any.
    private func activityContent(task: RunningTask, needsYou: [NeedsYouItem], fallbackStart: Date?) -> TaskActivityContent {
        let approval = needsYou.first { $0.kind == .approval && $0.taskID == task.id }
        return TaskActivityContent.make(
            task: task, status: approval != nil ? .needsApproval : .running,
            showTitle: settings.taskTitlesOnLockScreen, fallbackStart: fallbackStart,
            asking: approval?.title,
            inlineApprovalID: approval.flatMap { AlertPolicy.answersInline($0) ? $0.id : nil })
    }

    private func updateActivities(home: HomeSnapshot, recent: [RecentRun]) async {
        // The system's list is the truth: an activity the owner swiped away is no longer being watched.
        watching.formIntersection(activities.activeTaskIDs)
        let now = Date.now
        for id in watching {
            if let task = home.running.first(where: { $0.id == id }) {
                titles[id] = task.title
                let content = activityContent(task: task, needsYou: home.needsYou, fallbackStart: lastContent[id]?.startedAt)
                switch gate.decide(
                    old: lastContent[id], new: content, lastPush: lastPush[id], staleDate: staleDates[id],
                    awake: isAwake, now: now)
                {
                case .push, .refreshStale:
                    await push(id, content, at: now)
                case .skip where refreshStaleOnNextSync && connectionLive:
                    await push(id, content, at: now)
                case .wait(let delay):
                    scheduleDeferredSync(after: delay)
                case .skip:
                    break
                }
            } else {
                let outcome = recent.first { $0.id == id }?.outcome
                switch outcome {
                case .done, .failed:
                    let failed = outcome == .failed
                    let base = lastContent[id] ?? TaskActivityContent(step: 0, stepCount: 0, status: .running, startedAt: .now)
                    let final = base.finished(failed: failed).titled(titles[id], show: settings.taskTitlesOnLockScreen)
                    await activities.end(taskID: id, final: final, dismissAfter: failed ? 300 : 120)
                case .cancelled, .none:
                    await activities.end(taskID: id, final: nil, dismissAfter: 0)
                }
                watching.remove(id)
                lastContent[id] = nil
                lastPush[id] = nil
                staleDates[id] = nil
            }
        }
        await refreshChatFreshness()
        await endChatActivitiesCoveredByTasks()
        if connectionLive { refreshStaleOnNextSync = false }
        scheduleStaleRefresh()
    }

    // MARK: - Freshness

    /// Awake: the app is open or keeping itself awake, and the Gateway connection is live to vouch for the state.
    var isAwake: Bool { (appActive || awake?.isRunning == true) && connectionLive }

    func staleDate(from now: Date) -> Date {
        if let staleOverride { return now.addingTimeInterval(staleOverride) }
        return ActivityFreshness.staleDate(lastUpdate: now, awake: isAwake)
    }

    /// One update to an activity: records what it now shows and when it goes stale.
    private func push(_ id: String, _ content: TaskActivityContent, at now: Date, staleDate: Date? = nil) async {
        let stale = staleDate ?? self.staleDate(from: now)
        lastContent[id] = content
        lastPush[id] = now
        staleDates[id] = stale
        await activities.update(taskID: id, content: content, staleDate: stale)
    }

    /// A changed state that came too soon after the last push goes out once the interval has passed.
    private func scheduleDeferredSync(after delay: TimeInterval) {
        guard deferredPush == nil else { return }
        deferredPush = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.deferredPush = nil
            await self.sync(.live)
        }
    }

    /// While awake, one sleep until the earliest stale date is about to pass; then the unchanged activity gets a
    /// later one. Not a poll: it is re-armed only by an update and runs once per stale period.
    func scheduleStaleRefresh() {
        staleRefresh?.cancel()
        staleRefresh = nil
        let stale = watching.compactMap { staleDates[$0] } + chatWatching.compactMap { chatStaleDates[$0] }
        guard staleOverride == nil, isAwake, let soonest = stale.min() else { return }
        let delay = max(1, ActivityFreshness.refreshTime(forStaleDate: soonest).timeIntervalSinceNow)
        staleRefresh = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            await self.sync(.live)
        }
    }

    /// The app left with nothing holding it awake: nothing can refresh the activities, so their fuse is cut to the
    /// short one. (Only ever shortened, so it cannot make a stale one fresh.)
    private func shortenStaleDates() async {
        let now = Date.now
        let short = now.addingTimeInterval(staleOverride ?? ActivityFreshness.staleAfterAsleep)
        for id in watching {
            guard let content = lastContent[id], let current = staleDates[id], short < current else { continue }
            await push(id, content, at: now, staleDate: short)
        }
        await shortenChatStaleDates(to: short, at: now)
        staleRefresh?.cancel()
        staleRefresh = nil
    }

    // MARK: - Staying awake

    /// Tells the awake controller what is being watched: the system's list of activities, and how many of those
    /// the Gateway says are still running or waiting.
    func updateAwake() {
        let systemWatched = Set(activities.activeTaskIDs)
        // A chat reply with an activity keeps the app awake like a watched task does, under its own key.
        let chatWatched = Set(chatActivities.activeThreadIDs)
        let chatRunning = Set(chatWatched.filter { chatTracker.turns[$0] != nil }.map { "chat:" + $0 })
        awake?.setTasks(
            watched: systemWatched.count + chatWatched.count,
            active: systemWatched.intersection(activeIDs).union(chatRunning))
    }

    /// The owner dismissed an activity, or the system ended one.
    private func activitiesChangedBySystem() {
        watching.formIntersection(activities.activeTaskIDs)
        updateAwake()
    }

    /// An awake stretch ended while tasks are still being watched: what the activity shows can no longer be
    /// vouched for. The cap and an unreachable Gateway mark it stale at once; any other reason, once the app is
    /// away, leaves only the short fuse.
    private func awakeStopped(_ reason: StayAwake.StopReason) {
        scheduleStaleRefresh()
        guard !watching.isEmpty || !chatWatching.isEmpty else { return }
        Task {
            if reason == .gatewayUnreachable || (reason == .hardCap && !appActive) {
                let now = Date.now
                for id in watching {
                    if let content = lastContent[id] { await push(id, content, at: now, staleDate: now) }
                }
                await markChatActivitiesStale(at: now)
            } else if !appActive {
                await shortenStaleDates()
            }
        }
    }

    // MARK: - Notifications

    private func announce(_ items: [NeedsYouItem], mode: SyncMode) async {
        if mode == .baseline || !settings.notifications {
            // What is already waiting when the app opens is on Home; turning notifications on later must not
            // replay it.
            await ledger.markSeen(items.map(\.id))
            return
        }
        for item in items {
            if await ledger.contains(item.id) { continue }
            var status = await notifier.authorization()
            if status == .notDetermined && mode == .live {
                // The first time something needs the owner: ask then, never at launch.
                _ = await notifier.requestAuthorization()
                status = await notifier.authorization()
            }
            guard status == .allowed, await ledger.claim(item.id) else { continue }
            await notifier.post(AlertPolicy.payload(for: item))
            #if canImport(UIKit) && os(iOS)
            if mode == .live && appActive { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
            #endif
        }
    }

    private func announceFinished(vanished: Set<String>, recent: [RecentRun]) async {
        guard settings.notifications, await notifier.authorization() == .allowed else { return }
        for run in recent where vanished.contains(run.id) && run.outcome != .cancelled {
            let payload = AlertPolicy.finished(taskID: run.id, title: run.title, failed: run.outcome == .failed)
            if await ledger.claim(payload.id) { await notifier.post(payload) }
        }
    }

    /// An answer given anywhere (here, the Mac, a notification button) removes the notification everywhere.
    private func clearStale(pending: Set<String>) async {
        let gone = await notifier.delivered().filter {
            guard let category = $0.category else { return false }
            return AlertPolicy.isWaitingOnOwner(category) && !pending.contains($0.id)
        }
        await notifier.removeDelivered(ids: gone.map(\.id))
    }

    private func considerOffer(_ running: [RunningTask], previous: Set<String>) {
        guard liveActivitiesOn, appActive, offer == nil, let sent = sentFromPhoneAt,
              Date.now.timeIntervalSince(sent) < 120 else { return }
        if let new = running.first(where: { !previous.contains($0.id) && !watching.contains($0.id) }) {
            offer = new
            sentFromPhoneAt = nil
        }
    }

    // MARK: - Notification buttons

    /// A tap on a notification or one of its buttons.
    func handle(_ incoming: IncomingNotification) async {
        switch AlertAction(rawValue: incoming.actionID) {
        case .approve: await answer(incoming.id, .allow)
        case .deny: await answer(incoming.id, .deny)
        case .review, .open: pendingOpen = .item(incoming.id)
        case nil:
            // The notification itself was tapped.
            if let route = incoming.route {
                pendingOpen = .path(route)
            } else if incoming.category == .finished {
                pendingOpen = .path("/overview")
            } else {
                pendingOpen = .item(incoming.id)
            }
        }
    }

    /// Approve and Deny from the lock screen. The answer goes out only once the connection is live; if the Mac
    /// can't be reached in a few seconds the notification becomes "Reconnect to answer". An approval is never
    /// queued: its token is single use and it can expire. This path adds no way around Face ID or the passcode:
    /// Approve carries `.authenticationRequired`, and presence-gated kinds get no Approve button at all.
    ///
    /// `onlyIf` re-checks the item against what the Gateway says is waiting before answering; the island's
    /// buttons use it so an id that is no longer a plain write approval is never answered from there.
    /// `refresh` redraws the Live Activities from the fresh state before the connection is let go.
    private func answer(
        _ id: String, _ decision: ApprovalDecision, onlyIf allowed: ((NeedsYouItem) -> Bool)? = nil,
        refresh: Bool = false
    ) async {
        guard await connection.ensureLive(timeout: .seconds(6)) else {
            await notifier.post(AlertPolicy.reconnect(for: id))
            await connection.release(appActive: appActive)
            return
        }
        await send(id, decision, onlyIf: allowed)
        if refresh {
            // Redraw the island while still connected, so its buttons go away whatever happened.
            lastContent = [:]
            await sync(.live)
        }
        await connection.release(appActive: appActive)
    }

    private func send(_ id: String, _ decision: ApprovalDecision, onlyIf allowed: ((NeedsYouItem) -> Bool)?) async {
        if let allowed {
            let item = (try? await store.home())?.needsYou.first { $0.id == id }
            guard let item, allowed(item) else { return }
        }
        do {
            try await store.answerApproval(id: id, decision: decision)
            await notifier.removeDelivered(ids: [id])
        } catch BackendError.unreachable {
            await notifier.post(AlertPolicy.reconnect(for: id))
        } catch BackendError.notFound {
            await notifier.removeDelivered(ids: [id])
        } catch {
            await notifier.post(AlertPolicy.couldNotAnswer(id, message: error.localizedDescription))
        }
    }

    /// Deny or Approve from the expanded Dynamic Island (`AnswerApprovalIntent`). The same path as the
    /// notification buttons, and the same rule: only a write approval with no presence gate is answered here.
    /// The button is drawn only for those, and the id is checked again against the Gateway, so a stale or
    /// forged id never answers a payment. The island then redraws from the fresh state while still connected.
    ///
    /// The intent's id is never enough on its own: the Gateway must say it is waiting, that it belongs to a
    /// task with a Live Activity running (what the island draws its buttons for; the system keeps that list
    /// across a relaunch), and that it may be answered there.
    func answerFromIsland(_ id: String, approve: Bool) async {
        let watched = Set(activities.answerableTaskIDs)
        await answer(id, approve ? .allow : .deny, onlyIf: { item in
            guard let task = item.taskID, watched.contains(task) else { return false }
            return AlertPolicy.answersInline(item)
        }, refresh: true)
    }

    /// Foreground presentation: a banner, except for the thread already on screen.
    func shouldBanner(threadID: String?) -> Bool {
        guard let threadID, appActive else { return true }
        return threadID != visibleThread()
    }

    // MARK: - Background

    /// What a background app refresh does: connect briefly, read approvals and running tasks, announce what is new
    /// (de-duplicated by id), update any running activity, and let go.
    func backgroundCheck() async {
        await loadSettings()
        guard settings.notifications else { return }
        guard await connection.ensureLive(timeout: .seconds(10)) else {
            await connection.release(appActive: appActive)
            return
        }
        await sync(.background)
        await connection.release(appActive: appActive)
    }
}

