import Foundation
import PsycheHelperCore
import Testing

@Suite("NDJSON framing")
struct NDJSONTests {
    @Test func reassemblesALineSplitAcrossChunks() throws {
        var buf = NDJSONLineBuffer()
        #expect(try buf.append(Data(#"{"type":"re"#.utf8)).isEmpty)
        #expect(buf.pendingByteCount == 11)
        let lines = try buf.append(Data((#"q","id":"1"}"# + "\n").utf8))
        #expect(lines == [Data(#"{"type":"req","id":"1"}"#.utf8)])
        #expect(buf.pendingByteCount == 0)
    }

    @Test func splitsMergedLinesAndKeepsTheRemainder() throws {
        var buf = NDJSONLineBuffer()
        let lines = try buf.append(Data("{\"a\":1}\n{\"b\":2}\r\n\n{\"c\"".utf8))
        #expect(lines == [Data("{\"a\":1}".utf8), Data("{\"b\":2}".utf8)])
        #expect(try buf.append(Data(":3}\n".utf8)) == [Data("{\"c\":3}".utf8)])
    }

    @Test func rejectsFramesOverTheLimit() throws {
        var buf = NDJSONLineBuffer(maxFrameBytes: 8)
        #expect(try buf.append(Data("12345678\n".utf8)) == [Data("12345678".utf8)])
        #expect(throws: NDJSONLineBuffer.FramingError.frameTooLarge(limit: 8)) {
            try buf.append(Data("123456789\n".utf8))
        }
        var unterminated = NDJSONLineBuffer(maxFrameBytes: 8)
        #expect(throws: NDJSONLineBuffer.FramingError.frameTooLarge(limit: 8)) {
            try unterminated.append(Data("123456789".utf8))
        }
    }

    @Test func defaultLimitIsOneMebibyte() throws {
        #expect(NDJSONLineBuffer().maxFrameBytes == 1_048_576)
        let line = try NDJSONLineBuffer.line(for: Data("{}".utf8))
        #expect(line == Data("{}\n".utf8))
        #expect(throws: NDJSONLineBuffer.FramingError.frameTooLarge(limit: 1_048_576)) {
            try NDJSONLineBuffer.line(for: Data(count: 1_048_577))
        }
    }
}
