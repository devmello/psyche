import Foundation
import PsycheShared
import enum PsycheProtocol.JSONValue
import PsycheWire

/// One write waiting to go out.
public struct OutboxEntry: Codable, Sendable, Equatable, Identifiable {
    public enum Kind: String, Codable, Sendable, CaseIterable {
        case chatSend, uploadChunk, markRead

        /// The one Gateway method each kind may call. This is an allowlist: what goes on the wire is always
        /// `kind.method`, never a method string read back from the queue file.
        public var method: String {
            switch self {
            case .chatSend: "chat.send"
            case .uploadChunk: "library.upload"
            case .markRead: "notifications.markRead"
            }
        }
    }

    /// Also the idempotency key, so a resend after a lost acknowledgement is a no-op on the Gateway.
    public var id: String
    public var kind: Kind
    /// Kept for the file format; `Outbox` pins it to `kind.method` and the sender uses `kind.method`.
    public var method: String
    public var params: JSONValue
    public var enqueuedAt: Date
    /// The Gateway this write was made for: the fingerprint of the pinned Gateway at enqueue time. A flush to
    /// any other Gateway drops the entry instead of sending it.
    public var gateway: String?

    public init(
        id: String, kind: Kind, method: String, params: JSONValue, enqueuedAt: Date = .now, gateway: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.method = method
        self.params = params
        self.enqueuedAt = enqueuedAt
        self.gateway = gateway
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
    private var flushing = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var settled: [String: Delivery] = [:]
    /// Bumped by `wipe()`, so a send that was in flight across a wipe can tell and discard its result.
    private var generation = 0
    private var lastPersistError: (any Error)?

    /// `directory` nil keeps the queue in memory only (tests).
    public init(directory: URL?) {
        if let directory {
            fileURL = directory.appendingPathComponent("outbox.json")
            let data = try? Data(contentsOf: directory.appendingPathComponent("outbox.json"))
            let loaded = data.flatMap { try? JSONDecoder().decode([OutboxEntry].self, from: $0) } ?? []
            // The file can be edited: an entry whose method is not the one its kind may call is dropped.
            entries = loaded.filter { $0.method == $0.kind.method }
        } else {
            fileURL = nil
            entries = []
        }
    }

    public var pending: [OutboxEntry] { entries }
    public var isEmpty: Bool { entries.isEmpty }

    /// The error of the last failed write of the queue file; nil once a write succeeded.
    public var persistenceError: (any Error)? { lastPersistError }

    /// Adds an entry (ignored when one with the same id is already queued) and persists it. The method is
    /// pinned to the entry's kind. Returns the error when the queue file cannot be written (the entry stays
    /// queued in memory either way), so a caller can tell the person it may not survive a relaunch.
    @discardableResult
    public func enqueue(_ entry: OutboxEntry) -> (any Error)? {
        guard !entries.contains(where: { $0.id == entry.id }) else { return nil }
        var pinned = entry
        pinned.method = entry.kind.method
        entries.append(pinned)
        do { try persist() } catch { return error }
        return nil
    }

    /// Sends queued entries in order until one cannot go (offline) or all are done. Returns each
    /// entry's outcome. Only one flush runs at a time: a second call waits for the first and then runs
    /// its own, and an outcome the first one reached stays available through `takeOutcome(for:)`.
    ///
    /// With `gateway`, only entries made for that Gateway go out; the rest are dropped unsent (they were
    /// written for a Gateway this phone no longer trusts). Without it nothing is checked.
    @discardableResult
    public func flush(gateway: String? = nil, checkGateway: Bool = false, using send: Sender) async -> [String: Delivery] {
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
            if checkGateway, next.gateway != gateway {
                let outcome = Delivery.rejected("This message was written for a different Mac.")
                entries.removeAll { $0.id == next.id }
                try? persist()
                outcomes[next.id] = outcome
                settle(next.id, outcome)
                continue
            }
            let started = generation
            let outcome: Delivery
            do {
                outcome = .delivered(try await send(next))
            } catch OutboxSendError.rejected(let why) {
                outcome = .rejected(why)
            } catch {
                break  // retryLater / unreachable: keep order, try again on the next connect.
            }
            // A wipe may have run while the send was in flight: the entry is gone (or the queue now belongs to
            // a new pairing), so there is nothing to remove and no outcome to report for it.
            guard started == generation, entries.contains(where: { $0.id == next.id }) else { continue }
            entries.removeAll { $0.id == next.id }
            try? persist()
            outcomes[next.id] = outcome
            settle(next.id, outcome)
        }
        return outcomes
    }

    /// Takes one entry back out (a message whose queue file could not be written and that is not being sent now).
    public func discard(id: String) {
        entries.removeAll { $0.id == id }
        try? persist()
    }

    /// What happened to an entry some flush sent, once. A caller whose flush found another one running (the
    /// one that starts on connect) reads its entry's outcome here.
    public func takeOutcome(for id: String) -> Delivery? { settled.removeValue(forKey: id) }

    private func settle(_ id: String, _ delivery: Delivery) {
        if settled.count >= 200 { settled.removeAll() }  // outcomes nobody asked for must not pile up
        settled[id] = delivery
    }

    /// Revoked, unpaired or paired with another Gateway: nothing from the old pairing may reach a new one.
    public func wipe() {
        generation += 1
        entries.removeAll()
        settled.removeAll()
        if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
    }

    /// Writes the queue file. A failure keeps the in-memory queue, is remembered in `persistenceError` and
    /// thrown, so the caller can tell the person a queued message may not survive a relaunch.
    private func persist() throws {
        guard let fileURL else { return }
        do {
            try AppGroup.prepareDirectory(fileURL.deletingLastPathComponent())
            try JSONEncoder().encode(entries).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            lastPersistError = nil
        } catch {
            lastPersistError = error
            throw error
        }
    }
}
