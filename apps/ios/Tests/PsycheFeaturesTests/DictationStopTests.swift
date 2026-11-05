import Foundation
import Testing

@testable import PsycheFeatures

private final class FakeEngine: DictationEngining, @unchecked Sendable {
    private let lock = NSLock()
    private var _starts = 0
    private var _stops = 0
    var starts: Int { lock.withLock { _starts } }
    var stops: Int { lock.withLock { _stops } }
    func start(onText: @escaping @Sendable (String) -> Void) async throws { lock.withLock { _starts += 1 } }
    func stop() async { lock.withLock { _stops += 1 } }
}

/// With the `audio` background mode the microphone would keep running after the app leaves the screen, so the app
/// stops every dictation when the scene leaves `.active`.
@MainActor
@Suite(.serialized)
struct DictationStopTests {
    private func listening(_ dictation: Dictation) async throws {
        dictation.toggle { _ in }
        for _ in 0..<200 where dictation.state != .listening { try await Task.sleep(for: .milliseconds(10)) }
        #expect(dictation.state == .listening)
    }

    @Test func stopAllStopsEveryDictationInTheApp() async throws {
        let homeEngine = FakeEngine()
        let chatEngine = FakeEngine()
        let home = Dictation(engine: homeEngine)
        let chat = Dictation(engine: chatEngine)
        try await listening(home)
        try await listening(chat)
        PsycheDictation.stopAll()  // what PsycheApp calls when the scene phase is not .active
        #expect(home.state == .idle)
        #expect(chat.state == .idle)
        try await Task.sleep(for: .milliseconds(50))
        #expect(homeEngine.stops >= 1)
        #expect(chatEngine.stops >= 1)
    }

    @Test func stopAllLeavesAnIdleDictationAlone() async throws {
        let engine = FakeEngine()
        let idle = Dictation(engine: engine)
        PsycheDictation.stopAll()
        #expect(idle.state == .idle)
    }
}
