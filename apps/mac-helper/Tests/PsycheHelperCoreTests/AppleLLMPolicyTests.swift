import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

@Suite("Apple on-device model policy")
struct AppleLLMPolicyTests {
    @Test func inputIsRefusedNotCut() {
        #expect(AppleLLMPolicy.checkInput(prompt: "hi", instructions: nil) == nil)
        #expect(AppleLLMPolicy.checkInput(prompt: "", instructions: nil) == .tooLong)
        let big = String(repeating: "a", count: AppleLLMPolicy.maxInputChars)
        #expect(AppleLLMPolicy.checkInput(prompt: big, instructions: nil) == nil)
        #expect(AppleLLMPolicy.checkInput(prompt: big, instructions: "x") == .tooLong)
        #expect(AppleLLMPolicy.checkInput(prompt: "q", instructions: big) == .tooLong)
    }

    @Test func numbersAreClamped() {
        #expect(AppleLLMPolicy.outputTokens(nil) == AppleLLMPolicy.defaultOutputTokens)
        #expect(AppleLLMPolicy.outputTokens(1) == 16)
        #expect(AppleLLMPolicy.outputTokens(99_999) == AppleLLMPolicy.maxOutputTokens)
        #expect(AppleLLMPolicy.timeoutMs(nil) == AppleLLMPolicy.defaultTimeoutMs)
        #expect(AppleLLMPolicy.timeoutMs(5) == AppleLLMPolicy.minTimeoutMs)
        #expect(AppleLLMPolicy.temperature(nil) == nil)
        #expect(AppleLLMPolicy.temperature(9) == 2 && AppleLLMPolicy.temperature(-1) == 0)
    }

    @Test func schemaSubsetBecomesAShape() throws {
        let schema: JSONValue = Schema.object([
            "terms": Schema.array(Schema.string()),
            "after": Schema.string("YYYY-MM-DD"),
            "intent": Schema.string(enum: ["find", "answer", "list"]),
            "count": Schema.integer(),
        ], required: ["terms", "intent"])
        let shape = try AppleLLMPolicy.parseSchema(schema)
        guard case .object(let name, let props) = shape else { Issue.record("not an object"); return }
        #expect(name == "Reply")
        #expect(props.map(\.name) == ["after", "count", "intent", "terms"])
        #expect(props.first { $0.name == "intent" }?.shape == .choice(["find", "answer", "list"]))
        #expect(props.first { $0.name == "terms" }?.shape == .array(.string, maxItems: AppleLLMPolicy.maxArrayItems))
        #expect(props.first { $0.name == "terms" }?.required == true)
        #expect(props.first { $0.name == "after" }?.required == false)
        #expect(props.first { $0.name == "after" }?.description == "YYYY-MM-DD")
    }

    @Test func unsupportedShapesAreRefusedWithAReason() {
        let bad: [JSONValue] = [
            .string("not a schema"),
            .object([:]),
            Schema.object([:]),
            .object(["type": "null"]),
            .object(["type": "array"]),
            Schema.string(enum: []),
            Schema.string(enum: ["a", "a"]),
            Schema.object(Dictionary(uniqueKeysWithValues: (0...AppleLLMPolicy.maxProperties).map { ("p\($0)", Schema.string()) })),
        ]
        for schema in bad {
            #expect(throws: AppleLLMPolicy.SchemaError.self) { try AppleLLMPolicy.parseSchema(schema) }
        }
        // Four levels of nesting are the limit.
        var deep: JSONValue = Schema.string()
        for _ in 0..<AppleLLMPolicy.maxSchemaDepth { deep = Schema.object(["a": deep]) }
        #expect(throws: AppleLLMPolicy.SchemaError.self) { try AppleLLMPolicy.parseSchema(deep) }
    }

    @Test func modelErrorsMapToRefusals() {
        #expect(AppleLLMPolicy.refusal(forErrorCase: "exceededContextWindowSize(Context(...))") == .contextExceeded)
        #expect(AppleLLMPolicy.refusal(forErrorCase: "guardrailViolation(Context(...))") == .guardrail)
        #expect(AppleLLMPolicy.refusal(forErrorCase: "refusal(Refusal(...), Context(...))") == .guardrail)
        #expect(AppleLLMPolicy.refusal(forErrorCase: "unsupportedLanguageOrLocale(...)") == .unsupportedLanguage)
        #expect(AppleLLMPolicy.refusal(forErrorCase: "unsupportedGuide(...)") == .unsupportedSchema)
        #expect(AppleLLMPolicy.refusal(forErrorCase: "rateLimited(...)") == .rateLimited)
        #expect(AppleLLMPolicy.refusal(forErrorCase: "concurrentRequests(...)") == .rateLimited)
        #expect(AppleLLMPolicy.refusal(forErrorCase: "assetsUnavailable(...)") == .unavailable)
        #expect(AppleLLMPolicy.refusal(forErrorCase: "somethingNew") == .failed)
    }
}
