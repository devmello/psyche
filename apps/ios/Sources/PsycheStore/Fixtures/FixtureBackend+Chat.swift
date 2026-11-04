import Foundation

/// Chat's fixture state. A sent message streams a short reply word by word, like `chat.delta`.
struct ChatState: Sendable {
    var summaries = FixtureData.threads
    var threads = FixtureData.chatThreads
    var cancelled: Set<String> = []
    var counter = 0
}

extension FixtureBackend: ChatBackend {
    public func threads() async throws -> [ChatThreadSummary] {
        await pause()
        return chatState.summaries
    }

    public func thread(id: String) async throws -> ChatThread {
        await pause()
        return chatState.threads[id] ?? FixtureData.emptyThread(id: id, summaries: chatState.summaries)
    }

    public func newThread() async throws -> ChatThreadSummary {
        chatState.counter += 1
        let summary = ChatThreadSummary(
            id: "thr_new\(chatState.counter)", title: "New chat", status: "Just now", statusKind: .neutral,
            isMain: false, updated: "now")
        chatState.summaries.insert(summary, at: min(1, chatState.summaries.count))
        publish(.changed(.threads))
        return summary
    }

    public func send(_ draft: MessageDraft) async throws -> SentMessage {
        let threadID = draft.threadID ?? FixtureData.mainThreadID
        let item = ChatItem.user(id: draft.clientID, text: draft.text)
        appendItem(item, to: threadID)
        publish(.chat(.item(threadID: threadID, item: item)))
        chatState.cancelled.remove(threadID)
        Task { await self.streamReply(in: threadID, to: draft.text, attachments: draft.attachmentIDs.count) }
        return SentMessage(threadID: threadID, messageID: draft.clientID, delivery: .sent)
    }

    public func cancelRun(threadID: String) async throws {
        chatState.cancelled.insert(threadID)
    }

    public func pinThread(id: String, pinned: Bool) async throws {
        guard let index = chatState.summaries.firstIndex(where: { $0.id == id }), !chatState.summaries[index].isMain
        else { return }
        chatState.summaries[index].isPinned = pinned
        publish(.changed(.threads))
    }

    public func archiveThread(id: String) async throws {
        chatState.summaries.removeAll { $0.id == id && !$0.isMain }
        publish(.changed(.threads))
    }

    private func appendItem(_ item: ChatItem, to threadID: String) {
        var thread = chatState.threads[threadID] ?? FixtureData.emptyThread(id: threadID, summaries: chatState.summaries)
        if let index = thread.items.firstIndex(where: { $0.id == item.id }) {
            thread.items[index] = item
        } else {
            thread.items.append(item)
        }
        chatState.threads[threadID] = thread
    }

    private func emit(_ item: ChatItem, in threadID: String) {
        appendItem(item, to: threadID)
        publish(.chat(.item(threadID: threadID, item: item)))
    }

    private func streamReply(in threadID: String, to text: String, attachments: Int) async {
        chatState.counter += 1
        let replyID = "reply\(chatState.counter)"
        publish(.chat(.status(threadID: threadID, status: "Thinking", kind: .running)))
        try? await Task.sleep(for: .milliseconds(450))
        if chatState.cancelled.contains(threadID) {
            publish(.chat(.status(threadID: threadID, status: "", kind: .neutral)))
            return
        }
        emit(
            .toolRun(
                id: replyID + "-tool", symbol: "magnifyingglass", summary: "Searched mail and calendar · 3 results",
                arguments: [
                    ToolArgument(key: "query", value: String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))),
                    ToolArgument(key: "sources", value: "mail, calendar"),
                    ToolArgument(key: "since", value: "7 days"),
                ], result: "3 results"),
            in: threadID)
        emit(.assistant(id: replyID, text: "", streaming: true), in: threadID)
        var reply = ""
        for word in FixtureData.reply(to: text, attachments: attachments).split(separator: " ", omittingEmptySubsequences: false) {
            if chatState.cancelled.contains(threadID) { break }
            try? await Task.sleep(for: .milliseconds(55))
            let piece = (reply.isEmpty ? "" : " ") + word
            reply += piece
            appendItem(.assistant(id: replyID, text: reply, streaming: true), to: threadID)
            publish(.chat(.delta(threadID: threadID, itemID: replyID, text: piece)))
        }
        appendItem(.assistant(id: replyID, text: reply, streaming: false), to: threadID)
        publish(.chat(.done(threadID: threadID, itemID: replyID)))
        emit(.evidence(id: replyID + "-ev", label: "Sources", parts: ["mail", "calendar", "now"]), in: threadID)
        publish(.chat(.status(threadID: threadID, status: "", kind: .neutral)))
    }
}

extension FixtureData {
    // MARK: Chat

    public static let threads: [ChatThreadSummary] = [
        ChatThreadSummary(
            id: mainThreadID, title: "Psyche", status: "Main thread", statusKind: .neutral, isMain: true,
            updated: "10:31", isPinned: true),
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

    /// Every block type appears at least once across these threads (a general mix: work, bills, family).
    static let chatThreads: [String: ChatThread] = [
        mainThreadID: ChatThread(
            id: mainThreadID, title: "Psyche", status: "Main thread", statusKind: .neutral,
            items: [
                .user(id: "a1", text: "What's on for this week?"),
                .toolCall(id: "a2", symbol: "calendar", summary: "Read calendar · 6 events"),
                .assistant(
                    id: "a3",
                    text:
                        "## This week\n\nThree things matter, in this order:\n\n1. **Wednesday:** Dana's Q3 review. The deck still needs a pick.\n2. **Thursday:** the electricity bill is due. I've asked you to approve it.\n3. **Saturday:** Maya lands at 14:20.\n\n> Nothing else needs you before Wednesday.\n\nI'll remind you on Home the morning of each.",
                    streaming: false),
                .evidence(id: "a4", label: "Because", parts: ["calendar", "bills", "10:31"]),
                .note(id: "a5", kind: .learned, title: "Learned", detail: "You'd rather review decks the evening before."),
                .user(id: "a6", text: "Remember that I don't take calls before 10."),
                .note(id: "a7", kind: .taught, title: "Saved to Soul", detail: "No calls before 10:00."),
                .assistant(id: "a8", text: "Got it. I'll keep mornings clear and say so when someone asks.", streaming: false),
            ]),
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
                .progress(
                    id: "m2p", kind: .plan, title: "Plan · Q3 summary for Dana",
                    steps: [
                        ProgressStep(id: "p1", title: "Find Monday's deck", state: .done),
                        ProgressStep(id: "p2", title: "Read the slides", state: .done),
                        ProgressStep(id: "p3", title: "Pick which deck to use", state: .running),
                        ProgressStep(id: "p4", title: "Outline the quarter", state: .pending),
                        ProgressStep(id: "p5", title: "Draft the summary", state: .pending),
                        ProgressStep(id: "p6", title: "Check numbers against Finance", state: .pending),
                        ProgressStep(id: "p7", title: "Send to Dana (asks you first)", state: .pending),
                    ]),
                .toolCall(id: "m3", symbol: "magnifyingglass", summary: "Searched Library · 2 results"),
                .toolRun(
                    id: "m4", symbol: "doc", summary: "Read Q3-review-v4.key · 18 slides",
                    arguments: [
                        ToolArgument(key: "file", value: "lib_8f2a"),
                        ToolArgument(key: "pages", value: "1–18"),
                    ], result: "18 slides, 2,140 words"),
                .file(
                    id: "m4f", title: "Q3-review-v4.key", fileType: "key", detail: "Monday 10:14 · 18 slides",
                    libraryID: "lib_8f2a", isArtifact: false),
                .question(
                    id: "q_deck", title: "Which deck should I use?",
                    options: [
                        ChatOption(id: "o1", title: "Q3-review-v4.key", detail: "Monday 10:14 · 18 slides"),
                        ChatOption(id: "o2", title: "Q3-review-final.pdf", detail: "Monday 16:52 · 21 pages"),
                    ]),
                .evidence(id: "m6", label: "Sources", parts: ["lib_8f2a", "lib_91c0", "10:22"]),
                .assistant(
                    id: "m7",
                    text: "While you pick, here's the outline so far: the quarter's results, the two launches that moved to December, and where hiring stands",
                    streaming: true),
            ]),
        "thr_bills": ChatThread(
            id: "thr_bills", title: "Bills automation", status: "Waiting for you", statusKind: .needsYou,
            items: [
                .user(id: "b1", text: "Pay the electricity bill when it lands, and tell me first."),
                .note(
                    id: "b2", kind: .automationWorkflow, title: "Automation · Bills",
                    detail: "When a bill arrives: read it, check the amount, ask you, pay."),
                .progress(
                    id: "b3", kind: .checklist, title: "This bill",
                    steps: [
                        ProgressStep(id: "c1", title: "Bill found in mail", state: .done),
                        ProgressStep(id: "c2", title: "Amount within the usual range", state: .done),
                        ProgressStep(id: "c3", title: "Your OK", state: .running),
                        ProgressStep(id: "c4", title: "Pay and file the receipt", state: .pending),
                    ]),
                .approval(id: "b4", item: electricityNeedsYou, resolution: nil),
                .evidence(id: "b5", label: "Approval", parts: ["Bills automation", "9:12"]),
                .appLink(id: "b6", title: "Rent and bills", detail: "Memory · 4 due this month", route: "/goals/rent"),
            ]),
        "thr_lease": ChatThread(
            id: "thr_lease", title: "Lease renewal questions", status: "Oct 28", statusKind: .neutral,
            items: [
                .user(id: "l1", text: "What should I ask about before renewing the lease?"),
                .assistant(
                    id: "l2",
                    text:
                        "# Before you renew\n\nFour things in the lease are worth a question:\n\n- **Rent increase:** the letter says 4.5%, the lease caps it at 3%\n- **Pets:** the new addendum adds a $40/month fee\n- **Parking:** the second space is no longer included\n- **Notice period:** it moved from 30 to 60 days\n\n> The cap in section 6 is the strongest point. Start there.\n\nA short note you could send:\n\n```\nHi Sam, section 6 caps increases at 3%.\nCould you confirm the 4.5% in the letter?\n```\n\nI can draft the whole reply if you like.",
                    streaming: false),
                .toolCall(id: "l3", symbol: "doc.text", summary: "Read Lease-2025.pdf · 14 pages"),
                .note(
                    id: "l4", kind: .specialistResult, title: "Contracts specialist",
                    detail: "Found the 3% cap in section 6 and a fee clause in the addendum."),
                .evidence(id: "l5", label: "Sources", parts: ["lib_lease25", "lib_letter", "Oct 28"]),
                .note(
                    id: "l6", kind: .compaction, title: "Earlier messages summarized",
                    detail: "42 messages from Oct 12–20 are kept as a summary."),
                .note(
                    id: "l7", kind: .wrapUp, title: "Wrap-up",
                    detail: "Asked about the cap and the pet fee. Waiting on Sam's reply."),
            ]),
        "thr_trip": ChatThread(
            id: "thr_trip", title: "Maya's visit", status: "Oct 24", statusKind: .neutral,
            items: [
                .user(id: "t1", text: "Maya's flight lands Saturday. Plan something low key."),
                .assistant(
                    id: "t2",
                    text: "Saturday is open after 15:00. I'd keep it simple: pick her up at 14:20, early dinner at the place she liked last time, and nothing booked on Sunday morning.",
                    streaming: false),
                .progress(
                    id: "t3", kind: .task, title: "Book dinner for two, Saturday 18:00",
                    steps: [
                        ProgressStep(id: "d1", title: "Find the restaurant", state: .done),
                        ProgressStep(id: "d2", title: "Check a table is free", state: .done),
                        ProgressStep(id: "d3", title: "Book it", state: .failed),
                    ]),
                .file(
                    id: "t4", title: "Saturday plan.html", fileType: "html", detail: "Artifact · today",
                    libraryID: "lib_plan", isArtifact: true),
                .relatedThreads(
                    id: "t5",
                    threads: [
                        RelatedThread(id: "thr_lease", title: "Lease renewal questions", status: "Oct 28"),
                        RelatedThread(id: "thr_q3", title: "Q3 review", status: "Running · step 3 of 7"),
                    ]),
                .widget(id: "t7", widgetID: "wdg_saturday_route"),
                .unknown(id: "t6", type: "map_route"),
            ]),
    ]

    static let electricityNeedsYou = NeedsYouItem(
        id: "appr_electric", kind: .approval, title: "Pay the electricity bill, $84.20",
        source: "Bills automation", time: "9:12", approval: electricityApproval)

    static func emptyThread(id: String, summaries: [ChatThreadSummary] = threads) -> ChatThread {
        let title = summaries.first { $0.id == id }?.title ?? "Chat"
        return ChatThread(
            id: id, title: title, status: "", statusKind: .neutral,
            items: [
                .assistant(id: "e1", text: "Ask me anything. I'll show what I looked at as I go.", streaming: false)
            ])
    }

    static func reply(to text: String, attachments: Int = 0) -> String {
        let topic = text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60)
        let files = attachments > 0 ? "\(attachments) file\(attachments == 1 ? "" : "s") you sent, plus " : ""
        return "I checked \(files)your mail, calendar and Library for \u{201C}\(topic)\u{201D}.\n\n- **Mail:** nothing that needs you\n- **Calendar:** nothing new this week\n\nI'll keep an eye on it and tell you on Home if that changes."
    }
}
