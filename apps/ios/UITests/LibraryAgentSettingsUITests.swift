import XCTest

final class LibraryUITests: PsycheUITestCase {
    func testSectionsSwitchOpenItemAndDelete() {
        launch()
        openTab("Library")
        waitFor(match("lease-2026.pdf"))
        for (section, item) in [("Images", "Quartz sample.jpg"), ("Artifacts", "Kitchen budget"), ("Downloads", "renters-policy-2026.pdf"), ("Documents", "lease-2026.pdf")] {
            app.buttons[section].firstMatch.tap()
            waitFor(match(item), 5)
        }
        let item = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "lease-2026.pdf")).firstMatch
        waitFor(item)
        item.tap()
        let delete = app.buttons["Delete"].firstMatch
        waitFor(delete, 10)
        tapWhenHittable(delete)
        waitFor(app.staticTexts["Delete this file?"].firstMatch, 5)
        tapWhenHittable(lastButton("Delete"))
        // Back on the list, the item is gone.
        waitFor(app.buttons["Documents"].firstMatch, 10)
        waitGone(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "lease-2026.pdf")).firstMatch, 5)
    }

    func testPlusMenuOpens() {
        launch()
        openTab("Library")
        let plus = app.buttons["Add to Library"]
        waitFor(plus)
        plus.tap()
        waitFor(app.buttons["Photos"], 5)
        waitFor(app.buttons["Files"], 5)
        waitFor(app.buttons["Scan document"], 5)
    }
}

final class AgentSheetUITests: PsycheUITestCase {
    private var avatar: XCUIElement { app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Open Psyche's activity")).firstMatch }

    func testSegmentsAndCancelRunningTask() {
        launch()
        waitFor(avatar)
        avatar.tap()
        let segments = app.segmentedControls.firstMatch
        waitFor(segments)
        for name in ["Approvals", "Upcoming", "Soul", "Activity"] {
            segments.buttons[name].tap()
        }
        waitFor(match("Drafting the Q3 review summary"), 5)
        app.buttons["Cancel"].firstMatch.tap()
        // "Keep running" is the dialog's cancel role, which iPhone draws as a tap-outside; "Cancel task" is the action.
        let confirm = app.buttons["Cancel task"]
        waitFor(confirm, 5)
        confirm.tap()
        // The running task leaves the sheet's Now list, so its Cancel button is gone.
        waitGone(app.buttons["Cancel"].firstMatch, 8)
    }
}

final class SettingsUITests: PsycheUITestCase {
    private func openSettings() {
        let avatar = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Open Psyche's activity")).firstMatch
        waitFor(avatar)
        // A context menu on a long press: slow runners need a longer press, and sometimes a second one.
        let item = app.buttons["Settings"].firstMatch
        for _ in 0..<2 where !item.waitForExistence(timeout: 0.5) {
            waitHittable(avatar)  // a sheet that is still dismissing covers it
            avatar.press(forDuration: 1.6)
            if item.waitForExistence(timeout: 5) { break }
        }
        waitFor(item, 5)
        item.tap()
        waitFor(app.navigationBars["Settings"], 5)
    }

    func testToggleKeepsStateAndRemoveConfirmationCancels() {
        launch()
        openSettings()
        let toggle = app.switches["Face ID for approvals"]
        scrollTo(toggle)
        waitFor(toggle)
        let before = toggle.value as? String
        toggle.switches.firstMatch.exists ? toggle.switches.firstMatch.tap() : toggle.tap()
        XCTAssertNotEqual(toggle.value as? String, before)
        let after = toggle.value as? String
        app.buttons["Done"].tap()
        waitGone(app.navigationBars["Settings"], 5)
        openSettings()
        let again = app.switches["Face ID for approvals"]
        scrollTo(again)
        XCTAssertEqual(again.value as? String, after)

        let remove = app.buttons["Remove this phone"]
        scrollTo(remove)
        remove.tap()
                waitFor(app.staticTexts["Remove this phone?"].firstMatch, 5)
        dismissPopover()  // Cancel
        waitGone(app.staticTexts["Remove this phone?"].firstMatch, 5)
        waitFor(app.navigationBars["Settings"], 5)
    }
}

final class InboxUITests: PsycheUITestCase {
    func testTappingAnItemMarksItRead() {
        launch()
        let inbox = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Inbox")).firstMatch
        waitFor(inbox)
        scrollTo(inbox)
        inbox.tap()
        let item = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Which deck should I send to Dana?")).firstMatch
        waitFor(item)
        XCTAssertEqual(item.value as? String, "Unread")
        item.tap()
        waitFor(sheetGrabber, 5)
        dismissSheetByDragging()
        waitGone(sheetGrabber, 5)
        let read = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Which deck should I send to Dana?")).firstMatch
        waitFor(read)
        XCTAssertEqual(read.value as? String, "Read")
    }
}

final class StatesUITests: PsycheUITestCase {
    func testAwayScenarioShowsBannerAndDisablesAnswering() {
        launch("away")
        waitFor(match("You're away from home"))
        // Home rows say why they can't be opened and are not buttons.
        waitFor(match("reconnect to answer"))
        XCTAssertFalse(needsYouRow("Pay the electricity bill").exists)
        // The agent sheet's Cancel is off too.
        let avatar = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Open Psyche's activity")).firstMatch
        avatar.tap()
        let cancel = app.buttons["Cancel"].firstMatch
        waitFor(cancel)
        XCTAssertFalse(cancel.isEnabled)
    }

    func testUnpairedShowsPairingAndTryItEntersTheApp() {
        launch("unpaired")
        waitFor(app.staticTexts["Pair with your Mac"].firstMatch)
        let tryIt = app.buttons["Try it without a Mac"]
        waitFor(tryIt)
        tryIt.tap()
        waitFor(tab("Chat"), 10)
        waitFor(needsYouRow("Pay the electricity bill"), 10)
    }
}

final class PadUITests: PsycheUITestCase {
    override func setUp() {
        super.setUp()
    }

    func testHomeShowsSidebarAndNeedsYou() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPad only")
        launch()
        waitFor(needsYouRow("Pay the electricity bill"))
        // iPad shows the tabs as a top bar or sidebar; either way every tab is reachable.
        for name in ["Home", "Chat", "Library", "Memory"] {
            XCTAssertTrue(tab(name).waitForExistence(timeout: 5), "\(name) missing")
        }
    }

    func testChatSplitViewShowsThreadsAndDetail() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPad only")
        launch()
        openTab("Chat")
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Q3 review")).firstMatch
        waitFor(row)
        row.tap()
        // The list stays on screen next to the open thread.
        waitFor(composer)
        XCTAssertTrue(row.exists, "thread list should stay beside the thread")
        let composerField = composer.frame
        XCTAssertGreaterThan(composerField.minX, row.frame.minX + 100)
    }
}
