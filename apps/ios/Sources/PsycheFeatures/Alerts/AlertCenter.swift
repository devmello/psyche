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

    private let store: any PsycheBackend
    private let notifier: any LocalNotifier
    private let activities: any ActivityHost
    private let connection: any AlertConnection
    private let ledger: NotifiedLedger
    private let isFixture: Bool
    var isFixtureMode: Bool { isFixture }
    private var settings = PhoneSettings(
        notifications: true, liveActivities: true, taskTitlesOnLockScreen: false, faceIDForApprovals: true)
    private var coalescer = UpdateCoalescer(interval: 1)
    private var observer: Task<Void, Never>?
    private var scheduledSync: Task<Void, Never>?
    private var baselined = false
    private var appActive = false
    private var sentFromPhoneAt: Date?
    /// What each activity last showed, so an unchanged state is not pushed again.
    private var lastContent: [String: TaskActivityContent] = [:]
    private var titles: [String: String] = [:]
    private var delegate: NotificationDelegate?

    init(
        store: any PsycheBackend, notifier: any LocalNotifier, activities: any ActivityHost,
        connection: any AlertConnection, ledger: NotifiedLedger, isFixture: Bool = false
    ) {
        self.store = store
        self.notifier = notifier
        self.activities = activities
        self.connection = connection
        self.ledger = ledger
        self.isFixture = isFixture
        watching = Set(activities.activeTaskIDs)
    }

    /// The real wiring. `client` is nil in fixture mode (`-psycheScenario`, "Try it without a Mac").
    public static func make(store: any PsycheBackend, client: GatewayClient?) -> AlertCenter {
        #if os(iOS)
        let host: any ActivityHost = SystemActivityHost()
        #else
        let host: any ActivityHost = NoActivityHost()
        #endif
        // Fixtures keep their own ledger in memory: made-up data must not touch the real one.
        let ledger = NotifiedLedger(directory: client == nil ? nil : AppGroup.dataDirectory)
        return AlertCenter(
            store: store, notifier: SystemNotifier(),
            activities: host,
            connection: client.map { GatewayAlertConnection(client: $0) } ?? FixtureAlertConnection(),
            ledger: ledger, isFixture: client == nil)
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
    }

    public func setAppActive(_ active: Bool) {
        appActive = active
    }

    /// Starts watching the backend's events. Safe to call again; the shell calls it once the phone is paired.
    public func start() {
        guard observer == nil else { return }
        observer = Task { [weak self] in
            guard let self else { return }
            await self.loadSettings()
            await self.sync(.baseline)
            let events = self.store.events()
            for await event in events {
                switch event {
                case .changed(.home), .changed(.activity), .resynced: self.requestSync()
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
    }

    private var liveActivitiesOn: Bool { settings.notifications && settings.liveActivities }

    /// The owner flipped a toggle: end activities that are no longer allowed, and redraw the rest with or
    /// without the title.
    private func applySettings() async {
        if !liveActivitiesOn {
            for id in watching { await activities.end(taskID: id, final: nil, dismissAfter: 0) }
            watching = []
            lastContent = [:]
            offer = nil
        } else {
            lastContent = [:]
            await sync(.live)
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
        let content = TaskActivityContent.make(
            task: task, status: .running, showTitle: settings.taskTitlesOnLockScreen)
        guard activities.start(taskID: task.id, content: content) else { return "Couldn't start the Live Activity." }
        watching.insert(task.id)
        lastContent[task.id] = content
        titles[task.id] = task.title
        if offer?.id == task.id { offer = nil }
        if let fixtures = store as? FixtureBackend { await fixtures.startRunningDemo(taskID: task.id) }
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
        await announce(home.needsYou, mode: effective)
        await clearStale(pending: Set(home.needsYou.map(\.id)))

        let vanished = previous.union(watching).subtracting(running)
        let recent = vanished.isEmpty ? [] : ((try? await store.activity())?.recent ?? [])
        await updateActivities(home: home, recent: recent)
        if effective != .baseline {
            await announceFinished(vanished: vanished, recent: recent)
            if effective == .live { considerOffer(home.running, previous: previous) }
        }
        await ledger.setRunning(home.running.map(\.id))
        if mode != .background { baselined = true }
    }

    private func updateActivities(home: HomeSnapshot, recent: [RecentRun]) async {
        for id in watching {
            if let task = home.running.first(where: { $0.id == id }) {
                titles[id] = task.title
                let waiting = home.needsYou.contains { $0.kind == .approval && $0.taskID == id }
                let content = TaskActivityContent.make(
                    task: task, status: waiting ? .needsApproval : .running,
                    showTitle: settings.taskTitlesOnLockScreen, fallbackStart: lastContent[id]?.startedAt)
                if lastContent[id] != content {
                    lastContent[id] = content
                    await activities.update(taskID: id, content: content)
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
    private func answer(_ id: String, _ decision: ApprovalDecision) async {
        guard await connection.ensureLive(timeout: .seconds(6)) else {
            await notifier.post(AlertPolicy.reconnect(for: id))
            await connection.release(appActive: appActive)
            return
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
        await connection.release(appActive: appActive)
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
