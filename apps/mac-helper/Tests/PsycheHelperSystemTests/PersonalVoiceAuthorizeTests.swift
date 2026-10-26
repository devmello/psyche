import Foundation
import PsycheHelperCore
import PsycheHelperSystem
import PsycheProtocol
import Testing

/// `speech.personal_voice.authorize` on a fake authorizer (voice mode V-H H4): it prompts once,
/// only while nothing is decided. No real prompt appears in tests.
@Suite("speech.personal_voice.authorize")
struct PersonalVoiceAuthorizeTests {
    struct DenyAll: PermissionPreflight {
        func isGranted(_ permission: TCCPermission) -> Bool { false }
    }

    final class FakeAuthorizer: PersonalVoiceAuthorizer, @unchecked Sendable {
        private let lock = NSLock()
        private var current: String
        private let answer: String
        private var asks = 0
        init(_ status: String, answer: String = "authorized") {
            current = status
            self.answer = answer
        }
        var requests: Int { lock.withLock { asks } }
        func status() -> String { lock.withLock { current } }
        func request() async -> String {
            lock.withLock {
                asks += 1
                current = answer
                return current
            }
        }
    }

    func authorize(_ fake: FakeAuthorizer) async throws -> CapabilityOutput {
        let h = SpeechCapabilities.make(preflight: DenyAll(), personalVoice: fake).first { $0.spec.name == "speech.personal_voice.authorize" }!
        #expect(h.spec.sideEffect == .write && h.spec.receiptKind == "permission_request" && !h.spec.streaming)
        return try await h.invoke(InvocationContext(invocationId: "i", capability: h.spec.name, params: [:], approvalId: nil, emit: { _ in }))
    }

    @Test func promptsOnceWhileUndecided() async throws {
        let fake = FakeAuthorizer("notDetermined")
        let first = try await authorize(fake)
        #expect(first.result == ["status": "authorized", "prompted": true])
        #expect(first.receipt?.summary.contains("Asked macOS") == true)
        // Asking again does not prompt: the answer stands.
        #expect(try await authorize(fake).result == ["status": "authorized", "prompted": false])
        #expect(fake.requests == 1)
    }

    @Test func deniedPointsAtSettingsWithoutAPrompt() async throws {
        let fake = FakeAuthorizer("denied")
        let r = try await authorize(fake).result
        #expect(r["status"] == "denied" && r["prompted"] == false && r["settingsHint"] != nil)
        #expect(fake.requests == 0)
        let after = FakeAuthorizer("notDetermined", answer: "denied")
        #expect(try await authorize(after).result["settingsHint"] != nil)
    }

    @Test func unsupportedMacsNeverPrompt() async throws {
        let fake = FakeAuthorizer("unsupported")
        #expect(try await authorize(fake).result == ["status": "unsupported", "prompted": false])
        #expect(fake.requests == 0)
        #expect(PersonalVoiceAuth.result(status: "weird", prompted: false)["status"] == "unsupported")
    }

    @Test func nothingElsePrompts() {
        // speech.voices and speech.status only read the status (they call status(), never request()).
        let specs = SpeechCapabilities.make(preflight: DenyAll(), personalVoice: FakeAuthorizer("notDetermined")).map(\.spec)
        #expect(specs.filter { $0.name.contains("personal_voice") }.map(\.name) == ["speech.personal_voice.authorize"])
    }
}
