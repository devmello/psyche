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

    func testMemoryMenuItemsOpenAndBackReturns() {
        launch()
        openTab("Memory")
        waitFor(match("Pay rent"))
        let more = app.buttons["More"]
        for item in ["What Psyche learned", "To confirm", "Recent changes", "Held back", "Memory files"] {
            waitFor(more, 5)
            more.tap()
            let entry = app.buttons[item].firstMatch
            waitFor(entry, 5)
            entry.tap()
            waitGone(app.buttons["More"], 5)
            app.navigationBars.buttons.firstMatch.tap()
            waitFor(app.buttons["More"], 5)
        }
    }

    func testSettingsConnectionPageOpensAndBackReturns() {
        launch()
        openSettings()
        let connection = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Connection")).firstMatch
        waitFor(connection)
        connection.tap()
        waitFor(app.staticTexts["Fingerprint"].firstMatch, 5)
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
            openTab("Memory")
            waitFor(match("Pay rent"))
            shot("memory", mode)
            app.terminate()
            launch("live", extra: extra)
            // Settings and its Connection page
            openSettings()
            waitFor(app.navigationBars["Settings"], 5)
            shot("settings", mode)
            let connection = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Connection")).firstMatch
            if connection.waitForExistence(timeout: 5) {
                connection.tap()
                waitFor(app.staticTexts["Fingerprint"].firstMatch, 5)
                shot("connection", mode)
            }
            app.terminate()
            // Agent sheet
            launch("live", extra: extra)
            let avatar = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Open Psyche's activity")).firstMatch
            waitFor(avatar)
            avatar.tap()
            waitFor(match("Drafting the Q3 review summary"), 5)
            shot("agent", mode)
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
