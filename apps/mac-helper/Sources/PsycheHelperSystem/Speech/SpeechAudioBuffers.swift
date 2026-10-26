import AVFAudio
import Foundation
import PsycheHelperCore
import PsycheProtocol

/// `AVAudioPCMBuffer` is not `Sendable`. Each box is handed off once, from the producer (tap,
/// push decoder) to the single consumer that owns it from then on.
public struct PCMBufferBox: @unchecked Sendable {
    public let buffer: AVAudioPCMBuffer
    public init(buffer: AVAudioPCMBuffer) { self.buffer = buffer }
}

enum SpeechAudio {
    static func avFormat(_ format: PCMAudioFormat) -> AVAudioFormat? {
        avFormat(format.encoding, sampleRate: Double(format.sampleRate), channels: AVAudioChannelCount(format.channels))
    }

    static func avFormat(_ encoding: PCMEncoding, sampleRate: Double, channels: AVAudioChannelCount) -> AVAudioFormat? {
        let common: AVAudioCommonFormat = encoding == .pcmS16le ? .pcmFormatInt16 : .pcmFormatFloat32
        return AVAudioFormat(commonFormat: common, sampleRate: sampleRate, channels: channels, interleaved: true)
    }

    /// Interleaved little-endian bytes → buffer in `format` (an interleaved format from `avFormat`).
    static func buffer(from data: Data, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let bytesPerFrame = Int(format.streamDescription.pointee.mBytesPerFrame)
        guard bytesPerFrame > 0 else { return nil }
        let frames = data.count / bytesPerFrame
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return nil }
        buffer.frameLength = AVAudioFrameCount(frames)
        let list = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        guard let dst = list[0].mData else { return nil }
        data.withUnsafeBytes { src in
            if let base = src.baseAddress { dst.copyMemory(from: base, byteCount: frames * bytesPerFrame) }
        }
        return buffer
    }

    /// Deep copy (tap buffers may be reused by the framework after the callback).
    static func copy(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let out = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: max(1, buffer.frameLength)) else { return nil }
        out.frameLength = buffer.frameLength
        let src = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        let dst = UnsafeMutableAudioBufferListPointer(out.mutableAudioBufferList)
        for i in 0..<min(src.count, dst.count) {
            guard let s = src[i].mData, let d = dst[i].mData else { continue }
            d.copyMemory(from: s, byteCount: Int(min(src[i].mDataByteSize, dst[i].mDataByteSize)))
        }
        return out
    }

    static func durationMs(frames: Int, sampleRate: Double) -> Int {
        sampleRate > 0 ? Int((Double(frames) * 1000 / sampleRate).rounded()) : 0
    }
}

/// Streaming format conversion (rate, channel count, sample type) with `AVAudioConverter`. Passes
/// buffers through untouched when the formats already match.
final class PCMBufferConverter {
    let input: AVAudioFormat
    let output: AVAudioFormat
    private let converter: AVAudioConverter?

    init(from input: AVAudioFormat, to output: AVAudioFormat) throws {
        self.input = input
        self.output = output
        if input == output {
            converter = nil
        } else {
            guard let c = AVAudioConverter(from: input, to: output) else {
                throw CapabilityError.unavailable("unsupported_audio_format", "Cannot convert this audio format for the speech engine")
            }
            // Streaming: no priming, so the first buffers are not delayed.
            c.primeMethod = .none
            converter = c
        }
    }

    func convert(_ buffer: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer? {
        guard let converter else { return buffer }
        guard buffer.frameLength > 0 else { return nil }
        let ratio = output.sampleRate / input.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return nil }
        let feed = OneShotInput(buffer)
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if let b = feed.take() {
                inputStatus.pointee = .haveData
                return b
            }
            inputStatus.pointee = .noDataNow
            return nil
        }
        if status == .error {
            throw CapabilityError.unavailable("audio_conversion_failed", "Audio format conversion failed")
        }
        return out.frameLength > 0 ? out : nil
    }

    /// Hands the converter its input buffer exactly once per `convert` call.
    private final class OneShotInput: @unchecked Sendable {
        private var buffer: AVAudioPCMBuffer?
        init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
        func take() -> AVAudioPCMBuffer? {
            defer { buffer = nil }
            return buffer
        }
    }
}
