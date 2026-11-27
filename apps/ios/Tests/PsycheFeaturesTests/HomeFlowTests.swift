import Testing

@testable import PsycheFeatures
@testable import PsycheStore

@MainActor
struct HomeFlowTests {
    // MARK: Route(appPath:)

    @Test func mapsDesktopRoutes() {
        #expect(Route(appPath: "/chat/thr_q3") == .thread(id: "thr_q3"))
        #expect(Route(appPath: "/goals/p1") == nil)  // Goals are not on the phone
        #expect(Route(appPath: "/people/pe2") == .person(id: "pe2"))
        #expect(Route(appPath: "/library/lib_77c1") == .file(id: "lib_77c1"))
        #expect(Route(appPath: "/inbox") == .inbox)
        #expect(Route(appPath: "/scheduled") == .scheduled)
        #expect(Route(appPath: "/overview") == .scheduled)
        #expect(Route(appPath: "/overview/run/run_9") == .scheduled)
        #expect(Route(appPath: "/chat/thr_q3?focus=composer#top") == .thread(id: "thr_q3"))
    }

    @Test func unknownRoutesAreNil() {
        #expect(Route(appPath: "") == nil)
        #expect(Route(appPath: "/") == nil)
        #expect(Route(appPath: "/home/instructions") == nil)
        #expect(Route(appPath: "/onboarding") == nil)
        #expect(Route(appPath: "/can-do") == nil)
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

    /// Counts every Face ID request.
    private final class RecordingPresence: PresenceCheck, @unchecked Sendable {
        private(set) var asked = 0
        func confirm(reason: String) async -> PresenceResult {
            asked += 1
            return .confirmed
        }
    }

    private func detail(presenceNote: String?, needsMac: Bool) -> ApprovalDetail {
        ApprovalDetail(
            kindLabel: "Install a skill", title: "Run a script", summary: "", fields: [], evidence: [],
            alsoSentTo: "Also sent to your Mac", presenceNote: presenceNote, allowLabel: "Allow once",
            needsMac: needsMac)
    }

    @Test func aNeedsMacCardNeverAsksForPresenceAndSendsNoAllow() async {
        let presence = RecordingPresence()
        let sent = Counter()
        // Even with a stray presence note, a needs-Mac card never calls the presence check.
        for note in [nil, "Payments need Face ID on this phone."] as [String?] {
            let flow = AnswerFlow()
            await flow.answer(.allow, on: detail(presenceNote: note, needsMac: true), presence: presence, confirmation: "x") {
                await sent.bump()
            }
            #expect(flow.stage == .failed(AnswerFlow.needsMacMessage))
            let denied = AnswerFlow()
            await denied.answer(.deny, on: detail(presenceNote: note, needsMac: true), presence: presence, confirmation: "Denied.") {
                await sent.bump()
            }
            #expect(denied.stage == .answered("Denied."))
        }
        #expect(presence.asked == 0)
        #expect(await sent.value == 2)
    }

    @Test func aCardThePhoneHoldsNoAnswerForSendsNoDeny() async {
        let presence = RecordingPresence()
        let sent = Counter()
        let card = ApprovalDetail(
            kindLabel: "Purchase", title: "Pay $5", summary: "", fields: [], evidence: [],
            alsoSentTo: "Also sent to your Mac", presenceNote: nil, allowLabel: "Allow once",
            needsMac: true, canDeny: false)
        for decision in [ApprovalDecision.allow, .deny] {
            let flow = AnswerFlow()
            await flow.answer(decision, on: card, presence: presence, confirmation: "x") { await sent.bump() }
            #expect(flow.stage == .failed(AnswerFlow.needsMacMessage))
        }
        #expect(presence.asked == 0)
        #expect(await sent.value == 0)
    }

    @Test func onlyAPaymentThePhoneAnswersAsksForPresence() async {
        let presence = RecordingPresence()
        let tap = AnswerFlow()
        await tap.answer(.allow, on: detail(presenceNote: nil, needsMac: false), presence: presence, confirmation: "Allowed.") { }
        #expect(tap.stage == .answered("Allowed."))
        #expect(presence.asked == 0)
        let payment = AnswerFlow()
        await payment.answer(
            .allow, on: detail(presenceNote: "Payments need Face ID on this phone.", needsMac: false), presence: presence,
            confirmation: "Allowed.") { }
        #expect(payment.stage == .answered("Allowed."))
        #expect(presence.asked == 1)
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
