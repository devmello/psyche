import XCTest

/// Wave C: Memory's toolbar menu and Settings' Connection page open and Back returns, and each screen is
/// photographed in light, dark and the largest accessibility text size. The shots land in
/// `.claude/demo/ios-c/` of the worktree this file sits in. Nothing here taps Allow, Approve or a payment button.
final class WaveCScreensUITests: PsycheUITestCase {
    private var outDir: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()  // apps/ios
            .deletingLastPathComponent().deletingLastPathComponent()  // repo root
            .appendingPathComponent(".claude/demo/ios-c")
    }

    private func shot(_ name: String, _ mode: String) {
        try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        let png = app.screenshot().pngRepresentation
        try? png.write(to: outDir.appendingPathComponent("\(name)-\(mode).png"))
    }

    override func tearDown() {
        XCUIDevice.shared.appearance = .light
        super.tearDown()
    }

    // MARK: Navigation

    func testPeopleMenuHoldsOnlyTheEverydayItems() {
        launch()
        openTab("People")
        waitFor(match("Pay rent"))
        let more = app.buttons["More"]
        waitFor(more, 5)
        more.tap()
        waitFor(app.buttons["Remember this"].firstMatch, 5)
        for gone in ["What Psyche learned", "Recent changes", "Held back", "Memory files"] {
            XCTAssertFalse(app.buttons[gone].firstMatch.exists, "\(gone) should be Mac-only now")
        }
    }

    func testSettingsConnectionPageOpensAndBackReturns() {
        launch()
        openSettings()
        let connection = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Connected over")).firstMatch
        waitFor(connection)
        connection.tap()
        waitFor(app.staticTexts["Security code"].firstMatch, 5)
        app.navigationBars.buttons.firstMatch.tap()
        waitFor(app.navigationBars["Settings"], 5)
    }

    // MARK: Screenshots

    func testScreenshotsLightDarkAX5() {
        let modes: [(String, XCUIDevice.Appearance, [String])] = [
            ("light", .light, []),
            ("dark", .dark, []),
            ("ax5", .light, ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]),
        ]
        for (mode, appearance, extra) in modes {
            XCUIDevice.shared.appearance = appearance
            // Memory
            launch("live", extra: extra)
            openTab("People")
            waitFor(match("Pay rent"))
            shot("memory", mode)
            app.terminate()
            launch("live", extra: extra)
            // Settings and its Connection page
            openSettings()
            waitFor(app.navigationBars["Settings"], 5)
            shot("settings", mode)
            let connection = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Connected over")).firstMatch
            if connection.waitForExistence(timeout: 5) {
                connection.tap()
                waitFor(app.staticTexts["Security code"].firstMatch, 5)
                shot("connection", mode)
            }
            app.terminate()
            // Approval sheet (never answered) and question sheet
            launch("live", extra: extra)
            let approval = needsYouRow("Dentist cleaning")
            waitFor(approval)
            approval.tap()
            waitFor(sheetGrabber)
            shot("approval", mode)
            app.terminate()
            launch("live", extra: extra)
            let question = needsYouRow("Which deck should I send to Dana?")
            waitFor(question)
            question.tap()
            waitFor(sheetGrabber)
            shot("question", mode)
            app.terminate()
        }
    }
}
