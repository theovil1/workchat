//! What the calendar endpoints exchange.

use serde::{Deserialize, Deserializer, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::authz::CalendarAccess;

/// Read a field that may be absent (`None`), `null` (`Some(None)`) or a value (`Some(Some(v))`).
pub(crate) fn absent_null_or<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// A calendar as its viewer sees it.
#[derive(Debug, Serialize, ToSchema)]
pub struct CalendarDto {
    pub id: Uuid,
    /// The space it belongs to; absent for a personal calendar.
    pub space_id: Option<Uuid>,
    pub name: String,
    pub description: Option<String>,
    pub color: String,
    /// `members` or `admins`.
    pub write_access: String,
    /// The reminder a timed event gets by default, in minutes before it; `null` is none.
    pub default_reminder_minutes: Option<i32>,
    pub is_default: bool,
    pub can_write_events: bool,
    pub can_manage: bool,
    /// Whether the viewer hid it from their view.
    pub hidden: bool,
    /// The viewer's own reminder for the whole calendar: absent when they follow the default,
    /// `null` when they turned it off.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<i32>)]
    pub my_reminder_minutes: Option<Option<i32>>,
}

impl CalendarDto {
    pub fn from_access(
        access: CalendarAccess,
        hidden: bool,
        my_reminder_minutes: Option<Option<i32>>,
    ) -> Self {
        let c = access.calendar;
        Self {
            id: c.id,
            space_id: c.space_id,
            name: c.name,
            description: c.description,
            color: c.color,
            write_access: c.write_access,
            default_reminder_minutes: c.default_reminder_minutes,
            is_default: c.is_default,
            can_write_events: access.can_write_events,
            can_manage: access.can_manage,
            hidden,
            my_reminder_minutes,
        }
    }
}

/// A new calendar.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateCalendar {
    pub name: String,
    pub color: String,
    pub description: Option<String>,
    /// `members` (the default) or `admins`; ignored for a personal calendar.
    pub write_access: Option<String>,
    /// Absent: ten minutes. `null`: no reminder.
    #[serde(default, deserialize_with = "absent_null_or")]
    #[schema(value_type = Option<i32>)]
    pub default_reminder_minutes: Option<Option<i32>>,
}

/// A change to a calendar; absent fields stay as they are.
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct UpdateCalendar {
    pub name: Option<String>,
    pub color: Option<String>,
    #[serde(default, deserialize_with = "absent_null_or")]
    #[schema(value_type = Option<String>)]
    pub description: Option<Option<String>>,
    pub write_access: Option<String>,
    #[serde(default, deserialize_with = "absent_null_or")]
    #[schema(value_type = Option<i32>)]
    pub default_reminder_minutes: Option<Option<i32>>,
}

/// The viewer's own settings for a calendar; absent fields stay as they are.
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct CalendarMe {
    pub hidden: Option<bool>,
    /// A number of minutes, or `null` for no reminder.
    #[serde(default, deserialize_with = "absent_null_or")]
    #[schema(value_type = Option<i32>)]
    pub reminder_minutes: Option<Option<i32>>,
    /// `true` drops the viewer's own reminder and follows the calendar's default again.
    #[serde(default)]
    pub reminder_default: bool,
}

/// Deleting a calendar names it, as a confirmation.
#[derive(Debug, Deserialize, ToSchema)]
pub struct DeleteCalendar {
    pub confirm_name: String,
}

/// An event as the form sends it, for a new event or a change.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct EventInput {
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub all_day: bool,
    /// RFC 3339 for a timed event, `YYYY-MM-DD` for an all-day one.
    pub start: String,
    /// Same form as `start`; exclusive for an all-day event (one day on the 7th ends on the 8th).
    pub end: String,
    /// IANA time zone of a timed event; the author's profile one when absent.
    pub tzid: Option<String>,
    /// A bare RFC 5545 rule, `FREQ=...`; absent or null for a one-off event.
    pub rrule: Option<String>,
    /// The author's own reminder for this event: absent leaves it, `null` turns it off.
    #[serde(default, deserialize_with = "absent_null_or")]
    #[schema(value_type = Option<i32>)]
    pub reminder_minutes: Option<Option<i32>>,
    /// Another calendar to move the event to (whole-series changes only).
    pub calendar_id: Option<Uuid>,
}

/// One occurrence, ready to draw.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct OccurrenceDto {
    pub event_id: Uuid,
    pub calendar_id: Uuid,
    /// Which occurrence of a series this is (its original start); absent for a one-off event.
    pub recurrence_id: Option<String>,
    pub title: String,
    pub location: Option<String>,
    /// The occurrence's notes: its own when it was changed apart, else the series'.
    pub description: Option<String>,
    pub all_day: bool,
    /// RFC 3339 in UTC for a timed occurrence, `YYYY-MM-DD` for an all-day one.
    pub start: String,
    pub end: String,
    pub tzid: Option<String>,
    pub is_recurring: bool,
    /// Whether this occurrence was changed apart from its series.
    pub overridden: bool,
    pub can_edit: bool,
    /// The reminder the viewer gets for it, in minutes; absent when none.
    pub my_reminder_minutes: Option<i32>,
}

/// An event (or a series' head) with everything the form needs.
#[derive(Debug, Serialize, ToSchema)]
pub struct EventDto {
    #[serde(flatten)]
    pub head: OccurrenceDto,
    pub rrule: Option<String>,
    pub created_by: Option<Uuid>,
    /// RFC 3339.
    pub updated_at: String,
}

/// Which part of a series a change or a deletion touches.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum EditScope {
    /// The one occurrence named by `recurrence_id`.
    This,
    /// That occurrence and every later one.
    Following,
    /// The whole series.
    #[default]
    All,
}

#[derive(Debug, Deserialize)]
pub struct EditQuery {
    #[serde(default)]
    pub scope: EditScope,
    pub recurrence_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct OccurrencesQuery {
    /// RFC 3339.
    pub from: String,
    /// RFC 3339, exclusive.
    pub to: String,
    /// Comma-separated calendar ids; every visible calendar when absent.
    pub calendars: Option<String>,
}

/// The viewer's own reminder for one event (its whole series).
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct EventMe {
    /// A number of minutes, or `null` for no reminder.
    #[serde(default, deserialize_with = "absent_null_or")]
    #[schema(value_type = Option<i32>)]
    pub reminder_minutes: Option<Option<i32>>,
    /// `true` drops the viewer's choice for this event and follows their calendar setting again.
    #[serde(default)]
    pub reminder_default: bool,
}
