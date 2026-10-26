import AVFAudio
import Foundation
import PsycheHelperCore
import PsycheHelperSystem
import PsycheProtocol
import Testing

/// `speech.synthesize` / `speech.prepare` on a fake synthesizer (voice mode V-H H2). No
/// AVSpeechSynthesizer runs and nothing is played.
@Suite("speech synthesis on a fake backend")
struct SpeechSynthesisTests {
    struct DenyAll: PermissionPreflight {
        func isGranted(_ permission: TCCPermission) -> Bool { false }
    }

    /// Renders `chunks` buffers of 0.1 s Float32 mono at 22.05 kHz, like the compact voices.
    final class FakeSynth: SynthesisBackend, @unchecked Sendable {
        private let lock = NSLock()
        private var _renders: [(text: String, voice: String, rate: Float?)] = []
        private var _prepared: [(voice: String?, language: String?, keepWarmMs: Int)] = []
        private var warmVoices: Set<String> = []
        var chunks = 3

        var renders: [(text: String, voice: String, rate: Float?)] { lock.withLock { _renders } }
        var prepared: [(voice: String?, language: String?, keepWarmMs: Int)] { lock.withLock { _prepared } }

        func resolve(_ p: SynthesizeParams) throws -> SynthesisVoice {
            if p.voice == "missing" { throw CapabilityError(.notFound, reason: "voice_not_found", "no such voice") }
            return SynthesisVoice(id: p.voice ?? "com.apple.voice.compact.en-US.Samantha", personal: false)
        }

        func render(_ text: String, voice: SynthesisVoice, rate: Float?) async throws -> SynthesisRender {
            let warm = lock.withLock {
                _renders.append((text, voice.id, rate))
                return !warmVoices.insert(voice.id).inserted
            }
            let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 22_050, channels: 1, interleaved: false)!
            let (stream, feed) = AsyncStream.makeStream(of: PCMBufferBox.self)
            for i in 0..<chunks {
                let b = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2205)!
                b.frameLength = 2205
                for f in 0..<2205 { b.floatChannelData![0][f] = Float(i) * 0.1 }
                feed.yield(PCMBufferBox(buffer: b))
            }
            feed.finish()
            return SynthesisRender(buffers: stream, warm: warm, cancel: {})
        }

        func prepare(voice: String?, language: String?, keepWarmMs: Int) async throws -> SynthesisVoice {
            lock.withLock {
                _prepared.append((voice, language, keepWarmMs))
                warmVoices.insert(voice ?? "best.\(language ?? "default")")
            }
            return SynthesisVoice(id: voice ?? "best.\(language ?? "default")", personal: false)
        }
    }

    final class Events: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [JSONValue] = []
        func add(_ v: JSONValue) { lock.withLock { items.append(v) } }
        var all: [JSONValue] { lock.withLock { items } }
    }

    let synth = FakeSynth()
    let timings = SpeechTimings()

    func invoke(_ name: String, _ params: JSONValue, events: Events = Events()) async throws -> JSONValue {
        let h = SpeechCapabilities.make(preflight: DenyAll(), log: HelperLog(echo: { _ in }), synthesis: synth, timings: timings)
            .first { $0.spec.name == name }!
        let ctx = InvocationContext(invocationId: "inv", capability: name, params: params, approvalId: nil, emit: { events.add($0) })
        return try await h.invoke(ctx).result
    }

    @Test func sentencePcmCarriesItsUtteranceId() async throws {
        let events = Events()
        let r = try await invoke("speech.synthesize", ["text": "First sentence.", "speed": .number(1.29), "utteranceId": "utt_1"], events: events)
        #expect(events.all.count == 3)
        #expect(events.all.allSatisfy { $0["type"] == "speech.audio" && $0["utteranceId"] == "utt_1" })
        #expect(events.all.map { $0["seq"] } == [0, 1, 2])
        #expect(events.all.first?["format"] == ["encoding": "pcm_s16le", "sampleRate": 22_050, "channels": 1])
        // 2205 frames of 16-bit mono per chunk, base64 in the event.
        if case .string(let b64) = events.all[1]["data"] { #expect(Data(base64Encoded: b64)?.count == 4410) } else { Issue.record("no data") }
        #expect(r["utteranceId"] == "utt_1" && r["durationMs"] == 300 && r["chunks"] == 3 && r["warm"] == false)
        #expect(synth.renders.first?.rate == 0.55)
        #expect(timings.median(.synthesisFirstAudio) != nil)
    }

    @Test func prepareWarmsTheNextSentence() async throws {
        let p = try await invoke("speech.prepare", ["voice": "com.apple.voice.premium.en-US.Zoe", "keepWarmMs": 30_000])
        #expect(p["voice"] == "com.apple.voice.premium.en-US.Zoe" && p["prepared"] == true)
        #expect(synth.prepared.map(\.keepWarmMs) == [30_000])
        let r = try await invoke("speech.synthesize", ["text": "Hello.", "voice": "com.apple.voice.premium.en-US.Zoe"])
        #expect(r["warm"] == true)
        // Language only: the backend picks the best voice; the default keep-warm applies.
        let l = try await invoke("speech.prepare", ["language": "fr-FR"])
        #expect(l["voice"] == "best.fr-FR" && synth.prepared.last?.keepWarmMs == 120_000)
    }

    @Test func oldCallsKeepWorking() async throws {
        let events = Events()
        let r = try await invoke("speech.synthesize", ["text": "Plain.", "rate": .number(0.5), "format": "pcm_f32le"], events: events)
        #expect(events.all.allSatisfy { $0["utteranceId"] == nil })
        #expect(r["utteranceId"] == nil && r["format"]?["encoding"] == "pcm_f32le" && r["nonCommercial"] == false)
        #expect(synth.renders.first?.rate == AVSpeechUtteranceMinimumSpeechRate + 0.5 * (AVSpeechUtteranceMaximumSpeechRate - AVSpeechUtteranceMinimumSpeechRate))
    }

    @Test func invalidParamsBeforeAnyRender() async {
        for params: JSONValue in [["text": "a", "speed": 3], ["text": "a", "utteranceId": ""], ["text": ""]] {
            await #expect(throws: CapabilityError.self) { _ = try await invoke("speech.synthesize", params) }
        }
        await #expect(throws: CapabilityError.self) { _ = try await invoke("speech.prepare", ["keepWarmMs": 10]) }
        await #expect(throws: CapabilityError.self) { _ = try await invoke("speech.synthesize", ["text": "a", "voice": "missing"]) }
        #expect(synth.renders.isEmpty && synth.prepared.isEmpty)
    }
}
