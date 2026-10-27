@preconcurrency import AVFoundation
import FluidAudio
import Foundation
import Speech
import WhisperKit

/// One push-to-talk engine. `prepare` loads models once per process (the helper keeps them warm);
/// each utterance is `begin` → `feed`… → `end` (key-up), which returns the final transcript.
/// `onUpdate` receives the whole current hypothesis (finalized text + volatile tail).
@MainActor
protocol DictationEngine: AnyObject {
    var name: String { get }
    var notes: [String] { get }
    func prepare(vocabulary: [String]) async throws
    func begin(onUpdate: @escaping @Sendable (String) -> Void) async throws
    func feed(_ buffer: AVAudioPCMBuffer) async throws
    func end() async throws -> String
}

@MainActor
func makeEngine(_ id: String) throws -> DictationEngine {
    switch id {
    case "speech", "speech-fast", "speech-vocab", "speech-fast-vocab", "dictation", "dictation-vocab", "dictation-short":
        guard #available(macOS 26, *) else { throw SpikeError.message("\(id) needs macOS 26") }
        return AppleEngine(id: id)
    case "parakeet-eou": return ParakeetEouEngine(chunk: .ms320)
    case "parakeet-eou-160": return ParakeetEouEngine(chunk: .ms160)
    case "parakeet-tdt": return ParakeetTdtEngine()
    case _ where id.hasPrefix("whisper-"):
        return WhisperEngine(id: id)
    default: throw SpikeError.message("unknown engine \(id)")
    }
}

// MARK: - SpeechAnalyzer (macOS 26+)

@available(macOS 26, *)
final class AppleEngine: DictationEngine {
    let name: String
    private(set) var notes: [String] = []
    private let useVocabulary: Bool
    private let dictation: Bool
    private let fast: Bool
    private let short: Bool
    private var locale: Locale!
    private var module: (any SpeechModule)!
    private var analyzerFormat: AVAudioFormat!
    private var context = AnalysisContext()
    private var analyzer: SpeechAnalyzer?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<String, Error>?
    private var converter: Converter?

    init(id: String) {
        name = id
        dictation = id.hasPrefix("dictation")
        useVocabulary = id.hasSuffix("-vocab")
        fast = id.contains("-fast")
        short = id.contains("-short")
    }

    private func makeModule(locale: Locale) -> any SpeechModule {
        if dictation {
            // progressiveLongDictation = volatile results + punctuation, tuned for long-form dictation.
            return DictationTranscriber(locale: locale, preset: short ? .progressiveShortDictation : .progressiveLongDictation)
        }
        // The "progressive live" preset: volatile results; fastResults trades accuracy for earlier partials.
        var preset = SpeechTranscriber.Preset.progressiveTranscription
        if fast { preset.reportingOptions.insert(.fastResults) }
        return SpeechTranscriber(locale: locale, preset: preset)
    }

    func prepare(vocabulary: [String]) async throws {
        let wanted = Locale(identifier: "en-US")
        let locale: Locale?
        if dictation {
            locale = await DictationTranscriber.supportedLocale(equivalentTo: wanted)
        } else {
            guard SpeechTranscriber.isAvailable else { throw SpikeError.message("SpeechTranscriber.isAvailable == false on this device") }
            locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted)
        }
        guard let locale else { throw SpikeError.message("en-US not supported") }
        self.locale = locale
        module = makeModule(locale: locale)

        let status = await AssetInventory.status(forModules: [module])
        notes.append("asset status before: \(status)")
        if status != .installed, let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            let t = now()
            try await request.downloadAndInstall()
            notes.append(String(format: "asset download+install: %.1f s", now() - t))
        }
        let reserved = await AssetInventory.reservedLocales
        notes.append("reserved locales: \(reserved.map(\.identifier)) of max \(AssetInventory.maximumReservedLocales)")

        analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module])
        notes.append("analyzer format: \(analyzerFormat.map { "\(Int($0.sampleRate)) Hz \($0.commonFormat.rawValue == 3 ? "int16" : "fmt\($0.commonFormat.rawValue)") \($0.channelCount) ch" } ?? "nil")")
        if analyzerFormat != monoFormat { converter = Converter(from: monoFormat, to: analyzerFormat) }

        if useVocabulary {
            context.contextualStrings[.general] = vocabulary
        }
    }

    func begin(onUpdate: @escaping @Sendable (String) -> Void) async throws {
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        input = continuation
        // A fresh module and analyzer per utterance: attaching a module that already served a finished
        // analyzer traps inside Speech.framework (EXC_BREAKPOINT in TranscriberCommon.worker.setter).
        // .processLifetime keeps the model resident between utterances.
        module = makeModule(locale: locale)
        let analyzer = SpeechAnalyzer(
            modules: [module], options: .init(priority: .userInitiated, modelRetention: .processLifetime))
        self.analyzer = analyzer
        if useVocabulary { try await analyzer.setContext(context) }
        try await analyzer.prepareToAnalyze(in: analyzerFormat)

        let module = self.module!
        resultsTask = Task {
            var finalized = ""
            func join(_ a: String, _ b: String) -> String {
                a.isEmpty ? b : (b.isEmpty ? a : a + " " + b)
            }
            func handle(text: AttributedString, isFinal: Bool) {
                let s = String(text.characters).trimmingCharacters(in: .whitespaces)
                if isFinal {
                    finalized = join(finalized, s)
                    onUpdate(finalized)
                } else {
                    onUpdate(join(finalized, s))
                }
            }
            if let m = module as? SpeechTranscriber {
                for try await r in m.results { handle(text: r.text, isFinal: r.isFinal) }
            } else if let m = module as? DictationTranscriber {
                for try await r in m.results { handle(text: r.text, isFinal: r.isFinal) }
            }
            return finalized
        }
        try await analyzer.start(inputSequence: stream)
    }

    func feed(_ buffer: AVAudioPCMBuffer) async throws {
        let converted = try converter?.convert(buffer) ?? buffer
        input?.yield(AnalyzerInput(buffer: converted))
    }

    func end() async throws -> String {
        input?.finish()
        try await analyzer?.finalizeAndFinishThroughEndOfInput()
        return try await resultsTask?.value ?? ""
    }
}

// MARK: - FluidAudio Parakeet EOU (streaming, 320 ms chunks)

final class ParakeetEouEngine: DictationEngine {
    let name: String
    private(set) var notes: [String] = []
    private let manager: StreamingEouAsrManager

    /// .ms320 decodes a 630 ms window every 320 ms; .ms160 a 160 ms window every 80 ms.
    init(chunk: StreamingChunkSize) {
        name = "parakeet-eou-\(chunk.modelSubdirectory)"
        // Debounce long enough that the end-of-utterance head never cuts a push-to-talk utterance short.
        manager = StreamingEouAsrManager(chunkSize: chunk, eouDebounceMs: 5_000)
    }

    func prepare(vocabulary: [String]) async throws {
        try await manager.loadModels()
        notes.append("parakeet-realtime-eou-120m-coreml \(name); no custom vocabulary in the EOU path")
    }

    func begin(onUpdate: @escaping @Sendable (String) -> Void) async throws {
        await manager.reset()
        await manager.setPartialCallback { onUpdate($0) }
    }

    func feed(_ buffer: AVAudioPCMBuffer) async throws {
        _ = try await manager.process(audioBuffer: buffer)
    }

    func end() async throws -> String {
        try await manager.finish()
    }
}

// MARK: - FluidAudio Parakeet TDT v2 (re-decode the buffer every second, full decode at key-up)

final class ParakeetTdtEngine: DictationEngine {
    let name = "parakeet-tdt"
    private(set) var notes: [String] = []
    private let manager = AsrManager(config: .default)
    private var audio: [Float] = []
    private var decodedUpTo = 0
    private var inFlight: Task<Void, Never>?
    private var onUpdate: (@Sendable (String) -> Void)?
    private var layers = 2

    func prepare(vocabulary: [String]) async throws {
        let models = try await AsrModels.downloadAndLoad(version: .v2)
        try await manager.loadModels(models)
        layers = await manager.decoderLayerCount
        notes.append("parakeet-tdt-0.6b-v2-coreml (English); partials = re-decode of the whole buffer every 320 ms")
    }

    private func decode(_ samples: [Float]) async throws -> String {
        var state = TdtDecoderState.make(decoderLayers: layers)
        return try await manager.transcribe(samples, decoderState: &state).text
    }

    func begin(onUpdate: @escaping @Sendable (String) -> Void) async throws {
        audio = []
        decodedUpTo = 0
        self.onUpdate = onUpdate
    }

    func feed(_ buffer: AVAudioPCMBuffer) async throws {
        audio += samples(of: buffer)
        // Re-decode every 320 ms of new audio (the EOU model's shift), never overlapping; a full decode
        // of 90 s takes ~0.2 s, so re-decoding a push-to-talk buffer is cheap.
        let due = decodedUpTo + 5_120
        guard audio.count >= due, inFlight == nil else { return }
        decodedUpTo = audio.count
        let snapshot = audio
        inFlight = Task { [weak self] in
            guard let self else { return }
            if let text = try? await self.decode(snapshot), !text.isEmpty { self.onUpdate?(text) }
            self.inFlight = nil
        }
    }

    func end() async throws -> String {
        await inFlight?.value
        return try await decode(audio)
    }
}

// MARK: - WhisperKit (the AudioStreamTranscriber loop: re-decode since the last confirmed segment)

final class WhisperEngine: DictationEngine {
    let name: String
    private(set) var notes: [String] = []
    private let model: String
    private let useVocabulary: Bool
    /// `-final`: partials from the streaming loop, but the key-up transcript is one clean decode of the
    /// whole buffer (the loop's clip-and-confirm can drop or hallucinate segments).
    private let fullFinal: Bool
    private var kit: WhisperKit!
    private var options = DecodingOptions()
    private var audio: [Float] = []
    private var lastDecodedCount = 0
    private var confirmedText = ""
    private var confirmedEnd: Float = 0
    private var inFlight: Task<Void, Never>?
    private var onUpdate: (@Sendable (String) -> Void)?

    init(id: String) {
        name = id
        model = id.contains("small") ? "openai_whisper-small.en" : "openai_whisper-base.en"
        useVocabulary = id.contains("-vocab")
        fullFinal = id.contains("-final")
    }

    func prepare(vocabulary: [String]) async throws {
        // With download: true WhisperKit resolves the model name against Hugging Face on every launch and
        // fails offline even when the model is cached; pass the local folder and download: false instead.
        if let folder = ProcessInfo.processInfo.environment["WHISPER_MODEL_FOLDER"] {
            kit = try await WhisperKit(WhisperKitConfig(
                modelFolder: folder + "/" + model, verbose: false, logLevel: .error, prewarm: true, load: true, download: false))
        } else {
            kit = try await WhisperKit(WhisperKitConfig(model: model, verbose: false, logLevel: .error, prewarm: true, load: true, download: true))
        }
        options = DecodingOptions(language: "en", temperatureFallbackCount: 3, skipSpecialTokens: true)
        if useVocabulary, let tokenizer = kit.tokenizer {
            let prompt = " " + vocabulary.joined(separator: ", ") + "."
            options.promptTokens = tokenizer.encode(text: prompt).filter { $0 < tokenizer.specialTokens.specialTokenBegin }
        }
        notes.append("\(model); partials = AudioStreamTranscriber-style loop (confirm all but last 2 segments)")
    }

    func begin(onUpdate: @escaping @Sendable (String) -> Void) async throws {
        audio = []
        lastDecodedCount = 0
        confirmedText = ""
        confirmedEnd = 0
        self.onUpdate = onUpdate
    }

    private func decode(final: Bool) async throws -> String {
        var opts = options
        if final && fullFinal {
            confirmedText = ""
            confirmedEnd = 0
        }
        opts.clipTimestamps = [confirmedEnd]
        let snapshot = audio
        let results = try await kit.transcribe(audioArray: snapshot, decodeOptions: opts)
        let segments = results.flatMap(\.segments)
        func text(_ segs: ArraySlice<TranscriptionSegment>) -> String {
            segs.map { $0.text.trimmingCharacters(in: .whitespaces) }.joined(separator: " ")
        }
        if final { return [confirmedText, text(segments[...])].filter { !$0.isEmpty }.joined(separator: " ") }
        if segments.count > 2 {
            let confirmed = segments.prefix(segments.count - 2)
            if let last = confirmed.last, last.end > confirmedEnd {
                confirmedEnd = last.end
                confirmedText = [confirmedText, text(confirmed)].filter { !$0.isEmpty }.joined(separator: " ")
            }
            return [confirmedText, text(segments.suffix(2))].filter { !$0.isEmpty }.joined(separator: " ")
        }
        return [confirmedText, text(segments[...])].filter { !$0.isEmpty }.joined(separator: " ")
    }

    func feed(_ buffer: AVAudioPCMBuffer) async throws {
        audio += samples(of: buffer)
        guard audio.count - lastDecodedCount >= 16_000, inFlight == nil else { return }
        lastDecodedCount = audio.count
        inFlight = Task { [weak self] in
            guard let self else { return }
            if let text = try? await self.decode(final: false), !text.isEmpty { self.onUpdate?(text) }
            self.inFlight = nil
        }
    }

    func end() async throws -> String {
        await inFlight?.value
        return try await decode(final: true)
    }
}
