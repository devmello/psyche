import Foundation

// Live updates. One stream per subscriber; a model subscribes in `.task` and stops when the view goes.
// Chat events carry the content; everything else is a hint to refetch (push is a hint, not state:
// companion §2.3). Owner: the client-core session (I2); new topics are additive.

public protocol LiveUpdates: Sendable {
    func events() -> AsyncStream<LiveEvent>
}

public enum LiveEvent: Sendable, Equatable {
    case chat(ChatEvent)
    /// Something under this topic changed: refetch if it's on screen.
    case changed(LiveTopic)
    /// Reconnected and `stateVersion` moved: refetch everything visible (N14).
    case resynced
}

public enum LiveTopic: String, Sendable, Equatable, CaseIterable {
    case home, threads, library, memory, activity, settings
}
