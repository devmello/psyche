import PsycheStore

/// How a message the user sent is doing. Only the user's own messages carry one.
public enum MessageDelivery: Equatable, Sendable {
    /// Waiting in the outbox; goes out when the Mac is reachable.
    case queued
    case failed(String)
}

/// What the blocks need from the screen around them: state to draw and what to do on a tap. The Chat
/// feature builds one per thread; the blocks never reach for the router or the backend themselves.
public struct BlockContext {
    /// Question id → the option picked (here, or by the Gateway).
    public var chosen: [String: String]
    /// False when the Mac can't take an answer right now (away from home).
    public var canAnswer: Bool
    /// Message id → delivery note.
    public var delivery: [String: MessageDelivery]
    public var choose: @MainActor (_ question: String, _ option: String) -> Void
    public var openApproval: @MainActor (NeedsYouItem) -> Void
    /// An app path such as `/goals/rent` or `/chat/thr_q3`.
    public var openRoute: @MainActor (String) -> Void
    public var openThread: @MainActor (String) -> Void
    public var openFile: @MainActor (String) -> Void
    public var retry: @MainActor (String) -> Void

    public init(
        chosen: [String: String] = [:],
        canAnswer: Bool = true,
        delivery: [String: MessageDelivery] = [:],
        choose: @escaping @MainActor (String, String) -> Void = { _, _ in },
        openApproval: @escaping @MainActor (NeedsYouItem) -> Void = { _ in },
        openRoute: @escaping @MainActor (String) -> Void = { _ in },
        openThread: @escaping @MainActor (String) -> Void = { _ in },
        openFile: @escaping @MainActor (String) -> Void = { _ in },
        retry: @escaping @MainActor (String) -> Void = { _ in }
    ) {
        self.chosen = chosen
        self.canAnswer = canAnswer
        self.delivery = delivery
        self.choose = choose
        self.openApproval = openApproval
        self.openRoute = openRoute
        self.openThread = openThread
        self.openFile = openFile
        self.retry = retry
    }
}
