import XCTest

final class LibraryUITests: PsycheUITestCase {
    func testSectionsSwitchOpenItemAndDelete() {
        launch()
        openTab("Library")
        waitFor(match("lease-2026.pdf"))
        for (section, item) in [("Images", "Quartz sample.jpg"), ("Artifacts", "Q3 review"), ("Downloads", "renters-policy-2026.pdf"), ("Documents", "lease-2026.pdf")] {
            // The sections sit behind the toolbar filter menu.
            app.buttons["Filter"].firstMatch.tap()
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
        waitFor(app.buttons["Filter"].firstMatch, 10)
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

extension PsycheUITestCase {
    /// The agent sheet's running-task row, scrolled into view (the sheet opens at a medium detent): Cancel is behind
    /// its trailing swipe.
    var runningTaskRow: XCUIElement {
        let title = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Drafting the Q3 review summary")).firstMatch
        _ = title.waitForExistence(timeout: 10)
        for _ in 0..<4 where !title.isHittable { app.swipeUp() }
        return title
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
        // Cancel is a swipe action on the running task's row (and in its context menu).
        runningTaskRow.swipeLeft()
        app.buttons["Cancel"].firstMatch.tap()
        // "Keep running" is the dialog's cancel role, which iPhone draws as a tap-outside; "Cancel task" is the action.
        let confirm = app.buttons["Cancel task"]
        waitFor(confirm, 5)
        confirm.tap()
        // The dialog closes once the Gateway took the cancel.
        waitGone(confirm, 8)
    }
}

final class SettingsUITests: PsycheUITestCase {
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
        app.navigationBars["Settings"].buttons["Done"].tap()
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
        let inbox = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Notifications")).firstMatch
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
        // The agent sheet's Cancel is gone too.
        let avatar = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Open Psyche's activity")).firstMatch
        avatar.tap()
        waitFor(app.staticTexts["Drafting the Q3 review summary"].firstMatch)
        let row = runningTaskRow
        let rowFrame = row.frame
        row.swipeLeft()
        // Away from home Cancel is not offered on the sheet's row (the live test above is the positive control; the
        // Home card behind the sheet has its own Cancel, so look only where the row is).
        let cancels = app.buttons.matching(identifier: "Cancel").allElementsBoundByIndex
        XCTAssertFalse(cancels.contains { $0.frame.intersects(rowFrame) })
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
