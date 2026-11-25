import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue
import PsycheWire

extension GatewayBackend {
    public func threads() async throws -> [ChatThreadSummary] {
        try await threadPage(cursor: nil).threads
    }

    public func threadPage(cursor: String?) async throws -> ThreadPage {
        var params: [String: JSONValue] = ["limit": .number(Self.pageSize)]
        if let cursor { params["cursor"] = .string(cursor) }
        let result = try await call("threads.list", .object(params))
        let entries = result["threads"]?.array ?? []
        var out: [ChatThreadSummary] = []
        for entry in entries {
            guard let summary = Self.summary(from: entry) else { continue }
            if entry.at("thread", "kind")?.string == "main", let id = entry.at("thread", "id")?.string { await mainThread.set(id) }
            out.append(summary)
        }
        return ThreadPage(threads: out, nextCursor: result["nextCursor"]?.string)
    }

    public func thread(id requested: String) async throws -> ChatThread {
        let id = try await resolveThreadID(requested == FixtureData.mainThreadID ? nil : requested)
        async let entry = call("threads.get", .obj(["threadId": .string(id)]))
        async let history = call("chat.history", .obj(["threadId": .string(id), "limit": .number(Self.pageSize)]))
        let (head, page) = try await (entry, history)
        guard let summary = Self.summary(from: head) else { throw BackendError.notFound }
        let (items, older) = await transcript(page)
        let wire = head["thread"]
        let imported = !(wire?["imported"]?.isNull ?? true)
        return ChatThread(
            id: summary.id, title: summary.title, status: summary.status, statusKind: summary.statusKind,
            items: items, olderCursor: older, permissionMode: wire?["permissionMode"]?.string ?? "balanced",
            fullAccessAllowed: ThreadFullAccess.isAllowed(
                kind: wire?["kind"]?.string, imported: imported, sessionKey: wire?["sessionKey"]?.string))
    }

    public func olderItems(threadID: String, before cursor: String) async throws -> MessagePage {
        let id = try await resolveThreadID(threadID == FixtureData.mainThreadID ? nil : threadID)
        let page = try await call(
            "chat.history", .obj(["threadId": .string(id), "limit": .number(Self.pageSize), "cursor": .string(cursor)]))
        let (items, older) = await transcript(page)
        return MessagePage(items: items, nextCursor: older)
    }

    /// Page size for both lists; the Gateway clamps it to its own maximum.
    static let pageSize: Double = 60

    /// One `chat.history` page as the thread reads it, plus the cursor of the page before it. Each page's
    /// messages are oldest first (`listMessagesPage` reverses its DESC read), which is the order the thread reads in.
    private func transcript(_ page: JSONValue) async -> ([ChatItem], String?) {
        var items: [ChatItem] = []
        let lookup = questionLookup()
        for message in page["messages"]?.array ?? [] {
            items.append(contentsOf: await ChatMapping.items(from: message, lookupQuestion: lookup))
        }
        return (items, page["nextCursor"]?.string)
    }

    public func newThread() async throws -> ChatThreadSummary {
        let result = try await call("threads.newChat", .obj(["kind": "side"]))
        guard let thread = result["thread"], let summary = Self.summary(from: .obj(["thread": thread, "activity": nil])) else {
            throw BackendError.refused(String(localized: "The Gateway didn't create a chat.", bundle: .module))
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

    public func steer(threadID: String, text: String) async throws {
        let id = try await resolveThreadID(threadID)
        // chat.steer is side-effecting: the key makes a resend after a lost reply a no-op.
        _ = try await call("chat.steer", .obj(["threadId": .string(id), "content": .string(text)]), key: UUID().uuidString)
    }

    public func queueFollowUp(threadID: String, text: String) async throws -> QueuedFollowUp {
        let id = try await resolveThreadID(threadID)
        let result = try await call("chat.followUp", .obj(["threadId": .string(id), "content": .string(text)]), key: UUID().uuidString)
        guard let messageID = result["messageId"]?.string else { throw BackendError.refused(String(localized: "The Gateway didn't queue the message.", bundle: .module)) }
        // The position is the Gateway's to say: `chat.queue.updated` carries the whole list, so the
        // queue's own order replaces this guess; Int.max keeps the new item last until then.
        return QueuedFollowUp(id: messageID, threadID: id, position: .max, text: text)
    }

    public func queuedFollowUps(threadID: String) async throws -> [QueuedFollowUp] {
        let id = try await resolveThreadID(threadID)
        let result = try await call("chat.queue.list", .obj(["threadId": .string(id)]))
        return (result["items"]?.array ?? []).compactMap(Self.queued(from:))
    }

    public func removeQueuedFollowUp(threadID: String, id: String) async throws -> Bool {
        let thread = try await resolveThreadID(threadID)
        let result = try await call("chat.queue.remove", .obj(["threadId": .string(thread), "messageId": .string(id)]))
        return result["removed"]?.bool ?? false
    }

    /// One `QueuedMessage` as the composer's queue strip shows it. A malformed item is skipped, not fatal.
    static func queued(from entry: JSONValue) -> QueuedFollowUp? {
        guard let id = entry["messageId"]?.string, let thread = entry["threadId"]?.string,
              let text = entry["content"]?.string else { return nil }
        return QueuedFollowUp(id: id, threadID: thread, position: entry["position"]?.int ?? 0, text: text)
    }

    public func pinThread(id: String, pinned: Bool) async throws {
        _ = try await call("threads.pin", .obj(["threadId": .string(id), "pinned": .bool(pinned)]))
    }

    public func archiveThread(id: String) async throws {
        _ = try await call("threads.archive", .obj(["threadId": .string(id)]))
    }

    public func renameThread(id: String, title: String) async throws {
        _ = try await call("threads.rename", .obj(["threadId": .string(id), "title": .string(title)]))
    }

    public func setFullAccess(threadID: String, enabled: Bool) async throws {
        let id = try await resolveThreadID(threadID)
        _ = try await call(
            "threads.update",
            .obj(["threadId": .string(id), "permissionMode": .string(enabled ? ThreadFullAccess.mode : "balanced")]))
    }

    public func deleteThread(id: String) async throws {
        _ = try await call("threads.delete", .obj(["threadId": .string(id)]))
    }

    public func exportThread(id: String) async throws -> String {
        let result = try await call("chat.export", .obj(["threadId": .string(id), "format": "markdown"]))
        guard let content = result["content"]?.string else { throw BackendError.notFound }
        return content
    }

    public func forkThread(id: String, messageID: String, title: String?) async throws -> ChatThreadSummary {
        let thread = try await resolveThreadID(id)
        var params: [String: JSONValue] = ["threadId": .string(thread), "messageId": .string(messageID)]
        if let title { params["title"] = .string(title) }
        // Side-effecting: the key makes a resend after a lost reply return the same fork, not a second one.
        let result = try await call("threads.fork", .object(params), key: UUID().uuidString)
        guard let forked = result["thread"], let summary = Self.summary(from: .obj(["thread": forked, "activity": nil])) else {
            throw BackendError.refused(String(localized: "The Gateway didn't fork the chat.", bundle: .module))
        }
        return summary
    }

    public func clearThread(id: String) async throws {
        let thread = try await resolveThreadID(id)
        _ = try await call("threads.clear", .obj(["threadId": .string(thread)]), key: UUID().uuidString)
    }

    public func compactThread(id: String) async throws -> Bool {
        let thread = try await resolveThreadID(id)
        let result = try await call("threads.compact", .obj(["threadId": .string(thread)]), key: UUID().uuidString)
        // `compaction` is null when there was nothing to summarise.
        return !(result["compaction"]?.isNull ?? true)
    }

    public func restoreThread(id: String) async throws {
        _ = try await call("threads.restore", .obj(["threadId": .string(id)]))
    }

    public func archivedThreadPage(cursor: String?) async throws -> ThreadPage {
        // `archivedOnly` makes the Gateway filter and page the archived chats itself, so they are not cut off
        // behind the newest threads of every kind.
        var params: [String: JSONValue] = ["archivedOnly": .bool(true), "limit": .number(Self.pageSize)]
        if let cursor { params["cursor"] = .string(cursor) }
        let result = try await call("threads.list", .object(params))
        let rows = (result["threads"]?.array ?? []).compactMap(Self.summary(from:))
        return ThreadPage(threads: rows, nextCursor: result["nextCursor"]?.string)
    }

    public func giveFeedback(threadID: String, messageID: String, helpful: Bool) async throws {
        let thread = try await resolveThreadID(threadID)
        let target: JSONValue = .obj(["type": "message", "id": .string(messageID), "threadId": .string(thread)])
        _ = try await call(
            "feedback.give",
            .obj(["target": target, "kind": .string(helpful ? "helpful" : "not_helpful")]),
            key: UUID().uuidString)
    }

    // MARK: -

    /// nil means the main thread. The screens still ask for the fixture's main-thread id ("thr_main") in a
    /// few places (Home's Ask field); on a real Gateway that id means the same thing.
    private func resolveThreadID(_ id: String?) async throws -> String {
        if let id, id != FixtureData.mainThreadID { return id }
        if let known = await mainThread.get() { return known }
        let result = try await call("threads.list", .obj(["kind": "main", "limit": .number(1)]))
        if let found = result["threads"]?.array?.first?.at("thread", "id")?.string {
            await mainThread.set(found)
            return found
        }
        // A new Gateway has no main thread until someone first talks to it. `threads.create` with kind main
        // returns the existing one or makes it, so a first visit to Chat is an empty thread, not an error.
        let made = try await call("threads.create", .obj(["kind": "main"]), key: UUID().uuidString)
        guard let id = made.at("thread", "id")?.string else { throw BackendError.notFound }
        await mainThread.set(id)
        return id
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
        // The main thread is the conversation with Psyche itself, so an untitled one is named after it.
        let untitled = thread["kind"]?.string == "main" ? "Psyche" : String(localized: "New chat", bundle: .module)
        let title = thread["title"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? untitled
        let activity = entry["activity"]
        let waiting = (activity?["awaitingApproval"]?.int ?? 0) + (activity?["awaitingInput"]?.int ?? 0)
        let running = activity?["running"]?.int ?? 0
        let updated = WireFormat.time(thread["lastMessageAt"]?.string ?? thread["updatedAt"]?.string)
        let (status, kind): (String, ChatThreadSummary.Status) =
            waiting > 0 ? (String(localized: "Waiting for you", bundle: .module), .needsYou)
            : running > 0 ? (String(localized: "Running", bundle: .module), .running)
            : (entry.at("lastMessage", "text")?.string ?? updated, .neutral)
        return ChatThreadSummary(
            id: id, title: title, status: status, statusKind: kind,
            isMain: thread["kind"]?.string == "main", updated: updated,
            spaceID: thread["spaceId"]?.string, isArchived: !(thread["archivedAt"]?.isNull ?? true))
    }
}
