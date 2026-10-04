//! The `calendar_attendee_overrides` table: an attendee's answer for one date of a series, over
//! their answer for the series. `recurrence_id` is the occurrence's key, as exceptions write it.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "calendar_attendee_overrides")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub attendee_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub recurrence_id: String,
    pub status: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
