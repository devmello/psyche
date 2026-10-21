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

    static func run(_ p: SynthesizeParams, emit: @escaping @Sendable (JSONValue) async -> Void) async throws -> CapabilityOutput {
        let voice = try resolveVoice(p)
        let personal = isPersonal(voice)
        let voiceId = voice.identifier
        let utterance = AVSpeechUtterance(string: p.text)
        utterance.voice = voice
        if let rate = p.rate {
            let lo = AVSpeechUtteranceMinimumSpeechRate, hi = AVSpeechUtteranceMaximumSpeechRate
            utterance.rate = lo + Float(rate) * (hi - lo)
        }
        let job = SynthesisJob(utterance: utterance)
        let buffers = job.buffers
        await MainActor.run { job.start() }

        var seq = 0
        var frames = 0
        var converter: PCMBufferConverter?
        var wire: PCMAudioFormat?
        try await withTaskCancellationHandler {
            for await box in buffers {
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
                frames += Int(converted.frameLength)
                for chunk in PCMChunker.split(SpeechAudio.data(from: converted), bytesPerFrame: wire.bytesPerFrame) {
                    await emit(SpeechEvent.audio(seq: seq, data: chunk, format: wire))
                    seq += 1
                }
            }
        } onCancel: {
            _Concurrency.Task { @MainActor in job.stop() }
        }
        try _Concurrency.Task.checkCancellation()
        // Keeps the synthesizer alive until the write finished (it stops when deallocated).
        await MainActor.run { job.release() }
        let format = wire ?? PCMAudioFormat(encoding: p.format, sampleRate: 22_050, channels: 1)
        return CapabilityOutput([
            "format": format.json,
            "durationMs": .int(SpeechAudio.durationMs(frames: frames, sampleRate: Double(format.sampleRate))),
            "chunks": .int(seq),
            "voice": .string(voiceId),
            "personalVoice": .bool(personal),
            // Apple's SLA limits Personal Voice output to personal, non-commercial use.
            "nonCommercial": .bool(personal),
        ])
    }
}

/// Owns one synthesizer for one `write`. Created off-main, started and stopped on the main actor.
private final class SynthesisJob: @unchecked Sendable {
    let buffers: AsyncStream<PCMBufferBox>
    private let continuation: AsyncStream<PCMBufferBox>.Continuation
    private let utterance: AVSpeechUtterance
    private var synthesizer: AVSpeechSynthesizer?

    init(utterance: AVSpeechUtterance) {
        self.utterance = utterance
        (buffers, continuation) = AsyncStream.makeStream(of: PCMBufferBox.self)
    }

    @MainActor func start() {
        let synthesizer = AVSpeechSynthesizer()
        self.synthesizer = synthesizer
        let continuation = self.continuation
        synthesizer.write(utterance) { buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength > 0 else {
                continuation.finish()
                return
            }
            if let copy = SpeechAudio.copy(pcm) { continuation.yield(PCMBufferBox(buffer: copy)) }
        }
    }

    @MainActor func stop() {
        synthesizer?.stopSpeaking(at: .immediate)
        continuation.finish()
        synthesizer = nil
    }

    @MainActor func release() {
        synthesizer = nil
    }
}
