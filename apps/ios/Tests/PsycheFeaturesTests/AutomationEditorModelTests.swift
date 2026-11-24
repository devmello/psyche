import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

@MainActor
struct AutomationEditorModelTests {
    private func seeded(kind: String = "cron", prompt: String = "Summarize the week") async throws -> (FixtureBackend, String) {
        let store = FixtureBackend()
        let id = try await store.createAutomation(AutomationCreate(
            kind: kind, title: "Digest", schedule: "30 9 * * 5", prompt: prompt, timezone: "America/Los_Angeles", enabled: true))
        return (store, id)
    }

    @Test func aNewAutomationNeedsAPromptBeforeItCanBeSaved() async {
        let model = AutomationEditorModel(store: FixtureBackend(), automationID: nil)
        await model.load()
        #expect(model.phase == .ready)
        #expect(model.isNew)
        #expect(!model.canSave)
        model.draft.prompt = "Summarize the week"
        #expect(model.canSave)
        model.draft.prompt = "   "
        #expect(!model.canSave)
    }

    @Test func aWeeklyScheduleWithNoDayStaysUnsavable() async {
        let model = AutomationEditorModel(store: FixtureBackend(), automationID: nil)
        await model.load()
        model.draft.prompt = "Summarize the week"
        model.draft.schedule.preset = .weekly
        model.draft.schedule.weekdays = []
        #expect(model.problems.schedule == .noDays)
        #expect(!model.canSave)
        model.draft.schedule.weekdays = [5]
        #expect(model.canSave)
    }

    @Test func savingANewAutomationCreatesIt() async throws {
        let store = FixtureBackend()
        let model = AutomationEditorModel(store: store, automationID: nil)
        await model.load()
        model.draft.prompt = "  Draft the standup.  "
        #expect(await model.save())
        let created = try await store.scheduled().items.first { $0.title == "Draft the standup." }
        #expect(created != nil)
    }

    @Test func editingSendsTheChangedTitleAndKeepsThePrompt() async throws {
        let (store, id) = try await seeded()
        let model = AutomationEditorModel(store: store, automationID: id)
        await model.load()
        #expect(model.phase == .ready)
        #expect(!model.isNew)
        model.draft.title = "Weekly digest"
        #expect(await model.save())
        let after = try await store.automation(id: id)
        #expect(after.title == "Weekly digest")
        #expect(after.prompt == "Summarize the week")
        #expect(after.schedule == "30 9 * * 5")
    }

    @Test func aTriggeredAutomationOpensReadOnly() async throws {
        let (store, id) = try await seeded(kind: "event")
        let model = AutomationEditorModel(store: store, automationID: id)
        await model.load()
        #expect(model.phase == .readOnly)
        #expect(!model.canSave)
    }

    @Test func deleteRemovesTheAutomation() async throws {
        let (store, id) = try await seeded()
        let model = AutomationEditorModel(store: store, automationID: id)
        await model.load()
        #expect(await model.delete())
        await #expect(throws: BackendError.notFound) { try await store.automation(id: id) }
    }

    @Test func anUnknownAutomationShowsItsFailure() async {
        let model = AutomationEditorModel(store: FixtureBackend(), automationID: "auto_missing")
        await model.load()
        #expect(model.phase == .failed(BackendError.notFound.localizedDescription))
    }

    @Test func theEmptyPromptHintWaitsForAnEdit() async {
        let model = AutomationEditorModel(store: FixtureBackend(), automationID: nil)
        await model.load()
        #expect(model.problems.prompt)
        #expect(!model.isPromptTouched)
        #expect(!model.showsPromptHint)
        model.draft.prompt = "   "
        #expect(model.isPromptTouched)
        #expect(model.showsPromptHint)
        model.draft.prompt = "Summarize the week"
        #expect(!model.showsPromptHint)
    }

    @Test func anOverLimitPromptShowsItsHintWithoutAnEdit() async throws {
        let long = String(repeating: "a", count: AutomationDraft.maxPrompt + 1)
        let (store, id) = try await seeded(prompt: long)
        let model = AutomationEditorModel(store: store, automationID: id)
        await model.load()
        #expect(!model.isPromptTouched)
        #expect(model.showsPromptHint)
        #expect(!model.canSave)
    }

}
