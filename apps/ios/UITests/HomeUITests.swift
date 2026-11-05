import XCTest

final class HomeUITests: PsycheUITestCase {
    func testNeedsYouRowsExist() {
        launch()
        waitFor(text("Needs you"))
        waitFor(needsYouRow("Pay the electricity bill"))
        waitFor(needsYouRow("Which deck should I send to Dana?"))
        waitFor(needsYouRow("Dentist cleaning"))
    }

    func testApprovalAllowOnceArmedDismissesAndRemovesRow() {
        launch()
        let row = needsYouRow("Dentist cleaning")
        waitFor(row)
        row.tap()
        waitFor(sheetGrabber)
        for value in ["Dentist cleaning", "Sat, Nov 7 · 10:00", "Personal"] {
            waitFor(text(value), 5)
        }
        let allow = app.buttons["Allow"]
        waitFor(allow)
        Thread.sleep(forTimeInterval: 0.6)  // past the 400 ms arming delay
        waitEnabled(allow)
        allow.tap()
        waitGone(sheetGrabber, 8)
        waitGone(needsYouRow("Dentist cleaning"), 5)
        waitFor(needsYouRow("Pay the electricity bill"))
    }

    /// The simulator has a passcode, so "Allow with Face ID" raises the system prompt. The test never gives
    /// presence; it proves the gate holds: "Checking…" shows and the approval stays open.
    func testPaymentApprovalStaysUntilPresenceIsGiven() {
        launch()
        let row = needsYouRow("Pay the electricity bill")
        waitFor(row)
        row.tap()
        waitFor(sheetGrabber)
        for value in ["$84.20 USD", "PG&E", "pge.com/pay", "Card on file ··4417", "Fri, Nov 6"] {
            waitFor(text(value), 5)
        }
        let allow = app.buttons["Allow with Face ID"]
        waitFor(allow)
        Thread.sleep(forTimeInterval: 0.6)
        waitEnabled(allow)
        allow.tap()
        waitFor(app.buttons["Checking…"], 5)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let close = springboard.buttons["Close"].firstMatch
        if close.waitForExistence(timeout: 3) { close.tap() }
        app.activate()
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertTrue(sheetGrabber.exists, "the approval must stay open without presence")
        XCTAssertFalse(app.staticTexts["Allowed. Your Mac has your answer."].exists)
    }

    func testApprovalDenyDismissesAndRemovesRow() {
        launch()
        let row = needsYouRow("Dentist cleaning")
        waitFor(row)
        row.tap()
        let deny = app.buttons["Deny"]
        waitFor(deny)
        deny.tap()
        waitGone(sheetGrabber, 8)
        waitGone(needsYouRow("Dentist cleaning"), 5)
    }

    func testQuestionOptionLeavesNeedsYou() {
        launch()
        let row = needsYouRow("Which deck should I send to Dana?")
        waitFor(row)
        row.tap()
        waitFor(sheetGrabber)
        let option = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Q3 review v3")).firstMatch
        waitFor(option)
        option.tap()
        let send = app.buttons["Send answer"]
        waitEnabled(send)
        send.tap()
        waitGone(sheetGrabber, 8)
        waitGone(needsYouRow("Which deck should I send to Dana?"), 5)
        waitFor(needsYouRow("Pay the electricity bill"))
    }

    func testAskPsycheFieldOpensChatWithDraft() {
        launch()
        let field = app.textFields["Ask Psyche anything"]
        waitFor(field)
        field.tap()
        field.typeText("What is on my plate today")
        field.typeText("\n")
        waitFor(composer)
        XCTAssertEqual(composer.value as? String, "What is on my plate today")
    }
}
