import Foundation
import Testing
import PsycheStore

@testable import PsycheFeatures

/// Records every call; no microphone, no Gateway.
private actor FakeVoiceBackend: VoiceMemoBackend {
    private let startError: Error?
    private let pushError: Error?
    private let saveError: Error?
    private(set) var started = 0
    private(set) var pushes: [(seq: Int, pcm: Data)] = []
    private(set) var saves: [String] = []
    private(set) var cancels: [String] = []

    init(startError: Error? = nil, pushError: Error? = nil, saveError: Error? = nil) {
        self.startError = startError
        self.pushError = pushError
        self.saveError = saveError
    }

    func startVoiceMemo() async throws -> String {
        if let startError { throw startError }
        started += 1
        return "s\(started)"
    }

    func pushVoiceMemo(sessionID: String, seq: Int, pcm: Data) async throws {
        if let pushError { throw pushError }
        pushes.append((seq, pcm))
    }

    func saveVoiceMemo(sessionID: String) async throws -> VoiceMemoSaved {
        saves.append(sessionID)
        if let saveError { throw saveError }
        let item = LibraryItem(id: "lib-1", title: "Voice memo", section: .documents, fileType: "wav", detail: "")
        return VoiceMemoSaved(item: item, transcript: "Remind me to call.", durationMs: 1200)
    }

    func cancelVoiceMemo(sessionID: String) async throws {
        cancels.append(sessionID)
    }
}

/// A microphone that only delivers what the test hands it.
private final class FakeVoiceRecorder: VoiceMemoRecording, @unchecked Sendable {
    private let lock = NSLock()
    private var sink: (@Sendable (Data) -> Void)?
    private var starts = 0
    private var stops = 0
    private var startError: Error?
    /// Delivered when the recording stops, like the last partial chunk of a real recording.
    var tail: Data?

    init(startError: Error? = nil) {
        self.startError = startError
    }

    var startCount: Int { lock.withLock { starts } }
    var stopCount: Int { lock.withLock { stops } }

    func setStartError(_ error: Error?) {
        lock.withLock { startError = error }
    }

    func start(onChunk: @escaping @Sendable (Data) -> Void) async throws {
        let error = lock.withLock { startError }
        if let error { throw error }
        lock.withLock {
            starts += 1
            sink = onChunk
        }
    }

    func stop() async {
        let (out, tail) = lock.withLock { () -> ((@Sendable (Data) -> Void)?, Data?) in
            stops += 1
            let out = sink
            sink = nil
            return (out, self.tail)
        }
        if let tail { out?(tail) }
    }

    func emit(_ data: Data) {
        let out = lock.withLock { sink }
        out?(data)
    }
}

private struct Denied: LocalizedError {
    var errorDescription: String? { "The microphone is off." }
}

@MainActor
struct VoiceMemoModelTests {
    @Test func recordsThenSendsEveryChunkInOrderAndFilesTheMemo() async throws {
        let backend = FakeVoiceBackend()
        let recorder = FakeVoiceRecorder()
        recorder.tail = Data([5])
        let model = VoiceMemoModel(backend: backend, recorder: recorder)

        await model.start()
        #expect(model.isRecording)
        recorder.emit(Data([1, 2]))
        recorder.emit(Data([3, 4]))
        await model.stop()

        let pushes = await backend.pushes
        #expect(pushes.map { $0.seq } == [0, 1, 2])
        #expect(pushes.map { $0.pcm } == [Data([1, 2]), Data([3, 4]), Data([5])])
        #expect(await backend.saves == ["s1"])
        #expect(await backend.cancels.isEmpty)
        guard case .saved(let saved) = model.phase else {
            Issue.record("expected saved, got \(model.phase)")
            return
        }
        #expect(saved.transcript == "Remind me to call.")
        #expect(saved.item.id == "lib-1")
    }

    @Test func cancelWhileRecordingDiscardsOnTheMacAndFilesNothing() async throws {
        let backend = FakeVoiceBackend()
        let recorder = FakeVoiceRecorder()
        let model = VoiceMemoModel(backend: backend, recorder: recorder)

        await model.start()
        recorder.emit(Data([1, 2]))
        await model.cancel()

        #expect(model.phase == .idle)
        #expect(await backend.saves.isEmpty)
        #expect(await backend.cancels == ["s1"])
        #expect(recorder.stopCount == 1)
    }

    @Test func aMicrophoneThatWontStartFailsInlineAndDropsTheSession() async throws {
        let backend = FakeVoiceBackend()
        let recorder = FakeVoiceRecorder(startError: Denied())
        let model = VoiceMemoModel(backend: backend, recorder: recorder)

        await model.start()

        #expect(model.phase == .failed("The microphone is off."))
        #expect(model.isRecording == false)
        #expect(await backend.cancels == ["s1"])
        #expect(await backend.saves.isEmpty)
    }

    @Test func aFailedMemoCanBeStartedAgain() async throws {
        let backend = FakeVoiceBackend()
        let recorder = FakeVoiceRecorder(startError: Denied())
        let model = VoiceMemoModel(backend: backend, recorder: recorder)
        await model.start()

        recorder.setStartError(nil)
        await model.start()

        #expect(model.isRecording)
        #expect(await backend.started == 2)
    }

    @Test func aSecondStartWhileRecordingIsIgnored() async throws {
        let backend = FakeVoiceBackend()
        let recorder = FakeVoiceRecorder()
        let model = VoiceMemoModel(backend: backend, recorder: recorder)

        await model.start()
        await model.start()

        #expect(await backend.started == 1)
        #expect(recorder.startCount == 1)
    }

    @Test func modelBudgetSlowDownShowsTheGatewayWordsAndDiscardsTheSession() async throws {
        let backend = FakeVoiceBackend(saveError: BackendError.slowDown(minutes: 5))
        let recorder = FakeVoiceRecorder()
        let model = VoiceMemoModel(backend: backend, recorder: recorder)
        await model.start()
        recorder.emit(Data([1, 2]))

        await model.stop()

        #expect(model.phase == .failed(BackendError.slowDown(minutes: 5).localizedDescription))
        #expect(await backend.cancels == ["s1"])
    }

    @Test func aFailedChunkStopsTheMemoAndNothingIsFiled() async throws {
        let backend = FakeVoiceBackend(pushError: BackendError.unreachable)
        let recorder = FakeVoiceRecorder()
        let model = VoiceMemoModel(backend: backend, recorder: recorder)
        await model.start()
        recorder.emit(Data([1, 2]))

        await model.stop()

        #expect(model.phase == .failed(BackendError.unreachable.localizedDescription))
        #expect(await backend.saves.isEmpty)
        #expect(await backend.cancels == ["s1"])
    }
}
