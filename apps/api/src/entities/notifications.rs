//! The `notifications` table: a per-user in-app inbox.
//!
//! One row per delivered notification. `kind` is `mention`, `broadcast`, `reply`, `dm`, `message`,
//! `calendar_reminder`, or one of the invitation kinds `calendar_invitation`, `calendar_update`,
//! `calendar_cancel` and `calendar_declined` (enforced by a CHECK constraint). A message notification
//! carries its conversation and message, a reminder its event and occurrence, an invitation kind its
//! event (none for a cancellation, which outlives it) and a `payload`, never the other pair (a second
//! CHECK). `read_at` NULL means unread. Rows cascade away with their subject or the recipient;
//! `actor_id` is nulled if the author's account is removed.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "notifications")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub user_id: Uuid,
    /// One of `mention`, `broadcast`, `reply`, `dm`, `message`, `calendar_reminder`,
    /// `calendar_invitation`, `calendar_update`, `calendar_cancel`, `calendar_declined`.
    pub kind: String,
    pub conversation_id: Option<Uuid>,
    pub message_id: Option<Uuid>,
    /// A reminder's event and the start of the occurrence it is about.
    pub event_id: Option<Uuid>,
    pub occurrence_start: Option<TimeDateTimeWithTimeZone>,
    /// What an invitation kind says about its event, as it was when it was sent (see
    /// `crate::calendar::attendees::Snapshot`).
    pub payload: Option<Json>,
    pub actor_id: Option<Uuid>,
    pub created_at: TimeDateTimeWithTimeZone,
    pub read_at: Option<TimeDateTimeWithTimeZone>,
    /// When the email fallback decided about this row, whether it sent an email or not. NULL means
    /// it is still waiting for its turn (see `crate::notify::email`).
    pub email_handled_at: Option<TimeDateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
