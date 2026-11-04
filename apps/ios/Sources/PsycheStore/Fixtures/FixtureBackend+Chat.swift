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
        Task { await self.streamReply(in: threadID, to: draft.text) }
        return SentMessage(threadID: threadID, messageID: draft.clientID, delivery: .sent)
    }

    public func cancelRun(threadID: String) async throws {
        chatState.cancelled.insert(threadID)
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

    private func streamReply(in threadID: String, to text: String) async {
        chatState.counter += 1
        let replyID = "reply\(chatState.counter)"
        publish(.chat(.status(threadID: threadID, status: "Thinking", kind: .running)))
        try? await Task.sleep(for: .milliseconds(450))
        let tool = ChatItem.toolCall(id: replyID + "-tool", symbol: "magnifyingglass", summary: "Searched mail and calendar · 3 results")
        appendItem(tool, to: threadID)
        publish(.chat(.item(threadID: threadID, item: tool)))
        var reply = ""
        appendItem(.assistant(id: replyID, text: reply, streaming: true), to: threadID)
        publish(.chat(.item(threadID: threadID, item: .assistant(id: replyID, text: reply, streaming: true))))
        for word in FixtureData.reply(to: text).split(separator: " ", omittingEmptySubsequences: false) {
            if chatState.cancelled.contains(threadID) { break }
            try? await Task.sleep(for: .milliseconds(55))
            let piece = (reply.isEmpty ? "" : " ") + word
            reply += piece
            appendItem(.assistant(id: replyID, text: reply, streaming: true), to: threadID)
            publish(.chat(.delta(threadID: threadID, itemID: replyID, text: piece)))
        }
        appendItem(.assistant(id: replyID, text: reply, streaming: false), to: threadID)
        publish(.chat(.done(threadID: threadID, itemID: replyID)))
        let evidence = ChatItem.evidence(id: replyID + "-ev", label: "Sources", parts: ["mail", "calendar", "now"])
        appendItem(evidence, to: threadID)
        publish(.chat(.item(threadID: threadID, item: evidence)))
        publish(.chat(.status(threadID: threadID, status: "", kind: .neutral)))
    }
}

extension FixtureData {
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
            ])
    ]

    static func emptyThread(id: String, summaries: [ChatThreadSummary] = threads) -> ChatThread {
        let title = summaries.first { $0.id == id }?.title ?? "Chat"
        return ChatThread(
            id: id, title: title, status: "", statusKind: .neutral,
            items: [
                .assistant(id: "e1", text: "Ask me anything. I'll show what I looked at as I go.", streaming: false)
            ])
    }

    static func reply(to text: String) -> String {
        let topic = text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60)
        return "I checked your mail, calendar and Library for \u{201C}\(topic)\u{201D}. Nothing there needs you right now. I'll keep an eye on it and tell you on Home if that changes."
    }
}
