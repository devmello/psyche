import XCTest

final class HomeUITests: PsycheUITestCase {
    func testNeedsYouRowsExist() {
        launch()
        waitFor(text("Needs you"))
        waitFor(needsYouRow("Pay the electricity bill"))
        waitFor(needsYouRow("Which deck should I send to Dana?"))
    }

    func testApprovalAllowOnceArmedDismissesAndRemovesRow() {
        launch()
        let row = needsYouRow("Pay the electricity bill")
        waitFor(row)
        row.tap()
        waitFor(sheetGrabber)
        // The sheet shows the full arguments.
        for value in ["$84.20 USD", "PG&E", "pge.com/pay", "Card on file ··4417", "Fri, Nov 6"] {
            waitFor(text(value), 5)
        }
        let allow = app.buttons["Allow with Face ID"]
        waitFor(allow)
        // Arming takes 400 ms; wait past it.
        Thread.sleep(forTimeInterval: 0.6)
        waitEnabled(allow)
        allow.tap()
        waitGone(sheetGrabber, 8)
        waitFor(text("Needs you"))
        waitGone(needsYouRow("Pay the electricity bill"), 5)
        waitFor(needsYouRow("Which deck should I send to Dana?"))
    }

    func testApprovalDenyDismissesAndRemovesRow() {
        launch()
        let row = needsYouRow("Pay the electricity bill")
        waitFor(row)
        row.tap()
        let deny = app.buttons["Deny"]
        waitFor(deny)
        deny.tap()
        waitGone(sheetGrabber, 8)
        waitGone(needsYouRow("Pay the electricity bill"), 5)
    }

    func testQuestionOptionLeavesNeedsYou() {
        launch()
        let row = needsYouRow("Which deck should I send to Dana?")
        waitFor(row)
        row.tap()
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
