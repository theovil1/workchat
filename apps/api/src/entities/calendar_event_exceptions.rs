//! The `calendar_event_exceptions` table: one occurrence of a series cancelled or changed.
//!
//! `recurrence_id` is the occurrence's original start, written `2026-10-26T08:00:00Z` (UTC) for a
//! timed series and `2026-10-26` for an all-day one. Any other column left NULL is the series'.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "calendar_event_exceptions")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub event_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub recurrence_id: String,
    pub cancelled: bool,
    pub title: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start_at: Option<TimeDateTimeWithTimeZone>,
    pub end_at: Option<TimeDateTimeWithTimeZone>,
    pub start_date: Option<TimeDate>,
    pub end_date: Option<TimeDate>,
    pub ical_extra: Json,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
