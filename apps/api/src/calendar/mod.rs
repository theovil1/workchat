//! The calendar: personal and space calendars, events and their recurring series, reminders, and
//! the read-only iCal subscription.
//!
//! A recurring event is stored the way iCalendar describes it, a rule and its exceptions, and its
//! occurrences are computed when they are asked for ([`recurrence`]). See
//! `docs/adr/0004-calendar-data-model.md` for why.

// Not wired to a route until the events land; the attribute goes with that change.
#[allow(dead_code)]
pub(crate) mod recurrence;
