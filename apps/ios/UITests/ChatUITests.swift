import XCTest

final class ChatUITests: PsycheUITestCase {
    private let replyEnd = "tell you on Home if that changes."

    private func openThread(_ title: String) {
        openTab("Chat")
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
        waitFor(row)
        row.tap()
        waitFor(composer, 20)
    }

    private func send(_ message: String) {
        composer.tap()
        composer.typeText(message)
        let send = app.buttons["Send"]
        waitEnabled(send)
        send.tap()
    }

    func testSendMessageStreamsAReply() {
        launch()
        openThread("Psyche, Main thread")
        send("What is on my plate today")
        waitFor(text("What is on my plate today"), 5)
        // The composer clears on send.
        XCTAssertNotEqual(composer.value as? String, "What is on my plate today")
        waitFor(match(replyEnd), 20)
    }

    func testStopCancelsAStreamingReply() {
        launch()
        openThread("Psyche, Main thread")
        send("Tell me about my week")
        let stop = app.buttons["Stop"]
        waitFor(stop, 5)
        stop.tap()
        waitGone(stop, 5)
        // A stopped reply never reaches its last words.
        Thread.sleep(forTimeInterval: 4)
        XCTAssertFalse(match(replyEnd).exists, "Stop should end the stream")
        // The composer is ready again.
        XCTAssertTrue(app.buttons["Send"].exists)
    }

    func testNewChatCreatesAThread() {
        launch()
        openTab("Chat")
        let new = app.buttons["New chat"].firstMatch
        waitFor(new)
        new.tap()
        waitFor(composer)
        XCTAssertTrue(app.navigationBars.staticTexts["New chat"].waitForExistence(timeout: 5) || match("New chat").exists)
        if !isPad {
            app.navigationBars.buttons.firstMatch.tap()
            waitFor(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "New chat")).firstMatch)
        }
    }

    /// A short horizontal drag inside a row (a full-width swipe can start on the sidebar edge on iPad).
    private func drag(_ row: XCUIElement, from: CGFloat, to: CGFloat) {
        if !isPad { to > from ? row.swipeRight() : row.swipeLeft(); return }
        row.coordinate(withNormalizedOffset: CGVector(dx: from, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: row.coordinate(withNormalizedOffset: CGVector(dx: to, dy: 0.5)))
    }

    func testSwipePinAndArchive() {
        launch()
        openTab("Chat")
        let lease = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Lease renewal questions")).firstMatch
        waitFor(lease)
        drag(lease, from: 0.25, to: 0.85)
        let pin = app.buttons["Pin"]
        waitFor(pin, 5)
        pin.tap()
        waitFor(app.images["Pinned"].firstMatch, 5)
        let trip = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Maya's visit")).firstMatch
        waitFor(trip)
        drag(trip, from: 0.85, to: 0.25)
        let archive = app.buttons["Archive"]
        waitFor(archive, 5)
        archive.tap()
        waitGone(trip, 5)
    }

    func testAttachMenuShowsSources() {
        launch()
        openThread("Psyche, Main thread")
        let plus = app.buttons["Add photo or file"]
        waitFor(plus)
        plus.tap()
        waitFor(app.buttons["Photos"], 5)
        waitFor(app.buttons["Files"], 5)
        // The simulator has no camera, so the menu leaves Camera out there.
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            waitFor(app.buttons["Camera"], 5)
        } else {
            XCTAssertFalse(app.buttons["Camera"].exists)
        }
    }

    func testQuestionCardInThreadShowsChosenOption() {
        launch()
        openThread("Q3 review")
        let option = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Q3-review-final.pdf")).firstMatch
        scrollTo(option)
        waitFor(option)
        waitFor(text("Psyche is asking"), 5)
        option.tap()
        waitFor(text("You answered"), 5)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Q3-review-final.pdf")).firstMatch.isSelected)
    }
}
