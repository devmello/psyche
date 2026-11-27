import Foundation

import Testing

@testable import PsycheFeatures

/// The temp files that hold an attachment's bytes while it waits for the Mac: written, read, deleted, and swept on launch.
struct WaitingPayloadStoreTests {
    private func scratch() -> WaitingPayloadStore {
        WaitingPayloadStore(directory: FileManager.default.temporaryDirectory
            .appending(path: "psyche-waiting-tests-\(UUID().uuidString)", directoryHint: .isDirectory))
    }

    @Test func aWaitingFileHoldsTheBytesUntilItIsDeleted() throws {
        let store = scratch()
        let bytes = Data((0..<4096).map { UInt8($0 % 251) })
        let url = try store.save(bytes)
        #expect(FileManager.default.fileExists(atPath: url.path))
        #expect(store.load(url) == bytes)
        store.delete(url)
        #expect(!FileManager.default.fileExists(atPath: url.path))
        #expect(store.load(url) == nil)
        store.sweepLeftovers()
    }

    @Test func eachWaitingFileGetsItsOwnURL() throws {
        let store = scratch()
        let first = try store.save(Data([1]))
        let second = try store.save(Data([2]))
        #expect(first != second)
        // Positive control: deleting one leaves the other intact.
        store.delete(first)
        #expect(store.load(second) == Data([2]))
        store.sweepLeftovers()
    }

    /// A launch removes what an earlier launch left, and a second sweep on an empty folder is harmless.
    @Test func aLaunchSweepRemovesLeftoversAndIsSafeWhenEmpty() throws {
        let store = scratch()
        let leftover = try store.save(Data([9, 9]))
        store.sweepLeftovers()
        #expect(store.load(leftover) == nil)
        #expect(!FileManager.default.fileExists(atPath: store.directory.path))
        store.sweepLeftovers()
        // Positive control: after the sweep a new save works again.
        let fresh = try store.save(Data([7]))
        #expect(store.load(fresh) == Data([7]))
        store.sweepLeftovers()
    }
}
