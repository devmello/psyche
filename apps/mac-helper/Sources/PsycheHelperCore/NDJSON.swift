import Foundation

/// Newline-delimited JSON framing for the node socket (wire spec v1: one frame per line, UTF-8,
/// max 1 MiB per frame). Feed it bytes as they arrive; it returns complete lines.
public struct NDJSONLineBuffer: Sendable {
    public enum FramingError: Error, Equatable {
        case frameTooLarge(limit: Int)
    }

    public let maxFrameBytes: Int
    private var pending = Data()

    public init(maxFrameBytes: Int = 1_048_576) {
        self.maxFrameBytes = maxFrameBytes
    }

    /// Bytes buffered without a terminating newline yet.
    public var pendingByteCount: Int { pending.count }

    /// Appends `chunk` and returns every complete line (without the `\n`, and without a trailing
    /// `\r`). Empty lines are skipped. Throws when a line exceeds `maxFrameBytes`.
    public mutating func append(_ chunk: Data) throws -> [Data] {
        pending.append(chunk)
        var lines: [Data] = []
        while let nl = pending.firstIndex(of: 0x0A) {
            var line = pending[pending.startIndex..<nl]
            pending = Data(pending[pending.index(after: nl)...])
            if line.last == 0x0D { line = line.dropLast() }
            if line.count > maxFrameBytes { throw FramingError.frameTooLarge(limit: maxFrameBytes) }
            if !line.isEmpty { lines.append(Data(line)) }
        }
        if pending.count > maxFrameBytes { throw FramingError.frameTooLarge(limit: maxFrameBytes) }
        return lines
    }

    /// Encodes one frame as a line. Throws when the encoded frame exceeds `maxFrameBytes`.
    public static func line(for frame: Data, maxFrameBytes: Int = 1_048_576) throws -> Data {
        guard frame.count <= maxFrameBytes else { throw FramingError.frameTooLarge(limit: maxFrameBytes) }
        var out = frame
        out.append(0x0A)
        return out
    }
}
