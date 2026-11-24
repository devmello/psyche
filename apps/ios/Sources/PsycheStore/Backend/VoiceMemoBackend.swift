import Foundation

// Voice memos (owner: Library). The phone records 16 kHz mono PCM and streams it to the Mac with
// `voice.start` (memo: true), `voice.push` and `voice.cancel`; `voice.memo.save` ends the session and files it
// as a Library recording with its transcript. The Mac owns the engine, the transcript and the file.

public protocol VoiceMemoBackend: Sendable {
    /// Starts a memo session on the Mac and returns its id.
    func startVoiceMemo() async throws -> String
    /// Appends one chunk of 16 kHz mono signed 16-bit little-endian PCM. Chunks arrive in `seq` order, from 0.
    func pushVoiceMemo(sessionID: String, seq: Int, pcm: Data) async throws
    /// Ends the session and files the memo in the Library. Throws `BackendError.slowDown` when the phone is out of model budget.
    func saveVoiceMemo(sessionID: String) async throws -> VoiceMemoSaved
    /// Drops the session and its audio without filing anything.
    func cancelVoiceMemo(sessionID: String) async throws
}

public struct VoiceMemoSaved: Sendable, Equatable {
    public var item: LibraryItem
    public var transcript: String
    public var durationMs: Int

    public init(item: LibraryItem, transcript: String, durationMs: Int) {
        self.item = item
        self.transcript = transcript
        self.durationMs = durationMs
    }
}

/// Where the phone's microphone comes from. The live recorder is in PsycheFeatures; tests and the demo
/// scenario inject another one, so no test ever asks for the microphone.
public protocol VoiceMemoRecording: Sendable {
    /// Starts capturing (asking for the microphone first). `onChunk` gets 16 kHz mono s16le PCM as it is captured.
    func start(onChunk: @escaping @Sendable (Data) -> Void) async throws
    /// Stops capturing and hands the last partial chunk to `onChunk` before returning. Safe to call twice.
    func stop() async
}

/// The demo recorder for `-psycheScenario live`: no microphone, a steady stream of silence.
public final class FixtureVoiceMemoRecorder: VoiceMemoRecording, @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Never>?

    public init() {}

    public func start(onChunk: @escaping @Sendable (Data) -> Void) async throws {
        lock.withLock { task?.cancel() }
        let chunk = Data(count: 16_000) // half a second of silence
        let task = Task {
            while !Task.isCancelled {
                onChunk(chunk)
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
        lock.withLock { self.task = task }
    }

    public func stop() async {
        lock.withLock {
            task?.cancel()
            task = nil
        }
    }
}
