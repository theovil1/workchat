//! The calendar: personal and space calendars, events and their recurring series, reminders, and
//! the read-only iCal subscription.
//!
//! A recurring event is stored the way iCalendar describes it, a rule and its exceptions, and its
//! occurrences are computed when they are asked for ([`recurrence`]). See
//! `docs/adr/0004-calendar-data-model.md` for why.

// Not wired to a route until the events land; the attribute goes with that change.
pub(crate) mod authz;
pub(crate) mod calendars;
pub(crate) mod dto;
pub(crate) mod error;
#[allow(dead_code)]
pub(crate) mod recurrence;
mod routes;

pub use routes::router;

/// The reminders a timed event may carry, in minutes before it starts.
pub const TIMED_REMINDERS: [i32; 7] = [0, 5, 10, 15, 30, 60, 1440];
