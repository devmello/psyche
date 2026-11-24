import Foundation
import Observation
import PsycheStore

/// Record, save, cancel for one voice memo. The phone holds no audio: chunks go to the Mac as they are captured,
/// and `save` files the session there. Phases: idle, preparing (session started, mic not yet live), recording,
/// saving, saved, failed. Cancel discards the session on the Mac and returns to idle.
@MainActor @Observable
final class VoiceMemoModel {
    enum Phase: Equatable {
        case idle
        case preparing
        case recording(since: Date)
        case saving
        case saved(VoiceMemoSaved)
        case failed(String)
    }

    private(set) var phase: Phase = .idle

    private let backend: any VoiceMemoBackend
    private let recorder: any VoiceMemoRecording
    private var session: String?
    private var chunks: AsyncStream<Data>.Continuation?
    private var pusher: Task<Void, Never>?
    /// The first push failure of this memo; `stop` refuses to save a memo the Mac did not fully receive.
    private var pushFailure: String?

    init(backend: any VoiceMemoBackend, recorder: any VoiceMemoRecording) {
        self.backend = backend
        self.recorder = recorder
    }

    var isRecording: Bool {
        if case .recording = phase { return true }
        return false
    }

    /// Starts a memo. Does nothing while one is in progress; a failed memo can be started again.
    func start() async {
        switch phase {
        case .idle, .failed, .saved: break
        case .preparing, .recording, .saving: return
        }
        phase = .preparing
        pushFailure = nil
        let id: String
        do {
            id = try await backend.startVoiceMemo()
        } catch {
            phase = .failed(Self.message(error))
            return
        }
        // Cancelled while the Mac answered: the session is ours to drop.
        guard case .preparing = phase else {
            try? await backend.cancelVoiceMemo(sessionID: id)
            return
        }
        session = id
        let (stream, continuation) = AsyncStream<Data>.makeStream()
        chunks = continuation
        let backend = backend
        // One pusher keeps the chunks in order: `seq` counts from 0 and no two pushes overlap.
        pusher = Task { [weak self] in
            var seq = 0
            for await pcm in stream {
                do {
                    try await backend.pushVoiceMemo(sessionID: id, seq: seq, pcm: pcm)
                    seq += 1
                } catch {
                    await self?.pushFailed(Self.message(error), session: id)
                    return
                }
            }
        }
        do {
            try await recorder.start { continuation.yield($0) }
        } catch {
            await tearDown(cancelling: id)
            phase = .failed(Self.message(error))
            return
        }
        guard case .preparing = phase else {
            await recorder.stop()
            return
        }
        phase = .recording(since: Date())
    }

    /// Ends the recording, sends the rest of the audio, and files the memo on the Mac.
    func stop() async {
        guard case .recording = phase, let id = session else { return }
        phase = .saving
        await recorder.stop()
        chunks?.finish()
        chunks = nil
        await pusher?.value
        pusher = nil
        if let pushFailure {
            session = nil
            phase = .failed(pushFailure)
            try? await backend.cancelVoiceMemo(sessionID: id)
            return
        }
        do {
            let saved = try await backend.saveVoiceMemo(sessionID: id)
            session = nil
            phase = .saved(saved)
        } catch {
            session = nil
            phase = .failed(Self.message(error))
            try? await backend.cancelVoiceMemo(sessionID: id)
        }
    }

    /// Discards the memo: the microphone stops, the Mac drops the session and its audio, nothing is filed.
    func cancel() async {
        switch phase {
        case .preparing, .recording:
            let id = session
            phase = .idle
            await tearDown(cancelling: id)
        case .saving, .saved, .failed, .idle:
            if case .failed = phase { phase = .idle }
        }
    }

    private func pushFailed(_ message: String, session id: String) async {
        guard session == id else { return }
        pushFailure = message
        if case .recording = phase {
            phase = .failed(message)
            await tearDown(cancelling: id)
        }
    }

    private func tearDown(cancelling id: String?) async {
        await recorder.stop()
        chunks?.finish()
        chunks = nil
        pusher?.cancel()
        pusher = nil
        session = nil
        if let id { try? await backend.cancelVoiceMemo(sessionID: id) }
    }

    /// The Gateway's words when it has some (`slowDown` names the wait), a plain line otherwise.
    static func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? String(localized: "Couldn't save the voice memo.", bundle: .module)
    }
}
