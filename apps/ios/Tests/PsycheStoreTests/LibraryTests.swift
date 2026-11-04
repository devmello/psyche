import Foundation
import PsycheShared
import Testing

@testable import PsycheStore

struct ShareInboxTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "share-inbox-\(UUID().uuidString)")

    private func sampleFile(_ name: String, _ text: String = "hello") throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appending(path: name)
        try text.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    @Test func enqueueCopiesFilesAndKeepsTheNote() throws {
        let inbox = ShareInbox(root: root)
        let source = try sampleFile("lease.pdf", "pdf bytes")
        let item = try inbox.enqueue(
            ShareDraft(destination: .thread(id: "thr_lease"), note: "Is clause 4 normal?", files: [(source, "lease.pdf", "application/pdf")]))
        let pending = inbox.pending()
        #expect(pending.map(\.id) == [item.id])
        #expect(pending[0].note == "Is clause 4 normal?")
        #expect(pending[0].destination == .thread(id: "thr_lease"))
        let copy = inbox.fileURL(pending[0].files[0], in: pending[0])
        #expect(try String(contentsOf: copy, encoding: .utf8) == "pdf bytes")
        #expect(source != copy)
    }

    @Test func drainsOldestFirstAndOnlyOnce() async throws {
        let inbox = ShareInbox(root: root)
        let base = Date(timeIntervalSince1970: 1_000)
        for (index, note) in ["first", "second", "third"].enumerated() {
            try inbox.enqueue(ShareDraft(destination: .newChat, note: note), now: base.addingTimeInterval(Double(index)))
        }
        // Enqueued out of order on disk (directory names are random); the queue still comes back by time.
        var seen: [String] = []
        let first = await inbox.drain { seen.append($0.note) }
        #expect(first == .drained(count: 3))
        #expect(seen == ["first", "second", "third"])
        let second = await inbox.drain { seen.append($0.note) }
        #expect(second == .drained(count: 0))
        #expect(seen.count == 3)
        #expect(inbox.pending().isEmpty)
    }

    @Test func aFailureKeepsTheItemAndTheOrder() async throws {
        let inbox = ShareInbox(root: root)
        let base = Date(timeIntervalSince1970: 2_000)
        for (index, note) in ["a", "b"].enumerated() {
            try inbox.enqueue(ShareDraft(destination: .newChat, note: note), now: base.addingTimeInterval(Double(index)))
        }
        let stopped = await inbox.drain { _ in throw BackendError.unreachable }
        #expect(stopped == .stopped(done: 0, remaining: 2))
        #expect(inbox.pending().map(\.note) == ["a", "b"])
        #expect(inbox.pending()[0].attempts == 1)
        var seen: [String] = []
        _ = await inbox.drain { seen.append($0.note) }
        #expect(seen == ["a", "b"])
    }

    @Test func anItemThatKeepsFailingIsDropped() async throws {
        let inbox = ShareInbox(root: root)
        try inbox.enqueue(ShareDraft(destination: .newChat, note: "bad"))
        for _ in 0..<ShareInbox.maxAttempts { _ = await inbox.drain { _ in throw BackendError.refused("no") } }
        #expect(inbox.pending().isEmpty)
    }

    @Test func recentsRoundTripAndNothingToShareIsRefused() throws {
        let inbox = ShareInbox(root: root)
        #expect(inbox.recents().isEmpty)
        inbox.writeRecents([ShareThreadChoice(id: "t1", title: "Q3 review")])
        #expect(inbox.recents() == [ShareThreadChoice(id: "t1", title: "Q3 review")])
        #expect(throws: ShareInboxError.nothingToShare) { try inbox.enqueue(ShareDraft(destination: .newChat)) }
        // The recents file sits next to the items without being mistaken for one.
        #expect(inbox.pending().isEmpty)
    }

    @Test func sharedTextAndLinksGoInTheMessage() async throws {
        let item = ShareInboxItem(
            id: "x", createdAt: .now, destination: .newChat, note: "Worth reading?", text: "https://example.com/a", files: [], attempts: 0)
        #expect(item.messageText == "Worth reading?\n\nhttps://example.com/a")
        let bare = ShareInboxItem(
            id: "y", createdAt: .now, destination: .newChat, note: "", text: "", files: [SharedFile(name: "a", contentType: "x/y", path: "files/a")], attempts: 0)
        #expect(bare.messageText == "Shared from my iPhone.")
    }

    @Test func drainUploadsIntoTheChosenThreadThenSendsTheNote() async throws {
        let inbox = ShareInbox(root: root)
        let backend = FixtureBackend()
        let source = try sampleFile("notes.txt", "remember the milk")
        try inbox.enqueue(
            ShareDraft(destination: .thread(id: "thr_bills"), note: "File this", files: [(source, "notes.txt", "text/plain")]))
        let result = await ShareInboxDrain.run(inbox: inbox, backend: backend)
        #expect(result == .drained(count: 1))
        let uploaded = try await backend.library(section: .documents).first { $0.title == "notes.txt" }
        #expect(uploaded?.threadID == "thr_bills")
        let thread = try await backend.thread(id: "thr_bills")
        #expect(thread.items.contains { if case .user(_, let text) = $0 { text == "File this" } else { false } })
    }

    @Test func newChatOpensAThread() async throws {
        let inbox = ShareInbox(root: root)
        let backend = FixtureBackend()
        try inbox.enqueue(ShareDraft(destination: .newChat, note: "Look at this", text: "https://example.com"))
        _ = await ShareInboxDrain.run(inbox: inbox, backend: backend)
        let threads = try await backend.threads()
        #expect(threads.contains { $0.title == "New chat" })
    }
}

struct LibraryFixtureTests {
    let store = FixtureBackend()

    @Test func uploadReportsProgressAndLandsFirst() async throws {
        let log = ProgressLog()
        let item = try await store.upload(UploadFile(name: "scan.pdf", contentType: "application/pdf", data: Data("x".utf8), threadID: "thr_q3")) {
            log.add($0)
        }
        let values = log.values
        #expect(values.first == 0 && values.last == 1)
        #expect(values == values.sorted())
        #expect(item.threadTitle == "Q3 review")
        let documents = try await store.library(section: .documents)
        #expect(documents.first?.id == item.id)
        #expect(try await store.libraryItem(id: item.id).title == "scan.pdf")
        let file = try #require(try await store.libraryFile(id: item.id))
        #expect(try Data(contentsOf: file) == Data("x".utf8))
    }

    @Test func imagesGoToImagesAndDeleteRemovesTheItem() async throws {
        let item = try await store.upload(UploadFile(name: "p.jpg", contentType: "image/jpeg", data: Data()))
        #expect(item.section == .images)
        try await store.deleteLibraryItem(id: item.id)
        await #expect(throws: BackendError.notFound) { try await store.libraryItem(id: item.id) }
    }

    @Test func someFilesOpenLocallyAndOthersDoNot() async throws {
        let pdf = try #require(try await store.libraryFile(id: "lib_91c0"))
        #expect(FileManager.default.fileExists(atPath: pdf.path))
        #expect(pdf.pathExtension == "pdf")
        #expect(try Data(contentsOf: pdf).prefix(4) == Data("%PDF".utf8))
        #expect(try await store.libraryFile(id: "lib_lease") == nil)
    }

    @Test func changesAreAnnounced() async throws {
        var events = store.events().makeAsyncIterator()
        try await Task.sleep(for: .milliseconds(50))
        try await store.deleteLibraryItem(id: "lib_dl1")
        #expect(await events.next() == .changed(.library))
    }
}

private final class ProgressLog: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [Double] = []
    func add(_ value: Double) { lock.lock(); stored.append(value); lock.unlock() }
    var values: [Double] { lock.lock(); defer { lock.unlock() }; return stored }
}
