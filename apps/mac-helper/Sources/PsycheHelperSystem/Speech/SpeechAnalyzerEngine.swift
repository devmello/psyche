import AVFAudio
import CoreMedia
import Foundation
import PsycheHelperCore
import PsycheProtocol
import Speech

/// One on-device transcription engine run.
protocol TranscriptionEngine: AnyObject, Sendable {
    var kind: SpeechEngineKind { get }
    /// BCP-47 tag of the locale actually used.
    var language: String { get }
    /// Installs model assets (emitting `speech.model_download`) and warms the model.
    func prepare(inputFormat: AVAudioFormat, emit: @escaping @Sendable (JSONValue) async -> Void) async throws
    /// Consumes `input` until it ends, then finalizes; segments are reported in order.
    func transcribe(_ input: AsyncStream<PCMBufferBox>, inputFormat: AVAudioFormat, onSegment: @escaping @Sendable (SpeechSegment) async -> Void) async throws
    /// Abandons the run (invocation cancelled).
    func cancel() async
}

/// `SpeechAnalyzer` with `SpeechTranscriber` (general) or `DictationTranscriber` (custom
/// vocabulary through `AnalysisContext.contextualStrings`). macOS 26+. Uses only macOS 26.0 API
/// (checked against the 26.5 SDK interface); no presets, whose names changed during the 26 betas.
@available(macOS 26.0, *)
final class AnalyzerEngine: TranscriptionEngine, @unchecked Sendable {
    private enum Module {
        case speech(SpeechTranscriber)
        case dictation(DictationTranscriber)

        var any: any SpeechModule {
            switch self {
            case .speech(let m): m
            case .dictation(let m): m
            }
        }
    }

    let kind: SpeechEngineKind
    let language: String
    private let locale: Locale
    private let vocabulary: [String]
    private let module: Module
    private let lock = NSLock()
    private var analyzer: SpeechAnalyzer?
    private var analyzerFormat: AVAudioFormat?

    /// Resolves the locale for the engine kind; nil when that transcriber does not support it.
    static func resolveLocale(_ requested: Locale, kind: SpeechEngineKind) async -> Locale? {
        switch kind {
        case .dictationTranscriber: await DictationTranscriber.supportedLocale(equivalentTo: requested)
        default: await SpeechTranscriber.supportedLocale(equivalentTo: requested)
        }
    }

    init(kind: SpeechEngineKind, locale: Locale, vocabulary: [String], volatile: Bool) {
        self.kind = kind
        self.locale = locale
        self.language = locale.identifier(.bcp47)
        self.vocabulary = vocabulary
        switch kind {
        case .dictationTranscriber:
            module = .dictation(DictationTranscriber(
                locale: locale, contentHints: [],
                transcriptionOptions: [.punctuation],
                reportingOptions: volatile ? [.volatileResults, .frequentFinalization] : [.frequentFinalization],
                attributeOptions: [.audioTimeRange, .transcriptionConfidence]))
        default:
            module = .speech(SpeechTranscriber(
                locale: locale, transcriptionOptions: [],
                reportingOptions: volatile ? [.volatileResults, .fastResults] : [],
                attributeOptions: [.audioTimeRange, .transcriptionConfidence]))
        }
    }

    func prepare(inputFormat: AVAudioFormat, emit: @escaping @Sendable (JSONValue) async -> Void) async throws {
        let modules = [module.any]
        try await Self.ensureAssets(modules: modules, language: language, emit: emit)
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules, considering: inputFormat) else {
            throw CapabilityError.unavailable("unsupported_audio_format", "The speech model accepts no audio format usable here")
        }
        let analyzer = SpeechAnalyzer(modules: modules, options: SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .lingering))
        do {
            if !vocabulary.isEmpty {
                let context = AnalysisContext()
                context.contextualStrings[.general] = vocabulary
                try await analyzer.setContext(context)
            }
            // Loads the model before audio arrives, so the first partial is not delayed by it.
            try await analyzer.prepareToAnalyze(in: format)
        } catch {
            throw Self.mapError(error)
        }
        lock.withLock {
            self.analyzer = analyzer
            self.analyzerFormat = format
        }
    }

    func transcribe(_ input: AsyncStream<PCMBufferBox>, inputFormat: AVAudioFormat, onSegment: @escaping @Sendable (SpeechSegment) async -> Void) async throws {
        let (analyzer, format) = lock.withLock { (self.analyzer, self.analyzerFormat) }
        guard let analyzer, let format else {
            throw CapabilityError(.errorCodeInternal, reason: "engine_not_prepared", "The speech engine was not prepared")
        }
        let converter = try PCMBufferConverter(from: inputFormat, to: format)
        let (stream, feed) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let results = resultsTask(onSegment)
        do {
            try await analyzer.start(inputSequence: stream)
            for await box in input {
                if let converted = try converter.convert(box.buffer) {
                    feed.yield(AnalyzerInput(buffer: converted))
                }
            }
            feed.finish()
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            try await results.value
        } catch {
            feed.finish()
            await analyzer.cancelAndFinishNow()
            results.cancel()
            throw Self.mapError(error)
        }
    }

    func cancel() async {
        let analyzer = lock.withLock { self.analyzer }
        await analyzer?.cancelAndFinishNow()
    }

    private func resultsTask(_ onSegment: @escaping @Sendable (SpeechSegment) async -> Void) -> _Concurrency.Task<Void, any Error> {
        switch module {
        case .speech(let m):
            _Concurrency.Task {
                for try await r in m.results {
                    await onSegment(Self.segment(r.text, range: r.range, final: r.isFinal))
                }
            }
        case .dictation(let m):
            _Concurrency.Task {
                for try await r in m.results {
                    await onSegment(Self.segment(r.text, range: r.range, final: r.isFinal))
                }
            }
        }
    }

    static func segment(_ text: AttributedString, range: CMTimeRange, final: Bool) -> SpeechSegment {
        var weighted = 0.0
        var count = 0
        for run in text.runs {
            guard let c = run.attributes[AttributeScopes.SpeechAttributes.ConfidenceAttribute.self] else { continue }
            let n = text[run.range].characters.count
            weighted += c * Double(n)
            count += n
        }
        return SpeechSegment(
            text: String(text.characters), startSeconds: range.start.seconds, endSeconds: range.end.seconds,
            final: final, confidence: count > 0 ? weighted / Double(count) : nil)
    }

    /// Installs (downloads) the system speech model for `modules` if needed, emitting progress.
    static func ensureAssets(modules: [any SpeechModule], language: String, emit: @escaping @Sendable (JSONValue) async -> Void) async throws {
        let request: AssetInstallationRequest?
        do {
            request = try await AssetInventory.assetInstallationRequest(supporting: modules)
        } catch {
            throw CapabilityError.unavailable("model_unavailable", "The speech model for this locale cannot be installed")
        }
        guard let request else { return }
        await emit(SpeechEvent.modelDownload(phase: .started, locale: language, fraction: 0))
        let progress = request.progress
        let poller = _Concurrency.Task {
            var last = -1.0
            while !_Concurrency.Task.isCancelled {
                try? await _Concurrency.Task.sleep(for: .milliseconds(500))
                let f = progress.fractionCompleted
                if f > last + 0.01 {
                    last = f
                    await emit(SpeechEvent.modelDownload(phase: .progress, locale: language, fraction: f))
                }
            }
        }
        defer { poller.cancel() }
        do {
            try await request.downloadAndInstall()
        } catch {
            throw CapabilityError.unavailable("model_download_failed", "The speech model download failed", retryable: true)
        }
        await emit(SpeechEvent.modelDownload(phase: .finished, locale: language, fraction: 1))
    }

    static func mapError(_ error: any Error) -> CapabilityError {
        if let e = error as? CapabilityError { return e }
        if error is CancellationError { return .cancelled }
        let ns = error as NSError
        return CapabilityError(
            .unavailable, reason: "transcription_failed", "On-device transcription failed",
            details: ["domain": .string(ns.domain), "code": .int(ns.code)], retryable: true)
    }
}
