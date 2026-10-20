import Foundation

/// Plain text out of chat.db's `message.attributedBody` (J7). Since macOS 13 Messages often leaves
/// `message.text` NULL and stores the body only as an `NSArchiver` typedstream of an
/// `NSAttributedString`. Unarchiving untrusted bytes with `NSUnarchiver` would instantiate arbitrary
/// classes, so this reads only the first `NSString` payload: the class name, the fixed
/// `01 94 84 01 2B` preamble, a length (one byte, or `0x81` + UInt16 LE, or `0x82` + UInt32 LE) and
/// that many UTF-8 bytes.
public enum TypedStream {
    static let marker = Array("NSString".utf8)
    static let preamble: [UInt8] = [0x01, 0x94, 0x84, 0x01, 0x2B]
    /// Larger bodies are not messages; refuse rather than allocate.
    static let maxLength = 1 << 20

    public static func text(from data: Data) -> String? {
        let b = [UInt8](data)
        guard let start = find(marker, in: b) else { return nil }
        var i = start + marker.count
        guard i + preamble.count <= b.count, Array(b[i..<(i + preamble.count)]) == preamble else { return nil }
        i += preamble.count
        guard i < b.count else { return nil }
        var length: Int
        switch b[i] {
        case 0x81:
            guard i + 2 < b.count else { return nil }
            length = Int(b[i + 1]) | Int(b[i + 2]) << 8
            i += 3
        case 0x82:
            guard i + 4 < b.count else { return nil }
            length = Int(b[i + 1]) | Int(b[i + 2]) << 8 | Int(b[i + 3]) << 16 | Int(b[i + 4]) << 24
            i += 5
        case let n where n < 0x80:
            length = Int(n)
            i += 1
        default:
            return nil
        }
        guard length <= maxLength, i + length <= b.count else { return nil }
        return String(bytes: b[i..<(i + length)], encoding: .utf8)
    }

    static func find(_ needle: [UInt8], in hay: [UInt8]) -> Int? {
        guard needle.count <= hay.count else { return nil }
        var i = 0
        while i + needle.count <= hay.count {
            if hay[i] == needle[0], Array(hay[i..<(i + needle.count)]) == needle { return i }
            i += 1
        }
        return nil
    }
}
