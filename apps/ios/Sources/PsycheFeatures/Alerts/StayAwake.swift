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

/// The silent audio session. A protocol so the controller is tested without AVFoundation.
@MainActor
protocol SilentAudio: AnyObject {
    var isPlaying: Bool { get }
    /// Starts the session and the silent loop. False if iOS refused (for one, when the app is not in front).
    func start() -> Bool
    /// Plays again after an interruption or a route change stopped it.
    func resume() -> Bool
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
    var onChange: (@MainActor () -> Void)? { get set }
}

@MainActor
final class StayAwakeController {
    private let audio: any SilentAudio
    private let conditions: any DeviceConditions
    private let ledger: AwakeTimeLedger
    private let setKeepConnected: @MainActor (Bool) -> Void
    private let onStopped: @MainActor (StayAwake.StopReason) -> Void
    private let clock: @MainActor () -> Date

    private(set) var isRunning = false
    private var switchOn = false
    private var watched = 0
    private var active = 0
    private var unreachableSince: Date?
    private var capLatched = false
    private var awakeSince: Date?
    private var checkpointAt: Date?
    private var wake: Task<Void, Never>?
    /// Why the last awake stretch ended; for tests and for Settings' footnote.
    private(set) var lastStop: StayAwake.StopReason?

    init(
        audio: any SilentAudio, conditions: any DeviceConditions, ledger: AwakeTimeLedger,
        setKeepConnected: @escaping @MainActor (Bool) -> Void,
        onStopped: @escaping @MainActor (StayAwake.StopReason) -> Void,
        clock: @escaping @MainActor () -> Date = { .now }
    ) {
        self.audio = audio
        self.conditions = conditions
        self.ledger = ledger
        self.setKeepConnected = setKeepConnected
        self.onStopped = onStopped
        self.clock = clock
        conditions.onChange = { [weak self] in self?.reevaluate() }
        audio.onEvent = { [weak self] event in self?.handle(event) }
    }

    // MARK: Inputs

    func setSwitch(_ on: Bool) {
        guard on != switchOn else { return }
        switchOn = on
        reevaluate()
    }

    func setTasks(watched: Int, active: Int) {
        guard watched != self.watched || active != self.active else { return }
        self.watched = watched
        self.active = active
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

    /// "Kept awake 42 min today": what was saved plus the stretch in progress.
    func secondsToday() async -> TimeInterval {
        let now = clock()
        let saved = await ledger.seconds(on: now)
        guard isRunning, let checkpointAt else { return saved }
        return saved + max(0, now.timeIntervalSince(checkpointAt))
    }

    // MARK: Deciding

    private func inputs(now: Date) -> StayAwake.Inputs {
        let device = conditions.snapshot()
        return StayAwake.Inputs(
            switchOn: switchOn, watched: watched, active: active, lowPowerMode: device.lowPowerMode,
            batteryLevel: device.batteryLevel, pluggedIn: device.pluggedIn, awakeSince: awakeSince,
            capLatched: capLatched, unreachableSince: unreachableSince, now: now)
    }

    func reevaluate() {
        let now = clock()
        // The cap holds for as long as the same work is still running; new work (or none) starts fresh.
        if active == 0 || !switchOn { capLatched = false }
        switch StayAwake.decide(inputs(now: now)) {
        case .run:
            if !isRunning { begin(now: now) }
            scheduleWake(now: now)
        case .stop(let reason):
            if isRunning { end(reason, now: now) }
        }
    }

    private func begin(now: Date) {
        guard audio.start() else { return }  // refused: stay off; the next change tries again
        isRunning = true
        awakeSince = now
        checkpointAt = now
        lastStop = nil
        setKeepConnected(true)
    }

    private func end(_ reason: StayAwake.StopReason, now: Date) {
        wake?.cancel()
        wake = nil
        audio.stop()
        setKeepConnected(false)
        if let checkpointAt { let ledger = ledger; Task { await ledger.record(from: checkpointAt, to: now) } }
        isRunning = false
        awakeSince = nil
        checkpointAt = nil
        lastStop = reason
        if reason == .hardCap { capLatched = true }
        onStopped(reason)
    }

    /// Sleeps until the next moment the answer could change by itself: the cap, the Gateway limit, or the next
    /// ledger checkpoint. One task at a time; nothing runs in between.
    private func scheduleWake(now: Date) {
        wake?.cancel()
        var next = checkpointAt.map { $0.addingTimeInterval(StayAwake.checkpoint) }
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
        if isRunning, let checkpointAt, now.timeIntervalSince(checkpointAt) >= StayAwake.checkpoint - 1 {
            let ledger = ledger
            Task { await ledger.record(from: checkpointAt, to: now) }
            self.checkpointAt = now
        }
        reevaluate()
    }

    // MARK: Audio events

    private func handle(_ event: SilentAudioEvent) {
        guard isRunning else { return }
        switch event {
        case .interrupted:
            break  // iOS paused it; nothing to do until it ends
        case .interruptionEnded, .routeChanged:
            // Resume only if still needed: the rules may have changed during a long call.
            reevaluate()
            if isRunning, !audio.isPlaying, !audio.resume() { end(.nothingRunning, now: clock()) }
        case .mediaServicesReset:
            audio.stop()
            reevaluate()
            if isRunning, !audio.start() { end(.nothingRunning, now: clock()) }
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
    var onEvent: (@MainActor (SilentAudioEvent) -> Void)?

    var isPlaying: Bool { player?.isPlaying ?? false }

    func start() -> Bool {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
            let player = try AVAudioPlayer(data: Self.silence)
            player.numberOfLoops = -1
            player.volume = 0
            guard player.prepareToPlay(), player.play() else { return false }
            self.player = player
        } catch {
            return false
        }
        observe()
        return true
    }

    func resume() -> Bool {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setActive(true)
        } catch {
            return false
        }
        return player?.play() ?? false
    }

    func stop() {
        player?.stop()
        player = nil
        for token in observers { NotificationCenter.default.removeObserver(token) }
        observers = []
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

/// Low Power Mode and battery from the system, reported on change. Battery monitoring is switched on only while
/// the controller has asked (`snapshot()` is called) and costs one notification per percent.
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

    func snapshot() -> DeviceSnapshot {
        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        let level = device.batteryLevel  // -1 when unknown (the simulator)
        let plugged = device.batteryState == .charging || device.batteryState == .full
        return DeviceSnapshot(
            lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled, batteryLevel: level < 0 ? nil : level,
            pluggedIn: plugged)
    }
}
#endif

/// Where there is no AVFoundation (macOS test runs): never plays.
@MainActor
final class NoSilentAudio: SilentAudio {
    var isPlaying: Bool { false }
    var onEvent: (@MainActor (SilentAudioEvent) -> Void)?
    func start() -> Bool { false }
    func resume() -> Bool { false }
    func stop() {}
}

@MainActor
final class NoDeviceConditions: DeviceConditions {
    var onChange: (@MainActor () -> Void)?
    func snapshot() -> DeviceSnapshot { DeviceSnapshot(lowPowerMode: false, batteryLevel: nil, pluggedIn: true) }
}
