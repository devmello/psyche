import Foundation

// Skills on the phone (Settings → Skills), read-only. Gateway method: skills.list (operator.read).
// Turning a skill on or off, installing and removing are admin settings (skills.setEnabled, skills.install,
// skills.remove need operator.admin), so they stay on the Mac: this backend has no writes.

public struct SkillItem: Sendable, Equatable, Identifiable {
    public var id: String { name }
    /// The skill folder name (`SKILL.md` frontmatter `name`).
    public var name: String
    public var description: String
    /// The effective state: the owner's switch and the gates (`enabled` on the Gateway).
    public var enabled: Bool

    public init(name: String, description: String, enabled: Bool) {
        self.name = name
        self.description = description
        self.enabled = enabled
    }
}

public protocol SkillsBackend: Sendable {
    /// Every skill the Gateway knows, in its order. Empty when the Gateway doesn't have the list.
    func skills() async throws -> [SkillItem]
}

extension SkillsBackend {
    public func skills() async throws -> [SkillItem] { [] }
}
