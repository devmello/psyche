import Foundation
import PsycheProtocol

/// Machine reasons (`details.reason`) for speech failures.
public enum SpeechErrors {
    public static let microphoneBusy = CapabilityError(
        .conflict, reason: "microphone_busy", "Another speech stream is already using the microphone")

    public static func streamExists(_ id: String) -> CapabilityError {
        CapabilityError(.conflict, reason: "stream_exists", "A speech stream with this id is already running", details: ["streamId": .string(id)])
    }

    public static let tooManyStreams = CapabilityError(
        .rateLimited, reason: "too_many_streams", "Too many speech streams are running", retryable: true)

    /// Retryable: a push can race the start of its `speech.transcribe_stream` invocation.
    public static func streamNotFound(_ id: String) -> CapabilityError {
        CapabilityError(.notFound, reason: "stream_not_found", "No active speech stream with this id", details: ["streamId": .string(id)], retryable: true)
    }

    public static let notPushStream = CapabilityError(
        .conflict, reason: "not_push_stream", "This speech stream reads the microphone; it does not accept pushed audio")

    public static let streamFinished = CapabilityError(
        .conflict, reason: "stream_finished", "This speech stream no longer accepts audio")

    public static func pushBufferFull(buffered: Int, limit: Int) -> CapabilityError {
        CapabilityError(
            .rateLimited, reason: "push_buffer_full", "Pushed audio is arriving faster than it is transcribed; retry shortly",
            details: ["bufferedBytes": .int(buffered), "limitBytes": .int(limit)], retryable: true)
    }

    public static func pushError(_ error: PushAudioBuffer.PushError) -> CapabilityError {
        switch error {
        case .finished: streamFinished
        case .overflow(let buffered, let limit): pushBufferFull(buffered: buffered, limit: limit)
        }
    }
}

/// Active `speech.transcribe_stream` invocations by stream id (= invocation id). Enforces one
/// microphone stream at a time and a small cap on concurrent streams.
public final class SpeechStreamRegistry: @unchecked Sendable {
    /// One registered stream. `requestStop()` runs the stop handler the pipeline installs (or runs it
    /// as soon as it is installed when the stop came first).
    public final class Handle: @unchecked Sendable {
        public let id: String
        public let source: SpeechSource
        /// Set for `push` streams.
        public let pushBuffer: PushAudioBuffer?

        private let lock = NSLock()
        private var stopHandler: (@Sendable () -> Void)?
        private var stopRequested = false

        init(id: String, source: SpeechSource, pushBuffer: PushAudioBuffer?) {
            self.id = id
            self.source = source
            self.pushBuffer = pushBuffer
        }

        public var isStopRequested: Bool { lock.withLock { stopRequested } }

        public func setStopHandler(_ handler: @escaping @Sendable () -> Void) {
            let runNow: Bool = lock.withLock {
                if stopRequested { return true }
                stopHandler = handler
                return false
            }
            if runNow { handler() }
        }

        /// Idempotent. Push streams also finish their buffer so queued audio drains and ends.
        public func requestStop() {
            let handler: (@Sendable () -> Void)? = lock.withLock {
                if stopRequested { return nil }
                stopRequested = true
                defer { stopHandler = nil }
                return stopHandler
            }
            pushBuffer?.finish()
            handler?()
        }
    }

    public let maxStreams: Int
    private let lock = NSLock()
    private var streams: [String: Handle] = [:]

    public init(maxStreams: Int = SpeechLimits.maxConcurrentStreams) {
        self.maxStreams = max(1, maxStreams)
    }

    public func register(id: String, source: SpeechSource, pushLimitBytes: Int = SpeechLimits.pushBufferLimitBytes) throws -> Handle {
        try lock.withLock {
            if streams[id] != nil { throw SpeechErrors.streamExists(id) }
            if source == .microphone, streams.values.contains(where: { $0.source == .microphone }) { throw SpeechErrors.microphoneBusy }
            if streams.count >= maxStreams { throw SpeechErrors.tooManyStreams }
            let handle = Handle(id: id, source: source, pushBuffer: source == .push ? PushAudioBuffer(limitBytes: pushLimitBytes) : nil)
            streams[id] = handle
            return handle
        }
    }

    public func handle(_ id: String) -> Handle? { lock.withLock { streams[id] } }

    public func remove(_ id: String) {
        _ = lock.withLock { streams.removeValue(forKey: id) }
    }

    public var activeCount: Int { lock.withLock { streams.count } }
    public var microphoneBusy: Bool { lock.withLock { streams.values.contains { $0.source == .microphone } } }

    /// Feeds pushed audio into a push stream (the body of `speech.audio_push`). Returns the
    /// unconsumed byte count after the push.
    @discardableResult
    public func push(streamId: String, audio: Data, final: Bool) throws -> Int {
        guard let handle = handle(streamId) else { throw SpeechErrors.streamNotFound(streamId) }
        guard let buffer = handle.pushBuffer else { throw SpeechErrors.notPushStream }
        do {
            return try buffer.push(audio, final: final)
        } catch {
            throw SpeechErrors.pushError(error)
        }
    }

    /// Asks a stream to stop and finalize (the body of `speech.stop`).
    public func stop(streamId: String) throws {
        guard let handle = handle(streamId) else { throw SpeechErrors.streamNotFound(streamId) }
        handle.requestStop()
    }
}
