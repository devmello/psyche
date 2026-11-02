import Foundation
import PsycheProtocol

/// Pure rules for `ocr.recognize` (roadmap §3.4): which files and which PDF pages are read, and how
/// the text is tidied. No Vision here, so everything is unit-tested without a model.
public enum OCRPolicy {
    public static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "heic", "heif", "tiff", "tif", "gif", "webp", "bmp"]
    /// A PDF page whose text layer is shorter than this is an image-only page.
    public static let defaultMinTextChars = 30
    public static let defaultMaxPages = 20
    public static let maxPagesPerCall = 20
    public static let defaultMaxFileBytes = 25 * 1024 * 1024
    /// Pages of a PDF whose text layer is looked at in one call (reading a layer is cheap, recognising is not).
    public static let maxScannedPages = 200
    public static let maxPageChars = 20_000

    public enum Kind: Equatable, Sendable { case image, pdf }

    public static func kind(ofExtension ext: String) -> Kind? {
        let e = ext.lowercased()
        if e == "pdf" { return .pdf }
        return imageExtensions.contains(e) ? .image : nil
    }

    /// Why a path may not be read, or the kind of file it is. Symlinks, directories and special files
    /// are refused (the Gateway only sends paths inside folders the owner granted; this is the
    /// helper's own backstop), as are files over the size cap.
    public static func check(path: String, maxBytes: Int?, fileManager: FileManager = .default) -> (kind: Kind?, refusal: OcrRefusal?) {
        guard path.hasPrefix("/") else { return (nil, .notAFile) }
        guard let kind = kind(ofExtension: (path as NSString).pathExtension) else { return (nil, .unsupportedType) }
        guard let attrs = try? fileManager.attributesOfItem(atPath: path),
              attrs[.type] as? FileAttributeType == .typeRegular
        else { return (nil, .notAFile) }
        let cap = min(maxBytes ?? defaultMaxFileBytes, defaultMaxFileBytes)
        if let size = (attrs[.size] as? NSNumber)?.intValue, size > cap { return (nil, .tooLarge) }
        return (kind, nil)
    }

    /// The pages to recognise, from the text-layer length of each page (index 0 = page 1): pages that
    /// are at least `from`, in `only` when given, with a text layer shorter than `minChars`, at most
    /// `maxPages`. `next` is where a later call continues when the cap or the scan limit stopped this one.
    public static func pagesToRecognize(textLengths: [Int], from: Int = 1, only: [Int]? = nil, minChars: Int = defaultMinTextChars,
                                        maxPages: Int = defaultMaxPages) -> (pages: [Int], next: Int?) {
        let cap = max(1, min(maxPages, maxPagesPerCall))
        let allowed = only.map(Set.init)
        var picked: [Int] = []
        var page = max(1, from)
        var scanned = 0
        while page <= textLengths.count {
            if scanned >= maxScannedPages { return (picked, page) }
            scanned += 1
            if allowed?.contains(page) ?? true, textLengths[page - 1] < minChars {
                if picked.count >= cap { return (picked, page) }
                picked.append(page)
            }
            page += 1
        }
        return (picked, nil)
    }

    /// Recognised lines → page text: trimmed, blank lines collapsed, capped.
    public static func tidy(_ lines: [String]) -> String {
        var out: [String] = []
        for raw in lines {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            out.append(line)
        }
        let text = out.joined(separator: "\n")
        return text.count > maxPageChars ? String(text.prefix(maxPageChars)) : text
    }

    /// The long side, in pixels, a page or image is scaled to before recognition: sharp enough for
    /// small print, small enough that one page never holds much memory.
    public static let maxPixelSide = 3000
}
