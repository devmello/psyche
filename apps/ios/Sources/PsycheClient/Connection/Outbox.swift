import Foundation
import enum PsycheProtocol.JSONValue
import PsycheWire

/// One write waiting to go out.
public struct OutboxEntry: Codable, Sendable, Equatable, Identifiable {
    public enum Kind: String, Codable, Sendable { case chatSend, uploadChunk, markRead }

    /// Also the idempotency key, so a resend after a lost acknowledgement is a no-op on the Gateway.
    public var id: String
    public var kind: Kind
    public var method: String
    public var params: JSONValue
    public var enqueuedAt: Date

    public init(id: String, kind: Kind, method: String, params: JSONValue, enqueuedAt: Date = .now) {
        self.id = id
        self.kind = kind
        self.method = method
        self.params = params
        self.enqueuedAt = enqueuedAt
    }
}

/// A durable FIFO of user-originated, idempotent writes (companion §2.3): `chat.send`, upload chunks
/// and mark-read. It is flushed in order on connect. Approvals are never queued: their token is
/// single-use and the approval can expire, so offline they say "Reconnect to answer".
///
/// Exactly-once is idempotency, not luck: an entry leaves the queue only after the Gateway
/// acknowledged it, and a resend carries the same key, which the Gateway answers with the original result.
public actor Outbox {
    public enum Delivery: Sendable, Equatable {
        /// Sent and acknowledged; `result` is the Gateway's response.
        case delivered(JSONValue)
        /// Waiting: offline, or behind an earlier entry that has not gone out.
        case queued
        /// The Gateway refused it for good (permission, bad params); it was dropped.
        case rejected(String)
    }

    /// Sends one entry. Throw `BackendError.unreachable`-style errors via `OutboxSendError.retryLater`.
    public typealias Sender = @Sendable (OutboxEntry) async throws -> JSONValue

    public enum OutboxSendError: Error { case retryLater, rejected(String) }

    private let fileURL: URL?
    private var entries: [OutboxEntry]
    private var results: [String: Delivery] = [:]
    private var flushing = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var settled: [String: Delivery] = [:]

    /// `directory` nil keeps the queue in memory only (tests).
    public init(directory: URL?) {
        if let directory {
            fileURL = directory.appendingPathComponent("outbox.json")
            let data = try? Data(contentsOf: directory.appendingPathComponent("outbox.json"))
            entries = data.flatMap { try? JSONDecoder().decode([OutboxEntry].self, from: $0) } ?? []
        } else {
            fileURL = nil
            entries = []
        }
    }

    public var pending: [OutboxEntry] { entries }
    public var isEmpty: Bool { entries.isEmpty }

    /// Adds an entry (ignored when one with the same id is already queued) and persists it.
    public func enqueue(_ entry: OutboxEntry) {
        guard !entries.contains(where: { $0.id == entry.id }) else { return }
        entries.append(entry)
        persist()
    }

    /// Sends queued entries in order until one cannot go (offline) or all are done. Returns each
    /// entry's outcome. Only one flush runs at a time: a second call waits for the first and then runs
    /// its own, and an outcome the first one reached stays available through `takeOutcome(for:)`.
    @discardableResult
    public func flush(using send: Sender) async -> [String: Delivery] {
        while flushing { await withCheckedContinuation { waiters.append($0) } }
        flushing = true
        defer {
            flushing = false
            let waiting = waiters
            waiters = []
            for waiter in waiting { waiter.resume() }
        }
        var outcomes: [String: Delivery] = [:]
        while let next = entries.first {
            do {
                let result = try await send(next)
                entries.removeAll { $0.id == next.id }  // by id: a wipe may have run while the send was in flight
                persist()
                outcomes[next.id] = .delivered(result)
                settle(next.id, .delivered(result))
            } catch OutboxSendError.rejected(let why) {
                entries.removeAll { $0.id == next.id }  // by id: a wipe may have run while the send was in flight
                persist()
                outcomes[next.id] = .rejected(why)
                settle(next.id, .rejected(why))
            } catch {
                break  // retryLater / unreachable: keep order, try again on the next connect.
            }
        }
        return outcomes
    }

    /// What happened to an entry some flush sent, once. A caller whose flush found another one running (the
    /// one that starts on connect) reads its entry's outcome here.
    public func takeOutcome(for id: String) -> Delivery? { settled.removeValue(forKey: id) }

    private func settle(_ id: String, _ delivery: Delivery) {
        if settled.count >= 200 { settled.removeAll() }  // outcomes nobody asked for must not pile up
        settled[id] = delivery
    }

    /// Revoked or unpaired: nothing from the old pairing may reach a new Gateway.
    public func wipe() {
        entries.removeAll()
        settled.removeAll()
        if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
    }

    private func persist() {
        guard let fileURL else { return }
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(entries).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            // A failed write keeps the in-memory queue; the next change tries again.
        }
    }
}
