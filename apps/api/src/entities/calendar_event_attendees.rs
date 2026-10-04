//! The `calendar_event_attendees` table: who is invited to an event (its whole series) and their
//! answer. An attendee is an account (`user_id`) or an email address (`email`, with the `name` it was
//! given). Someone invited by address answers through a link: `token_digest` finds them, and the
//! token itself is kept encrypted (`token_cipher`, `token_nonce`) so later mails repeat the link.
//! `status` is `needs_action`, `accepted`, `tentative` or `declined`.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "calendar_event_attendees")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub event_id: Uuid,
    pub user_id: Option<Uuid>,
    pub email: Option<String>,
    pub name: Option<String>,
    pub status: String,
    pub token_digest: Option<String>,
    pub token_cipher: Option<Vec<u8>>,
    pub token_nonce: Option<Vec<u8>>,
    pub invited_by: Option<Uuid>,
    pub invited_at: TimeDateTimeWithTimeZone,
    pub responded_at: Option<TimeDateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
