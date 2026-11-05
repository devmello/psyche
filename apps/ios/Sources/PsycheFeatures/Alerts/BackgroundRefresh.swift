import Foundation
import PsycheStore
import SwiftUI
#if os(iOS)
import BackgroundTasks
#endif

extension EnvironmentValues {
    /// Live Activities and local notifications; nil in previews.
    @Entry var alerts: AlertCenter?
}

#if os(iOS)
/// Background checks without push. iOS decides when (and whether) to run an app refresh, typically a few
/// times a day for an app the owner opens often, so this is a best effort and the docs say so.
extension AlertCenter {
    /// The identifier in project.yml's `BGTaskSchedulerPermittedIdentifiers`.
    public static var refreshIdentifier: String { (Bundle.main.bundleIdentifier ?? "com.psyche.ios") + ".refresh" }

    /// Registers the handler. Must run before the app finishes launching (from `App.init`).
    public func registerBackgroundRefresh() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshIdentifier, using: nil) { task in
            nonisolated(unsafe) let task = task
            Task { @MainActor in self.runRefresh(task) }
        }
    }

    /// Asks iOS for a check-in in about fifteen minutes or later. Called when the app goes to the background.
    public func scheduleBackgroundRefresh() {
        guard !isFixtureMode else { return }
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private func runRefresh(_ task: BGTask) {
        scheduleBackgroundRefresh()  // the next one, first
        if isFixtureMode {
            task.setTaskCompleted(success: true)
            return
        }
        nonisolated(unsafe) let task = task
        let work = Task { @MainActor in
            await backgroundCheck()
            task.setTaskCompleted(success: !Task.isCancelled)
        }
        task.expirationHandler = { work.cancel() }
    }
}
#endif
