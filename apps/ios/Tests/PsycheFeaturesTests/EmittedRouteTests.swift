import Testing

@testable import PsycheFeatures

/// Every `route:` path the Gateway emits (`/tasks/<id>`, `/agent/approvals`, `/goals/<id>`, …) and what
/// the phone opens for it. A nil is a route the phone refuses, and the caller opens Home.
@Suite struct EmittedRouteTests {
    @Test(arguments: [
        // Goals, Feed posts and Ideas are not on the phone any more: nil, so the caller opens Home.
        ("/goals/goal_1", nil),
        ("/goals", nil),
        ("/goals?add=1", nil),
        ("/feed/post_1", nil),
        ("/feed", nil),
        ("/feed?post=p1", nil),
        ("/ideas", nil),
        // Tasks: compose, computer use and the Live Activity tap.
        ("/tasks/task_9", Route.task(id: "task_9")),
        ("/tasks/1", Route.task(id: "1")),
        ("/task/task_9", Route.task(id: "task_9")),
        ("/agent/activity/task_9", Route.task(id: "task_9")),
        // Approvals wait in Home's Needs you.
        ("/agent/approvals", Route.tab(.home)),
        // Home pages the Gateway also names.
        ("/inbox", Route.inbox),
        ("/scheduled", Route.scheduled),
        // Task history is the Past section of Scheduled tasks.
        ("/overview", Route.scheduled),
        ("/overview#now", Route.scheduled),
        ("/agent/soul", Route.tab(.memory)),
        ("/chat/thr_1", Route.thread(id: "thr_1")),
        // Tab roots the Gateway names.
        ("/home", Route.tab(.home)),
        ("/chat", Route.tab(.chat)),
        ("/memory", Route.tab(.memory)),
        ("/memory/review", Route.tab(.memory)),
        ("/search", Route.tab(.search)),
        ("/library/documents", Route.tab(.library)),
        ("/library/all", Route.tab(.library)),
        ("/library/downloads", Route.tab(.library)),
        // Spaces live on Home.
        ("/spaces", Route.tab(.home)),
        ("/spaces?new=1", Route.tab(.home)),
        ("/spaces#archived", Route.tab(.home)),
        ("/spaces/s1", Route.space(id: "s1")),
        // Settings: the sheet, for every section (the phone has no section pages).
        ("/settings", Route.settings),
        ("/settings/devices", Route.settings),
        ("/settings/model", Route.settings),
        ("/settings/connectors", Route.settings),
        ("/settings/connectors/add-mcp", Route.settings),
        ("/settings/channels/ch1", Route.settings),
        ("/settings/browser", Route.settings),
        // Routes the phone does not open: nil, so the caller falls back to Home.
        ("/home/instructions", nil),
        ("/can-do", nil),
        ("/onboarding", nil),
    ] as [(String, Route?)])
    func parsesEmittedRoutes(path: String, expected: Route?) {
        #expect(Route(appPath: path) == expected, "route \(path)")
    }
}
