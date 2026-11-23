import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// Creating, editing and deleting automations over `automations.list`, `automations.create`, `automations.update` and
// `automations.delete`. The phone writes the same fields the Mac's form does; an update sends only what changed.
extension GatewayBackend {
    /// The automation behind a scheduled item. `automations.list` has no single-item read, so the list is filtered.
    public func automation(id: String) async throws -> AutomationDetail {
        let result = try await call("automations.list", .obj([:]))
        guard let wire = (result["automations"]?.array ?? []).first(where: { $0["id"]?.string == id }),
              let detail = Self.automationDetail(from: wire)
        else { throw BackendError.notFound }
        return detail
    }

    /// `automations.create` with a key per call, as Run now sends. The Mac's form sends no key.
    public func createAutomation(_ create: AutomationCreate) async throws -> String {
        let params: JSONValue = .obj([
            "kind": .string(create.kind),
            "title": .string(create.title),
            "schedule": .string(create.schedule),
            "prompt": .string(create.prompt),
            "timezone": .string(create.timezone),
            "enabled": .bool(create.enabled),
        ])
        let result = try await call("automations.create", params, key: "automation-create-\(UUID().uuidString)")
        guard let id = result["automation"]?["id"]?.string else { throw BackendError.notFound }
        return id
    }

    /// `automations.update` with only the changed fields. Nothing changed sends nothing.
    public func updateAutomation(id: String, changes: AutomationChanges) async throws {
        guard !changes.isEmpty else { return }
        var params: [String: JSONValue] = ["automationId": .string(id)]
        if let title = changes.title { params["title"] = .string(title) }
        if let prompt = changes.prompt { params["prompt"] = .string(prompt) }
        if let schedule = changes.schedule { params["schedule"] = .string(schedule) }
        if let enabled = changes.enabled { params["enabled"] = .bool(enabled) }
        _ = try await call("automations.update", .object(params))
    }

    public func deleteAutomation(id: String) async throws {
        _ = try await call("automations.delete", .obj(["automationId": .string(id)]))
    }

    static func automationDetail(from wire: JSONValue) -> AutomationDetail? {
        guard let id = wire["id"]?.string, let kind = wire["kind"]?.string, let title = wire["title"]?.string,
              let schedule = wire["schedule"]?.string
        else { return nil }
        return AutomationDetail(
            id: id, kind: kind, title: title, prompt: wire["prompt"]?.string ?? "", schedule: schedule,
            timezone: wire["timezone"]?.string ?? TimeZone.current.identifier, enabled: wire["enabled"]?.bool ?? true)
    }
}
