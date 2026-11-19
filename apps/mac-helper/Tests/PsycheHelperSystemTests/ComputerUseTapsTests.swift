import CoreGraphics
import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import Testing

/// A tap installer that records instead of calling the system: no real tap, no Accessibility prompt.
final class FakeTapInstaller: SessionTapInstaller, @unchecked Sendable {
    final class Handle: SessionTapHandle, @unchecked Sendable {
        let kind: SessionTapKind
        let owner: FakeTapInstaller
        init(_ kind: SessionTapKind, _ owner: FakeTapInstaller) {
            self.kind = kind
            self.owner = owner
        }
        func remove() { owner.add("remove \(kind) held=\(owner.activeSession() ?? "none")") }
    }

    private let lock = NSLock()
    private var events: [String] = []
    var escWorks = true
    var activeSession: @Sendable () -> String? = { nil }
    var log: [String] { lock.withLock { events } }

    func add(_ s: String) { lock.withLock { events.append(s) } }

    func install(_ kind: SessionTapKind) -> (any SessionTapHandle)? {
        if kind == .escStop, !escWorks { add("install esc FAILED"); return nil }
        add("install \(kind) held=\(activeSession() ?? "none")")
        return Handle(kind, self)
    }
}

/// A scheduler that never fires: these tests drive teardown by hand.
let neverFires: SessionTapScheduler = { _, _ in {} }

func makeComputerUse(installer: FakeTapInstaller) -> ComputerUse {
    let cu = ComputerUse(environment: [:], log: HelperLog(echo: { _ in }), tapInstaller: installer, schedule: neverFires)
    installer.activeSession = { [sessions = cu.sessions] in sessions.activeSession }
    return cu
}

@Suite("computer use installs its taps per session (R2)")
struct ComputerUseTapsTests {
    @Test func noTapExistsBeforeTheFirstAction() {
        let installer = FakeTapInstaller()
        _ = makeComputerUse(installer: installer)
        #expect(installer.log.isEmpty)
    }

    @Test func beginActionInstallsTheEscStopBeforeTheLockIsTaken() throws {
        let installer = FakeTapInstaller()
        let cu = makeComputerUse(installer: installer)
        try cu.beginAction(session: "run-1")
        #expect(installer.log.first == "install escStop held=none")
        #expect(cu.sessions.activeSession == "run-1")
    }

    @Test func withoutTheEscStopNoActionRuns() {
        let installer = FakeTapInstaller()
        installer.escWorks = false
        let cu = makeComputerUse(installer: installer)
        #expect(throws: CapabilityError.self) { try cu.beginAction(session: "run-1") }
        #expect(cu.sessions.activeSession == nil)
    }

    @Test func endingTheSessionRemovesTheTapsAfterTheLockIsReleased() throws {
        let installer = FakeTapInstaller()
        let cu = makeComputerUse(installer: installer)
        try cu.beginAction(session: "run-1")
        cu.taps.release("run-1")
        #expect(installer.log.suffix(2) == ["remove escStop held=none", "remove attention held=none"])
    }

    @Test func escThroughTheComputerUseRemovesTheTapsToo() throws {
        let installer = FakeTapInstaller()
        let cu = makeComputerUse(installer: installer)
        try cu.beginAction(session: "run-1")
        #expect(cu.taps.stopActive() == "run-1")
        #expect(installer.log.suffix(2) == ["remove escStop held=none", "remove attention held=none"])
        #expect(throws: CapabilityError.self) { try cu.beginAction(session: "run-1") }  // the stopped run cannot carry on
    }
}

@Suite("Esc stop key filter")
struct EscStopFilterTests {
    private let marker = Input.marker

    @Test func onlyABareOwnerEscIsConsumed() {
        #expect(EscStopTap.isOwnerEsc(keyCode: 53, flags: [], userData: 0))
        #expect(EscStopTap.isOwnerEsc(keyCode: 53, flags: [.maskAlphaShift, .maskNonCoalesced], userData: 0))
    }

    @Test func nearMissesPassThrough() {
        #expect(!EscStopTap.isOwnerEsc(keyCode: 53, flags: [], userData: marker))  // the helper's own Esc
        #expect(!EscStopTap.isOwnerEsc(keyCode: 36, flags: [], userData: 0))  // Return
        for flag in [CGEventFlags.maskCommand, .maskShift, .maskAlternate, .maskControl] {
            #expect(!EscStopTap.isOwnerEsc(keyCode: 53, flags: flag, userData: 0))
        }
    }
}
