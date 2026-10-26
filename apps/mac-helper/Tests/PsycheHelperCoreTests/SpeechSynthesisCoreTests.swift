import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

/// Voice mode V-H H2: speed mapping, synthesize / prepare params and timing medians.
@Suite("speech synthesis core")
struct SpeechSynthesisCoreTests {
    @Test func speedMapsThroughTheMeasuredTable() {
        #expect(SpeechRate.utteranceRate(speed: 1) == 0.5)
        #expect(SpeechRate.utteranceRate(speed: 1.29) == 0.55)
        #expect(abs(SpeechRate.utteranceRate(speed: 2) - 0.6815) < 0.001)
        // Below the slowest measured point the rate does not go lower (the voice gets no slower).
        #expect(SpeechRate.utteranceRate(speed: 0.5) == 0.3)
        #expect(SpeechRate.utteranceRate(speed: .nan) == 0.5)
        // Monotonic across 0.8–1.5×, the conversation's range.
        let rates = stride(from: 0.8, through: 1.5, by: 0.05).map { SpeechRate.utteranceRate(speed: $0) }
        #expect(zip(rates, rates.dropFirst()).allSatisfy { $0 <= $1 })
    }

    @Test func synthesizeParams() throws {
        let p = try JSONDecoder().decode(SynthesizeParams.self, from: Data(#"{"text":"Hi.","speed":1.29,"rate":0.1,"utteranceId":"u_1"}"#.utf8)).validated()
        #expect(p.utteranceId == "u_1")
        // speed wins over rate; rate alone spans the system range; neither means the default.
        #expect(p.utteranceRate(min: 0, max: 1) == 0.55)
        #expect(SynthesizeParams(text: "a", rate: 0.25).utteranceRate(min: 0, max: 1) == 0.25)
        #expect(SynthesizeParams(text: "a").utteranceRate(min: 0, max: 1) == nil)
        #expect(throws: CapabilityError.self) { try SynthesizeParams(text: "a", speed: 2.5).validated() }
        #expect(throws: CapabilityError.self) { try SynthesizeParams(text: "a", utteranceId: "").validated() }
        #expect(throws: CapabilityError.self) { try SynthesizeParams(text: "a", utteranceId: String(repeating: "u", count: 65)).validated() }
        // The old shape still decodes.
        let old = try JSONDecoder().decode(SynthesizeParams.self, from: Data(#"{"text":"Hi.","rate":0.5}"#.utf8)).validated()
        #expect(old.speed == nil && old.utteranceId == nil && old.format == .pcmS16le)
    }

    @Test func prepareParams() throws {
        #expect(try SpeechPrepareParams().validated().keepWarmMs == 120_000)
        #expect(try SpeechPrepareParams(language: "fr-FR", keepWarmMs: 5000).validated() == SpeechPrepareParams(language: "fr-FR", keepWarmMs: 5000))
        #expect(throws: CapabilityError.self) { try SpeechPrepareParams(keepWarmMs: 999).validated() }
        #expect(throws: CapabilityError.self) { try SpeechPrepareParams(language: "nope nope").validated() }
        #expect(throws: CapabilityError.self) { try SpeechPrepareParams(voice: "").validated() }
    }

    @Test func timingsMedianOfTheWindow() throws {
        let t = SpeechTimings(window: 3)
        #expect(t.json == [:])
        t.record(.synthesisFirstAudio, ms: 800)
        #expect(t.median(.synthesisFirstAudio) == 800)
        t.record(.synthesisFirstAudio, ms: 120)
        #expect(t.median(.synthesisFirstAudio) == 460)
        t.record(.synthesisFirstAudio, ms: 140)
        t.record(.synthesisFirstAudio, ms: 130)  // drops the cold 800
        #expect(t.median(.synthesisFirstAudio) == 130)
        let decoded = try JSONDecoder().decode(HelperSpeechTimings.self, from: JSONEncoder().encode(t.json))
        #expect(decoded.synthesisFirstAudioMS == 130)
    }

    @Test func audioEventCarriesTheUtteranceId() {
        let fmt = PCMAudioFormat(encoding: .pcmS16le, sampleRate: 22_050, channels: 1)
        #expect(SpeechEvent.audio(seq: 0, data: Data([1, 2]), format: fmt, utteranceId: "u_7")["utteranceId"] == "u_7")
        #expect(SpeechEvent.audio(seq: 0, data: Data([1, 2]), format: fmt)["utteranceId"] == nil)
    }
}

/// Voice mode V-H H3: the short preset.
@Suite("speech short preset core")
struct SpeechShortPresetCoreTests {
    let os26 = OperatingSystemVersion(majorVersion: 26, minorVersion: 0, patchVersion: 0)
    let os15 = OperatingSystemVersion(majorVersion: 15, minorVersion: 6, patchVersion: 0)

    @Test func shortPrefersDictation() throws {
        let all = SpeechEngineAvailability(speechTranscriber: true, dictationTranscriber: true, sfSpeechOnDevice: true)
        #expect(try SpeechEngineSelector.select(os: os26, vocabulary: [], availability: all, preset: .short) == .dictationTranscriber)
        #expect(try SpeechEngineSelector.select(os: os26, vocabulary: [], availability: all) == .speechAnalyzer)
        // Falls through as before when DictationTranscriber cannot serve the locale, and before 26.
        let noDictation = SpeechEngineAvailability(speechTranscriber: true, dictationTranscriber: false, sfSpeechOnDevice: true)
        #expect(try SpeechEngineSelector.select(os: os26, vocabulary: [], availability: noDictation, preset: .short) == .speechAnalyzer)
        #expect(try SpeechEngineSelector.select(os: os15, vocabulary: [], availability: all, preset: .short) == .sfSpeech)
    }

    @Test func presetParams() throws {
        let fmt = #""format":{"encoding":"pcm_s16le","sampleRate":16000,"channels":1}"#
        let short = try JSONDecoder().decode(TranscribeStreamParams.self, from: Data(#"{"source":"push",\#(fmt),"preset":"short"}"#.utf8)).validated()
        #expect(short.preset == .short)
        let plain = try JSONDecoder().decode(TranscribeStreamParams.self, from: Data(#"{"source":"push",\#(fmt)}"#.utf8)).validated()
        #expect(plain.preset == .long)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(TranscribeStreamParams.self, from: Data(#"{"preset":"medium"}"#.utf8)) }
        #expect(SpeechTimings.Metric.finalize(.short) == .finalizeShort && SpeechTimings.Metric.firstPartial(.long) == .firstPartialLong)
    }

    @Test func timingsJsonPairs() {
        let t = SpeechTimings()
        t.record(.firstPartialShort, ms: 420)
        t.record(.finalizeLong, ms: 300)
        #expect(t.json == ["firstPartialMs": ["short": 420], "finalizeMs": ["long": 300]])
    }
}
