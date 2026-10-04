//! The `calendars` table: a space's calendar or a person's, never both (a CHECK holds it).

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "calendars")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub space_id: Option<Uuid>,
    pub owner_user_id: Option<Uuid>,
    pub name: String,
    pub description: Option<String>,
    /// One of the palette's pastels: `sky`, `mint`, `violet`, `pink`, `peach`, `lime`, `sun`.
    pub color: String,
    /// `members` or `admins`: who may add and change events. Ignored for a personal calendar.
    pub write_access: String,
    /// The reminder a timed event gets when nobody chose otherwise; `None` is no reminder.
    pub default_reminder_minutes: Option<i32>,
    /// A space's first calendar, or a person's: renamed, never deleted.
    pub is_default: bool,
    pub created_by: Option<Uuid>,
    pub created_at: TimeDateTimeWithTimeZone,
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
