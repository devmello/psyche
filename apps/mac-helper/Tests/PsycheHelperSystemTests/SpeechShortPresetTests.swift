import AVFAudio
import Foundation
import PsycheHelperCore
import PsycheHelperSystem
import PsycheProtocol
import Testing

/// `speech.transcribe_stream {preset: "short"}` on a fake engine with pushed PCM (voice mode V-H
/// H3). No microphone and no recognizer.
@Suite("speech short preset on a fake engine")
struct SpeechShortPresetTests {
    struct AllowAll: PermissionPreflight {
        func isGranted(_ permission: TCCPermission) -> Bool { true }
    }

    /// Emits a final segment per pushed buffer, after a short delay at the end of input
    /// (standing in for the engine's finalize).
    final class FakeEngine: TranscriptionEngine, @unchecked Sendable {
        let kind: SpeechEngineKind = .dictationTranscriber
        let language = "en-US"
        func prepare(inputFormat: AVAudioFormat, emit: @escaping @Sendable (JSONValue) async -> Void) async throws {}
        func transcribe(_ input: AsyncStream<PCMBufferBox>, inputFormat: AVAudioFormat, onSegment: @escaping @Sendable (SpeechSegment) async -> Void) async throws {
            var n = 0
            for await box in input {
                await onSegment(SpeechSegment(text: "word\(n)", startMs: n * 100, endMs: n * 100 + Int(box.buffer.frameLength) / 16, final: false))
                n += 1
            }
            try await _Concurrency.Task.sleep(for: .milliseconds(30))
            await onSegment(SpeechSegment(text: "what time is it", startMs: 0, endMs: n * 100, final: true))
        }
        func cancel() async {}
    }

    final class Requests: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [TranscribeRequest] = []
        func add(_ r: TranscribeRequest) { lock.withLock { items.append(r) } }
        var all: [TranscribeRequest] { lock.withLock { items } }
    }

    let registry = SpeechStreamRegistry()
    let timings = SpeechTimings()
    let requests = Requests()

    var handlers: [String: any CapabilityHandler] {
        let requests = self.requests
        return Dictionary(uniqueKeysWithValues: SpeechCapabilities.make(
            preflight: AllowAll(), registry: registry, log: HelperLog(echo: { _ in }), timings: timings,
            transcriptionEngine: { r in requests.add(r); return FakeEngine() }
        ).map { ($0.spec.name, $0) })
    }

    func invoke(_ name: String, _ params: JSONValue, id: String = "push", emit: @escaping @Sendable (JSONValue) async -> Void = { _ in }) async throws -> JSONValue {
        try await handlers[name]!.invoke(InvocationContext(invocationId: id, capability: name, params: params, approvalId: nil, emit: emit)).result
    }

    func turn(preset: JSONValue?) async throws -> JSONValue {
        var params: JSONValue = ["source": "push", "format": ["encoding": "pcm_s16le", "sampleRate": 16_000, "channels": 1]]
        if let preset, case .object(var o) = params { o["preset"] = preset; params = .object(o) }
        let (started, startedFeed) = AsyncStream.makeStream(of: Void.self)
        let stream = _Concurrency.Task {
            try await invoke("speech.transcribe_stream", params, emit: { e in if e["type"] == "speech.started" { startedFeed.yield() } })
        }
        for await _ in started { break }
        // 0.5 s of silence in two pushes, the second final.
        let half = Data(count: 8000)
        _ = try await invoke("speech.audio_push", ["streamId": "push", "data": .string(half.base64EncodedString())], id: "p1")
        _ = try await invoke("speech.audio_push", ["streamId": "push", "data": .string(half.base64EncodedString()), "final": true], id: "p2")
        return try await stream.value
    }

    @Test func shortPresetReachesTheEngineAndIsTimed() async throws {
        let r = try await turn(preset: "short")
        #expect(requests.all.map(\.preset) == [.short])
        #expect(r["preset"] == "short" && r["text"] == "what time is it" && r["stopReason"] == "end_of_input")
        guard let fv = r["finalizeMs"], case .number(let ms) = fv else {
            Issue.record("no finalizeMs")
            return
        }
        let finalize = Int(ms)
        #expect(finalize >= 25)
        #expect(timings.median(.finalizeShort) == finalize)
        #expect(timings.median(.firstPartialShort) != nil)
        #expect(timings.median(.finalizeLong) == nil)
        let t = try JSONDecoder().decode(HelperSpeechTimings.self, from: JSONEncoder().encode(timings.json))
        #expect(t.finalizeMS?.short == finalize && t.finalizeMS?.long == nil)
    }

    @Test func longIsTheDefault() async throws {
        let r = try await turn(preset: nil)
        #expect(requests.all.map(\.preset) == [.long])
        #expect(r["preset"] == "long")
        #expect(timings.median(.finalizeLong) != nil && timings.median(.finalizeShort) == nil)
    }

    @Test func unknownPresetIsRefused() async {
        await #expect(throws: (any Error).self) {
            _ = try await invoke("speech.transcribe_stream", ["source": "push", "format": ["encoding": "pcm_s16le", "sampleRate": 16_000, "channels": 1], "preset": "medium"])
        }
        #expect(requests.all.isEmpty && registry.activeCount == 0)
    }
}
