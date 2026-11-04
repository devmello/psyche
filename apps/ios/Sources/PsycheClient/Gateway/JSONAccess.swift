import Foundation
import enum PsycheProtocol.JSONValue
import PsycheWire

// Lenient readers over `JSONValue`. The Gateway only ever adds fields; reading by name means a new
// field, a new block type or a new enum case never breaks the phone (the generated quicktype structs
// would throw on the first unknown case). Anything missing reads as nil.
extension JSONValue {
    var string: String? { if case .string(let s) = self { s } else { nil } }
    var bool: Bool? { if case .bool(let b) = self { b } else { nil } }
    var double: Double? { if case .number(let n) = self { n } else { nil } }
    var int: Int? { double.map { Int($0) } }
    var array: [JSONValue]? { if case .array(let a) = self { a } else { nil } }
    var object: [String: JSONValue]? { if case .object(let o) = self { o } else { nil } }
    var isNull: Bool { if case .null = self { true } else { false } }

    /// `value.at("a", "b")` reads `a.b`; null and missing both read nil.
    func at(_ path: String...) -> JSONValue? {
        var current: JSONValue? = self
        for key in path {
            guard case .object(let o)? = current else { return nil }
            current = o[key]
        }
        if case .null? = current { return nil }
        return current
    }

    static func obj(_ pairs: KeyValuePairs<String, JSONValue?>) -> JSONValue {
        var out: [String: JSONValue] = [:]
        for (key, value) in pairs { if let value { out[key] = value } }
        return .object(out)
    }
}
