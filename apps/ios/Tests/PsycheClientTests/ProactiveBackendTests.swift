import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import Testing

@testable import PsycheClient

struct ProactiveBackendTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await GatewayBackendTests().live(configure)
    }

    @Test func feedMapsPostsAndKeepsOnlyReadableSources() async throws {
        let (backend, h) = try await live { g in
            g.on("feed.list") { _ in .success(.object([
                "posts": .array([
                    .object(["id": "p1", "title": "Heat pumps", "bodyMd": "Cheaper.", "createdAt": "2030-01-01T09:12:00Z", "feedback": "save",
                             "citations": .array([.object(["title": "Energy Weekly", "url": "https://example.com/a"]), .object(["title": "No link", "url": ""])])]),
                    .object(["id": "p2", "title": "Odd", "feedback": "a_new_kind_of_feedback"]),
                    .object(["title": "No id"]),
                ]),
                "nextBriefAt": "2030-01-02T07:00:00Z",
            ])) }
        }
        let feed = try await backend.feed()
        #expect(feed.cards.map(\.id) == ["p1", "p2"])
        #expect(feed.cards[0].feedback == .save)
        #expect(feed.cards[0].sources == [FeedSource(title: "Energy Weekly", url: "https://example.com/a")])
        #expect(feed.cards[1].feedback == nil && feed.cards[1].body.isEmpty)
        #expect(feed.nextBriefAt != nil)
    }

    @Test func feedbackSendsTheWireNameAndNullClears() async throws {
        let (backend, h) = try await live { g in
            g.on("feed.feedback") { _ in .success(.object([:])) }
        }
        try await backend.setFeedback(postID: "p1", .notInterested)
        try await backend.setFeedback(postID: "p1", nil)
        let calls = h.gateway.received.filter { $0.method == "feed.feedback" }
        #expect(calls.count == 2)
        #expect(calls[0].params?["feedback"]?.string == "not_interested")
        #expect(calls[1].params?["feedback"]?.isNull == true)
    }

    @Test func ideasKeepOnlyProposedAndDecisionsCarryTheReason() async throws {
        let (backend, h) = try await live { g in
            g.on("ideas.list") { _ in .success(.object(["ideas": .array([
                .object(["id": "i1", "kind": "automation", "title": "Friday digest", "bodyMd": "Weekly.", "effort": "5 min", "status": "proposed"]),
                .object(["id": "i2", "title": "Old", "status": "dismissed"]),
            ])])) }
            g.on("ideas.accept") { _ in .success(.object([:])) }
            g.on("ideas.dismiss") { _ in .success(.object([:])) }
        }
        let ideas = try await backend.ideas()
        #expect(ideas.map(\.id) == ["i1"])
        #expect(ideas[0].effort == "5 min")
        try await backend.acceptIdea(id: "i1")
        try await backend.dismissIdea(id: "i1", reason: .notNow)
        let dismiss = h.gateway.received.filter { $0.method == "ideas.dismiss" }
        #expect(dismiss.first?.params?["reason"]?.string == "not_now")
        #expect(h.gateway.received.filter { $0.method == "ideas.accept" }.first?.params?["ideaId"]?.string == "i1")
    }

    @Test func goalDetailCountsDoneMilestonesAsProgress() async throws {
        let (backend, h) = try await live { g in
            g.on("goals.get") { _ in .success(.object([
                "goal": .object(["id": "g1", "title": "Half marathon", "category": "health", "status": "active"]),
                "taskIds": .array(["t1", "t2"]),
                "milestones": .array([
                    .object(["id": "m1", "goalId": "g1", "title": "5 km", "doneAt": "2030-01-01T09:12:00Z"]),
                    .object(["id": "m2", "goalId": "g1", "title": "10 km", "doneAt": .null]),
                ]),
            ])) }
            g.on("goals.list") { _ in .success(.object(["goals": .array([
                .object(["id": "g1", "title": "Half marathon", "category": "health", "status": "active"]),
                .object(["title": "no id"]),
            ])])) }
        }
        #expect(try await backend.goals().map(\.id) == ["g1"])
        let detail = try await backend.goalDetail(id: "g1")
        #expect(detail.linkedTasks == 2)
        #expect(detail.milestones.map(\.done) == [true, false])
        #expect(detail.progress == 0.5)
    }

    @Test func goalWithoutMilestonesHasUnknownProgress() {
        let goal = GoalItem(id: "g", title: "t", category: "other", status: "active")
        #expect(GoalDetail(goal: goal).progress == nil)
        #expect(GoalDetail(goal: GoalItem(id: "g", title: "t", category: "other", status: "done")).progress == 1)
    }

    @Test func scheduledListsUpcomingSoonestFirstAndFillsRetryAt() async throws {
        let (backend, h) = try await live { g in
            g.on("scheduled.list") { _ in .success(.object(["timezone": "UTC", "items": .array([
                .object(["id": "a2", "title": "Later", "state": "active", "nextRunAt": "2030-01-03T09:00:00Z", "group": "owner"]),
                .object(["id": "a1", "title": "Sooner", "state": "active", "nextRunAt": "2030-01-02T09:00:00Z", "group": "routine"]),
                .object(["id": "a3", "title": "Paused", "state": "paused", "nextRunAt": "2030-01-02T08:00:00Z"]),
                .object(["id": "a4", "title": "Event", "state": "active", "nextRunAt": .null]),
            ])])) }
            g.on("scheduled.runs") { _ in .success(.object(["runs": .array([
                .object(["id": "r2", "automationId": "a1", "title": "Sooner", "state": "running", "startedAt": "2030-01-01T09:00:00Z"]),
                .object(["id": "r1", "automationId": "a2", "title": "Later", "state": "succeeded", "startedAt": "2030-01-01T08:00:00Z", "summary": "ok"]),
                .object(["id": "r0", "automationId": "a2", "title": "Odd", "state": "from_the_future", "startedAt": "2030-01-01T07:00:00Z"]),
            ])])) }
            g.on("automations.runs") { _ in .success(.object(["runs": .array([
                .object(["id": "r2", "retryAt": "2030-01-01T09:05:00Z"]),
            ])])) }
        }
        let overview = try await backend.scheduled()
        #expect(overview.upcoming.map(\.id) == ["a1", "a2"])
        #expect(overview.upcoming[0].isRoutine && !overview.upcoming[1].isRoutine)
        #expect(overview.runs.map(\.state) == [.running, .succeeded, .skipped])
        #expect(overview.runs[0].retryAt == WireFormat.date("2030-01-01T09:05:00Z"))
        #expect(overview.runs[1].retryAt == nil)
        // Only the running run is looked up for a retry time.
        #expect(h.gateway.received.filter { $0.method == "automations.runs" }.count == 1)
    }

    @Test func aFailedRetryLookupLeavesTheRunWithoutOne() async throws {
        let (backend, h) = try await live { g in
            g.on("scheduled.list") { _ in .success(.object(["items": .array([])])) }
            g.on("scheduled.runs") { _ in .success(.object(["runs": .array([
                .object(["id": "r2", "automationId": "a1", "title": "Run", "state": "running"]),
            ])])) }
        }
        let overview = try await backend.scheduled()
        #expect(overview.runs.count == 1 && overview.runs[0].retryAt == nil)
    }
}
