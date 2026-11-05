import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import PsycheProtocol
import Testing

private final class FakeSource: AppTeachSource, @unchecked Sendable {
    var onEvent: (@Sendable (AppTeachEvent, Date) -> Void)?
    var onEnd: (@Sendable () -> Void)?
    var started = false
    var stopped = false
    var bundle = ""
    let allow: Bool
    init(allow: Bool = true) { self.allow = allow }
    func start(bundleId: String, onEvent: @escaping @Sendable (AppTeachEvent, Date) -> Void, onEnd: @escaping @Sendable () -> Void) -> Bool {
        guard allow else { return false }
        self.onEvent = onEvent
        self.onEnd = onEnd
        bundle = bundleId
        started = true
        return true
    }
    func stop() { stopped = true }
    func send(_ e: AppTeachEvent) { onEvent?(e, Date()) }
}

private final class FakeIndicator: AppTeachIndicator, @unchecked Sendable {
    var shown: String?
    var hidden = 0
    var stop: (@Sendable () -> Void)?
    func show(appName: String, onStop: @escaping @Sendable () -> Void) {
        shown = appName
        stop = onStop
    }
    func hide() { hidden += 1 }
}

private let mail = "com.apple.mail"

private func button(_ title: String, app: String = mail) -> AppTeachElement {
    AppTeachElement(bundleId: app, appName: "Mail", role: "AXButton", title: title, path: ["Inbox"])
}

private func controller(
    source: FakeSource = FakeSource(), indicator: FakeIndicator = FakeIndicator(),
    settings: TierSettings = TierSettings(defaultValue: .ask, apps: [mail: .interact]), running: Bool = true, maxSeconds: Int = 900
) -> AppTeachController {
    AppTeachController(
        makeSource: { source }, indicator: indicator, settings: { settings },
        appName: { running && $0.lowercased() == mail ? "Mail" : nil }, maxSeconds: maxSeconds, log: HelperLog(echo: { _ in })
    )
}

@Suite("teach in a Mac app: controller", .serialized)
struct AppTeachControllerTests {
    @Test func recordsOneGrantedAppShowsTheIndicatorAndHandsOverOnce() throws {
        let source = FakeSource()
        let indicator = FakeIndicator()
        let teach = controller(source: source, indicator: indicator)
        let started = try teach.begin(bundleId: mail)
        #expect(started.app.name == "Mail" && source.started && source.bundle == mail)
        #expect(indicator.shown == "Mail")  // visible while it records
        #expect(teach.status()["active"] == true)
        #expect(throws: CapabilityError.self) { _ = try teach.begin(bundleId: mail) }  // one at a time

        source.send(.press(button("New Message")))
        source.send(.press(button("Other", app: "com.apple.Notes")))  // not the recorded app
        let out = try teach.collect()
        #expect(source.stopped && indicator.hidden == 1)
        #expect(out["endedBy"] == "stop" && out["app"]?["bundleId"] == "com.apple.mail")
        #expect(out["steps"]?.arrayValue?.count == 1)
        #expect(out["steps"]?.arrayValue?.first?["kind"] == "app_click")
        // Handed over once; the helper keeps nothing.
        #expect(throws: CapabilityError.self) { _ = try teach.collect() }
        #expect(teach.status()["active"] == false)
    }

    @Test func stopIsAlwaysAvailableFromTheIndicator() throws {
        let source = FakeSource()
        let indicator = FakeIndicator()
        let teach = controller(source: source, indicator: indicator)
        _ = try teach.begin(bundleId: mail)
        source.send(.press(button("Archive")))
        indicator.stop?()  // the menu-bar Stop
        #expect(source.stopped && teach.activeId == nil)
        // Steps stay until the owner's Stop in Psyche collects them.
        #expect(try teach.collect()["steps"]?.arrayValue?.count == 1)
    }

    @Test func refusesAppsThatAreNotGrantedOrNeverRecorded() {
        let none = controller(settings: TierSettings(defaultValue: .ask, apps: [:]))
        #expect(throws: CapabilityError.self) { _ = try none.begin(bundleId: mail) }
        for app in ["com.psyche.desktop", "com.apple.loginwindow", "com.apple.SecurityAgent", "com.apple.keychainaccess"] {
            let src = FakeSource()
            let granted = controller(source: src, settings: TierSettings(defaultValue: .interact, apps: [app: .interact]))
            do {
                _ = try granted.begin(bundleId: app)
                Issue.record("\(app) must be refused")
            } catch let e as CapabilityError {
                #expect(e.code == .policyDenied, "\(app)")
            } catch {
                Issue.record("\(error)")
            }
            #expect(!src.started)  // nothing was watched
        }
    }

    @Test func needsAccessibilityAndARunningApp() {
        let denied = controller(source: FakeSource(allow: false))
        #expect(throws: CapabilityError.self) { _ = try denied.begin(bundleId: mail) }
        #expect(denied.activeId == nil)
        let notRunning = controller(running: false)
        #expect(throws: CapabilityError.self) { _ = try notRunning.begin(bundleId: mail) }
    }

    @Test func theAppQuittingEndsTheRecordingAndKeepsWhatWasCaught() throws {
        let source = FakeSource()
        let indicator = FakeIndicator()
        let teach = controller(source: source, indicator: indicator)
        _ = try teach.begin(bundleId: mail)
        source.send(.press(button("Archive")))
        source.onEnd?()
        #expect(indicator.hidden == 1 && teach.status()["ended"] == "interrupted")
        #expect(try teach.collect()["endedBy"] == "interrupted")
    }

    @Test func limitAndTimeoutEnd() async throws {
        let source = FakeSource()
        let teach = controller(source: source)
        _ = try teach.begin(bundleId: mail)
        for i in 0..<250 { source.send(.press(button("B\(i)"))) }
        #expect(teach.status()["ended"] == "limit")
        let out = try teach.collect()
        #expect(out["steps"]?.arrayValue?.count == 200)

        let slow = controller(maxSeconds: 1)
        _ = try slow.begin(bundleId: mail)
        try await _Concurrency.Task.sleep(nanoseconds: 1_300_000_000)
        #expect(slow.status()["ended"] == "timeout")
    }

    @Test func cancelDropsEverything() throws {
        let source = FakeSource()
        let indicator = FakeIndicator()
        let teach = controller(source: source, indicator: indicator)
        _ = try teach.begin(bundleId: mail)
        source.send(.press(button("Archive")))
        #expect(teach.cancel())
        #expect(source.stopped && indicator.hidden == 1)
        #expect(throws: CapabilityError.self) { _ = try teach.collect() }
        #expect(!teach.cancel())
    }

    @Test func theCapabilitiesAreNeverStreamingAndNeedAccessibilityToStart() throws {
        let computer = ComputerUse(environment: [:], log: HelperLog(echo: { _ in }))
        let handlers = AppTeachCapabilities.make(controller(), computer: computer)
        let names = handlers.map(\.spec.name)
        #expect(names == ["teach.record.start", "teach.record.stop", "teach.record.cancel", "teach.record.status"])
        let start = try #require(handlers.first)
        #expect(start.spec.permissions == [.accessibility] && !start.spec.streaming)
        // No screenshot capability anywhere in the group.
        #expect(!names.contains { $0.contains("screenshot") })
    }
}
