//! Calendar arithmetic without a date library: forum timestamps are ISO-8601 UTC, and only
//! day-level comparisons and YYYY-MM-DD formatting are ever needed.

use std::time::{SystemTime, UNIX_EPOCH};

pub const DAY_MS: i64 = 86_400_000;

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn digits(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Parse an ISO-8601 timestamp ("2026-08-28T20:00:00.000Z", "2026-08-28", "+02:00" offsets)
/// to epoch milliseconds. A missing offset is read as UTC.
pub fn parse_iso(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.len() < 10 {
        return None;
    }
    let (date, rest) = s.split_at(10);
    let b = date.as_bytes();
    if b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y = digits(&date[0..4])?;
    let m = digits(&date[5..7])? as u32;
    let d = digits(&date[8..10])? as u32;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let mut ms = days_from_civil(y, m, d) * DAY_MS;
    if rest.is_empty() {
        return Some(ms);
    }
    let rest = rest.strip_prefix(['T', 't', ' '])?;
    // Split the clock from the zone designator.
    let zone_at = rest.find(['Z', 'z', '+', '-']).unwrap_or(rest.len());
    let (clock, zone) = rest.split_at(zone_at);
    let mut parts = clock.splitn(3, ':');
    let h = digits(parts.next()?)?;
    let min = digits(parts.next()?)?;
    let (sec, frac) = match parts.next() {
        Some(sec) => match sec.split_once('.') {
            Some((s, f)) => (digits(s)?, f),
            None => (digits(sec)?, ""),
        },
        None => (0, ""),
    };
    if h > 24 || min > 59 || sec > 60 {
        return None;
    }
    let frac_ms = if frac.is_empty() {
        0
    } else {
        let f: String = frac.chars().take(3).collect();
        let v = digits(&f)?;
        v * 10_i64.pow(3 - f.len() as u32)
    };
    ms += ((h * 60 + min) * 60 + sec) * 1000 + frac_ms;
    match zone {
        "" | "Z" | "z" => Some(ms),
        z => {
            let sign = if z.starts_with('-') { 1 } else { -1 };
            let body = z[1..].replace(':', "");
            if body.len() != 4 && body.len() != 2 {
                return None;
            }
            let oh = digits(&body[0..2])?;
            let om = if body.len() == 4 { digits(&body[2..4])? } else { 0 };
            Some(ms + sign * (oh * 60 + om) * 60_000)
        }
    }
}

/// "YYYY-MM-DD" for an epoch-millisecond instant, in UTC.
pub fn ymd(ms: i64) -> String {
    let (y, m, d) = civil_from_days(ms.div_euclid(DAY_MS));
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn today() -> String {
    ymd(now_ms())
}

/// Start of the UTC day holding `ms`.
pub fn utc_midnight(ms: i64) -> i64 {
    ms.div_euclid(DAY_MS) * DAY_MS
}

/// Whether `s` is shaped YYYY-MM-DD.
pub fn is_date_shaped(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// A YYYY-MM-DD string that names a day on the calendar: "2026-02-31" is rejected, not
/// rolled over to 3 March.
pub fn is_real_date(s: &str) -> bool {
    if !is_date_shaped(s) {
        return false;
    }
    match parse_iso(s) {
        Some(ms) => ymd(ms) == s,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trips() {
        let ms = parse_iso("2026-08-28T20:00:00.000Z").unwrap();
        assert_eq!(ymd(ms), "2026-08-28");
        assert_eq!(parse_iso("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(parse_iso("1970-01-01T02:00:00+02:00"), Some(0));
        assert_eq!(parse_iso("nonsense"), None);
        assert_eq!(parse_iso(""), None);
    }

    #[test]
    fn real_dates_only() {
        assert!(is_real_date("2024-02-29"));
        assert!(!is_real_date("2026-02-31"));
        assert!(!is_real_date("2025-13-45"));
        assert!(!is_real_date("2025-1-01"));
    }
}
