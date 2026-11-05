import Foundation
import Testing

@testable import PsycheShared
@testable import PsycheStore

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

private func inputs(
    switchOn: Bool = true, watched: Int = 1, active: Int = 1, lowPower: Bool = false, battery: Float? = 0.8,
    plugged: Bool = false, awakeFor: TimeInterval? = nil, capLatched: Bool = false, unreachableFor: TimeInterval? = nil
) -> StayAwake.Inputs {
    StayAwake.Inputs(
        switchOn: switchOn, watched: watched, active: active, lowPowerMode: lowPower, batteryLevel: battery,
        pluggedIn: plugged, awakeSince: awakeFor.map { t0.addingTimeInterval(-$0) }, capLatched: capLatched,
        unreachableSince: unreachableFor.map { t0.addingTimeInterval(-$0) }, now: t0)
}

/// The start and stop rules, one trigger at a time.
struct StayAwakePolicyTests {
    @Test func runsOnlyWhenSwitchOnAndAWatchedTaskIsActive() {
        #expect(StayAwake.decide(inputs()) == .run)
    }

    @Test func offByDefaultMeansNeverRuns() {
        #expect(StayAwake.decide(inputs(switchOn: false)) == .stop(.switchOff))
        #expect(StayAwake.decide(inputs(switchOn: false)).isRun == false)
    }

    @Test func stopsWhenTheOwnerIsNotWatchingAnything() {
        #expect(StayAwake.decide(inputs(watched: 0, active: 0)) == .stop(.notWatching))
    }

    @Test func stopsWhenEveryWatchedTaskHasFinished() {
        #expect(StayAwake.decide(inputs(watched: 2, active: 0)) == .stop(.nothingRunning))
    }

    @Test func oneStillRunningIsEnough() {
        #expect(StayAwake.decide(inputs(watched: 3, active: 1)) == .run)
    }

    @Test func stopsOnLowPowerMode() {
        #expect(StayAwake.decide(inputs(lowPower: true)) == .stop(.lowPowerMode))
        // Plugged in does not override it: Low Power Mode is an explicit request to do less.
        #expect(StayAwake.decide(inputs(lowPower: true, plugged: true)) == .stop(.lowPowerMode))
    }

    @Test func stopsBelowTwentyPercentWhenUnplugged() {
        #expect(StayAwake.decide(inputs(battery: 0.19)) == .stop(.lowBattery))
        #expect(StayAwake.decide(inputs(battery: 0.05)) == .stop(.lowBattery))
    }

    @Test func twentyPercentOrMoreIsFine() {
        #expect(StayAwake.decide(inputs(battery: 0.20)) == .run)
    }

    @Test func lowBatteryDoesNotStopWhilePluggedIn() {
        #expect(StayAwake.decide(inputs(battery: 0.05, plugged: true)) == .run)
    }

    @Test func unknownBatteryIsNotLow() {
        #expect(StayAwake.decide(inputs(battery: nil)) == .run)
    }

    @Test func stopsAtTheThreeHourCap() {
        #expect(StayAwake.hardCap == 3 * 3600)
        #expect(StayAwake.decide(inputs(awakeFor: 3 * 3600 - 1)) == .run)
        #expect(StayAwake.decide(inputs(awakeFor: 3 * 3600)) == .stop(.hardCap))
    }

    @Test func doesNotStartAgainAfterTheCapWhileTheSameTasksRun() {
        #expect(StayAwake.decide(inputs(capLatched: true)) == .stop(.hardCap))
    }

    @Test func stopsWhenTheGatewayHasBeenUnreachableForTenMinutes() {
        #expect(StayAwake.unreachableLimit == 600)
        #expect(StayAwake.decide(inputs(unreachableFor: 599)) == .run)
        #expect(StayAwake.decide(inputs(unreachableFor: 600)) == .stop(.gatewayUnreachable))
    }

    @Test func theSwitchWinsOverEverythingElse() {
        let i = inputs(switchOn: false, watched: 0, active: 0, lowPower: true, battery: 0.01)
        #expect(StayAwake.decide(i) == .stop(.switchOff))
    }

    @Test func capAndUnreachableMarkTheActivityStaleAtOnce() {
        #expect(StayAwake.StopReason.hardCap.makesActivityStaleNow)
        #expect(StayAwake.StopReason.gatewayUnreachable.makesActivityStaleNow)
        #expect(!StayAwake.StopReason.lowPowerMode.makesActivityStaleNow)
        #expect(!StayAwake.StopReason.nothingRunning.makesActivityStaleNow)
    }

    @Test func nextWakeIsTheEarlierOfCapAndGatewayLimit() {
        #expect(StayAwake.nextWake(inputs()) == nil)  // not awake: nothing to sleep for
        let awake = inputs(awakeFor: 60)
        #expect(StayAwake.nextWake(awake) == t0.addingTimeInterval(-60 + 3 * 3600))
        let down = inputs(awakeFor: 60, unreachableFor: 120)
        #expect(StayAwake.nextWake(down) == t0.addingTimeInterval(-120 + 600))
    }
}

/// At most one Live Activity update every few seconds, and only when the content changed.
struct ActivityUpdateGateTests {
    private let gate = ActivityUpdateGate(minInterval: 5)
    private func content(step: Int = 1, status: TaskActivityStatus = .running, detail: String? = nil) -> TaskActivityContent {
        TaskActivityContent(step: step, stepCount: 4, status: status, startedAt: t0, detail: detail)
    }

    @Test func firstContentIsPushed() {
        #expect(gate.decide(old: nil, new: content(), lastPush: nil, staleDate: nil, awake: false, now: t0) == .push)
    }

    @Test func unchangedContentIsNeverPushed() {
        let c = content()
        #expect(gate.decide(old: c, new: c, lastPush: t0, staleDate: t0.addingTimeInterval(700), awake: true, now: t0.addingTimeInterval(60)) == .skip)
    }

    @Test func aChangeInsideTheIntervalWaitsForTheRest() {
        let d = gate.decide(
            old: content(step: 1), new: content(step: 2), lastPush: t0, staleDate: nil, awake: true,
            now: t0.addingTimeInterval(2))
        #expect(d == .wait(3))
    }

    @Test func aChangeAfterTheIntervalGoesThrough() {
        let d = gate.decide(
            old: content(step: 1), new: content(step: 2), lastPush: t0, staleDate: nil, awake: true,
            now: t0.addingTimeInterval(5))
        #expect(d == .push)
    }

    @Test func aChangeOfStatusGoesThroughAtOnce() {
        let d = gate.decide(
            old: content(), new: content(status: .needsApproval), lastPush: t0, staleDate: nil, awake: true,
            now: t0.addingTimeInterval(1))
        #expect(d == .push)
    }

    @Test func burstOfDetailChangesProducesOnePushPerInterval() {
        // Ten changes a second apart: pushes at 0, 5 and 10 seconds only, the rest wait.
        var last: Date? = nil
        var shown: TaskActivityContent? = nil
        var pushes = 0
        for second in 0...10 {
            let now = t0.addingTimeInterval(TimeInterval(second))
            let new = content(detail: "reading \(second) files")
            if gate.decide(old: shown, new: new, lastPush: last, staleDate: nil, awake: true, now: now) == .push {
                shown = new
                last = now
                pushes += 1
            }
        }
        #expect(pushes == 3)
    }

    @Test func anAwakeAppMovesTheStaleDateBeforeItPasses() {
        let c = content()
        let stale = t0.addingTimeInterval(ActivityFreshness.staleAfterAwake)
        let before = stale.addingTimeInterval(-ActivityFreshness.refreshLead - 1)
        let after = stale.addingTimeInterval(-ActivityFreshness.refreshLead)
        #expect(gate.decide(old: c, new: c, lastPush: t0, staleDate: stale, awake: true, now: before) == .skip)
        #expect(gate.decide(old: c, new: c, lastPush: t0, staleDate: stale, awake: true, now: after) == .refreshStale)
    }

    @Test func aSleepingAppNeverRefreshesTheStaleDate() {
        let c = content()
        let stale = t0.addingTimeInterval(ActivityFreshness.staleAfterAsleep)
        #expect(gate.decide(old: c, new: c, lastPush: t0, staleDate: stale, awake: false, now: stale) == .skip)
    }
}

/// What the island and the card say once iOS marks the activity stale.
struct ActivityFreshnessTests {
    private func content(
        status: TaskActivityStatus = .running, inline: String? = nil, estimatedEnd: Date? = nil, stepCount: Int = 4
    ) -> TaskActivityContent {
        TaskActivityContent(
            step: 2, stepCount: stepCount, status: status, startedAt: t0, asking: inline == nil ? nil : "Send it?",
            inlineApprovalID: inline, estimatedEnd: estimatedEnd)
    }

    @Test func staleDelaysAreShortAsleepAndLongerAwake() {
        #expect((2 * 60...5 * 60).contains(ActivityFreshness.staleAfterAsleep))
        #expect(ActivityFreshness.staleAfterAwake > ActivityFreshness.staleAfterAsleep)
        #expect(ActivityFreshness.staleDate(lastUpdate: t0, awake: false) == t0.addingTimeInterval(ActivityFreshness.staleAfterAsleep))
        #expect(ActivityFreshness.staleDate(lastUpdate: t0, awake: true) == t0.addingTimeInterval(ActivityFreshness.staleAfterAwake))
        // The refresh happens before the stale date, with room to spare.
        #expect(ActivityFreshness.refreshTime(forStaleDate: t0) < t0)
    }

    @Test func freshRunningShowsLiveStatus() {
        let p = ActivityPresentation(content: content(), isStale: false)
        #expect(!p.showsStaleNotice)
        #expect(!p.showsOpenLink)
    }

    @Test func staleRunningSaysMayBeOutOfDate() {
        #expect(ActivityPresentation(content: content(), isStale: true).showsStaleNotice)
    }

    @Test func freshPlainApprovalShowsApproveAndDeny() {
        let p = ActivityPresentation(content: content(status: .needsApproval, inline: "appr_1"), isStale: false)
        #expect(p.showsInlineAnswer)
        #expect(!p.showsOpenLink)
    }

    @Test func staleApprovalNeverShowsApproveOrDeny() {
        let p = ActivityPresentation(content: content(status: .needsApproval, inline: "appr_1"), isStale: true)
        #expect(!p.showsInlineAnswer)
        #expect(p.showsOpenLink)  // "Open Psyche": the app re-checks with the Gateway first
        #expect(p.showsStaleNotice)
    }

    @Test func presenceGatedApprovalAlwaysOnlyOpensTheApp() {
        let fresh = ActivityPresentation(content: content(status: .needsApproval), isStale: false)
        #expect(!fresh.showsInlineAnswer)
        #expect(fresh.showsOpenLink)
    }

    @Test func aFinishedActivityIsNeverCalledStale() {
        for status in [TaskActivityStatus.done, .failed] {
            let p = ActivityPresentation(content: content(status: status), isStale: true)
            #expect(!p.showsStaleNotice)
        }
    }

    @Test func progressIsOnlyEverWhatTheGatewayGave() {
        #expect(content(stepCount: 0).progressBasis == .elapsedOnly)
        #expect(content(stepCount: 4).progressBasis == .steps)
        let eta = content(estimatedEnd: t0.addingTimeInterval(600), stepCount: 4)
        #expect(eta.progressBasis == .estimate)
        #expect(eta.estimateRange == t0...t0.addingTimeInterval(600))
        // An end that is not after the start is not an estimate.
        #expect(content(estimatedEnd: t0).progressBasis == .steps)
        #expect(content(estimatedEnd: t0).estimateRange == nil)
    }

    @Test func noGatewayEtaMeansNoEstimateBar() {
        #expect(!ActivityPresentation(content: content(), isStale: false).showsEstimate)
    }

    @Test func anEstimateIsDrawnOnlyWhileFresh() {
        let eta = content(estimatedEnd: t0.addingTimeInterval(600))
        #expect(ActivityPresentation(content: eta, isStale: false).showsEstimate)
        #expect(!ActivityPresentation(content: eta, isStale: true).showsEstimate)
    }

    @Test func theLockScreenPrivacyRuleIsUnchanged() {
        var c = content()
        c.islandTitle = "Quarterly summary"
        c.detail = "Reading 12 files"
        #expect(c.lockScreenText(locked: true).title == nil)
        #expect(c.lockScreenText(locked: false).title == "Quarterly summary")
        c.title = "Quarterly summary"
        #expect(c.lockScreenText(locked: true).title == "Quarterly summary")
    }

    @Test func makingContentCarriesOnlyAGatewayEta() {
        let plain = RunningTask(id: "t", title: "T", step: 1, stepCount: 3, detail: "", elapsed: "1 min", startedAt: t0)
        #expect(TaskActivityContent.make(task: plain, status: .running, showTitle: false).estimatedEnd == nil)
        let eta = RunningTask(
            id: "t", title: "T", step: 1, stepCount: 3, detail: "", elapsed: "1 min", startedAt: t0,
            estimatedEnd: t0.addingTimeInterval(90))
        #expect(TaskActivityContent.make(task: eta, status: .running, showTitle: false).estimatedEnd == t0.addingTimeInterval(90))
        #expect(TaskActivityContent.make(task: eta, status: .running, showTitle: false).finished(failed: false).estimatedEnd == nil)
    }
}

/// "Kept awake 42 min today", kept on this phone per local day.
struct AwakeTimeLedgerTests {
    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }

    @Test func addsUpTheDay() async {
        let ledger = AwakeTimeLedger(directory: nil, calendar: utc)
        let noon = utc.date(from: DateComponents(year: 2026, month: 11, day: 5, hour: 12))!
        await ledger.record(from: noon, to: noon.addingTimeInterval(20 * 60))
        await ledger.record(from: noon.addingTimeInterval(3600), to: noon.addingTimeInterval(3600 + 22 * 60))
        #expect(await ledger.seconds(on: noon) == 42 * 60)
    }

    @Test func aStretchAcrossMidnightIsSplit() async {
        let ledger = AwakeTimeLedger(directory: nil, calendar: utc)
        let late = utc.date(from: DateComponents(year: 2026, month: 11, day: 5, hour: 23, minute: 50))!
        await ledger.record(from: late, to: late.addingTimeInterval(30 * 60))
        #expect(await ledger.seconds(on: late) == 10 * 60)
        #expect(await ledger.seconds(on: late.addingTimeInterval(3600)) == 20 * 60)
    }

    @Test func anotherDayStartsAtZero() async {
        let ledger = AwakeTimeLedger(directory: nil, calendar: utc)
        let noon = utc.date(from: DateComponents(year: 2026, month: 11, day: 5, hour: 12))!
        await ledger.record(from: noon, to: noon.addingTimeInterval(600))
        #expect(await ledger.seconds(on: noon.addingTimeInterval(86_400)) == 0)
    }

    @Test func survivesARestart() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("awake-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let noon = utc.date(from: DateComponents(year: 2026, month: 11, day: 5, hour: 12))!
        await AwakeTimeLedger(directory: dir, calendar: utc).record(from: noon, to: noon.addingTimeInterval(900))
        #expect(await AwakeTimeLedger(directory: dir, calendar: utc).seconds(on: noon) == 900)
    }

    @Test func settingDefaultsToOff() {
        #expect(PhoneSettings(notifications: true, liveActivities: true, taskTitlesOnLockScreen: false, faceIDForApprovals: true)
            .stayConnectedWhileRunning == false)
    }
}
