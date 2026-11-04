import CoreGraphics
import CoreText
import Foundation

/// Library's fixture state.
struct LibraryState: Sendable {
    var items = FixtureData.libraryItems
    var counter = 0
    /// Files written for items that have one on the phone (generated at first use, uploads as received).
    var files: [String: URL] = [:]
}

extension FixtureBackend: LibraryBackend {
    public func library(section: LibrarySection) async throws -> [LibraryItem] {
        await pause()
        return libraryState.items.filter { $0.section == section }
    }

    public func libraryItem(id: String) async throws -> LibraryItem {
        await pause()
        guard let item = libraryState.items.first(where: { $0.id == id }) else { throw BackendError.notFound }
        return item
    }

    /// Three items open with Quick Look (two PDFs and an artifact page); the rest say "Open on your Mac".
    public func libraryFile(id: String) async throws -> URL? {
        if let url = libraryState.files[id], FileManager.default.fileExists(atPath: url.path) { return url }
        guard let item = libraryState.items.first(where: { $0.id == id }),
            let url = LibraryFixtureFiles.generate(for: item)
        else { return nil }
        libraryState.files[id] = url
        return url
    }

    public func upload(_ file: UploadFile) async throws -> LibraryItem {
        try await upload(file, progress: { _ in })
    }

    /// Reports progress in a few steps so the upload row moves; the bytes are kept in the caches directory
    /// so an uploaded file opens with Quick Look.
    public func upload(_ file: UploadFile, progress: @escaping @Sendable (Double) -> Void) async throws -> LibraryItem {
        for step in 0...4 {
            progress(Double(step) / 5)
            try await Task.sleep(for: .milliseconds(160))
        }
        libraryState.counter += 1
        let id = "lib_up\(libraryState.counter)"
        let section: LibrarySection = file.contentType.hasPrefix("image/") ? .images : .documents
        let fileType = (file.name as NSString).pathExtension.lowercased()
        let item = LibraryItem(
            id: id, title: file.name, section: section, fileType: fileType,
            detail: "Just now · from this phone", threadID: file.threadID,
            evidence: ["Uploaded", "this phone", "just now"],
            threadTitle: file.threadID.flatMap { thread in chatState.summaries.first { $0.id == thread }?.title })
        if let url = LibraryFixtureFiles.store(file.data, named: file.name, id: id) { libraryState.files[id] = url }
        libraryState.items.insert(item, at: 0)
        progress(1)
        publish(.changed(.library))
        return item
    }

    public func deleteLibraryItem(id: String) async throws {
        libraryState.items.removeAll { $0.id == id }
        libraryState.files[id] = nil
        publish(.changed(.library))
    }
}

/// Small real files for Quick Look, written into the caches directory at first use. Core Graphics and
/// Core Text only, so the store stays UI-free and macOS-testable.
enum LibraryFixtureFiles {
    static var directory: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appending(path: "psyche-fixture-library", directoryHint: .isDirectory)
    }

    static func store(_ data: Data, named name: String, id: String) -> URL? {
        let folder = directory.appending(path: id, directoryHint: .isDirectory)
        let url = folder.appending(path: name.replacingOccurrences(of: "/", with: "-"))
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try data.write(to: url)
            return url
        } catch { return nil }
    }

    static func generate(for item: LibraryItem) -> URL? {
        let folder = directory.appending(path: item.id, directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appending(path: item.title.hasSuffix(".\(item.fileType)") ? item.title : "\(item.title).\(item.fileType)")
        if FileManager.default.fileExists(atPath: url.path) { return url }
        switch item.id {
        case "lib_91c0":
            return writePDF(
                to: url, title: "Q3 review", pages: [
                    "Revenue landed at 104% of plan. The two misses are both timing: the Acme renewal slipped a week and the annual prepay for Northwind arrives in October.",
                    "Costs are flat. Contractor spend fell by a third after the migration finished, and the new tooling is within budget.",
                    "Next quarter: three hires, one pricing change, and the lease question on the Mission Street office.",
                ])
        case "lib_77c1":
            return writePDF(
                to: url, title: "PG&E statement, October", pages: [
                    "Amount due: $142.18, due November 14. Usage was 8% lower than September. The rate change on page 2 takes effect with the next cycle."
                ])
        case "lib_art1":
            let html = """
                <!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
                <body style="font:17px -apple-system;margin:32px;color:#21201f">
                <h1 style="font-family:ui-serif">Kitchen budget</h1>
                <p>Cabinets $4,200 · Counter $3,100 · Labor $2,800 · Contingency $1,000</p>
                <p><b>Total $11,100</b>, $900 under the cap.</p></body>
                """
            return (try? html.write(to: url, atomically: true, encoding: .utf8)) != nil ? url : nil
        default:
            return nil
        }
    }

    private static func writePDF(to url: URL, title: String, pages: [String]) -> URL? {
        var box = CGRect(x: 0, y: 0, width: 612, height: 792)
        guard let context = CGContext(url as CFURL, mediaBox: &box, nil) else { return nil }
        let titleFont = CTFontCreateWithName("Times-Bold" as CFString, 26, nil)
        let bodyFont = CTFontCreateWithName("Helvetica" as CFString, 13, nil)
        let key = NSAttributedString.Key(kCTFontAttributeName as String)
        for (index, text) in pages.enumerated() {
            context.beginPDFPage(nil)
            let heading = NSAttributedString(string: index == 0 ? title : "\(title), continued", attributes: [key: titleFont])
            context.textPosition = CGPoint(x: 64, y: 792 - 96)
            CTLineDraw(CTLineCreateWithAttributedString(heading), context)
            let body = NSAttributedString(string: text, attributes: [key: bodyFont])
            let framesetter = CTFramesetterCreateWithAttributedString(body)
            let path = CGPath(rect: CGRect(x: 64, y: 96, width: 484, height: 792 - 96 - 130), transform: nil)
            CTFrameDraw(CTFramesetterCreateFrame(framesetter, CFRange(location: 0, length: 0), path, nil), context)
            context.endPDFPage()
        }
        context.closePDF()
        return url
    }
}

extension FixtureData {

    public static let libraryItems: [LibraryItem] = [
        LibraryItem(id: "lib_8f2a", title: "Q3-review-v4.key", section: .documents, fileType: "key", detail: "Monday 10:14 · 18 slides", threadID: "thr_q3", evidence: ["Made for", "Q3 review", "Mon 10:14"], threadTitle: "Q3 review"),
        LibraryItem(id: "lib_91c0", title: "Q3-review-final.pdf", section: .documents, fileType: "pdf", detail: "Monday 16:52 · 21 pages", threadID: "thr_q3", evidence: ["Exported from", "Q3-review-v4.key", "Mon 16:52"], threadTitle: "Q3 review"),
        LibraryItem(id: "lib_lease", title: "lease-2026.pdf", section: .documents, fileType: "pdf", detail: "Oct 28 · 9 pages", threadID: "thr_lease", evidence: ["Read for", "Lease renewal questions", "Oct 28"], threadTitle: "Lease renewal questions"),
        LibraryItem(id: "lib_77c1", title: "PG&E statement, October", section: .documents, fileType: "pdf", detail: "Today 08:58 · 2 pages", evidence: ["Because", "mail", "Today 08:58"]),
        LibraryItem(id: "lib_img1", title: "Quartz sample.jpg", section: .images, fileType: "jpg", detail: "Oct 30", evidence: ["Uploaded", "this phone", "Oct 30"]),
        LibraryItem(id: "lib_img2", title: "Receipt, hardware store.png", section: .images, fileType: "png", detail: "Oct 27", evidence: ["Uploaded", "this phone", "Oct 27"]),
        LibraryItem(id: "lib_art1", title: "Kitchen budget", section: .artifacts, fileType: "html", detail: "Built for you · Oct 30", evidence: ["Made by", "Psyche", "Oct 30"]),
        LibraryItem(id: "lib_dl1", title: "renters-policy-2026.pdf", section: .downloads, fileType: "pdf", detail: "Oct 12 · 14 pages", evidence: ["Fetched from", "state-farm.com", "Oct 12"]),
    ]
}
