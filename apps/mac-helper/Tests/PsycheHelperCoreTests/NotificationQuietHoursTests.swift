import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

private func calendar(_ tz: String) -> Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: tz)!
    return c
}

private func at(_ hour: Int, _ minute: Int, _ cal: Calendar) -> Date {
    cal.date(from: DateComponents(year: 2026, month: 10, day: 19, hour: hour, minute: minute))!
}

@Suite("quiet hours")
struct NotificationQuietHoursTests {
    let la = calendar("America/Los_Angeles")

    @Test func parsesStrictHHmm() {
        #expect(QuietHours.parse("00:00") == 0)
        #expect(QuietHours.parse("07:30") == 450)
        #expect(QuietHours.parse("23:59") == 1439)
        for bad in ["24:00", "7:30", "07:60", "0730", "07:3", "aa:bb", "", "07:30:00", "-1:00", "+7:30", "０７:３０"] {
            #expect(QuietHours.parse(bad) == nil, "\(bad)")
        }
    }

    @Test func sameDayWindow() {
        let q = QuietHours(start: "13:00", end: "15:00")!
        #expect(!q.contains(at(12, 59, la), calendar: la))
        #expect(q.contains(at(13, 0, la), calendar: la))  // start inclusive
        #expect(q.contains(at(14, 59, la), calendar: la))
        #expect(!q.contains(at(15, 0, la), calendar: la))  // end exclusive
    }

    @Test func overnightWindow() {
        let q = QuietHours(start: "22:00", end: "07:00")!
        #expect(!q.contains(at(21, 59, la), calendar: la))
        #expect(q.contains(at(22, 0, la), calendar: la))
        #expect(q.contains(at(23, 59, la), calendar: la))
        #expect(q.contains(at(0, 0, la), calendar: la))
        #expect(q.contains(at(6, 59, la), calendar: la))
        #expect(!q.contains(at(7, 0, la), calendar: la))
        #expect(!q.contains(at(12, 0, la), calendar: la))
    }

    @Test func emptyWindowIsDisabled() {
        let q = QuietHours(start: "08:00", end: "08:00")!
        #expect(q.isEmpty)
        for m in stride(from: 0, to: 1440, by: 7) { #expect(!q.contains(minuteOfDay: m)) }
    }

    @Test func usesTheCalendarsTimeZone() {
        let q = QuietHours(start: "22:00", end: "07:00")!
        let instant = at(23, 0, la)  // 23:00 in Los Angeles is 08:00 (DST) in Berlin
        #expect(q.contains(instant, calendar: la))
        #expect(!q.contains(instant, calendar: calendar("Europe/Berlin")))
    }

    @Test func quietHoursDowngradeEverythingIncludingApprovals() throws {
        for kind in [NotificationKind.approval, .inputNeeded, .taskFailed, .reminder] {
            var p = NotifyShowParams(id: "ntf_1", kind: kind, title: "T", body: "B")
            p.quietHours = NotifyQuietHoursParams(start: "22:00", end: "07:00")
            p.interruption = .timeSensitive
            p.sound = true
            let quiet = try NotificationPlan.make(p, now: at(2, 30, la), calendar: la)
            #expect(quiet.interruption == .passive)
            #expect(quiet.requestedInterruption == .timeSensitive)
            #expect(quiet.quietHoursApplied)
            #expect(!quiet.playSound)

            let awake = try NotificationPlan.make(p, now: at(9, 0, la), calendar: la)
            #expect(awake.interruption == .timeSensitive)
            #expect(!awake.quietHoursApplied && awake.playSound)
        }
    }

    @Test func noQuietHoursMeansNoDowngrade() throws {
        let p = NotifyShowParams(id: "ntf_1", kind: .approval, title: "T", body: "B")
        let plan = try NotificationPlan.make(p, now: at(3, 0, la), calendar: la)
        #expect(plan.interruption == .timeSensitive && !plan.quietHoursApplied)

        var empty = p
        empty.quietHours = NotifyQuietHoursParams(start: "00:00", end: "00:00")
        #expect(try !NotificationPlan.make(empty, now: at(3, 0, la), calendar: la).quietHoursApplied)
    }

    @Test func malformedQuietHoursAreInvalidParams() {
        var p = NotifyShowParams(id: "ntf_1", kind: .approval, title: "T", body: "B")
        p.quietHours = NotifyQuietHoursParams(start: "10pm", end: "07:00")
        #expect(throws: CapabilityError.self) { try NotificationPlan.make(p, now: at(3, 0, la), calendar: la) }
    }
}
