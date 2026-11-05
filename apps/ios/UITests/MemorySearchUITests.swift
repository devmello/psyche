import XCTest

final class MemoryUITests: PsycheUITestCase {
    private func segment(_ name: String) -> XCUIElement {
        app.segmentedControls.buttons[name]
    }

    func testSegmentsSwitch() {
        launch()
        openTab("Memory")
        waitFor(match("Pay rent"))
        segment("Work").tap()
        waitFor(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Kitchen remodel")).firstMatch)
        segment("People").tap()
        waitFor(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Sam Ortiz")).firstMatch)
        segment("To-do").tap()
        waitFor(match("Pay rent"))
    }

    func testCircleCheckMarksTodoDone() {
        launch()
        openTab("Memory")
        let check = app.buttons["Mark Pay rent done"]
        waitFor(check)
        check.tap()
        waitFor(app.buttons["Mark Pay rent not done"], 5)
    }

    func testSwipeTodoDone() {
        launch()
        openTab("Memory")
        let row = app.staticTexts["Book a dentist cleaning"]
        waitFor(row)
        row.swipeRight()
        let done = app.buttons["Done"]
        waitFor(done, 5)
        done.tap()
        waitFor(app.buttons["Mark Book a dentist cleaning not done"], 5)
    }

    func testOpenProjectAndPersonPagesThenBack() {
        launch()
        openTab("Memory")
        segment("Work").tap()
        let project = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Kitchen remodel")).firstMatch
        waitFor(project)
        project.tap()
        waitGone(segment("Work"), 5)
        app.navigationBars.buttons.firstMatch.tap()
        waitFor(segment("Work"))
        segment("People").tap()
        let person = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Sam Ortiz")).firstMatch
        waitFor(person)
        person.tap()
        waitGone(segment("People"), 5)
        app.navigationBars.buttons.firstMatch.tap()
        waitFor(segment("People"))
    }
}

final class SearchUITests: PsycheUITestCase {
    private func search(_ query: String) {
        openTab("Search")
        let field = app.searchFields.firstMatch
        waitFor(field)
        field.tap()
        field.typeText(query)
        // Typing into the system search field can drop the first characters; retype until it reads back.
        if (field.value as? String) != query {
            field.buttons["Clear text"].tap()
            field.typeText(query)
        }
        XCTAssertEqual(field.value as? String, query)
    }

    func testRentShowsAnswerAndGroupedHits() {
        launch()
        search("rent")
        waitFor(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "From your memory")).firstMatch, 10)
        waitFor(text("To-do"), 5)
        waitFor(text("Chats and files"), 5)
    }

    func testTodoHitLandsInMemory() {
        launch()
        search("rent")
        let hit = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Pay rent for November")).firstMatch
        waitFor(hit)
        hit.tap()
        waitFor(app.segmentedControls.buttons["To-do"], 5)
        // The Memory page is showing (its title); on iPad the floating tab bar can be hidden at this moment.
        waitFor(app.staticTexts["Memory"], 5)
    }

    func testPersonHitOpensPersonPage() {
        launch()
        search("Sam")
        waitFor(text("People"), 10)
        let hit = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Sam Ortiz")).firstMatch
        waitFor(hit)
        hit.tap()
        // The person page replaces the results.
        waitGone(text("People"), 5)
        waitFor(app.staticTexts["Sam Ortiz"].firstMatch, 5)
    }

    func testRecentSearchesShowAndClear() {
        launch()
        search("rent")
        waitFor(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "From your memory")).firstMatch)
        app.keyboards.buttons["search"].tap()  // submitting remembers the query
        app.searchFields.firstMatch.buttons["Clear text"].tap()
        waitFor(text("Recent searches"), 5)
        waitFor(app.buttons["rent"].firstMatch, 5)
        let clear = app.buttons["Clear"]
        waitFor(clear)
        clear.tap()
        waitGone(text("Recent searches"), 5)
    }

    /// Passages are read only after the explicit button; a chip opens the source (or says to open it on the Mac);
    /// the follow-up box sends the turn before it.
    func testAnswerFromPassagesThenChipThenFollowUp() {
        launch()
        search("rent")
        let chips = app.buttons.matching(identifier: "passage-chip")
        let button = app.buttons["answer-from-passages"]
        tapWhenHittable(button)
        let mail = chips.matching(NSPredicate(format: "label CONTAINS %@", "Re: November rent")).firstMatch
        waitFor(mail, 10)
        waitGone(button, 5)

        // A chip the phone may open: the passage text, read only.
        tapWhenHittable(mail)
        waitFor(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "bank switch settles")).firstMatch, 10)
        app.buttons["Done"].tap()

        // One it may not: says so.
        let notes = chips.matching(NSPredicate(format: "label CONTAINS %@", "Autopay and the bank")).firstMatch
        tapWhenHittable(notes)
        waitFor(match("Open on your Mac"), 10)
        app.buttons["Done"].tap()

        // The follow-up box.
        let field = app.textFields["follow-up-field"]
        tapWhenHittable(field)
        field.typeText("and autopay?")
        app.buttons["Ask follow-up"].tap()
        waitFor(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "comes back on December 1")).firstMatch, 10)
    }
}
