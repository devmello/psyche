import Foundation
import PsycheProtocol

/// Raw PCM sample encodings the helper accepts (push audio). The subset of
/// `AudioFormat.encoding` in `packages/protocol/src/contracts/SpeechEngine.ts` that is plain PCM.
public enum PCMEncoding: String, Codable, Sendable, CaseIterable {
    case pcmS16le = "pcm_s16le"
    case pcmF32le = "pcm_f32le"

    public var bytesPerSample: Int {
        switch self {
        case .pcmS16le: 2
        case .pcmF32le: 4
        }
    }
}

/// Interleaved little-endian PCM format; wire shape `AudioFormat {encoding, sampleRate, channels}`.
public struct PCMAudioFormat: Codable, Sendable, Equatable {
    public var encoding: PCMEncoding
    public var sampleRate: Int
    public var channels: Int

    /// Accepted for pushed audio (telephone band up to studio rate).
    public static let sampleRateRange = 8_000...48_000
    public static let channelRange = 1...2

    public init(encoding: PCMEncoding, sampleRate: Int, channels: Int) {
        self.encoding = encoding
        self.sampleRate = sampleRate
        self.channels = channels
    }

    public var bytesPerFrame: Int { encoding.bytesPerSample * channels }

    /// Milliseconds of audio in `byteCount` bytes (whole frames only).
    public func durationMs(byteCount: Int) -> Int {
        guard sampleRate > 0, bytesPerFrame > 0 else { return 0 }
        return Int((Double(byteCount / bytesPerFrame) * 1000 / Double(sampleRate)).rounded())
    }

    /// Bytes holding `ms` milliseconds of audio (whole frames).
    public func byteCount(durationMs ms: Int) -> Int {
        Int((Double(ms) * Double(sampleRate) / 1000).rounded(.down)) * bytesPerFrame
    }

    public func validate(field: String = "format") throws {
        guard Self.sampleRateRange.contains(sampleRate) else {
            throw CapabilityError.invalidParams(
                "\(field).sampleRate must be between \(Self.sampleRateRange.lowerBound) and \(Self.sampleRateRange.upperBound)",
                field: "\(field).sampleRate")
        }
        guard Self.channelRange.contains(channels) else {
            throw CapabilityError.invalidParams("\(field).channels must be 1 or 2", field: "\(field).channels")
        }
    }

    public var json: JSONValue {
        ["encoding": .string(encoding.rawValue), "sampleRate": .int(sampleRate), "channels": .int(channels)]
    }
}
