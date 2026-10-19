import Foundation

/// Single-consumer queue of pushed audio chunks (`speech.audio_push` → `speech.transcribe_stream`).
///
/// Producers call `push` from any thread; the transcription pipeline awaits `next()`. Backpressure:
/// a push that would take the unconsumed bytes over `limitBytes` is refused (the caller retries after
/// the engine catches up) instead of growing memory without bound. `finish()` lets the consumer drain
/// what is queued and then see `nil`; `cancel()` drops the queue and ends it at once.
public final class PushAudioBuffer: @unchecked Sendable {
    public enum PushError: Error, Equatable, Sendable {
        /// `finish()` or `cancel()` already ran.
        case finished
        /// Accepting the chunk would exceed the limit.
        case overflow(buffered: Int, limit: Int)
    }

    public let limitBytes: Int

    private let lock = NSLock()
    private var queue: [Data] = []
    private var head = 0
    private var buffered = 0
    private var total = 0
    private var finished = false
    private var waiter: CheckedContinuation<Data?, Never>?

    public init(limitBytes: Int = SpeechLimits.pushBufferLimitBytes) {
        self.limitBytes = max(1, limitBytes)
    }

    /// Unconsumed bytes queued right now.
    public var bufferedBytes: Int { lock.withLock { buffered } }
    /// Bytes accepted since creation.
    public var totalPushedBytes: Int { lock.withLock { total } }
    public var isFinished: Bool { lock.withLock { finished } }

    /// Queues `data` (empty data is allowed, e.g. a bare `final: true`) and, when `final`, finishes
    /// the stream after it. Returns the unconsumed byte count after the push.
    @discardableResult
    public func push(_ data: Data, final: Bool = false) throws(PushError) -> Int {
        lock.lock()
        if finished {
            lock.unlock()
            throw .finished
        }
        if !data.isEmpty, buffered + data.count > limitBytes {
            let current = buffered
            lock.unlock()
            throw .overflow(buffered: current, limit: limitBytes)
        }
        var resume: (CheckedContinuation<Data?, Never>, Data?)?
        if !data.isEmpty {
            total += data.count
            if let w = waiter {
                waiter = nil
                resume = (w, data)
            } else {
                queue.append(data)
                buffered += data.count
            }
        }
        if final {
            finished = true
            if resume == nil, let w = waiter {
                waiter = nil
                resume = (w, nil)
            }
        }
        let now = buffered
        lock.unlock()
        resume.map { $0.0.resume(returning: $0.1) }
        return now
    }

    /// No more pushes; the consumer drains the queue and then gets `nil`.
    public func finish() {
        let w: CheckedContinuation<Data?, Never>? = lock.withLock {
            finished = true
            defer { waiter = nil }
            return head < queue.count ? nil : waiter
        }
        w?.resume(returning: nil)
    }

    /// Ends the stream now, dropping anything queued.
    public func cancel() {
        let w: CheckedContinuation<Data?, Never>? = lock.withLock {
            finished = true
            queue.removeAll()
            head = 0
            buffered = 0
            defer { waiter = nil }
            return waiter
        }
        w?.resume(returning: nil)
    }

    /// Next chunk in push order, or `nil` once finished and drained. Single consumer. Cancelling the
    /// waiting task cancels the buffer.
    public func next() async -> Data? {
        await withTaskCancellationHandler {
            await withCheckedContinuation { (c: CheckedContinuation<Data?, Never>) in
                lock.lock()
                if head < queue.count {
                    let d = queue[head]
                    head += 1
                    buffered -= d.count
                    if head > 64, head * 2 > queue.count {
                        queue.removeFirst(head)
                        head = 0
                    }
                    lock.unlock()
                    c.resume(returning: d)
                } else if finished {
                    lock.unlock()
                    c.resume(returning: nil)
                } else {
                    precondition(waiter == nil, "PushAudioBuffer supports a single consumer")
                    waiter = c
                    lock.unlock()
                }
            }
        } onCancel: {
            cancel()
        }
    }
}
