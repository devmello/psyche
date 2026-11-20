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

    @Test func everyKnownKeyIsInTheCatalogInEveryLanguageWithTheSamePlaceholders() throws {
        // #filePath: apps/ios/Tests/PsycheFeaturesTests/<this file>, so three levels up is apps/ios.
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/PsycheFeatures/Resources/Localizable.xcstrings")
        let catalog = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        let strings = catalog?["strings"] as? [String: Any] ?? [:]
        let languages = ["en", "ar", "de", "es", "fr", "hi", "it", "ja", "ko", "pt", "zh-Hans"]

        func value(_ key: String, _ language: String) -> String? {
            let localizations = (strings[key] as? [String: Any])?["localizations"] as? [String: Any]
            let unit = (localizations?[language] as? [String: Any])?["stringUnit"] as? [String: Any]
            return unit?["value"] as? String
        }
        func placeholders(_ text: String) -> Set<String> {
            Set(text.components(separatedBy: "{").dropFirst().compactMap { $0.components(separatedBy: "}").first })
        }

        for key in NoticeWording.knownKeys {
            let english = try #require(value(key, "en"), "\(key) has no English text")
            #expect(NoticeWording.lookup(key) != nil, "\(key) is not in the compiled bundle")
            for language in languages {
                let text = value(key, language) ?? ""
                #expect(!text.isEmpty, "\(key) is missing in \(language)")
                #expect(placeholders(text) == placeholders(english), "\(key) placeholders differ in \(language)")
            }
        }
    }
}
