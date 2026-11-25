import Foundation
import Testing

// The Points probe table is shared with TypeScript (`points-rules.test.ts`). The judge itself arrives
// in W3; until then these tests keep the shared file honest from the Swift side: it decodes, both
// lists are non-empty and meaningful, and every row says what the judge must answer, so a W3 test
// can run the table without guessing.

@Suite("Points sensitive fixture")
struct PointsFixtureTests {
    private static let reasons: Set<String> = [
        "password", "payment", "one_time_code", "identity", "secret", "secure_field", "value_shape", "directions_only",
    ]

    @Test func fileIsFoundAndDecodes() throws {
        let fixture = try PointsSensitiveFixture.load()
        #expect(fixture.mustBeSensitive.count >= 60)
        #expect(fixture.mustNotBeSensitive.count >= 30)
        #expect(!fixture.directionsOnlyPages.isEmpty)
        #expect(!fixture.ordinaryPages.isEmpty)
        #expect(!fixture.valueShapes.mustBeSensitive.isEmpty)
        #expect(!fixture.valueShapes.mustNotBe.isEmpty)
    }

    @Test func everyMustBeRowNamesAKnownReason() throws {
        let fixture = try PointsSensitiveFixture.load()
        for row in fixture.mustBeSensitive + fixture.acceptedFalseMatches {
            let reason = try #require(row.reason, "row \(row.label) has no reason")
            #expect(Self.reasons.contains(reason), "row \(row.label): unknown reason \(reason)")
        }
        for row in fixture.valueShapes.mustBeSensitive {
            let reason = try #require(row.reason, "value row has no reason")
            #expect(Self.reasons.contains(reason))
        }
    }

    @Test func nearMissesNameNoReason() throws {
        let fixture = try PointsSensitiveFixture.load()
        for row in fixture.mustNotBeSensitive { #expect(row.reason == nil, "near-miss \(row.label) carries a reason") }
        for row in fixture.valueShapes.mustNotBe { #expect(row.reason == nil) }
    }

    @Test func designRowsAreInBothLists() throws {
        let fixture = try PointsSensitiveFixture.load()
        let must = Set(fixture.mustBeSensitive.map(\.label))
        for label in [
            "SSN", "Social Security number", "Passport No.", "A-Number", "ITIN", "Routing number",
            "Account number (for direct deposit)", "Card number", "CVV", "PIN", "One-time code", "Mot de passe", "Reisepassnummer",
        ] { #expect(must.contains(label), "missing must-be row \(label)") }
        let not = Set(fixture.mustNotBeSensitive.map(\.label))
        for label in [
            "Passport photo upload", "Library card number", "Number of dependents", "Account name", "Card holder's city",
            "Tax year", "Card title", "Pass note",
        ] { #expect(not.contains(label), "missing near-miss row \(label)") }
    }

    @Test func noRowIsInBothLists() throws {
        let fixture = try PointsSensitiveFixture.load()
        func key(_ f: PointsSensitiveFixture.Field) -> String {
            [
                f.label, f.placeholder ?? "", f.help ?? "", f.identifier ?? "", f.autocomplete ?? "", f.secure == true ? "s" : "",
                (f.path ?? []).joined(separator: ">"), (f.nearbyText ?? []).joined(separator: ">"),
            ].joined(separator: "|")
        }
        let must = Set(fixture.mustBeSensitive.map(key))
        for row in fixture.mustNotBeSensitive { #expect(!must.contains(key(row)), "\(row.label) is in both lists") }
    }

    @Test func coversTheShippedLanguages() throws {
        let fixture = try PointsSensitiveFixture.load()
        let labels = fixture.mustBeSensitive.map(\.label).joined(separator: "\n")
        for sample in ["Contraseña", "Mot de passe", "Passwort", "Senha", "パスワード", "비밀번호", "密码", "पासवर्ड", "كلمة المرور", "Numero di carta"] {
            #expect(labels.contains(sample), "no row in the language of \(sample)")
        }
    }
}
