import Foundation

// Previews and screenshots: a few skills so Settings → Skills has rows to show.
extension FixtureBackend: SkillsBackend {
    public func skills() async throws -> [SkillItem] {
        [
            SkillItem(name: "daily-brief", description: "Summarises the day ahead each morning.", enabled: true),
            SkillItem(name: "draft-replies", description: "", enabled: false),
        ]
    }
}
