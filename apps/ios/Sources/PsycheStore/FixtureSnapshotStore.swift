import Foundation

/// Fixtures for previews, screenshots and the fake session. A general mix (bills, work, family),
/// not school-first (docs/design/ios-app-2026.md §6).
public struct FixtureSnapshotStore: SnapshotStore {
    public init() {}

    public func home() async throws -> HomeSnapshot { Self.home }
    public func threads() async throws -> [ChatThreadSummary] { Self.threads }
    public func memory() async throws -> MemorySnapshot { Self.memory }

    public func thread(id: String) async throws -> ChatThread {
        Self.chatThreads[id] ?? Self.emptyThread(id: id)
    }

    public func search(query: String) async throws -> SearchResults {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return SearchResults(answer: nil, hits: []) }
        let hits = Self.searchIndex.filter {
            $0.title.lowercased().contains(needle) || $0.detail.lowercased().contains(needle)
        }
        let answer = needle.contains("rent") ? Self.rentAnswer : nil
        return SearchResults(answer: answer, hits: hits)
    }
}

extension FixtureSnapshotStore {
    public static let mainThreadID = "thr_main"

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

    // MARK: Chat

    public static let threads: [ChatThreadSummary] = [
        ChatThreadSummary(
            id: mainThreadID, title: "Psyche", status: "Main thread", statusKind: .neutral, isMain: true,
            updated: "10:31"),
        ChatThreadSummary(
            id: "thr_q3", title: "Q3 review", status: "Running · step 3 of 7", statusKind: .running,
            isMain: false, updated: "10:22"),
        ChatThreadSummary(
            id: "thr_bills", title: "Bills automation", status: "Waiting for you", statusKind: .needsYou,
            isMain: false, updated: "9:12"),
        ChatThreadSummary(
            id: "thr_lease", title: "Lease renewal questions", status: "Oct 28", statusKind: .neutral,
            isMain: false, updated: "Oct 28"),
        ChatThreadSummary(
            id: "thr_trip", title: "Maya's visit", status: "Oct 24", statusKind: .neutral,
            isMain: false, updated: "Oct 24"),
    ]

    static let chatThreads: [String: ChatThread] = [
        "thr_q3": ChatThread(
            id: "thr_q3", title: "Q3 review", status: "Running · step 3 of 7", statusKind: .running,
            items: [
                .user(
                    id: "m1",
                    text: "Pull together a summary of the Q3 review for Dana. Use the deck from Monday."),
                .assistant(
                    id: "m2",
                    text: "On it. I found two decks from Monday, so I'll check which one before anything goes to Dana.",
                    streaming: false),
                .toolCall(id: "m3", symbol: "magnifyingglass", summary: "Searched Library · 2 results"),
                .toolCall(id: "m4", symbol: "doc", summary: "Read Q3-review-v4.key · 18 slides"),
                .question(
                    id: "m5", title: "Which deck should I use?",
                    options: [
                        ChatOption(id: "o1", title: "Q3-review-v4.key", detail: "Monday 10:14 · 18 slides"),
                        ChatOption(id: "o2", title: "Q3-review-final.pdf", detail: "Monday 16:52 · 21 pages"),
                    ]),
                .evidence(id: "m6", label: "Sources", parts: ["lib_8f2a", "lib_91c0", "10:22"]),
                .assistant(
                    id: "m7",
                    text: "While you pick, here's the outline so far: the quarter's results, the two launches that moved to December, and where hiring stands",
                    streaming: true),
            ])
    ]

    static func emptyThread(id: String) -> ChatThread {
        let title = threads.first { $0.id == id }?.title ?? "Chat"
        return ChatThread(
            id: id, title: title, status: "", statusKind: .neutral,
            items: [
                .assistant(id: "e1", text: "Ask me anything. I'll show what I looked at as I go.", streaming: false)
            ])
    }

    // MARK: Memory

    public static let memory = MemorySnapshot(
        todos: [
            TodoItem(
                id: "t1", title: "Pay rent", meta: "Fri · Home · $1,850", bucket: .thisWeek, needsYou: true),
            TodoItem(
                id: "t2", title: "Send the Q3 summary to Dana", meta: "Thu · Q3 review · in progress",
                bucket: .thisWeek),
            TodoItem(id: "t3", title: "Book a dentist cleaning", meta: "Sat · no project", bucket: .thisWeek),
            TodoItem(id: "t4", title: "Renew car registration", meta: "Nov 30 · Car", bucket: .later),
            TodoItem(id: "t5", title: "Renew renter's insurance", meta: "Dec 1 · Home", bucket: .later),
            TodoItem(
                id: "t6", title: "File the expense report", meta: "Handed in · Oct 31", bucket: .later, done: true),
        ],
        projects: [
            ProjectItem(
                id: "p1", title: "Kitchen remodel", detail: "Waiting on the second quote", fraction: 0.4),
            ProjectItem(id: "p2", title: "Q3 review", detail: "Step 3 of 7", fraction: 3.0 / 7.0),
            ProjectItem(id: "p3", title: "Car", detail: "Registration due Nov 30", fraction: 0.75),
        ],
        people: [
            PersonItem(id: "pe1", name: "Sam Ortiz", initials: "SO", detail: "Landlord · last mail Oct 28"),
            PersonItem(id: "pe2", name: "Dana Reyes", initials: "DR", detail: "Work · Q3 review"),
            PersonItem(id: "pe3", name: "Maya Chen", initials: "MC", detail: "Family · lands Tue 6:40 pm"),
            PersonItem(id: "pe4", name: "Jordan Lee", initials: "JL", detail: "Friend · last talked in September"),
        ],
        leftOff: LeftOff(
            title: "Kitchen remodel.",
            text: "You picked the quartz sample and were waiting on the contractor's second quote.",
            evidence: ["mail Oct 30", "notes/kitchen.md"])
    )

    // MARK: Search

    static let rentAnswer = SearchResults.Answer(
        text: "Rent is due Friday, November 6: $1,850 to Sam Ortiz. Autopay is paused this month.",
        emphasis: "Friday, November 6",
        evidence: ["lease-2026.pdf", "mail Oct 28", "todo_rent"])

    static let searchIndex: [SearchResults.Hit] = [
        .init(id: "s1", group: .todo, symbol: "circle", title: "Pay rent for November", detail: "Due Fri · Home"),
        .init(id: "s2", group: .todo, symbol: "circle", title: "Renew renter's insurance", detail: "Due Dec 1 · Home"),
        .init(
            id: "s3", group: .chatsAndFiles, symbol: "bubble.left", title: "Lease renewal questions",
            detail: "Chat · Oct 28"),
        .init(
            id: "s4", group: .chatsAndFiles, symbol: "doc", title: "lease-2026.pdf",
            detail: "Library · p. 3 \"rent is due on the 6th\""),
        .init(
            id: "s5", group: .chatsAndFiles, symbol: "doc", title: "Q3-review-v4.key",
            detail: "Library · Monday 10:14"),
        .init(id: "s6", group: .people, symbol: "person", title: "Sam Ortiz", detail: "Landlord · last mail Oct 28"),
        .init(id: "s7", group: .people, symbol: "person", title: "Dana Reyes", detail: "Work · Q3 review"),
    ]
}
