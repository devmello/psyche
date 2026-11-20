import Foundation
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

// The Live Activity for a chat reply that runs long (companion §3.6, "M2-lite"). The app and the Widgets
// extension both compile this. Like the task activity it is started, updated and ended by the app itself over
// its live Gateway connection: there is no APNs on a free signing path, so nothing here relies on a push.
//
// What it may show, and where (the same privacy tiers as `TaskActivityContent`):
// - Lock Screen: "Psyche is replying" and a timer. The chat's title and the latest status appear when the owner
//   opts in ("Task titles on the Lock Screen"), or otherwise only while the phone is unlocked.
// - Dynamic Island (unlocked only): the chat's title and the latest status line too.
// Never message text, tool arguments or results. The status line is a tool's one-line summary or the Gateway's own
// status text, the same lines the thread screen already shows.

public enum ChatTurnPhase: String, Codable, Hashable, Sendable {
    /// The run started and nothing has streamed yet.
    case thinking
    /// The reply is streaming in.
    case writing
    /// A tool is running.
    case working
    /// The run is waiting for an approval or an answer from the owner.
    case waiting
    case done
    case failed

    public var isEnded: Bool { self == .done || self == .failed }
}

public struct ChatTurnContent: Codable, Hashable, Sendable {
    public var phase: ChatTurnPhase
    /// When the reply started, for the timer (`Text(timerInterval:)` counts by itself).
    public var startedAt: Date
    /// Set once the reply finished or failed, so the timer stops.
    public var endedAt: Date?
    /// The chat's title: present only with Settings -> "Task titles on the Lock Screen" on.
    public var title: String?
    /// The chat's title for the Dynamic Island and an unlocked card.
    public var islandTitle: String?
    /// The latest short status ("Reading 12 files"). Unlocked only, like `islandTitle`.
    public var detail: String?

    public init(
        phase: ChatTurnPhase, startedAt: Date, endedAt: Date? = nil, title: String? = nil, islandTitle: String? = nil,
        detail: String? = nil
    ) {
        self.phase = phase
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.title = title
        self.islandTitle = islandTitle
        self.detail = detail
    }

    /// What the Lock Screen card may say: the opted-in title and status always, otherwise only on an unlocked
    /// phone (`locked` is iOS's `.privacy` redaction). Locked and not opted in, the card says "Psyche is replying"
    /// and its timer, nothing more.
    public func lockScreenText(locked: Bool) -> (title: String?, detail: String?) {
        if let title { return (title, detail) }
        guard !locked else { return (nil, nil) }
        return (islandTitle, detail)
    }

    /// The same content with the opted-out fields removed, for a future Gateway push (companion §3.6).
    public var forPush: ChatTurnContent {
        var copy = self
        copy.islandTitle = nil
        copy.detail = nil
        return copy
    }

    /// The final state shown briefly when the reply ends.
    public func finished(failed: Bool, at end: Date) -> ChatTurnContent {
        var copy = self
        copy.phase = failed ? .failed : .done
        copy.endedAt = max(end, startedAt)
        copy.detail = nil
        return copy
    }

    /// The deep link a tap on the activity follows; `Route(appPath:)` maps `/chat/<id>`.
    public static func url(forThread id: String) -> URL? {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove("/")
        guard let escaped = id.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: "psyche://chat/\(escaped)")
    }
}

/// What the views draw for a content state, given whether iOS has marked it stale.
public struct ChatTurnPresentation: Equatable, Sendable {
    /// "May be out of date · open Psyche" replaces the status line.
    public var showsStaleNotice: Bool
    /// The timer keeps counting (a stale or ended activity stops claiming the reply is going on right now).
    public var timerIsLive: Bool

    public init(content: ChatTurnContent, isStale: Bool) {
        let ended = content.phase.isEnded
        showsStaleNotice = isStale && !ended
        timerIsLive = !ended
    }
}

#if canImport(ActivityKit) && os(iOS)
public struct PsycheChatTurnAttributes: ActivityAttributes {
    public typealias ContentState = ChatTurnContent

    public var threadID: String

    public init(threadID: String) {
        self.threadID = threadID
    }
}
#endif
