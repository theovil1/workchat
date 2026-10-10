# ADR 0004: Recurring events stored as a rule and its exceptions

- Status: accepted
- Date: 2026-10-04

## Context

Ruchoir's calendar has to replace the one teams leave behind in Nextcloud: personal and space
calendars, events that repeat ("every Monday at 9:00", "the 2nd Thursday of the month", "the last
working day"), occurrences changed or cancelled one at a time, reminders, and a read-only iCal
subscription so phones can show it. A Nextcloud import will bring `.ics` files in, and a sync with
external calendars (CalDAV, then Google and Microsoft) may follow.

Every one of those speaks iCalendar (RFC 5545), where a recurring event is a first occurrence, a rule
(`RRULE`), added dates (`RDATE`), cancelled dates (`EXDATE`), and changed occurrences written as
separate components carrying a `RECURRENCE-ID`.

Three ways of storing that were weighed:

1. **The rule and its exceptions**, as iCalendar has them, with the occurrences of a period computed
   when they are asked for.
2. **One row per occurrence**, written ahead on a rolling year.
3. **The raw `.ics` text** per event, as a CalDAV server keeps it, with an index beside it.

## Decision

Option 1.

- `calendar_events` holds an event or a series' head: its first occurrence (two instants and the IANA
  `tzid` it was written in, or two dates for an all-day event), the bare `RRULE` value, `RDATE`s, and
  the iCalendar properties Ruchoir does not handle (`ical_extra`), kept to be written back.
- `calendar_event_exceptions` holds one row per occurrence cancelled or changed, keyed by the
  occurrence's original start (`recurrence_id`, written `2026-10-26T08:00:00Z` or `2026-10-26`).
- `apps/api/src/calendar/recurrence.rs` unfolds a series over a period, with the `rrule` crate, **on
  the wall clock of the event's own time zone**: "9:00, Paris" stays 9:00 on both sides of a change
  of time. A period is capped at 400 days and a series at 2,000 occurrences per request, so no rule
  (an imported `FREQ=MINUTELY` included) can make the server spin. The screen offers nothing finer
  than daily.
- "This and the following ones" cuts a series in two, as Google and Outlook do: the old rule gains
  an `UNTIL` (or keeps its share of a `COUNT`), a new series with a new UID starts at the occurrence,
  and the exceptions after the cut move to it.
- `series_until` (when the last occurrence ends, `NULL` when never) is kept beside the rule so a
  period's query reads only the series that can reach it.

## Consequences

- The subscription file, the coming Nextcloud import and any later CalDAV sync translate nothing:
  rules, exceptions and unknown properties go out (and come in) as they are.
- Reading a period costs an unfolding per series that reaches it. At the scale of a team's calendars
  that is a few milliseconds; a cache can come later without changing the model.
- Free/busy (lot D) and reminders unfold the same way; reminders look two days ahead every minute.
- Option 2 was rejected because an endless series has no last row, "change the following ones"
  rewrites hundreds of rows, and the export would have to rebuild the rule after the fact. Option 3
  was rejected because "what falls on Tuesday" would re-read every file, which reminders and
  free/busy ask constantly.
- `chrono` (what `rrule` speaks) stays inside `apps/api/src/calendar/`; the rest of the API uses
  `time`.
