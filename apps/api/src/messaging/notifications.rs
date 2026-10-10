//! In-app notifications: the per-user inbox fed by mentions, direct messages and thread replies.
//!
//! Notifications are created inside the [`super::messages::send_message`] transaction (so a message
//! and its notifications commit together), then pushed over the hub to each recipient. This module
//! owns the recipient computation, the persistence helper, the DTO hydration and the read endpoints.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::sea_query::Expr;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseTransaction, EntityTrait,
    IntoActiveModel, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde::Deserialize;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{messages, notifications, users};
use crate::state::AppState;

use super::dto::{rfc3339, NotificationDto, NotificationPage};
use super::error::ApiError;

const DEFAULT_LIMIT: u64 = 30;
const MAX_LIMIT: u64 = 100;
const PREVIEW_CHARS: usize = 140;

/// Relative priority of the notification kinds, so a user who is both mentioned and a DM participant
/// (or the replied-to author) gets a single, most-specific notification.
///
/// `broadcast` (`@channel`, `@here`) sits below a mention by name and above a reply: being one of
/// fifty people addressed at once is a weaker claim on someone's attention than being named, and
/// the client is entitled to treat it differently, which it cannot do if the two arrive under the
/// same kind.
fn rank(kind: &str) -> u8 {
    match kind {
        "mention" => 4,
        "broadcast" => 3,
        "reply" => 2,
        "dm" => 1,
        _ => 0,
    }
}

/// Collapse the candidate recipients for a message into one `(user, kind)` per user, keeping the
/// highest-priority kind and never notifying the author of their own message.
pub fn compute_recipients(
    author_id: Uuid,
    mention_user_ids: &[Uuid],
    broadcast_user_ids: &[Uuid],
    dm_recipients: &[Uuid],
    reply_target: Option<Uuid>,
) -> Vec<(Uuid, &'static str)> {
    let mut best: HashMap<Uuid, &'static str> = HashMap::new();
    let mut consider = |user_id: Uuid, kind: &'static str| {
        if user_id == author_id {
            return;
        }
        let keep = best
            .get(&user_id)
            .map(|current| rank(kind) > rank(current))
            .unwrap_or(true);
        if keep {
            best.insert(user_id, kind);
        }
    };

    for &user_id in mention_user_ids {
        consider(user_id, "mention");
    }
    for &user_id in broadcast_user_ids {
        consider(user_id, "broadcast");
    }
    if let Some(target) = reply_target {
        consider(target, "reply");
    }
    for &user_id in dm_recipients {
        consider(user_id, "dm");
    }

    best.into_iter().collect()
}

/// Persist one notification per recipient inside the sending transaction, returning the created rows
/// so the caller can fan them out.
pub async fn create_for_message(
    txn: &DatabaseTransaction,
    actor_id: Uuid,
    conversation_id: Uuid,
    message_id: Uuid,
    recipients: &[(Uuid, &'static str)],
) -> Result<Vec<notifications::Model>, ApiError> {
    let now = OffsetDateTime::now_utc();
    let mut created = Vec::with_capacity(recipients.len());
    for (user_id, kind) in recipients {
        let model = notifications::ActiveModel {
            id: Set(Uuid::new_v4()),
            user_id: Set(*user_id),
            kind: Set((*kind).to_owned()),
            conversation_id: Set(Some(conversation_id)),
            message_id: Set(Some(message_id)),
            event_id: Set(None),
            occurrence_start: Set(None),
            payload: Set(None),
            actor_id: Set(Some(actor_id)),
            created_at: Set(now),
            read_at: Set(None),
            email_handled_at: Set(None),
        }
        .insert(txn)
        .await?;
        created.push(model);
    }
    Ok(created)
}

/// A short single-line plain-text excerpt of a message body.
fn preview(body: &str) -> String {
    let flat = body.replace('\n', " ");
    let trimmed = flat.trim();
    if trimmed.chars().count() <= PREVIEW_CHARS {
        return trimmed.to_owned();
    }
    let cut: String = trimmed.chars().take(PREVIEW_CHARS).collect();
    format!("{}\u{2026}", cut.trim_end())
}

/// Turn notification rows into DTOs, batch-loading each source message (for the preview) and actor
/// (for the display name) so a page costs a fixed handful of queries.
pub async fn hydrate<C: ConnectionTrait>(
    db: &C,
    rows: Vec<notifications::Model>,
) -> Result<Vec<NotificationDto>, ApiError> {
    // Calendar reminders and invitations are drawn by the calendar, which knows their events; the
    // rest are about a message. Both come back in the order they were asked for.
    let order: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
    let (reminder_rows, rows): (Vec<_>, Vec<_>) = rows
        .into_iter()
        .partition(|r| r.kind == "calendar_reminder");
    let (invitation_rows, rows): (Vec<_>, Vec<_>) = rows
        .into_iter()
        .partition(|r| crate::notify::prefs::is_invitation_kind(&r.kind));
    let mut drawn = crate::calendar::reminders::hydrate(db, reminder_rows)
        .await
        .map_err(|_| ApiError::Internal)?;
    drawn.extend(
        crate::calendar::invitations::hydrate(db, invitation_rows)
            .await
            .map_err(|_| ApiError::Internal)?,
    );
    let rows: Vec<(notifications::Model, Uuid, Uuid)> = rows
        .into_iter()
        .filter_map(|r| {
            let (conversation_id, message_id) = (r.conversation_id?, r.message_id?);
            Some((r, conversation_id, message_id))
        })
        .collect();
    if rows.is_empty() {
        return Ok(in_order(drawn, &order));
    }

    let message_ids: Vec<Uuid> = rows.iter().map(|(_, _, m)| *m).collect();
    let bodies: HashMap<Uuid, String> = messages::Entity::find()
        .filter(messages::Column::Id.is_in(message_ids))
        .all(db)
        .await?
        .into_iter()
        .map(|m| (m.id, m.body))
        .collect();

    // The space each notification happened in, read from its conversation: the client shows the
    // inbox for the space on screen, and a notification whose space it cannot determine would be
    // shown everywhere.
    // Where each one happened, in words: shared with the saved list, which needs exactly the same
    // thing for exactly the same reason.
    let conversation_ids: Vec<Uuid> = rows.iter().map(|(_, c, _)| *c).collect();
    let labels = super::conversations::label_conversations(db, conversation_ids).await?;

    let actor_ids: Vec<Uuid> = rows.iter().filter_map(|(r, _, _)| r.actor_id).collect();
    let names: HashMap<Uuid, String> = if actor_ids.is_empty() {
        HashMap::new()
    } else {
        users::Entity::find()
            .filter(users::Column::Id.is_in(actor_ids))
            .all(db)
            .await?
            .into_iter()
            .map(|u| (u.id, u.display_name))
            .collect()
    };

    drawn.extend(rows.into_iter().map(|(r, conversation_id, message_id)| {
        NotificationDto {
            preview: bodies
                .get(&message_id)
                .map(|b| preview(b))
                .unwrap_or_default(),
            actor_name: r.actor_id.and_then(|id| names.get(&id).cloned()),
            read: r.read_at.is_some(),
            created_at: rfc3339(r.created_at),
            id: r.id,
            kind: r.kind,
            space_id: labels.get(&conversation_id).map(|l| l.space_id),
            channel_name: labels
                .get(&conversation_id)
                .and_then(|l| l.channel_name.clone()),
            space_name: labels
                .get(&conversation_id)
                .map(|l| l.space_name.clone())
                .unwrap_or_default(),
            conversation_id: Some(conversation_id),
            message_id: Some(message_id),
            actor_id: r.actor_id,
            event_id: None,
            recurrence_id: None,
            event_title: None,
            event_start: None,
            event_all_day: None,
            event_location: None,
            calendar_name: None,
            event_changes: None,
            event_my_status: None,
        }
    }));
    Ok(in_order(drawn, &order))
}

/// Put drawn notifications back in the order their rows came in.
fn in_order(mut drawn: Vec<NotificationDto>, order: &[Uuid]) -> Vec<NotificationDto> {
    let position: HashMap<Uuid, usize> = order.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    drawn.sort_by_key(|dto| position.get(&dto.id).copied().unwrap_or(usize::MAX));
    drawn
}

/// Query for the notification feed.
#[derive(Debug, Deserialize)]
pub struct FeedQuery {
    /// When true, only unread notifications are returned.
    #[serde(default)]
    pub unread: bool,
    pub limit: Option<u64>,
    /// Return notifications older than this one (keyset pagination).
    pub before: Option<Uuid>,
}

/// `GET /api/v1/notifications`: the caller's notifications, newest first, with the unread count.
#[utoipa::path(
    get,
    path = "/api/v1/notifications",
    tag = "messaging",
    params(
        ("unread" = Option<bool>, Query, description = "Only unread notifications"),
        ("limit" = Option<u64>, Query, description = "Page size (max 100)"),
        ("before" = Option<Uuid>, Query, description = "Return notifications older than this id")
    ),
    responses((status = 200, description = "Notification feed", body = NotificationPage))
)]
pub async fn list_notifications(
    State(state): State<AppState>,
    session: AuthSession,
    Query(query): Query<FeedQuery>,
) -> Result<Json<NotificationPage>, ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);

    let mut select =
        notifications::Entity::find().filter(notifications::Column::UserId.eq(session.user_id));
    if query.unread {
        select = select.filter(notifications::Column::ReadAt.is_null());
    }
    if let Some(before) = query.before {
        // Resolve the cursor to its timestamp, but only if it is the caller's own row.
        if let Some(cursor) = notifications::Entity::find_by_id(before)
            .one(&state.db)
            .await?
        {
            if cursor.user_id == session.user_id {
                select = select.filter(notifications::Column::CreatedAt.lt(cursor.created_at));
            }
        }
    }

    let rows = select
        .order_by_desc(notifications::Column::CreatedAt)
        .order_by_desc(notifications::Column::Id)
        .limit(limit)
        .all(&state.db)
        .await?;

    let next_before = if rows.len() as u64 == limit {
        rows.last().map(|r| r.id)
    } else {
        None
    };

    let unread_count = notifications::Entity::find()
        .filter(notifications::Column::UserId.eq(session.user_id))
        .filter(notifications::Column::ReadAt.is_null())
        .count(&state.db)
        .await? as i64;

    let notifications = hydrate(&state.db, rows).await?;
    Ok(Json(NotificationPage {
        notifications,
        next_before,
        unread_count,
    }))
}

/// `PUT /api/v1/notifications/{id}/read`: mark one notification read. Idempotent.
#[utoipa::path(
    put,
    path = "/api/v1/notifications/{id}/read",
    tag = "messaging",
    params(("id" = Uuid, Path, description = "Notification id")),
    responses(
        (status = 204, description = "Marked read"),
        (status = 404, description = "No such notification for the caller")
    )
)]
pub async fn mark_read(
    State(state): State<AppState>,
    session: AuthSession,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let row = notifications::Entity::find_by_id(id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    // Only ever the caller's own notifications; do not reveal others exist.
    if row.user_id != session.user_id {
        return Err(ApiError::NotFound);
    }
    if row.read_at.is_none() {
        let mut active = row.into_active_model();
        active.read_at = Set(Some(OffsetDateTime::now_utc()));
        active.update(&state.db).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `PUT /api/v1/notifications/read`: mark all of the caller's notifications read. Idempotent.
#[utoipa::path(
    put,
    path = "/api/v1/notifications/read",
    tag = "messaging",
    responses((status = 204, description = "All marked read"))
)]
pub async fn mark_all_read(
    State(state): State<AppState>,
    session: AuthSession,
) -> Result<StatusCode, ApiError> {
    notifications::Entity::update_many()
        .col_expr(
            notifications::Column::ReadAt,
            Expr::value(OffsetDateTime::now_utc()),
        )
        .filter(notifications::Column::UserId.eq(session.user_id))
        .filter(notifications::Column::ReadAt.is_null())
        .exec(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::compute_recipients;
    use uuid::Uuid;

    fn kind_for(recipients: &[(Uuid, &'static str)], user: Uuid) -> Option<&'static str> {
        recipients
            .iter()
            .find(|(id, _)| *id == user)
            .map(|(_, kind)| *kind)
    }

    #[test]
    fn being_named_outranks_being_in_the_room() {
        let author = Uuid::new_v4();
        let reader = Uuid::new_v4();
        // `@here` expands to every member, so the same person is very often in both lists. They get
        // one notification, and it is the stronger one.
        let recipients = compute_recipients(author, &[reader], &[reader], &[], None);
        assert_eq!(recipients.len(), 1);
        assert_eq!(kind_for(&recipients, reader), Some("mention"));
    }

    #[test]
    fn a_broadcast_outranks_a_reply_and_a_direct_message() {
        let author = Uuid::new_v4();
        let reader = Uuid::new_v4();
        let recipients = compute_recipients(author, &[], &[reader], &[reader], Some(reader));
        assert_eq!(kind_for(&recipients, reader), Some("broadcast"));
    }

    #[test]
    fn a_broadcast_is_not_reported_as_a_mention() {
        // The distinction the reader's preference rests on: someone who has turned off `@canal`
        // can only be obeyed if these two never arrive under the same name.
        let author = Uuid::new_v4();
        let reader = Uuid::new_v4();
        let recipients = compute_recipients(author, &[], &[reader], &[], None);
        assert_eq!(kind_for(&recipients, reader), Some("broadcast"));
    }

    #[test]
    fn the_author_is_never_notified_of_their_own_message() {
        let author = Uuid::new_v4();
        let recipients = compute_recipients(author, &[author], &[author], &[author], Some(author));
        assert!(recipients.is_empty());
    }
}
