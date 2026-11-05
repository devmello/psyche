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

    /// With Live Activities off, Watch says so (and stays "Watch") instead of doing nothing.
    func testWatchExplainsWhenLiveActivitiesAreOff() {
        launch()
        // Settings opens from the moth avatar's menu.
        let avatar = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Open Psyche's activity")).firstMatch
        waitFor(avatar)
        let settings = app.buttons["Settings"].firstMatch
        for _ in 0..<2 where !settings.waitForExistence(timeout: 0.5) {
            waitHittable(avatar)
            avatar.press(forDuration: 1.6)
            if settings.waitForExistence(timeout: 5) { break }
        }
        settings.tap()
        let toggle = app.switches["Live Activities"]
        scrollTo(toggle)
        waitFor(toggle)
        if (toggle.value as? String) == "1" { toggle.switches.firstMatch.exists ? toggle.switches.firstMatch.tap() : toggle.tap() }
        XCTAssertEqual(toggle.value as? String, "0")
        app.buttons["Done"].tap()
        waitGone(app.navigationBars["Settings"], 5)

        let watch = app.buttons["Watch"]
        scrollTo(watch)
        tapWhenHittable(watch)
        waitFor(match("Live Activities are off"), 5)
        XCTAssertFalse(app.staticTexts["Watching"].exists)
    }
}
