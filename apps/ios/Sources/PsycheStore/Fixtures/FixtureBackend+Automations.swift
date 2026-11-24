import Foundation

// Automation create, edit and delete on the fixture, as the Gateway answers them. A seeded scheduled item with no
// stored automation reads back as a daily cron whose prompt is its summary.
extension FixtureBackend {
    public func automation(id: String) async throws -> AutomationDetail {
        await pause()
        if let found = proactiveState.automations.first(where: { $0.id == id }) { return found }
        guard let job = proactiveState.scheduled.items.first(where: { $0.id == id }), !job.isRoutine else { throw BackendError.notFound }
        return AutomationDetail(
            id: job.id, kind: "cron", title: job.title, prompt: job.summary, schedule: "0 9 * * *",
            timezone: TimeZone.current.identifier, enabled: job.state == "active")
    }

    public func createAutomation(_ create: AutomationCreate) async throws -> String {
        await pause()
        let id = "auto_\(UUID().uuidString.prefix(8).lowercased())"
        let detail = AutomationDetail(
            id: id, kind: create.kind, title: create.title, prompt: create.prompt, schedule: create.schedule,
            timezone: create.timezone, enabled: create.enabled)
        proactiveState.automations.append(detail)
        proactiveState.scheduled.items.append(Self.fixtureJob(from: detail))
        proactiveState.scheduled.upcoming = ScheduledOverview.upcomingOf(proactiveState.scheduled.items)
        return id
    }

    public func updateAutomation(id: String, changes: AutomationChanges) async throws {
        await pause()
        guard !changes.isEmpty else { return }
        var detail = try await automation(id: id)
        if let title = changes.title { detail.title = title }
        if let prompt = changes.prompt { detail.prompt = prompt }
        if let schedule = changes.schedule { detail.schedule = schedule }
        if let enabled = changes.enabled { detail.enabled = enabled }
        if let index = proactiveState.automations.firstIndex(where: { $0.id == id }) {
            proactiveState.automations[index] = detail
        } else {
            proactiveState.automations.append(detail)
        }
        if let index = proactiveState.scheduled.items.firstIndex(where: { $0.id == id }) {
            proactiveState.scheduled.items[index] = Self.fixtureJob(from: detail)
        }
        proactiveState.scheduled.upcoming = ScheduledOverview.upcomingOf(proactiveState.scheduled.items)
    }

    public func deleteAutomation(id: String) async throws {
        await pause()
        guard proactiveState.scheduled.items.contains(where: { $0.id == id }) else { throw BackendError.notFound }
        proactiveState.automations.removeAll { $0.id == id }
        proactiveState.scheduled.items.removeAll { $0.id == id }
        proactiveState.scheduled.upcoming = ScheduledOverview.upcomingOf(proactiveState.scheduled.items)
    }

    /// The scheduled row an automation shows as. A disabled one is paused, so Resume still works on it.
    static func fixtureJob(from detail: AutomationDetail) -> ScheduledJob {
        ScheduledJob(
            id: detail.id, title: detail.title, summary: String(detail.prompt.prefix(80)),
            state: detail.enabled ? "active" : "paused",
            nextRunAt: detail.enabled ? Date(timeIntervalSince1970: 1_900_100_000) : nil)
    }
}
