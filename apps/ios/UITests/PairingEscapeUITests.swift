import XCTest

/// The pairing screens that used to be dead ends: a refused Gateway, and the demo.
final class PairingEscapeUITests: PsycheUITestCase {
    func testRefusedGatewayCanBePairedAgain() {
        launch("mismatch")
        waitFor(app.staticTexts["pairing.refused.mismatch"])
        let pairAgain = app.buttons["Pair again"]
        waitFor(pairAgain)
        pairAgain.tap()
        // The confirmation names what is forgotten; its button is the last "Pair again" on screen.
        waitFor(match("Pair this phone again?"))
        app.buttons.matching(identifier: "Pair again").allElementsBoundByIndex.last?.tap()
        waitFor(app.staticTexts["pairing.scan.title"])
        XCTAssertFalse(app.staticTexts["pairing.refused.mismatch"].exists)
    }

    func testAChangedMacIdentityCanBePairedAgain() {
        launch("identityChanged")
        waitFor(app.staticTexts["pairing.refused.changed"])
        // "Try again" is the primary button; "Pair again" is behind a confirm.
        waitFor(app.buttons["Try again"])
        let pairAgain = app.buttons["Pair again"]
        waitFor(pairAgain)
        pairAgain.tap()
        waitFor(match("Pair this phone again?"))
        app.buttons.matching(identifier: "Pair again").allElementsBoundByIndex.last?.tap()
        waitFor(app.staticTexts["pairing.scan.title"])
    }

    private func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// A `psyche-pair:v2` link entered by hand (a Mac on the local network) is understood, and when that Mac can't be reached
    /// the first pairing shows why and offers Cancel instead of empty tabs. Uses the real client: the name below
    /// never answers.
    func testEnteredLanLinkParsesAndAnUnreachableMacCanBeCancelled() throws {
        let fields: [String: String] = [
            "gatewayUrl": "https://psyche-ui-test-nobody.local:7443",
            "gatewayKey": base64URL(Data(repeating: 5, count: 32)),
            "certPin": base64URL(Data(repeating: 9, count: 32)),
            "setupToken": "pst_" + base64URL(Data(repeating: 7, count: 32)),
            "hostName": "Studio Mac",
        ]
        let json = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        launch("")
        let enterCode = app.buttons["pairing.enter-code"]
        waitFor(enterCode, 15)
        enterCode.tap()
        let field = app.descendants(matching: .any)["pairing.code-field"]
        waitFor(field)
        field.tap()
        field.typeText("psyche-pair:v2:" + base64URL(json))
        app.buttons["pairing.code-connect"].tap()
        // The scheme-and-host check passed: the phone asks before it sends anything.
        waitFor(app.staticTexts["pairing.confirm.title"], 10)
        app.buttons["Connect"].tap()
        waitFor(app.staticTexts["pairing.unreachable"], 30)
        let cancel = app.buttons["Cancel"]
        waitFor(cancel)
        cancel.tap()
        waitFor(app.staticTexts["pairing.scan.title"], 10)
    }

    func testDemoCanBeLeftFromSettings() {
        launch("unpaired")
        let demo = app.buttons["Try the demo"]
        waitFor(demo)
        demo.tap()
        openSettings()
        let exit = app.buttons["Exit demo"]
        scrollTo(exit)
        exit.tap()
        waitFor(app.staticTexts["pairing.scan.title"], 15)
    }
}
