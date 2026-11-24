import Foundation
import Testing

@testable import PsycheStore

struct AutomationEditingTests {
    static let la = TimeZone(identifier: "America/Los_Angeles")!
    /// 2030-01-01T00:00:00Z. Times below are worked out from this instant.
    static let now = Date(timeIntervalSince1970: 1_893_456_000)

    // MARK: Schedule strings

    @Test func presetsWriteTheSameStringsAsTheMacForm() {
        #expect(AutomationSchedule(preset: .daily, minuteOfDay: 9 * 60 + 30).wire(zone: Self.la, now: Self.now, editingKind: nil)
            == .success(AutomationWireSchedule(kind: "cron", schedule: "30 9 * * *")))
        #expect(AutomationSchedule(preset: .weekdays, minuteOfDay: 8 * 60).wire(zone: Self.la, now: Self.now, editingKind: nil)
            == .success(AutomationWireSchedule(kind: "cron", schedule: "0 8 * * 1-5")))
        #expect(AutomationSchedule(preset: .weekly, minuteOfDay: 9 * 60, weekdays: [5, 1, 3, 1]).wire(zone: Self.la, now: Self.now, editingKind: nil)
            == .success(AutomationWireSchedule(kind: "cron", schedule: "0 9 * * 1,3,5")))
        #expect(AutomationSchedule(preset: .interval, intervalHours: 6).wire(zone: Self.la, now: Self.now, editingKind: nil)
            == .success(AutomationWireSchedule(kind: "interval", schedule: "PT6H")))
    }

    @Test func aOneTimeScheduleWritesAnOffsetInstantInTheZone() {
        // 2030-01-02 09:00 in Los Angeles is 17:00 UTC, 8 hours behind UTC in winter.
        let tomorrowNine = Date(timeIntervalSince1970: 1_893_603_600 + 30)
        let wire = AutomationSchedule(preset: .once, onceAt: tomorrowNine).wire(zone: Self.la, now: Self.now, editingKind: nil)
        #expect(wire == .success(AutomationWireSchedule(kind: "reminder", schedule: "2030-01-02T09:00:00-08:00")))
    }

    @Test func aOneTimeScheduleAlreadyPastIsRefused() {
        let past = Date(timeIntervalSince1970: Self.now.timeIntervalSince1970 - 3600)
        #expect(AutomationSchedule(preset: .once, onceAt: past).wire(zone: Self.la, now: Self.now, editingKind: nil) == .failure(.past))
    }

    // MARK: Once defaults and the Repeats choices

    @Test func theNextWholeHourIsInTheAutomationsZone() {
        // 2030-01-01T00:20Z is 16:20 in Los Angeles: the next whole hour is 17:00 there, 01:00Z.
        let twentyPast = Date(timeIntervalSince1970: Self.now.timeIntervalSince1970 + 20 * 60)
        #expect(AutomationSchedule.nextWholeHour(now: twentyPast, zone: Self.la) == Date(timeIntervalSince1970: 1_893_459_600))
        // On the hour itself the next whole hour is the one after.
        #expect(AutomationSchedule.nextWholeHour(now: Self.now, zone: Self.la) == Date(timeIntervalSince1970: 1_893_459_600))
    }

    @Test func aNewOneTimeScheduleDefaultsToAWholeHourNotTheEpoch() {
        let onceAt = AutomationSchedule().onceAt
        #expect(onceAt > Date())
        #expect(Calendar.current.component(.minute, from: onceAt) == 0)
        #expect(onceAt.timeIntervalSince1970 > 0)
    }

    @Test func aRepeatingAutomationNeverOffersOnce() {
        #expect(AutomationSchedule.choices(editingKind: "cron", current: .daily) == [.daily, .weekdays, .weekly, .interval])
        #expect(AutomationSchedule.choices(editingKind: "interval", current: .interval) == [.daily, .weekdays, .weekly, .interval])
    }

    @Test func aOneTimeAutomationOffersOnlyOnce() {
        #expect(AutomationSchedule.choices(editingKind: "reminder", current: .once) == [.once])
    }

    @Test func aNewAutomationOffersAllPresetsAndACustomOnlyWhenItIsOne() {
        #expect(AutomationSchedule.choices(editingKind: nil, current: .daily) == [.once, .daily, .weekdays, .weekly, .interval])
        #expect(AutomationSchedule.choices(editingKind: "cron", current: .custom) == [.daily, .weekdays, .weekly, .interval, .custom])
    }

    // MARK: Prompt problems

    @Test func anEmptyPromptAndAnOverLimitPromptAreDifferentProblems() {
        #expect(AutomationDraft(prompt: "   ", schedule: AutomationSchedule()).promptProblem == .empty)
        #expect(AutomationDraft(prompt: String(repeating: "p", count: AutomationDraft.maxPrompt + 1), schedule: AutomationSchedule())
            .promptProblem == .tooLong)
        #expect(AutomationDraft(prompt: String(repeating: "p", count: AutomationDraft.maxPrompt), schedule: AutomationSchedule())
            .promptProblem == nil)
        #expect(AutomationDraft(prompt: "Do it", schedule: AutomationSchedule()).promptProblem == nil)
    }

    @Test func aWeeklyScheduleNeedsADay() {
        #expect(AutomationSchedule(preset: .weekly, weekdays: []).wire(zone: Self.la, now: Self.now, editingKind: nil) == .failure(.noDays))
    }

    @Test func anIntervalOutsideOneToOneSixtyEightHoursIsRefused() {
        #expect(AutomationSchedule(preset: .interval, intervalHours: 0).wire(zone: Self.la, now: Self.now, editingKind: nil) == .failure(.hours))
        #expect(AutomationSchedule(preset: .interval, intervalHours: 169).wire(zone: Self.la, now: Self.now, editingKind: nil) == .failure(.hours))
        #expect(AutomationSchedule(preset: .interval, intervalHours: 168).wire(zone: Self.la, now: Self.now, editingKind: nil)
            == .success(AutomationWireSchedule(kind: "interval", schedule: "PT168H")))
    }

    @Test func aOneTimeAndARepeatingAutomationCannotSwapKinds() {
        #expect(AutomationSchedule(preset: .daily).wire(zone: Self.la, now: Self.now, editingKind: "reminder") == .failure(.switchKind))
        #expect(AutomationSchedule(preset: .once, onceAt: Date(timeIntervalSince1970: Self.now.timeIntervalSince1970 + 3600))
            .wire(zone: Self.la, now: Self.now, editingKind: "cron") == .failure(.switchKind))
    }

    @Test func aCustomScheduleKeepsItsTextAndKind() {
        #expect(AutomationSchedule(preset: .custom, customText: "  0 9 * * 1  ").wire(zone: Self.la, now: Self.now, editingKind: "cron")
            == .success(AutomationWireSchedule(kind: "cron", schedule: "0 9 * * 1")))
        #expect(AutomationSchedule(preset: .custom, customText: "   ").wire(zone: Self.la, now: Self.now, editingKind: "cron") == .failure(.emptyCustom))
    }

    // MARK: Reading a schedule back

    @Test func aStoredScheduleReadsBackToItsPreset() {
        #expect(AutomationSchedule.from(kind: "cron", schedule: "30 9 * * *", zone: Self.la).preset == .daily)
        #expect(AutomationSchedule.from(kind: "cron", schedule: "30 9 * * *", zone: Self.la).minuteOfDay == 9 * 60 + 30)
        #expect(AutomationSchedule.from(kind: "cron", schedule: "0 8 * * 1-5", zone: Self.la).preset == .weekdays)
        let weekly = AutomationSchedule.from(kind: "cron", schedule: "0 9 * * 1,3,5", zone: Self.la)
        #expect(weekly.preset == .weekly)
        #expect(weekly.weekdays == [1, 3, 5])
        #expect(AutomationSchedule.from(kind: "interval", schedule: "PT6H", zone: Self.la).intervalHours == 6)
    }

    @Test func aOneTimeStoredScheduleReadsBackToTheSameInstant() {
        let once = AutomationSchedule.from(kind: "reminder", schedule: "2030-01-02T09:00:00-08:00", zone: Self.la)
        #expect(once.preset == .once)
        #expect(once.onceAt == Date(timeIntervalSince1970: 1_893_603_600))
    }

    @Test func anythingElseIsKeptAsCustom() {
        for (kind, text) in [("cron", "*/5 * * * *"), ("cron", "0 9 * * 7"), ("interval", "PT200H"), ("reminder", "not a date"), ("watch", "inbox")] {
            let read = AutomationSchedule.from(kind: kind, schedule: text, zone: Self.la)
            #expect(read.preset == .custom, "\(kind) \(text)")
            #expect(read.customText == text)
        }
    }

    // MARK: Draft validation

    @Test func aDraftNeedsAPromptAndAShortEnoughTitle() {
        let blank = AutomationDraft(prompt: "   ", schedule: AutomationSchedule())
        #expect(blank.problems(zone: Self.la, now: Self.now, editingKind: nil).prompt)
        #expect(!blank.problems(zone: Self.la, now: Self.now, editingKind: nil).isEmpty)

        let longTitle = AutomationDraft(title: String(repeating: "t", count: 201), prompt: "Do it", schedule: AutomationSchedule())
        #expect(longTitle.problems(zone: Self.la, now: Self.now, editingKind: nil).title)

        let exact = AutomationDraft(title: String(repeating: "t", count: 200), prompt: "Do it", schedule: AutomationSchedule())
        #expect(exact.problems(zone: Self.la, now: Self.now, editingKind: nil).isEmpty)

        let longPrompt = AutomationDraft(prompt: String(repeating: "p", count: 20_001), schedule: AutomationSchedule())
        #expect(longPrompt.problems(zone: Self.la, now: Self.now, editingKind: nil).prompt)
    }

    @Test func aDraftWithAScheduleProblemStaysUnsavedAndNamesIt() {
        let draft = AutomationDraft(prompt: "Do it", schedule: AutomationSchedule(preset: .weekly, weekdays: []))
        #expect(draft.problems(zone: Self.la, now: Self.now, editingKind: nil).schedule == .noDays)
        #expect(draft.create(zone: Self.la, now: Self.now) == .failure(draft.problems(zone: Self.la, now: Self.now, editingKind: nil)))
    }

    @Test func theTitleIsThePromptsFirstLineWhenBlank() {
        let draft = AutomationDraft(prompt: "  Summarize the week\nand send it  ", schedule: AutomationSchedule())
        #expect(draft.effectiveTitle == "Summarize the week")
        let long = AutomationDraft(prompt: String(repeating: "a", count: 120), schedule: AutomationSchedule())
        #expect(long.effectiveTitle.count == 80)
        #expect(AutomationDraft(title: " Digest ", prompt: "x", schedule: AutomationSchedule()).effectiveTitle == "Digest")
    }

    @Test func aNewAutomationIsCreatedWithTheTrimmedPromptAndTheZone() throws {
        let draft = AutomationDraft(prompt: "  Draft my standup.  ", schedule: AutomationSchedule(preset: .weekdays, minuteOfDay: 9 * 60), enabled: false)
        let create = try draft.create(zone: Self.la, now: Self.now).get()
        #expect(create == AutomationCreate(
            kind: "cron", title: "Draft my standup.", schedule: "0 9 * * 1-5", prompt: "Draft my standup.",
            timezone: "America/Los_Angeles", enabled: false))
    }

    // MARK: Changes

    static let existing = AutomationDetail(
        id: "auto_1", kind: "cron", title: "Friday digest", prompt: "Summarize the week's mail.", schedule: "30 9 * * 5",
        timezone: "America/Los_Angeles", enabled: true)

    @Test func anUnchangedDraftSendsNoChanges() throws {
        let changes = try AutomationDraft(Self.existing).changes(from: Self.existing, now: Self.now).get()
        #expect(changes.isEmpty)
    }

    @Test func aRenameSendsOnlyTheTitle() throws {
        var draft = AutomationDraft(Self.existing)
        draft.title = "Weekly digest"
        let changes = try draft.changes(from: Self.existing, now: Self.now).get()
        #expect(changes == AutomationChanges(title: "Weekly digest"))
    }

    @Test func whitespaceAroundThePromptIsNotAChange() throws {
        var draft = AutomationDraft(Self.existing)
        draft.prompt = "  Summarize the week's mail.\n"
        #expect(try draft.changes(from: Self.existing, now: Self.now).get().isEmpty)
    }

    @Test func aDisableAndAScheduleChangeSendOnlyThoseFields() throws {
        var draft = AutomationDraft(Self.existing)
        draft.enabled = false
        draft.schedule = AutomationSchedule(preset: .daily, minuteOfDay: 9 * 60 + 30)
        let changes = try draft.changes(from: Self.existing, now: Self.now).get()
        #expect(changes == AutomationChanges(schedule: "30 9 * * *", enabled: false))
    }

    @Test func aStoredOneTimeScheduleThatHasPassedBlocksTheSave() {
        let gone = AutomationDetail(
            id: "auto_2", kind: "reminder", title: "Renew", prompt: "Renew the passport", schedule: "2029-06-01T09:00:00-08:00",
            timezone: "America/Los_Angeles", enabled: true)
        let draft = AutomationDraft(gone)
        #expect(draft.changes(from: gone, now: Self.now) == .failure(AutomationDraftProblems(schedule: .past)))
    }

    @Test func aTriggeredAutomationIsNotAFormKind() {
        let event = AutomationDetail(
            id: "auto_3", kind: "event", title: "Mail", prompt: "Watch mail", schedule: "", timezone: "UTC", enabled: true)
        #expect(!event.isFormKind)
    }
}
