import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import PsycheProtocol
import Testing

/// Psyche points and computer use never run together (docs/design/psyche-points-2026.md §4.3 item 4):
/// while a Points session runs, every computer action is refused with `conflict/points_active`.
@Suite("Points excludes computer use")
struct PointsExclusionTests {
    private func ctx(_ capability: String, _ params: JSONValue) -> InvocationContext {
        InvocationContext(invocationId: "inv-1", capability: capability, params: params, approvalId: nil, emit: { _ in })
    }

    @Test func computerActionsAreRefusedWhileASessionRuns() throws {
        let cu = makeComputerUse(installer: FakeTapInstaller())
        let activity = PointsActivity()
        cu.isPointing = { activity.isActive }
        // Positive control: with no session the lock is taken.
        try cu.beginAction(session: "run-1")
        cu.sessions.release("run-1")
        #expect(activity.begin("points-1"))
        do {
            try cu.beginAction(session: "run-2")
            Issue.record("computer use must wait while points runs")
        } catch let e as CapabilityError {
            #expect(e.reason == "points_active" && e.code == .conflict)
        }
        #expect(cu.sessions.activeSession == nil, "a refused action takes no session")
        activity.end("points-1")
        try cu.beginAction(session: "run-3")
    }

    @Test func mutatingComputerCapabilitiesAreRefused() async throws {
        let cu = makeComputerUse(installer: FakeTapInstaller())
        let activity = PointsActivity()
        cu.isPointing = { activity.isActive }
        #expect(activity.begin("points-1"))
        let handlers = ComputerCapabilities.make(cu).filter { $0.spec.sideEffect != .read && $0.spec.sideEffect != .none }
        #expect(handlers.count >= 6)
        var refused: [String] = []
        for h in handlers {
            do {
                _ = try await h.invoke(ctx(h.spec.name, ["session": "run-9", "keys": "a", "text": "a", "x": 1, "y": 1]))
            } catch let e as CapabilityError where e.reason == "points_active" {
                refused.append(h.spec.name)
            } catch {
                // Another refusal first (a bad parameter) is not the exclusion: only the ones above count.
            }
        }
        #expect(refused.contains("computer.key") && refused.contains("computer.type"), "refused: \(refused)")
        #expect(cu.sessions.activeSession == nil)
    }

    @Test func theRuntimeWiresPointsActivityIntoComputerUse() throws {
        // `HelperRuntime` sets `computer.isPointing` from `PointsActivity.shared`; the source says so.
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let src = try String(contentsOf: dir.appendingPathComponent("Sources/PsycheHelperSystem/HelperRuntime.swift"), encoding: .utf8)
        #expect(src.contains("computer.isPointing = { PointsActivity.shared.isActive }"))
    }
}
