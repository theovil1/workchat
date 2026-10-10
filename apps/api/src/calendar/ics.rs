//! A calendar as an iCalendar file (RFC 5545), for the read-only subscription.
//!
//! A series is written as it is stored: its first occurrence with its `TZID`, its rule, an `EXDATE`
//! per cancelled occurrence, and one more `VEVENT` with a `RECURRENCE-ID` per changed occurrence.
//! Every time zone in use gets a `VTIMEZONE`, so clients that do not know IANA names read the
//! times right too. Properties Ruchoir does not handle (kept from an import in `ical_extra`) are
//! written back unchanged.

use icalendar::{Calendar, Component, Event, EventLike, Property};
use time::OffsetDateTime;

use super::events::when_of;
use super::recurrence::{self, RecurrenceId, When};
use crate::entities::{calendar_event_exceptions as exceptions, calendar_events};

/// The hexadecimal value of each palette colour, for the clients that show it. `accent` has no
/// value of its own outside Ruchoir, and goes out as the default accent, sky.
pub fn color_hex(color: &str) -> &'static str {
    match color {
        "sky" => "#8fd0ff",
        "mint" => "#6fe0c2",
        "violet" => "#c9a8ff",
        "pink" => "#f5b0f0",
        "peach" => "#ffb3ba",
        "lime" => "#8fe6a3",
        "sun" => "#ffd84d",
        _ => "#8fd0ff",
    }
}

fn utc_stamp(instant: OffsetDateTime) -> String {
    let utc = instant.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        utc.year(),
        u8::from(utc.month()),
        utc.day(),
        utc.hour(),
        utc.minute(),
        utc.second()
    )
}

fn date_value(date: time::Date) -> String {
    format!(
        "{:04}{:02}{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

/// A date-time property in the event's zone (`KEY;TZID=Europe/Paris:20261019T090000`), or a date.
fn moment(key: &str, at: Moment, tzid: Option<&str>) -> Property {
    match (at, tzid) {
        (Moment::Date(date), _) => Property::new(key, date_value(date))
            .add_parameter("VALUE", "DATE")
            .done(),
        (Moment::Instant(instant), Some(tz)) => match recurrence::local_wall_time(instant, tz) {
            Some(local) => Property::new(key, local).add_parameter("TZID", tz).done(),
            None => Property::new(key, utc_stamp(instant)),
        },
        (Moment::Instant(instant), None) => Property::new(key, utc_stamp(instant)),
    }
}

#[derive(Clone, Copy)]
enum Moment {
    Instant(OffsetDateTime),
    Date(time::Date),
}

impl From<RecurrenceId> for Moment {
    fn from(id: RecurrenceId) -> Self {
        match id {
            RecurrenceId::Instant(instant) => Self::Instant(instant),
            RecurrenceId::Date(date) => Self::Date(date),
        }
    }
}

fn put_when(event: &mut Event, when: &When, tzid: Option<&str>) {
    let (start, end) = match *when {
        When::Timed { start, end } => (Moment::Instant(start), Moment::Instant(end)),
        When::AllDay { start, end } => (Moment::Date(start), Moment::Date(end)),
    };
    event.append_property(moment("DTSTART", start, tzid));
    event.append_property(moment("DTEND", end, tzid));
}

fn put_text(event: &mut Event, title: &str, description: Option<&str>, location: Option<&str>) {
    event.summary(title);
    if let Some(description) = description {
        event.description(description);
    }
    if let Some(location) = location {
        event.location(location);
    }
}

/// Re-emit the content lines kept from an import (`NAME;PARAM=x:value`).
fn put_extra(event: &mut Event, extra: &serde_json::Value) {
    for line in extra
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| l.as_str())
    {
        if let Some((key, value)) = line.split_once(':') {
            event.append_multi_property(Property::new(key, value));
        }
    }
}

/// Render a calendar: `name` as clients show it, `color` one of the palette's names (none for the
/// address that mixes several calendars), and each event with its exceptions.
pub fn render(
    name: &str,
    color: Option<&str>,
    events: &[(calendar_events::Model, Vec<exceptions::Model>)],
) -> String {
    let mut calendar = Calendar::new();
    calendar
        .append_property(Property::new("PRODID", "-//Ruchoir//Calendar//EN"))
        .append_property(Property::new("CALSCALE", "GREGORIAN"))
        .name(name);
    if let Some(color) = color {
        calendar.append_property(Property::new("X-APPLE-CALENDAR-COLOR", color_hex(color)));
    }

    // The zones in use, each from the earliest year one of its events starts.
    let mut zones: std::collections::BTreeMap<&str, i32> = std::collections::BTreeMap::new();

    for (event, rows) in events {
        let tzid = event.tzid.as_deref();
        let when = when_of(event);
        if let (Some(tz), When::Timed { start, .. }) = (tzid, &when) {
            let year = zones.entry(tz).or_insert(start.year());
            *year = (*year).min(start.year());
        }

        let mut head = Event::new();
        head.uid(&event.uid)
            .sequence(u32::try_from(event.sequence).unwrap_or(0))
            .append_property(Property::new("DTSTAMP", utc_stamp(event.updated_at)))
            .append_property(Property::new("LAST-MODIFIED", utc_stamp(event.updated_at)));
        put_text(
            &mut head,
            &event.title,
            event.description.as_deref(),
            event.location.as_deref(),
        );
        put_when(&mut head, &when, tzid);
        if let Some(rule) = &event.rrule {
            head.append_property(Property::new("RRULE", rule.as_str()));
        }
        for rdate in event.rdates.iter().flatten() {
            head.append_multi_property(moment("RDATE", Moment::Instant(*rdate), tzid));
        }
        let mut changed = Vec::new();
        let series = super::events::series_of(event, &[]);
        for row in rows {
            let Some(id) = RecurrenceId::from_key(&row.recurrence_id) else {
                continue;
            };
            // A row naming no occurrence of the rule (stale after a change of rule) says nothing.
            if !recurrence::is_occurrence(&series, &id).unwrap_or(false) {
                continue;
            }
            if row.cancelled {
                head.append_multi_property(moment("EXDATE", id.into(), tzid));
            } else {
                changed.push((id, row));
            }
        }
        put_extra(&mut head, &event.ical_extra);
        calendar.push(head.done());

        for (id, row) in changed {
            let mut occurrence = Event::new();
            occurrence
                .uid(&event.uid)
                .sequence(u32::try_from(event.sequence).unwrap_or(0))
                .append_property(Property::new("DTSTAMP", utc_stamp(event.updated_at)))
                .append_property(moment("RECURRENCE-ID", id.into(), tzid));
            put_text(
                &mut occurrence,
                row.title.as_deref().unwrap_or(&event.title),
                row.description.as_deref(),
                row.location.as_deref(),
            );
            let moved = match (row.start_at, row.end_at, row.start_date, row.end_date) {
                (Some(start), Some(end), _, _) => When::Timed { start, end },
                (_, _, Some(start), Some(end)) => When::AllDay { start, end },
                _ => recurrence::occurrence_when(&when, id),
            };
            put_when(&mut occurrence, &moved, tzid);
            put_extra(&mut occurrence, &row.ical_extra);
            calendar.push(occurrence.done());
        }
    }

    let mut text = calendar.done().to_string();
    let blocks: String = zones
        .iter()
        .filter_map(|(tz, year)| recurrence::vtimezone(tz, *year))
        .collect();
    if !blocks.is_empty() {
        let at = text
            .find("BEGIN:VEVENT")
            .or_else(|| text.find("END:VCALENDAR"))
            .unwrap_or(text.len());
        text.insert_str(at, &blocks);
    }
    text
}
