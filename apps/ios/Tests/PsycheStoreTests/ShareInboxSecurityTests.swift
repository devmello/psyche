import Foundation
import PsycheShared
import Testing

@testable import PsycheStore

struct ShareInboxSecurityTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "inbox-sec-\(UUID().uuidString)", directoryHint: .isDirectory)

    @Test func awayFromTheMacDoesNotUseUpAnAttempt() async throws {
        let inbox = ShareInbox(root: root)
        defer { try? FileManager.default.removeItem(at: root) }
        try inbox.enqueue(ShareDraft(destination: .newChat, note: "later"))
        for _ in 0..<(ShareInbox.maxAttempts + 3) {
            _ = await inbox.drain(countsAsAttempt: ShareInboxDrain.countsAsAttempt) { _ in throw BackendError.unreachable }
        }
        #expect(inbox.pending().count == 1)
        #expect(inbox.pending().first?.attempts == 0)
        // A real failure still counts, and the item is dropped at the limit.
        for _ in 0..<ShareInbox.maxAttempts {
            _ = await inbox.drain(countsAsAttempt: ShareInboxDrain.countsAsAttempt) { _ in throw BackendError.refused("no") }
        }
        #expect(inbox.pending().isEmpty)
    }

    @Test func offlineErrorsAreNotCountedButOthersAre() {
        #expect(!ShareInboxDrain.countsAsAttempt(BackendError.unreachable))
        #expect(!ShareInboxDrain.countsAsAttempt(URLError(.notConnectedToInternet)))
        #expect(ShareInboxDrain.countsAsAttempt(BackendError.refused("x")))
        #expect(ShareInboxDrain.countsAsAttempt(BackendError.notFound))
    }

    @Test func wipeRemovesItemsFilesAndRecents() throws {
        let inbox = ShareInbox(root: root)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = FileManager.default.temporaryDirectory.appending(path: "s-\(UUID().uuidString).txt")
        try Data("x".utf8).write(to: file)
        try inbox.enqueue(ShareDraft(destination: .newChat, note: "n", files: [(file, "s.txt", "text/plain")]))
        inbox.writeRecents([ShareThreadChoice(id: "t", title: "T")])
        #expect(!inbox.pending().isEmpty && !inbox.recents().isEmpty)
        inbox.wipe()
        #expect(inbox.pending().isEmpty)
        #expect(inbox.recents().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: root.path))
    }

    @Test func theInboxIsKeptOutOfBackups() throws {
        let inbox = ShareInbox(root: root)
        defer { try? FileManager.default.removeItem(at: root) }
        try inbox.enqueue(ShareDraft(destination: .newChat, note: "n"))
        let values = try root.resourceValues(forKeys: [.isExcludedFromBackupKey])
        #expect(values.isExcludedFromBackup == true)
    }

    @Test func theDataDirectoryIsKeptOutOfBackups() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "data-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: dir) }
        try EndpointStore(directory: dir).save(GatewayEndpoint(host: "h", fingerprint: "A", transport: .lan, url: "https://h.local"))
        #expect(try dir.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    }
}
