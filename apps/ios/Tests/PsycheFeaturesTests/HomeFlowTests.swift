import Testing

@testable import PsycheFeatures
@testable import PsycheStore

@MainActor
struct HomeFlowTests {
    // MARK: Route(appPath:)

    @Test func mapsDesktopRoutes() {
        #expect(Route(appPath: "/chat/thr_q3") == .thread(id: "thr_q3"))
        #expect(Route(appPath: "/goals/p1") == .project(id: "p1"))
        #expect(Route(appPath: "/people/pe2") == .person(id: "pe2"))
        #expect(Route(appPath: "/library/lib_77c1") == .file(id: "lib_77c1"))
        #expect(Route(appPath: "/inbox") == .inbox)
        #expect(Route(appPath: "/scheduled") == .scheduled)
        #expect(Route(appPath: "/overview") == .overview)
        #expect(Route(appPath: "/overview/run/run_9") == .overview)
        #expect(Route(appPath: "/chat/thr_q3?focus=composer#top") == .thread(id: "thr_q3"))
    }

    @Test func unknownRoutesAreNil() {
        #expect(Route(appPath: "") == nil)
        #expect(Route(appPath: "/") == nil)
        #expect(Route(appPath: "/home") == nil)
        #expect(Route(appPath: "/chat") == nil)
        #expect(Route(appPath: "/settings/models") == nil)
    }

    // MARK: AnswerFlow

    private struct StubPresence: PresenceCheck {
        var result: PresenceResult
        func confirm(reason: String) async -> PresenceResult { result }
    }

    @Test func allowAsksForPresenceFirstAndAnswers() async {
        let flow = AnswerFlow()
        await flow.run(presence: StubPresence(result: .confirmed), reason: "Allow", confirmation: "Allowed.") { }
        #expect(flow.stage == .answered("Allowed."))
        #expect(flow.answeredCount == 1)
    }

    @Test func cancellingFaceIDSendsNothing() async {
        let flow = AnswerFlow()
        let sent = Counter()
        await flow.run(presence: StubPresence(result: .cancelled), reason: "Allow", confirmation: "x") { await sent.bump() }
        #expect(flow.stage == .review)
        #expect(await sent.value == 0)
    }

    @Test func noPasscodeFailsClosedWithAMessage() async {
        let flow = AnswerFlow()
        let sent = Counter()
        await flow.run(presence: StubPresence(result: .unavailable("Set a passcode.")), reason: "Allow", confirmation: "x") {
            await sent.bump()
        }
        #expect(flow.stage == .failed("Set a passcode."))
        #expect(await sent.value == 0)
    }

    @Test func gatewayErrorShowsItsMessageAndTryAgainRuns() async {
        let flow = AnswerFlow()
        let attempts = Counter()
        await flow.run(confirmation: "Sent.") {
            if await attempts.bump() == 1 { throw BackendError.refused("That approval expired.") }
        }
        #expect(flow.stage == .failed("That approval expired."))
        await flow.retry()
        #expect(flow.stage == .answered("Sent."))
        #expect(await attempts.value == 2)
    }

    @Test func anAnswerAgainstTheFixtureLandsOnce() async throws {
        let store = FixtureBackend()
        let flow = AnswerFlow()
        await flow.run(confirmation: "Allowed.") { try await store.answerApproval(id: "appr_electric", decision: .allow) }
        #expect(flow.stage == .answered("Allowed."))
        #expect(try await store.home().needsYou.allSatisfy { $0.id != "appr_electric" })
    }

    private actor Counter {
        private(set) var value = 0
        @discardableResult func bump() -> Int {
            value += 1
            return value
        }
    }
}
