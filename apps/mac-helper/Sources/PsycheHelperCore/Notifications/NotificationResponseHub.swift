import Foundation

/// Fans notification responses out to open `notify.subscribe` invocations. The protocol has no
/// unsolicited node→Gateway event, so responses ride a long-lived streaming invocation; while no
/// subscriber is attached (helper relaunched by a click, Gateway reconnecting) up to `capacity`
/// responses are buffered, dropping the oldest, and handed to the next subscriber.
public final class NotificationResponseHub: @unchecked Sendable {
    public static let defaultCapacity = 100

    public let capacity: Int
    private let lock = NSLock()
    private var buffer: [NotificationResponse] = []
    private var subscribers: [UInt64: AsyncStream<NotificationResponse>.Continuation] = [:]
    private var nextId: UInt64 = 0
    private var dropped = 0

    public init(capacity: Int = NotificationResponseHub.defaultCapacity) {
        self.capacity = max(1, capacity)
    }

    /// Responses waiting for a subscriber.
    public var pendingCount: Int { lock.withLock { buffer.count } }
    /// Responses dropped because the buffer was full.
    public var droppedCount: Int { lock.withLock { dropped } }
    public var subscriberCount: Int { lock.withLock { subscribers.count } }

    public func publish(_ response: NotificationResponse) {
        lock.lock()
        defer { lock.unlock() }
        var delivered = false
        for (id, c) in subscribers {
            if case .terminated = c.yield(response) {
                // Consumer went away but its termination handler has not run yet.
                subscribers.removeValue(forKey: id)
            } else {
                delivered = true
            }
        }
        guard !delivered else { return }
        buffer.append(response)
        if buffer.count > capacity {
            let excess = buffer.count - capacity
            buffer.removeFirst(excess)
            dropped += excess
        }
    }

    /// A stream of responses: everything buffered first, then live ones. Ends when the consuming
    /// task is cancelled (the invocation was cancelled or the connection dropped).
    public func subscribe() -> AsyncStream<NotificationResponse> {
        let (stream, continuation) = AsyncStream.makeStream(of: NotificationResponse.self, bufferingPolicy: .bufferingNewest(capacity))
        lock.lock()
        let id = nextId
        nextId += 1
        continuation.onTermination = { [weak self] _ in self?.remove(id) }
        subscribers[id] = continuation
        for r in buffer { continuation.yield(r) }
        buffer.removeAll()
        lock.unlock()
        return stream
    }

    private func remove(_ id: UInt64) {
        lock.withLock { _ = subscribers.removeValue(forKey: id) }
    }
}
