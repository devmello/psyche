import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

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

    @Test func timingsMedianOfTheWindow() throws {
        let t = SpeechTimings(window: 3)
        #expect(t.json == [:])
        t.record(.finalizeShort, ms: 800)
        #expect(t.median(.finalizeShort) == 800)
        t.record(.finalizeShort, ms: 120)
        #expect(t.median(.finalizeShort) == 460)
        t.record(.finalizeShort, ms: 140)
        t.record(.finalizeShort, ms: 130)  // drops the 800
        #expect(t.median(.finalizeShort) == 130)
        let decoded = try JSONDecoder().decode(HelperSpeechTimings.self, from: JSONEncoder().encode(t.json))
        #expect(decoded.finalizeMS?.short == 130)
    }
}
