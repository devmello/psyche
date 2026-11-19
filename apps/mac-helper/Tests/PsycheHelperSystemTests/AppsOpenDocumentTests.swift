import Foundation
import PsycheHelperCore
import PsycheProtocol
@testable import PsycheHelperSystem
import Testing

/// `apps.open` document checks on real files in a temp folder (the review's probes). Only file
/// system reads: nothing is registered with LaunchServices, opened or launched.
@Suite("apps.open documents")
struct AppsOpenDocumentTests {
    let root: URL

    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("psyche-open-\(UUID().uuidString)")
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("X.app/Contents/MacOS"), withIntermediateDirectories: true)
        try Data("<plist/>".utf8).write(to: root.appendingPathComponent("X.app/Contents/Info.plist"))
        try fm.createDirectory(at: root.appendingPathComponent("Disguised.notes/Contents"), withIntermediateDirectories: true)
        try Data("<plist/>".utf8).write(to: root.appendingPathComponent("Disguised.notes/Contents/Info.plist"))
        try fm.createDirectory(at: root.appendingPathComponent("Photos"), withIntermediateDirectories: true)
        try Data("hello".utf8).write(to: root.appendingPathComponent("notes.txt"))
        try Data("%PDF-1.4".utf8).write(to: root.appendingPathComponent("report.pdf"))
        try Data("#!/bin/sh\necho hi\n".utf8).write(to: root.appendingPathComponent("run"))
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.appendingPathComponent("run").path)
        try Data("x".utf8).write(to: root.appendingPathComponent("session.term"))
        try fm.createSymbolicLink(atPath: root.appendingPathComponent("link.txt").path, withDestinationPath: root.appendingPathComponent("X.app").path)
        try fm.createSymbolicLink(atPath: root.appendingPathComponent("tool.txt").path, withDestinationPath: root.appendingPathComponent("run").path)
    }

    private func check(_ url: String) -> (URL?, String?) {
        guard let u = URL(string: url) else { return (nil, "bad url") }
        do {
            return (try AppsCapabilities.checkedDocumentURL(u), nil)
        } catch let e as CapabilityError {
            return (nil, e.reason)
        } catch {
            return (nil, "\(error)")
        }
    }

    private func file(_ rel: String) -> String { root.appendingPathComponent(rel).absoluteString }
    /// The folder's `file:` URL with a trailing slash, for spellings `appendingPathComponent` would fold.
    private var base: String { root.absoluteString.hasSuffix("/") ? root.absoluteString : root.absoluteString + "/" }

    @Test func bundleSuffixTricksAreJudgedAsTheBundle() {
        // Probe: `X.app/.`, `X.app/%2e`, `X.app/%2E/` and `X.app/Contents/..` all name the bundle.
        for suffix in ["X.app/.", "X.app/%2e", "X.app/%2E/", "X.app/Contents/..", "X.app/Contents/MacOS/../.."] {
            #expect(check(base + suffix).1 == "executable_document", "\(suffix)")
        }
        // A bundle-shaped folder whose name says nothing.
        #expect(check(file("Disguised.notes")).1 == "executable_document")
    }

    @Test func symlinksAreJudgedByTheirTarget() {
        // Probe: `link.txt -> X.app` and `tool.txt -> run` (an executable).
        #expect(check(file("link.txt")).1 == "executable_document")
        #expect(check(file("tool.txt")).1 == "executable_document")
    }

    @Test func executablesAndSessionFilesAreRefused() {
        #expect(check(file("run")).1 == "executable_document")
        #expect(check(file("session.term")).1 == "executable_document")
        #expect(check(file("missing.pdf")).1 == "document_not_found")
    }

    @Test func plainDocumentsOpenFromTheirResolvedPath() throws {
        let (pdf, why) = check(file("report.pdf"))
        #expect(why == nil)
        #expect(pdf?.path == AppLaunchPolicy.canonical(root.appendingPathComponent("report.pdf")))
        #expect(check(file("notes.txt")).1 == nil)
        #expect(check(file("Photos")).1 == nil)
        // `.` segments resolve before the check, and the resolved URL is what opens.
        let (dotted, _) = check(base + "Photos/../notes.txt")
        #expect(dotted?.lastPathComponent == "notes.txt")
    }
}
