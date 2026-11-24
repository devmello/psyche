#if os(iOS)
import AVFoundation
import Foundation
import PsycheStore

/// What a voice memo needs from the microphone when it isn't ours to ask for.
enum VoiceMemoError: LocalizedError {
    case microphone

    var errorDescription: String? {
        switch self {
        case .microphone: String(localized: "Allow the microphone for Psyche in Settings to record a voice memo.", bundle: .module)
        }
    }
}

/// The phone's microphone for a voice memo: 16 kHz mono s16le, handed out in half-second chunks. It shares the
/// microphone tap and audio-session arbiter with dictation, so stay-awake keeps its place.
final class LiveVoiceMemoRecorder: VoiceMemoRecording, @unchecked Sendable {
    private static let chunkBytes = 16_000
    private let capture = AudioCapture()
    private let lock = NSLock()
    private var pending = Data()
    private var sink: (@Sendable (Data) -> Void)?
    private var running = false
    private var configuredSession = false
    private var claim: UUID?

    func start(onChunk: @escaping @Sendable (Data) -> Void) async throws {
        guard await AVAudioApplication.requestRecordPermission() else { throw VoiceMemoError.microphone }
        claim = await MainActor.run { AudioSessionArbiter.shared.begin() }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            configuredSession = true
            guard let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true) else {
                throw VoiceMemoError.microphone
            }
            let converter = BufferConverter(to: target, from: capture.inputFormat)
            lock.withLock {
                sink = onChunk
                pending = Data()
            }
            try capture.start { [weak self] buffer in
                guard let self, let converted = converter.convert(buffer) else { return }
                self.append(converted)
            }
            lock.withLock { running = true }
        } catch {
            await release()
            throw error
        }
    }

    func stop() async {
        let wasRunning = lock.withLock { () -> Bool in
            let was = running
            running = false
            return was
        }
        guard wasRunning else { return }
        capture.stop()
        let (tail, out) = lock.withLock { () -> (Data, (@Sendable (Data) -> Void)?) in
            let tail = pending
            pending = Data()
            return (tail, sink)
        }
        if !tail.isEmpty { out?(tail) }
        lock.withLock { sink = nil }
        #if os(iOS)
        if configuredSession {
            configuredSession = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        #endif
        await release()
    }

    private func append(_ buffer: AVAudioPCMBuffer) {
        guard let samples = buffer.int16ChannelData?[0] else { return }
        let bytes = Data(bytes: samples, count: Int(buffer.frameLength) * MemoryLayout<Int16>.size)
        let full: [Data] = lock.withLock {
            pending.append(bytes)
            var out: [Data] = []
            while pending.count >= Self.chunkBytes {
                out.append(pending.prefix(Self.chunkBytes))
                pending.removeFirst(Self.chunkBytes)
            }
            return out
        }
        let out = lock.withLock { sink }
        for chunk in full { out?(chunk) }
    }

    private func release() async {
        guard let claim else { return }
        self.claim = nil
        await MainActor.run { AudioSessionArbiter.shared.end(claim) }
    }
}
#endif
