import Foundation
import PsycheProtocol

/// Pure parts of `messages.*` (J7): parameter validation, the polling watcher and the Messages.app
/// send script. The live capability group is `PsycheHelperSystem/Messages`.
public enum MessagesCore {
    public static let messagesBundleId = "com.apple.MobileSMS"
    public static let maxText = 20000
    public static let sendTimeoutSeconds = 20
    /// OSA errors that mean "no such chat / participant": safe to try the next spelling, because
    /// nothing was sent. Anything else (a timeout after Messages took the text) is final.
    public static let notFoundOSAErrors: Set<Int> = [-1728, -1719]

    // MARK: Params

    public struct ChatsParams: Decodable, Sendable { public var limit: Int?; public var query: String? }
    public struct ReadParams: Decodable, Sendable {
        public var chatId: String?
        public var handle: String?
        public var sinceCursor: Int?
        public var limit: Int?
    }
    public struct SendParams: Decodable, Sendable {
        public var to: String?
        public var chatId: String?
        public var text: String
        public var service: String?
    }
    public struct WatchParams: Decodable, Sendable {
        public var sinceCursor: Int?
        public var intervalMs: Int?
        public var includeFromMe: Bool?
    }

    /// The validated target of a send.
    public enum Recipient: Equatable, Sendable {
        case handle(String, service: MessagesSendService)
        case chat(String)

        public var display: String {
            switch self {
            case .handle(let h, _): return h
            case .chat(let c): return c
            }
        }
    }

    public static func validate(_ p: SendParams) throws -> (Recipient, String) {
        guard !p.text.isEmpty, p.text.count <= maxText else {
            throw CapabilityError.invalidParams("text must be 1–\(maxText) characters", field: "text")
        }
        let service: MessagesSendService
        switch p.service ?? "imessage" {
        case "imessage": service = .imessage
        case "sms": service = .sms
        default: throw CapabilityError.invalidParams("service must be imessage or sms", field: "service")
        }
        switch (p.to, p.chatId) {
        case (let to?, nil):
            let h = ChatDatabase.normalize(handle: to)
            guard isHandle(h) else { throw CapabilityError.invalidParams("to must be a phone number or email address", field: "to") }
            return (.handle(h, service: service), p.text)
        case (nil, let chat?):
            guard isChatId(chat) else { throw CapabilityError.invalidParams("chatId is not a Messages chat id", field: "chatId") }
            return (.chat(chat), p.text)
        default:
            throw CapabilityError.invalidParams("pass exactly one of to or chatId", field: "to")
        }
    }

    static func isHandle(_ h: String) -> Bool {
        guard !h.isEmpty, h.count <= 320 else { return false }
        if h.contains("@") {
            return h.range(of: #"^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$"#, options: .regularExpression) != nil
        }
        return h.range(of: #"^\+?[0-9]{3,20}$"#, options: .regularExpression) != nil
    }

    static func isChatId(_ c: String) -> Bool {
        c.count <= 512 && c.range(of: #"^[A-Za-z]+;[-+];[A-Za-z0-9@._%+\-]+$"#, options: .regularExpression) != nil
    }

    // MARK: Send script

    /// AppleScript string literal (backslash and quote escaped; the text is never code).
    public static func literal(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// Scripts to try, in order. A 1:1 chat id is sent to its participant handle, because macOS 26+
    /// renamed chat GUIDs (`any;-;…`) and Messages' scripting may not find the chat.db GUID; a group
    /// chat is addressed by id, trying the `any;` and `iMessage;` spellings.
    public static func sendScripts(_ recipient: Recipient, text: String, chatService: MessagesService? = nil) -> [String] {
        // A bounded Apple Event wait: a hung Messages must not hold the helper's main thread.
        func toParticipant(_ handle: String, _ service: MessagesSendService) -> String {
            let type = service == .sms ? "SMS" : "iMessage"
            return """
                with timeout of \(sendTimeoutSeconds) seconds
                    tell application id "\(messagesBundleId)"
                        set svc to first account whose service type is \(type)
                        send \(literal(text)) to participant \(literal(handle)) of svc
                    end tell
                end timeout
                """
        }
        func toChat(_ id: String) -> String {
            """
            with timeout of \(sendTimeoutSeconds) seconds
                tell application id "\(messagesBundleId)"
                    send \(literal(text)) to chat id \(literal(id))
                end tell
            end timeout
            """
        }
        switch recipient {
        case .handle(let h, let service):
            return [toParticipant(h, service)]
        case .chat(let id):
            let parts = id.components(separatedBy: ";")
            guard parts.count == 3 else { return [toChat(id)] }
            if parts[1] == "-" {
                // `any;` (macOS 26+) and `RCS;` ids say nothing about the account: use the chat's
                // last message service; SMS and RCS go through the SMS account.
                let prefix = parts[0].lowercased()
                let svc: MessagesService = prefix == "imessage" ? .imessage : prefix == "sms" || prefix == "rcs" ? .sms : (chatService ?? .imessage)
                let service: MessagesSendService = svc == .sms || svc == .rcs ? .sms : .imessage
                return [toParticipant(ChatDatabase.normalize(handle: parts[2]), service)]
            }
            var ids = [id]
            for prefix in ["any", "iMessage"] where prefix != parts[0] { ids.append("\(prefix);+;\(parts[2])") }
            return ids.map(toChat)
        }
    }

    // MARK: Watcher

    /// Polls `read(since:)` every `interval` and emits `MessagesWatchEvent`s until cancelled.
    /// Starts at `since`, or at the newest row so nothing old is replayed. Busy or unreadable
    /// databases back off (up to 30 s) and emit one `messages.watch_error` per failure streak;
    /// a missing Full Disk Access grant emits it and ends the invocation with that error.
    ///
    /// `read` must return rows not yet linked to a chat (empty `chatID`): Messages writes the
    /// `chat_message_join` row right after the message, so an unlinked row younger than
    /// `holdBack` stops the cursor before it until the next poll; an older one is skipped.
    public struct Watcher: Sendable {
        public typealias Read = @Sendable (_ since: Int) async throws -> ChatDatabase.ReadPage
        public var read: Read
        public var start: @Sendable () async throws -> Int?
        public var sleep: @Sendable (Duration) async throws -> Void
        public var now: @Sendable () -> Date
        public var holdBack: TimeInterval = 30

        public init(read: @escaping Read, start: @escaping @Sendable () async throws -> Int?,
                    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await _Concurrency.Task.sleep(for: $0) },
                    now: @escaping @Sendable () -> Date = { Date() }) {
            self.read = read
            self.start = start
            self.sleep = sleep
            self.now = now
        }

        /// Rows to deliver and the cursor to advance to, honouring the hold-back rule.
        func accept(_ page: ChatDatabase.ReadPage, after cursor: Int) -> (messages: [MessagesMessage], cursor: Int, held: Bool) {
            var out: [MessagesMessage] = []
            var next = cursor
            for m in page.messages {
                if m.chatID.isEmpty {
                    let sent = ISO8601DateFormatter.psyche.date(from: m.sentAt) ?? .distantPast
                    if now().timeIntervalSince(sent) < holdBack { return (out, next, true) }
                } else {
                    out.append(m)
                }
                next = m.cursor
            }
            return (out, max(next, page.cursor ?? next), false)
        }

        public func run(since: Int?, intervalMs: Int, includeFromMe: Bool, emit: @Sendable (JSONValue) async -> Void) async throws {
            let interval = Duration.milliseconds(max(500, min(intervalMs, 60000)))
            var cursor: Int
            if let since { cursor = since } else { cursor = try await start() ?? 0 }
            var failing = false
            var delay = interval
            while true {
                try _Concurrency.Task.checkCancellation()
                do {
                    var more = true
                    while more {
                        let page = try await read(cursor)
                        let (accepted, next, held) = accept(page, after: cursor)
                        more = page.hasMore && !held
                        guard next > cursor else { break }
                        cursor = next
                        let msgs = includeFromMe ? accepted : accepted.filter { !$0.isFromMe }
                        if !msgs.isEmpty {
                            let event = MessagesWatchEvent(cursor: next, messages: msgs, type: .messagesNew, reason: nil, retryable: nil)
                            await emit((try? JSONValue(encoding: event)) ?? .null)
                        }
                    }
                    failing = false
                    delay = interval
                } catch let e as CapabilityError {
                    if !failing {
                        failing = true
                        let event = MessagesWatchEvent(cursor: nil, messages: nil, type: .messagesWatchError, reason: e.reason, retryable: e.retryable)
                        await emit((try? JSONValue(encoding: event)) ?? .null)
                    }
                    guard e.retryable else { throw e }
                    delay = min(delay * 2, .seconds(30))
                }
                try await sleep(delay)
            }
        }
    }
}
