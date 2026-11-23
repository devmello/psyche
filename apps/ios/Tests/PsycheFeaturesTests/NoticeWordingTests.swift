import Foundation
import PsycheStore
import Testing

@testable import PsycheFeatures

struct NoticeWordingTests {
    static func item(message: InboxNoticeKeys?, actions: [InboxAction] = []) -> InboxItem {
        InboxItem(
            id: "n", title: "Gateway title", body: "Gateway body", kindLabel: "Update", time: "9:00",
            message: message, actions: actions)
    }

    static let held = InboxNoticeKeys(
        titleKey: "notice.codeRun.held.title", bodyKey: "notice.codeRun.held.body",
        params: ["repo": "psyche", "paths": ".vscode/launch.json"])

    /// The keys whose desktop strings use ICU `select` or `plural` (see `NoticeWording.render`).
    static let icuKeys = [
        "notice.apiKey.changed.title", "notice.apiKey.changed.body",
        "notice.approvals.digest.title",
        "notice.approvals.resumeMissed.title", "notice.approvals.resumeMissed.body",
        "notice.connector.changed.body",
        "notice.security.changed.body", "notice.security.firstAdmin.body", "notice.security.firstSeal.body",
        "notice.security.recovery.title", "notice.security.recovery.body",
        "notice.security.resealed.title", "notice.security.resealed.body",
        "notice.security.tightened.title",
        "notice.specialist.result.title", "notice.specialist.result.body",
    ]

    /// The catalog's `strings` table, read from the source file: the same text the app compiles in.
    static func loadCatalog() -> [String: Any] {
        // #filePath: apps/ios/Tests/PsycheFeaturesTests/<this file>, so three levels up is apps/ios.
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/PsycheFeatures/Resources/Localizable.xcstrings")
        let catalog = (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: Any]
        return catalog?["strings"] as? [String: Any] ?? [:]
    }

    static func catalogValue(_ strings: [String: Any], _ key: String, _ language: String) -> String? {
        let localizations = (strings[key] as? [String: Any])?["localizations"] as? [String: Any]
        let unit = (localizations?[language] as? [String: Any])?["stringUnit"] as? [String: Any]
        return unit?["value"] as? String
    }

    /// Every `select` and `plural` in a parsed string, nested ones included.
    static func allChoices(_ pieces: [NoticeWording.Piece]) -> [NoticeWording.Choice] {
        var found: [NoticeWording.Choice] = []
        for piece in pieces {
            guard case .choice(let choice) = piece else { continue }
            found.append(choice)
            for branch in choice.branches.values { found += allChoices(branch) }
        }
        return found
    }

    static let languages = ["en", "ar", "de", "es", "fr", "hi", "it", "ja", "ko", "pt", "zh-Hans"]

    @Test func knownKeysAreWordedFromTheCatalogWithValuesFilledIn() {
        let item = Self.item(message: Self.held)
        let title = NoticeWording.title(item)
        #expect(title != "Gateway title")
        #expect(title.contains("psyche"))
        #expect(!title.contains("{repo}"))
        let body = NoticeWording.body(item)
        #expect(body != "Gateway body")
        #expect(body.contains(".vscode/launch.json"))
        #expect(!body.contains("{paths}"))
    }

    @Test func unknownKeysAndNoticesWithoutIdsShowTheGatewayText() {
        let unknown = Self.item(message: InboxNoticeKeys(titleKey: "notice.future.title", bodyKey: "notice.future.body"))
        #expect(NoticeWording.title(unknown) == "Gateway title")
        #expect(NoticeWording.body(unknown) == "Gateway body")
        #expect(NoticeWording.title(Self.item(message: nil)) == "Gateway title")
        #expect(NoticeWording.body(Self.item(message: nil)) == "Gateway body")
    }

    @Test func aGatewayIdOutsideTheKnownSetNeverReadsTheCatalog() {
        // "Background" is a catalog key of another screen; a Gateway id must not reach it.
        #expect(NoticeWording.lookup("Background") == nil)
    }

    @Test func actionLabelsUseTheCatalogAndFallBackToTheGatewayLabel() {
        let keep = NoticeWording.label(InboxAction(id: "keep", label: "Keep it", labelKey: "notice.action.keepIt"))
        #expect(keep != "notice.action.keepIt")
        #expect(NoticeWording.label(InboxAction(id: "x", label: "Do it", labelKey: "notice.future.label")) == "Do it")
        #expect(NoticeWording.label(InboxAction(id: "x", label: "Do it")) == "Do it")
    }

    @Test func fillReplacesEachPlaceholderOnceAndLeavesUnknownOnesAsWritten() {
        #expect(NoticeWording.fill("A {repo} and {place}", ["repo": "{paths}"]) == "A {paths} and {place}")
        #expect(NoticeWording.fill("no placeholders", ["repo": "x"]) == "no placeholders")
    }

    @Test func everyKnownKeyIsInTheCatalogInEveryLanguageAndItsMarkupParses() throws {
        let strings = Self.loadCatalog()
        for key in NoticeWording.knownKeys {
            let english = try #require(Self.catalogValue(strings, key, "en"), "\(key) has no English text")
            let englishNames = try #require(NoticeWording.argumentNames(english), "\(key) English markup does not parse")
            #expect(NoticeWording.lookup(key) != nil, "\(key) is not in the compiled bundle")
            for language in Self.languages {
                let text = Self.catalogValue(strings, key, language) ?? ""
                #expect(!text.isEmpty, "\(key) is missing in \(language)")
                // A translation that does not parse would fall back to English on the phone, so it fails here.
                #expect(NoticeWording.argumentNames(text) == englishNames, "\(key) arguments differ in \(language)")
            }
        }
    }

    @Test func everyBranchOfTheIcuNoticesRendersWithoutMarkup() throws {
        let strings = Self.loadCatalog()
        for key in Self.icuKeys {
            for language in ["en", "ar", "fr", "ja"] {
                let template = try #require(Self.catalogValue(strings, key, language))
                let pieces = try #require(NoticeWording.parse(template), "\(key) \(language) does not parse")
                let names = try #require(NoticeWording.argumentNames(template))
                for choice in Self.allChoices(pieces) {
                    for selector in choice.branches.keys {
                        // Every other argument gets "x" (so nested choices take `other`); this choice gets the branch.
                        // A plural category word ("one", "few") is not a number, so it takes `other` here; the
                        // categories are checked by `pluralBranchesFollowTheCLDRCategoryOfEachCatalogLanguage`.
                        var params = Dictionary(uniqueKeysWithValues: names.map { ($0, "x") })
                        params[choice.name] = choice.isPlural && selector.hasPrefix("=")
                            ? String(selector.dropFirst()) : selector
                        let rendered = try #require(
                            NoticeWording.render(template, params, language: language),
                            "\(key) \(language) \(choice.name)=\(selector) does not render")
                        #expect(!rendered.contains("{") && !rendered.contains("}"),
                                "\(key) \(language) \(choice.name)=\(selector) leaves markup: \(rendered)")
                    }
                }
            }
        }
    }

    @Test func englishIcuNoticesPickTheBranchForTheValue() {
        #expect(NoticeWording.render("{count, plural, =1 {# action is waiting from your automations} other {# actions are waiting from your automations}}",
                                     ["count": "1"], language: "en") == "1 action is waiting from your automations")
        #expect(NoticeWording.render("{count, plural, =1 {# action is waiting from your automations} other {# actions are waiting from your automations}}",
                                     ["count": "3"], language: "en") == "3 actions are waiting from your automations")
        #expect(NoticeWording.render("{count, plural, =1 {# action is waiting from your automations} other {# actions are waiting from your automations}}",
                                     ["count": "0"], language: "en") == "0 actions are waiting from your automations")
        #expect(NoticeWording.render("{restored, select, yes {Security records sealed after a restore} other {Security records sealed again}}",
                                     ["restored": "yes"], language: "en") == "Security records sealed after a restore")
        #expect(NoticeWording.render("{restored, select, yes {Security records sealed after a restore} other {Security records sealed again}}",
                                     ["restored": "no"], language: "en") == "Security records sealed again")
        #expect(NoticeWording.render("{outcome, select, done {{who} finished {title}} partial {{who} stopped early on {title}} cancelled {{who} was stopped on {title}} other {{who} couldn't finish {title}}}",
                                     ["outcome": "partial", "who": "Ana", "title": "the audit"], language: "en")
            == "Ana stopped early on the audit")
        #expect(NoticeWording.render("{outcome, select, done {{who} finished {title}} partial {{who} stopped early on {title}} cancelled {{who} was stopped on {title}} other {{who} couldn't finish {title}}}",
                                     ["outcome": "unknown", "who": "Ana", "title": "the audit"], language: "en")
            == "Ana couldn't finish the audit")
        #expect(NoticeWording.render("Security settings were tightened from {device, select, none {a device} other {{device}}}",
                                     ["device": "none"], language: "en") == "Security settings were tightened from a device")
        #expect(NoticeWording.render("Security settings were tightened from {device, select, none {a device} other {{device}}}",
                                     ["device": "Mac"], language: "en") == "Security settings were tightened from Mac")
    }

    @Test func pluralBranchesFollowTheCLDRCategoryOfEachCatalogLanguage() {
        let template = "{n, plural, zero {zero} one {one} two {two} few {few} many {many} other {other}}"
        // Expected categories from Intl.PluralRules (CLDR) for 0, 1, 2, 3, 11 and 100.
        let expected: [String: [String]] = [
            "en": ["other", "one", "other", "other", "other", "other"],
            "ar": ["zero", "one", "two", "few", "many", "other"],
            "fr": ["one", "one", "other", "other", "other", "other"],
            "hi": ["one", "one", "other", "other", "other", "other"],
            "pt": ["one", "one", "other", "other", "other", "other"],
            "de": ["other", "one", "other", "other", "other", "other"],
            "es": ["other", "one", "other", "other", "other", "other"],
            "it": ["other", "one", "other", "other", "other", "other"],
            "ja": ["other", "other", "other", "other", "other", "other"],
            "ko": ["other", "other", "other", "other", "other", "other"],
            "zh": ["other", "other", "other", "other", "other", "other"],
        ]
        let numbers = [0, 1, 2, 3, 11, 100]
        for (language, words) in expected {
            for (index, number) in numbers.enumerated() {
                #expect(NoticeWording.render(template, ["n": "\(number)"], language: language) == words[index],
                        "\(language) \(number)")
            }
        }
        // The `zh-Hans` catalog language is read as `zh`.
        #expect(NoticeWording.pluralCategory(0, language: "zh") == "other")
    }

    @Test func pluralUsesAnExactMatchBeforeTheCategory() {
        let template = "{n, plural, =0 {nothing} one {one} other {# items}}"
        #expect(NoticeWording.render(template, ["n": "0"], language: "fr") == "nothing")
        #expect(NoticeWording.render(template, ["n": "1"], language: "fr") == "one")
        #expect(NoticeWording.render(template, ["n": "2"], language: "fr") == "2 items")
    }

    @Test func aParamValueWithBracesIsShownAsWrittenAndNeverParsed() {
        #expect(NoticeWording.render("{a} and {b, select, x {X} other {O}}", ["a": "{b}", "b": "x"], language: "en")
            == "{b} and X")
        #expect(NoticeWording.render("{n, plural, one {one} other {many: #}}", ["n": "{1}"], language: "en")
            == "many: {1}")
        #expect(NoticeWording.render("{a}", ["a": "}{"], language: "en") == "}{")
    }

    @Test func aMissingParamKeepsItsPlaceholderAsWritten() {
        #expect(NoticeWording.render("Hi {a} {b, select, x {X} other {O}}", [:], language: "en")
            == "Hi {a} {b, select, x {X} other {O}}")
    }

    @Test func hashIsTheNumberOnlyInsideAPluralAndTextElsewhere() {
        #expect(NoticeWording.render("# {a}", ["a": "1"], language: "en") == "# 1")
        #expect(NoticeWording.render("{n, plural, other {# items {s, select, y {yes} other {no}}}}",
                                     ["n": "4", "s": "y"], language: "en") == "4 items yes")
    }

    @Test func malformedMarkupDoesNotRenderAndFallsBackToEnglish() {
        #expect(NoticeWording.render("{a, select, x {X}}", ["a": "x"], language: "en") == nil, "no other branch")
        #expect(NoticeWording.render("{a, select, x {X", ["a": "x"], language: "en") == nil, "unclosed branch")
        #expect(NoticeWording.render("x}", [:], language: "en") == nil, "stray closing brace")
        #expect(NoticeWording.render("{a, plural, one {# one} other {# other}", ["a": "1"], language: "en") == nil,
                "unclosed argument")
        #expect(NoticeWording.render("{a, foo, other {x}}", ["a": "1"], language: "en") == nil, "unknown type")
        #expect(NoticeWording.render("{}", [:], language: "en") == nil, "no name")
        #expect(NoticeWording.render("{a, select other {x}}", ["a": "x"], language: "en") == nil, "missing comma")
    }
}
