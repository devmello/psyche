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
}
