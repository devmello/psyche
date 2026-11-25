import Foundation
import PsycheProtocol
import Testing

@testable import PsycheHelperCore

// The Swift judge against the shared probe table (`packages/protocol/test/fixtures/points-sensitive.json`),
// the same rows `points-rules.test.ts` runs. A drift between the two judges is a failing row here.

private func facts(_ f: PointsSensitiveFixture.Field) -> PointsFieldFacts {
    PointsFieldFacts(
        label: f.label, placeholder: f.placeholder, help: f.help, identifier: f.identifier, autocomplete: f.autocomplete,
        secure: f.secure ?? false, path: f.path ?? [], nearbyText: f.nearbyText ?? [])
}

private func page(_ p: PointsSensitiveFixture.Page) -> PointsPageFacts {
    PointsPageFacts(url: p.url, host: p.host, title: p.title, hasPaymentFields: p.hasPaymentFields ?? false, insecure: p.insecure ?? false)
}

@Suite("Points sensitive judge, shared probe table")
struct PointsJudgeFixtureTests {
    @Test func everyMustBeRowIsSensitiveWithItsReason() throws {
        let fixture = try PointsSensitiveFixture.load()
        var wrong: [String] = []
        for row in fixture.mustBeSensitive {
            let got = PointsSensitiveJudge.classify(facts(row))
            if got?.rawValue != row.reason { wrong.append("\(row.label) \(row.path ?? []): wanted \(row.reason ?? "?"), got \(got?.rawValue ?? "nil")") }
        }
        #expect(wrong.isEmpty, "\(wrong.count) rows: \(wrong.joined(separator: "; "))")
    }

    @Test func noNearMissIsSensitive() throws {
        let fixture = try PointsSensitiveFixture.load()
        var wrong: [String] = []
        for row in fixture.mustNotBeSensitive {
            if let got = PointsSensitiveJudge.classify(facts(row)) { wrong.append("\(row.label): \(got.rawValue)") }
        }
        #expect(wrong.isEmpty, "\(wrong.count) near-misses judged sensitive: \(wrong.joined(separator: "; "))")
    }

    @Test func acceptedFalseMatchesStaySensitive() throws {
        let fixture = try PointsSensitiveFixture.load()
        for row in fixture.acceptedFalseMatches {
            #expect(PointsSensitiveJudge.classify(facts(row))?.rawValue == row.reason, "\(row.label)")
        }
    }

    @Test func directionsOnlyPagesAndOrdinaryPages() throws {
        let fixture = try PointsSensitiveFixture.load()
        for p in fixture.directionsOnlyPages { #expect(PointsSensitiveJudge.isDirectionsOnly(page(p)), "\(p)") }
        for p in fixture.ordinaryPages { #expect(!PointsSensitiveJudge.isDirectionsOnly(page(p)), "\(p)") }
    }

    @Test func everyFieldOnADirectionsOnlyPageIsSensitive() {
        let plain = PointsFieldFacts(label: "Tax year")
        #expect(PointsSensitiveJudge.classify(plain) == nil)
        #expect(PointsSensitiveJudge.classify(plain, directionsOnly: true) == .directionsOnly)
        #expect(PointsSensitiveJudge.classify(PointsFieldFacts(label: "Tax year", secure: true), directionsOnly: true) == .secureField)
    }
}
