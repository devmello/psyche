import Foundation

/// Offline TCC pre-grant for the guest helper (L3; spike 06 "TCC rows that work"): SIP blocks
/// in-guest writes to the system `TCC.db`, so the host writes the rows while the guest is stopped
/// and its Data volume is mounted. One row per service for the guest helper's bundle id, bound to
/// its designated requirement (`csreq`), so only that signed binary gets the grant.
public enum GuestTCC {
    public static let services = ["kTCCServiceAccessibility", "kTCCServiceScreenCapture"]
    public static let dbPath = "Library/Application Support/com.apple.TCC/TCC.db"

    public struct Client: Sendable, Equatable {
        /// Bundle id (client_type 0) of the guest helper.
        public var bundleId: String
        /// Compiled designated requirement (`csreq -b`).
        public var csreq: Data

        public init(bundleId: String, csreq: Data) {
            self.bundleId = bundleId
            self.csreq = csreq
        }
    }

    static func quote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "''") + "'" }

    /// `INSERT OR REPLACE` statements filling only the `access` columns this guest's schema has
    /// (`PRAGMA table_info(access)`; 27.0.1 adds reminder columns).
    public static func statements(client: Client, columns: Set<String>, now: Date = Date()) throws -> [String] {
        let required: Set = ["service", "client", "client_type", "auth_value", "auth_reason", "auth_version", "csreq"]
        guard required.isSubset(of: columns) else {
            throw CapabilityError(.unavailable, reason: "tcc_schema", "The guest's TCC database has an unexpected schema")
        }
        guard client.bundleId.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x2E || $0 == 0x2D }) else {
            throw CapabilityError.invalidParams("bad bundle id")
        }
        let hex = client.csreq.map { String(format: "%02X", $0) }.joined()
        return services.map { service in
            var values: [(String, String)] = [
                ("service", quote(service)), ("client", quote(client.bundleId)), ("client_type", "0"), ("auth_value", "2"),
                ("auth_reason", "4"), ("auth_version", "1"), ("csreq", "X'\(hex)'"),
            ]
            let optional: [(String, String)] = [
                ("policy_id", "NULL"), ("indirect_object_identifier_type", "NULL"), ("indirect_object_identifier", quote("UNUSED")),
                ("indirect_object_code_identity", "NULL"), ("flags", "0"), ("last_modified", String(Int(now.timeIntervalSince1970))),
                ("pid", "NULL"), ("pid_version", "NULL"), ("boot_uuid", quote("UNUSED")), ("last_reminded", "0"),
            ]
            values += optional.filter { columns.contains($0.0) }
            return "INSERT OR REPLACE INTO access (\(values.map(\.0).joined(separator: ", "))) VALUES (\(values.map(\.1).joined(separator: ", ")));"
        }
    }
}
