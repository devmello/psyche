import CoreGraphics
import CoreText
import Foundation
import ImageIO
import PsycheHelperCore
import PsycheHelperSystem
import PsycheProtocol
import Testing
import UniformTypeIdentifiers

private func call(_ r: CapabilityRegistry, _ params: JSONValue) async throws -> OcrRecognizeResult {
    let h = try #require(r["ocr.recognize"])
    let out = try await h.invoke(InvocationContext(invocationId: "i", capability: "ocr.recognize", params: params, approvalId: nil, emit: { _ in }))
    return try out.result.decode(as: OcrRecognizeResult.self)
}

/// A white bitmap with `text` drawn large in black (CoreText), as a CGImage.
private func textImage(_ text: String) -> CGImage? {
    let width = 1200, height = 300
    guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 110, nil)
    let attrs: [CFString: Any] = [kCTFontAttributeName: font, kCTForegroundColorFromContextAttributeName: true]
    ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    let line = CTLineCreateWithAttributedString(CFAttributedStringCreate(nil, text as CFString, attrs as CFDictionary))
    ctx.textPosition = CGPoint(x: 40, y: 100)
    CTLineDraw(line, ctx)
    return ctx.makeImage()
}

private func writePNG(_ image: CGImage, to path: String) -> Bool {
    guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(dest, image, nil)
    return CGImageDestinationFinalize(dest)
}

/// Page 1 has a real text layer (more than 30 characters); page 2 is only a picture of words.
private func twoPagePDF(at path: String, image: CGImage) -> Bool {
    var box = CGRect(x: 0, y: 0, width: 612, height: 792)
    guard let ctx = CGContext(URL(fileURLWithPath: path) as CFURL, mediaBox: &box, nil) else { return false }
    ctx.beginPDFPage(nil)
    let font = CTFontCreateWithName("Helvetica" as CFString, 12, nil)
    let layer = "This page keeps a text layer with plenty of characters in it."
    let line = CTLineCreateWithAttributedString(CFAttributedStringCreate(nil, layer as CFString, [kCTFontAttributeName: font] as CFDictionary))
    ctx.textPosition = CGPoint(x: 40, y: 700)
    CTLineDraw(line, ctx)
    ctx.endPDFPage()
    ctx.beginPDFPage(nil)
    ctx.draw(image, in: CGRect(x: 0, y: 300, width: 612, height: 153))
    ctx.endPDFPage()
    ctx.closePDF()
    return true
}

@Suite("ocr.recognize (R6/R7)")
struct OCRCapabilitiesTests {
    let registry = CapabilityRegistry(OCRCapabilities.make())

    @Test func manifestIsAReadOnPaths() throws {
        let spec = try #require(registry["ocr.recognize"]).spec
        #expect(spec.sideEffect == .read && spec.targetKind == .path)
        #expect(registry.ordered.count == 1)
    }

    @Test func refusesWithoutReadingAnything() async throws {
        let dir = NSTemporaryDirectory() + "psyche-ocr-sys-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        try Data("hello".utf8).write(to: URL(fileURLWithPath: dir + "/notes.txt"))
        let txt = try await call(registry, ["path": .string(dir + "/notes.txt")])
        #expect(txt.refusal == .unsupportedType && txt.pages.isEmpty)
        try Data(repeating: 0, count: 4096).write(to: URL(fileURLWithPath: dir + "/big.png"))
        let big = try await call(registry, ["path": .string(dir + "/big.png"), "maxFileBytes": 2048])
        #expect(big.refusal == .tooLarge)
        let junk = try await call(registry, ["path": .string(dir + "/big.png")])
        #expect(junk.refusal == .unreadable)
    }

    @Test func aFakeRecognizerSeesOnlyThePagesBelowTheThreshold() async throws {
        let dir = NSTemporaryDirectory() + "psyche-ocr-pdf-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        guard let img = textImage("Receipt 4821"), twoPagePDF(at: dir + "/mixed.pdf", image: img) else { return }
        let seen = Seen()
        let r = CapabilityRegistry(OCRCapabilities.make(recognizer: { _ in
            seen.bump()
            return (["  Receipt 4821 ", ""], 0.9)
        }))
        let out = try await call(r, ["path": .string(dir + "/mixed.pdf")])
        #expect(out.pageCount == 2)
        #expect(seen.count == 1, "the page with a text layer is not recognised")
        #expect(out.pages.map(\.page) == [2] && out.pages.first?.text == "Receipt 4821")
        // Raising the threshold above that page's text layer sends both pages.
        let both = try await call(r, ["path": .string(dir + "/mixed.pdf"), "minTextChars": 1000])
        #expect(both.pages.map(\.page) == [1, 2])
    }

    /// Real Vision over a generated PNG. Skips when Vision cannot run here (CI without the models).
    @Test func visionReadsRenderedText() async throws {
        let dir = NSTemporaryDirectory() + "psyche-ocr-vision-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        guard let img = textImage("Receipt 4821"), writePNG(img, to: dir + "/receipt.png") else { return }
        let out: OcrRecognizeResult
        do { out = try await call(registry, ["path": .string(dir + "/receipt.png")]) } catch {
            print("OCR: Vision unavailable here, skipping (\(error))")
            return
        }
        if out.pages.isEmpty {
            print("OCR: Vision returned nothing, skipping")
            return
        }
        #expect(out.pageCount == 1 && out.refusal == nil)
        let text = out.pages[0].text.lowercased()
        #expect(text.contains("receipt") && text.contains("4821"), "got \(text)")
        // A scanned PDF page goes through the same path.
        if twoPagePDF(at: dir + "/mixed.pdf", image: img) {
            let pdf = try await call(registry, ["path": .string(dir + "/mixed.pdf")])
            #expect(pdf.pages.map(\.page) == [2])
            #expect(pdf.pages.first?.text.lowercased().contains("4821") == true)
        }
    }
}

private final class Seen: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func bump() { lock.lock(); n += 1; lock.unlock() }
    var count: Int { lock.lock(); defer { lock.unlock() }; return n }
}
