import Foundation

/// Holds the bytes of a file that waits for the Mac in a temp file, so the composer keeps a URL rather than up to
/// 25 MB of image data per attachment (five photos can reach about 125 MB). The file goes once the upload succeeds,
/// the owner removes the chip, or the next launch finds it as a leftover.
struct WaitingPayloadStore: Sendable {
    let directory: URL

    static let standard = WaitingPayloadStore(
        directory: FileManager.default.temporaryDirectory.appending(path: "psyche-waiting-uploads", directoryHint: .isDirectory))

    /// Writes the bytes to a new file and returns its URL.
    func save(_ data: Data) throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appending(path: UUID().uuidString, directoryHint: .notDirectory)
        try data.write(to: url, options: .atomic)
        return url
    }

    /// The bytes, or nil when the file is gone (the system may purge temp files).
    func load(_ url: URL) -> Data? {
        try? Data(contentsOf: url)
    }

    func delete(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    /// Removes every file of an earlier launch. Only call it before any composer has saved a file.
    func sweepLeftovers() {
        try? FileManager.default.removeItem(at: directory)
    }
}
