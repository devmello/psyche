import Foundation
import PsycheShared

// The app's whole backend contract, one protocol per feature so parallel sessions never edit the
// same file (docs/design/ios-app-2026.md §4). Two implementations:
//   - `FixtureBackend` (PsycheStore/Fixtures): in memory, interactive, for previews, screenshots,
//     UI tests and running the app with no Gateway.
//   - `GatewayBackend` (PsycheClient, I2): the real one, over the WebSocket protocol.
// Reads return snapshots; writes return once the Gateway (or the outbox) accepted them; anything that
// changes later arrives as a `LiveEvent`.

public typealias PsycheBackend = AgentBackend & ChatBackend & HomeBackend & LibraryBackend & LiveUpdates
    & FollowupsBackend & GrantsBackend & MemoryBackend & ModelsBackend & ProactiveBackend & ReceiptsBackend & SearchBackend & SettingsBackend
    & SkillsBackend & SpacesBackend & VoiceMemoBackend & WidgetBackend

public enum BackendError: Error, Equatable, LocalizedError {
    /// Not reachable right now (away from home, Mac asleep). Writes that can wait go to the outbox.
    case unreachable
    /// The Gateway refused (permission, expired approval, unknown id). The message is the Gateway's.
    case refused(String)
    /// The Gateway's policy said no (`policy_denied`), such as a chat-only model picked for agent work. The
    /// message is the Gateway's; the caller can offer the owner a way past it.
    case policyDenied(String)
    case notFound
    /// This phone used its model budget (`rate_limited`, reason `model_budget`): wait this many whole minutes.
    case slowDown(minutes: Int)

    public var errorDescription: String? {
        switch self {
        case .unreachable: "Your Mac isn't reachable right now."
        case .refused(let message), .policyDenied(let message): message
        case .notFound: "That's no longer there."
        case .slowDown(let minutes): SlowDown.message(minutes: minutes)
        }
    }
}
