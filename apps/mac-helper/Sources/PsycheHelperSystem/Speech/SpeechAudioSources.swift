import AVFAudio
import Foundation
import PsycheHelperCore
import PsycheProtocol

/// A live audio source for one transcription stream: buffers in `format` until `stop()` or the end
/// of input.
protocol SpeechAudioSource: AnyObject, Sendable {
    var format: AVAudioFormat { get }
    var buffers: AsyncStream<PCMBufferBox> { get }
    func start() throws
    /// Idempotent; ends `buffers` after what is already queued.
    func stop()
}

/// Microphone capture through an `AVAudioEngine` input tap. Tap buffers are copied (the engine may
/// reuse them) and handed to the pipeline, which converts them to the engine's format.
final class MicrophoneSource: SpeechAudioSource, @unchecked Sendable {
    let format: AVAudioFormat
    let buffers: AsyncStream<PCMBufferBox>
    private let continuation: AsyncStream<PCMBufferBox>.Continuation
    private let engine: AVAudioEngine
    private let lock = NSLock()
    private var running = false
    private var stopped = false

    /// ~43 ms at 48 kHz; small taps keep time-to-first-partial low.
    static let tapFrames: AVAudioFrameCount = 2048

    init() throws {
        engine = AVAudioEngine()
        let format = engine.inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw CapabilityError.unavailable("no_input_device", "No microphone is available")
        }
        self.format = format
        // ~90 s of 2048-frame buffers at 48 kHz before the oldest are dropped.
        (buffers, continuation) = AsyncStream.makeStream(of: PCMBufferBox.self, bufferingPolicy: .bufferingNewest(2048))
    }

    func start() throws {
        let continuation = self.continuation
        engine.inputNode.installTap(onBus: 0, bufferSize: Self.tapFrames, format: format) { buffer, _ in
            if let copy = SpeechAudio.copy(buffer) { continuation.yield(PCMBufferBox(buffer: copy)) }
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            engine.inputNode.removeTap(onBus: 0)
            throw CapabilityError.unavailable("microphone_start_failed", "The microphone could not be started", retryable: true)
        }
        lock.withLock { running = true }
    }

    func stop() {
        let wasRunning: Bool = lock.withLock {
            if stopped { return false }
            stopped = true
            return running
        }
        if wasRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        continuation.finish()
    }
}

/// Pushed PCM (`speech.audio_push`): drains the stream's `PushAudioBuffer`, re-frames the bytes and
/// turns them into buffers in the declared format.
final class PushSource: SpeechAudioSource, @unchecked Sendable {
    let format: AVAudioFormat
    let buffers: AsyncStream<PCMBufferBox>
    private let continuation: AsyncStream<PCMBufferBox>.Continuation
    private let pushBuffer: PushAudioBuffer
    private let wire: PCMAudioFormat
    private let lock = NSLock()
    private var reader: _Concurrency.Task<Void, Never>?

    init(buffer: PushAudioBuffer, format wire: PCMAudioFormat) throws {
        guard let format = SpeechAudio.avFormat(wire) else {
            throw CapabilityError.invalidParams("format is not a supported PCM layout", field: "format")
        }
        self.format = format
        self.wire = wire
        self.pushBuffer = buffer
        // Unbounded here; the PushAudioBuffer limit is the backpressure point.
        (buffers, continuation) = AsyncStream.makeStream(of: PCMBufferBox.self)
    }

    func start() throws {
        let pushBuffer = self.pushBuffer
        let continuation = self.continuation
        let wire = self.wire
        let format = PCMFormatBox(format: self.format)
        let task = _Concurrency.Task {
            var aligner = PCMFrameAligner(bytesPerFrame: wire.bytesPerFrame)
            while let chunk = await pushBuffer.next() {
                let whole = aligner.append(chunk)
                if let buffer = SpeechAudio.buffer(from: whole, format: format.format) {
                    continuation.yield(PCMBufferBox(buffer: buffer))
                }
            }
            continuation.finish()
        }
        lock.withLock { reader = task }
    }

    /// Lets queued audio drain, then ends.
    func stop() {
        pushBuffer.finish()
    }

    /// Drops queued audio and ends now (invocation cancelled).
    func cancel() {
        pushBuffer.cancel()
    }
}

/// `AVAudioFormat` is immutable after creation; safe to share.
struct PCMFormatBox: @unchecked Sendable {
    let format: AVAudioFormat
}
