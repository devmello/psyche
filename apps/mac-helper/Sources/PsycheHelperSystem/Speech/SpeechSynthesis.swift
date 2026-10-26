import AVFAudio
import Foundation
import PsycheHelperCore
import PsycheProtocol

/// `speech.synthesize` / `speech.voices` over `AVSpeechSynthesizer`.
///
/// Measured on macOS 27: `write(_:toBufferCallback:)` only produces audio when the synthesizer is
/// created and driven on the main thread with the main queue serviced (the helper's main thread must
/// run `dispatchMain()` / the main run loop, with the socket loop on another thread). Buffers then
/// arrive off-main (Float32 mono, 22.05 kHz for the compact voices), ending with a zero-length buffer.
enum SpeechSynthesis {
    static func quality(_ q: AVSpeechSynthesisVoiceQuality) -> String {
        switch q {
        case .enhanced: "enhanced"
        case .premium: "premium"
        default: "default"
        }
    }

    static func isPersonal(_ v: AVSpeechSynthesisVoice) -> Bool {
        v.voiceTraits.contains(.isPersonalVoice)
    }

    static func personalVoiceStatus() -> String {
        switch AVSpeechSynthesizer.personalVoiceAuthorizationStatus {
        case .authorized: "authorized"
        case .denied: "denied"
        case .unsupported: "unsupported"
        default: "notDetermined"
        }
    }

    static func voiceJSON(_ v: AVSpeechSynthesisVoice) -> JSONValue {
        [
            "id": .string(v.identifier), "name": .string(v.name), "language": .string(v.language),
            "quality": .string(quality(v.quality)), "personalVoice": .bool(isPersonal(v)),
            // speechVoices() lists only voices whose assets are on disk.
            "installed": true,
        ]
    }

    /// Picks the voice. Personal Voice is used only on explicit opt-in (`personalVoice: true`) with
    /// Personal Voice authorization granted; a personal voice id without the opt-in is refused.
    static func resolveVoice(_ p: SynthesizeParams) throws -> AVSpeechSynthesisVoice {
        if p.personalVoice, AVSpeechSynthesizer.personalVoiceAuthorizationStatus != .authorized {
            throw CapabilityError(
                .forbidden, reason: "personal_voice_unauthorized",
                "Personal Voice is not authorized for Psyche (Helper). Allow it in System Settings › Accessibility › Personal Voice.",
                details: ["status": .string(personalVoiceStatus())])
        }
        if let id = p.voice {
            guard let v = AVSpeechSynthesisVoice(identifier: id) else {
                throw CapabilityError(.notFound, reason: "voice_not_found", "No installed voice has this identifier", details: ["voice": .string(id)])
            }
            if isPersonal(v), !p.personalVoice {
                throw CapabilityError(.forbidden, reason: "personal_voice_opt_in_required", "Using a Personal Voice needs personalVoice: true")
            }
            if p.personalVoice, !isPersonal(v) {
                throw CapabilityError.invalidParams("voice is not a Personal Voice", field: "voice")
            }
            return v
        }
        if p.personalVoice {
            guard let v = AVSpeechSynthesisVoice.speechVoices().first(where: isPersonal) else {
                throw CapabilityError(.notFound, reason: "no_personal_voice", "No Personal Voice is available")
            }
            return v
        }
        if let v = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode()) ?? AVSpeechSynthesisVoice(language: "en-US") {
            return v
        }
        throw CapabilityError.unavailable("no_voice", "No speech synthesis voice is installed")
    }

    /// The best installed voice for `language` (premium, then enhanced, then default; never a
    /// Personal Voice), as the conversation picks it when the owner chose none (voice mode §4.8).
    static func bestVoice(language: String) -> AVSpeechSynthesisVoice? {
        let lang = language.lowercased().replacingOccurrences(of: "_", with: "-")
        let rank: (AVSpeechSynthesisVoice) -> Int = { v in
            switch v.quality {
            case .premium: 3
            case .enhanced: 2
            default: 1
            }
        }
        let all = AVSpeechSynthesisVoice.speechVoices().filter { !isPersonal($0) }
        let exact = all.filter { $0.language.lowercased() == lang }
        let prefix = all.filter { $0.language.lowercased().hasPrefix(lang.split(separator: "-").first.map(String.init) ?? lang) }
        let pool = exact.isEmpty ? prefix : exact
        return pool.max { a, b in (rank(a), b.identifier) < (rank(b), a.identifier) }
    }

    static func run(_ p: SynthesizeParams, backend: any SynthesisBackend, timings: SpeechTimings,
                    emit: @escaping @Sendable (JSONValue) async -> Void) async throws -> CapabilityOutput {
        let voice = try backend.resolve(p)
        let clock = ContinuousClock()
        let started = clock.now
        let render = try await backend.render(
            p.text, voice: voice, rate: p.utteranceRate(min: AVSpeechUtteranceMinimumSpeechRate, max: AVSpeechUtteranceMaximumSpeechRate))

        var seq = 0
        var frames = 0
        var converter: PCMBufferConverter?
        var wire: PCMAudioFormat?
        try await withTaskCancellationHandler {
            for await box in render.buffers {
                try _Concurrency.Task.checkCancellation()
                let input = box.buffer
                if converter == nil {
                    let rate = input.format.sampleRate
                    let channels = input.format.channelCount
                    guard let out = SpeechAudio.avFormat(p.format, sampleRate: rate, channels: channels) else {
                        throw CapabilityError.unavailable("unsupported_audio_format", "Cannot produce this audio format")
                    }
                    converter = try PCMBufferConverter(from: input.format, to: out)
                    wire = PCMAudioFormat(encoding: p.format, sampleRate: Int(rate), channels: Int(channels))
                }
                guard let converter, let wire, let converted = try converter.convert(input) else { continue }
                if seq == 0 { timings.record(.synthesisFirstAudio, ms: elapsedMs(started, clock.now)) }
                frames += Int(converted.frameLength)
                for chunk in PCMChunker.split(SpeechAudio.data(from: converted), bytesPerFrame: wire.bytesPerFrame) {
                    await emit(SpeechEvent.audio(seq: seq, data: chunk, format: wire, utteranceId: p.utteranceId))
                    seq += 1
                }
            }
        } onCancel: {
            _Concurrency.Task { await render.cancel() }
        }
        try _Concurrency.Task.checkCancellation()
        await render.finished()
        let format = wire ?? PCMAudioFormat(encoding: p.format, sampleRate: 22_050, channels: 1)
        var out: [String: JSONValue] = [
            "format": format.json,
            "durationMs": .int(SpeechAudio.durationMs(frames: frames, sampleRate: Double(format.sampleRate))),
            "chunks": .int(seq),
            "voice": .string(voice.id),
            "personalVoice": .bool(voice.personal),
            // Apple's SLA limits Personal Voice output to personal, non-commercial use.
            "nonCommercial": .bool(voice.personal),
            "warm": .bool(render.warm),
        ]
        if let id = p.utteranceId { out["utteranceId"] = .string(id) }
        return CapabilityOutput(.object(out))
    }
}

/// A voice `speech.synthesize` resolved.
public struct SynthesisVoice: Sendable, Equatable {
    public var id: String
    public var personal: Bool
    public init(id: String, personal: Bool) {
        self.id = id
        self.personal = personal
    }
}

/// One rendering: its buffers (ending when the utterance is done), whether a warm synthesizer
/// rendered it, and hooks to cancel it or hand the synthesizer back once it is drained.
public struct SynthesisRender: Sendable {
    public var buffers: AsyncStream<PCMBufferBox>
    public var warm: Bool
    public var cancel: @Sendable () async -> Void
    public var finished: @Sendable () async -> Void

    public init(buffers: AsyncStream<PCMBufferBox>, warm: Bool, cancel: @escaping @Sendable () async -> Void,
                finished: @escaping @Sendable () async -> Void = {}) {
        self.buffers = buffers
        self.warm = warm
        self.cancel = cancel
        self.finished = finished
    }
}

/// The synthesizer behind `speech.synthesize` / `speech.prepare`. Live: `AVSpeechSynthesizer`
/// (rendering to buffers only; the helper never plays audio). Tests pass a fake.
public protocol SynthesisBackend: Sendable {
    func resolve(_ p: SynthesizeParams) throws -> SynthesisVoice
    func render(_ text: String, voice: SynthesisVoice, rate: Float?) async throws -> SynthesisRender
    /// Loads `voice` (or the best voice for `language`, else the default) into a synthesizer kept
    /// for `keepWarmMs` without use, by rendering a short phrase that is thrown away.
    func prepare(voice: String?, language: String?, keepWarmMs: Int) async throws -> SynthesisVoice
}

public struct LiveSynthesisBackend: SynthesisBackend {
    public init() {}

    public func resolve(_ p: SynthesizeParams) throws -> SynthesisVoice {
        let v = try SpeechSynthesis.resolveVoice(p)
        return SynthesisVoice(id: v.identifier, personal: SpeechSynthesis.isPersonal(v))
    }

    public func render(_ text: String, voice: SynthesisVoice, rate: Float?) async throws -> SynthesisRender {
        guard let v = AVSpeechSynthesisVoice(identifier: voice.id) else {
            throw CapabilityError(.notFound, reason: "voice_not_found", "No installed voice has this identifier", details: ["voice": .string(voice.id)])
        }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = v
        if let rate { utterance.rate = rate }
        let job = SynthesisJob(utterance: utterance, voiceId: voice.id)
        let warm = await MainActor.run { job.start(WarmSynthesizers.shared.checkout(voice.id)) }
        return SynthesisRender(
            buffers: job.buffers, warm: warm,
            cancel: { await MainActor.run { job.stop() } },
            finished: { await MainActor.run { job.finish() } })
    }

    public func prepare(voice: String?, language: String?, keepWarmMs: Int) async throws -> SynthesisVoice {
        let v: AVSpeechSynthesisVoice
        if let voice {
            guard let found = AVSpeechSynthesisVoice(identifier: voice) else {
                throw CapabilityError(.notFound, reason: "voice_not_found", "No installed voice has this identifier", details: ["voice": .string(voice)])
            }
            // Warming a Personal Voice needs the same opt-in as speaking with it.
            if SpeechSynthesis.isPersonal(found) {
                throw CapabilityError(.forbidden, reason: "personal_voice_opt_in_required", "speech.prepare does not warm a Personal Voice")
            }
            v = found
        } else if let language, let best = SpeechSynthesis.bestVoice(language: language) {
            v = best
        } else {
            v = try SpeechSynthesis.resolveVoice(SynthesizeParams(text: "."))
        }
        let resolved = SynthesisVoice(id: v.identifier, personal: false)
        let warm = try await render("Ready.", voice: resolved, rate: nil)
        for await _ in warm.buffers {}
        await warm.finished()
        await MainActor.run { WarmSynthesizers.shared.keep(v.identifier, forMs: keepWarmMs) }
        return resolved
    }
}

/// Synthesizers kept alive per voice between sentences of a conversation (§5: a cold
/// AVSpeechSynthesizer took 0.8 s to its first audio). One render at a time per synthesizer; a
/// second concurrent sentence gets a fresh one. Unused entries expire after their keep-warm time.
@MainActor final class WarmSynthesizers {
    static let shared = WarmSynthesizers()

    private struct Entry {
        var synthesizer: AVSpeechSynthesizer
        var busy: Bool
        var keepMs: Int
        var generation: Int
    }

    private var entries: [String: Entry] = [:]
    private var generation = 0

    /// The idle warm synthesizer for `voiceId`, marked busy; nil when there is none or it is busy.
    func checkout(_ voiceId: String) -> AVSpeechSynthesizer? {
        guard var e = entries[voiceId], !e.busy else { return nil }
        e.busy = true
        entries[voiceId] = e
        return e.synthesizer
    }

    /// Hands a synthesizer back after a render. A voice that was never prepared is kept only if it
    /// was the one checked out.
    func checkin(_ voiceId: String, _ synthesizer: AVSpeechSynthesizer) {
        guard var e = entries[voiceId], e.synthesizer === synthesizer else { return }
        e.busy = false
        entries[voiceId] = e
        scheduleExpiry(voiceId)
    }

    /// Keeps (or starts keeping) the synthesizer that just rendered `voiceId`.
    func keep(_ voiceId: String, forMs ms: Int) {
        if var e = entries[voiceId] {
            e.keepMs = ms
            entries[voiceId] = e
        }
        scheduleExpiry(voiceId)
    }

    /// Adopts a fresh synthesizer that just rendered `voiceId`, unless the voice already has one.
    @discardableResult func adopt(_ voiceId: String, _ synthesizer: AVSpeechSynthesizer) -> Bool {
        guard entries[voiceId] == nil else { return false }
        entries[voiceId] = Entry(synthesizer: synthesizer, busy: false, keepMs: SpeechPrepareParams.defaultKeepWarmMs, generation: 0)
        scheduleExpiry(voiceId)
        return true
    }

    var count: Int { entries.count }

    private func scheduleExpiry(_ voiceId: String) {
        guard var e = entries[voiceId] else { return }
        generation += 1
        e.generation = generation
        entries[voiceId] = e
        let mine = generation
        let ms = e.keepMs
        _Concurrency.Task { @MainActor [weak self] in
            try? await _Concurrency.Task.sleep(for: .milliseconds(ms))
            guard let self, let e = self.entries[voiceId], e.generation == mine, !e.busy else { return }
            self.entries[voiceId] = nil
        }
    }
}

/// One `write` on a synthesizer (warm or fresh), started and stopped on the main actor.
private final class SynthesisJob: @unchecked Sendable {
    let buffers: AsyncStream<PCMBufferBox>
    private let continuation: AsyncStream<PCMBufferBox>.Continuation
    private let utterance: AVSpeechUtterance
    private let voiceId: String
    private var synthesizer: AVSpeechSynthesizer?
    private var adopted = false

    init(utterance: AVSpeechUtterance, voiceId: String) {
        self.utterance = utterance
        self.voiceId = voiceId
        (buffers, continuation) = AsyncStream.makeStream(of: PCMBufferBox.self)
    }

    /// Returns true when it reused a warm synthesizer.
    @MainActor func start(_ warm: AVSpeechSynthesizer?) -> Bool {
        let synthesizer = warm ?? AVSpeechSynthesizer()
        self.synthesizer = synthesizer
        adopted = warm != nil
        let continuation = self.continuation
        synthesizer.write(utterance) { buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength > 0 else {
                continuation.finish()
                return
            }
            if let copy = SpeechAudio.copy(pcm) { continuation.yield(PCMBufferBox(buffer: copy)) }
        }
        return adopted
    }

    @MainActor func stop() {
        synthesizer?.stopSpeaking(at: .immediate)
        continuation.finish()
        if let synthesizer, adopted { WarmSynthesizers.shared.checkin(voiceId, synthesizer) }
        synthesizer = nil
    }

    /// The write finished: a warm synthesizer goes back to the pool; a fresh one becomes the
    /// voice's warm synthesizer if it has none, so the next sentence starts warm.
    @MainActor func finish() {
        guard let synthesizer else { return }
        if adopted {
            WarmSynthesizers.shared.checkin(voiceId, synthesizer)
        } else {
            WarmSynthesizers.shared.adopt(voiceId, synthesizer)
        }
        self.synthesizer = nil
    }
}

/// Personal Voice authorization. Live: `AVSpeechSynthesizer`; tests pass a fake.
public protocol PersonalVoiceAuthorizer: Sendable {
    /// One of `PersonalVoiceAuth.statuses`; never prompts.
    func status() -> String
    /// Shows the system prompt (only ever called while the status is `notDetermined`).
    func request() async -> String
}

public struct LivePersonalVoiceAuthorizer: PersonalVoiceAuthorizer {
    public init() {}

    public func status() -> String { SpeechSynthesis.personalVoiceStatus() }

    public func request() async -> String {
        _ = await AVSpeechSynthesizer.requestPersonalVoiceAuthorization()
        return SpeechSynthesis.personalVoiceStatus()
    }
}
