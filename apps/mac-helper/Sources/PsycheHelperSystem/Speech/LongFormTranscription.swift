import AVFAudio
import Foundation
import PsycheHelperCore
import PsycheProtocol

/// One chunk's transcription: segment times are from the chunk's `readFromMs`.
public struct LongFormChunkResult: Sendable, Equatable {
    public var engine: SpeechEngineKind
    public var language: String
    public var segments: [SpeechSegment]

    public init(engine: SpeechEngineKind, language: String, segments: [SpeechSegment]) {
        self.engine = engine
        self.language = language
        self.segments = segments
    }
}

/// Reads and transcribes an audio file chunk by chunk. Live: `AVAudioFile` and the on-device engine;
/// tests pass a fake.
public protocol LongFormAudioBackend: Sendable {
    /// The file's duration; `unsupported_audio` when it is not audio the system can decode.
    func durationMs(path: String) throws -> Int
    func transcribe(path: String, chunk: LongFormChunk, request: TranscribeRequest,
                    emit: @escaping @Sendable (JSONValue) async -> Void) async throws -> LongFormChunkResult
}

/// `speech.transcribe_file` (#673 H1): path guard → duration gate → chunks → progress → merged result.
enum LongFormTranscription {
    /// Granted folders plus the Library (`$PSYCHE_HOME/library`).
    static func roots(environment: [String: String] = ProcessInfo.processInfo.environment) -> FinderRoots {
        let library = (HelperPaths.psycheHome(environment: environment) as NSString).appendingPathComponent("library")
        return FinderRoots(roots: FinderRoots.load(environment: environment).roots + [library])
    }

    static func run(_ ctx: InvocationContext, backend: any LongFormAudioBackend, roots: FinderRoots, log: HelperLog) async throws -> CapabilityOutput {
        let request = try ctx.decode(TranscribeFileParams.self).validated()
        let path = try roots.resolve(request.path)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue else {
            throw CapabilityError(.notFound, reason: "not_found", "\(request.path) is not a file", details: ["path": .string(request.path)])
        }
        let audioMs = try backend.durationMs(path: path)
        try request.checkDuration(audioMs: audioMs)

        let chunks = LongFormChunkPlanner.plan(audioMs: audioMs)
        let engineRequest = request.engineRequest
        log.info("speech file start chunks=\(chunks.count) audio_ms=\(audioMs)")
        await ctx.emit(SpeechEvent.progress(processedMs: 0, totalMs: audioMs, chunk: 0, chunks: chunks.count))

        var merger = LongFormMerger()
        var engine = SpeechEngineKind.speechAnalyzer
        var language = request.locale ?? Locale.current.identifier(.bcp47)
        for chunk in chunks {
            try _Concurrency.Task.checkCancellation()
            let r = try await backend.transcribe(path: path, chunk: chunk, request: engineRequest, emit: ctx.emit)
            engine = r.engine
            language = r.language
            merger.add(chunk, segments: r.segments, isLast: chunk.index == chunks.count - 1)
            await ctx.emit(SpeechEvent.progress(processedMs: chunk.keepToMs, totalMs: audioMs, chunk: chunk.index + 1, chunks: chunks.count))
        }
        log.info("speech file end engine=\(engine.rawValue) chunks=\(chunks.count) segments=\(merger.segments.count)")
        return CapabilityOutput(untrusted(merger.result(engine: engine, language: language, audioMs: audioMs)))
    }

    /// Recorded speech is other people's words unless the caller knows better (`untrusted`).
    static func untrusted(_ v: JSONValue) -> JSONValue {
        guard case .object(var o) = v else { return v }
        o["provenance"] = "untrusted"
        return .object(o)
    }
}

/// Pull-based reader of one frame range: the engine asks for the next buffer, so a 10-minute
/// chunk is never decoded ahead of the engine.
final class AudioFileRangeReader: @unchecked Sendable {
    private let lock = NSLock()
    private let file: AVAudioFile
    private var remaining: AVAudioFramePosition
    static let bufferFrames: AVAudioFrameCount = 16_384

    var format: AVAudioFormat { file.processingFormat }

    init(path: String, fromMs: Int, toMs: Int) throws {
        file = try LiveLongFormBackend.open(path)
        let rate = file.processingFormat.sampleRate
        let start = min(file.length, AVAudioFramePosition(Double(fromMs) / 1000 * rate))
        let end = min(file.length, AVAudioFramePosition(Double(toMs) / 1000 * rate))
        file.framePosition = start
        remaining = max(0, end - start)
    }

    func next() -> PCMBufferBox? {
        lock.withLock {
            guard remaining > 0 else { return nil }
            let n = AVAudioFrameCount(min(AVAudioFramePosition(Self.bufferFrames), remaining))
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: n) else { return nil }
            do {
                try file.read(into: buffer, frameCount: n)
            } catch {
                remaining = 0
                return nil
            }
            guard buffer.frameLength > 0 else {
                remaining = 0
                return nil
            }
            remaining -= AVAudioFramePosition(buffer.frameLength)
            return PCMBufferBox(buffer: buffer)
        }
    }

    var buffers: AsyncStream<PCMBufferBox> {
        AsyncStream(unfolding: { self.next() })
    }
}

/// `AVAudioFile` and the same engines as `speech.transcribe_stream` (a fresh engine per chunk; the
/// analyzer keeps its model loaded between them).
struct LiveLongFormBackend: LongFormAudioBackend {
    let preflight: any PermissionPreflight

    static func open(_ path: String) throws -> AVAudioFile {
        do {
            return try AVAudioFile(forReading: URL(fileURLWithPath: path))
        } catch {
            throw CapabilityError(.invalidParams, reason: "unsupported_audio", "\((path as NSString).lastPathComponent) is not an audio file this Mac can decode")
        }
    }

    func durationMs(path: String) throws -> Int {
        let file = try Self.open(path)
        let rate = file.processingFormat.sampleRate
        guard rate > 0 else { throw CapabilityError(.invalidParams, reason: "unsupported_audio", "The audio has no sample rate") }
        return Int((Double(file.length) / rate * 1000).rounded())
    }

    func transcribe(path: String, chunk: LongFormChunk, request: TranscribeRequest,
                    emit: @escaping @Sendable (JSONValue) async -> Void) async throws -> LongFormChunkResult {
        let reader = try AudioFileRangeReader(path: path, fromMs: chunk.readFromMs, toMs: chunk.readToMs)
        let engine = try await SpeechTranscription.makeEngine(request)
        if engine.kind == .sfSpeech, !preflight.isGranted(.speechRecognition) {
            throw CapabilityError.permissionMissing(.speechRecognition)
        }
        try await engine.prepare(inputFormat: reader.format, emit: emit)
        let collected = SegmentBox()
        try await withTaskCancellationHandler {
            try await engine.transcribe(reader.buffers, inputFormat: reader.format) { collected.add($0) }
        } onCancel: {
            _Concurrency.Task { await engine.cancel() }
        }
        try _Concurrency.Task.checkCancellation()
        return LongFormChunkResult(engine: engine.kind, language: engine.language, segments: collected.finals())
    }

    private final class SegmentBox: @unchecked Sendable {
        private let lock = NSLock()
        private var accumulator = TranscriptAccumulator()
        func add(_ s: SpeechSegment) { lock.withLock { accumulator.ingest(s) } }
        func finals() -> [SpeechSegment] {
            lock.withLock {
                accumulator.promoteVolatile()
                return accumulator.finals
            }
        }
    }
}
