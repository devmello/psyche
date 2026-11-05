import Foundation
import PsycheShared
import PsycheStore
#if os(iOS)
import AVFoundation
import UIKit
#endif

// "Stay connected while a task runs". With no push (no paid developer account) a Live Activity can only move
// while Psyche runs, and iOS suspends an app shortly after it leaves the screen. While the owner has this on,
// a task they are watching is running, and nothing below says stop, Psyche holds one silent, mixable audio
// session open (the `audio` background mode) and keeps its one Gateway connection. That is all it does: no
// polling, no timers except one sleep until the next thing that could change the answer. The rules are
// `StayAwake.decide`; this file only carries them out.
//
// RELEASE BLOCKER FOR ANY STORE BUILD: a silent audio loop whose only purpose is to keep the app running breaks
// App Store Review Guideline 2.5.4 (background audio must be used for audible content). It is fine for a build
// the owner signs with a free Personal Team for their own phone. Remove `SystemSilentAudio`, `NoSilentAudio`
// wiring and `audio` from UIBackgroundModes before any TestFlight or App Store build (see apps/ios/README.md).

/// Who holds the audio session. Dictation takes it (record category); stay-awake gives it up while dictation runs
/// and takes it back afterwards. One owner at a time.
@MainActor
final class AudioSessionArbiter {
    static let shared = AudioSessionArbiter()
    private(set) var dictating = false
    private var observers: [@MainActor () -> Void] = []

    func observe(_ handler: @escaping @MainActor () -> Void) { observers.append(handler) }

    func setDictating(_ on: Bool) {
        guard on != dictating else { return }
        dictating = on
        for handler in observers { handler() }
    }
}

/// The silent audio session. A protocol so the controller is tested without AVFoundation.
@MainActor
protocol SilentAudio: AnyObject {
    var isPlaying: Bool { get }
    /// Starts the session and the silent loop. False if iOS refused (for one, when the app is not in front).
    func start() -> Bool
    /// Stops the loop but leaves the session alone: someone else (dictation) owns it now.
    func pause()
    /// Takes the session back (category included) and plays again after an interruption, a route change or a pause.
    func resume() -> Bool
    /// Stops the loop and deactivates the session only if this owns it.
    func stop()
    /// What happened outside the app's control; the controller decides what to do about it.
    var onEvent: (@MainActor (SilentAudioEvent) -> Void)? { get set }
}

enum SilentAudioEvent: Equatable, Sendable {
    /// A call, Siri or another app took the session.
    case interrupted
    case interruptionEnded
    /// Headphones or another output came or went.
    case routeChanged
    /// The audio system was reset underneath the app.
    case mediaServicesReset
}

struct DeviceSnapshot: Equatable, Sendable {
    var lowPowerMode: Bool
    var batteryLevel: Float?
    var pluggedIn: Bool
}

/// Low Power Mode and the battery, read when asked and reported when they change (never polled).
@MainActor
protocol DeviceConditions: AnyObject {
    func snapshot() -> DeviceSnapshot
    /// Battery notifications are costly to leave on: only while there is something to start or keep going for.
    func setMonitoring(_ on: Bool)
    var onChange: (@MainActor () -> Void)? { get set }
}

@MainActor
final class StayAwakeController {
    private let audio: any SilentAudio
    private let conditions: any DeviceConditions
    private let ledger: AwakeTimeLedger
    private let capStore: AwakeCapStore
    private let setKeepConnected: @MainActor (Bool) -> Void
    private let onStopped: @MainActor (StayAwake.StopReason) -> Void
    private let clock: @MainActor () -> Date
    private let arbiter: AudioSessionArbiter

    private(set) var isRunning = false
    /// Running, but the audio session is lent to dictation.
    private(set) var isPaused = false
    private var switchOn = false
    private var watched = 0
    private var activeIDs: Set<String> = []
    /// Set once the first task list has arrived: before that "no tasks" means "not known yet", and the saved
    /// budget must not be thrown away.
    private var tasksReported = false
    private var foreground = false
    private var unreachableSince: Date?
    /// The 3-hour budget used by the current work; persisted.
    private var record: AwakeCapRecord?
    /// The stretch in progress (nil while stopped or paused) and what the budget had used when it began.
    private var segmentStart: Date?
    private var usedAtSegmentStart: TimeInterval = 0
    private var wake: Task<Void, Never>?
    /// Ledger writes in order; `settled()` waits for the last.
    private var ledgerWrite: Task<Void, Never>?
    /// Why the last awake stretch ended; for tests.
    private(set) var lastStop: StayAwake.StopReason?

    init(
        audio: any SilentAudio, conditions: any DeviceConditions, ledger: AwakeTimeLedger,
        capStore: AwakeCapStore = AwakeCapStore(directory: nil),
        setKeepConnected: @escaping @MainActor (Bool) -> Void,
        onStopped: @escaping @MainActor (StayAwake.StopReason) -> Void,
        clock: @escaping @MainActor () -> Date = { .now }, arbiter: AudioSessionArbiter = .shared
    ) {
        self.arbiter = arbiter
        self.audio = audio
        self.conditions = conditions
        self.ledger = ledger
        self.capStore = capStore
        self.setKeepConnected = setKeepConnected
        self.onStopped = onStopped
        self.clock = clock
        record = capStore.load()
        conditions.onChange = { [weak self] in self?.reevaluate() }
        audio.onEvent = { [weak self] event in self?.handle(event) }
        arbiter.observe { [weak self] in self?.reevaluate() }
    }

    // MARK: Inputs

    func setSwitch(_ on: Bool) {
        guard on != switchOn else { return }
        switchOn = on
        reevaluate()
    }

    func setTasks(watched: Int, active: Set<String>) {
        guard watched != self.watched || active != activeIDs || !tasksReported else { return }
        tasksReported = true
        self.watched = watched
        activeIDs = active
        if isRunning { record?.ids.formUnion(active) }
        reevaluate()
    }

    /// Starting needs the app in front (iOS refuses to start audio from the background); keeping going does not.
    func setForeground(_ on: Bool) {
        guard on != foreground else { return }
        foreground = on
        reevaluate()
    }

    func setGateway(live: Bool) {
        if live {
            guard unreachableSince != nil else { return }
            unreachableSince = nil
        } else {
            guard unreachableSince == nil else { return }
            unreachableSince = clock()
        }
        reevaluate()
    }

    /// "Kept awake 42 min today": what was saved plus the stretch in progress (paused time is not counted).
    func secondsToday() async -> TimeInterval {
        let now = clock()
        await ledgerWrite?.value
        let saved = await ledger.seconds(on: now)
        guard let segmentStart else { return saved }
        return saved + max(0, now.timeIntervalSince(segmentStart))
    }

    /// Resolves once every ledger write started so far has been applied (tests).
    func settled() async { await ledgerWrite?.value }

    // MARK: Deciding

    private var capLatched: Bool { record?.capped == true }

    private func inputs(now: Date) -> StayAwake.Inputs {
        let device = conditions.snapshot()
        return StayAwake.Inputs(
            switchOn: switchOn, watched: watched, active: activeIDs.count, lowPowerMode: device.lowPowerMode,
            batteryLevel: device.batteryLevel, pluggedIn: device.pluggedIn,
            awakeSince: segmentStart.map { $0.addingTimeInterval(-usedAtSegmentStart) }, capLatched: capLatched,
            unreachableSince: unreachableSince, now: now)
    }

    func reevaluate() {
        let now = clock()
        // New work (an id the record has not seen), or none, frees the cap and the budget.
        if let record, tasksReported, activeIDs.isEmpty || !activeIDs.isSubset(of: record.ids), !isRunning {
            self.record = nil
            capStore.save(nil)
        }
        switch StayAwake.decide(inputs(now: now)) {
        case .run:
            if !isRunning {
                if foreground, !arbiter.dictating { begin(now: now) }
            } else if arbiter.dictating, !isPaused {
                pause(now: now)
            } else if !arbiter.dictating, isPaused {
                unpause(now: now)
            }
            if isRunning, !isPaused { scheduleWake(now: now) }
        case .stop(let reason):
            if isRunning { end(reason, now: now) }
        }
        conditions.setMonitoring(switchOn && watched > 0)
    }

    private func begin(now: Date) {
        guard audio.start() else { return }  // refused: stay off; the next change tries again
        isRunning = true
        isPaused = false
        lastStop = nil
        let continuing = record.map { !$0.capped && activeIDs.isSubset(of: $0.ids) } ?? false
        usedAtSegmentStart = continuing ? record?.used ?? 0 : 0
        record = AwakeCapRecord(ids: activeIDs.union(continuing ? record?.ids ?? [] : []), used: usedAtSegmentStart)
        capStore.save(record)
        segmentStart = now
        setKeepConnected(true)
    }

    /// Ends the stretch in progress: its time goes to the ledger and the budget.
    private func closeSegment(now: Date) {
        guard let start = segmentStart else { return }
        record?.used += max(0, now.timeIntervalSince(start))
        if let record { capStore.save(record) }
        segmentStart = nil
        let ledger = ledger
        ledgerWrite = Task { [previous = ledgerWrite] in
            await previous?.value
            await ledger.record(from: start, to: now)
        }
    }

    private func pause(now: Date) {
        wake?.cancel()
        wake = nil
        closeSegment(now: now)
        audio.pause()
        isPaused = true
    }

    private func unpause(now: Date) {
        guard audio.resume() else {
            end(.audioUnavailable, now: now)
            return
        }
        isPaused = false
        usedAtSegmentStart = record?.used ?? 0
        segmentStart = now
    }

    private func end(_ reason: StayAwake.StopReason, now: Date) {
        wake?.cancel()
        wake = nil
        closeSegment(now: now)
        audio.stop()
        setKeepConnected(false)
        isRunning = false
        isPaused = false
        lastStop = reason
        switch reason {
        case .hardCap:
            record?.capped = true
            capStore.save(record)
        case .nothingRunning, .notWatching, .switchOff:
            record = nil
            capStore.save(nil)
        case .lowPowerMode, .lowBattery, .gatewayUnreachable, .audioUnavailable:
            break  // the same work resumes on the same budget
        }
        onStopped(reason)
    }

    /// Sleeps until the next moment the answer could change by itself: the cap, the Gateway limit, or the next
    /// ledger checkpoint. One task at a time; nothing runs in between.
    private func scheduleWake(now: Date) {
        wake?.cancel()
        var next = segmentStart.map { $0.addingTimeInterval(StayAwake.checkpoint) }
        if let deadline = StayAwake.nextWake(inputs(now: now)) { next = min(next ?? deadline, deadline) }
        guard let next else { return }
        let delay = max(1, next.timeIntervalSince(now))
        wake = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.woke()
        }
    }

    private func woke() {
        let now = clock()
        if isRunning, !isPaused, let start = segmentStart, now.timeIntervalSince(start) >= StayAwake.checkpoint - 1 {
            // Checkpoint: save what has been used so a kill loses little.
            closeSegment(now: now)
            usedAtSegmentStart = record?.used ?? 0
            segmentStart = now
        }
        reevaluate()
    }

    // MARK: Audio events

    private func handle(_ event: SilentAudioEvent) {
        guard isRunning, !isPaused else { return }
        switch event {
        case .interrupted:
            break  // iOS paused it; nothing to do until it ends
        case .interruptionEnded, .routeChanged:
            // Resume only if still needed: the rules may have changed during a long call.
            reevaluate()
            if isRunning, !isPaused, !audio.isPlaying, !audio.resume() { end(.audioUnavailable, now: clock()) }
        case .mediaServicesReset:
            audio.stop()
            reevaluate()
            if isRunning, !isPaused, !audio.start() { end(.audioUnavailable, now: clock()) }
        }
    }
}

// MARK: - The real thing

#if os(iOS)
/// A tiny silent loop on a `.playback` + `.mixWithOthers` session: the owner's music is not interrupted, and
/// with no Now Playing info set and mixing on, nothing shows on the Lock Screen or in Control Center.
/// The buffer is two seconds of 16-bit mono zeros at 8 kHz (32 KB): the lightest source AVAudioPlayer will loop,
/// played at volume 0 as well. It cannot make a sound.
@MainActor
final class SystemSilentAudio: SilentAudio {
    private var player: AVAudioPlayer?
    private var observers: [any NSObjectProtocol] = []
    /// True while this holds the session: `stop()` deactivates it only then, so it never pulls the session out
    /// from under dictation.
    private var ownsSession = false
    var onEvent: (@MainActor (SilentAudioEvent) -> Void)?

    var isPlaying: Bool { player?.isPlaying ?? false }

    func start() -> Bool {
        guard activate() else { return false }
        do {
            let player = try AVAudioPlayer(data: Self.silence)
            player.numberOfLoops = -1
            player.volume = 0
            guard player.prepareToPlay(), player.play() else {
                release()
                return false
            }
            self.player = player
        } catch {
            release()
            return false
        }
        observe()
        return true
    }

    func pause() {
        player?.pause()
        ownsSession = false  // dictation has (or is about to take) the session
    }

    func resume() -> Bool {
        // Whoever had the session may have changed the category (dictation records): set ours again.
        guard activate() else { return false }
        if player == nil { return start() }
        return player?.play() ?? false
    }

    func stop() {
        player?.stop()
        player = nil
        for token in observers { NotificationCenter.default.removeObserver(token) }
        observers = []
        release()
    }

    private func activate() -> Bool {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
        } catch {
            return false
        }
        ownsSession = true
        return true
    }

    private func release() {
        guard ownsSession else { return }
        ownsSession = false
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    private func observe() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let type = raw.flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            MainActor.assumeIsolated {
                switch type {
                case .began: self?.onEvent?(.interrupted)
                case .ended: self?.onEvent?(.interruptionEnded)
                default: break
                }
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onEvent?(.routeChanged) }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onEvent?(.mediaServicesReset) }
        })
    }

    /// RIFF/WAVE, PCM, 8 kHz, mono, 16 bit, two seconds of zeros.
    static let silence: Data = {
        let rate: UInt32 = 8000
        let samples = Int(rate) * 2
        let dataBytes = UInt32(samples * 2)
        var d = Data()
        func put32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func put16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append(contentsOf: Array("RIFF".utf8)); put32(36 + dataBytes)
        d.append(contentsOf: Array("WAVE".utf8)); d.append(contentsOf: Array("fmt ".utf8))
        put32(16); put16(1); put16(1); put32(rate); put32(rate * 2); put16(2); put16(16)
        d.append(contentsOf: Array("data".utf8)); put32(dataBytes)
        d.append(Data(count: Int(dataBytes)))
        return d
    }()
}

/// Low Power Mode and battery from the system, reported on change. Battery monitoring is on only while the
/// controller asks for it (the switch is on and something is being watched).
@MainActor
final class SystemDeviceConditions: DeviceConditions {
    var onChange: (@MainActor () -> Void)?
    private var observers: [any NSObjectProtocol] = []

    init() {
        let center = NotificationCenter.default
        let fire: @Sendable (Notification) -> Void = { [weak self] _ in
            Task { @MainActor in self?.onChange?() }
        }
        observers = [
            center.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main, using: fire),
            center.addObserver(forName: UIDevice.batteryLevelDidChangeNotification, object: nil, queue: .main, using: fire),
            center.addObserver(forName: UIDevice.batteryStateDidChangeNotification, object: nil, queue: .main, using: fire),
        ]
    }

    func setMonitoring(_ on: Bool) {
        let device = UIDevice.current
        if device.isBatteryMonitoringEnabled != on { device.isBatteryMonitoringEnabled = on }
    }

    func snapshot() -> DeviceSnapshot {
        let device = UIDevice.current
        let level = device.isBatteryMonitoringEnabled ? device.batteryLevel : -1  // -1 when unknown (or not monitoring)
        let plugged = device.batteryState == .charging || device.batteryState == .full
        return DeviceSnapshot(
            lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled, batteryLevel: level < 0 ? nil : level,
            pluggedIn: plugged)
    }
}
#endif

/// Where there is no AVFoundation (macOS test runs) and in fixture mode: never plays.
@MainActor
final class NoSilentAudio: SilentAudio {
    var isPlaying: Bool { false }
    var onEvent: (@MainActor (SilentAudioEvent) -> Void)?
    func start() -> Bool { false }
    func pause() {}
    func resume() -> Bool { false }
    func stop() {}
}

@MainActor
final class NoDeviceConditions: DeviceConditions {
    var onChange: (@MainActor () -> Void)?
    func snapshot() -> DeviceSnapshot { DeviceSnapshot(lowPowerMode: false, batteryLevel: nil, pluggedIn: true) }
    func setMonitoring(_ on: Bool) {}
}
