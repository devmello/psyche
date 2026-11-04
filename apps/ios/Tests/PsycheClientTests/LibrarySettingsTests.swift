import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import struct PsycheProtocol.WireReqFrame
import PsycheStore
import Testing

@testable import PsycheClient

/// Library and Settings over the Gateway (the I6/I7 wiring), against the scripted `FakeGateway`.
struct LibrarySettingsTests {
    final class Requests: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [WireReqFrame] = []
        func add(_ req: WireReqFrame) { lock.withLock { all.append(req) } }
        var frames: [WireReqFrame] { lock.withLock { all } }
    }

    final class Progress: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [Double] = []
        func add(_ value: Double) { lock.withLock { values.append(value) } }
        var all: [Double] { lock.withLock { values } }
    }

    static func wireItem(
        _ id: String, kind: String = "document", name: String = "Q3 review.pdf", mime: String = "application/pdf",
        size: Int = 18_000, origin: String = "agent", threadID: String? = "thr_q3", quarantined: Bool? = nil
    ) -> JSONValue {
        var item: [String: JSONValue] = [
            "id": .string(id), "kind": .string(kind), "name": .string(name), "mime": .string(mime),
            "path": .string("documents/\(name)"), "size": .number(Double(size)), "sha256": "abcdef0123456789",
            "origin": .string(origin), "tags": .array([]), "createdAt": "2030-01-01T10:14:00Z",
        ]
        item["threadId"] = threadID.map { .string($0) } ?? .null
        if let quarantined { item["quarantined"] = .bool(quarantined) }
        return .object(item)
    }

    // MARK: Library

    @Test func listMapsItemsOntoTheSectionAndSkipsQuarantined() async throws {
        let seen = Requests()
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("library.list") { req in
                seen.add(req)
                return .success(.object(["items": .array([
                    Self.wireItem("lib_1"),
                    Self.wireItem("lib_2", name: "scan", mime: "image/png", origin: "upload", threadID: nil),
                    Self.wireItem("lib_3", quarantined: true),
                ])]))
            }
        }
        let items = try await backend.library(section: .documents)
        #expect(seen.frames.first?.params?["kind"]?.stringValue == "document")
        #expect(items.map(\.id) == ["lib_1", "lib_2"])
        #expect(items[0].title == "Q3 review.pdf")
        #expect(items[0].section == .documents)
        #expect(items[0].fileType == "pdf")
        #expect(items[0].threadID == "thr_q3")
        #expect(items[0].detail.hasSuffix("18 KB") || items[0].detail.contains("KB"))
        #expect(items[0].evidence.first == "Made for")
        #expect(items[1].fileType == "png")  // no extension in the name: the mime's subtype
        #expect(items[1].threadID == nil)
        #expect(items[1].evidence.first == "Uploaded")
    }

    @Test func sectionsAskForTheirKind() async throws {
        let kinds = OutboxTests.Sent()
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("library.list") { req in
                kinds.add(req.params?["kind"]?.stringValue ?? "?")
                return .success(.object(["items": .array([])]))
            }
        }
        for section in LibrarySection.allCases { _ = try await backend.library(section: section) }
        #expect(kinds.all == ["document", "image", "artifact", "download"])
    }

    @Test func oneItemGetsItsThreadTitleForTheEvidenceLine() async throws {
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("library.get") { _ in .success(.object(["item": Self.wireItem("lib_1")])) }
            g.on("threads.get") { _ in .success(GatewayBackendTests.thread("thr_q3", title: "Q3 review")) }
        }
        let item = try await backend.libraryItem(id: "lib_1")
        #expect(item.threadTitle == "Q3 review")
        #expect(Array(item.evidence.prefix(2)) == ["Made for", "Q3 review"])
    }

    @Test func uploadSendsAtMost384KBPerChunkAndReportsProgress() async throws {
        let seen = Requests()
        let (backend, h) = try await GatewayBackendTests().live { g in
            g.on("library.upload") { req in
                seen.add(req)
                let final = req.params?["final"]?.bool == true
                var body: [String: JSONValue] = ["uploadId": "up_1", "received": .number(1)]
                if final { body["item"] = Self.wireItem("lib_new", name: "big.bin", mime: "application/octet-stream", origin: "upload") }
                return .success(.object(body))
            }
        }
        let size = 900 * 1024
        let file = UploadFile(name: "big.bin", contentType: "application/octet-stream", data: Data(repeating: 7, count: size), threadID: "thr_1")
        let progress = Progress()
        let item = try await backend.upload(file) { progress.add($0) }

        let chunks = seen.frames
        #expect(chunks.count == 3)  // 384 + 384 + 132 KiB
        let raw = chunks.map { Data(base64Encoded: $0.params?["bytes"]?.stringValue ?? "")?.count ?? -1 }
        #expect(raw == [384 * 1024, 384 * 1024, 132 * 1024])
        #expect(raw.reduce(0, +) == size)
        // Every chunk is under the Gateway's 600 KB (as base64) limit.
        #expect(chunks.allSatisfy { ($0.params?["bytes"]?.stringValue?.utf8.count ?? .max) <= 600 * 1024 })
        // The first chunk names no upload and carries the thread; later ones continue the upload.
        #expect(chunks[0].params?["uploadId"] == nil)
        #expect(chunks[0].params?["threadId"]?.stringValue == "thr_1")
        #expect(chunks[1].params?["uploadId"]?.stringValue == "up_1")
        #expect(chunks[2].params?["uploadId"]?.stringValue == "up_1")
        #expect(chunks.map { $0.params?["final"]?.bool } == [false, false, true])
        #expect(chunks.allSatisfy { $0.params?["name"]?.stringValue == "big.bin" })
        // One idempotency key per chunk, all different.
        let keys = chunks.compactMap(\.idempotencyKey)
        #expect(keys.count == 3 && Set(keys).count == 3)
        #expect(progress.all.first == 0 && progress.all.last == 1)
        #expect(progress.all == progress.all.sorted())
        #expect(item.id == "lib_new" && item.title == "big.bin")
        _ = h
    }

    @Test func aSmallUploadIsOneFinalChunkAndAnnouncesTheChange() async throws {
        let seen = Requests()
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("library.upload") { req in
                seen.add(req)
                return .success(.object(["uploadId": "up_2", "received": .number(5), "item": Self.wireItem("lib_s", name: "a.txt", mime: "text/plain", origin: "upload")]))
            }
        }
        let events = backend.events()
        let changed = Task { () -> Bool in
            for await event in events { if event == .changed(.library) { return true } }
            return false
        }
        _ = try await backend.upload(UploadFile(name: "a.txt", contentType: "text/plain", data: Data("hello".utf8)))
        #expect(seen.frames.count == 1)
        #expect(seen.frames[0].params?["final"]?.bool == true)
        #expect(seen.frames[0].params?["threadId"] == nil)
        let announced = await withTaskGroup(of: Bool.self) { group in
            group.addTask { await changed.value }
            group.addTask { try? await Task.sleep(for: .seconds(2)); changed.cancel(); return false }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
        #expect(announced)
    }

    @Test func emptyAndOversizedFilesAreRefusedBeforeAnythingIsSent() async throws {
        let seen = Requests()
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("library.upload") { req in seen.add(req); return .failure(WireError(code: "internal", message: "no")) }
        }
        await #expect(throws: BackendError.refused("That file is empty.")) {
            try await backend.upload(UploadFile(name: "e", contentType: "", data: Data()))
        }
        await #expect(throws: BackendError.refused("That file is bigger than 25 MB. Add it on your Mac instead.")) {
            try await backend.upload(UploadFile(name: "huge", contentType: "", data: Data(count: 25 * 1024 * 1024 + 1)))
        }
        #expect(seen.frames.isEmpty)
    }

    @Test func uploadAwayFromTheMacThrowsUnreachable() async throws {
        let h = GatewayClientTests.Harness(gateway: FakeGateway())
        try await GatewayClientTests.pairedThenOffline(h)
        let backend = GatewayBackend(client: h.client)
        await #expect(throws: BackendError.unreachable) {
            try await backend.upload(UploadFile(name: "a.txt", contentType: "text/plain", data: Data("hi".utf8)))
        }
    }

    @Test func deleteCallsTheGatewayAndAnnouncesTheChange() async throws {
        let seen = Requests()
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("library.delete") { req in seen.add(req); return .success(.object(["ok": .bool(true)])) }
        }
        let events = backend.events()
        let changed = Task { () -> Bool in
            for await event in events { if event == .changed(.library) { return true } }
            return false
        }
        try await backend.deleteLibraryItem(id: "lib_9")
        #expect(seen.frames.count == 1)
        #expect(seen.frames[0].params?["itemId"]?.stringValue == "lib_9")
        let announced = await withTaskGroup(of: Bool.self) { group in
            group.addTask { await changed.value }
            group.addTask { try? await Task.sleep(for: .seconds(2)); changed.cancel(); return false }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
        #expect(announced)
    }

    @Test func deleteOfAMissingItemIsNotFound() async throws {
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("library.delete") { _ in .failure(WireError(code: "not_found", message: "gone")) }
        }
        await #expect(throws: BackendError.notFound) { try await backend.deleteLibraryItem(id: "nope") }
    }

    @Test func aFileDownloadsInChunksIntoProtectedCaches() async throws {
        let id = "lib_dl_\(UUID().uuidString.prefix(8))"
        let part1 = Data(repeating: 1, count: 512 * 1024)
        let part2 = Data(repeating: 2, count: 1000)
        let reads = Requests()
        let (backend, h) = try await GatewayBackendTests().live { g in
            g.on("library.get") { _ in .success(.object(["item": Self.wireItem(id, size: 513_000)])) }
            g.on("files.read") { req in
                reads.add(req)
                let offset = req.params?["offset"]?.int ?? 0
                if offset == 0 {
                    return .success(.object(["size": .number(513_000), "offset": .number(0), "etag": "e1", "bytes": .string(part1.base64EncodedString()), "nextOffset": .number(Double(part1.count))]))
                }
                return .success(.object(["size": .number(513_000), "offset": .number(Double(offset)), "etag": "e1", "bytes": .string(part2.base64EncodedString()), "nextOffset": .null]))
            }
        }
        let url = try #require(try await backend.libraryFile(id: id))
        #expect(url.lastPathComponent == "Q3 review.pdf")
        #expect(url.path.hasPrefix(h.dir.appendingPathComponent("LibraryCache").path))
        #expect(try Data(contentsOf: url) == part1 + part2)
        #expect(reads.frames.map { $0.params?["libraryPath"]?.stringValue } == ["documents/Q3 review.pdf", "documents/Q3 review.pdf"])
        #expect(reads.frames.map { $0.params?["offset"]?.int } == [0, 512 * 1024])
        // A second open is served from the cache.
        let again = try await backend.libraryFile(id: id)
        #expect(again == url)
        #expect(reads.frames.count == 2)
    }

    @Test func quarantinedAndHugeFilesStayOnTheMac() async throws {
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("library.get") { req in
                switch req.params?["itemId"]?.stringValue {
                case "q": .success(.object(["item": Self.wireItem("q", quarantined: true)]))
                default: .success(.object(["item": Self.wireItem("big", size: 200 * 1024 * 1024)]))
                }
            }
        }
        #expect(try await backend.libraryFile(id: "q") == nil)
        #expect(try await backend.libraryFile(id: "big") == nil)
    }

    // MARK: Settings

    @Test func settingsDefaultThenRoundTripOnThePhone() async throws {
        let (backend, h) = try await GatewayBackendTests().live { _ in }
        let first = try await backend.settings()
        #expect(first == PhoneSettings(notifications: true, liveActivities: true, taskTitlesOnLockScreen: false, faceIDForApprovals: true))
        let changed = PhoneSettings(notifications: false, liveActivities: false, taskTitlesOnLockScreen: true, faceIDForApprovals: false)
        try await backend.updateSettings(changed)
        #expect(try await backend.settings() == changed)
        // A new backend over the same directory (an app relaunch) reads the same file.
        #expect(try await GatewayBackend(client: h.client).settings() == changed)
        // Nothing went to the Gateway.
        #expect(h.gateway.received.allSatisfy { !$0.method.hasPrefix("settings.") })
    }

    @Test func settingsDefaultsFillWhateverTheFileLacks() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("settings-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try Data(#"{"notifications":false}"#.utf8).write(to: dir.appendingPathComponent(PhoneSettingsStore.fileName))
        let loaded = PhoneSettingsStore(directory: dir).load()
        #expect(loaded.notifications == false && loaded.liveActivities == true && loaded.faceIDForApprovals == true)
        try Data("not json".utf8).write(to: dir.appendingPathComponent(PhoneSettingsStore.fileName))
        #expect(PhoneSettingsStore(directory: dir).load() == PhoneSettingsStore.defaults)
    }

    @Test func thisPhoneComesFromThePinnedEndpointAndTheGrantedScopes() async throws {
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("devices.list") { _ in .failure(WireError(code: "forbidden", message: "Needs admin.")) }
        }
        let device = try await backend.device()
        #expect(device.name == "Test iPhone")
        #expect(device.scopes == ["Read"])
        #expect(device.gatewayHost.isEmpty == false)
        #expect(device.gatewayFingerprint.hasPrefix("sha256:"))
        #expect(device.transport == "Home network" || device.transport == "Tailscale")
    }

    @Test func anAdminPhoneReadsItsOwnRecordFromTheDeviceList() async throws {
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("devices.list") { _ in .success(.object(["devices": .array([
                .object(["id": "someone_else", "name": "iPad", "scopes": .array(["operator.read"])]),
                .object(["id": "dev_test", "name": "Dev's iPhone", "scopes": .array(["operator.read", "operator.write", "operator.approvals"])]),
            ])])) }
        }
        let device = try await backend.device()
        #expect(device.name == "Dev's iPhone")
        #expect(device.scopes == ["Read", "Write", "Approvals"])
    }

    // MARK: Remove this phone (devices.revokeSelf)

    @Test func revokeSelfSuccessWipesAndMovesToRevoked() async throws {
        let gateway = FakeGateway()
        let seen = Requests()
        gateway.on("devices.revokeSelf") { req in seen.add(req); return .success(.object(["device": .object([:])])) }
        let h = try await SecurityReviewTests.pairedHarness(gateway)
        let backend = GatewayBackend(client: h.client)
        try await backend.updateSettings(PhoneSettings(notifications: false, liveActivities: true, taskTitlesOnLockScreen: false, faceIDForApprovals: true))
        try await backend.revokeThisPhone()
        #expect(seen.frames.count == 1)
        #expect(seen.frames[0].params?.object?.isEmpty == true)  // it never names a device
        #expect(await h.client.currentState == .revoked)
        #expect(h.endpointStore.load() == nil)
        #expect(h.wiped.isSet)
        #expect(PhoneSettingsStore(directory: h.dir).load() == PhoneSettingsStore.defaults)
    }

    @Test func revokeSelfFailureLeavesThePairingAlone() async throws {
        let gateway = FakeGateway()
        gateway.on("devices.revokeSelf") { _ in .failure(WireError(code: "unauthorized", message: "No.")) }
        let h = try await SecurityReviewTests.pairedHarness(gateway)
        await #expect(throws: BackendError.refused("No.")) { try await GatewayBackend(client: h.client).revokeThisPhone() }
        #expect(h.endpointStore.load() != nil)
        #expect(await h.client.currentState == .live)
        #expect(!h.wiped.isSet)
    }

    @Test func revokeSelfWithTheGatewayUnreachableThrowsTheContractErrorThenALocalWipeIsPossible() async throws {
        let h = GatewayClientTests.Harness(gateway: FakeGateway())
        try await GatewayClientTests.pairedThenOffline(h)
        let backend = GatewayBackend(client: h.client)
        await #expect(throws: BackendError.unreachable) { try await backend.revokeThisPhone() }
        #expect(BackendError.unreachable.errorDescription == "Your Mac isn't reachable right now.")
        #expect(h.endpointStore.load() != nil && !h.wiped.isSet)
        // The owner's separate choice: wipe this phone only, without the Gateway.
        try await backend.removeThisPhoneLocally()
        #expect(await h.client.currentState == .revoked)
        #expect(h.endpointStore.load() == nil)
        #expect(h.wiped.isSet)
        #expect(!h.gateway.received.contains { $0.method == "devices.revokeSelf" })
    }
}
