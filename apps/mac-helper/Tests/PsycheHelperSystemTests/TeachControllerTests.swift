import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import PsycheProtocol
import Testing

/// A fake AX event stream.
private final class FakeSource: TeachInputSource, @unchecked Sendable {
    var onInput: (@Sendable (TeachInput, Date) -> Void)?
    var started = false
    var stopped = false
    let allow: Bool
    init(allow: Bool = true) { self.allow = allow }
    func start(_ onInput: @escaping @Sendable (TeachInput, Date) -> Void) -> Bool {
        guard allow else { return false }
        self.onInput = onInput
        started = true
        return true
    }
    func stop() { stopped = true }
    func send(_ i: TeachInput) { onInput?(i, Date()) }
}

private final class Events: @unchecked Sendable {
    let lock = NSLock()
    var items: [JSONValue] = []
    func add(_ e: JSONValue) { lock.withLock { items.append(e) } }
    var steps: [JSONValue] { lock.withLock { items.filter { $0["type"] == "teach.step" } } }
}

private let notes = TeachTargetInfo(app: "com.apple.Notes", appName: "Notes", window: "Notes", role: "AXButton", label: "New Note")
private let body = TeachTargetInfo(app: "com.apple.Notes", appName: "Notes", window: "Notes", role: "AXTextArea", label: "Body")

private func settle() async { try? await _Concurrency.Task.sleep(nanoseconds: 100_000_000) }

@Suite("teach mode (J8): controller and capabilities", .serialized)
struct TeachControllerTests {
    @Test func recordStreamStopAndReviewDraft() async throws {
        let source = FakeSource()
        let shot = Data([0xFF, 0xD8, 0xFF])
        let teach = TeachController(makeSource: { source }, screenshot: { app in app == "com.apple.Notes" ? (shot, "image/jpeg") : nil }, log: HelperLog(echo: { _ in }))
        let events = Events()
        let id = try teach.begin(.init(name: "new-note", description: "Make a note", screenshots: true), emit: { events.add($0) })
        #expect(throws: CapabilityError.self) { _ = try teach.begin(.init(), emit: { _ in }) }  // one at a time
        #expect(teach.status()["active"] == true)
        source.send(.click(button: 0, clickCount: 1, target: notes))
        for c in "Groceries" { source.send(.key(keyCode: 0, characters: String(c), flags: 0, target: body)) }
        await settle()
        let waiter = _Concurrency.Task { await teach.wait(id) }
        let draft = try #require(teach.end(id, .stop))
        let waited = await waiter.value
        #expect(waited == draft)
        #expect(source.stopped)
        #expect(draft["endedBy"] == "stop" && draft["name"] == "new-note" && draft["description"] == "Make a note")
        let steps = try #require(draft["steps"]?.arrayValue)
        #expect(steps.map { $0["kind"] } == ["click", "type"])
        #expect(steps.allSatisfy { $0["screenshot"] == nil })  // no bytes in the draft
        let files = try #require(draft["files"]?.arrayValue)
        #expect(files.first?["path"] == "SKILL.md")
        #expect(files.first?["text"]?.stringValue?.contains(#"Type "Groceries" into the textarea "Body"."#) == true)
        #expect(files.contains { $0["path"] == "screens/step-1.jpg" && $0["fromStep"] == 1 })
        // The streamed click carried its screenshot bytes.
        await settle()
        let click = try #require(events.steps.first)
        #expect(click["step"]?["screenshot"]?["base64"] == .string(shot.base64EncodedString()))
        #expect(teach.status()["active"] == false)
        #expect(teach.end(id, .stop) == draft)  // idempotent
    }

    @Test func cancelKeepsNothingAndLimitsEnd() async throws {
        let source = FakeSource()
        let teach = TeachController(makeSource: { source }, log: HelperLog(echo: { _ in }))
        let id = try teach.begin(.init(), emit: { _ in })
        source.send(.click(button: 0, clickCount: 1, target: notes))
        await settle()
        let draft = try #require(teach.end(id, .cancel))
        #expect(draft["endedBy"] == "cancel" && draft["steps"]?.arrayValue?.isEmpty == true && draft["files"]?.arrayValue?.isEmpty == true)

        let limited = FakeSource()
        let teach2 = TeachController(makeSource: { limited }, log: HelperLog(echo: { _ in }))
        let id2 = try teach2.begin(.init(maxSteps: 2), emit: { _ in })
        let waiter = _Concurrency.Task { await teach2.wait(id2) }
        limited.send(.click(button: 0, clickCount: 1, target: notes))
        limited.send(.click(button: 1, clickCount: 1, target: notes))
        let d = await waiter.value
        #expect(d["endedBy"] == "limit" && d["steps"]?.arrayValue?.count == 2)
        #expect(limited.stopped)
    }

    @Test func refusalsAndCapabilityShapes() async throws {
        let denied = TeachController(makeSource: { FakeSource(allow: false) }, log: HelperLog(echo: { _ in }))
        do {
            _ = try denied.begin(.init(), emit: { _ in })
            Issue.record("expected permission_missing")
        } catch let e as CapabilityError { #expect(e.reason == "permission_missing") }
        #expect(denied.status()["active"] == false)
        #expect(throws: CapabilityError.self) { _ = try denied.begin(.init(name: "Bad Name"), emit: { _ in }) }

        let caps = TeachCapabilities.make(TeachController(makeSource: { FakeSource() }, log: HelperLog(echo: { _ in })),
                                          computer: ComputerUse(environment: ["PSYCHE_HOME": NSTemporaryDirectory()], log: HelperLog(echo: { _ in })))
        let specs = Dictionary(uniqueKeysWithValues: caps.map { ($0.spec.name, $0.spec) })
        #expect(Set(specs.keys) == ["teach.start", "teach.stop", "teach.cancel", "teach.status"])
        #expect(specs["teach.start"]?.streaming == true && specs["teach.start"]?.receiptKind == "teach" && specs["teach.start"]?.permissions == [.accessibility])
    }
}
