import Foundation
import Testing

@testable import PsycheStore

/// The phone's "Next runs" preview, checked against the same rules as the Mac's nextRuns (schedule-form.ts).
struct AutomationNextRunsTests {
    private static func at(_ iso: String) -> Date {
        ISO8601DateFormatter().date(from: iso)!
    }

    @Test func dailyRunsKeepTheWallClockTimeAcrossTheSpringForwardChange() {
        // New York switches to daylight time on 2026-03-08. 09:00 local is 14:00 UTC before that and 13:00 UTC after.
        let zone = TimeZone(identifier: "America/New_York")!
        let now = Self.at("2026-03-07T17:00:00Z")  // Saturday 12:00 EST
        let schedule = AutomationSchedule(preset: .daily, minuteOfDay: 9 * 60)

        let runs = schedule.nextRuns(zone: zone, now: now)

        #expect(runs == [
            Self.at("2026-03-08T13:00:00Z"),
            Self.at("2026-03-09T13:00:00Z"),
            Self.at("2026-03-10T13:00:00Z"),
        ])
        // The day that loses an hour is 23 hours long, not 24: the wall-clock time holds, the gap does not.
        #expect(runs![1].timeIntervalSince(runs![0]) == 86_400)
    }

    @Test func weekdayRunsSkipTheWeekendAcrossTheWeekBoundary() {
        // Saturday noon UTC: the next weekday run is Monday, then Tuesday and Wednesday.
        let zone = TimeZone(identifier: "UTC")!
        let now = Self.at("2026-11-21T12:00:00Z")
        let schedule = AutomationSchedule(preset: .weekdays, minuteOfDay: 9 * 60)

        #expect(schedule.nextRuns(zone: zone, now: now) == [
            Self.at("2026-11-23T09:00:00Z"),
            Self.at("2026-11-24T09:00:00Z"),
            Self.at("2026-11-25T09:00:00Z"),
        ])
    }

    @Test func weeklyRunsOnlyOnTheChosenDaysAcrossTheWeekBoundary() {
        // Monday only: Saturday noon is before this week's Monday run, so the next three are one week apart.
        let zone = TimeZone(identifier: "UTC")!
        let now = Self.at("2026-11-21T12:00:00Z")
        let schedule = AutomationSchedule(preset: .weekly, minuteOfDay: 9 * 60, weekdays: [1])

        #expect(schedule.nextRuns(zone: zone, now: now) == [
            Self.at("2026-11-23T09:00:00Z"),
            Self.at("2026-11-30T09:00:00Z"),
            Self.at("2026-12-07T09:00:00Z"),
        ])
    }

    @Test func aRunTodayThatHasPassedIsSkipped() {
        let zone = TimeZone(identifier: "UTC")!
        let now = Self.at("2026-11-21T10:00:00Z")  // Saturday, after 09:00
        let schedule = AutomationSchedule(preset: .daily, minuteOfDay: 9 * 60)

        #expect(schedule.nextRuns(zone: zone, now: now)?.first == Self.at("2026-11-22T09:00:00Z"))
    }

    @Test func intervalRunsAreSpacedByTheChosenHours() {
        let now = Self.at("2026-11-21T12:00:00Z")
        let schedule = AutomationSchedule(preset: .interval, intervalHours: 6)

        #expect(schedule.nextRuns(zone: .current, now: now) == [
            Self.at("2026-11-21T18:00:00Z"),
            Self.at("2026-11-22T00:00:00Z"),
            Self.at("2026-11-22T06:00:00Z"),
        ])
    }

    @Test func oneTimeScheduleShowsItsInstantOnlyWhileItIsStillAhead() {
        let now = Self.at("2026-11-21T12:00:00Z")
        let ahead = AutomationSchedule(preset: .once, onceAt: Self.at("2026-11-22T08:30:40Z"))
        let gone = AutomationSchedule(preset: .once, onceAt: Self.at("2026-11-21T11:00:00Z"))

        // Seconds are dropped, as they are when the schedule is saved.
        #expect(ahead.nextRuns(zone: .current, now: now) == [Self.at("2026-11-22T08:30:00Z")])
        #expect(gone.nextRuns(zone: .current, now: now) == [])
    }

    @Test func noPreviewForACustomScheduleOrAnEmptyChoice() {
        let now = Self.at("2026-11-21T12:00:00Z")
        let custom = AutomationSchedule(preset: .custom, customText: "0 9 * * 1#2")
        let noDays = AutomationSchedule(preset: .weekly, minuteOfDay: 540, weekdays: [])
        let badHours = AutomationSchedule(preset: .interval, intervalHours: 0)

        #expect(custom.nextRuns(zone: .current, now: now) == nil)
        #expect(noDays.nextRuns(zone: .current, now: now) == nil)
        #expect(badHours.nextRuns(zone: .current, now: now) == nil)
    }
}

struct MemoryFactEditTests {
    @Test func aFactWithoutAnAttributeCannotBeEdited() {
        // The Gateway writes a value for one closed attribute, so a fact without one has no Edit. Forget still works.
        #expect(MemoryFact(id: "f1", text: "Likes tea", evidence: []).isEditable == false)
        #expect(MemoryFact(id: "f2", text: "Works at Acme", evidence: [], attribute: "employer").isEditable)
    }
}
