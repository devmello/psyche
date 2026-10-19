import Foundation
import PsycheProtocol

/// Tiny JSON Schema builder for capability `inputSchema`s (draft 2020-12 subset the Gateway's
/// validator understands: type, properties, required, enum, minimum/maximum, items, maxLength).
public enum Schema {
    public static func object(_ properties: [String: JSONValue], required: [String] = [], description: String? = nil, additional: Bool = false) -> JSONValue {
        var o: [String: JSONValue] = [
            "type": "object",
            "properties": .object(properties),
            "additionalProperties": .bool(additional),
        ]
        if !required.isEmpty { o["required"] = .array(required.sorted().map { .string($0) }) }
        if let description { o["description"] = .string(description) }
        return .object(o)
    }

    public static func string(_ description: String? = nil, enum values: [String]? = nil, maxLength: Int? = nil) -> JSONValue {
        var o: [String: JSONValue] = ["type": "string"]
        if let description { o["description"] = .string(description) }
        if let values { o["enum"] = .array(values.map { .string($0) }) }
        if let maxLength { o["maxLength"] = .number(Double(maxLength)) }
        return .object(o)
    }

    public static func integer(_ description: String? = nil, min: Int? = nil, max: Int? = nil) -> JSONValue {
        var o: [String: JSONValue] = ["type": "integer"]
        if let description { o["description"] = .string(description) }
        if let min { o["minimum"] = .number(Double(min)) }
        if let max { o["maximum"] = .number(Double(max)) }
        return .object(o)
    }

    public static func number(_ description: String? = nil, min: Double? = nil, max: Double? = nil) -> JSONValue {
        var o: [String: JSONValue] = ["type": "number"]
        if let description { o["description"] = .string(description) }
        if let min { o["minimum"] = .number(min) }
        if let max { o["maximum"] = .number(max) }
        return .object(o)
    }

    public static func boolean(_ description: String? = nil) -> JSONValue {
        var o: [String: JSONValue] = ["type": "boolean"]
        if let description { o["description"] = .string(description) }
        return .object(o)
    }

    public static func array(_ items: JSONValue, description: String? = nil, maxItems: Int? = nil) -> JSONValue {
        var o: [String: JSONValue] = ["type": "array", "items": items]
        if let description { o["description"] = .string(description) }
        if let maxItems { o["maxItems"] = .number(Double(maxItems)) }
        return .object(o)
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral
{
    public init(stringLiteral value: String) { self = .string(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
    }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
}

extension JSONValue {
    public static func int(_ v: Int) -> JSONValue { .number(Double(v)) }

    public var objectValue: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    public var numberValue: Double? {
        if case .number(let n) = self { return n }
        return nil
    }

    /// Compact JSON text (sorted keys), e.g. for hashing or printing the manifest.
    public func jsonString(pretty: Bool = false) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = pretty ? [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes] : [.sortedKeys, .withoutEscapingSlashes]
        return (try? String(data: enc.encode(self), encoding: .utf8)) ?? "null"
    }
}
