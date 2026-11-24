import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// Cancelling a waiting recovery from its notice (docs/design/security-state-integrity-2026.md §7.3).
// `security.state.get` is `operator.read`; `security.recoveries.cancel` is `operator.admin` with no presence step
// (it only narrows). The phone shows the button only when the scopes it was granted at connect include admin, and
// the Gateway checks them again on the call. Approving stays on the Mac: it needs a fresh-presence approval.
extension GatewayBackend {
    public func canCancelRecoveries() async -> Bool {
        await client.ownIdentity.scopes.contains("operator.admin")
    }

    public func cancelRecovery(for notice: RecoveryNotice) async throws -> RecoveryCancelOutcome {
        let state = try await call("security.state.get", .obj([:]))
        let ids = Self.waitingRecoveryIDs(matching: notice, in: state)
        guard !ids.isEmpty else { return .nothingWaiting }
        var cancelled = 0
        for id in ids {
            _ = try await call("security.recoveries.cancel", .obj(["id": .string(id)]), key: "cancel-recovery-\(id)")
            cancelled += 1
        }
        return .cancelled(cancelled)
    }

    /// The notice carries the op, the device's name and the start of its key's fingerprint, not the recovery's id,
    /// so the phone matches on those. Every waiting request that fits is the one the notice describes (the same
    /// op for the same key), and cancelling only narrows, so all of them are cancelled. A notice that names a key
    /// matches nothing whose key differs or is missing.
    static func waitingRecoveryIDs(matching notice: RecoveryNotice, in state: JSONValue) -> [String] {
        let ops = [
            "approve": "devices.approve", "grant": "devices.grant",
            "presence": "presence.reset", "seal": "seal.reset",
        ]
        guard let op = ops[notice.op] else { return [] }
        return (state["recoveries"]?.array ?? []).compactMap { r in
            guard r["status"]?.string == "waiting", r["op"]?.string == op, let id = r["id"]?.string else { return nil }
            if op == "devices.approve" || op == "devices.grant" {
                if let key = notice.key {
                    let fingerprint = (r["deviceFingerprint"]?.string ?? "").replacingOccurrences(of: "sha256:", with: "")
                    guard fingerprint.hasPrefix(key) else { return nil }
                } else if let device = notice.device, r["deviceName"]?.string != device {
                    return nil
                }
            }
            return id
        }
    }
}
