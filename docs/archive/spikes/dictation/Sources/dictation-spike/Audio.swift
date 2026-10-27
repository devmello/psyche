@preconcurrency import AVFoundation
import CoreGraphics
import Foundation

/// Every engine receives what the helper would hand it: 16 kHz mono Float32 buffers of ~100 ms,
/// which is roughly what an `AVAudioEngine` input tap delivers.
let sampleRate: Double = 16_000
let monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!
let bufferFrames: AVAudioFrameCount = 1_600

func makeBuffer(_ samples: ArraySlice<Float>) -> AVAudioPCMBuffer {
    let buffer = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: AVAudioFrameCount(samples.count))!
    buffer.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { src in
        buffer.floatChannelData![0].update(from: src.baseAddress!, count: samples.count)
    }
    return buffer
}

func samples(of buffer: AVAudioPCMBuffer) -> [Float] {
    Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
}

/// Converts any PCM buffer to `format` (sample rate, channel count and sample type).
final class Converter {
    private let converter: AVAudioConverter
    let output: AVAudioFormat

    init(from input: AVAudioFormat, to output: AVAudioFormat) {
        self.converter = AVAudioConverter(from: input, to: output)!
        self.output = output
    }

    func convert(_ buffer: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        let ratio = output.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 32
        let out = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity)!
        var consumed = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        if status == .error, let error { throw error }
        return out
    }
}

func readMono16k(_ url: URL) throws -> [Float] {
    let file = try AVAudioFile(forReading: url)
    let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
    try file.read(into: buffer)
    if file.processingFormat == monoFormat { return samples(of: buffer) }
    return samples(of: try Converter(from: file.processingFormat, to: monoFormat).convert(buffer))
}

func writeWav(_ samples: [Float], to url: URL) throws {
    let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: sampleRate, AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
    ]
    let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    try file.write(from: makeBuffer(samples[...]))
}

/// Index of the first 20 ms frame louder than -40 dBFS (speech onset).
func speechOnset(_ samples: [Float]) -> Int {
    let frame = 320
    var i = 0
    while i + frame <= samples.count {
        var sum: Float = 0
        for s in samples[i..<(i + frame)] { sum += s * s }
        if (sum / Float(frame)).squareRoot() > 0.01 { return i }
        i += frame
    }
    return 0
}

func rms(_ samples: [Float]) -> Float {
    var sum: Float = 0
    for s in samples { sum += s * s }
    return (sum / Float(max(samples.count, 1))).squareRoot()
}

// MARK: - Audio sources

/// One push-to-talk utterance as the engine sees it: buffers arrive in real time,
/// `keyDown` is when capture began and `keyUp` when the last buffer was delivered.
protocol AudioSource {
    func run(deliver: @escaping (AVAudioPCMBuffer) -> Void, speechStarted: @escaping () -> Void) async throws
}

/// Replays a file at real-time pace in 100 ms buffers, so latency numbers match a live microphone.
struct FileSource: AudioSource {
    let samples: [Float]

    func run(deliver: @escaping (AVAudioPCMBuffer) -> Void, speechStarted: @escaping () -> Void) async throws {
        let onset = speechOnset(samples)
        let start = now()
        var offset = 0
        var announced = false
        while offset < samples.count {
            let end = min(offset + Int(bufferFrames), samples.count)
            let due = start + Double(end) / sampleRate
            let wait = due - now()
            if wait > 0 { try await Task.sleep(nanoseconds: UInt64(wait * 1e9)) }
            deliver(makeBuffer(samples[offset..<end]))
            if !announced, end > onset {
                announced = true
                speechStarted()
            }
            offset = end
        }
    }
}

/// Live microphone through `AVAudioEngine`. Push-to-talk holds the Option key
/// (polled with `CGEventSource.flagsState`, which needs no Input Monitoring grant); `seconds` records for a fixed time instead.
struct MicSource: AudioSource {
    var seconds: Double?

    func run(deliver: @escaping (AVAudioPCMBuffer) -> Void, speechStarted: @escaping () -> Void) async throws {
        try await ensureMicrophoneAccess()
        if seconds == nil {
            log("Hold Option (⌥) to talk; release to stop.")
            while !optionDown() { try await Task.sleep(nanoseconds: 10_000_000) }
        }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let hwFormat = input.outputFormat(forBus: 0)
        let converter = Converter(from: hwFormat, to: monoFormat)
        let tapFrames = AVAudioFrameCount(hwFormat.sampleRate / 10)
        nonisolated(unsafe) var announced = false
        input.installTap(onBus: 0, bufferSize: tapFrames, format: hwFormat) { buffer, _ in
            guard let mono = try? converter.convert(buffer) else { return }
            deliver(mono)
            if !announced, rms(samples(of: mono)) > 0.01 {
                announced = true
                speechStarted()
            }
        }
        engine.prepare()
        try engine.start()
        log("● recording (input \(Int(hwFormat.sampleRate)) Hz, \(hwFormat.channelCount) ch)")
        if let seconds {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
        } else {
            while optionDown() { try await Task.sleep(nanoseconds: 10_000_000) }
        }
        input.removeTap(onBus: 0)
        engine.stop()
        log("■ key-up")
    }

    private func optionDown() -> Bool {
        CGEventSource.flagsState(.combinedSessionState).contains(.maskAlternate)
    }
}

func ensureMicrophoneAccess() async throws {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return
    case .notDetermined:
        if await AVCaptureDevice.requestAccess(for: .audio) { return }
    default: break
    }
    throw SpikeError.message("Microphone access denied (System Settings → Privacy & Security → Microphone)")
}

enum SpikeError: Error, CustomStringConvertible {
    case message(String)
    var description: String {
        switch self { case .message(let m): return m }
    }
}

// MARK: - Test audio

/// Trims a synthesized read (see tts.swift) to its speech and adds 0.5 s of lead-in silence
/// and 0.3 s of tail, a realistic gap between the last word and key-up.
func padSpeech(_ raw: [Float]) -> [Float] {
    let first = speechOnset(raw)
    let last = raw.count - speechOnset(raw.reversed())
    let core = Array(raw[first..<max(first, last)])
    return [Float](repeating: 0, count: 8_000) + core + [Float](repeating: 0, count: 4_800)
}

/// A quiet-room microphone noise floor: white noise at `dBFS` RMS. Without it the lead-in is digital
/// zeros, which no real microphone produces and which delays SpeechTranscriber's first partial by ~0.9 s.
func addNoiseFloor(_ speech: [Float], dBFS: Float) -> [Float] {
    var seed: UInt32 = 54_321
    let amplitude = pow(10, dBFS / 20) * Float(3).squareRoot()  // uniform noise: RMS = amplitude / sqrt(3)
    return speech.map { s in
        seed = seed &* 1_664_525 &+ 1_013_904_223
        return max(-1, min(1, s + (Float(seed) / Float(UInt32.max) * 2 - 1) * amplitude))
    }
}

/// Synthetic background music (pad chords, bass, kick and hi-hat at 120 bpm) mixed at `snrDB`
/// relative to the speech RMS. Deterministic so both reads are reproducible.
func mixMusic(into speech: [Float], snrDB: Float) -> [Float] {
    let chords: [[Float]] = [
        [261.63, 329.63, 392.00], [196.00, 246.94, 293.66],
        [220.00, 261.63, 329.63], [174.61, 220.00, 261.63],
    ]
    var seed: UInt32 = 12_345
    func noise() -> Float {
        seed = seed &* 1_664_525 &+ 1_013_904_223
        return Float(seed) / Float(UInt32.max) * 2 - 1
    }
    var music = [Float](repeating: 0, count: speech.count)
    let sr = Float(sampleRate)
    for n in 0..<speech.count {
        let t = Float(n) / sr
        let chord = chords[Int(t / 2) % chords.count]
        var v: Float = 0
        for f in chord {
            for h in 1...4 { v += sin(2 * .pi * f * Float(h) * t) / Float(h * h) }
        }
        v *= 0.15
        v += 0.3 * sin(2 * .pi * chord[0] / 2 * t)  // bass
        let beat = t.truncatingRemainder(dividingBy: 0.5)
        v += 0.6 * sin(2 * .pi * 60 * beat) * exp(-beat * 18)  // kick
        let off = (t + 0.25).truncatingRemainder(dividingBy: 0.5)
        v += 0.25 * noise() * exp(-off * 60)  // hi-hat
        music[n] = v
    }
    let onset = speechOnset(speech)
    let speechRMS = rms(Array(speech[onset...]))
    let gain = speechRMS / rms(music) / pow(10, snrDB / 20)
    return zip(speech, music).map { max(-1, min(1, $0 + $1 * gain)) }
}
