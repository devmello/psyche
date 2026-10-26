import Foundation
import PsycheHelperCore
import PsycheHelperSystem
import PsycheProtocol
import Testing

/// Only paths that never reach the microphone, the recognizer or the synthesizer (no TCC, no audio).
@Suite("speech capabilities")
struct SpeechCapabilitiesTests {
    struct DenyAll: PermissionPreflight {
        func isGranted(_ permission: TCCPermission) -> Bool { false }
    }

    let registry = SpeechStreamRegistry()
    var handlers: [String: any CapabilityHandler] {
        Dictionary(uniqueKeysWithValues: SpeechCapabilities.make(preflight: DenyAll(), registry: registry, log: HelperLog(echo: { _ in })).map { ($0.spec.name, $0) })
    }

    func invoke(_ name: String, _ params: JSONValue, id: String = "inv") async throws -> JSONValue {
        let ctx = InvocationContext(invocationId: id, capability: name, params: params, approvalId: nil, emit: { _ in })
        return try await handlers[name]!.invoke(ctx).result
    }

    func reason(_ name: String, _ params: JSONValue) async -> String? {
        do {
            _ = try await invoke(name, params)
            return nil
        } catch let e as CapabilityError {
            return e.reason
        } catch {
            return "other"
        }
    }

    @Test func manifest() {
        let specs = SpeechCapabilities.make(preflight: DenyAll(), registry: registry).map(\.spec)
        #expect(specs.map(\.name) == ["speech.transcribe_stream", "speech.transcribe_file", "speech.audio_push", "speech.stop", "speech.synthesize", "speech.voices", "speech.status"])
        #expect(specs.allSatisfy { $0.sideEffect == .read })
        #expect(specs.filter(\.streaming).map(\.name) == ["speech.transcribe_stream", "speech.transcribe_file", "speech.synthesize"])
        _ = CapabilityRegistry(SpeechCapabilities.make(preflight: DenyAll(), registry: registry))
    }

    @Test func microphoneNeedsPermission() async {
        #expect(await reason("speech.transcribe_stream", [:]) == "permission_missing")
        #expect(registry.activeCount == 0)
    }

    @Test func invalidParamsBeforeAnyAudio() async {
        #expect(await reason("speech.transcribe_stream", ["source": "push"]) == "invalid_params")
        #expect(await reason("speech.transcribe_stream", ["vocabulary": .array(Array(repeating: "w", count: 101))]) == "invalid_params")
        #expect(await reason("speech.synthesize", ["text": ""]) == "invalid_params")
        #expect(await reason("speech.status", ["locale": "nope nope"]) == "invalid_params")
    }

    @Test func pushAndStopUnknownStream() async {
        #expect(await reason("speech.audio_push", ["streamId": "missing", "data": ""]) == "stream_not_found")
        #expect(await reason("speech.stop", ["streamId": "missing"]) == "stream_not_found")
    }

    @Test func pushIntoRegisteredStream() async throws {
        let handle = try registry.register(id: "s1", source: .push)
        let r = try await invoke("speech.audio_push", ["streamId": "s1", "data": .string(Data([0, 0, 1, 0]).base64EncodedString())])
        #expect(r == ["accepted": 4, "bufferedBytes": 4, "final": false])
        #expect(try await invoke("speech.stop", ["streamId": "s1"]) == ["stopped": true, "streamId": "s1"])
        #expect(handle.isStopRequested)
        #expect(await reason("speech.audio_push", ["streamId": "s1", "data": ""]) == "stream_finished")
    }
}
