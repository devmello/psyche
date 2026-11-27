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

    /// Both More pages open and draw their navigation title. Never touches an approval.
    func testEveryMorePageOpens() {
        launch()
        continueAfterFailure = true
        let more = app.descendants(matching: .any)["home.more"].firstMatch
        scrollTo(more, maxSwipes: 12)
        waitFor(more)
        more.tap()
        for title in ["Notifications", "Scheduled tasks"] {
            let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
            tapWhenHittable(row)
            let bar = app.navigationBars[title]
            XCTAssertTrue(bar.waitForExistence(timeout: 8), "\(title) page did not open; bars: \(app.navigationBars.allElementsBoundByIndex.map { $0.identifier }) texts: \(app.staticTexts.allElementsBoundByIndex.prefix(6).map { $0.label })")
            if bar.exists { bar.buttons.firstMatch.tap() }
            waitFor(app.navigationBars["More"], 5)
        }
    }

    func testTodaySwipeSnoozeAndRunningContextMenu() {
        launch()
        let running = app.staticTexts["Drafting the Q3 review summary"]
        waitFor(running)
        running.press(forDuration: 1.2)
        waitFor(app.buttons["Watch"], 5)
        app.buttons["Watch"].tap()
        let row = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Rent is due Friday")).firstMatch
        scrollTo(row)
        waitFor(row)
        row.swipeLeft()
        let snooze = app.buttons["Snooze"].firstMatch
        waitFor(snooze, 5)
        snooze.tap()
        waitGone(row, 8)
    }

    func testMoreRowOpensTheMorePage() {
        launch()
        let more = app.descendants(matching: .any)["home.more"].firstMatch
        scrollTo(more, maxSwipes: 12)
        waitFor(more)
        more.tap()
        waitFor(text("Notifications"))
        waitFor(text("Scheduled tasks"))
        // At most three rows: the junk-drawer rows are gone.
        XCTAssertFalse(text("Feed").exists)
        XCTAssertFalse(text("Goals").exists)
    }
}
