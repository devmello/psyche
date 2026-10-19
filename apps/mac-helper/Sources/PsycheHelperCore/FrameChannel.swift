import Foundation
import PsycheProtocol

/// One NDJSON frame stream over a connected socket (wire spec v1). Reads happen on one thread (the
/// serve loop); writes may come from any task and are serialized by a lock.
public final class FrameChannel: @unchecked Sendable {
    public let socket: UnixSocketConnection
    private var buffer = NDJSONLineBuffer(maxFrameBytes: WireProtocol.maxFrameBytes)
    private var queued: [Data] = []
    private let writeLock = NSLock()

    public init(socket: UnixSocketConnection) {
        self.socket = socket
    }

    /// Next frame, or `nil` on EOF. Lines that are not valid frames are skipped (the Gateway never
    /// sends them; a malformed line must not kill the node).
    public func readFrame(before deadline: Date) throws -> WireFrame? {
        while true {
            while !queued.isEmpty {
                let line = queued.removeFirst()
                if let frame = try? WireFrame.decode(line) { return frame }
            }
            guard let chunk = try socket.read(before: deadline) else { return nil }
            queued.append(contentsOf: try buffer.append(chunk))
        }
    }

    public func send(_ frame: WireFrame) throws {
        let line = try NDJSONLineBuffer.line(for: try frame.encode(), maxFrameBytes: WireProtocol.maxFrameBytes)
        writeLock.lock()
        defer { writeLock.unlock() }
        try socket.write(line)
    }

    public func close() { socket.close() }

    /// Wakes the reader (EOF) from another thread; `close()` follows once the loop exits.
    public func shutdown() { socket.shutdown() }
}
