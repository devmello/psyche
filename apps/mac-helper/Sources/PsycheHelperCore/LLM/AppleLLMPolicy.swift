import Foundation
import PsycheProtocol

/// Pure rules for `llm.apple.*` (docs/design/search-roadmap-2026.md, "Apple on-device model"): how
/// much input the on-device model is given, how much it may write, and which JSON Schema shapes
/// guided generation accepts. No FoundationModels here, so every rule is unit-tested without the
/// model, without Apple Intelligence and without macOS 26.
public enum AppleLLMPolicy {
    /// The model's window, input and output together, tokens (Apple's documented figure).
    public static let contextTokens = 4096
    /// Prompt and instructions together, characters (about 3,000 tokens; the rest is for the answer).
    public static let maxInputChars = 9000
    public static let maxOutputTokens = 1024
    public static let defaultOutputTokens = 512
    public static let defaultTimeoutMs = 60_000
    public static let minTimeoutMs = 1000
    public static let maxTimeoutMs = 120_000

    /// Guided generation limits: small shapes only, which is all the model handles well.
    public static let maxSchemaDepth = 4
    public static let maxProperties = 12
    public static let maxEnumValues = 24
    public static let maxArrayItems = 20

    /// `too_long` when the input would not leave room to answer; nothing is ever cut.
    public static func checkInput(prompt: String, instructions: String?) -> AppleLlmRefusal? {
        let total = prompt.count + (instructions?.count ?? 0)
        return total > maxInputChars || prompt.isEmpty ? .tooLong : nil
    }

    public static func outputTokens(_ requested: Int?) -> Int {
        min(max(requested ?? defaultOutputTokens, 16), maxOutputTokens)
    }

    public static func timeoutMs(_ requested: Int?) -> Int {
        min(max(requested ?? defaultTimeoutMs, minTimeoutMs), maxTimeoutMs)
    }

    /// 0...2, the same range the other providers take.
    public static func temperature(_ requested: Double?) -> Double? {
        requested.map { min(max($0, 0), 2) }
    }

    /// A guided-generation shape, independent of FoundationModels so it can be tested and then
    /// mapped to `DynamicGenerationSchema` by the live backend.
    public indirect enum Shape: Equatable, Sendable {
        case string
        case number
        case integer
        case boolean
        case choice([String])
        case array(Shape, maxItems: Int?)
        case object(name: String, properties: [Property])
    }

    public struct Property: Equatable, Sendable {
        public var name: String
        public var shape: Shape
        public var description: String?
        public var required: Bool
    }

    public enum SchemaError: Error, Equatable, Sendable {
        case unsupported(String)
    }

    /// Reads the JSON Schema subset the protocol documents (object, array, string, number, integer,
    /// boolean, string enum; properties, required, items). Anything else is refused with a reason,
    /// never guessed at.
    public static func parseSchema(_ schema: JSONValue) throws -> Shape {
        try parse(schema, depth: 1, name: "Reply")
    }

    private static func parse(_ node: JSONValue, depth: Int, name: String) throws -> Shape {
        guard depth <= maxSchemaDepth else { throw SchemaError.unsupported("nesting deeper than \(maxSchemaDepth)") }
        guard case .object = node, let type = node["type"]?.stringValue else {
            throw SchemaError.unsupported("every schema node needs a type")
        }
        switch type {
        case "string":
            guard let raw = node["enum"] else { return .string }
            guard case .array(let values) = raw, !values.isEmpty, values.count <= maxEnumValues else {
                throw SchemaError.unsupported("enum needs 1 to \(maxEnumValues) strings")
            }
            let strings = values.compactMap(\.stringValue)
            guard strings.count == values.count, Set(strings).count == strings.count else {
                throw SchemaError.unsupported("enum values must be distinct strings")
            }
            return .choice(strings)
        case "number": return .number
        case "integer": return .integer
        case "boolean": return .boolean
        case "array":
            guard let items = node["items"] else { throw SchemaError.unsupported("array needs items") }
            var max: Int?
            if case .number(let n)? = node["maxItems"] { max = Swift.min(Int(n), maxArrayItems) }
            return .array(try parse(items, depth: depth + 1, name: name + "Item"), maxItems: max ?? maxArrayItems)
        case "object":
            guard case .object(let props)? = node["properties"], !props.isEmpty, props.count <= maxProperties else {
                throw SchemaError.unsupported("object needs 1 to \(maxProperties) properties")
            }
            var required = Set<String>()
            if case .array(let list)? = node["required"] { required = Set(list.compactMap(\.stringValue)) }
            let properties = try props.keys.sorted().map { key -> Property in
                guard !key.isEmpty, key.count <= 64 else { throw SchemaError.unsupported("property names are 1 to 64 characters") }
                let child = props[key] ?? .null
                return Property(
                    name: key,
                    shape: try parse(child, depth: depth + 1, name: name + key.prefix(1).uppercased() + key.dropFirst()),
                    description: child["description"]?.stringValue.map { String($0.prefix(200)) },
                    required: required.contains(key)
                )
            }
            return .object(name: name, properties: properties)
        default:
            throw SchemaError.unsupported("type \(type)")
        }
    }

    /// Maps a thrown model error name to the protocol's refusal. Matching on the error's case name
    /// (the live backend passes `String(describing:)` of the case) keeps this testable without the
    /// framework.
    public static func refusal(forErrorCase name: String) -> AppleLlmRefusal {
        let n = name.lowercased()
        if n.contains("exceededcontextwindow") { return .contextExceeded }
        if n.contains("guardrail") || n.contains("refusal") { return .guardrail }
        if n.contains("unsupportedlanguage") { return .unsupportedLanguage }
        if n.contains("unsupportedguide") || n.contains("decodingfailure") { return .unsupportedSchema }
        if n.contains("ratelimited") || n.contains("concurrentrequests") { return .rateLimited }
        if n.contains("assetsunavailable") { return .unavailable }
        return .failed
    }
}
