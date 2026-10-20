import AVFAudio
import AVFoundation
import Foundation
import PsycheHelperCore
import PsycheProtocol
import Speech

/// Live preflight for the two speech permissions (never prompts; `permissions.request` does that).
/// Not-determined counts as missing.
struct SpeechPermissionPreflight: PermissionPreflight {
    func isGranted(_ permission: TCCPermission) -> Bool {
        switch permission {
        case .microphone: AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        case .speechRecognition: SFSpeechRecognizer.authorizationStatus() == .authorized
        default: false
        }
    }

    static func microphoneStatus() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: "granted"
        case .denied: "denied"
        case .restricted: "restricted"
        default: "notDetermined"
        }
    }

    static func speechRecognitionStatus() -> String {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: "granted"
        case .denied: "denied"
        case .restricted: "restricted"
        default: "notDetermined"
        }
    }
}

/// `speech.transcribe_stream`: source → duration gate → engine → events, with a summary result.
enum SpeechTranscription {
    /// Availability of every engine for `requested`, plus the locales the analyzer transcribers resolved.
    struct Probe {
        var availability: SpeechEngineAvailability
        var speechLocale: Locale?
        var dictationLocale: Locale?
    }

    static func probe(_ requested: Locale) async -> Probe {
        var probe = Probe(availability: SpeechEngineAvailability(speechTranscriber: false, dictationTranscriber: false, sfSpeechOnDevice: false))
        #if canImport(FoundationModels)  // macOS 26 SDK: see SpeechAnalyzerEngine.swift
        if #available(macOS 26.0, *) {
            if SpeechTranscriber.isAvailable {
                probe.speechLocale = await AnalyzerEngine.resolveLocale(requested, kind: .speechAnalyzer)
            }
            probe.dictationLocale = await AnalyzerEngine.resolveLocale(requested, kind: .dictationTranscriber)
            probe.availability.speechTranscriber = probe.speechLocale != nil
            probe.availability.dictationTranscriber = probe.dictationLocale != nil
        }
        #endif
        probe.availability.sfSpeechOnDevice = SFSpeechEngine.onDeviceAvailable(requested)
        return probe
    }

    static func makeEngine(_ request: TranscribeRequest) async throws -> any TranscriptionEngine {
        let requested = request.locale.map { Locale(identifier: $0) } ?? Locale.current
        let probe = await probe(requested)
        let kind = try SpeechEngineSelector.select(
            os: ProcessInfo.processInfo.operatingSystemVersion, vocabulary: request.vocabulary, availability: probe.availability)
        switch kind {
        case .speechAnalyzer, .dictationTranscriber:
            #if canImport(FoundationModels)
            if #available(macOS 26.0, *), let locale = kind == .speechAnalyzer ? probe.speechLocale : probe.dictationLocale {
                return AnalyzerEngine(kind: kind, locale: locale, vocabulary: request.vocabulary, volatile: request.volatile)
            }
            #endif
            throw CapabilityError.unavailable("no_speech_engine", "No on-device speech engine supports this locale on this Mac")
        case .sfSpeech:
            return try SFSpeechEngine(locale: requested, vocabulary: request.vocabulary, volatile: request.volatile)
        }
    }

    /// Mutable per-stream state touched from the engine's result callbacks.
    private final class StreamState: @unchecked Sendable {
        private let lock = NSLock()
        private var accumulator = TranscriptAccumulator()
        private var firstResultMs: Int?
        private let clock = ContinuousClock()
        private var startedAt: ContinuousClock.Instant?
        private var frames = 0
        private var hitLimit = false

        func markStarted() { lock.withLock { startedAt = clock.now } }

        /// Returns true when this is the first non-empty result.
        func ingest(_ s: SpeechSegment) -> Bool {
            lock.withLock {
                accumulator.ingest(s)
                guard firstResultMs == nil, !s.text.isEmpty, let startedAt else { return false }
                let d = clock.now - startedAt
                firstResultMs = Int(d.components.seconds * 1000 + d.components.attoseconds / 1_000_000_000_000_000)
                return true
            }
        }

        func addFrames(_ n: Int) { lock.withLock { frames += n } }
        func setHitLimit() { lock.withLock { hitLimit = true } }

        func finish() -> (TranscriptAccumulator, Int?, Int, Bool) {
            lock.withLock {
                accumulator.promoteVolatile()
                return (accumulator, firstResultMs, frames, hitLimit)
            }
        }
    }

    static func run(_ ctx: InvocationContext, registry: SpeechStreamRegistry, preflight: any PermissionPreflight, log: HelperLog) async throws -> CapabilityOutput {
        let request = try ctx.decode(TranscribeStreamParams.self).validated()
        if request.source == .microphone, !preflight.isGranted(.microphone) { throw CapabilityError.permissionMissing(.microphone) }
        let handle = try registry.register(id: ctx.invocationId, source: request.source)
        defer { registry.remove(handle.id) }

        let engine = try await makeEngine(request)
        if engine.kind == .sfSpeech, !preflight.isGranted(.speechRecognition) {
            throw CapabilityError.permissionMissing(.speechRecognition)
        }
        let source: any SpeechAudioSource
        switch request.source {
        case .microphone: source = try MicrophoneSource()
        case .push:
            guard let buffer = handle.pushBuffer, let format = request.format else {
                throw CapabilityError(.errorCodeInternal, reason: "internal", "push stream without buffer")
            }
            source = try PushSource(buffer: buffer, format: format)
        }
        defer { source.stop() }
        log.info("speech stream start engine=\(engine.kind.rawValue) source=\(request.source.rawValue)")

        try await engine.prepare(inputFormat: source.format, emit: ctx.emit)
        try _Concurrency.Task.checkCancellation()
        handle.setStopHandler { source.stop() }
        try source.start()

        let state = StreamState()
        state.markStarted()
        await ctx.emit(SpeechEvent.started(
            streamId: handle.id, engine: engine.kind, language: engine.language, source: request.source, format: request.format))

        // Duration gate: forwards at most maxDurationMs of audio, then stops the source.
        let sampleRate = source.format.sampleRate
        let maxFrames = Int(Double(request.maxDurationMs) / 1000 * sampleRate)
        let (gated, gate) = AsyncStream.makeStream(of: PCMBufferBox.self)
        let input = source.buffers
        let pump = _Concurrency.Task {
            var total = 0
            for await box in input {
                let n = Int(box.buffer.frameLength)
                if total + n >= maxFrames {
                    box.buffer.frameLength = AVAudioFrameCount(max(0, maxFrames - total))
                    if box.buffer.frameLength > 0 { gate.yield(box) }
                    state.addFrames(Int(box.buffer.frameLength))
                    state.setHitLimit()
                    source.stop()
                    break
                }
                total += n
                state.addFrames(n)
                gate.yield(box)
            }
            gate.finish()
        }
        defer { pump.cancel() }

        let emit = ctx.emit
        try await withTaskCancellationHandler {
            try await engine.transcribe(gated, inputFormat: source.format) { segment in
                if state.ingest(segment) { log.info("speech first result engine=\(engine.kind.rawValue)") }
                if !segment.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    await emit(SpeechEvent.segment(segment))
                }
            }
        } onCancel: {
            source.stop()
            _Concurrency.Task { await engine.cancel() }
        }
        try _Concurrency.Task.checkCancellation()

        let (transcript, firstResultMs, frames, hitLimit) = state.finish()
        let reason: SpeechStopReason = hitLimit ? .maxDuration : handle.isStopRequested ? .stopped : .endOfInput
        log.info("speech stream end engine=\(engine.kind.rawValue) reason=\(reason.rawValue) segments=\(transcript.finals.count) first_result_ms=\(firstResultMs.map(String.init) ?? "none")")
        return CapabilityOutput(transcript.summary(
            streamId: handle.id, engine: engine.kind, language: engine.language, stopReason: reason,
            audioMs: SpeechAudio.durationMs(frames: frames, sampleRate: sampleRate), firstResultMs: firstResultMs))
    }
}
