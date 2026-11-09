import Foundation
import PsycheShared
import PsycheStore

/// Live Activities for chat replies that run long. A reply that has been streaming or working for about 20 seconds
/// gets one activity (title, a self-moving timer, the latest short status); it ends with a brief "done" (or
/// "failed") when the reply finishes. Driven by the same chat events the thread screen reads, so it works with the
/// thread closed or the phone locked, and never needs a push.
///
/// Rules this file keeps:
/// - One activity per chat. `ChatTurnActivityHost.start` refuses a second, and a stale one is updated, not replaced.
/// - A chat whose work is already shown by a task's activity gets none (and loses one it had when that task is
///   watched): the same work never shows twice.
/// - Freshness is the task activity's: every update carries a stale date (`ActivityFreshness`), awake or asleep.
extension AlertCenter {
    // MARK: - Events

    /// A chat event from the live stream.
    func handleChat(_ event: ChatEvent) async {
        if case .run(let threadID, let update) = event, !update.isChat, let task = update.taskID {
            taskThreads[task] = threadID  // which chat a task belongs to, for the no-duplicates rule
        }
        await process(chatTracker.apply(event, now: .now))
    }

    /// The thread list: ends replies the events never closed, learns chat titles. (It never starts one.)
    func reconcileChatTurns() async {
        guard let summaries = try? await store.threads() else { return }
        for summary in summaries { chatTitles[summary.id] = summary.title }
        await process(chatTracker.reconcile(summaries, now: .now))
        // An activity the system kept across a relaunch for a reply that has since ended. What it last showed is
        // known only if this run of the app drew it; otherwise how it ended is not, so it is just removed.
        for id in chatWatching where chatTracker.turns[id] == nil {
            if let final = finalContent(for: id, failed: false, at: .now) {
                await endChatActivity(id, final: final, dismissAfter: Self.doneLinger)
            } else {
                await endChatActivity(id, final: nil, dismissAfter: 0)
            }
        }
        updateAwake()
    }

    private func process(_ changes: [ChatTurnTracker.Change]) async {
        for change in changes {
            switch change {
            case .started(let turn):
                scheduleChatStart(turn)
            case .updated(let turn):
                if chatWatching.contains(turn.threadID) {
                    await pushChat(turn)
                } else {
                    await startChatActivityIfDue(turn.threadID)
                }
            case .ended(let turn, let outcome, let at):
                chatStartTimers[turn.threadID]?.cancel()
                chatStartTimers[turn.threadID] = nil
                switch outcome {
                case .done, .failed:
                    let failed = outcome == .failed
                    await endChatActivity(
                        turn.threadID, final: finalContent(for: turn.threadID, failed: failed, at: at),
                        dismissAfter: failed ? Self.failedLinger : Self.doneLinger)
                case .cancelled:
                    await endChatActivity(turn.threadID, final: nil, dismissAfter: 0)
                }
            }
        }
        updateAwake()
    }

    // MARK: - Starting

    /// How long the finished state stays on screen.
    static let doneLinger: TimeInterval = 8
    static let failedLinger: TimeInterval = 60

    private func scheduleChatStart(_ turn: ChatTurnTracker.Turn) {
        guard chatStartTimers[turn.threadID] == nil else { return }
        let delay = max(0, turn.startedAt.addingTimeInterval(chatThreshold).timeIntervalSinceNow)
        let id = turn.threadID
        chatStartTimers[id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.chatStartTimers[id] = nil
            await self.startChatActivityIfDue(id)
        }
    }

    func startChatActivityIfDue(_ id: String) async {
        guard let turn = chatTracker.turns[id], !chatWatching.contains(id), liveActivitiesOn,
              Date.now.timeIntervalSince(turn.startedAt) >= chatThreshold - 0.25 else { return }
        guard !chatCoveredByTask(id) else { return }
        if chatTitles[id] == nil { await loadChatTitles() }
        // Awaiting the titles may have let the reply end or another path start the activity.
        guard let current = chatTracker.turns[id], !chatWatching.contains(id), chatActivities.isEnabled else { return }
        let now = Date.now
        let content = chatContent(for: current)
        let stale = staleDate(from: now)
        guard chatActivities.start(threadID: id, content: content, staleDate: stale) else { return }
        chatWatching.insert(id)
        chatContents[id] = content
        chatPushes[id] = now
        chatStaleDates[id] = stale
        scheduleStaleRefresh()
        updateAwake()
    }

    private func loadChatTitles() async {
        guard let summaries = try? await store.threads() else { return }
        for summary in summaries { chatTitles[summary.id] = summary.title }
    }

    // MARK: - Content

    func chatContent(for turn: ChatTurnTracker.Turn) -> ChatTurnContent {
        let phase: ChatTurnPhase
        var detail: String?
        if turn.waiting {
            phase = .waiting
        } else {
            switch turn.latest {
            case .thinking: phase = .thinking
            case .writing: phase = .writing
            case .text(let text):
                phase = .working
                detail = text
            }
        }
        let title = chatTitles[turn.threadID]
        return ChatTurnContent(
            phase: phase, startedAt: turn.startedAt, title: settings.taskTitlesOnLockScreen ? title : nil,
            islandTitle: title, detail: detail)
    }

    private func finalContent(for id: String, failed: Bool, at end: Date) -> ChatTurnContent? {
        chatContents[id]?.finished(failed: failed, at: end)
    }

    // MARK: - Updating

    /// A changed status goes out at most every few seconds; an unchanged one never.
    private func pushChat(_ turn: ChatTurnTracker.Turn) async {
        let content = chatContent(for: turn)
        guard content != chatContents[turn.threadID] else { return }
        let now = Date.now
        if let last = chatPushes[turn.threadID], now.timeIntervalSince(last) < chatMinInterval {
            scheduleChatCatchUp(after: chatMinInterval - now.timeIntervalSince(last))
            return
        }
        await pushChat(turn.threadID, content, at: now)
    }

    func pushChat(_ id: String, _ content: ChatTurnContent, at now: Date, staleDate: Date? = nil) async {
        let stale = staleDate ?? self.staleDate(from: now)
        chatContents[id] = content
        chatPushes[id] = now
        chatStaleDates[id] = stale
        await chatActivities.update(threadID: id, content: content, staleDate: stale)
    }

    private func scheduleChatCatchUp(after delay: TimeInterval) {
        guard chatCatchUp == nil else { return }
        chatCatchUp = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0.1, delay)))
            guard !Task.isCancelled, let self else { return }
            self.chatCatchUp = nil
            for id in self.chatWatching {
                if let turn = self.chatTracker.turns[id] { await self.pushChat(turn) }
            }
        }
    }

    // MARK: - Ending

    func endChatActivity(_ id: String, final: ChatTurnContent?, dismissAfter: TimeInterval) async {
        let had = chatWatching.contains(id)
        chatWatching.remove(id)
        chatContents[id] = nil
        chatPushes[id] = nil
        chatStaleDates[id] = nil
        if had { await chatActivities.end(threadID: id, final: final, dismissAfter: dismissAfter) }
    }

    /// Live Activities were turned off: every chat activity goes.
    func endAllChatActivities() async {
        for timer in chatStartTimers.values { timer.cancel() }
        chatStartTimers = [:]
        for id in chatWatching { await endChatActivity(id, final: nil, dismissAfter: 0) }
    }

    /// Live Activities were turned (back) on: replies already past the threshold get theirs.
    func startDueChatActivities() async {
        for turn in chatTracker.turns.values { scheduleChatStart(turn) }
        for id in chatTracker.turns.keys { await startChatActivityIfDue(id) }
    }

    /// The owner swiped one away, or the system ended it.
    func chatActivitiesChangedBySystem() {
        chatWatching.formIntersection(chatActivities.activeThreadIDs)
        for id in chatContents.keys where !chatWatching.contains(id) {
            chatContents[id] = nil
            chatPushes[id] = nil
            chatStaleDates[id] = nil
        }
        updateAwake()
    }

    // MARK: - No duplicates with the task activity

    /// Some task with a Live Activity is the work of this chat.
    func chatCoveredByTask(_ threadID: String) -> Bool {
        watching.contains { taskThreads[$0] == threadID }
    }

    /// A task was just watched: its chat's own activity would say the same thing a second time.
    func endChatActivitiesCoveredByTasks() async {
        for id in chatWatching where chatCoveredByTask(id) {
            await endChatActivity(id, final: nil, dismissAfter: 0)
        }
    }

    // MARK: - Freshness (the same rules as the task activities)

    /// Awake and the stale date is about to pass (or the app just opened with a live connection): the unchanged
    /// activity gets a later one. Asleep, nothing can, and the activity goes stale on its own.
    func refreshChatFreshness() async {
        let now = Date.now
        for id in chatWatching {
            guard let content = chatContents[id], let stale = chatStaleDates[id] else { continue }
            let due = isAwake && now >= ActivityFreshness.refreshTime(forStaleDate: stale)
            if due || (refreshStaleOnNextSync && connectionLive) { await pushChat(id, content, at: now) }
        }
    }

    /// The app is away with nothing keeping it awake: every chat activity's fuse is cut to the short one.
    func shortenChatStaleDates(to short: Date, at now: Date) async {
        for id in chatWatching {
            guard let content = chatContents[id], let current = chatStaleDates[id], short < current else { continue }
            await pushChat(id, content, at: now, staleDate: short)
        }
    }

    /// An awake stretch ended with no way to vouch for the state: mark every chat activity stale at once.
    func markChatActivitiesStale(at now: Date) async {
        for id in chatWatching {
            if let content = chatContents[id] { await pushChat(id, content, at: now, staleDate: now) }
        }
    }
}
