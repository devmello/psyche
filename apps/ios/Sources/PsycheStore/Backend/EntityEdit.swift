import Foundation

// Editing a person's or project's card (memory.entities.update). The phone sends only the fields the owner
// changed. Rules here mirror the Gateway schema (packages/protocol/src/methods/memory.ts). Nothing in this file
// is user-visible text, so it has no string catalog; the sheet in PsycheFeatures owns the words.

/// A project's status, as memory.entities.update takes it.
public enum ProjectStatus: String, Sendable, Equatable, CaseIterable {
    case active, paused, done
}

/// The owner's new due date, or none. Absent from `EntityChanges` means "keep the current one".
public enum DueChange: Sendable, Equatable {
    case clear
    case set(Date)
}

/// The fields the phone changed on a card. Nil means unchanged and is never sent.
public struct EntityChanges: Sendable, Equatable {
    public var name: String?
    /// The whole new alias list; the Gateway replaces the list rather than merging it.
    public var aliases: [String]?
    public var projectStatus: ProjectStatus?
    public var dueAt: DueChange?

    public init(name: String? = nil, aliases: [String]? = nil, projectStatus: ProjectStatus? = nil, dueAt: DueChange? = nil) {
        self.name = name
        self.aliases = aliases
        self.projectStatus = projectStatus
        self.dueAt = dueAt
    }
}

/// The card as the Gateway last returned it: what the edit sheet starts from, and the if-match `etag`.
public struct EntityCard: Sendable, Equatable {
    public var name: String
    public var aliases: [String]
    public var projectStatus: ProjectStatus?
    public var dueAt: Date?
    public var etag: String?

    public init(name: String, aliases: [String], projectStatus: ProjectStatus? = nil, dueAt: Date? = nil, etag: String? = nil) {
        self.name = name
        self.aliases = aliases
        self.projectStatus = projectStatus
        self.dueAt = dueAt
        self.etag = etag
    }
}

/// The edit sheet's state and the rules Save follows. Pure, so the tests need no view.
public struct EntityEditDraft: Sendable, Equatable {
    /// The schema's limits (memory.entities.update: aliases maxItems 20, strings maxLength 200).
    public static let maxAliases = 20
    public static let maxLength = 200

    public let original: EntityCard
    public var name: String
    public var aliases: [String]
    public var projectStatus: ProjectStatus?
    public var dueAt: Date?

    public init(card: EntityCard) {
        original = card
        name = card.name
        aliases = card.aliases
        projectStatus = card.projectStatus
        dueAt = card.dueAt
    }

    public var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The name is non-empty and within the schema's length.
    public var nameIsValid: Bool { !trimmedName.isEmpty && trimmedName.count <= Self.maxLength }

    public var canAddAlias: Bool { aliases.count < Self.maxAliases }

    /// Adds an alias typed by the owner. Trims it, and refuses a blank, a duplicate (ignoring case), an
    /// over-long one, or a list already full. Returns whether it was added.
    @discardableResult
    public mutating func addAlias(_ raw: String) -> Bool {
        let alias = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !alias.isEmpty, alias.count <= Self.maxLength, canAddAlias else { return false }
        guard !aliases.contains(where: { $0.caseInsensitiveCompare(alias) == .orderedSame }) else { return false }
        aliases.append(alias)
        return true
    }

    public mutating func removeAlias(at index: Int) {
        guard aliases.indices.contains(index) else { return }
        aliases.remove(at: index)
    }

    /// The aliases as they will be sent: trimmed, with blanks and duplicates dropped, first spelling kept.
    public var cleanAliases: [String] {
        var out: [String] = []
        for alias in aliases.map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) }) where !alias.isEmpty {
            if !out.contains(where: { $0.caseInsensitiveCompare(alias) == .orderedSame }) { out.append(alias) }
        }
        return out
    }

    /// What changed against the card the sheet opened with. Nil when nothing did.
    public var changes: EntityChanges? {
        var out = EntityChanges()
        if trimmedName != original.name { out.name = trimmedName }
        if cleanAliases != original.aliases { out.aliases = cleanAliases }
        if let projectStatus, projectStatus != original.projectStatus { out.projectStatus = projectStatus }
        if dueAt != original.dueAt {
            out.dueAt = dueAt.map(DueChange.set) ?? .clear
        }
        return out == EntityChanges() ? nil : out
    }

    /// Save is allowed once something changed and the name is valid.
    public var canSave: Bool { nameIsValid && changes != nil }
}
