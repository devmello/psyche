import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import PsycheProtocol
import Testing

@Suite("permissions.request automation (#549)")
struct AutomationRequestTests {
    private final class Fake: @unchecked Sendable {
        let lock = NSLock()
        var states: [AutomationPermission.State]
        var launched: [String] = []
        init(_ states: [AutomationPermission.State]) { self.states = states }
        func next() -> AutomationPermission.State { lock.withLock { states.count > 1 ? states.removeFirst() : states[0] } }
    }

    @Test func notRunningTargetsAreLaunchedThenAsked() async throws {
        let f = Fake([.notRunning, .granted])
        let r = try await AutomationRequest.run(target: "com.apple.mail", ask: { _ in f.next() }, launch: { id in f.lock.withLock { f.launched.append(id) } })
        #expect(r.state == .granted && r.launched && f.launched == ["com.apple.mail"])
    }

    @Test func runningTargetsAreAskedOnceAndFailuresPropagate() async throws {
        for s in [AutomationPermission.State.granted, .denied, .notDetermined] {
            let f = Fake([s])
            let r = try await AutomationRequest.run(target: "com.apple.Notes", ask: { _ in f.next() }, launch: { _ in Issue.record("no launch for \(s)") })
            #expect(r.state == s && !r.launched)
        }
        let missing = Fake([.notRunning])
        await #expect(throws: CapabilityError.self) {
            _ = try await AutomationRequest.run(target: "com.example.none", ask: { _ in missing.next() }, launch: { _ in
                throw CapabilityError(.notFound, reason: "app_not_installed", "not installed")
            })
        }
    }
}
