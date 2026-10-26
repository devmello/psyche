import Foundation
import PsycheHelperCore
import PsycheHelperSystem
import PsycheProtocol
import Testing

private struct StubBackend: DictationBackend {
    var current: DictationFocus?
    func focus() -> DictationFocus? { current }
    func secureInputActive() -> Bool { false }
    func setSelectedText(_ text: String) -> Bool { true }
    func replaceSelectedRange(_ text: String) -> Bool { true }
    func type(_ text: String, guardChunk: @escaping () throws -> Void) throws {}
}

private let notes = DictationFocus(
    pid: 11, bundleId: "com.apple.Notes", appName: "Notes", role: "AXTextArea",
    element: DictationElementInfo(selectedTextSettable: true, valueSettable: true, hasSelectedRange: true))

private func cap(_ name: String, focus: DictationFocus? = notes) throws -> any CapabilityHandler {
    try #require(DictationCapabilities.make(backend: StubBackend(current: focus)).first { $0.spec.name == name })
}

private func run(_ c: any CapabilityHandler, _ params: JSONValue) async throws -> JSONValue {
    try await c.invoke(InvocationContext(invocationId: "i", capability: c.spec.name, params: params, approvalId: nil, emit: { _ in })).result
}

@Suite("dictation.* capabilities (J9, Q2)")
struct DictationCapabilitiesTests {
    @Test func specs() throws {
        let specs = DictationCapabilities.make(backend: StubBackend()).map(\.spec)
        #expect(specs.map(\.name) == ["dictation.target", "dictation.insert", "dictation.watch"])
        #expect(specs.map(\.sideEffect) == [.read, .write, .read])
        #expect(specs.map(\.streaming) == [false, false, true])
        #expect(specs.allSatisfy { $0.permissions == [.accessibility] && $0.targetKind == nil })
    }

    @Test func targetAndInsert() async throws {
        let t = try await run(try cap("dictation.target"), [:])
        #expect(t["target"]?["appName"] == "Notes" && t["target"]?["insertable"] == true)
        #expect(try await run(try cap("dictation.target", focus: nil), [:]) == ["target": .null])

        let r = try await run(try cap("dictation.insert"), ["text": "hello\nworld", "expectPid": 11])
        #expect(r["method"] == "ax" && r["chars"] == 11 && r["target"]?["bundleId"] == "com.apple.Notes")
        await #expect(throws: CapabilityError.self) { _ = try await run(try cap("dictation.insert"), [:]) }
    }

    @Test func watchWithNullKeyStops() async throws {
        #expect(try await run(try cap("dictation.watch"), ["key": .null]) == ["watching": false])
        #expect(try await run(try cap("dictation.watch"), [:]) == ["watching": false])
    }

    @Test func twoKeyWatchIsValidatedBeforeTheTap() async throws {
        let w = try cap("dictation.watch")
        for keys: JSONValue in [
            [["key": "fn", "role": "voice"], ["key": "fn", "role": "dictation"]],
            [["key": "fn", "role": "voice"], ["key": "rightOption", "role": "voice"]],
            [],
        ] {
            do {
                _ = try await run(w, ["key": .null, "keys": keys])
                Issue.record("accepted \(keys)")
            } catch let e as CapabilityError {
                #expect(e.reason == "invalid_params")
            }
        }
        let schema = w.spec.inputSchema
        #expect(schema["properties"]?["keys"]?["maxItems"] == 2)
    }
}
