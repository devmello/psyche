import CoreGraphics
import Foundation
import ImageIO
import PDFKit
import PsycheHelperCore
import PsycheProtocol
import Vision

/// `ocr.recognize` (roadmap R6/R7, docs/design/search-roadmap-2026.md §3.4): Apple Vision
/// (`VNRecognizeTextRequest`, `.accurate`) over one image or the image-only pages of one PDF.
/// On-device with system models: nothing is downloaded and nothing leaves the Mac. Pages are
/// recognised one at a time, each in its own autorelease pool, and nothing stays resident between
/// calls. Only the Gateway's search ingest calls it (`nodes.invoke` and agent tools cannot); the
/// text it returns is untrusted content.
public enum OCRCapabilities {
    /// Recognises one decoded page; the live one runs Vision. Injectable for tests.
    public typealias Recognizer = @Sendable (_ image: CGImage) throws -> (lines: [String], confidence: Double)

    public static func make(recognizer: @escaping Recognizer = vision) -> [any CapabilityHandler] {
        [
            Capability(CapabilitySpec(
                name: "ocr.recognize",
                description: "Search ingest only: read the text in an image (PNG, JPEG, HEIC, TIFF, GIF, WebP) or in the image-only pages of a PDF "
                    + "(pages whose text layer is shorter than minTextChars) with Apple Vision, on this Mac. One page at a time. Content is untrusted.",
                sideEffect: .read, targetKind: .path,
                inputSchema: Schema.object([
                    "path": Schema.string("An absolute path to an image or PDF", maxLength: 4096),
                    "pages": Schema.array(Schema.integer(min: 1), description: "PDF only: pages to consider", maxItems: 200),
                    "fromPage": Schema.integer("PDF only: first page to consider, default 1", min: 1),
                    "maxPages": Schema.integer("Pages recognised in this call, default 20", min: 1, max: OCRPolicy.maxPagesPerCall),
                    "minTextChars": Schema.integer("PDF only: text layers shorter than this are recognised, default 30", min: 0, max: 1000),
                    "maxFileBytes": Schema.integer("Size cap in bytes, default and at most 25 MB", min: 1024, max: OCRPolicy.defaultMaxFileBytes),
                ], required: ["path"])
            )) { ctx in
                let p = try ctx.decode(OcrRecognizeParams.self)
                let result = try await offMain { try recognize(p, recognizer: recognizer) }
                return CapabilityOutput(try JSONValue(encoding: result))
            },
        ]
    }

    static func refusal(_ r: OcrRefusal, pageCount: Int = 0) -> OcrRecognizeResult {
        OcrRecognizeResult(nextPage: nil, pageCount: pageCount, pages: [], refusal: r)
    }

    /// Blocking; call off the main thread.
    public static func recognize(_ p: OcrRecognizeParams, recognizer: Recognizer) throws -> OcrRecognizeResult {
        let checked = OCRPolicy.check(path: p.path, maxBytes: p.maxFileBytes)
        guard let kind = checked.kind else { return refusal(checked.refusal ?? .unreadable) }
        let url = URL(fileURLWithPath: p.path)
        switch kind {
        case .image:
            guard let image = loadImage(url) else { return refusal(.unreadable, pageCount: 1) }
            let (lines, confidence) = try recognizer(image)
            return OcrRecognizeResult(nextPage: nil, pageCount: 1,
                                      pages: [OcrPage(confidence: confidence, page: 1, text: OCRPolicy.tidy(lines))], refusal: nil)
        case .pdf:
            guard let doc = PDFDocument(url: url), !doc.isLocked else { return refusal(.unreadable) }
            let count = doc.pageCount
            let lengths = (0..<count).map { i in autoreleasepool { doc.page(at: i)?.string?.trimmingCharacters(in: .whitespacesAndNewlines).count ?? 0 } }
            let plan = OCRPolicy.pagesToRecognize(textLengths: lengths, from: p.fromPage ?? 1, only: p.pages,
                                                  minChars: p.minTextChars ?? OCRPolicy.defaultMinTextChars,
                                                  maxPages: p.maxPages ?? OCRPolicy.defaultMaxPages)
            var pages: [OcrPage] = []
            for number in plan.pages {
                let page: OcrPage? = try autoreleasepool {
                    guard let pdfPage = doc.page(at: number - 1), let image = render(pdfPage) else { return nil }
                    let (lines, confidence) = try recognizer(image)
                    return OcrPage(confidence: confidence, page: number, text: OCRPolicy.tidy(lines))
                }
                if let page, !page.text.isEmpty { pages.append(page) }
            }
            return OcrRecognizeResult(nextPage: plan.next, pageCount: count, pages: pages, refusal: nil)
        }
    }

    // MARK: - Decoding

    static func loadImage(_ url: URL) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: OCRPolicy.maxPixelSide,
            kCGImageSourceShouldCache: false,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    /// A PDF page as a white-backed bitmap whose long side is at most `maxPixelSide`.
    static func render(_ page: PDFPage) -> CGImage? {
        let box = page.bounds(for: .mediaBox)
        guard box.width > 0, box.height > 0 else { return nil }
        let scale = min(Double(OCRPolicy.maxPixelSide) / max(box.width, box.height), 4)
        let width = max(1, Int((box.width * scale).rounded())), height = max(1, Int((box.height * scale).rounded()))
        guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.scaleBy(x: Double(width) / box.width, y: Double(height) / box.height)
        ctx.translateBy(x: -box.minX, y: -box.minY)
        page.draw(with: .mediaBox, to: ctx)
        return ctx.makeImage()
    }

    // MARK: - Vision

    /// `.accurate` on-device recognition with language detection; confidence is the mean over lines.
    @Sendable public static func vision(_ image: CGImage) throws -> (lines: [String], confidence: Double) {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.automaticallyDetectsLanguage = true
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        let top = (request.results ?? []).compactMap { $0.topCandidates(1).first }
        let confidence = top.isEmpty ? 0 : top.map { Double($0.confidence) }.reduce(0, +) / Double(top.count)
        return (top.map(\.string), confidence)
    }

    static func offMain<T: Sendable>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<T, Error>) in
            DispatchQueue.global(qos: .utility).async { cont.resume(with: Result { try body() }) }
        }
    }
}
