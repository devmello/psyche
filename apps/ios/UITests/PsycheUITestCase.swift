import XCTest

/// Base class for the UI flows. Each test launches the app on the in-memory `FixtureBackend`, so state
/// (answered approvals, sent messages) starts fresh every launch.
class PsycheUITestCase: XCTestCase {
    var app: XCUIApplication!
    var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    override func setUp() {
        continueAfterFailure = false
    }

    @discardableResult
    func launch(_ scenario: String = "live", extra: [String] = []) -> XCUIApplication {
        app = XCUIApplication()
        app.launchArguments = ["-psycheScenario", scenario] + extra
        app.launch()
        return app
    }

    // MARK: Finding things

    /// A tab of the tab bar (iPhone) or sidebar (iPad).
    func tab(_ name: String) -> XCUIElement {
        let bar = app.tabBars.buttons[name]
        if bar.exists { return bar }
        return app.buttons[name].firstMatch
    }

    func openTab(_ name: String, file: StaticString = #filePath, line: UInt = #line) {
        let element = tab(name)
        XCTAssertTrue(element.waitForExistence(timeout: 10), "tab \(name) missing", file: file, line: line)
        element.tap()
    }

    /// Any element whose label contains `text` (rows combine their children into one label).
    func match(_ text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    func waitFor(_ element: XCUIElement, _ timeout: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "expected \(element) to exist", file: file, line: line)
    }

    func waitGone(_ element: XCUIElement, _ timeout: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line) {
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element)
        XCTAssertEqual(XCTWaiter().wait(for: [gone], timeout: timeout), .completed, "expected \(element) to go away", file: file, line: line)
    }

    func waitEnabled(_ element: XCUIElement, _ timeout: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line) {
        let ok = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: element)
        XCTAssertEqual(XCTWaiter().wait(for: [ok], timeout: timeout), .completed, "expected \(element) to be enabled", file: file, line: line)
    }

    /// Swipes up until `element` exists and is hittable.
    func scrollTo(_ element: XCUIElement, maxSwipes: Int = 8) {
        var n = 0
        while !(element.exists && element.isHittable) && n < maxSwipes {
            app.swipeUp(velocity: .slow)
            n += 1
        }
    }

    /// A static text whose label starts with or equals `label` (section headers carry counts: "Needs you · 2").
    func text(_ label: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", label, label + " ·")).firstMatch
    }

    /// The chat composer: the only text field on a thread screen (its placeholder goes once it holds text).
    var composer: XCUIElement { app.textFields.firstMatch }

    /// The grabber every sheet shows; gone once the sheet has dismissed.
    var sheetGrabber: XCUIElement { app.buttons["Sheet Grabber"] }

    /// The Needs-you row for an item by title text.
    func needsYouRow(_ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
    }
}
