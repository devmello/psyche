import Foundation

// Night shift (docs/design/night-shift-2026.md §5.2): overnight Psyche prepares changes (reply drafts, calendar fixes,
// filed documents, reminders) and runs none of them. The owner reviews them in the morning, ticks what they want and
// taps one Apply, which is one plain-tap `staged_apply` approval. Gateway methods: nightShift.status, review.get, apply,
// dismiss, approvals.answer. The phone has no Channels, Plugins or Vault screens; Night shift settings stay on the Mac.
//
// Everything the phone draws comes from the Gateway's item data and nothing else, as plain text (never markdown, never a
// link). A mail item's text is another person's, so it is read as untrusted.

public protocol NightShiftBackend: Sendable {
    /// Whether Night shift is on, and the review waiting for the owner, if any. Never throws for "off".
    func nightShiftStatus() async throws -> NightShiftStatus
    /// One night's review with its prepared items.
    func nightShiftReview(id: String) async throws -> NightShiftReview
    /// Requests the one approval for what was ticked and, when this phone may answer it, answers it. Before the answer
    /// it checks that the approval binds exactly the calls that were ticked (`NightShiftApplyError.mismatch` when not).
    func applyNightShift(_ request: NightShiftApplyRequest) async throws -> NightShiftApplyOutcome
    /// Requests the approval that undoes applied items (within a day) and answers it. The approval must list exactly the
    /// items asked for. An undo the Gateway refuses at run time leaves the item applied, with its reason.
    func undoNightShift(itemIDs: [String]) async throws -> NightShiftApplyOutcome
    /// Dismisses the given items, or every item still ready when `itemIDs` is nil. Runs nothing.
    func dismissNightShift(reviewID: String, itemIDs: [String]?) async throws
}

public enum NightShiftDomain: String, Sendable, Equatable, CaseIterable {
    case mail, calendar, reminders, files
}

public enum NightShiftItemStatus: String, Sendable, Equatable {
    case ready, stale, superseded, applied, failed, uncertain, skipped, dismissed, expired, undone
}

/// Counts per domain, for the Home card ("3 reply drafts · 2 calendar fixes").
public struct NightShiftCounts: Sendable, Equatable {
    public var mail: Int
    public var calendar: Int
    public var reminders: Int
    public var files: Int

    public init(mail: Int = 0, calendar: Int = 0, reminders: Int = 0, files: Int = 0) {
        self.mail = mail
        self.calendar = calendar
        self.reminders = reminders
        self.files = files
    }

    public var total: Int { mail + calendar + reminders + files }

    public func count(_ domain: NightShiftDomain) -> Int {
        switch domain {
        case .mail: mail
        case .calendar: calendar
        case .reminders: reminders
        case .files: files
        }
    }
}

public struct NightShiftStatus: Sendable, Equatable {
    public var enabled: Bool
    public var counts: NightShiftCounts
    /// The night with a review in `ready` or `partial`. Nil: nothing to show (the card is not drawn).
    public var readyReviewID: String?
    public var expiresAt: Date?

    public init(enabled: Bool, counts: NightShiftCounts = NightShiftCounts(), readyReviewID: String? = nil, expiresAt: Date? = nil) {
        self.enabled = enabled
        self.counts = counts
        self.readyReviewID = readyReviewID
        self.expiresAt = expiresAt
    }
}

/// One row of an item's preview, in the order the Gateway sends them (`StagedPreview.rows`). Plain text. A calendar change
/// carries its before and after inside `value` ("9:00 -> 9:30").
public struct NightShiftRow: Sendable, Equatable {
    public enum Badge: String, Sendable, Equatable {
        /// An address the owner has never written to.
        case newRecipient = "new_recipient"
        /// The draft answers everyone on the thread.
        case replyAll = "reply_all"
    }

    public var label: String
    public var value: String
    /// `value` is a shortened form of the real text.
    public var truncated: Bool
    public var badge: Badge?

    public init(label: String, value: String, truncated: Bool = false, badge: Badge? = nil) {
        self.label = label
        self.value = value
        self.truncated = truncated
        self.badge = badge
    }
}

/// A send waiting under a reply draft: its own box, bound to the saved draft's content.
public struct NightShiftSend: Sendable, Equatable {
    public var recipients: [String]
    /// What the owner's tick is bound to (`sends[].sendHash` on apply).
    public var contentHash: String

    public init(recipients: [String], contentHash: String) {
        self.recipients = recipients
        self.contentHash = contentHash
    }
}

public struct NightShiftItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var domain: NightShiftDomain
    public var status: NightShiftItemStatus
    /// The Gateway's tool name (`mail_draft`, `gmail_create_draft`, ...): decides whether a send may be offered.
    public var tool: String
    /// One line. Mail-derived text is untrusted. For a withheld item it is the Gateway's English fallback; the screen
    /// draws its own localized line instead.
    public var summary: String
    /// One sentence from the Gateway, already stripped of owner-only sources; never an instruction.
    public var why: String?
    /// The call's binding hash: what the `staged_apply` approval's child is bound to.
    public var bindingHash: String
    /// Built from other people's mail: the row says so.
    public var untrusted: Bool
    /// Made from the owner's Messages: this phone saw only a generic line, and the Gateway refuses an apply or undo of
    /// it from here. The Mac applies it.
    public var withheldMessages: Bool
    /// The preview's rows, as sent.
    public var rows: [NightShiftRow]
    /// Some row was shortened: the whole draft must be opened before its send box can be ticked.
    public var truncated: Bool
    /// The whole draft text, when the item carries it. Nil with `truncated` keeps the send box off for good.
    public var fullBody: String?
    public var send: NightShiftSend?
    /// Its details are too large to show here: read and apply it on the Mac.
    public var needsMac: Bool
    /// `approvalId` is set on a ready item: an apply is open for it right now.
    public var applying: Bool
    /// The Gateway's note on the result: why it is stale, failed or refused to undo.
    public var reason: String?
    /// A send of this draft went (`result.refs` holds `sent:<draftId>`).
    public var sent: Bool
    /// Applied less than a day ago with an inverse recorded: Undo may be offered.
    public var canUndo: Bool

    public init(
        id: String, domain: NightShiftDomain, status: NightShiftItemStatus = .ready, tool: String = "mail_draft",
        summary: String, why: String? = nil, bindingHash: String, untrusted: Bool = false, withheldMessages: Bool = false,
        rows: [NightShiftRow] = [], truncated: Bool = false, fullBody: String? = nil, send: NightShiftSend? = nil,
        needsMac: Bool = false, applying: Bool = false, reason: String? = nil, sent: Bool = false, canUndo: Bool = false
    ) {
        self.id = id
        self.domain = domain
        self.status = status
        self.tool = tool
        self.summary = summary
        self.why = why
        self.bindingHash = bindingHash
        self.untrusted = untrusted
        self.withheldMessages = withheldMessages
        self.rows = rows
        self.truncated = truncated
        self.fullBody = fullBody
        self.send = send
        self.needsMac = needsMac
        self.applying = applying
        self.reason = reason
        self.sent = sent
        self.canUndo = canUndo
    }

    /// The draft is a new Apple Mail draft: the only kind whose saved draft can be read back and checked before a send.
    /// Gmail drafts and replies are refused by the Gateway with a reason, so no send box is offered for them.
    public var canOfferSend: Bool {
        guard send != nil else { return false }
        let bare = tool.split(separator: "__").last.map(String.init) ?? tool
        return bare == "mail_draft" || bare == "mail_create_draft"
    }

    public var newRecipient: Bool { rows.contains { $0.badge == .newRecipient } }
    public var replyAll: Bool { rows.contains { $0.badge == .replyAll } }

    /// Only a `ready` item that can be read in full here, with no apply open for it, may be ticked. Stale, superseded,
    /// failed and the rest cannot, and neither can one that needs the Mac or was withheld from this phone.
    public var canTick: Bool { status == .ready && !needsMac && !withheldMessages && !applying }

    /// The draft can be read in full: its preview is not cut, or the whole text is here.
    public var hasFullText: Bool { !truncated || fullBody != nil }
}

public struct NightShiftReview: Sendable, Equatable {
    public var id: String
    /// Local date of the night, `YYYY-MM-DD`.
    public var night: String
    public var expiresAt: Date?
    public var items: [NightShiftItem]

    public init(id: String, night: String, expiresAt: Date? = nil, items: [NightShiftItem]) {
        self.id = id
        self.night = night
        self.expiresAt = expiresAt
        self.items = items
    }
}

/// One ticked call: the item and the hash the owner saw it with. A send also carries the recipients the owner saw, which
/// the approval's `<itemId>:send` row must repeat.
public struct NightShiftTick: Sendable, Equatable {
    public var itemID: String
    public var hash: String
    public var recipients: [String]

    public init(itemID: String, hash: String, recipients: [String] = []) {
        self.itemID = itemID
        self.hash = hash
        self.recipients = recipients
    }
}

public struct NightShiftApplyRequest: Sendable, Equatable {
    public var reviewID: String
    public var items: [NightShiftTick]
    /// Sends are separate from `items`: ticking every item never sends.
    public var sends: [NightShiftTick]

    public init(reviewID: String, items: [NightShiftTick], sends: [NightShiftTick]) {
        self.reviewID = reviewID
        self.items = items
        self.sends = sends
    }

    public var isEmpty: Bool { items.isEmpty }
}

public struct NightShiftRefusal: Sendable, Equatable {
    public var itemID: String
    public var reason: String

    public init(itemID: String, reason: String) {
        self.itemID = itemID
        self.reason = reason
    }
}

public enum NightShiftApplyOutcome: Sendable, Equatable {
    /// The approval was answered; the Gateway runs the calls. `refused` items were left out by the Gateway.
    case answered(refused: [NightShiftRefusal])
    /// The approval can't be answered from the phone (details too large, or it is a payment): answer it on the Mac.
    /// Nothing was sent to `approvals.answer`.
    case needsMac(refused: [NightShiftRefusal])
    /// Nothing was left to approve: every ticked item was refused.
    case nothingApproved(refused: [NightShiftRefusal])
}

public enum NightShiftApplyError: Error, Equatable {
    /// The approval does not bind exactly the calls that were ticked. Nothing was answered. The screen words it in the
    /// app's language (this target has no string catalog).
    case mismatch
}

/// The review screen's ticks and the rules that decide what may be ticked. Plain values, so the rules are tested off the
/// device:
///  - only a `ready` item that fits on the phone can be ticked;
///  - Select all ticks items only, never a send;
///  - a send box is its own tick, off by default, and needs its draft ticked;
///  - when the preview is cut short, the send box stays off until the full text was opened (and only if it is there);
///  - an item the Gateway refused can't be ticked again.
public struct NightShiftSelection: Sendable, Equatable {
    public private(set) var ticked: Set<String> = []
    public private(set) var sendTicked: Set<String> = []
    public private(set) var expanded: Set<String> = []
    public private(set) var refused: [String: String] = [:]

    public init() {}

    public func canTick(_ item: NightShiftItem) -> Bool {
        item.canTick && refused[item.id] == nil
    }

    /// A send needs its draft ticked, and the whole draft read when the preview was cut short.
    public func canTickSend(_ item: NightShiftItem) -> Bool {
        guard item.canOfferSend, canTick(item), ticked.contains(item.id) else { return false }
        return !item.truncated || (item.fullBody != nil && expanded.contains(item.id))
    }

    public mutating func toggle(_ item: NightShiftItem) {
        if ticked.contains(item.id) {
            ticked.remove(item.id)
            sendTicked.remove(item.id)
        } else if canTick(item) {
            ticked.insert(item.id)
        }
    }

    public mutating func toggleSend(_ item: NightShiftItem) {
        if sendTicked.contains(item.id) {
            sendTicked.remove(item.id)
        } else if canTickSend(item) {
            sendTicked.insert(item.id)
        }
    }

    /// Ticks every item that can be ticked. It never ticks a send, and it leaves sends already ticked as they are.
    public mutating func selectAll(_ items: [NightShiftItem]) {
        for item in items where canTick(item) { ticked.insert(item.id) }
    }

    public mutating func clear() {
        ticked = []
        sendTicked = []
    }

    /// The owner opened the full draft text. Counts only when the item carries the full text.
    public mutating func expand(_ item: NightShiftItem) {
        if item.fullBody != nil { expanded.insert(item.id) }
    }

    /// Items the Gateway left out of the approval can't be ticked again; they leave the selection.
    public mutating func markRefused(_ refusals: [NightShiftRefusal]) {
        for refusal in refusals {
            refused[refusal.itemID] = refusal.reason
            ticked.remove(refusal.itemID)
            sendTicked.remove(refusal.itemID)
        }
    }

    /// Drops ticks for items that are no longer tickable in a fresh read (an item went stale or was applied elsewhere).
    public mutating func reconcile(with items: [NightShiftItem]) {
        let live = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        for id in ticked where live[id].map({ !canTick($0) }) ?? true { ticked.remove(id) }
        for id in sendTicked where live[id].map({ !canTickSend($0) }) ?? true { sendTicked.remove(id) }
        expanded.formIntersection(live.keys)
    }

    /// The request for what is ticked now, with each hash taken from the item as it is shown.
    public func request(reviewID: String, items: [NightShiftItem]) -> NightShiftApplyRequest {
        var picked: [NightShiftTick] = []
        var sends: [NightShiftTick] = []
        for item in items where ticked.contains(item.id) && canTick(item) {
            picked.append(NightShiftTick(itemID: item.id, hash: item.bindingHash))
            if sendTicked.contains(item.id), canTickSend(item), let send = item.send {
                sends.append(NightShiftTick(itemID: item.id, hash: send.contentHash, recipients: send.recipients))
            }
        }
        return NightShiftApplyRequest(reviewID: reviewID, items: picked, sends: sends)
    }
}
