import Foundation

/// Sample conversion between little-endian byte streams and `Float` samples.
///
/// s16 → float divides by 32768 and float → s16 multiplies by 32768 (power-of-two scaling), so every
/// Int16 value survives a round trip exactly; out-of-range floats clip to [-32768, 32767] and NaN
/// becomes silence.
public enum PCMConvert {
    public static func float32(fromS16LE data: Data) -> [Float] {
        let count = data.count / 2
        guard count > 0 else { return [] }
        return data.withUnsafeBytes { raw in
            (0..<count).map { i in
                let bits = UInt16(raw[2 * i]) | UInt16(raw[2 * i + 1]) << 8
                return Float(Int16(bitPattern: bits)) / 32768
            }
        }
    }

    public static func s16LE(fromFloat32 samples: [Float]) -> Data {
        var out = Data(count: samples.count * 2)
        out.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
            for (i, sample) in samples.enumerated() {
                let bits = UInt16(bitPattern: int16(clipping: sample))
                raw[2 * i] = UInt8(truncatingIfNeeded: bits)
                raw[2 * i + 1] = UInt8(truncatingIfNeeded: bits >> 8)
            }
        }
        return out
    }

    public static func float32(fromF32LE data: Data) -> [Float] {
        let count = data.count / 4
        guard count > 0 else { return [] }
        return data.withUnsafeBytes { raw in
            (0..<count).map { i in
                Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: 4 * i, as: UInt32.self)))
            }
        }
    }

    public static func f32LE(fromFloat32 samples: [Float]) -> Data {
        var out = Data(count: samples.count * 4)
        out.withUnsafeMutableBytes { raw in
            for (i, sample) in samples.enumerated() {
                raw.storeBytes(of: sample.bitPattern.littleEndian, toByteOffset: 4 * i, as: UInt32.self)
            }
        }
        return out
    }

    /// Converts a byte stream between the two PCM encodings (same rate and channel layout).
    public static func convert(_ data: Data, from: PCMEncoding, to: PCMEncoding) -> Data {
        guard from != to else { return data }
        switch from {
        case .pcmS16le: return f32LE(fromFloat32: float32(fromS16LE: data))
        case .pcmF32le: return s16LE(fromFloat32: float32(fromF32LE: data))
        }
    }

    @inline(__always)
    static func int16(clipping sample: Float) -> Int16 {
        guard !sample.isNaN else { return 0 }
        let scaled = (sample * 32768).rounded()
        if scaled >= 32767 { return .max }
        if scaled <= -32768 { return .min }
        return Int16(scaled)
    }
}

/// Splits PCM bytes into event-sized chunks. Chunks are frame-aligned and small enough that their
/// base64 text stays within `maxEncodedBytes` (64 KiB by default), keeping every `node.event` frame
/// far below the 1 MiB NDJSON limit.
public enum PCMChunker {
    public static let defaultMaxEncodedBytes = 64 * 1024

    /// Largest raw chunk (frame-aligned) whose base64 form fits in `maxEncodedBytes`.
    public static func maxRawBytes(bytesPerFrame: Int, maxEncodedBytes: Int = defaultMaxEncodedBytes) -> Int {
        let raw = maxEncodedBytes / 4 * 3
        let frame = max(1, bytesPerFrame)
        return max(frame, raw - raw % frame)
    }

    public static func split(_ data: Data, bytesPerFrame: Int, maxEncodedBytes: Int = defaultMaxEncodedBytes) -> [Data] {
        let size = maxRawBytes(bytesPerFrame: bytesPerFrame, maxEncodedBytes: maxEncodedBytes)
        var chunks: [Data] = []
        var offset = data.startIndex
        while offset < data.endIndex {
            let end = min(offset + size, data.endIndex)
            chunks.append(data.subdata(in: offset..<end))
            offset = end
        }
        return chunks
    }
}

/// Re-frames an arbitrary byte stream into whole PCM frames, carrying a partial frame over to the
/// next push (clients may split pushes anywhere).
public struct PCMFrameAligner: Sendable {
    public let bytesPerFrame: Int
    private var carry = Data()

    public init(bytesPerFrame: Int) {
        self.bytesPerFrame = max(1, bytesPerFrame)
    }

    /// Bytes of an incomplete trailing frame held back.
    public var pendingByteCount: Int { carry.count }

    /// Returns the whole frames available after appending `data`.
    public mutating func append(_ data: Data) -> Data {
        var bytes = carry
        bytes.append(data)
        let whole = bytes.count - bytes.count % bytesPerFrame
        carry = bytes.subdata(in: (bytes.startIndex + whole)..<bytes.endIndex)
        return bytes.subdata(in: bytes.startIndex..<(bytes.startIndex + whole))
    }
}
