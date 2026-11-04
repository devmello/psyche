import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue
import PsycheWire

extension GatewayBackend {
    public func threads() async throws -> [ChatThreadSummary] {
        let result = try await call("threads.list", .obj(["limit": .number(60)]))
        let entries = result["threads"]?.array ?? []
        var out: [ChatThreadSummary] = []
        for entry in entries {
            guard let summary = Self.summary(from: entry) else { continue }
            if entry.at("thread", "kind")?.string == "main", let id = entry.at("thread", "id")?.string { await mainThread.set(id) }
            out.append(summary)
        }
        return out
    }

    public func thread(id requested: String) async throws -> ChatThread {
        let id = try await resolveThreadID(requested == FixtureData.mainThreadID ? nil : requested)
        async let entry = call("threads.get", .obj(["threadId": .string(id)]))
        async let history = call("chat.history", .obj(["threadId": .string(id), "limit": .number(60)]))
        let (head, page) = try await (entry, history)
        guard let summary = Self.summary(from: head) else { throw BackendError.notFound }
        // chat.history pages backwards from the newest; the thread reads oldest first.
        let messages = (page["messages"]?.array ?? []).reversed()
        let lookup = questionLookup()
        var items: [ChatItem] = []
        for message in messages {
            items.append(contentsOf: await ChatMapping.items(from: message, lookupQuestion: lookup))
        }
        return ChatThread(id: summary.id, title: summary.title, status: summary.status, statusKind: summary.statusKind, items: items)
    }

    public func newThread() async throws -> ChatThreadSummary {
        let result = try await call("threads.newChat", .obj(["kind": "side"]))
        guard let thread = result["thread"], let summary = Self.summary(from: .obj(["thread": thread, "activity": nil])) else {
            throw BackendError.refused("The Gateway didn't create a chat.")
        }
        return summary
    }

    public func send(_ draft: MessageDraft) async throws -> SentMessage {
        let threadID = try await resolveThreadID(draft.threadID)
        var params: [String: JSONValue] = ["threadId": .string(threadID), "content": .string(draft.text)]
        if !draft.attachmentIDs.isEmpty { params["attachments"] = .array(draft.attachmentIDs.map { .string($0) }) }
        // The draft's clientID is the idempotency key and the outbox entry id: a resend after a lost
        // acknowledgement is answered with the original result, never a second message.
        let entry = OutboxEntry(id: draft.clientID, kind: .chatSend, method: "chat.send", params: .object(params))
        switch await client.submit(entry) {
        case .delivered(let result):
            return SentMessage(threadID: threadID, messageID: result["messageId"]?.string ?? draft.clientID, delivery: .sent)
        case .queued:
            return SentMessage(threadID: threadID, messageID: draft.clientID, delivery: .queued)
        case .rejected(let why):
            throw BackendError.refused(why)
        }
    }

    public func cancelRun(threadID: String) async throws {
        _ = try await call("chat.cancel", .obj(["threadId": .string(threadID)]))
    }

    // MARK: -

    /// nil means the main thread. The screens still ask for the fixture's main-thread id ("thr_main") in a
    /// few places (Home's Ask field); on a real Gateway that id means the same thing.
    private func resolveThreadID(_ id: String?) async throws -> String {
        if let id, id != FixtureData.mainThreadID { return id }
        if let known = await mainThread.get() { return known }
        let result = try await call("threads.list", .obj(["kind": "main", "limit": .number(1)]))
        guard let found = result["threads"]?.array?.first?.at("thread", "id")?.string else { throw BackendError.notFound }
        await mainThread.set(found)
        return found
    }

    private func questionLookup() -> ChatMapping.QuestionLookup {
        { [self] id in
            guard let payload = try? await call("questions.get", .obj(["inputRequestId": .string(id)])) else { return nil }
            return payload["inputRequest"].flatMap(ChatMapping.question(from:))
        }
    }

    /// A `ThreadListEntry` (or just `{thread, activity}`) as the row the thread list shows.
    static func summary(from entry: JSONValue) -> ChatThreadSummary? {
        guard let thread = entry["thread"], let id = thread["id"]?.string else { return nil }
        let title = thread["title"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "New chat"
        let activity = entry["activity"]
        let waiting = (activity?["awaitingApproval"]?.int ?? 0) + (activity?["awaitingInput"]?.int ?? 0)
        let running = activity?["running"]?.int ?? 0
        let updated = WireFormat.time(thread["lastMessageAt"]?.string ?? thread["updatedAt"]?.string)
        let (status, kind): (String, ChatThreadSummary.Status) =
            waiting > 0 ? ("Waiting for you", .needsYou)
            : running > 0 ? ("Running", .running)
            : (entry.at("lastMessage", "text")?.string ?? updated, .neutral)
        return ChatThreadSummary(
            id: id, title: title, status: status, statusKind: kind,
            isMain: thread["kind"]?.string == "main", updated: updated)
    }
}
