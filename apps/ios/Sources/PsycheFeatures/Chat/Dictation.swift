import AVFoundation
import Foundation
import Observation
import Speech

/// Dictation for the composer: on-device `SpeechAnalyzer` (iOS 26), falling back to `SFSpeechRecognizer`
/// (on-device when the language supports it). Audio never leaves the phone unless the system's own
/// fallback recognizer decides it must; this code asks for on-device whenever it is offered.
@MainActor @Observable
final class Dictation {
    enum State: Equatable {
        case idle
        case preparing
        case listening
        case failed(String)
    }

    private(set) var state: State = .idle
    private let engine = DictationEngine()
    private var onText: @MainActor (String) -> Void = { _ in }
    private var starting: Task<Void, Never>?

    var isActive: Bool { state == .preparing || state == .listening }

    /// `onText` receives the whole transcript of this dictation each time it changes.
    func toggle(onText: @escaping @MainActor (String) -> Void) {
        if isActive {
            stop()
        } else {
            self.onText = onText
            start()
        }
    }

    func stop() {
        starting?.cancel()
        starting = nil
        if isActive { state = .idle }
        let engine = engine
        Task { await engine.stop() }
    }

    func clearError() {
        if case .failed = state { state = .idle }
    }

    private func start() {
        state = .preparing
        let engine = engine
        let sink: @MainActor @Sendable (String) -> Void = { [weak self] text in
            guard let self, self.isActive else { return }
            self.onText(text)
        }
        starting = Task { [weak self] in
            do {
                try await engine.start { text in
                    Task { @MainActor in sink(text) }
                }
                if Task.isCancelled {
                    await engine.stop()
                    return
                }
                self?.state = .listening
            } catch {
                self?.state = .failed((error as? LocalizedError)?.errorDescription ?? "Dictation isn't available right now.")
            }
        }
    }
}

enum DictationError: LocalizedError {
    case denied
    case unavailable

    var errorDescription: String? {
        switch self {
        case .denied: "Allow the microphone and speech recognition for Psyche in Settings to dictate."
        case .unavailable: "Dictation isn't available for your language on this device."
        }
    }
}

/// The audio and recognition plumbing, off the main actor: the microphone tap runs on an audio thread.
final class DictationEngine: @unchecked Sendable {
    private let capture = AudioCapture()
    private var analyzer: SpeechAnalyzer?
    private var inputContinuation: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private var legacyRequest: SFSpeechAudioBufferRecognitionRequest?
    private var legacyTask: SFSpeechRecognitionTask?

    func start(onText: @escaping @Sendable (String) -> Void) async throws {
        try await authorize()
        try configureSession()
        do {
            try await startAnalyzer(onText: onText)
        } catch {
            await stopAnalyzer()
            try startLegacy(onText: onText)
        }
    }

    func stop() async {
        capture.stop()
        legacyRequest?.endAudio()
        legacyTask?.finish()
        legacyRequest = nil
        legacyTask = nil
        await stopAnalyzer()
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    // MARK: Permissions and session

    private func authorize() async throws {
        guard await AVAudioApplication.requestRecordPermission() else { throw DictationError.denied }
        let status = await withCheckedContinuation { (continuation: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard status == .authorized else { throw DictationError.denied }
    }

    private func configureSession() throws {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        #endif
    }

    // MARK: SpeechAnalyzer (iOS 26)

    private func startAnalyzer(onText: @escaping @Sendable (String) -> Void) async throws {
        guard SpeechTranscriber.isAvailable,
            let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current)
        else { throw DictationError.unavailable }
        let transcriber = SpeechTranscriber(
            locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw DictationError.unavailable
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        self.analyzer = analyzer
        inputContinuation = continuation
        resultsTask = Task {
            var finalized = ""
            do {
                for try await result in transcriber.results {
                    let piece = String(result.text.characters)
                    if result.isFinal {
                        finalized += piece
                        onText(finalized)
                    } else {
                        onText(finalized + piece)
                    }
                }
            } catch {}
        }
        try await analyzer.start(inputSequence: stream)
        let converter = BufferConverter(to: format, from: capture.inputFormat)
        try capture.start { buffer in
            if let converted = converter.convert(buffer) {
                continuation.yield(AnalyzerInput(buffer: converted))
            }
        }
    }

    private func stopAnalyzer() async {
        inputContinuation?.finish()
        inputContinuation = nil
        if let analyzer {
            try? await analyzer.finalizeAndFinishThroughEndOfInput()
        }
        analyzer = nil
        resultsTask?.cancel()
        resultsTask = nil
    }

    // MARK: SFSpeechRecognizer fallback

    private func startLegacy(onText: @escaping @Sendable (String) -> Void) throws {
        guard let recognizer = SFSpeechRecognizer(locale: .current), recognizer.isAvailable else {
            throw DictationError.unavailable
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        legacyRequest = request
        nonisolated(unsafe) let sendableRequest = request
        legacyTask = recognizer.recognitionTask(with: request) { result, _ in
            if let result { onText(result.bestTranscription.formattedString) }
        }
        try capture.start { buffer in sendableRequest.append(buffer) }
    }
}

/// The microphone tap. Not main-actor isolated: the tap closure runs on an audio thread.
final class AudioCapture: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private var running = false

    var inputFormat: AVAudioFormat { engine.inputNode.outputFormat(forBus: 0) }

    func start(_ handler: @escaping @Sendable (AVAudioPCMBuffer) -> Void) throws {
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: input.outputFormat(forBus: 0)) { buffer, _ in
            handler(buffer)
        }
        engine.prepare()
        try engine.start()
        running = true
    }

    func stop() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        running = false
    }
}

/// Converts microphone buffers to the format the analyzer asked for.
final class BufferConverter: @unchecked Sendable {
    private let target: AVAudioFormat
    private let converter: AVAudioConverter?

    init(to target: AVAudioFormat, from source: AVAudioFormat) {
        self.target = target
        converter = source == target ? nil : AVAudioConverter(from: source, to: target)
    }

    func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let converter else { return buffer }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }
        let served = Served()
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            if served.take() {
                inputStatus.pointee = .noDataNow
                return nil
            }
            inputStatus.pointee = .haveData
            return buffer
        }
        return status == .error || error != nil ? nil : output
    }

    private final class Served: @unchecked Sendable {
        private var done = false
        func take() -> Bool {
            defer { done = true }
            return done
        }
    }
}
