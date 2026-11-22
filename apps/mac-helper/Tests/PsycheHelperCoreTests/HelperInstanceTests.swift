import Foundation
import PsycheHelperCore
import Testing

private final class Flag: @unchecked Sendable {
    var count = 0
}

@Suite("bundled helper: single instance, bundle replacement, signing kind")
struct HelperInstanceTests {
    private func tempDir() throws -> String {
        let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("psyche-instance-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir
    }

    @Test func secondCopyFindsTheLockTaken() throws {
        let dir = try tempDir()
        let path = (dir as NSString).appendingPathComponent("run/helper.lock")
        let first = try #require(SingleInstanceLock.acquire(path: path))
        #expect(SingleInstanceLock.acquire(path: path) == nil)
        first.release()
        let again = try #require(SingleInstanceLock.acquire(path: path))
        again.release()
        #expect(SingleInstanceLock.path(environment: ["PSYCHE_HOME": "/x"]) == "/x/run/helper.lock")
    }

    @Test func replacingOrRemovingTheExecutableIsNoticedOnce() throws {
        let dir = try tempDir()
        let exe = (dir as NSString).appendingPathComponent("psyche-helper")
        try Data("v1".utf8).write(to: URL(fileURLWithPath: exe))
        let flag = Flag()
        let w = BundleWatcher(executablePath: exe, interval: 3600) { flag.count += 1 }
        #expect(!w.check())
        // Rewriting in place keeps the inode: not an upgrade.
        try Data("v1!".utf8).write(to: URL(fileURLWithPath: exe), options: [])
        // An installer replaces the file (new inode), as ditto / Squirrel do.
        let staged = exe + ".new"
        try Data("v2".utf8).write(to: URL(fileURLWithPath: staged))
        _ = rename(staged, exe)
        #expect(w.check())
        #expect(w.check())
        #expect(flag.count == 1)

        let gone = BundleWatcher(executablePath: staged + "x", interval: 3600) { flag.count += 1 }
        #expect(!gone.check())  // never existed: nothing to compare against
        let w2 = BundleWatcher(executablePath: exe, interval: 3600) { flag.count += 1 }
        try FileManager.default.removeItem(atPath: exe)
        #expect(w2.check() && flag.count == 2)
    }

    @Test func signingKinds() {
        #expect(SigningKind.classify(signed: false, adhoc: false, leafCommonName: nil) == .unsigned)
        #expect(SigningKind.classify(signed: true, adhoc: true, leafCommonName: nil) == .adhoc)
        #expect(SigningKind.classify(signed: true, adhoc: false, leafCommonName: "Developer ID Application: A (TEAM)") == .developerId)
        #expect(SigningKind.classify(signed: true, adhoc: false, leafCommonName: "Apple Development: a@b.c (X)") == .development)
        #expect(SigningKind.developerId.rawValue == "developer_id")
    }
}
