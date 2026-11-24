import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import Testing

@testable import PsycheClient

/// Receipts and artifacts over the fake gateway: the params each call sends and the rows they map to.
struct ReceiptsBackendTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        let gateway = FakeGateway()
        configure(gateway)
        let h = GatewayClientTests.Harness(gateway: gateway)
        await h.client.beginPairing(try GatewayClientTests.link())
        #expect(await GatewayClientTests.wait(h.client) { $0 == .live } == .live)
        return (GatewayBackend(client: h.client), h)
    }

    @Test func receiptsSendTheCursorAndKeepTheNextOne() async throws {
        let seen = Recorder()
        let (backend, _) = try await live { g in
            g.on("receipts.list") { req in
                seen.record(req.params)
                return .success(.object([
                    "receipts": .array([
                        .object([
                            "id": "rcpt_1", "kind": "payment", "summary": "Paid the invoice", "outcome": "ok",
                            "taskId": "task_9", "toolCallId": .null, "approvalId": .null, "createdAt": "2026-11-23T10:14:00.000Z",
                            "externalRefs": .object([
                                "merchant": "Lindqvist", "amount": "240.00", "invoice": "INV-2041", "a": .number(3),
                            ]),
                            "payload": .null,
                        ]),
                    ]),
                    "nextCursor": "c2",
                ]))
            }
        }
        let page = try await backend.receipts(cursor: "c1")
        #expect(seen.last?["cursor"]?.stringValue == "c1")
        #expect(seen.last?["limit"]?.int == 50)
        #expect(page.nextCursor == "c2")
        #expect(page.receipts.count == 1)
        let receipt = try #require(page.receipts.first)
        #expect(receipt.kind == "payment")
        #expect(receipt.outcome == .ok)
        #expect(receipt.taskID == "task_9")
        #expect(receipt.merchant == "Lindqvist")
        #expect(receipt.amount == "240.00")
        // Merchant and amount are lifted out; the rest are sorted by key, and numbers become text.
        #expect(receipt.references == [ReceiptReference(key: "a", value: "3"), ReceiptReference(key: "invoice", value: "INV-2041")])
    }

    @Test func firstPageSendsNoCursor() async throws {
        let seen = Recorder()
        let (backend, _) = try await live { g in
            g.on("receipts.list") { req in
                seen.record(req.params)
                return .success(.object(["receipts": .array([]), "nextCursor": .null]))
            }
        }
        let page = try await backend.receipts(cursor: nil)
        #expect(seen.last?["cursor"] == nil)
        #expect(page.nextCursor == nil)
        #expect(page.receipts.isEmpty)
    }

    @Test func receiptGetReadsTheReceiptKey() async throws {
        let seen = Recorder()
        let (backend, _) = try await live { g in
            g.on("receipts.get") { req in
                seen.record(req.params)
                return .success(.object(["receipt": .object([
                    "id": "rcpt_2", "kind": "email.send", "summary": "Sent it", "outcome": "failed",
                    "taskId": .null, "createdAt": "2026-11-23T10:14:00.000Z", "externalRefs": .object([:]), "payload": .null,
                ])]))
            }
        }
        let receipt = try await backend.receipt(id: "rcpt_2")
        #expect(seen.last?["receiptId"]?.stringValue == "rcpt_2")
        #expect(receipt.outcome == .failed)
        #expect(receipt.taskID == nil)
        #expect(receipt.merchant == nil)
    }

    @Test func artifactReadSendsTheVersionOnlyWhenAsked() async throws {
        let seen = Recorder()
        let (backend, _) = try await live { g in
            g.on("artifacts.read") { req in
                seen.record(req.params)
                return .success(.object([
                    "artifactId": "art_q3", "version": .number(2), "type": "html", "content": "<h1>Q3</h1>", "totalLines": .number(1),
                ]))
            }
        }
        let latest = try await backend.artifactContent(id: "art_q3", version: nil)
        #expect(seen.last?["version"] == nil)
        #expect(latest.version == 2)
        #expect(latest.type == "html")
        _ = try await backend.artifactContent(id: "art_q3", version: 1)
        #expect(seen.last?["version"]?.int == 1)
    }

    @Test func artifactsListMapsTitlesAndCursor() async throws {
        let (backend, _) = try await live { g in
            g.on("artifacts.list") { _ in
                .success(.object([
                    "artifacts": .array([.object([
                        "id": "art_q3", "libraryItemId": "lib_q3", "type": "html", "title": "Q3 review", "version": .number(2),
                        "nameSlug": "q3-review", "sourceRef": .null, "updatedAt": "2026-11-23T10:20:00.000Z",
                    ])]),
                    "nextCursor": .null,
                ]))
            }
        }
        let page = try await backend.artifacts(cursor: nil)
        #expect(page.artifacts.map(\.title) == ["Q3 review"])
        #expect(page.artifacts.first?.version == 2)
        #expect(page.artifacts.first?.isHTML == true)
        #expect(page.nextCursor == nil)
    }

    @Test func versionsKeepTheRestoreSource() async throws {
        let (backend, _) = try await live { g in
            g.on("artifacts.versions") { _ in
                .success(.object(["versions": .array([
                    .object(["artifactId": "art_q3", "version": .number(1), "author": "agent", "kind": "snapshot", "bytes": .number(10),
                             "hash": "h1", "summary": "First draft", "runId": .null, "toolCallId": .null,
                             "createdAt": "2026-11-23T10:12:00.000Z"]),
                    .object(["artifactId": "art_q3", "version": .number(3), "author": "user", "kind": "snapshot", "bytes": .number(12),
                             "hash": "h3", "summary": "Back to draft one", "runId": .null, "toolCallId": .null,
                             "restoredFrom": .number(1), "createdAt": "2026-11-23T10:30:00.000Z"]),
                ])]))
            }
        }
        let versions = try await backend.artifactVersions(id: "art_q3")
        #expect(versions.map(\.version) == [1, 3])
        #expect(versions[0].restoredFrom == nil)
        #expect(versions[1].restoredFrom == 1)
        #expect(versions[1].author == "user")
    }

    @Test func restoreSendsBothIdsAndReturnsTheNewLatest() async throws {
        let seen = Recorder()
        let (backend, _) = try await live { g in
            g.on("artifacts.restore") { req in
                seen.record(req.params)
                return .success(.object([
                    "artifact": .object(["id": "art_q3"]),
                    "ref": .object(["artifactId": "art_q3", "version": .number(3), "type": "html", "title": "Q3", "bytes": .number(1),
                                    "hash": "h", "summary": "restored"]),
                ]))
            }
        }
        let latest = try await backend.restoreArtifact(id: "art_q3", version: 1)
        #expect(latest == 3)
        #expect(seen.last?["artifactId"]?.stringValue == "art_q3")
        #expect(seen.last?["version"]?.int == 1)
    }
}

/// Keeps the params of the last request a fake handler saw.
private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var params: [String: JSONValue]?

    func record(_ value: JSONValue?) {
        lock.lock(); defer { lock.unlock() }
        params = value?.object
    }

    var last: [String: JSONValue]? {
        lock.lock(); defer { lock.unlock() }
        return params
    }
}
