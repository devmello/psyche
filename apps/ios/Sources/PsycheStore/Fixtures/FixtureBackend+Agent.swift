import Foundation

/// The agent sheet's fixture state.
struct AgentState: Sendable {
    var nextUp = FixtureData.nextUp
    var recent = FixtureData.recent
}

extension FixtureBackend: AgentBackend {
    public func activity() async throws -> AgentActivity {
        await pause()
        return AgentActivity(
            needsYou: homeState.snapshot.needsYou, now: homeState.snapshot.running,
            nextUp: agentState.nextUp, recent: agentState.recent)
    }

    public func persona() async throws -> PersonaSummary { FixtureData.persona }

    public func cancelTask(id: String) async throws {
        guard let task = homeState.snapshot.running.first(where: { $0.id == id }) else { throw BackendError.notFound }
        homeState.snapshot.running.removeAll { $0.id == id }
        agentState.recent.insert(RecentRun(id: id, title: task.title, outcome: .cancelled, time: "now"), at: 0)
        publish(.changed(.activity))
        publish(.changed(.home))
    }
}

extension FixtureData {

    public static let nextUp: [UpcomingItem] = [
        UpcomingItem(id: "u1", title: "Morning brief", when: "Tomorrow 7:00 · every weekday"),
        UpcomingItem(id: "u2", title: "Check the PG&E payment cleared", when: "Fri 9:00"),
        UpcomingItem(id: "u3", title: "Remind you to leave for SFO", when: "Today 17:40"),
    ]

    public static let recent: [RecentRun] = [
        RecentRun(id: "r1", title: "Filed the expense report", outcome: .done, time: "Yesterday 16:02"),
        RecentRun(id: "r2", title: "Summarized the lease renewal", outcome: .done, time: "Oct 28"),
        RecentRun(id: "r3", title: "Looked up flight UA 1182", outcome: .done, time: "Oct 24"),
    ]

    public static let persona = PersonaSummary(
        name: "Psyche",
        summary: "Plain-spoken and brief. Asks before spending money or writing to anyone. Keeps you posted on Home, not with pings.",
        files: ["persona.md", "voice.md", "boundaries.md"])
}
