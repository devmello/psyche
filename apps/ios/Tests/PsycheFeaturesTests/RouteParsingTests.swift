import Testing

@testable import PsycheFeatures

/// `Route(appPath:)` for every route shape the Gateway's search writes (`routeOf` in packages/search/src/handlers.ts),
/// plus the Library and agent cases the phone maps or refuses. A nil means the host refuses the route.
@Suite struct RouteParsingTests {
    @Test(arguments: [
        // routeOf: thread, message, task, memory, library, feed, idea, goal, person/project
        ("/chat/t1", Route.thread(id: "t1")),
        ("/chat/t1?message=m1", Route.thread(id: "t1")),
        ("/agent/activity/task1", Route.task(id: "task1")),
        ("/agent/soul?file=memory%2Fnotes.md", Route.memoryFile(path: "memory/notes.md")),
        ("/agent/soul?file=SOUL.md", Route.memoryFile(path: "SOUL.md")),
        ("/library/all?item=abc", Route.file(id: "abc")),
        ("/library/all?item=mail%3Am1", Route.file(id: "mail:m1")),
        ("/library/all?item=mail:m1", Route.file(id: "mail:m1")),
        ("/library/documents?item=doc1", Route.file(id: "doc1")),
        ("/feed?post=p1", Route.feed),
        ("/ideas?idea=i1", Route.ideas),
        ("/goals/g1", Route.project(id: "g1")),
        ("/agent/soul?entity=e1", Route.entity(id: "e1")),
        ("/agent/soul?entity=ent_x", Route.entity(id: "ent_x")),
        // Existing shapes and refusals
        ("/library/file-9", Route.file(id: "file-9")),
        ("/library/all", nil),
        ("/library/all?item=", nil),
        ("/library/all?item=%ZZ", nil),
        ("/agent/soul", Route.memoryFiles),
        // A traversal, an absolute path, a backslash, an empty or dot segment, a control character, a bad % escape,
        // an empty value, or a query with neither key is refused.
        ("/agent/soul?file=..%2F..%2Fsecret", nil),
        ("/agent/soul?file=memory%2F..%2Fx.md", nil),
        ("/agent/soul?file=..", nil),
        ("/agent/soul?file=%2Fetc%2Fpasswd", nil),
        ("/agent/soul?file=memory%2F%2Fx", nil),
        ("/agent/soul?file=memory%5Cx", nil),
        ("/agent/soul?file=memory%2F.%2Fx", nil),
        ("/agent/soul?file=memory%2F%0Ax", nil),
        ("/agent/soul?file=%ZZ", nil),
        ("/agent/soul?file=", nil),
        ("/agent/soul?entity=", nil),
        ("/agent/soul?other=1", nil),
        ("/agent/activity", nil),
        ("/people/p2", Route.person(id: "p2")),
        ("/home", nil),
        ("", nil),
    ] as [(String, Route?)])
    func parsesGatewayRoutes(path: String, expected: Route?) {
        #expect(Route(appPath: path) == expected, "route \(path)")
    }

    @Test(arguments: [
        ("person", EntityPage.person), ("org", .person), ("project", .project),
        ("place", .other), ("event", .other), ("topic", .other), ("assignment", .other),
    ] as [(String, EntityPage)])
    func entityKindDecidesThePage(kind: String, expected: EntityPage) {
        #expect(EntityPage.page(for: kind) == expected, "kind \(kind)")
    }
}
