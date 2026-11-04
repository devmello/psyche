import Foundation

/// Home's fixture state. Answering removes the item, as the Gateway does.
struct HomeState: Sendable {
    var snapshot = FixtureData.home
    var inbox = FixtureData.inbox
}

extension FixtureBackend: HomeBackend {
    public func home() async throws -> HomeSnapshot {
        await pause()
        return homeState.snapshot
    }

    public func answerApproval(id: String, decision: ApprovalDecision) async throws {
        guard homeState.snapshot.needsYou.contains(where: { $0.id == id }) else { throw BackendError.notFound }
        homeState.snapshot.needsYou.removeAll { $0.id == id }
        publish(.changed(.home))
        publish(.changed(.activity))
    }

    public func answerQuestion(id: String, answer: QuestionAnswer) async throws {
        homeState.snapshot.needsYou.removeAll { $0.id == id }
        publish(.changed(.home))
        publish(.changed(.activity))
    }

    public func actOnNudge(id: String, action: NudgeAction) async throws {
        homeState.snapshot.keepInTouch.removeAll { $0.id == id }
        publish(.changed(.home))
    }

    public func inbox() async throws -> [InboxItem] {
        await pause()
        return homeState.inbox
    }

    public func markRead(ids: [String]) async throws {
        for index in homeState.inbox.indices where ids.contains(homeState.inbox[index].id) {
            homeState.inbox[index].read = true
        }
        publish(.changed(.home))
    }
}

extension FixtureData {
    // MARK: Home

    public static let electricityApproval = ApprovalDetail(
        kindLabel: "payment",
        title: "Pay the electricity bill",
        summary: "Your Bills automation found the October statement and wants to pay it on pge.com.",
        fields: [
            .init(key: "Amount", value: "$84.20 USD"),
            .init(key: "Payee", value: "PG&E"),
            .init(key: "Site", value: "pge.com/pay"),
            .init(key: "Pay with", value: "Card on file ··4417"),
            .init(key: "Due", value: "Fri, Nov 6"),
            .init(key: "Statement", value: "lib_77c1 · Oct"),
        ],
        evidence: ["mail 08:58", "lib_77c1", "auto_bills"],
        alsoSentTo: "Mac · expires 21:12",
        presenceNote: "Payments need Face ID on this phone.",
        allowLabel: "Allow with Face ID"
    )

    public static let home = HomeSnapshot(
        needsYou: [
            NeedsYouItem(
                id: "appr_electric", kind: .approval, title: "Pay the electricity bill, $84.20",
                source: "Bills automation", time: "9:12", approval: electricityApproval),
            NeedsYouItem(
                id: "q_deck", kind: .question, title: "Which deck should I send to Dana?",
                source: "Q3 review", time: "8:40", threadID: "thr_q3"),
        ],
        running: [
            RunningTask(
                id: "task_q3", title: "Drafting the Q3 review summary", step: 3, stepCount: 7,
                detail: "reading 12 files", elapsed: "2 min")
        ],
        today: [
            BriefItem(
                id: "b1", text: "Rent is due Friday: $1,850. Autopay is off this month, so it needs a manual transfer.",
                evidenceLabel: "Because", evidence: ["calendar", "rent-nov"]),
            BriefItem(
                id: "b2", text: "Maya lands at 6:40 pm on UA 1182. Leave by 5:50 for SFO.",
                evidenceLabel: "Sources", evidence: ["mail 14:02", "maps"]),
            BriefItem(
                id: "b3", text: "Car registration renewal is open. Due November 30.",
                evidenceLabel: "Because", evidence: ["mail", "dmv-renewal"]),
        ],
        keepInTouch: [
            Nudge(id: "n1", initials: "JL", text: "You and Jordan haven't talked since September.")
        ],
        updatedAt: Calendar.current.date(bySettingHour: 8, minute: 12, second: 0, of: .now) ?? .now
    )

    public static let inbox: [InboxItem] = [
        InboxItem(
            id: "i1", title: "Pay the electricity bill, $84.20", body: "Bills automation wants to pay on pge.com.",
            kindLabel: "Approval", time: "9:12", needsYou: true),
        InboxItem(
            id: "i2", title: "Which deck should I send to Dana?", body: "Q3 review", kindLabel: "Question",
            time: "8:40", needsYou: true, route: "/chat/thr_q3"),
        InboxItem(
            id: "i3", title: "Your morning brief is ready", body: "Rent, Maya's flight and the car registration.",
            kindLabel: "Brief", time: "7:00", read: true, route: "/home"),
        InboxItem(
            id: "i4", title: "Filed the expense report", body: "Handed in to Concur · receipt lib_51d0",
            kindLabel: "Done", time: "Yesterday", read: true),
    ]
}
