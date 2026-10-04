//! The calendar: personal and space calendars, events and their recurring series, invitations and
//! their answers, reminders, and the read-only iCal subscription.
//!
//! A recurring event is stored the way iCalendar describes it, a rule and its exceptions, and its
//! occurrences are computed when they are asked for ([`recurrence`]). See
//! `docs/adr/0004-calendar-data-model.md` for why.

pub(crate) mod attendees;
pub(crate) mod authz;
pub(crate) mod calendars;
pub(crate) mod dto;
pub(crate) mod error;
pub(crate) mod events;
pub(crate) mod feeds;
pub(crate) mod ics;
pub(crate) mod occurrences;
pub(crate) mod recurrence;
pub(crate) mod reminders;
mod routes;

pub use routes::router;

/// The reminders a timed event may carry, in minutes before it starts.
pub const TIMED_REMINDERS: [i32; 7] = [0, 5, 10, 15, 30, 60, 1440];

/// The reminders an all-day event may carry, in minutes before the local midnight that starts it:
/// the evening before at 17:00 (`420`), the same morning at 9:00 (`-540`).
pub const ALL_DAY_REMINDERS: [i32; 2] = [420, -540];
