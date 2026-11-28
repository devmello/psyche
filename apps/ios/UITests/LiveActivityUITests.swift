import XCTest

final class LiveActivityUITests: PsycheUITestCase {
    /// Watch on a running task starts its Live Activity: the row says "Watching", and the task keeps
    /// advancing in the fixture script (Step 4 of 7 after a few seconds).
    func testWatchStartsALiveActivity() {
        launch()
        watchRunningTask()
        waitFor(match("Watching"), 5)
        waitFor(match("Step 4 of 7"), 15)
    }

    /// With Live Activities off, Watch says so (and stays "Watch") instead of doing nothing.
    func testWatchExplainsWhenLiveActivitiesAreOff() {
        launch()
        openSettings()
        let toggle = app.switches["Live Activities"]
        scrollTo(toggle)
        waitFor(toggle)
        if (toggle.value as? String) == "1" { toggle.switches.firstMatch.exists ? toggle.switches.firstMatch.tap() : toggle.tap() }
        XCTAssertEqual(toggle.value as? String, "0")
        app.buttons["Done"].tap()
        waitGone(app.navigationBars["Settings"], 5)

        watchRunningTask()
        waitFor(match("Live Activities are off"), 5)
        XCTAssertFalse(match("Watching").exists)
    }

    /// Watch is in the running task's context menu (long press), not a visible button.
    private func watchRunningTask() {
        let row = app.descendants(matching: .any).matching(identifier: "home.running.row").firstMatch
        scrollTo(row)
        waitFor(row)
        row.press(forDuration: 1.0)
        let watch = app.buttons["Watch"]
        waitFor(watch, 5)
        watch.tap()
    }
}
