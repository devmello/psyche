import Testing

@testable import PsycheFeatures

/// Every `route:` path the Gateway emits (`/goals/<id>`, `/feed/<id>`, `/tasks/<id>`, `/agent/approvals`, …) and what
/// the phone opens for it. A nil is a route the phone refuses, and the caller opens Home.
@Suite struct EmittedRouteTests {
    @Test(arguments: [
        // Goal notifications (checkin, service, ideas) send /goals/<goalId>: the goal's sheet, not Memory's project.
        ("/goals/goal_1", Route.goal(id: "goal_1")),
        ("/goals/halfMarathon", Route.goal(id: "halfMarathon")),
        ("/goals", Route.goals),
        ("/goals?add=1", Route.goals),
        // Feed posts: daily brief, mail digest, meeting prep and notes.
        ("/feed/post_1", Route.feedPost(id: "post_1")),
        ("/feed", Route.feed),
        ("/feed?post=p1", Route.feed),
        // Tasks: compose, computer use and the Live Activity tap.
        ("/tasks/task_9", Route.task(id: "task_9")),
        ("/tasks/1", Route.task(id: "1")),
        ("/task/task_9", Route.task(id: "task_9")),
        ("/agent/activity/task_9", Route.task(id: "task_9")),
        ("/agent/approvals", Route.agentApprovals),
        // Home pages the Gateway also names.
        ("/inbox", Route.inbox),
        ("/scheduled", Route.scheduled),
        ("/overview", Route.overview),
        ("/overview#now", Route.overview),
        ("/ideas", Route.ideas),
        ("/agent/soul", Route.memoryFiles),
        ("/chat/thr_1", Route.thread(id: "thr_1")),
        // Routes the phone does not open: nil, so the caller falls back to Home.
        ("/settings/devices", nil),
        ("/memory/review", nil),
        ("/home/instructions", nil),
        ("/can-do", nil),
    ] as [(String, Route?)])
    func parsesEmittedRoutes(path: String, expected: Route?) {
        #expect(Route(appPath: path) == expected, "route \(path)")
    }
}
