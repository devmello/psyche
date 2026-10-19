import AVFAudio
import Foundation
import PsycheHelperCore
import PsycheProtocol
import Speech

/// `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true`: the interim engine on macOS 15
/// (spike 03, which picks FluidAudio Parakeet or WhisperKit, has not landed) and the fallback on 26+
/// for locales SpeechAnalyzer lacks. Audio never leaves the Mac. Needs the Speech Recognition grant.
///
/// Each recognizer result is the whole utterance so far, so it maps to one segment spanning the
/// recognized words; the final result is the transcript.
final class SFSpeechEngine: TranscriptionEngine, @unchecked Sendable {
    let kind = SpeechEngineKind.sfSpeech
    let language: String
    private let recognizer: SFSpeechRecognizer
    private let vocabulary: [String]
    private let volatile: Bool
    private let lock = NSLock()
    private var task: SFSpeechRecognitionTask?

    /// kAFAssistantErrorDomain 1110: no speech detected (an empty transcript, not a failure).
    static let noSpeechCode = 1110

    static func onDeviceAvailable(_ locale: Locale) -> Bool {
        guard let r = SFSpeechRecognizer(locale: locale) else { return false }
        return r.supportsOnDeviceRecognition
    }

    init(locale: Locale, vocabulary: [String], volatile: Bool) throws {
        guard let recognizer = SFSpeechRecognizer(locale: locale) else {
            throw CapabilityError.unavailable("unsupported_locale", "Speech recognition does not support this locale")
        }
        guard recognizer.supportsOnDeviceRecognition else {
            throw CapabilityError.unavailable("on_device_unsupported", "On-device recognition is not available for this locale")
        }
        // The helper's main thread may be blocked serving the socket: never deliver on the main queue.
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.qualityOfService = .userInitiated
        recognizer.queue = queue
        self.recognizer = recognizer
        self.language = recognizer.locale.identifier(.bcp47)
        self.vocabulary = vocabulary
        self.volatile = volatile
    }

    func prepare(inputFormat: AVAudioFormat, emit: @escaping @Sendable (JSONValue) async -> Void) async throws {
        guard recognizer.isAvailable else {
            throw CapabilityError.unavailable("recognizer_unavailable", "Speech recognition is unavailable right now", retryable: true)
        }
    }

    func transcribe(_ input: AsyncStream<PCMBufferBox>, inputFormat: AVAudioFormat, onSegment: @escaping @Sendable (SpeechSegment) async -> Void) async throws {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = volatile
        request.contextualStrings = vocabulary
        request.addsPunctuation = true
        request.taskHint = .dictation
        let converter = try PCMBufferConverter(from: inputFormat, to: request.nativeAudioFormat)

        let (results, sink) = AsyncThrowingStream.makeStream(of: SpeechSegment.self)
        let task = recognizer.recognitionTask(with: request) { result, error in
            if let result {
                sink.yield(Self.segment(result))
                if result.isFinal { sink.finish() }
            } else if let error {
                sink.finish(throwing: error)
            }
        }
        lock.withLock { self.task = task }

        let box = RequestBox(request: request)
        let feeder = _Concurrency.Task {
            for await b in input {
                if let converted = try? converter.convert(b.buffer) { box.request.append(converted) }
            }
            box.request.endAudio()
        }
        defer { feeder.cancel() }
        do {
            for try await segment in results { await onSegment(segment) }
        } catch {
            let ns = error as NSError
            if ns.code == Self.noSpeechCode { return }
            throw CapabilityError(
                .unavailable, reason: "transcription_failed", "On-device transcription failed",
                details: ["domain": .string(ns.domain), "code": .int(ns.code)], retryable: true)
        }
    }

    func cancel() async {
        lock.withLock { task }?.cancel()
    }

    static func segment(_ result: SFSpeechRecognitionResult) -> SpeechSegment {
        let t = result.bestTranscription
        let segments = t.segments
        let start = segments.first?.timestamp ?? 0
        let end = segments.last.map { $0.timestamp + $0.duration } ?? start
        // Confidence is 0 on partial results; only report it for finals.
        let confidence: Double? = result.isFinal && !segments.isEmpty
            ? segments.map { Double($0.confidence) }.reduce(0, +) / Double(segments.count) : nil
        return SpeechSegment(text: t.formattedString, startSeconds: start, endSeconds: end, final: result.isFinal, confidence: confidence)
    }

    private struct RequestBox: @unchecked Sendable {
        let request: SFSpeechAudioBufferRecognitionRequest
    }
}
