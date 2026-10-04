//! Recurring events: unfolding a rule into the occurrences of a period.
//!
//! An event is either timed (two instants, plus the IANA time zone it was written in) or all-day
//! (two dates, the end exclusive as in iCalendar). A series is that first occurrence, an RFC 5545
//! rule, the dates added by hand (`RDATE`) and the exceptions: occurrences cancelled or moved.
//!
//! **A timed series unfolds in its own time zone.** "Every Monday at 9:00, Paris" stays at 9:00 in
//! Paris on both sides of a daylight saving change, so the rule is expanded on the wall clock of
//! `tzid` and each occurrence converted to an instant afterwards. An all-day series has no time
//! zone at all: the 7th is the 7th everywhere.
//!
//! Everything outside this module speaks `time`; `chrono` is what the `rrule` crate speaks and
//! stays inside the conversions below.

use time::{Date, Duration, OffsetDateTime};

/// The widest period one expansion may cover.
pub const MAX_WINDOW_DAYS: i64 = 400;

/// The most occurrences one series yields to one expansion, whatever its rule.
pub const MAX_OCCURRENCES: usize = 2000;

/// When an occurrence happens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum When {
    Timed {
        start: OffsetDateTime,
        end: OffsetDateTime,
    },
    /// The end date is exclusive: a one-day event on the 7th ends on the 8th.
    AllDay { start: Date, end: Date },
}

/// Which occurrence of a series an exception replaces: its original start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RecurrenceId {
    Instant(OffsetDateTime),
    Date(Date),
}

impl RecurrenceId {
    /// How an exception names its occurrence in the database: `2026-10-26T08:00:00Z` (always UTC)
    /// or `2026-10-26`.
    pub fn to_key(self) -> String {
        match self {
            Self::Instant(instant) => {
                let utc = instant.to_offset(time::UtcOffset::UTC);
                format!(
                    "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
                    utc.year(),
                    u8::from(utc.month()),
                    utc.day(),
                    utc.hour(),
                    utc.minute(),
                    utc.second()
                )
            }
            Self::Date(date) => format!(
                "{:04}-{:02}-{:02}",
                date.year(),
                u8::from(date.month()),
                date.day()
            ),
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        if key.len() == 10 {
            let format = time::macros::format_description!("[year]-[month]-[day]");
            return Date::parse(key, &format).ok().map(Self::Date);
        }
        OffsetDateTime::parse(key, &time::format_description::well_known::Rfc3339)
            .ok()
            .map(Self::Instant)
    }

    /// The same occurrence once the whole series moved by `delta` (whole days for an all-day one).
    pub fn shifted(self, delta: Duration) -> Self {
        match self {
            Self::Instant(instant) => Self::Instant(instant + delta),
            Self::Date(date) => Self::Date(date + Duration::days(delta.whole_days())),
        }
    }
}

/// Whether `name` is an IANA time zone this server knows.
pub fn known_time_zone(name: &str) -> bool {
    name.parse::<chrono_tz::Tz>().is_ok()
}

/// An instant as the wall clock of `tzid` shows it, the way iCalendar writes a local time
/// (`20261026T090000`); `None` for an unknown zone.
pub fn local_wall_time(instant: OffsetDateTime, tzid: &str) -> Option<String> {
    let tz = tzid.parse::<chrono_tz::Tz>().ok()?;
    Some(
        to_chrono(instant)
            .with_timezone(&tz)
            .format("%Y%m%dT%H%M%S")
            .to_string(),
    )
}

/// A `VTIMEZONE` block for `tzid`, its daylight saving changes written as yearly rules starting in
/// `year`: what a calendar client needs to read the `TZID` of the events. `None` for an unknown
/// zone.
pub fn vtimezone(tzid: &str, year: i32) -> Option<String> {
    use chrono::{Datelike, Offset, TimeZone};
    use chrono_tz::OffsetName;

    let tz = tzid.parse::<chrono_tz::Tz>().ok()?;
    let at = |seconds: i64| {
        let instant = chrono::DateTime::<chrono::Utc>::from_timestamp(seconds, 0)
            .unwrap_or(chrono::DateTime::<chrono::Utc>::UNIX_EPOCH);
        tz.offset_from_utc_datetime(&instant.naive_utc())
    };
    let seconds_of = |offset: &chrono_tz::TzOffset| offset.fix().local_minus_utc();
    let text = |seconds: i32| {
        let sign = if seconds < 0 { '-' } else { '+' };
        let minutes = seconds.unsigned_abs() / 60;
        format!("{sign}{:02}{:02}", minutes / 60, minutes % 60)
    };
    let name = |offset: &chrono_tz::TzOffset| {
        offset
            .abbreviation()
            .filter(|n| n.chars().all(|c| c.is_ascii_alphabetic()))
            .map(|n| format!("TZNAME:{n}\r\n"))
            .unwrap_or_default()
    };

    // Find the year's changes: day by day at noon, then hour by hour on the day it changed.
    let start = chrono::Utc
        .with_ymd_and_hms(year, 1, 1, 12, 0, 0)
        .single()?
        .timestamp();
    let mut transitions = Vec::new();
    let mut previous = at(start);
    for day in 1..=366 {
        let noon = start + day * 86_400;
        let offset = at(noon);
        if seconds_of(&offset) != seconds_of(&previous) {
            let mut hour = noon - 86_400;
            while seconds_of(&at(hour + 3_600)) == seconds_of(&previous) {
                hour += 3_600;
            }
            transitions.push((hour + 3_600, previous, offset));
        }
        previous = offset;
    }

    let mut out = format!("BEGIN:VTIMEZONE\r\nTZID:{tzid}\r\n");
    if transitions.is_empty() {
        let offset = at(start);
        out.push_str(&format!(
            "BEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:{0}\r\n\
             TZOFFSETTO:{0}\r\n{1}END:STANDARD\r\n",
            text(seconds_of(&offset)),
            name(&offset),
        ));
    }
    for (moment, before, after) in &transitions {
        let kind = if seconds_of(after) > seconds_of(before) {
            "DAYLIGHT"
        } else {
            "STANDARD"
        };
        // The wall clock just before the change, in the offset that was in force.
        let local = chrono::DateTime::<chrono::Utc>::from_timestamp(
            moment + i64::from(seconds_of(before)),
            0,
        )?
        .naive_utc();
        let date = local.date();
        let last_days = date.day() + 7 > days_in_month(date.year(), date.month());
        let ordinal = if last_days {
            "-1".to_owned()
        } else {
            ((date.day() - 1) / 7 + 1).to_string()
        };
        let weekday = match date.weekday() {
            chrono::Weekday::Mon => "MO",
            chrono::Weekday::Tue => "TU",
            chrono::Weekday::Wed => "WE",
            chrono::Weekday::Thu => "TH",
            chrono::Weekday::Fri => "FR",
            chrono::Weekday::Sat => "SA",
            chrono::Weekday::Sun => "SU",
        };
        out.push_str(&format!(
            "BEGIN:{kind}\r\nDTSTART:{}\r\nRRULE:FREQ=YEARLY;BYMONTH={};BYDAY={ordinal}{weekday}\r\n\
             TZOFFSETFROM:{}\r\nTZOFFSETTO:{}\r\n{}END:{kind}\r\n",
            local.format("%Y%m%dT%H%M%S"),
            date.month(),
            text(seconds_of(before)),
            text(seconds_of(after)),
            name(after),
        ));
    }
    out.push_str("END:VTIMEZONE\r\n");
    Some(out)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let next = if month == 12 {
        chrono::NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        chrono::NaiveDate::from_ymd_opt(year, month + 1, 1)
    };
    next.and_then(|n| n.pred_opt())
        .map_or(31, |last| chrono::Datelike::day(&last))
}

/// When the occurrence `id` of a series whose first occurrence is `series` happens, unmoved.
pub fn occurrence_when(series: &When, id: RecurrenceId) -> When {
    shifted(series, recurrence_instant(&id))
}

/// An occurrence cancelled or moved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExceptionInput {
    pub recurrence_id: RecurrenceId,
    pub cancelled: bool,
    /// The new time, when it moved.
    pub when: Option<When>,
}

/// Everything that decides when a series' occurrences happen.
#[derive(Debug, Clone, Copy)]
pub struct SeriesInput<'a> {
    pub when: When,
    pub tzid: Option<&'a str>,
    pub rrule: Option<&'a str>,
    pub rdates: &'a [OffsetDateTime],
    pub exceptions: &'a [ExceptionInput],
}

/// One occurrence, ready to be drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Occurrence {
    /// `None` for an event that does not repeat.
    pub recurrence_id: Option<RecurrenceId>,
    pub when: When,
    /// Whether an exception moved it.
    pub overridden: bool,
}

/// Where a rule comes from: the screen offers nothing finer than a day, an import may.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleOrigin {
    Ui,
    Import,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecurrenceError {
    InvalidRule(String),
    RuleTooFine,
    UnknownTimeZone(String),
    TooWide,
}

impl std::fmt::Display for RecurrenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRule(why) => write!(f, "invalid recurrence rule: {why}"),
            Self::RuleTooFine => f.write_str("a rule may not repeat more often than daily"),
            Self::UnknownTimeZone(tz) => write!(f, "unknown time zone: {tz}"),
            Self::TooWide => write!(f, "a period may not exceed {MAX_WINDOW_DAYS} days"),
        }
    }
}

impl std::error::Error for RecurrenceError {}

/// Check a rule before it is stored: a bare `RRULE` value (`FREQ=...;...`), that the engine
/// accepts, and no finer than daily when it comes from the screen.
pub fn validate_rule(rrule: &str, origin: RuleOrigin) -> Result<(), RecurrenceError> {
    let parsed = parse_rule(rrule)?;
    let probe = chrono::DateTime::<chrono::Utc>::UNIX_EPOCH.with_timezone(&RTz::Tz(chrono_tz::UTC));
    let validated = parsed
        .validate(probe)
        .map_err(|e| RecurrenceError::InvalidRule(e.to_string()))?;
    if origin == RuleOrigin::Ui
        && matches!(
            validated.get_freq(),
            Frequency::Hourly | Frequency::Minutely | Frequency::Secondly
        )
    {
        return Err(RecurrenceError::RuleTooFine);
    }
    Ok(())
}

/// The occurrences that overlap `[from, to)`, in order, cancellations removed and moves applied.
///
/// All-day occurrences are dates, not instants, so they are matched against the dates the window
/// touches, one day wider at the end: a viewer west or east of UTC draws a day that the window's
/// UTC bounds only half cover. The client keeps the dates of its own local period.
pub fn expand(
    series: &SeriesInput,
    from: OffsetDateTime,
    to: OffsetDateTime,
) -> Result<Vec<Occurrence>, RecurrenceError> {
    if to - from > Duration::days(MAX_WINDOW_DAYS) {
        return Err(RecurrenceError::TooWide);
    }
    let window = Window::new(from, to);

    let Some(rule) = series.rrule else {
        return Ok(if window.overlaps(&series.when) {
            vec![Occurrence {
                recurrence_id: None,
                when: series.when,
                overridden: false,
            }]
        } else {
            Vec::new()
        });
    };

    // Unfold from early enough to catch an occurrence that started before the window and is still
    // running in it.
    let length = length_of(&series.when);
    let (lower, upper) = match series.when {
        When::Timed { .. } => (from - length, to),
        When::AllDay { .. } => (
            midnight(window.first_day) - length,
            midnight(window.last_day_exclusive),
        ),
    };
    let generated = unfold(series, rule, Some((lower, upper)), MAX_OCCURRENCES)?.starts;

    let mut handled = std::collections::HashSet::new();
    let mut found = Vec::new();
    for start in generated {
        let recurrence_id = series_id(&series.when, start);
        handled.insert(recurrence_id);
        let exception = series
            .exceptions
            .iter()
            .find(|e| e.recurrence_id == recurrence_id);
        let (when, overridden) = match exception {
            Some(e) if e.cancelled => continue,
            Some(ExceptionInput { when: Some(w), .. }) => (*w, true),
            _ => (shifted(&series.when, start), false),
        };
        if window.overlaps(&when) {
            found.push(Occurrence {
                recurrence_id: Some(recurrence_id),
                when,
                overridden,
            });
        }
    }
    // Occurrences moved into the window from outside it.
    for exception in series.exceptions {
        if exception.cancelled || handled.contains(&exception.recurrence_id) {
            continue;
        }
        if let Some(when) = exception.when {
            if window.overlaps(&when) {
                found.push(Occurrence {
                    recurrence_id: Some(exception.recurrence_id),
                    when,
                    overridden: true,
                });
            }
        }
    }
    found.sort_by_key(|o| sort_key(&o.when));
    found.truncate(MAX_OCCURRENCES);
    Ok(found)
}

/// When the series' last occurrence ends, or `None` when it never stops (or stops so far away that
/// counting to it is not worth it: the caller treats both alike, as "keep looking at this series").
pub fn series_until(series: &SeriesInput) -> Result<Option<OffsetDateTime>, RecurrenceError> {
    let length = length_of(&series.when);
    let mut last = match series.rrule {
        None => Some(start_instant(&series.when)),
        Some(rule) => {
            parse_rule(rule)?;
            if parsed_has(rule, "COUNT").is_none() && parsed_has(rule, "UNTIL").is_none() {
                None
            } else {
                let unfolded = unfold(series, rule, None, usize::from(u16::MAX))?;
                if unfolded.limited {
                    None
                } else {
                    unfolded.starts.last().copied()
                }
            }
        }
    };
    if let Some(end) = last.as_mut() {
        *end += length;
        for rdate in series.rdates {
            *end = (*end).max(*rdate + length);
        }
        for exception in series.exceptions {
            if let Some(when) = exception.when {
                *end = (*end).max(end_instant(&when));
            }
        }
    }
    Ok(last)
}

/// Cut a series in two at the occurrence `at`: the rule that ends just before it, and the rule of
/// the series that starts with it. A `COUNT` is shared between the two; otherwise the first rule
/// gains an `UNTIL` just before `at` and the second keeps the original end.
///
/// Cutting at the very first occurrence leaves nothing before it (`COUNT=0`, or an `UNTIL` before
/// the start): the caller edits the whole series instead.
pub fn split_rule(
    rrule: &str,
    series_start: &When,
    tzid: Option<&str>,
    at: &RecurrenceId,
) -> Result<(String, String), RecurrenceError> {
    parse_rule(rrule)?;
    let parts = rule_parts(rrule);
    if let Some(count) = parsed_has(rrule, "COUNT") {
        let total: usize = count
            .parse()
            .map_err(|_| RecurrenceError::InvalidRule(format!("COUNT={count}")))?;
        let series = SeriesInput {
            when: *series_start,
            tzid,
            rrule: Some(rrule),
            rdates: &[],
            exceptions: &[],
        };
        let cut = recurrence_instant(at);
        let before = unfold(
            &series,
            rrule,
            Some((start_instant(series_start), cut - Duration::nanoseconds(1))),
            usize::from(u16::MAX),
        )?
        .starts
        .len();
        let first = with_part(&parts, "COUNT", Some(before.to_string()));
        let second = with_part(
            &parts,
            "COUNT",
            Some(total.saturating_sub(before).to_string()),
        );
        return Ok((first, second));
    }
    let until = match at {
        RecurrenceId::Instant(instant) => {
            let last = (*instant - Duration::seconds(1)).to_offset(time::UtcOffset::UTC);
            format!(
                "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
                last.year(),
                u8::from(last.month()),
                last.day(),
                last.hour(),
                last.minute(),
                last.second()
            )
        }
        RecurrenceId::Date(date) => {
            let last = date.previous_day().unwrap_or(*date);
            format!(
                "{:04}{:02}{:02}",
                last.year(),
                u8::from(last.month()),
                last.day()
            )
        }
    };
    let without = with_part(&parts, "UNTIL", None);
    let first = format!("{without};UNTIL={until}");
    Ok((first, rrule.to_owned()))
}

// --- Internals -----------------------------------------------------------------------------------

use chrono::TimeZone as _;
use rrule::{Frequency, RRule, Tz as RTz, Unvalidated};

/// What `unfold` found: occurrence starts, and whether the limit cut the list short.
struct Unfolded {
    starts: Vec<OffsetDateTime>,
    limited: bool,
}

/// The dates an all-day occurrence is compared against.
struct Window {
    from: OffsetDateTime,
    to: OffsetDateTime,
    first_day: Date,
    last_day_exclusive: Date,
}

impl Window {
    fn new(from: OffsetDateTime, to: OffsetDateTime) -> Self {
        let utc_to = to.to_offset(time::UtcOffset::UTC);
        Self {
            from,
            to,
            first_day: from.to_offset(time::UtcOffset::UTC).date(),
            last_day_exclusive: utc_to.date().next_day().unwrap_or(utc_to.date()),
        }
    }

    fn overlaps(&self, when: &When) -> bool {
        match *when {
            When::Timed { start, end } if start == end => start >= self.from && start < self.to,
            When::Timed { start, end } => start < self.to && end > self.from,
            When::AllDay { start, end } => {
                start < self.last_day_exclusive
                    && end.max(start.next_day().unwrap_or(start)) > self.first_day
            }
        }
    }
}

fn parse_rule(rrule: &str) -> Result<RRule<Unvalidated>, RecurrenceError> {
    if rrule.trim().is_empty() || rrule.contains([':', '\n', '\r']) {
        return Err(RecurrenceError::InvalidRule(
            "expected a bare RRULE value".to_owned(),
        ));
    }
    engine_rule(rrule)
        .parse::<RRule<Unvalidated>>()
        .map_err(|e| RecurrenceError::InvalidRule(e.to_string()))
}

/// The rule as the engine wants it: an `UNTIL` in UTC. A date-only `UNTIL` (all-day series, as
/// iCalendar writes them) becomes the end of that day, a floating one is read as UTC.
fn engine_rule(rrule: &str) -> String {
    rule_parts(rrule)
        .into_iter()
        .map(|(key, value)| {
            if key.eq_ignore_ascii_case("UNTIL") {
                let value = match value.len() {
                    8 => format!("{value}T235959Z"),
                    15 => format!("{value}Z"),
                    _ => value,
                };
                format!("{key}={value}")
            } else {
                format!("{key}={value}")
            }
        })
        .collect::<Vec<_>>()
        .join(";")
}

fn rule_parts(rrule: &str) -> Vec<(String, String)> {
    rrule
        .split(';')
        .filter(|part| !part.is_empty())
        .map(|part| match part.split_once('=') {
            Some((key, value)) => (key.to_owned(), value.to_owned()),
            None => (part.to_owned(), String::new()),
        })
        .collect()
}

fn parsed_has(rrule: &str, key: &str) -> Option<String> {
    rule_parts(rrule)
        .into_iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v)
}

/// The rule with `key` replaced in place (or removed with `None`).
fn with_part(parts: &[(String, String)], key: &str, value: Option<String>) -> String {
    parts
        .iter()
        .filter_map(|(k, v)| {
            if k.eq_ignore_ascii_case(key) {
                value.as_ref().map(|value| format!("{k}={value}"))
            } else {
                Some(format!("{k}={v}"))
            }
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// Unfold the series' rule (and its added dates) between two instants, inclusive.
fn unfold(
    series: &SeriesInput,
    rule: &str,
    between: Option<(OffsetDateTime, OffsetDateTime)>,
    limit: usize,
) -> Result<Unfolded, RecurrenceError> {
    let tz = match (&series.when, series.tzid) {
        (When::AllDay { .. }, _) | (When::Timed { .. }, None) => chrono_tz::UTC,
        (When::Timed { .. }, Some(name)) => name
            .parse::<chrono_tz::Tz>()
            .map_err(|_| RecurrenceError::UnknownTimeZone(name.to_owned()))?,
    };
    let tz = RTz::Tz(tz);
    let dt_start = to_chrono(start_instant(&series.when)).with_timezone(&tz);
    let mut set = parse_rule(rule)?
        .build(dt_start)
        .map_err(|e| RecurrenceError::InvalidRule(e.to_string()))?;
    if !series.rdates.is_empty() {
        set = set.set_rdates(
            series
                .rdates
                .iter()
                .map(|d| to_chrono(*d).with_timezone(&tz))
                .collect(),
        );
    }
    if let Some((lower, upper)) = between {
        set = set
            .after(to_chrono(lower).with_timezone(&tz))
            .before(to_chrono(upper).with_timezone(&tz));
    }
    let limit = u16::try_from(limit).unwrap_or(u16::MAX);
    let result = set.all(limit);
    let mut starts: Vec<OffsetDateTime> = result.dates.iter().map(from_chrono).collect();
    if let Some((_, upper)) = between {
        // `before` is inclusive; the window's end is not.
        starts.retain(|s| *s < upper || matches!(series.when, When::AllDay { .. }));
    }
    starts.dedup();
    Ok(Unfolded {
        starts,
        limited: result.limited && result.dates.len() >= usize::from(limit),
    })
}

fn to_chrono(instant: OffsetDateTime) -> chrono::DateTime<chrono::Utc> {
    chrono::Utc
        .timestamp_opt(instant.unix_timestamp(), instant.nanosecond())
        .single()
        .unwrap_or(chrono::DateTime::<chrono::Utc>::UNIX_EPOCH)
}

fn from_chrono<Z: chrono::TimeZone>(instant: &chrono::DateTime<Z>) -> OffsetDateTime {
    let nanos = i128::from(instant.timestamp()) * 1_000_000_000
        + i128::from(instant.timestamp_subsec_nanos());
    OffsetDateTime::from_unix_timestamp_nanos(nanos).unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

fn midnight(date: Date) -> OffsetDateTime {
    date.midnight().assume_utc()
}

fn start_instant(when: &When) -> OffsetDateTime {
    match *when {
        When::Timed { start, .. } => start,
        When::AllDay { start, .. } => midnight(start),
    }
}

fn end_instant(when: &When) -> OffsetDateTime {
    match *when {
        When::Timed { end, .. } => end,
        When::AllDay { end, .. } => midnight(end),
    }
}

fn length_of(when: &When) -> Duration {
    end_instant(when) - start_instant(when)
}

fn recurrence_instant(id: &RecurrenceId) -> OffsetDateTime {
    match *id {
        RecurrenceId::Instant(instant) => instant,
        RecurrenceId::Date(date) => midnight(date),
    }
}

fn series_id(series_when: &When, start: OffsetDateTime) -> RecurrenceId {
    match series_when {
        When::Timed { .. } => RecurrenceId::Instant(start),
        When::AllDay { .. } => RecurrenceId::Date(start.to_offset(time::UtcOffset::UTC).date()),
    }
}

/// The series' first occurrence moved to start at `start`, keeping its length.
fn shifted(series_when: &When, start: OffsetDateTime) -> When {
    match *series_when {
        When::Timed { start: first, end } => When::Timed {
            start,
            end: start + (end - first),
        },
        When::AllDay { start: first, end } => {
            let date = start.to_offset(time::UtcOffset::UTC).date();
            When::AllDay {
                start: date,
                end: date + (end - first),
            }
        }
    }
}

fn sort_key(when: &When) -> OffsetDateTime {
    start_instant(when)
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::format_description::well_known::Rfc3339;
    use time::Month;

    fn at(value: &str) -> OffsetDateTime {
        OffsetDateTime::parse(value, &Rfc3339).expect("RFC 3339")
    }

    fn day(year: i32, month: u8, day: u8) -> Date {
        Date::from_calendar_date(year, Month::try_from(month).expect("month"), day).expect("date")
    }

    fn timed(start: &str, end: &str) -> When {
        When::Timed {
            start: at(start),
            end: at(end),
        }
    }

    fn series<'a>(
        when: When,
        tzid: Option<&'a str>,
        rrule: &'a str,
        exceptions: &'a [ExceptionInput],
    ) -> SeriesInput<'a> {
        SeriesInput {
            when,
            tzid,
            rrule: Some(rrule),
            rdates: &[],
            exceptions,
        }
    }

    fn starts(occurrences: &[Occurrence]) -> Vec<OffsetDateTime> {
        occurrences
            .iter()
            .map(|o| match o.when {
                When::Timed { start, .. } => start,
                When::AllDay { .. } => panic!("timed occurrence expected"),
            })
            .collect()
    }

    fn dates(occurrences: &[Occurrence]) -> Vec<Date> {
        occurrences
            .iter()
            .map(|o| match o.when {
                When::AllDay { start, .. } => start,
                When::Timed { start, .. } => start.date(),
            })
            .collect()
    }

    #[test]
    fn weekly_series_keeps_local_time_across_dst() {
        // 2026-10-19 09:00 in Paris is 07:00Z (summer time); the clocks go back on the 25th.
        let autumn = series(
            timed("2026-10-19T07:00:00Z", "2026-10-19T07:45:00Z"),
            Some("Europe/Paris"),
            "FREQ=WEEKLY;BYDAY=MO",
            &[],
        );
        let found = expand(
            &autumn,
            at("2026-10-01T00:00:00Z"),
            at("2026-10-31T00:00:00Z"),
        )
        .expect("expand");
        assert_eq!(
            starts(&found),
            vec![at("2026-10-19T07:00:00Z"), at("2026-10-26T08:00:00Z")]
        );
        // And forward on 2027-03-28.
        let spring = series(
            timed("2027-03-22T08:00:00Z", "2027-03-22T08:45:00Z"),
            Some("Europe/Paris"),
            "FREQ=WEEKLY;BYDAY=MO",
            &[],
        );
        let found = expand(
            &spring,
            at("2027-03-20T00:00:00Z"),
            at("2027-04-01T00:00:00Z"),
        )
        .expect("expand");
        assert_eq!(
            starts(&found),
            vec![at("2027-03-22T08:00:00Z"), at("2027-03-29T07:00:00Z")]
        );
        // The end moves with the start: still 45 minutes.
        match found[1].when {
            When::Timed { start, end } => assert_eq!(end - start, Duration::minutes(45)),
            When::AllDay { .. } => unreachable!(),
        }
    }

    #[test]
    fn second_thursday_of_the_month() {
        let s = series(
            timed("2026-10-08T08:00:00Z", "2026-10-08T09:00:00Z"),
            Some("Europe/Paris"),
            "FREQ=MONTHLY;BYDAY=2TH",
            &[],
        );
        let found = expand(&s, at("2026-10-01T00:00:00Z"), at("2027-01-01T00:00:00Z")).unwrap();
        assert_eq!(
            dates(&found),
            vec![day(2026, 10, 8), day(2026, 11, 12), day(2026, 12, 10)]
        );
    }

    #[test]
    fn last_working_day_of_the_month() {
        let s = series(
            timed("2026-10-30T15:00:00Z", "2026-10-30T16:00:00Z"),
            Some("Europe/Paris"),
            "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
            &[],
        );
        let found = expand(&s, at("2026-10-01T00:00:00Z"), at("2027-01-01T00:00:00Z")).unwrap();
        assert_eq!(
            dates(&found),
            vec![day(2026, 10, 30), day(2026, 11, 30), day(2026, 12, 31)]
        );
    }

    #[test]
    fn all_day_series_ignores_time_zones() {
        let s = series(
            When::AllDay {
                start: day(2026, 10, 7),
                end: day(2026, 10, 8),
            },
            None,
            "FREQ=YEARLY",
            &[],
        );
        let found = expand(&s, at("2027-10-06T23:30:00Z"), at("2027-10-07T00:30:00Z")).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(
            found[0].when,
            When::AllDay {
                start: day(2027, 10, 7),
                end: day(2027, 10, 8)
            }
        );
        assert_eq!(
            found[0].recurrence_id,
            Some(RecurrenceId::Date(day(2027, 10, 7)))
        );
        // A window that ends before the day starts finds nothing.
        let none = expand(&s, at("2027-10-05T00:00:00Z"), at("2027-10-06T00:00:00Z")).unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn cancelled_and_moved_exceptions() {
        let exceptions = [
            // The 26th of October is cancelled.
            ExceptionInput {
                recurrence_id: RecurrenceId::Instant(at("2026-10-26T08:00:00Z")),
                cancelled: true,
                when: None,
            },
            // The 2nd of November moves to the afternoon.
            ExceptionInput {
                recurrence_id: RecurrenceId::Instant(at("2026-11-02T08:00:00Z")),
                cancelled: false,
                when: Some(timed("2026-11-02T14:00:00Z", "2026-11-02T14:45:00Z")),
            },
            // The 9th moves out of the window, to the 20th.
            ExceptionInput {
                recurrence_id: RecurrenceId::Instant(at("2026-11-09T08:00:00Z")),
                cancelled: false,
                when: Some(timed("2026-11-20T08:00:00Z", "2026-11-20T08:45:00Z")),
            },
            // The 16th, outside the window, moves into it, to the 3rd.
            ExceptionInput {
                recurrence_id: RecurrenceId::Instant(at("2026-11-16T08:00:00Z")),
                cancelled: false,
                when: Some(timed("2026-11-03T08:00:00Z", "2026-11-03T08:45:00Z")),
            },
        ];
        let s = series(
            timed("2026-10-19T07:00:00Z", "2026-10-19T07:45:00Z"),
            Some("Europe/Paris"),
            "FREQ=WEEKLY;BYDAY=MO",
            &exceptions,
        );
        let found = expand(&s, at("2026-10-19T00:00:00Z"), at("2026-11-10T00:00:00Z")).unwrap();
        assert_eq!(
            starts(&found),
            vec![
                at("2026-10-19T07:00:00Z"),
                at("2026-11-02T14:00:00Z"),
                at("2026-11-03T08:00:00Z"),
            ]
        );
        assert!(!found[0].overridden);
        assert!(found[1].overridden);
        assert_eq!(
            found[1].recurrence_id,
            Some(RecurrenceId::Instant(at("2026-11-02T08:00:00Z")))
        );
        assert_eq!(
            found[2].recurrence_id,
            Some(RecurrenceId::Instant(at("2026-11-16T08:00:00Z")))
        );
    }

    #[test]
    fn count_and_until_end_the_series() {
        let counted = series(
            timed("2026-10-19T07:00:00Z", "2026-10-19T07:45:00Z"),
            Some("Europe/Paris"),
            "FREQ=WEEKLY;BYDAY=MO;COUNT=10",
            &[],
        );
        // The 10th Monday from the 19th of October is the 21st of December (winter time).
        assert_eq!(
            series_until(&counted).unwrap(),
            Some(at("2026-12-21T08:45:00Z"))
        );
        let found = expand(
            &counted,
            at("2026-10-01T00:00:00Z"),
            at("2027-06-01T00:00:00Z"),
        )
        .unwrap();
        assert_eq!(found.len(), 10);

        let until = series(
            timed("2026-10-19T07:00:00Z", "2026-10-19T07:45:00Z"),
            Some("Europe/Paris"),
            "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261102T080000Z",
            &[],
        );
        assert_eq!(
            series_until(&until).unwrap(),
            Some(at("2026-11-02T08:45:00Z"))
        );

        let endless = series(
            timed("2026-10-19T07:00:00Z", "2026-10-19T07:45:00Z"),
            Some("Europe/Paris"),
            "FREQ=WEEKLY;BYDAY=MO",
            &[],
        );
        assert_eq!(series_until(&endless).unwrap(), None);

        let single = SeriesInput {
            when: timed("2026-10-19T07:00:00Z", "2026-10-19T07:45:00Z"),
            tzid: Some("Europe/Paris"),
            rrule: None,
            rdates: &[],
            exceptions: &[],
        };
        assert_eq!(
            series_until(&single).unwrap(),
            Some(at("2026-10-19T07:45:00Z"))
        );
        let found = expand(
            &single,
            at("2026-10-19T07:30:00Z"),
            at("2026-10-20T00:00:00Z"),
        )
        .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].recurrence_id, None);
    }

    #[test]
    fn rdates_add_occurrences() {
        let rdates = [at("2026-10-21T13:00:00Z")];
        let s = SeriesInput {
            when: timed("2026-10-19T07:00:00Z", "2026-10-19T07:45:00Z"),
            tzid: Some("Europe/Paris"),
            rrule: Some("FREQ=WEEKLY;BYDAY=MO;COUNT=2"),
            rdates: &rdates,
            exceptions: &[],
        };
        let found = expand(&s, at("2026-10-01T00:00:00Z"), at("2026-11-01T00:00:00Z")).unwrap();
        assert_eq!(
            starts(&found),
            vec![
                at("2026-10-19T07:00:00Z"),
                at("2026-10-21T13:00:00Z"),
                at("2026-10-26T08:00:00Z")
            ]
        );
    }

    #[test]
    fn splitting_a_counted_series_keeps_the_total() {
        let start = timed("2026-10-19T07:00:00Z", "2026-10-19T07:45:00Z");
        let fourth = RecurrenceId::Instant(at("2026-11-09T08:00:00Z"));
        let (before, after) = split_rule(
            "FREQ=WEEKLY;BYDAY=MO;COUNT=10",
            &start,
            Some("Europe/Paris"),
            &fourth,
        )
        .unwrap();
        assert_eq!(before, "FREQ=WEEKLY;BYDAY=MO;COUNT=3");
        assert_eq!(after, "FREQ=WEEKLY;BYDAY=MO;COUNT=7");

        let (before, after) = split_rule(
            "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T230000Z",
            &start,
            Some("Europe/Paris"),
            &fourth,
        )
        .unwrap();
        assert_eq!(before, "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261109T075959Z");
        assert_eq!(after, "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T230000Z");

        let all_day = When::AllDay {
            start: day(2026, 10, 7),
            end: day(2026, 10, 8),
        };
        let (before, after) = split_rule(
            "FREQ=DAILY",
            &all_day,
            None,
            &RecurrenceId::Date(day(2026, 10, 10)),
        )
        .unwrap();
        assert_eq!(before, "FREQ=DAILY;UNTIL=20261009");
        assert_eq!(after, "FREQ=DAILY");
    }

    #[test]
    fn the_window_and_the_count_are_capped() {
        let daily = series(
            timed("2026-01-01T08:00:00Z", "2026-01-01T09:00:00Z"),
            Some("Europe/Paris"),
            "FREQ=DAILY",
            &[],
        );
        assert_eq!(
            expand(
                &daily,
                at("2026-01-01T00:00:00Z"),
                at("2027-02-06T00:00:00Z")
            ),
            Err(RecurrenceError::TooWide)
        );
        let found = expand(
            &daily,
            at("2026-01-01T00:00:00Z"),
            at("2027-02-05T00:00:00Z"),
        )
        .unwrap();
        assert_eq!(found.len(), 400);

        let minutely = series(
            timed("2026-01-01T08:00:00Z", "2026-01-01T08:01:00Z"),
            Some("Europe/Paris"),
            "FREQ=MINUTELY",
            &[],
        );
        let found = expand(
            &minutely,
            at("2026-01-01T00:00:00Z"),
            at("2026-01-10T00:00:00Z"),
        )
        .unwrap();
        assert_eq!(found.len(), MAX_OCCURRENCES);
    }

    #[test]
    fn rules_finer_than_a_day_are_refused_from_the_ui() {
        assert_eq!(
            validate_rule("FREQ=HOURLY", RuleOrigin::Ui),
            Err(RecurrenceError::RuleTooFine)
        );
        assert_eq!(validate_rule("FREQ=HOURLY", RuleOrigin::Import), Ok(()));
        assert_eq!(
            validate_rule("FREQ=WEEKLY;BYDAY=MO", RuleOrigin::Ui),
            Ok(())
        );
        assert!(matches!(
            validate_rule("FREQ=SOMETIMES", RuleOrigin::Ui),
            Err(RecurrenceError::InvalidRule(_))
        ));
        assert!(matches!(
            validate_rule("RRULE:FREQ=DAILY\nDTSTART:20260101T000000Z", RuleOrigin::Ui),
            Err(RecurrenceError::InvalidRule(_))
        ));
    }

    #[test]
    fn an_unknown_time_zone_is_refused() {
        let s = series(
            timed("2026-10-19T07:00:00Z", "2026-10-19T07:45:00Z"),
            Some("Mars/Olympus"),
            "FREQ=DAILY",
            &[],
        );
        assert_eq!(
            expand(&s, at("2026-10-19T00:00:00Z"), at("2026-10-20T00:00:00Z")),
            Err(RecurrenceError::UnknownTimeZone("Mars/Olympus".to_owned()))
        );
    }

    #[test]
    fn recurrence_ids_have_a_stable_text_form() {
        let instant = RecurrenceId::Instant(at("2026-10-26T09:00:00+01:00"));
        assert_eq!(instant.to_key(), "2026-10-26T08:00:00Z");
        assert_eq!(
            RecurrenceId::from_key("2026-10-26T08:00:00Z"),
            Some(instant)
        );
        let date = RecurrenceId::Date(day(2026, 10, 7));
        assert_eq!(date.to_key(), "2026-10-07");
        assert_eq!(RecurrenceId::from_key("2026-10-07"), Some(date));
        assert_eq!(RecurrenceId::from_key("yesterday"), None);
        // Moving a series moves its exceptions' keys with it.
        assert_eq!(
            instant.shifted(Duration::hours(1)),
            RecurrenceId::Instant(at("2026-10-26T09:00:00Z"))
        );
        assert_eq!(
            date.shifted(Duration::days(2)),
            RecurrenceId::Date(day(2026, 10, 9))
        );
    }

    #[test]
    fn time_zones_are_known_by_their_iana_name() {
        assert!(known_time_zone("Europe/Paris"));
        assert!(known_time_zone("America/New_York"));
        assert!(!known_time_zone("Mars/Olympus"));
        assert!(!known_time_zone(""));
    }

    #[test]
    fn wall_time_is_read_in_the_events_zone() {
        assert_eq!(
            local_wall_time(at("2026-10-26T08:00:00Z"), "Europe/Paris").as_deref(),
            Some("20261026T090000")
        );
        assert_eq!(
            local_wall_time(at("2026-07-01T08:00:00Z"), "Europe/Paris").as_deref(),
            Some("20260701T100000")
        );
        assert_eq!(
            local_wall_time(at("2026-07-01T08:00:00Z"), "Mars/Olympus"),
            None
        );
    }

    #[test]
    fn a_vtimezone_describes_the_zones_yearly_changes() {
        let paris = vtimezone("Europe/Paris", 2026).expect("Paris");
        assert!(paris.starts_with("BEGIN:VTIMEZONE\r\nTZID:Europe/Paris\r\n"));
        assert!(paris.ends_with("END:VTIMEZONE\r\n"));
        let daylight = "BEGIN:DAYLIGHT\r\nDTSTART:20260329T020000\r\n\
                        RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\n\
                        TZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nTZNAME:CEST\r\n\
                        END:DAYLIGHT\r\n";
        let standard = "BEGIN:STANDARD\r\nDTSTART:20261025T030000\r\n\
                        RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\n\
                        TZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nTZNAME:CET\r\n\
                        END:STANDARD\r\n";
        assert!(paris.contains(daylight), "{paris}");
        assert!(paris.contains(standard), "{paris}");

        // No daylight saving: one observance.
        let tokyo = vtimezone("Asia/Tokyo", 2026).expect("Tokyo");
        assert!(
            tokyo.contains(
                "BEGIN:STANDARD\r\nDTSTART:19700101T000000\r\n\
             TZOFFSETFROM:+0900\r\nTZOFFSETTO:+0900\r\nTZNAME:JST\r\nEND:STANDARD\r\n"
            ),
            "{tokyo}"
        );
        assert!(!tokyo.contains("DAYLIGHT"));
        assert_eq!(vtimezone("Mars/Olympus", 2026), None);
    }

    #[test]
    fn an_occurrence_keeps_its_series_length() {
        let series = timed("2026-10-19T07:00:00Z", "2026-10-19T07:45:00Z");
        assert_eq!(
            occurrence_when(&series, RecurrenceId::Instant(at("2026-10-26T08:00:00Z"))),
            timed("2026-10-26T08:00:00Z", "2026-10-26T08:45:00Z")
        );
        let all_day = When::AllDay {
            start: day(2026, 10, 7),
            end: day(2026, 10, 9),
        };
        assert_eq!(
            occurrence_when(&all_day, RecurrenceId::Date(day(2027, 10, 7))),
            When::AllDay {
                start: day(2027, 10, 7),
                end: day(2027, 10, 9)
            }
        );
    }
}
