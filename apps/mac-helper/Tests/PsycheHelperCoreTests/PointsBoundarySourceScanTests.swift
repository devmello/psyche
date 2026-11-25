import Foundation
import Testing

/// The source-scan line of the Psyche points boundary (docs/design/psyche-points-2026.md §4.3). It
/// runs without a build and mirrors step 2 of `scripts/check-points-boundary.sh`: the targets
/// Points may use contain no `kAXTrustedCheckOptionPrompt`, `CGEvent(` or `.post(`.
@Suite struct PointsBoundarySourceScanTests {
    static let sources: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Sources")

    static let guarded = ["PsycheHelperPoints", "PsycheAXRead", "PsycheCapture", "PsycheAXEnable", "PsycheHelperCore"]
    static let forbidden = ["kAXTrustedCheckOptionPrompt", "CGEvent(", ".post("]

    /// Every forbidden needle found in `text`, so a planted line is reported by name.
    static func hits(in text: String) -> [String] { forbidden.filter { text.contains($0) } }

    static func swiftFiles(in target: String) -> [URL] {
        let dir = sources.appendingPathComponent(target)
        let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)
        return (e?.allObjects as? [URL] ?? []).filter { $0.pathExtension == "swift" }
    }

    @Test func guardedTargetsExistAndHaveSources() {
        for t in Self.guarded { #expect(!Self.swiftFiles(in: t).isEmpty, "no sources found for \(t)") }
    }

    @Test(arguments: guarded) func guardedTargetHasNoEventPosting(target: String) throws {
        for file in Self.swiftFiles(in: target) {
            let text = try String(contentsOf: file, encoding: .utf8)
            #expect(Self.hits(in: text).isEmpty, "\(file.lastPathComponent) in \(target) contains \(Self.hits(in: text))")
        }
    }

    @Test func scannerFindsPlantedCalls() {
        #expect(Self.hits(in: "let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)") == ["CGEvent("])
        #expect(Self.hits(in: "e.post(tap: .cghidEventTap)") == [".post("])
        #expect(Self.hits(in: "let o = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true]") == ["kAXTrustedCheckOptionPrompt"])
        // Near-misses that share a word: types and flags link no symbol.
        #expect(Self.hits(in: "let flags: CGEventFlags = []; let k: CGKeyCode = 0; poster.postal(1)").isEmpty)
    }

    /// Positive control: the scan finds the real posting code in `PsycheHelperSystem`, so a scan
    /// that passes everywhere is a broken scan.
    @Test func scannerFindsRealPostingInSystemTarget() throws {
        let files = Self.swiftFiles(in: "PsycheHelperSystem")
        let found = try files.contains { try !Self.hits(in: String(contentsOf: $0, encoding: .utf8)).isEmpty }
        #expect(found, "no CGEvent( or .post( in PsycheHelperSystem: the source scan is not looking at the right files")
    }
}
