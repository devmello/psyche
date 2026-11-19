import Foundation
import PsycheHelperCore
import Testing

private final class FakeGate: KeyDownGate, @unchecked Sendable {
    private let lock = NSLock()
    private var calls: [Bool] = []
    var history: [Bool] { lock.withLock { calls } }
    func setEnabled(_ on: Bool) { lock.withLock { calls.append(on) } }
}

@Suite("dictation keyDown tap gate (R2)")
struct DictationKeyEngineTests {
    private let fn: Int64 = 63
    private let fnMask: UInt64 = 0x0080_0000

    private func engine(_ gate: FakeGate) -> DictationKeyEngine {
        DictationKeyEngine([DictationWatchedKey(key: .fn)], gate: gate)
    }

    @Test func theKeystrokeListenerStaysOffUntilAWatchedKeyIsHeld() {
        let gate = FakeGate()
        _ = engine(gate)
        #expect(gate.history.isEmpty)  // never enabled by merely arming
    }

    @Test func holdEnablesAndReleaseDisables() {
        let gate = FakeGate()
        let e = engine(gate)
        #expect(e.flagsChanged(keyCode: fn, flags: fnMask).map(\.down) == [true])
        #expect(gate.history == [true])
        #expect(e.flagsChanged(keyCode: fn, flags: 0).map(\.down) == [false])
        #expect(gate.history == [true, false])
    }

    @Test func aChordEndsTheHoldAndSwitchesTheListenerOff() {
        let gate = FakeGate()
        let e = engine(gate)
        _ = e.flagsChanged(keyCode: fn, flags: fnMask)
        #expect(e.keyDown().map(\.down) == [false])  // fn+arrow: not dictation
        #expect(gate.history == [true, false])
        #expect(e.flagsChanged(keyCode: fn, flags: 0).isEmpty)  // the release is swallowed
        #expect(gate.history == [true, false])
    }

    @Test func otherModifiersAndStrayKeysDoNotTouchTheGate() {
        let gate = FakeGate()
        let e = engine(gate)
        #expect(e.flagsChanged(keyCode: 56, flags: 0x20102).isEmpty)  // shift
        #expect(e.keyDown().isEmpty)
        #expect(gate.history.isEmpty)
    }

    @Test func twoKeysKeepTheListenerOnUntilBothAreUp() {
        let gate = FakeGate()
        let e = DictationKeyEngine(
            [DictationWatchedKey(key: .fn, role: .dictation), DictationWatchedKey(key: .rightOption, role: .voice)], gate: gate)
        _ = e.flagsChanged(keyCode: 63, flags: 0x0080_0000)
        _ = e.flagsChanged(keyCode: 61, flags: 0x0080_0040)
        #expect(gate.history == [true])
        _ = e.flagsChanged(keyCode: 63, flags: 0x40)
        #expect(gate.history == [true])  // right option still down
        _ = e.flagsChanged(keyCode: 61, flags: 0)
        #expect(gate.history == [true, false])
    }

    // Review 1402 #3: a keyDown the tap missed (enabled from another thread) still ends the hold as a chord.
    private final class Clock: @unchecked Sendable {
        var now = Date(timeIntervalSince1970: 5_000_000)
        var lastKeyDown: Date?
        var age: TimeInterval { lastKeyDown.map { now.timeIntervalSince($0) } ?? .infinity }
    }

    private func clocked(_ gate: FakeGate, _ clock: Clock) -> DictationKeyEngine {
        DictationKeyEngine(
            [DictationWatchedKey(key: .fn)], gate: gate, lastKeyDownAge: { clock.age }, now: { clock.now })
    }

    @Test func aKeyDownTheTapMissedIsAChordOnRecheck() {
        let gate = FakeGate()
        let clock = Clock()
        let e = clocked(gate, clock)
        _ = e.flagsChanged(keyCode: fn, flags: fnMask)
        clock.now += 0.03
        clock.lastKeyDown = clock.now  // fn+arrow struck inside the enable lag
        clock.now += 0.07
        #expect(e.recheckChord().map(\.down) == [false])
        #expect(gate.history == [true, false])
        #expect(e.flagsChanged(keyCode: fn, flags: 0).isEmpty)  // the release adds nothing
    }

    @Test func aKeyDownTheTapMissedIsAChordOnRelease() {
        let gate = FakeGate()
        let clock = Clock()
        let e = clocked(gate, clock)
        _ = e.flagsChanged(keyCode: fn, flags: fnMask)
        clock.now += 0.02
        clock.lastKeyDown = clock.now
        clock.now += 0.5
        // Release: one chord-end event, never a plain release after a held key.
        #expect(e.flagsChanged(keyCode: fn, flags: 0).map(\.down) == [false])
    }

    @Test func aKeyDownBeforeTheHoldIsNotACord() {
        let gate = FakeGate()
        let clock = Clock()
        clock.lastKeyDown = clock.now  // typing right before fn went down
        clock.now += 0.2
        let e = clocked(gate, clock)
        _ = e.flagsChanged(keyCode: fn, flags: fnMask)
        clock.now += 0.4
        #expect(e.recheckChord().isEmpty)
        #expect(e.flagsChanged(keyCode: fn, flags: 0).map(\.down) == [false])
        #expect(gate.history == [true, false])
    }

    @Test func theEngineDoesNotKeepItsGateAlive() {
        var gate: FakeGate? = FakeGate()
        weak var weakGate = gate
        let e = DictationKeyEngine([DictationWatchedKey(key: .fn)], gate: gate!)
        gate = nil
        #expect(weakGate == nil)
        _ = e.flagsChanged(keyCode: fn, flags: fnMask)  // no crash with the gate gone
    }
}
