import Foundation
import PsycheHelperCore
import PsycheProtocol
#if canImport(FoundationModels)
import FoundationModels
#endif

/// `llm.apple.availability` and `llm.apple.generate`: Apple's on-device language model
/// (`FoundationModels`, macOS 26 with Apple Intelligence) behind the Gateway's model router
/// (provider `apple`, ref `apple/on-device`). On-device system model: no download, no key, nothing
/// leaves the Mac. Only the router calls these (`nodes.invoke` and agent tools cannot reach `llm.*`),
/// and the model output is as untrusted as any other model's.
///
/// Every call is a fresh session (no history, no tools, no state kept between calls), one at a
/// time. Every failure is a `refusal` in the result, never a thrown error, so Apple Intelligence
/// being off, an unsupported device or region, a guardrail or a full window reads as an ordinary
/// "this model could not answer" upstream. The tests drive a fake backend; nothing in the test
/// suite loads or runs the real model.

public struct AppleLLMFailure: Error, Sendable {
    public var refusal: AppleLlmRefusal
    public init(_ refusal: AppleLlmRefusal) { self.refusal = refusal }
}

/// What the capabilities need from the model; the live one is `FoundationModelsBackend`.
public protocol AppleLanguageModelBackend: Sendable {
    func availability() -> AppleLlmAvailability
    /// The reply text, or JSON text when `shape` is given. Throws `AppleLLMFailure`.
    func generate(prompt: String, instructions: String?, shape: AppleLLMPolicy.Shape?, maxTokens: Int, temperature: Double?) async throws -> String
}

/// One call at a time, in arrival order.
actor AppleLLMGate {
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func run<T: Sendable>(_ body: @Sendable () async throws -> T) async rethrows -> T {
        if busy { await withCheckedContinuation { waiters.append($0) } }
        busy = true
        defer {
            if waiters.isEmpty { busy = false } else { waiters.removeFirst().resume() }
        }
        return try await body()
    }
}

public enum AppleLLMCapabilities {
    public static func make(backend: AppleLanguageModelBackend = live()) -> [any CapabilityHandler] {
        let gate = AppleLLMGate()
        return [
            Capability(CapabilitySpec(
                name: "llm.apple.availability",
                description: "Model router only: whether Apple's on-device language model can run (Apple Intelligence on, device eligible, model ready). Reads availability; never runs the model.",
                sideEffect: .read,
                inputSchema: Schema.object([:])
            )) { _ in
                CapabilityOutput(try JSONValue(encoding: backend.availability()))
            },
            Capability(CapabilitySpec(
                name: "llm.apple.generate",
                description: "Model router only: one prompt through Apple's on-device language model (about a 4,096-token window). Text, or JSON when a schema is given. "
                    + "Failures come back as a refusal, not an error. The reply is untrusted model output.",
                sideEffect: .read,
                inputSchema: Schema.object([
                    "prompt": Schema.string("The prompt", maxLength: AppleLLMPolicy.maxInputChars),
                    "instructions": Schema.string("System-style instructions", maxLength: AppleLLMPolicy.maxInputChars),
                    "schema": Schema.object([:], description: "Guided generation: a JSON Schema subset (object, array, string, number, integer, boolean, string enum)", additional: true),
                    "maxTokens": Schema.integer("Reply tokens, default 512", min: 16, max: AppleLLMPolicy.maxOutputTokens),
                    "temperature": Schema.number("0 to 2", min: 0, max: 2),
                    "timeoutMs": Schema.integer("Give up after this long", min: AppleLLMPolicy.minTimeoutMs, max: AppleLLMPolicy.maxTimeoutMs),
                ], required: ["prompt"])
            )) { ctx in
                let p = try ctx.decode(AppleLlmGenerateParams.self)
                let result = await gate.run { await generate(p, schema: ctx.params["schema"], backend: backend) }
                return CapabilityOutput(try JSONValue(encoding: result))
            },
        ]
    }

    static func refusal(_ r: AppleLlmRefusal, reason: AppleLlmUnavailableReason? = nil) -> AppleLlmGenerateResult {
        AppleLlmGenerateResult(reason: reason, refusal: r, structured: false, text: "")
    }

    /// Never throws: every failure is a refusal.
    static func generate(_ p: AppleLlmGenerateParams, schema: JSONValue?, backend: AppleLanguageModelBackend) async -> AppleLlmGenerateResult {
        if let tooLong = AppleLLMPolicy.checkInput(prompt: p.prompt, instructions: p.instructions) { return refusal(tooLong) }
        let availability = backend.availability()
        guard availability.available else { return refusal(.unavailable, reason: availability.reason) }
        let shape: AppleLLMPolicy.Shape?
        if let schema, schema != .null {
            do { shape = try AppleLLMPolicy.parseSchema(schema) } catch { return refusal(.unsupportedSchema) }
        } else {
            shape = nil
        }
        let timeout = AppleLLMPolicy.timeoutMs(p.timeoutMS)
        do {
            let text = try await withTimeout(milliseconds: timeout) {
                try await backend.generate(
                    prompt: p.prompt, instructions: p.instructions, shape: shape,
                    maxTokens: AppleLLMPolicy.outputTokens(p.maxTokens),
                    temperature: AppleLLMPolicy.temperature(p.temperature)
                )
            }
            return AppleLlmGenerateResult(reason: nil, refusal: nil, structured: shape != nil, text: text)
        } catch let failure as AppleLLMFailure {
            return refusal(failure.refusal)
        } catch is TimedOut {
            return refusal(.timedOut)
        } catch {
            return refusal(.failed)
        }
    }

    struct TimedOut: Error {}

    /// Races `body` against a timer; the loser is cancelled.
    static func withTimeout<T: Sendable>(milliseconds: Int, _ body: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await body() }
            group.addTask {
                try await Swift.Task.sleep(nanoseconds: UInt64(milliseconds) * 1_000_000)
                throw TimedOut()
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw TimedOut() }
            return first
        }
    }

    /// The real model on macOS 26+ when the SDK has it; otherwise a backend that says why not.
    public static func live() -> AppleLanguageModelBackend {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) { return FoundationModelsBackend() }
        #endif
        return UnavailableBackend(reason: .unsupportedOS)
    }
}

/// Reports "not available" for a reason and never produces text.
public struct UnavailableBackend: AppleLanguageModelBackend {
    public var reason: AppleLlmUnavailableReason
    public init(reason: AppleLlmUnavailableReason) { self.reason = reason }
    public func availability() -> AppleLlmAvailability {
        AppleLlmAvailability(available: false, contextTokens: AppleLLMPolicy.contextTokens, reason: reason)
    }
    public func generate(prompt: String, instructions: String?, shape: AppleLLMPolicy.Shape?, maxTokens: Int, temperature: Double?) async throws -> String {
        throw AppleLLMFailure(.unavailable)
    }
}

#if canImport(FoundationModels)
/// `SystemLanguageModel.default`, a fresh `LanguageModelSession` per call (no history, no tools).
/// On-device only: the `PrivateCloudComputeLanguageModel` is deliberately not used, because it
/// sends the prompt off the Mac. Not exercised by any test (see the file header).
@available(macOS 26.0, *)
public struct FoundationModelsBackend: AppleLanguageModelBackend {
    public init() {}

    public func availability() -> AppleLlmAvailability {
        switch SystemLanguageModel.default.availability {
        case .available:
            return AppleLlmAvailability(available: true, contextTokens: AppleLLMPolicy.contextTokens, reason: nil)
        case .unavailable(let why):
            let reason: AppleLlmUnavailableReason
            switch why {
            case .deviceNotEligible: reason = .deviceNotEligible
            case .appleIntelligenceNotEnabled: reason = .appleIntelligenceNotEnabled
            case .modelNotReady: reason = .modelNotReady
            @unknown default: reason = .unknown
            }
            return AppleLlmAvailability(available: false, contextTokens: AppleLLMPolicy.contextTokens, reason: reason)
        }
    }

    public func generate(prompt: String, instructions: String?, shape: AppleLLMPolicy.Shape?, maxTokens: Int, temperature: Double?) async throws -> String {
        do {
            let session = LanguageModelSession(model: .default, instructions: instructions)
            let options = GenerationOptions(temperature: temperature, maximumResponseTokens: maxTokens)
            if let shape {
                let schema = try Self.generationSchema(shape)
                return try await session.respond(to: prompt, schema: schema, options: options).content.jsonString
            }
            return try await session.respond(to: prompt, options: options).content
        } catch let error as LanguageModelSession.GenerationError {
            throw AppleLLMFailure(AppleLLMPolicy.refusal(forErrorCase: String(describing: error)))
        } catch let failure as AppleLLMFailure {
            throw failure
        }
    }

    /// Builds the guided-generation schema; construction does not run or load the model.
    public static func generationSchema(_ shape: AppleLLMPolicy.Shape) throws -> GenerationSchema {
        do { return try GenerationSchema(root: dynamic(shape), dependencies: []) } catch { throw AppleLLMFailure(.unsupportedSchema) }
    }

    static func dynamic(_ shape: AppleLLMPolicy.Shape) -> DynamicGenerationSchema {
        switch shape {
        case .string: return DynamicGenerationSchema(type: String.self)
        case .number: return DynamicGenerationSchema(type: Double.self)
        case .integer: return DynamicGenerationSchema(type: Int.self)
        case .boolean: return DynamicGenerationSchema(type: Bool.self)
        case .choice(let values): return DynamicGenerationSchema(name: "Choice", anyOf: values)
        case .array(let item, let maxItems):
            return DynamicGenerationSchema(arrayOf: dynamic(item), minimumElements: nil, maximumElements: maxItems)
        case .object(let name, let properties):
            return DynamicGenerationSchema(
                name: name,
                properties: properties.map {
                    DynamicGenerationSchema.Property(name: $0.name, description: $0.description, schema: dynamic($0.shape), isOptional: !$0.required)
                }
            )
        }
    }
}
#endif
