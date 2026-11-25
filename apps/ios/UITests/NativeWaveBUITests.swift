import XCTest

/// Wave B (Library, Search, Chat list): the toolbar controls present, and rows push and come back.
final class NativeWaveBUITests: PsycheUITestCase {
    private func leaseRow() -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "lease-2026.pdf")).firstMatch
    }

    private func openPlus() {
        launch()
        openTab("Library")
        let plus = app.buttons["Add to Library"]
        waitFor(plus)
        plus.tap()
    }

    func testPlusMenuListsEverySource() {
        openPlus()
        for source in ["Photos", "Files", "Scan document", "Voice memo"] { waitFor(app.buttons[source], 5) }
    }

    func testPhotosPickerPresents() {
        openPlus()
        app.buttons["Photos"].tap()
        waitFor(app.buttons["Cancel"].firstMatch, 10)
        app.buttons["Cancel"].firstMatch.tap()
    }

    func testFileImporterPresents() {
        openPlus()
        app.buttons["Files"].tap()
        waitFor(app.buttons["Cancel"].firstMatch, 10)
        app.buttons["Cancel"].firstMatch.tap()
    }

    func testVoiceMemoSheetPresents() {
        openPlus()
        app.buttons["Voice memo"].tap()
        waitFor(app.navigationBars["Voice memo"], 10)
        app.buttons["Cancel"].firstMatch.tap()
        waitGone(app.navigationBars["Voice memo"], 5)
    }

    func testFilterMenuAndContextMenu() {
        launch()
        openTab("Library")
        waitFor(leaseRow())
        app.buttons["Filter"].firstMatch.tap()
        waitFor(app.buttons["Images"].firstMatch, 5)
        app.buttons["Images"].firstMatch.tap()
        waitFor(match("Quartz sample.jpg"), 5)
        app.buttons["Filter"].firstMatch.tap()
        app.buttons["Documents"].firstMatch.tap()
        let row = leaseRow()
        waitFor(row)
        row.press(forDuration: 1.2)
        waitFor(app.buttons["Copy name"].firstMatch, 5)
        // Copy name only: never confirm the delete.
        app.buttons["Copy name"].firstMatch.tap()
    }

    func testLibraryRowOpensAndBackReturns() {
        launch()
        openTab("Library")
        let row = leaseRow()
        waitFor(row)
        row.tap()
        waitFor(app.buttons["Delete"].firstMatch, 10)
        app.navigationBars.buttons.firstMatch.tap()
        waitFor(app.buttons["Filter"].firstMatch, 10)
        waitFor(leaseRow(), 5)
    }

    func testSearchHitOpensAndBackReturns() {
        launch()
        openTab("Search")
        let field = app.searchFields.firstMatch
        waitFor(field)
        field.tap()
        field.typeText("Sam")
        if (field.value as? String) != "Sam" {
            field.buttons["Clear text"].tap()
            field.typeText("Sam")
        }
        waitFor(text("People"), 10)
        let hit = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Sam Ortiz")).firstMatch
        waitFor(hit)
        hit.tap()
        waitFor(app.staticTexts["Sam Ortiz"].firstMatch, 5)
        // A person hit is a cross-tab jump (the Router opens it in Memory), so Back lands on Memory's list.
        app.navigationBars.buttons["Back"].firstMatch.tap()
        waitFor(app.buttons["To-do"].firstMatch, 10)
    }

    func testChatRowOpensAndBackReturns() {
        launch()
        openTab("Chat")
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Q3 review")).firstMatch
        waitFor(row)
        row.tap()
        waitFor(composer, 20)
        if !isPad { app.navigationBars.buttons.firstMatch.tap() }
        waitFor(row, 10)
    }
}
