import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

private func makeImage(password: String = "Abcdefgh2345JKLmnpqr") throws -> (URL, String) {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pgi-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let contents: [String: Data] = [
        "Disk.img": Data(repeating: 7, count: 100_000), "AuxiliaryStorage": Data("aux".utf8), "HardwareModel": Data("hw".utf8),
        "bootstrap.json": try JSONEncoder().encode(GuestImage.Bootstrap(username: "psyche", password: password)),
    ]
    var files: [GuestImage.File] = []
    for (name, data) in contents.sorted(by: { $0.key < $1.key }) {
        try data.write(to: dir.appendingPathComponent(name))
        files.append(.init(name: name, bytes: data.count, sha256: GuestImage.sha256(data)))
    }
    let m = GuestImage.Manifest(id: "macos-27.0.1-20261020", guestOS: "27.0.1", diskFormat: "raw", diskGB: 80, username: "psyche",
                                createdAt: "2026-10-20T00:00:00Z", provisioned: true, psycheInstalled: true, permissionsGranted: true, files: files)
    return (dir, try GuestImage.writeManifest(m, to: dir))
}

private func reason(_ body: () throws -> Void) -> String? {
    do { try body(); return nil } catch let e as CapabilityError { return e.reason } catch { return "\(error)" }
}

@Suite("prebuilt guest images (L7): format and verification")
struct GuestImageTests {
    @Test func aWellFormedImageVerifiesAgainstItsPublishedChecksum() throws {
        let (dir, sha) = try makeImage()
        let progress = ProgressBox()
        let m = try GuestImage.verify(dir, expectedManifestSha256: sha) { progress.last = $0 }
        #expect(m.id == "macos-27.0.1-20261020" && m.diskName == "Disk.img")
        #expect(progress.last == 1)
        #expect(reason { _ = try GuestImage.verify(dir, expectedManifestSha256: String(repeating: "0", count: 64)) } == "image_checksum_mismatch")
        #expect(try GuestImage.sha256(file: dir.appendingPathComponent("HardwareModel")) == GuestImage.sha256(Data("hw".utf8)))
    }

    @Test func tamperingIsCaught() throws {
        // One flipped byte in the disk.
        var (dir, _) = try makeImage()
        let h = try FileHandle(forUpdating: dir.appendingPathComponent("Disk.img"))
        try h.seek(toOffset: 500)
        h.write(Data([8]))
        try h.close()
        #expect(reason { _ = try GuestImage.verify(dir, expectedManifestSha256: nil) } == "image_checksum_mismatch")

        // An extra file, a missing file, a symlink in place of a listed file.
        (dir, _) = try makeImage()
        try Data("x".utf8).write(to: dir.appendingPathComponent("MachineIdentifier"))
        #expect(reason { _ = try GuestImage.verify(dir, expectedManifestSha256: nil) } == "image_invalid")
        (dir, _) = try makeImage()
        try FileManager.default.removeItem(at: dir.appendingPathComponent("AuxiliaryStorage"))
        #expect(reason { _ = try GuestImage.verify(dir, expectedManifestSha256: nil) } == "image_invalid")
        (dir, _) = try makeImage()
        let hw = dir.appendingPathComponent("HardwareModel")
        try FileManager.default.removeItem(at: hw)
        try FileManager.default.createSymbolicLink(atPath: hw.path, withDestinationPath: "/etc/hosts")
        #expect(reason { _ = try GuestImage.verify(dir, expectedManifestSha256: nil) } == "image_checksum_mismatch")
    }

    @Test func manifestAndBootstrapRules() throws {
        // A newer format is refused, not guessed at.
        var (dir, _) = try makeImage()
        var m = try JSONDecoder().decode(GuestImage.Manifest.self, from: Data(contentsOf: dir.appendingPathComponent("manifest.json")))
        m.formatVersion = 2
        try GuestImage.writeManifest(m, to: dir)
        #expect(reason { _ = try GuestImage.verify(dir, expectedManifestSha256: nil) } == "image_version_unsupported")
        // A password that is not plain alphanumeric never reaches a guest shell.
        (dir, _) = try makeImage(password: "abc'; rm -rf ~; '1234")
        #expect(reason { _ = try GuestImage.verify(dir, expectedManifestSha256: nil) } == "image_invalid")
        #expect(!GuestImage.Bootstrap.isValidPassword("short1"))
        #expect(GuestImage.Bootstrap.isValidPassword("Abcdefgh2345JKLmnpqr"))
        #expect(GuestImage.isValidId("macos-27.0.1-20261020") && !GuestImage.isValidId("../x") && !GuestImage.isValidId("Mac"))
    }
}

private final class ProgressBox: @unchecked Sendable {
    var last: Double = 0
}
