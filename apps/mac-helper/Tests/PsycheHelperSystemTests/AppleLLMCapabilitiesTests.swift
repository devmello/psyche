import Foundation
import PsycheHelperCore
import PsycheHelperSystem
import PsycheProtocol
import Testing
#if canImport(FoundationModels)
import FoundationModels
#endif

// Nothing here loads or runs Apple's real model: every call goes to `FakeBackend`.

private final class Calls: @unchecked Sendable {
    private let lock = NSLock()
    private var _inFlight = 0, _maxInFlight = 0
    private(set) var requests: [(prompt: String, instructions: String?, shape: AppleLLMPolicy.Shape?, maxTokens: Int, temperature: Double?)] = []
    func begin(_ r: (prompt: String, instructions: String?, shape: AppleLLMPolicy.Shape?, maxTokens: Int, temperature: Double?)) {
        lock.lock(); defer { lock.unlock() }
        requests.append(r); _inFlight += 1; _maxInFlight = max(_maxInFlight, _inFlight)
    }
    func end() { lock.lock(); _inFlight -= 1; lock.unlock() }
    var maxInFlight: Int { lock.lock(); defer { lock.unlock() }; return _maxInFlight }
}

private struct FakeBackend: AppleLanguageModelBackend {
    var available: AppleLlmAvailability = AppleLlmAvailability(available: true, contextTokens: 4096, reason: nil)
    var reply: Result<String, AppleLLMFailure> = .success("ok")
    var delayMs = 0
    var calls = Calls()
    func availability() -> AppleLlmAvailability { available }
    func generate(prompt: String, instructions: String?, shape: AppleLLMPolicy.Shape?, maxTokens: Int, temperature: Double?) async throws -> String {
        calls.begin((prompt, instructions, shape, maxTokens, temperature))
        defer { calls.end() }
        if delayMs > 0 { try await Swift.Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000) }
        return try reply.get()
    }
}

private func invoke(_ backend: AppleLanguageModelBackend, _ name: String, _ params: JSONValue) async throws -> JSONValue {
    let registry = CapabilityRegistry(AppleLLMCapabilities.make(backend: backend))
    let h = try #require(registry[name])
    return try await h.invoke(InvocationContext(invocationId: "i", capability: name, params: params, approvalId: nil, emit: { _ in })).result
}

private func generate(_ backend: AppleLanguageModelBackend, _ params: JSONValue) async throws -> AppleLlmGenerateResult {
    try await invoke(backend, "llm.apple.generate", params).decode(as: AppleLlmGenerateResult.self)
}

@Suite("llm.apple.* (Apple on-device model, fake backend)")
struct AppleLLMCapabilitiesTests {
    @Test func bothCapabilitiesAreReadOnlyAndDescribed() throws {
        let registry = CapabilityRegistry(AppleLLMCapabilities.make(backend: FakeBackend()))
        for name in ["llm.apple.availability", "llm.apple.generate"] {
            let spec = try #require(registry[name]).spec
            #expect(spec.sideEffect == .read)
            #expect(spec.description.contains("Model router only"))
        }
    }

    @Test func availabilityIsReportedWithoutRunningTheModel() async throws {
        let backend = FakeBackend(available: AppleLlmAvailability(available: false, contextTokens: 4096, reason: .appleIntelligenceNotEnabled))
        let out = try await invoke(backend, "llm.apple.availability", .object([:])).decode(as: AppleLlmAvailability.self)
        #expect(out.available == false && out.reason == .appleIntelligenceNotEnabled && out.contextTokens == 4096)
        #expect(backend.calls.requests.isEmpty)
    }

    @Test func textComesBackWithClampedOptions() async throws {
        let backend = FakeBackend(reply: .success("hello"))
        let r = try await generate(backend, .object(["prompt": "hi", "instructions": "be brief", "maxTokens": 99_999, "temperature": 5]))
        #expect(r.text == "hello" && r.structured == false && r.refusal == nil)
        let call = try #require(backend.calls.requests.first)
        #expect(call.prompt == "hi" && call.instructions == "be brief" && call.shape == nil)
        #expect(call.maxTokens == AppleLLMPolicy.maxOutputTokens)
    }

    @Test func aSchemaMakesTheReplyStructured() async throws {
        let backend = FakeBackend(reply: .success("{\"intent\":\"find\"}"))
        let schema = Schema.object(["intent": Schema.string(enum: ["find", "answer"])], required: ["intent"])
        let r = try await generate(backend, .object(["prompt": "q", "schema": schema]))
        #expect(r.structured && r.text == "{\"intent\":\"find\"}")
        guard case .object(_, let props)? = backend.calls.requests.first?.shape else { Issue.record("no shape"); return }
        #expect(props.first?.shape == .choice(["find", "answer"]))
    }

    @Test func anUnsupportedSchemaIsRefusedBeforeTheModel() async throws {
        let backend = FakeBackend()
        let r = try await generate(backend, .object(["prompt": "q", "schema": .object(["type": "null"])]))
        #expect(r.refusal == .unsupportedSchema && r.text.isEmpty)
        #expect(backend.calls.requests.isEmpty)
    }

    @Test func tooMuchInputIsRefusedBeforeTheModel() async throws {
        let backend = FakeBackend()
        let r = try await generate(backend, .object(["prompt": .string(String(repeating: "x", count: AppleLLMPolicy.maxInputChars)), "instructions": "y"]))
        #expect(r.refusal == .tooLong)
        #expect(backend.calls.requests.isEmpty)
    }

    @Test func anUnavailableModelIsARefusalWithTheReasonNotAnError() async throws {
        for reason in [AppleLlmUnavailableReason.deviceNotEligible, .appleIntelligenceNotEnabled, .modelNotReady, .unsupportedOS] {
            let backend = FakeBackend(available: AppleLlmAvailability(available: false, contextTokens: 4096, reason: reason))
            let r = try await generate(backend, .object(["prompt": "hi"]))
            #expect(r.refusal == .unavailable && r.reason == reason && r.text.isEmpty)
            #expect(backend.calls.requests.isEmpty)
        }
    }

    @Test func modelFailuresAreRefusals() async throws {
        for refusal in [AppleLlmRefusal.guardrail, .contextExceeded, .unsupportedLanguage, .rateLimited] {
            let r = try await generate(FakeBackend(reply: .failure(AppleLLMFailure(refusal))), .object(["prompt": "hi"]))
            #expect(r.refusal == refusal && r.text.isEmpty)
        }
    }

    @Test func aSlowModelTimesOut() async throws {
        let r = try await generate(FakeBackend(delayMs: 5000), .object(["prompt": "hi", "timeoutMs": 1000]))
        #expect(r.refusal == .timedOut)
    }

    @Test func callsRunOneAtATime() async throws {
        let backend = FakeBackend(delayMs: 40)
        let registry = CapabilityRegistry(AppleLLMCapabilities.make(backend: backend))
        let h = try #require(registry["llm.apple.generate"])
        try await withThrowingTaskGroup(of: Void.self) { group in
            for i in 0..<4 {
                group.addTask {
                    _ = try await h.invoke(InvocationContext(invocationId: "i\(i)", capability: "llm.apple.generate", params: .object(["prompt": .string("p\(i)")]), approvalId: nil, emit: { _ in }))
                }
            }
            try await group.waitForAll()
        }
        #expect(backend.calls.requests.count == 4)
        #expect(backend.calls.maxInFlight == 1)
    }

    @Test func withoutFoundationModelsTheLiveBackendSaysWhy() {
        // `live()` only picks a backend; it does not call the model, and `availability()` just
        // reads the system's availability flag.
        let backend = UnavailableBackend(reason: .unsupportedOS)
        #expect(backend.availability().available == false && backend.availability().reason == .unsupportedOS)
    }

    #if canImport(FoundationModels)
    /// Builds the guided-generation schema for every shape. Construction does not load or run the
    /// model; it only checks the mapping to `DynamicGenerationSchema` is accepted.
    @Test func everyShapeBuildsAGenerationSchema() throws {
        guard #available(macOS 26.0, *) else { return }
        let schema: JSONValue = Schema.object([
            "terms": Schema.array(Schema.string()),
            "intent": Schema.string(enum: ["find", "answer", "list"]),
            "n": Schema.integer(),
            "x": Schema.number(),
            "ok": Schema.boolean(),
            "nested": Schema.object(["a": Schema.string()], required: ["a"]),
        ], required: ["intent"])
        let shape = try AppleLLMPolicy.parseSchema(schema)
        _ = try FoundationModelsBackend.generationSchema(shape)
    }
    #endif
}
