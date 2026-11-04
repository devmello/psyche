import Foundation

// Chat (§4.2, §5): threads, history, sending and streaming. Owner: the Chat session (I4). Gateway
// methods: threads.list/get/newChat, chat.history/send/cancel/steer; events chat.delta/block/message.

public protocol ChatBackend: Sendable {
    func threads() async throws -> [ChatThreadSummary]
    func thread(id: String) async throws -> ChatThread
    func newThread() async throws -> ChatThreadSummary
    /// Queue a message. It goes through the outbox (§3.1), so it is accepted offline; the reply
    /// arrives as `LiveEvent.chat` events.
    func send(_ draft: MessageDraft) async throws -> SentMessage
    func cancelRun(threadID: String) async throws
}

public struct MessageDraft: Sendable, Equatable {
    /// The idempotency key `chat.send` requires; also the local id of the user's message.
    public var clientID: String
    /// nil means the main thread.
    public var threadID: String?
    public var text: String
    /// Library ids of files uploaded for this message (`LibraryBackend.upload`).
    public var attachmentIDs: [String]

    public init(clientID: String = UUID().uuidString, threadID: String?, text: String, attachmentIDs: [String] = []) {
        self.clientID = clientID
        self.threadID = threadID
        self.text = text
        self.attachmentIDs = attachmentIDs
    }
}

public struct SentMessage: Sendable, Equatable {
    public enum Delivery: Sendable, Equatable { case sent, queued }
    public var threadID: String
    public var messageID: String
    public var delivery: Delivery

    public init(threadID: String, messageID: String, delivery: Delivery) {
        self.threadID = threadID
        self.messageID = messageID
        self.delivery = delivery
    }
}

/// Streaming updates for one thread, carried by `LiveEvent.chat`.
public enum ChatEvent: Sendable, Equatable {
    /// A new item, or a replacement for the item with the same id.
    case item(threadID: String, item: ChatItem)
    /// Text appended to a streaming assistant item.
    case delta(threadID: String, itemID: String, text: String)
    /// The streaming item finished.
    case done(threadID: String, itemID: String)
    case status(threadID: String, status: String, kind: ChatThreadSummary.Status)

    public var threadID: String {
        switch self {
        case .item(let id, _), .delta(let id, _, _), .done(let id, _), .status(let id, _, _): id
        }
    }
}

public struct ChatThreadSummary: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    /// "Running · step 3 of 7", "Waiting for you", or the last-activity time.
    public var status: String
    public var statusKind: Status
    public var isMain: Bool
    public var updated: String

    public enum Status: Sendable { case neutral, needsYou, running }

    public init(id: String, title: String, status: String, statusKind: Status, isMain: Bool, updated: String) {
        self.id = id
        self.title = title
        self.status = status
        self.statusKind = statusKind
        self.isMain = isMain
        self.updated = updated
    }
}

public struct ChatThread: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var status: String
    public var statusKind: ChatThreadSummary.Status
    public var items: [ChatItem]

    public init(id: String, title: String, status: String, statusKind: ChatThreadSummary.Status, items: [ChatItem]) {
        self.id = id
        self.title = title
        self.status = status
        self.statusKind = statusKind
        self.items = items
    }
}

public enum ChatItem: Sendable, Equatable, Identifiable {
    case user(id: String, text: String)
    case assistant(id: String, text: String, streaming: Bool)
    case toolCall(id: String, symbol: String, summary: String)
    case question(id: String, title: String, options: [ChatOption])
    case evidence(id: String, label: String, parts: [String])

    public var id: String {
        switch self {
        case .user(let id, _), .assistant(let id, _, _), .toolCall(let id, _, _),
             .question(let id, _, _), .evidence(let id, _, _):
            id
        }
    }
}

public struct ChatOption: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var detail: String

    public init(id: String, title: String, detail: String) {
        self.id = id
        self.title = title
        self.detail = detail
    }
}

extension [ChatThreadSummary] {
    public static let skeleton: [ChatThreadSummary] = (1...4).map {
        ChatThreadSummary(id: "skc\($0)", title: "Placeholder chat title", status: "Status", statusKind: .neutral, isMain: false, updated: "0:00")
    }
}

extension ChatThread {
    public static let skeleton = ChatThread(
        id: "sk", title: "Chat", status: "", statusKind: .neutral,
        items: [
            .assistant(id: "sk1", text: "Placeholder text for a message that wraps across two or three lines in the thread.", streaming: false),
            .toolCall(id: "sk2", symbol: "doc", summary: "Placeholder tool call summary"),
        ])
}
