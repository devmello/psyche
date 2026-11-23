import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// Skills (read-only on the phone): `skills.list` returns every discovered skill with its effective
// `enabled` state. Mapping only; the Mac owns the switch.
extension GatewayBackend {
    public func skills() async throws -> [SkillItem] {
        Self.skillItems(try await call("skills.list", .obj([:])))
    }

    static func skillItems(_ result: JSONValue) -> [SkillItem] {
        (result["skills"]?.array ?? []).compactMap { skill in
            guard let name = skill["name"]?.string, !name.isEmpty else { return nil }
            return SkillItem(
                name: name, description: skill["description"]?.string ?? "", enabled: skill["enabled"]?.bool ?? false)
        }
    }
}
