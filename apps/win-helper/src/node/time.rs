//! ISO 8601 formatting and parsing without a date library (UTC only, which is all the wire uses).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// (year, month, day) → days since 1970-01-01.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Milliseconds since the Unix epoch (negative before 1970).
pub fn unix_millis(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

fn format(ms: i64, fractional: bool) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, mo, d) = civil_from_days(days);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    if fractional {
        format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
    } else {
        format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
    }
}

/// `2026-11-04T10:00:00.123Z` (receipts, log lines).
pub fn iso8601_millis(t: SystemTime) -> String {
    format(unix_millis(t), true)
}

pub fn iso8601_millis_now() -> String {
    iso8601_millis(SystemTime::now())
}

/// `2026-11-04T10:00:00Z` (file dates, like the mac helper's `AppleDates.string`).
pub fn iso8601(t: SystemTime) -> String {
    format(unix_millis(t), false)
}

/// Parses `YYYY-MM-DDTHH:MM:SS[.fff…](Z|±HH:MM)` into milliseconds since the epoch.
pub fn parse_iso8601_millis(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let part = s.get(r)?;
        if !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    if b[4] != b'-'
        || b[7] != b'-'
        || !(b[10] == b'T' || b[10] == b't')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let (y, mo, d) = (num(0..4)?, num(5..7)? as u32, num(8..10)? as u32);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let mut i = 19;
    let mut millis = 0i64;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return None;
        }
        let frac = &s[start..i.min(start + 3)];
        millis = frac.parse::<i64>().ok()? * 10i64.pow(3 - frac.len() as u32);
    }
    let offset_min = match b.get(i) {
        Some(b'Z') | Some(b'z') if i + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) if i + 6 == b.len() && b[i + 3] == b':' => {
            let oh = num(i + 1..i + 3)?;
            let om = num(i + 4..i + 6)?;
            let v = oh * 60 + om;
            if *sign == b'-' { -v } else { v }
        }
        _ => return None,
    };
    let days = days_from_civil(y, mo, d);
    let secs = days * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60;
    Some(secs * 1000 + millis)
}

/// `FILETIME` ticks (100 ns since 1601-01-01) → `SystemTime`.
pub fn from_filetime(ticks: u64) -> Option<SystemTime> {
    const EPOCH_DIFF_100NS: u64 = 116_444_736_000_000_000;
    if ticks == 0 {
        return None;
    }
    if ticks >= EPOCH_DIFF_100NS {
        UNIX_EPOCH.checked_add(Duration::from_nanos((ticks - EPOCH_DIFF_100NS) * 100))
    } else {
        UNIX_EPOCH.checked_sub(Duration::from_nanos((EPOCH_DIFF_100NS - ticks) * 100))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_instants() {
        assert_eq!(format(0, true), "1970-01-01T00:00:00.000Z");
        assert_eq!(format(1_792_843_200_123, true), "2026-10-24T12:00:00.123Z");
        assert_eq!(format(951_782_400_000, false), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn parses_round_trip_and_offsets() {
        assert_eq!(
            parse_iso8601_millis("2026-10-24T12:00:00.123Z"),
            Some(1_792_843_200_123)
        );
        assert_eq!(
            parse_iso8601_millis("2026-10-24T14:00:00+02:00"),
            Some(1_792_843_200_000)
        );
        assert_eq!(
            parse_iso8601_millis("2026-10-24T12:00:00.5Z"),
            Some(1_792_843_200_500)
        );
        assert_eq!(parse_iso8601_millis("2026-10-24 12:00:00Z"), None);
        assert_eq!(parse_iso8601_millis("2026-13-24T12:00:00Z"), None);
        assert_eq!(parse_iso8601_millis("nope"), None);
    }

    #[test]
    fn filetime_epoch() {
        assert_eq!(from_filetime(116_444_736_000_000_000), Some(UNIX_EPOCH));
        assert_eq!(from_filetime(0), None);
    }
}
