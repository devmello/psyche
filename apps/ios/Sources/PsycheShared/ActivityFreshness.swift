import Foundation

// What a Live Activity may claim when nothing has updated it for a while. Pure logic, shared by the app (which
// picks each update's `staleDate`) and the Widgets extension (which draws `context.isStale`), so both agree.
//
// Without Gateway push the activity only changes while Psyche runs. Every update therefore carries a stale date;
// once it passes iOS sets `isStale` and the views say so instead of showing old state as current. A stale
// approval never shows Approve or Deny: answering one that may already be resolved goes through the app, which
// re-checks it with the Gateway first (`AlertCenter.answerFromIsland`).

public enum ActivityFreshness {
    /// While Psyche is awake (open, or kept connected by "Stay connected while a task runs") a live connection
    /// is vouching for the state, so the stale date is further out and is pushed forward before it passes.
    public static let staleAfterAwake: TimeInterval = 12 * 60
    /// While the app is not awake nothing can refresh the activity: a short fuse (2 to 5 minutes).
    public static let staleAfterAsleep: TimeInterval = 4 * 60
    /// An awake app moves the stale date forward this long before it passes.
    public static let refreshLead: TimeInterval = 90

    public static func staleDelay(awake: Bool) -> TimeInterval { awake ? staleAfterAwake : staleAfterAsleep }

    /// The stale date to attach to an update made at `lastUpdate`.
    public static func staleDate(lastUpdate: Date, awake: Bool) -> Date {
        lastUpdate.addingTimeInterval(staleDelay(awake: awake))
    }

    /// When an awake app should move the stale date forward again, given the one it set last.
    public static func refreshTime(forStaleDate staleDate: Date) -> Date {
        staleDate.addingTimeInterval(-refreshLead)
    }
}

/// What the views draw for a content state, given whether iOS has marked it stale.
public struct ActivityPresentation: Equatable, Sendable {
    /// "May be out of date · open Psyche" replaces the status line.
    public var showsStaleNotice: Bool
    /// Deny and Approve in the expanded island. Never when stale.
    public var showsInlineAnswer: Bool
    /// A tap-through to the app for an approval ("Review…", or "Open Psyche" when stale).
    public var showsOpenLink: Bool
    /// The bar or ring counts toward `estimatedEnd` on its own (`ProgressView(timerInterval:)`).
    public var showsEstimate: Bool

    public init(content: TaskActivityContent, isStale: Bool) {
        let ended = content.status == .done || content.status == .failed
        let stale = isStale && !ended
        showsStaleNotice = stale
        showsInlineAnswer = !stale && content.answersInline
        showsOpenLink = content.status == .needsApproval && !(!stale && content.answersInline)
        // An estimate is a promise about the future; stale, nothing backs it any more.
        showsEstimate = !stale && !ended && content.progressBasis == .estimate
    }
}
