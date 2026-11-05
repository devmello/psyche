import Foundation
@testable import PsycheHelperCore
import PsycheProtocol
import Testing

// Recorded AX event fixtures for "Record in an app" (J8 phase 2). The live AXObserver cannot run
// in tests, so the decisions it feeds are tested here: which apps may be recorded, which fields are
// secret, and how events become steps. Secret-looking values are built at run time.

private let mail = "com.apple.mail"

private func el(
    _ role: String, title: String? = nil, description: String? = nil, identifier: String? = nil, placeholder: String? = nil,
    label: String? = nil, path: [String] = ["New Message"], menu: [String] = [], app: String = mail, secureInput: Bool = false,
    subrole: String? = nil
) -> AppTeachElement {
    AppTeachElement(
        bundleId: app, appName: app == mail ? "Mail" : "Other", role: role, subrole: subrole, title: title, description: description,
        identifier: identifier, placeholder: placeholder, labelText: label, path: path, menuPath: menu, secureInput: secureInput
    )
}

private func settings(_ apps: [String: TierSettings.Value] = [mail: .interact]) -> TierSettings {
    TierSettings(defaultValue: .ask, apps: apps)
}

private func mapper() -> AppTeachMapper { AppTeachMapper(bundleId: mail, appName: "Mail") }

/// A Luhn-valid 16-digit number, computed so no card-looking literal sits in the source.
private func cardNumber() -> String {
    var digits = Array("4111111111111") .compactMap { $0.wholeNumberValue } + [0, 0, 0]
    for last in 0...9 {
        digits[15] = last
        var sum = 0
        for (i, d) in digits.reversed().enumerated() {
            var n = d
            if i % 2 == 1 { n *= 2; if n > 9 { n -= 9 } }
            sum += n
        }
        if sum % 10 == 0 { break }
    }
    return digits.map(String.init).joined()
}

@Suite("teach in a Mac app: policy")
struct AppTeachPolicyTests {
    @Test func grantedAppsOnly() {
        #expect(AppTeachPolicy.refusal(bundleId: mail, settings: settings()) == nil)
        #expect(AppTeachPolicy.refusal(bundleId: mail, settings: settings([mail: .click])) == nil)
        // Read alone is not enough: the agent could not act in the app anyway.
        #expect(AppTeachPolicy.refusal(bundleId: mail, settings: settings([mail: .read])) == .notGranted)
        #expect(AppTeachPolicy.refusal(bundleId: mail, settings: settings([:])) == .notGranted)  // default: ask
        #expect(AppTeachPolicy.refusal(bundleId: mail, settings: settings([mail: .off])) == .notGranted)
        #expect(AppTeachPolicy.refusal(bundleId: mail, settings: settings([mail: .ask])) == .notGranted)
        #expect(AppTeachPolicy.refusal(bundleId: "com.apple.Notes", settings: settings()) == .notGranted)
    }

    @Test func neverPsycheOrSystemSecurityUI() {
        let all: [String: TierSettings.Value] = [
            "com.psyche.desktop": .interact, "com.psyche.helper": .interact, "com.apple.loginwindow": .interact,
            "com.apple.SecurityAgent": .interact, "com.apple.keychainaccess": .interact, "com.apple.LocalAuthentication.UIAgent": .interact,
            "com.1password.1password": .interact, "com.apple.systempreferences": .interact,
        ]
        let s = settings(all)
        #expect(AppTeachPolicy.refusal(bundleId: "com.psyche.desktop", settings: s) == .psyche)
        #expect(AppTeachPolicy.refusal(bundleId: "com.psyche.helper", settings: s) == .psyche)
        #expect(AppTeachPolicy.refusal(bundleId: "com.apple.loginwindow", settings: s) == .securityPrompt)
        #expect(AppTeachPolicy.refusal(bundleId: "com.apple.SecurityAgent", settings: s) == .securityPrompt)
        #expect(AppTeachPolicy.refusal(bundleId: "com.apple.keychainaccess", settings: s) != nil)
        #expect(AppTeachPolicy.refusal(bundleId: "com.apple.LocalAuthentication.UIAgent", settings: s) == .securityPrompt)
        #expect(AppTeachPolicy.refusal(bundleId: "com.1password.1password", settings: s) == .passwordManager)
        #expect(AppTeachPolicy.refusal(bundleId: "com.apple.systempreferences", settings: s) != nil)
        // Case does not matter to LaunchServices.
        #expect(AppTeachPolicy.refusal(bundleId: "COM.APPLE.SECURITYAGENT", settings: s) == .securityPrompt)
    }

    @Test func appsThatCannotBeDrivenAreNotRecorded() {
        let s = settings(["com.apple.Safari": .interact, "com.apple.Terminal": .interact, "com.chase.app": .interact])
        #expect(AppTeachPolicy.refusal(bundleId: "com.apple.Safari", settings: s) == .offLimits)
        #expect(AppTeachPolicy.refusal(bundleId: "com.apple.Terminal", settings: s) == .offLimits)
        #expect(AppTeachPolicy.refusal(bundleId: "com.chase.app", settings: s) == .offLimits)
    }

    @Test func secretFieldsAreRecognisedByRoleInputStateAndWords() {
        #expect(AppTeachPolicy.isSecret(el("AXTextField", title: "Anything", subrole: "AXSecureTextField")))
        #expect(AppTeachPolicy.isSecret(el("AXSecureTextField", title: "Anything")))
        #expect(AppTeachPolicy.isSecret(el("AXTextField", title: "Subject", secureInput: true)))
        for words in ["Password", "Passwort", "Contraseña", "Card number", "CVV", "Verification code", "One-time code", "SSN", "API key", "Recovery phrase", "密码"] {
            #expect(AppTeachPolicy.isSecret(el("AXTextField", title: words)), "\(words)")
        }
        #expect(AppTeachPolicy.isSecret(el("AXTextField", title: "Field", identifier: "passwordField")))
        #expect(AppTeachPolicy.isSecret(el("AXTextField", placeholder: "Enter your PIN")))
        for ok in ["Subject", "To", "Cc", "Search", "Name", "Amount"] {
            #expect(!AppTeachPolicy.isSecret(el("AXTextField", title: ok)), "\(ok)")
        }
    }

    @Test func theSharedNeverListCoversManagersAuthenticatorsWalletsAndDevElectron() {
        let ids = [
            "com.markmcguill.strongbox.mac", "com.hicknhacksoftware.MacPass", "com.keepassium.mac", "com.outercorner.Secrets",
            "com.siber.roboform", "com.authy.authy-mac", "com.yubico.authenticator", "com.stepwise.StepTwo",
            "org.electrum.electrum", "com.sparrowwallet.Sparrow", "io.trezor.suite", "com.ledger.live", "com.exodus.wallet",
            "com.github.Electron", "COM.GITHUB.ELECTRON",
        ]
        let s = settings(Dictionary(uniqueKeysWithValues: ids.map { ($0, TierSettings.Value.interact) }))
        for id in ids { #expect(AppTeachPolicy.refusal(bundleId: id, settings: s) != nil, "\(id)") }
        // A neighbour with a similar prefix is not caught.
        #expect(AppTeachPolicy.refusal(bundleId: "com.githubx.Notes", settings: settings(["com.githubx.Notes": .interact])) == nil)
        #expect(!TeachNeverApps.patterns.isEmpty)
    }

    @Test func pathAndNearbyLabelsCountForTheSecretWords() {
        #expect(AppTeachPolicy.isSecret(el("AXTextField", title: "Field", path: ["Enter your verification code"])))
        var e = el("AXTextField", title: "Field")
        e.nearby = ["Recovery phrase"]
        #expect(AppTeachPolicy.isSecret(e))
        #expect(!AppTeachPolicy.isSecret(el("AXTextField", title: "Field", path: ["New Message"])))
    }

    @Test func moreSecretShapes() {
        let phrase = (0..<12).map { _ in "abandon" }.joined(separator: " ")
        #expect(AppTeachPolicy.valueReason(phrase) == .secret)
        #expect(AppTeachPolicy.valueReason((0..<24).map { _ in "zoo" }.joined(separator: " ")) == .secret)
        #expect(AppTeachPolicy.valueReason((0..<11).map { _ in "abandon" }.joined(separator: " ")) == nil)
        #expect(AppTeachPolicy.valueReason("https://" + "dana" + ":" + "pw" + "@example.com/x") == .secret)
        #expect(AppTeachPolicy.valueReason("https://example.com/x") == nil)
        #expect(AppTeachPolicy.valueReason("123456", label: "Code") == .oneTimeCode)
        // Any bare 4 to 8 digit number is treated as a code: one Keep click is too easy.
        #expect(AppTeachPolicy.valueReason("123456", label: "Quantity") == .oneTimeCode)
        #expect(AppTeachPolicy.valueReason("4821") == .oneTimeCode)
        #expect(AppTeachPolicy.valueReason("123") == nil)
        #expect(AppTeachPolicy.valueReason("2026-11-04") == nil)
    }

    @Test func valuesThatLookLikeSecretsAreCaught() {
        #expect(AppTeachPolicy.valueReason(cardNumber()) == .payment)
        #expect(AppTeachPolicy.valueReason("pay \(cardNumber()) now") == .payment)
        #expect(AppTeachPolicy.valueReason([String(123), String(45), String(6789)].joined(separator: "-")) == .identity)
        #expect(AppTeachPolicy.valueReason(String(repeating: "a1B2", count: 10)) == .secret)
        #expect(AppTeachPolicy.valueReason("ghp_" + String(repeating: "x9", count: 12)) == .secret)
        #expect(AppTeachPolicy.valueReason("Quarterly report") == nil)
        #expect(AppTeachPolicy.valueReason("4111") == .oneTimeCode)  // a bare 4 to 8 digit number
    }
}

@Suite("teach in a Mac app: events to steps")
struct AppTeachMapperTests {
    @Test func clickTypeAndMenuBecomeSemanticSteps() {
        let m = mapper()
        let button = el("AXButton", title: "New Message", identifier: "newMessage", path: ["Inbox"])
        let subject = el("AXTextField", title: "Subject", identifier: "subjectField")
        #expect(m.handle(.press(button)).map(\.kind) == ["app_click"])
        m.handle(.focus(subject))
        m.handle(.valueChanged(subject, value: "Q"))
        m.handle(.valueChanged(subject, value: "Quarterly"))
        m.handle(.valueChanged(subject, value: "Quarterly report"))
        let menu = el("AXMenuItem", title: "Export", path: [], menu: ["File", "Export"])
        let out = m.handle(.menuChosen(menu))
        #expect(out.map(\.kind) == ["app_type", "app_menu"])  // typing flushes before the next step
        let steps = m.finish()
        #expect(steps.map(\.kind) == ["app_click", "app_type", "app_menu"])

        #expect(steps[0].app == .init(bundleId: mail, name: "Mail"))
        #expect(steps[0].role == "button" && steps[0].name == "New Message")
        #expect(steps[0].path == ["Inbox", "New Message"])
        #expect(steps[0].fallback == "identifier:newMessage")

        #expect(steps[1].role == "textbox" && steps[1].name == "Subject")
        #expect(steps[1].sample == "Quarterly report")  // the whole value, not each keystroke
        #expect(steps[1].sensitive == nil)

        #expect(steps[2].path == ["File", "Export"] && steps[2].name == "Export" && steps[2].role == "menuitem")
        #expect(steps.map(\.id) == ["a1", "a2", "a3"])
    }

    @Test func typingIsOneStepPerFieldAndAnEmptiedFieldIsNone() {
        let m = mapper()
        let to = el("AXTextField", title: "To")
        let cc = el("AXTextField", title: "Cc")
        m.handle(.focus(to))
        m.handle(.valueChanged(to, value: "a"))
        m.handle(.valueChanged(to, value: "ana@example.com"))
        m.handle(.focus(cc))  // leaving the field flushes it
        m.handle(.valueChanged(cc, value: "x"))
        m.handle(.valueChanged(cc, value: ""))
        let steps = m.finish()
        #expect(steps.count == 1)
        #expect(steps[0].name == "To" && steps[0].sample == "ana@example.com")
    }

    @Test func secureFieldsAreSkippedAndTheirValueIsNeverKept() {
        let m = mapper()
        let pw = el("AXSecureTextField", title: "Password", identifier: "pw")
        m.handle(.focus(pw))
        // Even if a source wrongly handed the value over, it never reaches a step.
        m.handle(.valueChanged(pw, value: "hunter2"))
        m.handle(.valueChanged(pw, value: "hunter22"))
        let steps = m.finish()
        #expect(steps.count == 1)
        #expect(steps[0].kind == "app_type" && steps[0].sensitive == true)
        #expect(steps[0].sample == nil)
        let json = String(decoding: (try? JSONEncoder().encode(steps)) ?? Data(), as: UTF8.self)
        #expect(!json.contains("hunter"))
    }

    @Test func secureEventInputAndSecretWordsMarkAFieldSensitive() {
        let m = mapper()
        let subject = el("AXTextField", title: "Subject", secureInput: true)
        let code = el("AXTextField", title: "Verification code")
        m.handle(.focus(subject))
        m.handle(.valueChanged(subject, value: "secret subject"))
        m.handle(.focus(code))
        m.handle(.valueChanged(code, value: "123456"))
        let steps = m.finish()
        #expect(steps.map(\.sensitive) == [true, true])
        #expect(steps.allSatisfy { $0.sample == nil })
    }

    @Test func aSecretShapedValueInAnOrdinaryFieldIsDropped() {
        let m = mapper()
        let note = el("AXTextArea", title: "Body")
        let card = cardNumber()
        m.handle(.focus(note))
        m.handle(.valueChanged(note, value: card))
        let steps = m.finish()
        #expect(steps.count == 1)
        #expect(steps[0].sensitive == true && steps[0].sample == nil)
        let json = String(decoding: (try? JSONEncoder().encode(steps)) ?? Data(), as: UTF8.self)
        #expect(!json.contains(card))
    }

    @Test func valueChangesAreAcceptedFromTheFocusedFieldOnly() {
        let m = mapper()
        let subject = el("AXTextField", title: "Subject")
        let other = el("AXTextField", title: "Search")
        // No focus yet: nothing counts.
        m.handle(.valueChanged(subject, value: "early"))
        m.handle(.focus(subject))
        m.handle(.valueChanged(other, value: "typed elsewhere"))
        m.handle(.valueChanged(subject, value: "Weekly"))
        let steps = m.finish()
        #expect(steps.map(\.name) == ["Subject"] && steps[0].sample == "Weekly")
    }

    @Test func theRecordingIsBoundToTheProcess() {
        let m = mapper()
        m.bind(pid: 100)
        var mine = el("AXButton", title: "Archive")
        mine.pid = 100
        var imposter = el("AXButton", title: "Delete")  // same bundle id string, another process
        imposter.pid = 200
        #expect(m.handle(.press(imposter)).isEmpty)
        #expect(m.handle(.press(mine)).count == 1)
    }

    @Test func rowsAndCellsAreRecordedByRoleNeverByContent() {
        let m = mapper()
        let row = el("AXRow", title: "Invoice from dana@example.com", description: "Re: layoffs", identifier: "row7", path: ["Inbox", "Quiet subject"])
        let step = m.handle(.press(row)).first
        #expect(step?.role == "row" && step?.name == nil && step?.fallback == nil && step?.path == ["row"])
        let json = String(decoding: (try? JSONEncoder().encode(m.finish())) ?? Data(), as: UTF8.self)
        #expect(!json.contains("dana") && !json.contains("layoffs") && !json.contains("Quiet"))
    }

    @Test func aWindowTitleAndTheLabelBeforeAFieldDecideItButAreNeverKept() {
        // "Two-factor authentication" window, a sibling label, and a field with no words of its own.
        var code = el("AXTextField", title: nil, path: [])
        code.context = ["Two-factor authentication", "We sent a verification code to your phone"]
        #expect(AppTeachPolicy.isSecret(code))
        let m = mapper()
        m.handle(.focus(code))
        m.handle(.valueChanged(code, value: "x"))
        let steps = m.finish()
        #expect(steps.count == 1 && steps[0].sensitive == true && steps[0].sample == nil)
        let json = String(decoding: (try? JSONEncoder().encode(steps)) ?? Data(), as: UTF8.self)
        #expect(!json.contains("Two-factor") && !json.contains("verification"))
        // A plain window is not secret.
        var plain = el("AXTextField", title: "Subject")
        plain.context = ["New Message", "Subject:"]
        #expect(!AppTeachPolicy.isSecret(plain))
    }

    @Test func aBareCodeNumberIsSensitiveEvenInAPlainField() {
        let m = mapper()
        let f = el("AXTextField", title: "Amount")
        m.handle(.focus(f))
        m.handle(.valueChanged(f, value: "482913"))
        let s = m.finish()
        #expect(s.count == 1 && s[0].sensitive == true && s[0].sample == nil)
    }

    @Test func onlyWhatWasTypedAfterFocusIsKept() {
        let m = mapper()
        let f = el("AXTextField", title: "Subject")
        // Pre-filled "Re: " plus what the owner added: only the addition.
        m.handle(.focus(f, initial: "Re: "))
        m.handle(.valueChanged(f, value: "Re: Weekly"))
        #expect(m.finish().first?.sample == "Weekly")
        // Autofilled and untouched: nothing.
        let m2 = mapper()
        let g = el("AXTextField", title: "Name")
        m2.handle(.focus(g, initial: "Dana Example"))
        m2.handle(.valueChanged(g, value: "Dana Example"))
        #expect(m2.finish().isEmpty)
    }

    @Test func focusLeavingTheFieldEndsItsTyping() {
        let m = mapper()
        let f = el("AXTextField", title: "Subject")
        m.handle(.focus(f))
        m.handle(.valueChanged(f, value: "Weekly"))
        #expect(m.handle(.focusCleared).count == 1)  // flushed
        // Typing the source still reports for that field after focus left is ignored.
        m.handle(.valueChanged(f, value: "Weekly and more"))
        #expect(m.finish().count == 1)
        // A focus on an element of another process clears focus too.
        let m2 = mapper()
        m2.bind(pid: 10)
        var mine = el("AXTextField", title: "Subject")
        mine.pid = 10
        var foreign = el("AXTextField", title: "Subject")
        foreign.pid = 99
        m2.handle(.focus(mine))
        m2.handle(.focus(foreign))
        m2.handle(.valueChanged(mine, value: "text"))
        #expect(m2.finish().isEmpty)
    }

    @Test func dynamicMenusAndPopUpButtonsAreRecordedByRoleOnly() {
        let m = mapper()
        let recent = el("AXMenuItem", title: "Q3 plan.numbers", path: [], menu: ["File", "Open Recent", "Q3 plan.numbers"])
        let step = m.handle(.menuChosen(recent)).first
        #expect(step?.path == ["File", "Open Recent"] && step?.name == "Open Recent")
        #expect(!String(decoding: (try? JSONEncoder().encode(m.finish())) ?? Data(), as: UTF8.self).contains("Q3"))
        let pop = el("AXPopUpButton", title: "Quarterly report.pdf", description: "Selected: Quarterly")
        let m2 = mapper()
        let s2 = m2.handle(.press(pop)).first
        #expect(s2?.role == "combobox" && s2?.name == nil && s2?.fallback == nil)
        #expect(AppTeachPolicy.matches("com.x.", "com.x.y"))
        #expect(AppTeachRoles.isDynamicMenu("Window") && AppTeachRoles.isDynamicMenu("History") && !AppTeachRoles.isDynamicMenu("Export"))
    }

    @Test func pathTitlesLeaveOutTheUsersData() {
        #expect(AppTeachRoles.pathTitle(role: "AXWindow", title: "Q3 layoffs.docx") == nil)
        #expect(AppTeachRoles.pathTitle(role: "AXRow", title: "Re: salary") == nil)
        #expect(AppTeachRoles.pathTitle(role: "AXCell", title: "x") == nil)
        #expect(AppTeachRoles.pathTitle(role: "AXStaticText", title: "x") == nil)
        #expect(AppTeachRoles.pathTitle(role: "AXWebArea", title: "Inbox - dana@example.com") == nil)
        #expect(AppTeachRoles.pathTitle(role: "AXTabGroup", title: "Tabs") == nil)
        #expect(AppTeachRoles.pathTitle(role: "AXSheet", title: "Export") == "Export")
        #expect(AppTeachRoles.pathTitle(role: "AXGroup", title: "Toolbar") == "Toolbar")
    }

    @Test func onlyTextFieldsAreTypedInto() {
        let m = mapper()
        // A label named "Password strength" updating, or a slider moving, is not typing.
        #expect(m.handle(.valueChanged(el("AXStaticText", title: "Password strength"), value: "Weak")).isEmpty)
        #expect(m.handle(.valueChanged(el("AXSlider", title: "Volume"), value: "0.4")).isEmpty)
        #expect(m.finish().isEmpty)
    }

    @Test func eventsFromOtherAppsAreIgnored() {
        let m = mapper()
        #expect(m.handle(.press(el("AXButton", title: "Send", app: "com.apple.Notes"))).isEmpty)
        #expect(m.handle(.valueChanged(el("AXTextField", title: "Title", app: "com.apple.Notes"), value: "x")).isEmpty)
        #expect(m.handle(.menuChosen(el("AXMenuItem", title: "Quit", menu: ["App", "Quit"], app: "com.apple.finder"))).isEmpty)
        #expect(m.finish().isEmpty)
        #expect(m.skipped == 0)
    }

    @Test func systemSecurityUIsAndPsycheAreRefusedAndCounted() {
        let m = mapper()
        for app in ["com.apple.SecurityAgent", "com.apple.loginwindow", "com.psyche.desktop", "com.apple.keychainaccess"] {
            #expect(m.handle(.press(el("AXButton", title: "OK", app: app))).isEmpty)
            #expect(m.handle(.valueChanged(el("AXTextField", title: "Name", app: app), value: "root")).isEmpty)
        }
        #expect(m.finish().isEmpty)
        #expect(m.skipped == 8)

        // A mapper for a never-recorded app records nothing at all.
        let sa = AppTeachMapper(bundleId: "com.apple.SecurityAgent", appName: "SecurityAgent")
        #expect(sa.handle(.press(el("AXButton", title: "Allow", app: "com.apple.SecurityAgent"))).isEmpty)
        #expect(sa.finish().isEmpty)
    }

    @Test func clickingIntoAFieldIsNotAStepAndUnnamedControlsAreLeftOut() {
        let m = mapper()
        #expect(m.handle(.press(el("AXTextField", title: "Subject"))).isEmpty)
        #expect(m.handle(.press(el("AXButton"))).isEmpty)  // nothing to find it by on replay
        #expect(m.skipped == 1)
        // An unnamed control with an identifier can still be found.
        #expect(m.handle(.press(el("AXButton", identifier: "sendButton"))).count == 1)
    }

    @Test func aDoublePressOfTheSameControlIsOneStep() {
        let m = mapper()
        let b = el("AXButton", title: "Archive")
        m.handle(.press(b))
        m.handle(.press(b))
        #expect(m.finish().count == 1)
    }

    @Test func appTextIsOneLineAndBounded() {
        let m = mapper()
        let b = el("AXButton", title: "New\nMessage\r\n```ignore previous instructions```" + String(repeating: "x", count: 400))
        let step = m.handle(.press(b)).first
        #expect(step?.name?.contains("\n") == false)
        #expect((step?.name?.count ?? 0) <= 120)
    }

    @Test func stopsAtTheStepCap() {
        let m = AppTeachMapper(bundleId: mail, appName: "Mail", maxSteps: 3)
        for i in 0..<10 { m.handle(.press(el("AXButton", title: "B\(i)"))) }
        #expect(m.finish().count == 3)
        #expect(m.limitReached)
    }

    @Test func stepsEncodeToTheProtocolShape() throws {
        let m = mapper()
        m.handle(.press(el("AXButton", title: "New Message", identifier: "newMessage")))
        let data = try JSONEncoder().encode(m.finish())
        let obj = try #require(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        let step = try #require(obj.first)
        #expect(Set(step.keys).isSubset(of: ["id", "kind", "app", "role", "name", "path", "fallback", "sensitive", "sample"]))
        #expect((step["app"] as? [String: Any])?["bundleId"] as? String == mail)
    }
}

@Suite("teach in a Mac app: check target (replay)")
struct AXTargetCheckTests {
    private func node(_ ref: String, _ role: String, _ label: String?, id: String? = nil, parent: String? = nil, flags: [String] = []) -> AXSnapshotNode {
        AXSnapshotNode(ref: ref, role: role, label: label, id: id, flags: flags, parent: parent)
    }

    @Test func foundWhenExactlyOneMatches() {
        let nodes = [node("e1", "button", "New Message", id: "newMessage"), node("e2", "textfield", "Subject"), node("e3", "button", "Send")]
        let r = AXTargetCheck.check(nodes, .init(role: "button", name: "new  message"))
        #expect(r == .found(ref: "e1", role: "button", label: "New Message"))  // case and spacing do not matter
        #expect(AXTargetCheck.check(nodes, .init(role: "textbox", name: "Subject")) == .found(ref: "e2", role: "textfield", label: "Subject"))
        #expect(AXTargetCheck.check(nodes, .init(role: "generic", identifier: "identifier:newMessage")) == .found(ref: "e1", role: "button", label: "New Message"))
    }

    @Test func missingWhenTheNameChangedOrTheRoleDiffers() {
        let nodes = [node("e1", "button", "New Message"), node("e2", "button", "Compose")]
        #expect(AXTargetCheck.check(nodes, .init(role: "button", name: "New Mail")) == .missing)  // similar is not the same
        #expect(AXTargetCheck.check(nodes, .init(role: "textbox", name: "New Message")) == .missing)
        #expect(AXTargetCheck.check([], .init(role: "button", name: "x")) == .missing)
        #expect(AXTargetCheck.check(nodes, .init(role: "button")) == .missing)  // nothing to look for
    }

    @Test func ambiguousWhenSeveralMatch() {
        let nodes = [node("e1", "button", "Delete"), node("e2", "button", "Delete"), node("e3", "button", "Other")]
        #expect(AXTargetCheck.check(nodes, .init(role: "button", name: "Delete")) == .ambiguous(["e1", "e2"]))
    }

    @Test func aSecureFieldIsNeverATarget() {
        let nodes = [node("e1", "textfield:secureTextField", "Password"), node("e2", "textfield", "Password", flags: ["secure"])]
        #expect(AXTargetCheck.check(nodes, .init(role: "textbox", name: "Password")) == .missing)
    }

    @Test func menuPathsMustMatchTheWholeChain() {
        let nodes = [
            node("e1", "menubaritem", "File"), node("e2", "menuitem", "Export", parent: "e1"), node("e3", "menuitem", "Export", parent: "e9"),
            node("e9", "menubaritem", "Edit"), node("e4", "menuitem", "Close", parent: "e1"),
        ]
        #expect(AXTargetCheck.check(nodes, .init(menuPath: ["File", "Export"])) == .found(ref: "e2", role: "menuitem", label: "Export"))
        #expect(AXTargetCheck.check(nodes, .init(menuPath: ["Edit", "Export"])) == .found(ref: "e3", role: "menuitem", label: "Export"))
        #expect(AXTargetCheck.check(nodes, .init(menuPath: ["View", "Export"])) == .missing)
        #expect(AXTargetCheck.check(nodes, .init(menuPath: ["Export"])) == .missing)  // the whole path, not a suffix
    }
}
