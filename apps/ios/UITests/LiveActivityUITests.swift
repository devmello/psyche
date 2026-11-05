import XCTest

final class LiveActivityUITests: PsycheUITestCase {
    /// Watch on a running task starts its Live Activity: the button becomes "Watching", and the task keeps
    /// advancing in the fixture script (Step 4 of 7 after a few seconds).
    func testWatchStartsALiveActivity() {
        launch()
        let watch = app.buttons["Watch"]
        scrollTo(watch)
        waitFor(watch)
        watch.tap()
        waitFor(app.staticTexts["Watching"], 5)
        waitFor(match("Step 4 of 7"), 15)
    }
}
