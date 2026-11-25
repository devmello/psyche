import XCTest

/// The pairing screens that used to be dead ends: a refused Gateway, and the demo.
final class PairingEscapeUITests: PsycheUITestCase {
    func testRefusedGatewayCanBePairedAgain() {
        launch("mismatch")
        waitFor(match("This isn't your Gateway"))
        let pairAgain = app.buttons["Pair again"]
        waitFor(pairAgain)
        pairAgain.tap()
        // The confirmation names what is forgotten; its button is the last "Pair again" on screen.
        waitFor(match("Pair this phone again?"))
        app.buttons.matching(identifier: "Pair again").allElementsBoundByIndex.last?.tap()
        waitFor(match("Pair with your Mac"))
        XCTAssertFalse(match("This isn't your Gateway").exists)
    }

    func testAChangedMacIdentityCanBePairedAgain() {
        launch("identityChanged")
        waitFor(match("This Mac's identity changed."))
        let pairAgain = app.buttons["Pair again"]
        waitFor(pairAgain)
        pairAgain.tap()
        waitFor(match("Pair this phone again?"))
        app.buttons.matching(identifier: "Pair again").allElementsBoundByIndex.last?.tap()
        waitFor(match("Pair with your Mac"))
    }

    private func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// A pasted `psyche-pair:v2` link (a Mac on the local network) is understood, and when that Mac can't be reached
    /// the first pairing shows why and offers Cancel instead of empty tabs. Uses the real client: the name below
    /// never answers.
    func testPastedLanLinkParsesAndAnUnreachableMacCanBeCancelled() throws {
        let fields: [String: String] = [
            "gatewayUrl": "https://psyche-ui-test-nobody.local:7443",
            "gatewayKey": base64URL(Data(repeating: 5, count: 32)),
            "certPin": base64URL(Data(repeating: 9, count: 32)),
            "setupToken": "pst_" + base64URL(Data(repeating: 7, count: 32)),
            "hostName": "Studio Mac",
        ]
        let json = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        UIPasteboard.general.string = "psyche-pair:v2:" + base64URL(json)
        launch("")
        let paste = app.buttons["Paste a pairing link"]
        waitFor(paste, 15)
        paste.tap()
        // The scheme-and-host check passed: the phone asks before it sends anything.
        waitFor(match("Connect to Studio Mac?"), 10)
        app.buttons["Connect"].tap()
        waitFor(match("Can't reach your Mac at psyche-ui-test-nobody.local"), 30)
        let cancel = app.buttons["Cancel"]
        waitFor(cancel)
        cancel.tap()
        waitFor(match("Pair with your Mac"), 10)
    }

    func testDemoCanBeLeftFromSettings() {
        launch("unpaired")
        let demo = app.buttons["Try it without a Mac"]
        waitFor(demo)
        demo.tap()
        openSettings()
        let exit = app.buttons["Exit demo"]
        scrollTo(exit)
        exit.tap()
        waitFor(match("Pair with your Mac"), 15)
    }
}
