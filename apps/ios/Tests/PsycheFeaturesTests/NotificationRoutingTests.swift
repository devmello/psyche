import Testing

@testable import PsycheFeatures
@testable import PsycheStore

/// A notification row's route in Home > More > Notifications. The Inbox is pushed on Home, so a route that only
/// names Home (or nothing the phone knows) must pop back to Home's root, or the tap looks like it did nothing.
@MainActor
@Suite struct NotificationRoutingTests {
    private func routerWithInboxOpen() -> Router {
        let router = Router()
        router.tab = .home
        router.homePath = [.inbox]
        return router
    }

    @Test func approvalsRouteWithoutAnApprovalLandsOnHomeRoot() {
        let router = routerWithInboxOpen()
        router.open(appPath: "/agent/approvals")
        #expect(router.tab == .home)
        #expect(router.homePath.isEmpty)
    }

    @Test(arguments: ["/goals/goal_1", "/goals", "/ideas", "/nonsense/route", "/feed", ""])
    func unknownRoutesLandOnHomeRootAndLeaveTheInbox(path: String) {
        let router = routerWithInboxOpen()
        router.open(appPath: path)
        #expect(router.tab == .home)
        #expect(router.homePath.isEmpty, "route \(path)")
    }

    @Test func unknownRouteFromAnotherTabComesToHome() {
        let router = Router()
        router.tab = .library
        router.open(appPath: "/goals/g1")
        #expect(router.tab == .home)
        #expect(router.homePath.isEmpty)
    }

    @Test func feedPostOpensItsPageOnHome() {
        let router = routerWithInboxOpen()
        router.open(appPath: "/feed/post_1")
        #expect(router.tab == .home)
        #expect(router.homePath == [.feedItem(id: "post_1")])
    }

    @Test func routeThatPushesKeepsItsPage() {
        // Control: the reset is not unconditional, a route that pushes on Home still does.
        let router = Router()
        router.tab = .chat
        router.open(appPath: "/inbox")
        #expect(router.tab == .home)
        #expect(router.homePath == [.inbox])
    }

    @Test func approvalRowWithAnApprovalIDOpensThatApproval() async throws {
        let model = InboxModel(store: FixtureBackend())
        await model.load()
        let row = InboxItem(
            id: "n1", title: "Approve", body: "", kindLabel: "Approval", time: "9:12", needsYou: true,
            route: "/agent/approvals", needsYouID: "appr_electric")
        #expect(model.pending(for: row)?.id == "appr_electric")
        // Control: an approval nobody is waiting on is not offered; the route then lands on Home.
        let gone = InboxItem(
            id: "n2", title: "Approve", body: "", kindLabel: "Approval", time: "9:12", route: "/agent/approvals",
            needsYouID: "appr_missing")
        #expect(model.pending(for: gone) == nil)
    }

    @Test func feedPostPageFindsThePostOrSaysItIsGone() async {
        let known = FeedItemModel(id: "post_2", store: FixtureBackend())
        await known.load()
        guard case .loaded(let hit) = known.phase else { Issue.record("did not load"); return }
        #expect(hit?.title == "Your passport expires in 5 months")
        // Control: an id the feed does not hold loads as "gone", not as a failure.
        let missing = FeedItemModel(id: "missing", store: FixtureBackend())
        await missing.load()
        guard case .loaded(let none) = missing.phase else { Issue.record("did not load"); return }
        #expect(none == nil)
    }
}
