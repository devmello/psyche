import Foundation

/// The shared probe table for Psyche points (docs/design/psyche-points-2026.md §5.1), read from the
/// same JSON file the TypeScript rules are tested against (`packages/protocol/test/fixtures/
/// points-sensitive.json`). The helper's sensitive-field judge (W3) is tested against these rows, so
/// the Swift and TypeScript judges cannot drift. The file is found from this source file's path, so
/// it needs no copy step and no bundle resource.
struct PointsSensitiveFixture: Decodable {
    struct Field: Decodable {
        var label: String
        var placeholder: String?
        var help: String?
        var identifier: String?
        var autocomplete: String?
        var secure: Bool?
        var path: [String]?
        var nearbyText: [String]?
        /// The reason the judge must give. Absent on a near-miss.
        var reason: String?
        var why: String?
    }

    struct Page: Decodable {
        var url: String?
        var host: String?
        var title: String?
        var hasPaymentFields: Bool?
        var insecure: Bool?
    }

    struct Value: Decodable {
        var value: String
        var label: String?
        var reason: String?
    }

    struct ValueShapes: Decodable {
        var mustBeSensitive: [Value]
        var mustNotBe: [Value]
    }

    var mustBeSensitive: [Field]
    var mustNotBeSensitive: [Field]
    var acceptedFalseMatches: [Field]
    var directionsOnlyPages: [Page]
    var ordinaryPages: [Page]
    var valueShapes: ValueShapes

    /// `packages/protocol/test/fixtures/points-sensitive.json`, found from this file.
    static func url(file: String = #filePath) -> URL {
        var url = URL(fileURLWithPath: file)
        // …/apps/mac-helper/Tests/PsycheHelperCoreTests/<file>
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("packages/protocol/test/fixtures/points-sensitive.json")
    }

    static func load(file: String = #filePath) throws -> PointsSensitiveFixture {
        try JSONDecoder().decode(PointsSensitiveFixture.self, from: Data(contentsOf: url(file: file)))
    }
}
