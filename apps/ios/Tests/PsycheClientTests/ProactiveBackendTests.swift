import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
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

    @Test func generateFeedCallsFeedGenerateAndMapsThePosts() async throws {
        let (backend, h) = try await live { g in
            g.on("feed.generate") { _ in .success(.object(["posts": .array([
                .object(["id": "p9", "title": "Today", "bodyMd": "Made now.", "createdAt": "2030-01-01T07:00:00Z"]),
                .object(["title": "No id"]),
            ])])) }
        }
        let cards = try await backend.generateFeed()
        #expect(cards.map(\.id) == ["p9"])
        #expect(cards[0].body == "Made now.")
        #expect(h.gateway.received.filter { $0.method == "feed.generate" }.count == 1)
    }

    @Test func generateFeedWithNoPostsIsAnEmptyBrief() async throws {
        let (backend, _) = try await live { g in
            g.on("feed.generate") { _ in .success(.object(["posts": .array([])])) }
        }
        #expect(try await backend.generateFeed().isEmpty)
    }

    @Test func generateFeedShowsTheModelBudgetAsPlainWords() async throws {
        let (backend, _) = try await live { g in
            g.on("feed.generate") { _ in .failure(WireError(
                code: "rate_limited", message: "Too many requests from this device. Try again in 1 minute.",
                details: .object(["scope": .string("model_calls"), "reason": .string("model_budget"), "retryAfterMs": .number(120_000)]),
                retryable: true)) }
        }
        do {
            _ = try await backend.generateFeed()
            Issue.record("Expected the model budget refusal")
        } catch {
            #expect(error as? BackendError == .slowDown(minutes: 2))
        }
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

    @Test func pauseAndResumeSendTheItemAndReadTheStateBack() async throws {
        let (backend, h) = try await live { g in
            g.on("scheduled.pause") { req in
                .success(.object(["item": .object(["id": .string(req.params?["id"]?.string ?? ""), "state": .string(req.params?["paused"] == .bool(true) ? "paused" : "active")])]))
            }
        }
        #expect(try await backend.setScheduledPaused(id: "a1", paused: true) == "paused")
        #expect(try await backend.setScheduledPaused(id: "a1", paused: false) == "active")
        let calls = h.gateway.received.filter { $0.method == "scheduled.pause" }
        #expect(calls.map { $0.params?["id"]?.string } == ["a1", "a1"])
        #expect(calls.map { $0.params?["paused"] == .bool(true) } == [true, false])
    }

    @Test func aPauseTheGatewayRefusesShowsItsOwnWords() async throws {
        let (backend, _) = try await live { g in
            g.on("scheduled.pause") { _ in .failure(WireError(code: "forbidden", message: "This phone can't change schedules.")) }
        }
        await #expect(throws: BackendError.refused("This phone can't change schedules.")) {
            try await backend.setScheduledPaused(id: "a1", paused: true)
        }
    }

    @Test func runNowSendsTheAutomationId() async throws {
        let (backend, h) = try await live { g in
            g.on("automations.run") { _ in .success(.object(["runId": "run_9", "taskId": .null])) }
        }
        try await backend.runScheduledNow(id: "a1")
        let calls = h.gateway.received.filter { $0.method == "automations.run" }
        #expect(calls.count == 1)
        #expect(calls[0].params?["automationId"]?.string == "a1")
    }

    @Test func goalStatusChangeSendsTheWireNameAndReturnsTheGoal() async throws {
        let (backend, h) = try await live { g in
            g.on("goals.update") { _ in .success(.object([
                "goal": .object(["id": "g1", "title": "Half marathon", "category": "health", "status": "paused"]),
                "taskIds": .array([]),
                "milestones": .array([.object(["id": "m1", "title": "5 km", "doneAt": "2030-01-01T09:12:00Z"])]),
                "links": .array([]),
            ])) }
        }
        let detail = try await backend.setGoalStatus(id: "g1", .paused)
        #expect(detail.goal.status == "paused")
        #expect(detail.milestones.map(\.done) == [true])
        let call = h.gateway.received.filter { $0.method == "goals.update" }.first
        #expect(call?.params?["goalId"]?.string == "g1")
        #expect(call?.params?["status"]?.string == "paused")
    }

    @Test func scheduledItemsKeepPausedAndOffAndOnlyRoutinesWithoutApprovalsSkipTheConfirm() async throws {
        let (backend, _) = try await live { g in
            g.on("scheduled.list") { _ in .success(.object(["timezone": "UTC", "items": .array([
                .object(["id": "off1", "title": "Mail digest", "state": "off", "group": "routine"]),
                .object(["id": "p1", "title": "Expenses", "state": "paused", "group": "owner", "approvals": .array([])]),
                .object(["id": "r1", "title": "Brief", "state": "active", "group": "routine", "nextRunAt": "2030-01-02T09:00:00Z", "approvals": .array([])]),
                .object(["id": "r2", "title": "Mail", "state": "active", "group": "routine", "nextRunAt": "2030-01-03T09:00:00Z", "approvals": .array(["queued"])]),
                .object(["id": "x1", "title": "Odd", "state": "from_the_future", "group": "owner"]),
            ])])) }
            g.on("scheduled.runs") { _ in .success(.object(["runs": .array([])])) }
        }
        let overview = try await backend.scheduled()
        #expect(overview.items.map(\.id) == ["r1", "r2", "p1", "off1"])
        #expect(overview.upcoming.map(\.id) == ["r1", "r2"])
        #expect(overview.items.map(\.confirmsRunNow) == [false, true, true, false])
    }

    @Test func createGoalSendsTheTrimmedTitleAndCategoryAndDecodesTheGoal() async throws {
        let (backend, h) = try await live { g in
            g.on("goals.create") { _ in .success(.object([
                "goal": .object(["id": "g9", "title": "Read 12 books", "category": "learning", "status": "active"]),
                "taskIds": .array([]),
                "milestones": .array([]),
            ])) }
        }
        let detail = try await backend.createGoal(title: "  Read 12 books  ", category: .learning)
        #expect(detail.goal.id == "g9")
        #expect(detail.goal.status == "active")
        #expect(detail.goal.category == "learning")
        let sent = h.gateway.received.filter { $0.method == "goals.create" }
        #expect(sent.count == 1)
        #expect(sent.first?.params?["title"]?.string == "Read 12 books")
        #expect(sent.first?.params?["category"]?.string == "learning")
    }

    @Test func createGoalRefusalShowsTheGatewaysWords() async throws {
        let (backend, _) = try await live { g in
            g.on("goals.create") { _ in .failure(WireError(code: "forbidden", message: "This phone can't add goals.")) }
        }
        await #expect(throws: BackendError.refused("This phone can't add goals.")) {
            try await backend.createGoal(title: "Read", category: .other)
        }
    }

    @Test func decideSendsTheWireDecisionAndReturnsTheGoal() async throws {
        let (backend, h) = try await live { g in
            g.on("goals.decide") { _ in .success(.object([
                "goal": .object(["id": "g2", "title": "Save", "category": "finance", "status": "active"]),
            ])) }
        }
        let goal = try await backend.decideGoal(id: "g2", .confirm)
        #expect(goal.status == "active")
        let call = h.gateway.received.filter { $0.method == "goals.decide" }.first
        #expect(call?.params?["goalId"]?.string == "g2")
        #expect(call?.params?["decision"]?.string == "confirm")
    }

    @Test func archiveSendsTheGoalIdAndReturnsItArchived() async throws {
        let (backend, h) = try await live { g in
            g.on("goals.archive") { _ in .success(.object([
                "goal": .object(["id": "g1", "title": "Run", "category": "health", "status": "archived"]),
            ])) }
        }
        let goal = try await backend.archiveGoal(id: "g1")
        #expect(goal.status == "archived")
        #expect(h.gateway.received.filter { $0.method == "goals.archive" }.first?.params?["goalId"]?.string == "g1")
    }

    @Test func milestoneEditsSendTheRightFieldsForAddDoneAndRemove() async throws {
        let (backend, h) = try await live { g in
            g.on("goals.milestone") { _ in .success(.object([
                "goal": .object(["id": "g1", "title": "Run", "category": "health", "status": "active"]),
                "taskIds": .array([]),
                "milestones": .array([.object(["id": "m1", "title": "5 km", "doneAt": "2030-01-01T09:12:00Z"])]),
            ])) }
        }
        let detail = try await backend.changeMilestone(goalID: "g1", .add(title: "  Shoes ", dueAt: nil))
        #expect(detail.milestones.map(\.done) == [true])
        _ = try await backend.changeMilestone(goalID: "g1", .setDone(id: "m1", false))
        _ = try await backend.changeMilestone(goalID: "g1", .remove(id: "m1"))
        let sent = h.gateway.received.filter { $0.method == "goals.milestone" }
        #expect(sent.count == 3)
        #expect(sent[0].params?["milestoneId"] == nil)
        #expect(sent[0].params?["title"]?.string == "Shoes")
        #expect(sent[1].params?["milestoneId"]?.string == "m1")
        #expect(sent[1].params?["done"] == .bool(false))
        #expect(sent[2].params?["remove"] == .bool(true))
    }

    @Test func aRefusedMilestoneEditShowsTheGatewaysWords() async throws {
        let (backend, _) = try await live { g in
            g.on("goals.milestone") { _ in .failure(WireError(code: "forbidden", message: "This goal is archived.")) }
        }
        await #expect(throws: BackendError.refused("This goal is archived.")) {
            try await backend.changeMilestone(goalID: "g1", .remove(id: "m1"))
        }
    }
}
