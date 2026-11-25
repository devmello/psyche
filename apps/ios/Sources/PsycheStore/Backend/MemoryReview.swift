import Foundation

// The review queue on the Memory tab: items the Mac held back from memory (memory.quarantine.*) and the senders it
// offers to trust (memory.senders.*). Excerpts and sender names come from outside sources: they are untrusted text,
// shown as plain text only and never as Markdown, links or data.

/// One item the Mac held back. The Mac's own wording for each reason is in the app, keyed by the wire id.
public struct HeldItem: Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    /// Where the item came from (the wire source id, such as "mail"). Shown as the Mac shows it.
    public var source: String
    /// The item's date as the Mac sends it (ISO 8601).
    public var createdAt: String
    /// Wire reason ids (instruction_like, hidden_text, ...). Unknown ids get the generic line.
    public var reasons: [String]
    /// Untrusted, truncated text from the item. Shown verbatim.
    public var excerpt: String
    /// The sender the item came from, when there is one. "Block sender" is offered only then.
    public var senderEntityID: String?

    public init(
        id: String, source: String, createdAt: String, reasons: [String], excerpt: String,
        senderEntityID: String? = nil
    ) {
        self.id = id
        self.source = source
        self.createdAt = createdAt
        self.reasons = reasons
        self.excerpt = excerpt
        self.senderEntityID = senderEntityID
    }
}

/// What the owner does with a held item (QuarantineAction on the wire).
public enum HeldItemAction: String, Sendable, Equatable {
    case release
    case discard
    case blockSender = "block_sender"
}

/// One page of held items still waiting for the owner, newest first.
public struct HeldItemsPage: Sendable, Equatable {
    public var items: [HeldItem]
    public var nextCursor: String?

    public init(items: [HeldItem], nextCursor: String?) {
        self.items = items
        self.nextCursor = nextCursor
    }
}

/// A contact the Mac offers to auto-accept from, or already does (SenderTrust on the wire).
public struct SenderTrustRow: Sendable, Equatable, Identifiable {
    public var entityID: String
    /// A display name from a mail header: untrusted text, shown verbatim.
    public var name: String
    /// Facts the owner confirmed from them, none discarded.
    public var confirmed: Int
    public var state: SenderState

    public var id: String { entityID }

    public init(entityID: String, name: String, confirmed: Int, state: SenderState) {
        self.entityID = entityID
        self.name = name
        self.confirmed = confirmed
        self.state = state
    }
}

public enum SenderState: String, Sendable, Equatable {
    case offered
    case trusted
}

/// The owner's answer about a sender (SenderTrustDecision on the wire).
public enum SenderDecision: String, Sendable, Equatable {
    case trust
    case decline
    case revoke
}
