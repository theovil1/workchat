//! The `calendar_events` table: one event, or the head of a recurring series.
//!
//! A timed event has `start_at`, `end_at` and the IANA `tzid` it was written in; an all-day event
//! has `start_date` and `end_date` (exclusive). A CHECK forbids mixing the two.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "calendar_events")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub calendar_id: Uuid,
    /// The iCalendar UID, unique within its calendar.
    pub uid: String,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub all_day: bool,
    pub start_at: Option<TimeDateTimeWithTimeZone>,
    pub end_at: Option<TimeDateTimeWithTimeZone>,
    pub tzid: Option<String>,
    pub start_date: Option<TimeDate>,
    pub end_date: Option<TimeDate>,
    /// The bare RFC 5545 rule (`FREQ=WEEKLY;BYDAY=MO`), as stored and as exported.
    pub rrule: Option<String>,
    pub rdates: Option<Vec<TimeDateTimeWithTimeZone>>,
    /// When the series' last occurrence ends; `None` when it never does. Only an index aid.
    pub series_until: Option<TimeDateTimeWithTimeZone>,
    /// The iCalendar SEQUENCE, raised on every change.
    pub sequence: i32,
    /// iCalendar properties Ruchoir does not handle, kept as content lines for the export.
    pub ical_extra: Json,
    pub created_by: Option<Uuid>,
    pub updated_by: Option<Uuid>,
    pub created_at: TimeDateTimeWithTimeZone,
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
