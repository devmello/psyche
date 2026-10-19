import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

private func os(_ major: Int) -> OperatingSystemVersion { OperatingSystemVersion(majorVersion: major, minorVersion: 0, patchVersion: 0) }
private func avail(_ st: Bool, _ dt: Bool, _ sf: Bool) -> SpeechEngineAvailability {
    SpeechEngineAvailability(speechTranscriber: st, dictationTranscriber: dt, sfSpeechOnDevice: sf)
}

@Suite("speech engine selection")
struct SpeechEngineSelectionTests {
    @Test(arguments: [
        // (major, vocabulary?, speechTranscriber, dictation, sfSpeech, expected)
        (26, false, true, true, true, SpeechEngineKind?.some(.speechAnalyzer)),
        (26, true, true, true, true, .dictationTranscriber),
        (27, true, true, true, true, .dictationTranscriber),
        (26, true, true, false, true, .speechAnalyzer),
        (26, false, false, true, true, .dictationTranscriber),
        (26, false, false, false, true, .sfSpeech),
        (15, false, true, true, true, .sfSpeech),
        (15, true, true, true, true, .sfSpeech),
        (15, false, false, false, false, nil),
        (26, true, false, false, false, nil),
    ])
    func matrix(major: Int, vocabulary: Bool, st: Bool, dt: Bool, sf: Bool, expected: SpeechEngineKind?) {
        let vocab = vocabulary ? ["Psyche"] : []
        let result = try? SpeechEngineSelector.select(os: os(major), vocabulary: vocab, availability: avail(st, dt, sf))
        #expect(result == expected)
    }

    @Test func noEngineIsUnavailable() {
        #expect(throws: CapabilityError.unavailable("no_speech_engine", "No on-device speech engine supports this locale on this Mac")) {
            try SpeechEngineSelector.select(os: os(15), vocabulary: [], availability: avail(false, false, false))
        }
    }

    @Test func gate() {
        #expect(!SpeechEngineSelector.analyzerGateOpen(os(15)))
        #expect(SpeechEngineSelector.analyzerGateOpen(os(26)))
        #expect(SpeechEngineSelector.analyzerGateOpen(os(27)))
    }
}

@Suite("speech PCM")
struct SpeechPCMTests {
    @Test func s16RoundTripIsExact() {
        var bytes = Data()
        for v in [Int16.min, -12345, -1, 0, 1, 12345, Int16.max] {
            let u = UInt16(bitPattern: v)
            bytes.append(UInt8(u & 0xff))
            bytes.append(UInt8(u >> 8))
        }
        let floats = PCMConvert.float32(fromS16LE: bytes)
        #expect(floats.count == 7)
        #expect(floats[0] == -1)
        #expect(floats[3] == 0)
        #expect(PCMConvert.s16LE(fromFloat32: floats) == bytes)
    }

    @Test func allInt16ValuesRoundTrip() {
        var bytes = Data(capacity: 65536 * 2)
        for v in Int16.min...Int16.max {
            let u = UInt16(bitPattern: v)
            bytes.append(UInt8(u & 0xff))
            bytes.append(UInt8(u >> 8))
        }
        #expect(PCMConvert.s16LE(fromFloat32: PCMConvert.float32(fromS16LE: bytes)) == bytes)
    }

    @Test func clipping() {
        let data = PCMConvert.s16LE(fromFloat32: [2, 1, -1, -3, .nan, .infinity, -.infinity, 0.5])
        let bytes = [UInt8](data)
        let back: [Int16] = (0..<8).map { (i: Int) -> Int16 in Int16(bitPattern: UInt16(bytes[2 * i]) | UInt16(bytes[2 * i + 1]) << 8) }
        #expect(back == [32767, 32767, -32768, -32768, 0, 32767, -32768, 16384])
    }

    @Test func littleEndianLayout() {
        #expect(PCMConvert.s16LE(fromFloat32: [0.5]) == Data([0x00, 0x40]))
        #expect(PCMConvert.f32LE(fromFloat32: [1]) == Data([0x00, 0x00, 0x80, 0x3f]))
    }

    @Test func f32RoundTripAndCrossConversion() {
        let samples: [Float] = [-1, -0.25, 0, 0.125, 0.999]
        let f32 = PCMConvert.f32LE(fromFloat32: samples)
        #expect(PCMConvert.float32(fromF32LE: f32) == samples)
        let s16 = PCMConvert.convert(f32, from: .pcmF32le, to: .pcmS16le)
        #expect(s16.count == samples.count * 2)
        let again = PCMConvert.convert(s16, from: .pcmS16le, to: .pcmF32le)
        #expect(PCMConvert.float32(fromF32LE: again).enumerated().allSatisfy { abs($0.element - samples[$0.offset]) < 1.0 / 32768 })
        #expect(PCMConvert.convert(f32, from: .pcmF32le, to: .pcmF32le) == f32)
    }

    @Test func oddTrailingBytesAreIgnored() {
        #expect(PCMConvert.float32(fromS16LE: Data([1, 2, 3])).count == 1)
        #expect(PCMConvert.float32(fromF32LE: Data([1, 2, 3])).isEmpty)
    }

    @Test func chunkSizes() {
        #expect(PCMChunker.maxRawBytes(bytesPerFrame: 2) == 49152)
        #expect(PCMChunker.maxRawBytes(bytesPerFrame: 8) == 49152)
        #expect(PCMChunker.maxRawBytes(bytesPerFrame: 6) % 6 == 0)
        let data = Data(count: 49152 * 2 + 100)
        let chunks = PCMChunker.split(data, bytesPerFrame: 2)
        #expect(chunks.map(\.count) == [49152, 49152, 100])
        #expect(chunks.allSatisfy { $0.base64EncodedString().utf8.count <= PCMChunker.defaultMaxEncodedBytes })
        #expect(chunks.reduce(Data(), +) == data)
        #expect(PCMChunker.split(Data(), bytesPerFrame: 2).isEmpty)
        #expect(PCMChunker.split(Data(count: 10), bytesPerFrame: 4, maxEncodedBytes: 8).map(\.count) == [4, 4, 2])
    }

    @Test func frameAligner() {
        var a = PCMFrameAligner(bytesPerFrame: 4)
        #expect(a.append(Data([1, 2, 3])).isEmpty)
        #expect(a.pendingByteCount == 3)
        #expect(a.append(Data([4, 5, 6, 7, 8, 9])) == Data([1, 2, 3, 4, 5, 6, 7, 8]))
        #expect(a.pendingByteCount == 1)
    }

    @Test func formatMath() {
        let f = PCMAudioFormat(encoding: .pcmS16le, sampleRate: 16000, channels: 1)
        #expect(f.bytesPerFrame == 2)
        #expect(f.byteCount(durationMs: 1000) == 32000)
        #expect(f.durationMs(byteCount: 32000) == 1000)
        #expect(PCMAudioFormat(encoding: .pcmF32le, sampleRate: 48000, channels: 2).bytesPerFrame == 8)
    }
}

@Suite("speech params")
struct SpeechParamsTests {
    func decode<T: Decodable>(_ type: T.Type, _ json: JSONValue) throws -> T {
        try InvocationContext(invocationId: "i", capability: "c", params: json, approvalId: nil, emit: { _ in }).decode(T.self)
    }

    @Test(arguments: ["en", "en-US", "en_US", "zh-Hant-TW", "yue-HK", "es-419"])
    func validLocales(_ id: String) { #expect(SpeechValidation.isValidLocaleIdentifier(id)) }

    @Test(arguments: ["", "e", "english", "en-", "-US", "en--US", "en-U", "en-US-toolongsubtag", "en US", "ée", "en-US;rm -rf", String(repeating: "ab-", count: 20) + "ab"])
    func invalidLocales(_ id: String) { #expect(!SpeechValidation.isValidLocaleIdentifier(id)) }

    @Test func transcribeDefaults() throws {
        let r = try decode(TranscribeStreamParams.self, .null).validated()
        #expect(r == TranscribeRequest(source: .microphone, locale: nil, vocabulary: [], format: nil, maxDurationMs: SpeechLimits.defaultMaxDurationMs, volatile: true))
    }

    @Test func pushNeedsValidFormat() throws {
        #expect(throws: CapabilityError.self) { try decode(TranscribeStreamParams.self, ["source": "push"]).validated() }
        #expect(throws: CapabilityError.self) {
            try decode(TranscribeStreamParams.self, ["source": "push", "format": ["encoding": "pcm_s16le", "sampleRate": .int(4000), "channels": 1]]).validated()
        }
        #expect(throws: CapabilityError.self) {
            try decode(TranscribeStreamParams.self, ["source": "push", "format": ["encoding": "pcm_s16le", "sampleRate": .int(16000), "channels": 3]]).validated()
        }
        #expect(throws: CapabilityError.self) {
            try decode(TranscribeStreamParams.self, ["source": "push", "format": ["encoding": "opus", "sampleRate": .int(16000), "channels": 1]]).validated()
        }
        #expect(throws: CapabilityError.self) {
            try decode(TranscribeStreamParams.self, ["format": ["encoding": "pcm_s16le", "sampleRate": .int(16000), "channels": 1]]).validated()
        }
        let ok = try decode(TranscribeStreamParams.self, [
            "source": "push", "locale": "en-US", "volatile": false, "maxDurationMs": .int(600_000),
            "format": ["encoding": "pcm_f32le", "sampleRate": .int(48000), "channels": 2],
        ]).validated()
        #expect(ok.format == PCMAudioFormat(encoding: .pcmF32le, sampleRate: 48000, channels: 2))
        #expect(ok.volatile == false && ok.maxDurationMs == 600_000 && ok.locale == "en-US")
    }

    @Test func durationBounds() {
        #expect(throws: CapabilityError.self) { try TranscribeStreamParams(maxDurationMs: 600_001).validated() }
        #expect(throws: CapabilityError.self) { try TranscribeStreamParams(maxDurationMs: 0).validated() }
        #expect((try? TranscribeStreamParams(maxDurationMs: 1000).validated()) != nil)
    }

    @Test func vocabularyLimits() throws {
        #expect(try SpeechValidation.vocabulary([" Psyche ", "Psyche", "Kokoro"]) == ["Psyche", "Kokoro"])
        #expect(try SpeechValidation.vocabulary(nil) == [])
        #expect((try? SpeechValidation.vocabulary(Array(repeating: "a", count: 100))) != nil)
        #expect(throws: CapabilityError.self) { try SpeechValidation.vocabulary((0...100).map { "w\($0)" }) }
        #expect(throws: CapabilityError.self) { try SpeechValidation.vocabulary([String(repeating: "x", count: 65)]) }
        #expect((try? SpeechValidation.vocabulary([String(repeating: "x", count: 64)])) != nil)
        #expect(throws: CapabilityError.self) { try SpeechValidation.vocabulary(["ok", "  "]) }
        #expect(throws: CapabilityError.self) { try TranscribeStreamParams(locale: "not a locale").validated() }
    }

    @Test func invalidParamsCarryField() {
        do {
            _ = try TranscribeStreamParams(vocabulary: ["ok", ""]).validated()
            Issue.record("expected failure")
        } catch let e as CapabilityError {
            #expect(e.code == .invalidParams)
            #expect(e.details["field"] == "vocabulary.1")
        } catch { Issue.record("wrong error") }
    }

    @Test func audioPush() throws {
        let p = try decode(AudioPushParams.self, ["streamId": "s1", "data": .string(Data([1, 2, 3, 4]).base64EncodedString())]).validated()
        #expect(p.streamId == "s1" && p.audio == Data([1, 2, 3, 4]) && !p.final)
        #expect(try AudioPushParams(streamId: "s", data: "", final: true).validated().final)
        #expect(throws: CapabilityError.self) { try AudioPushParams(streamId: "s", data: "!!notbase64").validated() }
        #expect(throws: CapabilityError.self) { try AudioPushParams(streamId: "", data: "").validated() }
        let big = Data(count: SpeechLimits.maxPushBytes + 3).base64EncodedString()
        #expect(throws: CapabilityError.self) { try AudioPushParams(streamId: "s", data: big).validated() }
        let max = Data(count: SpeechLimits.maxPushBytes).base64EncodedString()
        #expect((try? AudioPushParams(streamId: "s", data: max).validated()) != nil)
        #expect(throws: CapabilityError.self) { try decode(AudioPushParams.self, ["data": ""]) }
    }

    @Test func synthesize() throws {
        let p = try decode(SynthesizeParams.self, ["text": "Hello"]).validated()
        #expect(p == SynthesizeParams(text: "Hello", voice: nil, rate: nil, personalVoice: false, format: .pcmS16le))
        #expect(try decode(SynthesizeParams.self, ["text": "Hi", "format": "pcm_f32le", "personalVoice": true]).validated().format == .pcmF32le)
        #expect(throws: CapabilityError.self) { try SynthesizeParams(text: "  ").validated() }
        #expect(throws: CapabilityError.self) { try SynthesizeParams(text: String(repeating: "a", count: 5001)).validated() }
        #expect((try? SynthesizeParams(text: String(repeating: "a", count: 5000)).validated()) != nil)
        #expect(throws: CapabilityError.self) { try SynthesizeParams(text: "a", rate: 1.5).validated() }
        #expect(throws: CapabilityError.self) { try SynthesizeParams(text: "a", voice: "").validated() }
        #expect(throws: CapabilityError.self) { try decode(SynthesizeParams.self, ["text": "a", "format": "mp3"]) }
    }
}

@Suite("speech events")
struct SpeechEventTests {
    @Test func segmentPayloads() {
        let partial = SpeechSegment(text: "hel", startMs: 0, endMs: 300, final: false)
        #expect(SpeechEvent.segment(partial) == ["type": "speech.partial", "text": "hel", "startMs": 0, "endMs": 300, "final": false])
        let final = SpeechSegment(text: "hello", startSeconds: 0.25, endSeconds: 0.9, final: true, confidence: 0.87)
        #expect(SpeechEvent.segment(final) == ["type": "speech.final", "text": "hello", "startMs": 250, "endMs": 900, "final": true, "confidence": .number(0.87)])
    }

    @Test func segmentClamps() {
        let s = SpeechSegment(text: "x", startSeconds: .nan, endSeconds: -1, final: true, confidence: 1.7)
        #expect(s.startMs == 0 && s.endMs == 0)
        #expect(s.json["confidence"] == .number(1))
        #expect(SpeechSegment(text: "x", startMs: 500, endMs: 100, final: true).endMs == 500)
    }

    @Test func otherEvents() {
        let f = PCMAudioFormat(encoding: .pcmS16le, sampleRate: 22050, channels: 1)
        #expect(SpeechEvent.audio(seq: 3, data: Data([0, 1]), format: f) == [
            "type": "speech.audio", "seq": 3, "data": "AAE=", "format": ["encoding": "pcm_s16le", "sampleRate": 22050, "channels": 1],
        ])
        #expect(SpeechEvent.modelDownload(phase: .progress, locale: "en-US", fraction: 0.12345) == [
            "type": "speech.model_download", "phase": "progress", "locale": "en-US", "fraction": .number(0.123),
        ])
        #expect(SpeechEvent.started(streamId: "inv1", engine: .speechAnalyzer, language: "en-US", source: .microphone, format: nil) == [
            "type": "speech.started", "streamId": "inv1", "engine": "speechAnalyzer", "language": "en-US", "source": "microphone",
        ])
        #expect(SpeechEvent.started(streamId: "s", engine: .sfSpeech, language: "en-US", source: .push, format: f)["format"] == f.json)
    }

    @Test func accumulatorAndSummary() {
        var acc = TranscriptAccumulator()
        acc.ingest(SpeechSegment(text: "hel", startMs: 0, endMs: 200, final: false))
        acc.ingest(SpeechSegment(text: "hello wor", startMs: 0, endMs: 500, final: false))
        #expect(acc.volatile?.text == "hello wor")
        acc.ingest(SpeechSegment(text: " Hello world.", startMs: 0, endMs: 900, final: true))
        #expect(acc.volatile == nil)
        acc.ingest(SpeechSegment(text: "", startMs: 900, endMs: 1000, final: true))
        acc.ingest(SpeechSegment(text: "how", startMs: 1000, endMs: 1200, final: false))
        acc.ingest(SpeechSegment(text: "  ", startMs: 1000, endMs: 1200, final: false))
        #expect(acc.volatile == nil)
        acc.ingest(SpeechSegment(text: "How are you?", startMs: 1000, endMs: 1800, final: false))
        acc.promoteVolatile()
        #expect(acc.text == "Hello world. How are you?")
        #expect(acc.finals.count == 2 && acc.finals.allSatisfy(\.final))
        let summary = acc.summary(streamId: "inv", engine: .dictationTranscriber, language: "en-US", stopReason: .stopped, audioMs: 1800, firstResultMs: 240)
        #expect(summary["text"] == "Hello world. How are you?")
        #expect(summary["engine"] == "dictationTranscriber")
        #expect(summary["language"] == "en-US")
        #expect(summary["stopReason"] == "stopped")
        #expect(summary["firstResultMs"] == 240)
        #expect(summary["segments"]?.arrayValue?.count == 2)
        #expect(summary["segments"]?.arrayValue?.first?["final"] == true)
        #expect(acc.summary(streamId: "i", engine: .sfSpeech, language: "en", stopReason: .maxDuration, audioMs: 0, firstResultMs: nil)["firstResultMs"] == nil)
    }
}

@Suite("speech push buffer")
struct PushAudioBufferTests {
    @Test func ordersAndFinishes() async throws {
        let b = PushAudioBuffer(limitBytes: 100)
        try b.push(Data([1]))
        try b.push(Data([2, 2]))
        #expect(b.bufferedBytes == 3)
        try b.push(Data([3]), final: true)
        #expect(throws: PushAudioBuffer.PushError.finished) { try b.push(Data([4])) }
        #expect(await b.next() == Data([1]))
        #expect(await b.next() == Data([2, 2]))
        #expect(await b.next() == Data([3]))
        #expect(await b.next() == nil)
        #expect(await b.next() == nil)
        #expect(b.totalPushedBytes == 4 && b.bufferedBytes == 0)
    }

    @Test func backpressureLimit() async throws {
        let b = PushAudioBuffer(limitBytes: 10)
        try b.push(Data(count: 6))
        #expect(throws: PushAudioBuffer.PushError.overflow(buffered: 6, limit: 10)) { try b.push(Data(count: 5)) }
        try b.push(Data(count: 4))
        _ = await b.next()
        try b.push(Data(count: 5))
        #expect(b.bufferedBytes == 9)
        // A bare final is accepted even when full.
        try b.push(Data(count: 0), final: true)
        #expect(b.isFinished)
    }

    @Test func wakesWaitingConsumer() async throws {
        let b = PushAudioBuffer()
        async let first = b.next()
        try await _Concurrency.Task.sleep(for: .milliseconds(20))
        try b.push(Data([9]))
        #expect(await first == Data([9]))
        async let end = b.next()
        try await _Concurrency.Task.sleep(for: .milliseconds(20))
        b.finish()
        #expect(await end == nil)
    }

    @Test func finishDrainsCancelDrops() async throws {
        let b = PushAudioBuffer()
        try b.push(Data([1]))
        b.finish()
        #expect(await b.next() == Data([1]))
        #expect(await b.next() == nil)
        let c = PushAudioBuffer()
        try c.push(Data([1]))
        c.cancel()
        #expect(await c.next() == nil)
        #expect(c.bufferedBytes == 0)
    }

    @Test func cancellingConsumerEndsBuffer() async throws {
        let b = PushAudioBuffer()
        let t = _Concurrency.Task { await b.next() }
        try await _Concurrency.Task.sleep(for: .milliseconds(20))
        t.cancel()
        #expect(await t.value == nil)
        #expect(b.isFinished)
    }

    @Test func manyChunksKeepOrder() async throws {
        let b = PushAudioBuffer()
        let producer = _Concurrency.Task {
            for i in 0..<500 {
                while (try? b.push(Data([UInt8(i % 256)]))) == nil { await _Concurrency.Task.yield() }
            }
            b.finish()
        }
        var got: [UInt8] = []
        while let d = await b.next() { got.append(contentsOf: d) }
        await producer.value
        #expect(got == (0..<500).map { UInt8($0 % 256) })
    }
}

@Suite("speech stream registry")
struct SpeechStreamRegistryTests {
    @Test func oneMicrophoneAtATime() throws {
        let r = SpeechStreamRegistry()
        _ = try r.register(id: "a", source: .microphone)
        #expect(r.microphoneBusy)
        #expect(throws: SpeechErrors.microphoneBusy) { try r.register(id: "b", source: .microphone) }
        _ = try r.register(id: "c", source: .push)
        #expect(throws: SpeechErrors.streamExists("c")) { try r.register(id: "c", source: .push) }
        r.remove("a")
        _ = try r.register(id: "b", source: .microphone)
        #expect(r.activeCount == 2)
    }

    @Test func streamCap() throws {
        let r = SpeechStreamRegistry(maxStreams: 2)
        _ = try r.register(id: "a", source: .push)
        _ = try r.register(id: "b", source: .push)
        #expect(throws: SpeechErrors.tooManyStreams) { try r.register(id: "c", source: .push) }
    }

    @Test func pushAndStop() async throws {
        let r = SpeechStreamRegistry()
        let mic = try r.register(id: "m", source: .microphone)
        #expect(mic.pushBuffer == nil)
        #expect(throws: SpeechErrors.notPushStream) { try r.push(streamId: "m", audio: Data([1]), final: false) }
        #expect(throws: SpeechErrors.streamNotFound("x")) { try r.push(streamId: "x", audio: Data([1]), final: false) }
        #expect(SpeechErrors.streamNotFound("x").retryable)

        let p = try r.register(id: "p", source: .push, pushLimitBytes: 4)
        #expect(try r.push(streamId: "p", audio: Data([1, 2]), final: false) == 2)
        #expect(throws: SpeechErrors.pushBufferFull(buffered: 2, limit: 4)) { try r.push(streamId: "p", audio: Data([1, 2, 3]), final: false) }
        try r.stop(streamId: "p")
        #expect(p.isStopRequested)
        #expect(throws: SpeechErrors.streamFinished) { try r.push(streamId: "p", audio: Data([1]), final: false) }
        #expect(await p.pushBuffer?.next() == Data([1, 2]))
        #expect(await p.pushBuffer?.next() == nil)
    }

    @Test func stopHandlerRunsOnceEvenWhenStopComesFirst() throws {
        let r = SpeechStreamRegistry()
        let h = try r.register(id: "m", source: .microphone)
        let counter = Counter()
        h.requestStop()
        h.setStopHandler { counter.bump() }
        h.requestStop()
        #expect(counter.value == 1)

        let h2 = try r.register(id: "p", source: .push)
        h2.setStopHandler { counter.bump() }
        h2.requestStop()
        h2.requestStop()
        #expect(counter.value == 2)
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func bump() { lock.withLock { n += 1 } }
    var value: Int { lock.withLock { n } }
}
