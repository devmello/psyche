import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

@Suite("OCR policy (R6/R7)")
struct OCRPolicyTests {
    @Test func onlyThinTextLayersAreRecognised() {
        // Pages 2 and 4 have a text layer of 30+ characters and keep it; 1, 3 and 5 are image-only.
        let plan = OCRPolicy.pagesToRecognize(textLengths: [0, 30, 29, 400, 5])
        #expect(plan.pages == [1, 3, 5])
        #expect(plan.next == nil)
    }

    @Test func thresholdIsExclusiveAtMinChars() {
        #expect(OCRPolicy.pagesToRecognize(textLengths: [29, 30, 31], minChars: 30).pages == [1])
        #expect(OCRPolicy.pagesToRecognize(textLengths: [0, 1], minChars: 0).pages.isEmpty)
    }

    @Test func aCallRecognisesAtMostMaxPagesAndSaysWhereToContinue() {
        let plan = OCRPolicy.pagesToRecognize(textLengths: Array(repeating: 0, count: 50), maxPages: 5)
        #expect(plan.pages == [1, 2, 3, 4, 5])
        #expect(plan.next == 6)
        let rest = OCRPolicy.pagesToRecognize(textLengths: Array(repeating: 0, count: 8), from: 6, maxPages: 5)
        #expect(rest.pages == [6, 7, 8] && rest.next == nil)
        // The cap is never above the per-call limit.
        #expect(OCRPolicy.pagesToRecognize(textLengths: Array(repeating: 0, count: 100), maxPages: 99).pages.count == OCRPolicy.maxPagesPerCall)
    }

    @Test func pageListNarrowsTheCandidates() {
        let plan = OCRPolicy.pagesToRecognize(textLengths: [0, 0, 0, 0], only: [2, 4, 9])
        #expect(plan.pages == [2, 4])
    }

    @Test func textLayersAreOnlyScannedUpToALimit() {
        let plan = OCRPolicy.pagesToRecognize(textLengths: Array(repeating: 500, count: 300))
        #expect(plan.pages.isEmpty)
        #expect(plan.next == OCRPolicy.maxScannedPages + 1)
    }

    @Test func kindsFollowTheExtension() {
        #expect(OCRPolicy.kind(ofExtension: "PNG") == .image)
        #expect(OCRPolicy.kind(ofExtension: "pdf") == .pdf)
        #expect(OCRPolicy.kind(ofExtension: "docx") == nil)
        #expect(OCRPolicy.kind(ofExtension: "txt") == nil)
    }

    @Test func checkRefusesWhatItShouldNotRead() throws {
        let dir = NSTemporaryDirectory() + "psyche-ocr-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let img = dir + "/a.png"
        try Data(repeating: 1, count: 4096).write(to: URL(fileURLWithPath: img))
        #expect(OCRPolicy.check(path: img, maxBytes: nil).kind == .image)
        #expect(OCRPolicy.check(path: img, maxBytes: 2048).refusal == .tooLarge)
        #expect(OCRPolicy.check(path: "relative/a.png", maxBytes: nil).refusal == .notAFile)
        #expect(OCRPolicy.check(path: dir + "/missing.png", maxBytes: nil).refusal == .notAFile)
        try Data("x".utf8).write(to: URL(fileURLWithPath: dir + "/b.txt"))
        #expect(OCRPolicy.check(path: dir + "/b.txt", maxBytes: nil).refusal == .unsupportedType)
        // A symlink is not followed.
        try FileManager.default.createSymbolicLink(atPath: dir + "/link.png", withDestinationPath: img)
        #expect(OCRPolicy.check(path: dir + "/link.png", maxBytes: nil).refusal == .notAFile)
        #expect(OCRPolicy.defaultMaxFileBytes == 25 * 1024 * 1024)
    }

    @Test func tidyDropsBlankLinesAndCaps() {
        #expect(OCRPolicy.tidy(["  Total  ", "", "   ", "42.00"]) == "Total\n42.00")
        #expect(OCRPolicy.tidy([String(repeating: "a", count: 30_000)]).count == OCRPolicy.maxPageChars)
    }
}
