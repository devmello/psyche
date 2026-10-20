import Foundation
import PsycheHelperCore
import PsycheHelperSystem
import PsycheProtocol
import Testing

private actor Sent {
    var scripts: [String] = []
    var asked: [Bool] = []
    func add(_ s: String) { scripts.append(s) }
    func ask(_ a: Bool) { asked.append(a) }
}

/// A directory that cannot be listed: what ~/Library/Messages looks like without Full Disk Access.
private let lockedDir: String = {
    let d = NSTemporaryDirectory() + "psyche-locked-\(UUID().uuidString)"
    try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    chmod(d, 0)
    return d
}()

private func registry(sent: Sent, automation: MessagesAutomationStatus = .granted, fail: Int = 0, osaError: Int = -1728,
                      dbPath: String = lockedDir + "/chat.db") -> CapabilityRegistry {
    let failures = Counter(fail)
    return CapabilityRegistry(MessagesCapabilities.make(
        databasePath: dbPath,
        sender: { s in
            await sent.add(s)
            if await failures.take() {
                throw CapabilityError(.unavailable, reason: "script_error", "script failed", details: ["osaError": .int(osaError)])
            }
        },
        automation: { ask in
            await sent.ask(ask)
            return automation
        },
        sleep: { _ in throw CancellationError() }
    ))
}

private actor Counter {
    var left: Int
    init(_ n: Int) { left = n }
    func take() -> Bool { guard left > 0 else { return false }; left -= 1; return true }
}

private func call(_ r: CapabilityRegistry, _ name: String, _ params: JSONValue, approval: String? = nil) async throws -> CapabilityOutput {
    let h = try #require(r[name])
    return try await h.invoke(InvocationContext(invocationId: "i", capability: name, params: params, approvalId: approval, emit: { _ in }))
}

@Suite("messages.* capabilities (J7)")
struct MessagesCapabilitiesTests {
    @Test func manifestDeclaresSideEffects() {
        let r = registry(sent: Sent())
        let specs = Dictionary(uniqueKeysWithValues: r.ordered.map { ($0.spec.name, $0.spec) })
        #expect(Set(specs.keys) == ["messages.status", "messages.chats", "messages.read", "messages.watch", "messages.send"])
        #expect(specs["messages.send"]?.sideEffect == .destructive && specs["messages.send"]?.targetKind == .recipient)
        #expect(specs["messages.send"]?.receiptKind == "message_send")
        #expect(specs["messages.watch"]?.streaming == true && specs["messages.watch"]?.sideEffect == .read)
        #expect(specs["messages.status"]?.sideEffect == SideEffect.none)
    }

    @Test func sendNeedsAnApprovalAndNeverRunsAScriptWithoutOne() async throws {
        let sent = Sent()
        let r = registry(sent: sent)
        await #expect(throws: CapabilityError.self) { _ = try await call(r, "messages.send", ["to": "+15551110000", "text": "hi"]) }
        do { _ = try await call(r, "messages.send", ["to": "+15551110000", "text": "hi"]) } catch let e as CapabilityError {
            #expect(e.code == .approvalRequired)
        }
        #expect(await sent.scripts.isEmpty)
        #expect(await sent.asked.isEmpty)
    }

    @Test func approvedSendRunsOneScriptAndRecordsAReceiptWithoutTheText() async throws {
        let sent = Sent()
        let out = try await call(registry(sent: sent), "messages.send", ["to": "+15551110000", "text": "secret plan"], approval: "apr_1")
        #expect(out.result["sent"] == true && out.result["recipient"] == "+15551110000")
        #expect(out.receipt?.summary == "Sent a message to +15551110000")
        #expect(!(out.receipt?.summary.contains("secret") ?? true))
        #expect(await sent.scripts.count == 1)
        #expect(await sent.asked == [true])
    }

    @Test func groupSendFallsBackToTheOtherChatGuidSpelling() async throws {
        let sent = Sent()
        _ = try await call(registry(sent: sent, fail: 1), "messages.send", ["chatId": "iMessage;+;chat123", "text": "x"], approval: "apr_1")
        let scripts = await sent.scripts
        #expect(scripts.count == 2 && scripts[1].contains("any;+;chat123"))
    }

    @Test func aTimeoutAfterMessagesTookTheTextIsNotRetried() async {
        let sent = Sent()
        await #expect(throws: CapabilityError.self) {
            _ = try await call(registry(sent: sent, fail: 1, osaError: -1712), "messages.send", ["chatId": "iMessage;+;chat123", "text": "x"], approval: "a")
        }
        #expect(await sent.scripts.count == 1)
    }

    @Test func deniedAutomationIsAClearError() async {
        do {
            _ = try await call(registry(sent: Sent(), automation: .denied), "messages.send", ["to": "+15551110000", "text": "x"], approval: "a")
            Issue.record("expected a refusal")
        } catch let e as CapabilityError {
            #expect(e.reason == "automation_denied" && e.message.contains("Automation"))
        } catch { Issue.record("\(error)") }
    }

    @Test func readsWithoutFullDiskAccessExplainWhereToGrantIt() async {
        let r = registry(sent: Sent())
        for name in ["messages.read", "messages.chats", "messages.watch"] {
            do {
                _ = try await call(r, name, [:])
                Issue.record("\(name) should fail")
            } catch let e as CapabilityError {
                #expect(e.code == .forbidden && e.reason == "full_disk_access_missing", "\(name)")
                #expect(e.message.contains("Full Disk Access"))
            } catch { Issue.record("\(error)") }
        }
    }

    @Test func statusNeverPrompts() async throws {
        let sent = Sent()
        let out = try await call(registry(sent: sent), "messages.status", [:])
        #expect(out.result["fullDiskAccess"] == false && out.result["automation"] == "granted")
        #expect(await sent.asked == [false])
    }
}
