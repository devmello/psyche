import Testing

@testable import PsycheFeatures

/// `Route(appPath:)` for every route shape the Gateway's search writes (`routeOf` in packages/search/src/handlers.ts),
/// plus the Library and agent cases the phone maps or refuses. A nil means the host refuses the route.
@Suite struct RouteParsingTests {
    @Test(arguments: [
        // routeOf: thread, message, task, memory, library, person/project
        ("/chat/t1", Route.thread(id: "t1")),
        ("/chat/t1?message=m1", Route.thread(id: "t1")),
        ("/agent/activity/task1", Route.task(id: "task1")),
        // The Soul and memory files are for the Mac: the phone lands on People.
        ("/agent/soul?file=memory%2Fnotes.md", Route.tab(.memory)),
        ("/agent/soul?file=SOUL.md", Route.tab(.memory)),
        ("/library/all?item=abc", Route.file(id: "abc")),
        ("/library/all?item=mail%3Am1", Route.file(id: "mail:m1")),
        ("/library/all?item=mail:m1", Route.file(id: "mail:m1")),
        ("/library/documents?item=doc1", Route.file(id: "doc1")),
        // Feed, Ideas and Goals are gone from the phone: the host opens Home.
        ("/feed?post=p1", nil),
        ("/ideas?idea=i1", nil),
        ("/goals/g1", nil),
        ("/agent/soul?entity=e1", Route.entity(id: "e1")),
        ("/agent/soul?entity=ent_x", Route.entity(id: "ent_x")),
        // Existing shapes and refusals
        ("/library/file-9", Route.file(id: "file-9")),
        ("/library/all", Route.tab(.library)),
        ("/library/all?item=", Route.tab(.library)),
        ("/library/all?item=%ZZ", Route.tab(.library)),
        ("/agent/soul", Route.tab(.memory)),
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
        ("/home", Route.tab(.home)),
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
