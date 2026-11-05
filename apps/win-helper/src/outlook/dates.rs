//! Outlook dates. The object model speaks OLE automation dates (`VT_DATE`: days since
//! 1899-12-30 as an `f64`, no zone). Most of them are local wall-clock time (`Start`,
//! `ReceivedTime`, `DueDate`, `Birthday`); a few are UTC (`StartUTC`, `EndUTC`). The wire is UTC
//! ISO 8601. Everything here is pure except `WindowsZone` and the filter-string formatter, so the
//! arithmetic is unit-tested with fixed and DST zones.

use crate::node::time::{civil_from_days, days_from_civil};

pub const MS_PER_DAY: i64 = 86_400_000;
const MS_PER_MINUTE: i64 = 60_000;
/// 1899-12-30 is 25 569 days before 1970-01-01.
const OLE_EPOCH_OFFSET_DAYS: i64 = 25_569;

/// Outlook's "None" date is 4501-01-01 (949 998.0); anything from 4500 on means "no date".
pub fn is_none_date(ole: f64) -> bool {
    !ole.is_finite() || ole >= 949_633.0
}

/// The OLE value Outlook uses for "no date".
pub const NONE_DATE: f64 = 949_998.0;

/// OLE date → milliseconds since the Unix epoch of the same wall clock ("naive": the zone is
/// whatever the OLE value was in), rounded to the second. Negative OLE values keep a positive
/// time of day (-1.25 is 1899-12-29 06:00), as OLE defines them.
pub fn ole_to_naive_ms(v: f64) -> Option<i64> {
    if !v.is_finite() || v.abs() > 3_000_000.0 {
        return None;
    }
    let days = v.trunc();
    let secs_of_day = ((v - days).abs() * 86_400.0).round() as i64;
    Some((days as i64 - OLE_EPOCH_OFFSET_DAYS) * MS_PER_DAY + secs_of_day * 1000)
}

/// Inverse of `ole_to_naive_ms`.
pub fn naive_ms_to_ole(ms: i64) -> f64 {
    let days = ms.div_euclid(MS_PER_DAY) + OLE_EPOCH_OFFSET_DAYS;
    let frac = ms.rem_euclid(MS_PER_DAY) as f64 / MS_PER_DAY as f64;
    if days >= 0 {
        days as f64 + frac
    } else {
        days as f64 - frac
    }
}

/// The machine's local time zone (Outlook's object model uses it for every local date).
pub trait LocalZone: Send + Sync {
    /// Local wall-clock ms → UTC ms. A wall-clock time skipped by a DST change maps forward.
    fn to_utc(&self, local_ms: i64) -> i64;
    /// UTC ms → local wall-clock ms.
    fn to_local(&self, utc_ms: i64) -> i64;
}

/// A zone with a constant offset from UTC (tests; also what UTC itself is).
#[derive(Debug, Clone, Copy)]
pub struct FixedZone {
    pub offset_minutes: i64,
}

impl LocalZone for FixedZone {
    fn to_utc(&self, local_ms: i64) -> i64 {
        local_ms - self.offset_minutes * MS_PER_MINUTE
    }
    fn to_local(&self, utc_ms: i64) -> i64 {
        utc_ms + self.offset_minutes * MS_PER_MINUTE
    }
}

/// Local OLE date → UTC ms (None for Outlook's "no date").
pub fn local_ole_to_utc_ms(ole: f64, zone: &dyn LocalZone) -> Option<i64> {
    if is_none_date(ole) {
        return None;
    }
    ole_to_naive_ms(ole).map(|ms| zone.to_utc(ms))
}

/// UTC OLE date (`StartUTC`) → UTC ms.
pub fn utc_ole_to_ms(ole: f64) -> Option<i64> {
    if is_none_date(ole) {
        return None;
    }
    ole_to_naive_ms(ole)
}

/// UTC ms → local OLE date (what `Start`, `ReminderTime` and filter strings take).
pub fn utc_ms_to_local_ole(utc_ms: i64, zone: &dyn LocalZone) -> f64 {
    naive_ms_to_ole(zone.to_local(utc_ms))
}

/// `(year, month, day)` of a naive ms value.
pub fn ymd(naive_ms: i64) -> (i64, u32, u32) {
    civil_from_days(naive_ms.div_euclid(MS_PER_DAY))
}

/// Naive ms of midnight on a date.
pub fn midnight(y: i64, m: u32, d: u32) -> i64 {
    days_from_civil(y, m, d) * MS_PER_DAY
}

/// The local calendar day (as naive midnight ms) that contains `utc_ms`.
pub fn local_day(utc_ms: i64, zone: &dyn LocalZone) -> i64 {
    zone.to_local(utc_ms).div_euclid(MS_PER_DAY) * MS_PER_DAY
}

/// Whether two instants fall on the same local calendar day.
pub fn same_local_day(a_utc: i64, b_utc: i64, zone: &dyn LocalZone) -> bool {
    local_day(a_utc, zone) == local_day(b_utc, zone)
}

/// All-day event bounds as local naive midnights: the start's local day, and the end's local day
/// rounded up to the next midnight, at least one day after the start (Outlook needs an all-day
/// event to end at a midnight after it starts).
pub fn all_day_bounds(start_utc: i64, end_utc: i64, zone: &dyn LocalZone) -> (i64, i64) {
    let start = local_day(start_utc, zone);
    let end_local = zone.to_local(end_utc);
    let mut end = end_local.div_euclid(MS_PER_DAY) * MS_PER_DAY;
    if end < end_local {
        end += MS_PER_DAY;
    }
    (start, end.max(start + MS_PER_DAY))
}

/// The local window for `Items.Restrict` (minute precision: from floored, to rounded up), so the
/// restriction never drops an event the exact UTC overlap test keeps.
pub fn restrict_window(from_utc: i64, to_utc: i64, zone: &dyn LocalZone) -> (i64, i64) {
    let from = zone.to_local(from_utc).div_euclid(MS_PER_MINUTE) * MS_PER_MINUTE;
    let to_local = zone.to_local(to_utc);
    let mut to = to_local.div_euclid(MS_PER_MINUTE) * MS_PER_MINUTE;
    if to < to_local {
        to += MS_PER_MINUTE;
    }
    // A DST change inside the window can shift either end by up to an hour: widen by a day each
    // side and let `overlaps` decide.
    (from - MS_PER_DAY, to + MS_PER_DAY)
}

/// The exact window test `calendar.list_events` applies after the coarse restriction: events
/// overlapping `[from, to)`, plus zero-length events inside it.
pub fn overlaps(start: i64, end: i64, from: i64, to: i64) -> bool {
    if start == end {
        return start >= from && start < to;
    }
    start < to && end > from
}

/// The live zone: Windows' current dynamic time zone (DST rules per year).
pub struct WindowsZone;

mod win {
    use windows::Win32::Foundation::SYSTEMTIME;
    use windows::Win32::System::Time::{
        DYNAMIC_TIME_ZONE_INFORMATION, GetDynamicTimeZoneInformation,
        SystemTimeToTzSpecificLocalTimeEx, TzSpecificLocalTimeToSystemTimeEx,
    };

    use super::*;

    pub fn to_systemtime(ms: i64) -> SYSTEMTIME {
        let (y, m, d) = ymd(ms);
        let rem = ms.rem_euclid(MS_PER_DAY);
        let dow = (ms.div_euclid(MS_PER_DAY) + 4).rem_euclid(7); // 1970-01-01 was a Thursday
        SYSTEMTIME {
            wYear: y.clamp(1601, 30_827) as u16,
            wMonth: m as u16,
            wDayOfWeek: dow as u16,
            wDay: d as u16,
            wHour: (rem / 3_600_000) as u16,
            wMinute: (rem % 3_600_000 / 60_000) as u16,
            wSecond: (rem % 60_000 / 1000) as u16,
            wMilliseconds: (rem % 1000) as u16,
        }
    }

    pub fn from_systemtime(st: &SYSTEMTIME) -> i64 {
        midnight(st.wYear as i64, st.wMonth as u32, st.wDay as u32)
            + st.wHour as i64 * 3_600_000
            + st.wMinute as i64 * 60_000
            + st.wSecond as i64 * 1000
            + st.wMilliseconds as i64
    }

    fn zone() -> DYNAMIC_TIME_ZONE_INFORMATION {
        let mut tz = DYNAMIC_TIME_ZONE_INFORMATION::default();
        // SAFETY: plain query into a local struct.
        unsafe { GetDynamicTimeZoneInformation(&mut tz) };
        tz
    }

    impl LocalZone for WindowsZone {
        fn to_utc(&self, local_ms: i64) -> i64 {
            let tz = zone();
            let local = to_systemtime(local_ms);
            let mut utc = SYSTEMTIME::default();
            // SAFETY: valid SYSTEMTIME pointers.
            match unsafe { TzSpecificLocalTimeToSystemTimeEx(Some(&tz), &local, &mut utc) } {
                Ok(()) => from_systemtime(&utc),
                // Outside the SYSTEMTIME range: fall back to the zone's standard bias.
                Err(_) => local_ms + tz.Bias as i64 * 60_000,
            }
        }

        fn to_local(&self, utc_ms: i64) -> i64 {
            let tz = zone();
            let utc = to_systemtime(utc_ms);
            let mut local = SYSTEMTIME::default();
            // SAFETY: valid SYSTEMTIME pointers.
            match unsafe { SystemTimeToTzSpecificLocalTimeEx(Some(&tz), &utc, &mut local) } {
                Ok(()) => from_systemtime(&local),
                Err(_) => utc_ms - tz.Bias as i64 * 60_000,
            }
        }
    }

    /// A local naive time as Outlook's `Restrict` parses it: the user's short date and time
    /// without seconds (what VBA's `Format(d, "ddddd h:nn AMPM")` produces in the docs' examples).
    pub fn filter_date_string(naive_ms: i64) -> String {
        use windows::Win32::Globalization::{
            DATE_SHORTDATE, GetDateFormatEx, GetTimeFormatEx, TIME_NOSECONDS,
        };
        use windows::core::PCWSTR;
        let st = to_systemtime(naive_ms);
        let mut date = [0u16; 128];
        let mut time = [0u16; 64];
        // SAFETY: fixed buffers; the user default locale (null name).
        let (dn, tn) = unsafe {
            (
                GetDateFormatEx(
                    PCWSTR::null(),
                    DATE_SHORTDATE,
                    Some(&st),
                    PCWSTR::null(),
                    Some(&mut date),
                    PCWSTR::null(),
                ),
                GetTimeFormatEx(
                    PCWSTR::null(),
                    TIME_NOSECONDS,
                    Some(&st),
                    PCWSTR::null(),
                    Some(&mut time),
                ),
            )
        };
        let s = |b: &[u16], n: i32| String::from_utf16_lossy(&b[..(n.max(1) as usize - 1)]);
        format!("{} {}", s(&date, dn), s(&time, tn))
    }
}

pub use win::filter_date_string;

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::node::time::parse_iso8601_millis;

    /// A zone with DST between two UTC instants (tests only).
    pub struct DstZone {
        pub std_minutes: i64,
        pub dst_minutes: i64,
        pub dst_from_utc: i64,
        pub dst_to_utc: i64,
    }

    impl LocalZone for DstZone {
        fn to_local(&self, utc_ms: i64) -> i64 {
            let off = if utc_ms >= self.dst_from_utc && utc_ms < self.dst_to_utc {
                self.dst_minutes
            } else {
                self.std_minutes
            };
            utc_ms + off * MS_PER_MINUTE
        }
        fn to_utc(&self, local_ms: i64) -> i64 {
            // Try standard first; if that instant is in DST, use the DST offset.
            let as_std = local_ms - self.std_minutes * MS_PER_MINUTE;
            if as_std >= self.dst_from_utc && as_std < self.dst_to_utc {
                local_ms - self.dst_minutes * MS_PER_MINUTE
            } else {
                as_std
            }
        }
    }

    fn ms(s: &str) -> i64 {
        parse_iso8601_millis(s).unwrap()
    }

    /// US Eastern 2026: DST from 2026-03-08 07:00Z to 2026-11-01 06:00Z.
    pub fn eastern() -> DstZone {
        DstZone {
            std_minutes: -300,
            dst_minutes: -240,
            dst_from_utc: ms("2026-03-08T07:00:00Z"),
            dst_to_utc: ms("2026-11-01T06:00:00Z"),
        }
    }

    #[test]
    fn ole_dates_round_trip() {
        assert_eq!(ole_to_naive_ms(25_569.0), Some(0));
        assert_eq!(ole_to_naive_ms(0.0), Some(ms("1899-12-30T00:00:00Z")));
        // -1.25 is 1899-12-29 06:00 (negative values keep a positive time of day).
        assert_eq!(ole_to_naive_ms(-1.25), Some(ms("1899-12-29T06:00:00Z")));
        assert_eq!(naive_ms_to_ole(ms("1899-12-29T06:00:00Z")), -1.25);
        let t = ms("2026-11-05T09:30:00Z");
        assert_eq!(ole_to_naive_ms(naive_ms_to_ole(t)), Some(t));
        // Sub-second float noise rounds to the second.
        assert_eq!(
            ole_to_naive_ms(naive_ms_to_ole(t) + 1e-9),
            Some(t),
            "rounded"
        );
        assert_eq!(ole_to_naive_ms(f64::NAN), None);
    }

    #[test]
    fn none_date_is_detected() {
        assert!(is_none_date(NONE_DATE));
        assert!(!is_none_date(naive_ms_to_ole(ms("2099-01-01T00:00:00Z"))));
        assert_eq!(
            local_ole_to_utc_ms(NONE_DATE, &FixedZone { offset_minutes: 0 }),
            None
        );
        assert_eq!(utc_ole_to_ms(NONE_DATE), None);
    }

    #[test]
    fn local_dates_convert_across_dst() {
        let z = eastern();
        // Summer: 09:00 EDT = 13:00Z.
        let summer = naive_ms_to_ole(ms("2026-07-01T09:00:00Z"));
        assert_eq!(
            local_ole_to_utc_ms(summer, &z),
            Some(ms("2026-07-01T13:00:00Z"))
        );
        // Winter: 09:00 EST = 14:00Z.
        let winter = naive_ms_to_ole(ms("2026-12-01T09:00:00Z"));
        assert_eq!(
            local_ole_to_utc_ms(winter, &z),
            Some(ms("2026-12-01T14:00:00Z"))
        );
        // And back.
        assert_eq!(
            ole_to_naive_ms(utc_ms_to_local_ole(ms("2026-12-01T14:00:00Z"), &z)),
            Some(ms("2026-12-01T09:00:00Z"))
        );
    }

    #[test]
    fn all_day_bounds_snap_to_local_midnights() {
        let z = eastern();
        // 2026-11-05 10:00 EST → 11:00 EST: one day, Nov 5 local.
        let (s, e) = all_day_bounds(ms("2026-11-05T15:00:00Z"), ms("2026-11-05T16:00:00Z"), &z);
        assert_eq!(s, ms("2026-11-05T00:00:00Z"));
        assert_eq!(e, ms("2026-11-06T00:00:00Z"));
        // Ending exactly at a local midnight two days later: two days.
        let (s, e) = all_day_bounds(ms("2026-11-05T05:00:00Z"), ms("2026-11-07T05:00:00Z"), &z);
        assert_eq!(
            (s, e),
            (ms("2026-11-05T00:00:00Z"), ms("2026-11-07T00:00:00Z"))
        );
        // A late-evening UTC instant is still the previous local day.
        let (s, _) = all_day_bounds(ms("2026-11-06T03:00:00Z"), ms("2026-11-06T03:00:00Z"), &z);
        assert_eq!(s, ms("2026-11-05T00:00:00Z"));
    }

    #[test]
    fn restrict_window_covers_the_exact_window() {
        let z = FixedZone { offset_minutes: 60 };
        let (f, t) = restrict_window(ms("2026-11-05T10:00:30Z"), ms("2026-11-05T12:00:30Z"), &z);
        assert!(f <= z.to_local(ms("2026-11-05T10:00:30Z")));
        assert!(t >= z.to_local(ms("2026-11-05T12:00:30Z")));
        assert_eq!(f % MS_PER_MINUTE, 0);
        assert_eq!(t % MS_PER_MINUTE, 0);
    }

    #[test]
    fn overlap_rules() {
        assert!(overlaps(10, 20, 15, 30));
        assert!(!overlaps(10, 15, 15, 30), "ends at from");
        assert!(!overlaps(30, 40, 15, 30), "starts at to");
        assert!(overlaps(15, 15, 15, 30), "zero-length at from");
        assert!(!overlaps(30, 30, 15, 30));
    }

    #[test]
    fn same_day_uses_the_local_zone() {
        let z = eastern();
        // 2026-11-06 03:00Z is Nov 5 22:00 local, same day as Nov 5 15:00Z.
        assert!(same_local_day(
            ms("2026-11-06T03:00:00Z"),
            ms("2026-11-05T15:00:00Z"),
            &z
        ));
        assert!(!same_local_day(
            ms("2026-11-06T06:00:00Z"),
            ms("2026-11-05T15:00:00Z"),
            &z
        ));
    }

    #[test]
    fn windows_zone_round_trips_and_formats() {
        let z = WindowsZone;
        let t = ms("2026-07-01T12:00:00Z");
        assert_eq!(z.to_utc(z.to_local(t)), t);
        let s = filter_date_string(ms("2026-07-01T09:05:00Z"));
        assert!(s.contains("2026") || s.contains("26"), "{s}");
        assert!(s.contains("05"), "{s}");
    }
}
