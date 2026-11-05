import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireEventFrame
import PsycheWire

/// Gateway events -> `LiveEvent`s. Chat events carry their content; everything else is a hint to
/// refetch (push and events are hints, not state: companion §2.3). Unknown events map to nothing, so a
/// newer Gateway never breaks an older phone.
struct EventMapper {
    /// Messages whose streaming row exists already, so the first delta creates it and later ones append.
    private var streaming: Set<String> = []
    private let lookupQuestion: ChatMapping.QuestionLookup

    init(lookupQuestion: @escaping ChatMapping.QuestionLookup) {
        self.lookupQuestion = lookupQuestion
    }

    /// What the connection should do besides publishing events.
    enum Effect: Equatable {
        case none
        /// `device.updated` for this phone with `revokedAt` set.
        case thisDeviceRevoked
    }

    mutating func map(_ frame: WireEventFrame, ownDeviceID: String) async -> (events: [LiveEvent], effect: Effect) {
        let p = frame.payload
        switch frame.event {
        case "chat.delta":
            guard let thread = p["threadId"]?.string, let message = p["messageId"]?.string,
                  let delta = p["delta"]?.string else { return ([], .none) }
            if streaming.insert(message).inserted {
                return ([.chat(.item(threadID: thread, item: .assistant(id: message, text: delta, streaming: true)))], .none)
            }
            return ([.chat(.delta(threadID: thread, itemID: message, text: delta))], .none)

        case "chat.message":
            guard let message = p["message"], let thread = message["threadId"]?.string,
                  let messageID = message["id"]?.string else { return ([], .none) }
            let items = await ChatMapping.items(from: message, lookupQuestion: lookupQuestion)
            var out: [LiveEvent] = items.map { .chat(.item(threadID: thread, item: $0)) }
            if streaming.remove(messageID) != nil { out.append(.chat(.done(threadID: thread, itemID: messageID))) }
            // A committed agent message can finish a run (status line) and move the thread list.
            out.append(.changed(.threads))
            if message["role"]?.string == "agent" { out.append(.changed(.home)) }
            return (out, .none)

        case "chat.block":
            guard let thread = p["threadId"]?.string, let block = p["block"] else { return ([], .none) }
            switch block["type"]?.string {
            case "tool_call":
                guard let id = block["toolCallId"]?.string else { return ([], .none) }
                let tool = block["tool"]?.string ?? ""
                let item = ChatItem.toolCall(id: id, symbol: ChatMapping.symbol(forTool: tool), summary: block["level1"]?.string ?? tool)
                return ([.chat(.item(threadID: thread, item: item))], .none)
            case "question":
                guard let id = block["inputRequestId"]?.string else { return ([], .none) }
                let q = await lookupQuestion(id)
                let item = ChatItem.question(id: id, title: q?.title ?? "Psyche has a question", options: q?.options ?? [])
                return ([.chat(.item(threadID: thread, item: item)), .changed(.home)], .none)
            case "approval", "task":
                return ([.changed(.home), .changed(.activity)], .none)
            default:
                return ([], .none)
            }

        case "approval.created", "approval.updated", "question.created", "question.updated":
            return ([.changed(.home), .changed(.activity)], .none)
        case "notification.created", "notification.updated", "notification.resolved", "notification.opened",
             "feed.post", "feed.updated", "idea.updated", "goal.updated":
            return ([.changed(.home)], .none)
        case "task.updated", "task.action", "run.updated", "specialist.spawned", "specialist.progress", "specialist.result":
            // A task or specialist job can be what a pinned widget's bindings read, so widgets refetch too.
            return ([.changed(.activity), .changed(.home), .changed(.widgets)], .none)
        case "automation.updated":
            return ([.changed(.widgets)], .none)
        case "thread.updated", "thread.cleared", "thread.deleted":
            return ([.changed(.threads)], .none)
        case "memory.entity.updated", "memory.loop.updated", "memory.suggestion.created", "memory.job.updated", "memory.file.changed":
            return ([.changed(.memory)], .none)
        // A patched or frozen widget: the widget views refetch (the Gateway has the patched spec and the bound
        // data), and Home's Pinned section reloads.
        case "widget.updated":
            return ([.changed(.widgets), .changed(.home)], .none)
        case _ where frame.event.hasPrefix("memory."):
            return ([.changed(.memory)], .none)
        case "settings.changed", "persona.updated":
            return ([.changed(.settings)], .none)
        // `library.item.changed` is an upload or delete from another device.
        case "artifact.updated", "library.item.changed", "library.item.created", "library.item.updated", "library.item.deleted":
            return ([.changed(.library)], .none)
        case "device.updated":
            if let device = p["device"], device["id"]?.string == ownDeviceID, device["revokedAt"]?.string != nil {
                return ([], .thisDeviceRevoked)
            }
            return ([.changed(.settings)], .none)
        default:
            return ([], .none)
        }
    }
}

/// Decides when everything on screen must be refetched (N14 `onResync`): the Gateway's `stateVersion`
/// moved while the phone was away, or the event stream skipped a `seq`.
struct Resync {
    private(set) var lastStateVersion: Int?
    private var lastSeq: Int?

    init(lastStateVersion: Int?) { self.lastStateVersion = lastStateVersion }

    /// A new connection starts a new `seq` count. True when the `stateVersion` it reports differs from
    /// the last one this phone saw (never true on the very first connect: there is nothing stale).
    mutating func connected(stateVersion: Int) -> Bool {
        lastSeq = nil
        defer { lastStateVersion = stateVersion }
        guard let previous = lastStateVersion else { return false }
        return previous != stateVersion
    }

    /// True when `seq` is not the next one: events were lost, so refetch.
    mutating func observed(seq: Int, stateVersion: Int) -> Bool {
        defer { lastSeq = seq; lastStateVersion = max(lastStateVersion ?? 0, stateVersion) }
        guard let last = lastSeq else { return false }
        return seq != last + 1
    }
}
