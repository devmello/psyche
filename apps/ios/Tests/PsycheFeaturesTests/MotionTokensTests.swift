import Foundation
import Testing

@testable import PsycheDesign

/// docs/design/motion.md §8: the numbers are the spec's, and no view types its own.
struct MotionTokensTests {
    @Test func springsMatchTheSpecTable() {
        let table: [(PsycheMotion.Spring, Double, Double)] = [
            (.micro, 0.20, 0), (.snappy, 0.30, 0.10), (.smooth, 0.35, 0),
            (.gentle, 0.50, 0), (.emphasis, 0.45, 0.15), (.interactive, 0.15, 0.14),
        ]
        #expect(table.count == PsycheMotion.Spring.allCases.count)
        for (spring, duration, bounce) in table {
            #expect(spring.duration == duration, "\(spring) duration")
            #expect(spring.bounce == bounce, "\(spring) bounce")
        }
    }

    @Test func noBounceInChromeAndNeverAboveTheCeiling() {
        for spring in PsycheMotion.Spring.allCases {
            #expect(spring.bounce <= 0.15, "\(spring) is above the 0.15 ceiling")
        }
        // Layout and surface springs are critically damped: only the two emphasis moments may bounce.
        for spring in [PsycheMotion.Spring.micro, .smooth, .gentle] { #expect(spring.bounce == 0) }
    }

    @Test func durationsMatchTheSpecTable() {
        #expect(PsycheMotion.Duration.instant == 0)
        #expect(PsycheMotion.Duration.micro == 0.1)
        #expect(PsycheMotion.Duration.short == 0.15)
        #expect(PsycheMotion.Duration.medium == 0.22)
        #expect(PsycheMotion.Duration.long == 0.32)
        #expect(PsycheMotion.Duration.exitFactor == 0.7)
        #expect(PsycheMotion.Duration.skeletonDelay == 0.15)
        #expect(PsycheMotion.Duration.staggerStep == 0.02)
        #expect(PsycheMotion.Duration.staggerLimit == 5)
        // Reduced motion crossfades are at most 150 ms (spec rule 6).
        #expect(PsycheMotion.Duration.short <= 0.15)
    }

    /// Animation literals live in Motion.swift and nowhere else. A view that needs a new kind of motion adds a
    /// token; it does not type a spring.
    @Test func noAnimationLiteralsOutsideTheTokensFile() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let banned = try NSRegularExpression(
            pattern: #"(?<!PsycheMotion)\.(snappy|smooth|bouncy|spring|easeIn|easeOut|easeInOut|linear|interactiveSpring|timingCurve|interpolatingSpring)\s*\("#
                + #"|\bwithAnimation\s*(\{|\(\s*\.)|\.animation\(\s*\.(default|snappy|smooth|linear|easeIn|easeOut|easeInOut|spring)\b"#
                + #"|\.animation\([^)]*\bvalue\s*:"#)
        var offenders: [String] = []
        var scanned = 0
        for folder in ["Sources", "Extensions", "App"] {
            guard let walker = FileManager.default.enumerator(at: root.appending(path: folder), includingPropertiesForKeys: nil)
            else { continue }
            for case let url as URL in walker where url.pathExtension == "swift" {
                if url.lastPathComponent == "Motion.swift" { continue }
                let text = try String(contentsOf: url, encoding: .utf8)
                scanned += 1
                for (number, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                    let code = line.split(separator: "//", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
                    let range = NSRange(code.startIndex..., in: code)
                    if banned.firstMatch(in: code, range: range) != nil {
                        offenders.append("\(url.lastPathComponent):\(number + 1): \(code.trimmingCharacters(in: .whitespaces))")
                    }
                }
            }
        }
        #expect(scanned > 50, "the scan found no sources: is #filePath still two levels under apps/ios?")
        #expect(offenders.isEmpty, "use PsycheMotion tokens: \(offenders.joined(separator: "\n"))")
    }
}
