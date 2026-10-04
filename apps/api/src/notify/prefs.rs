//! Notification preferences, held by the server so that it can obey them.
//!
//! They used to live in the browser: the global switches in `localStorage`, the per-channel ones in
//! the memory of one tab. That was enough while every notification was drawn by an open page, and it
//! stops being enough the moment the server itself reaches out (a push to a closed browser, an email).
//! A channel muted on one device has to be muted for the server, or the phone rings for it anyway.
//!
//! Three layers, read together by [`allows`], the nearest one that says something winning:
//!
//! - **Each conversation's level** ([`ConversationPref`]), on the membership row that already
//!   carried the columns (`channel_members`, `dm_participants`): `default`, `all` (every message),
//!   `mentions` or `none`, plus a mute.
//! - **Each space's level** (`space_notification_prefs`), for the conversations left on `default`.
//! - **The person's own settings** ([`NotificationPrefs`]), one JSON document in
//!   `user_preferences.notifications`: the master switch, which kinds reach them in the app and
//!   which by email (mentions, `@channel`, replies, direct messages, every message), quiet hours.
//!
//! A level decides how much a conversation says; the kinds decide through which door. `all` adds a
//! notification for every message (kind `message`), `mentions` keeps only what names or addresses
//! the person, `none` silences it.
//!
//! Quiet hours are kept as the local wall-clock times the person typed, plus the offset of their
//! clock from UTC, which the client refreshes on every load. That follows a change of time zone or of
//! daylight saving time the next time the app is opened, without a time-zone database on the server.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::sea_query::OnConflict;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, IntoActiveModel, QueryFilter,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{
    channel_members, conversations, dm_participants, space_notification_prefs, user_preferences,
};
use crate::messaging::error::ApiError;
use crate::state::AppState;

/// The largest offset from UTC a clock can have (UTC+14, Kiribati), in minutes.
const MAX_OFFSET_MINUTES: i32 = 14 * 60;

/// A person's own notification settings.
///
/// Every field has a default, and a stored document missing a field (written before it existed)
/// takes that default rather than failing to load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(default)]
pub struct NotificationPrefs {
    /// Master switch: off, nothing notifies, anywhere.
    pub enabled: bool,
    /// Play a sound with a notification.
    pub sound: bool,
    /// What is signalled in the app and by push, per kind. `channel_mentions` is `@channel` and
    /// `@here` (its name predates the others and is kept so stored documents still read).
    pub mentions: bool,
    pub channel_mentions: bool,
    pub replies: bool,
    pub direct_messages: bool,
    /// A notification for every message, not only the ones addressed to the person: the default
    /// for conversations left on `default` in spaces left on `default`. Off by default.
    pub messages: bool,
    /// Hold notifications back during the window below.
    pub quiet_hours: bool,
    /// Start of the quiet window, `HH:MM`, in the person's local time. May be later than
    /// `quiet_to` for a window that runs past midnight.
    pub quiet_from: String,
    /// End of the quiet window, `HH:MM`, local time.
    pub quiet_to: String,
    /// Offset of the person's clock from UTC, in minutes (`+120` in Paris in summer).
    pub utc_offset_minutes: i32,
    /// Email what is still unread after a while, when no Ruchoir page is open: the master switch
    /// of the email fallback, then the same four kinds as above. `@channel` is off by default by
    /// email: being one of a whole room is rarely worth a message in someone's inbox.
    pub email: bool,
    pub email_mentions: bool,
    pub email_broadcasts: bool,
    pub email_replies: bool,
    pub email_direct_messages: bool,
    pub email_messages: bool,
    /// Calendar reminders, in the app and by push, then by mail. Their own switches: a reminder is
    /// asked for, not something that happened in a conversation.
    pub calendar_reminders: bool,
    pub email_calendar_reminders: bool,
    /// Calendar invitations and what follows them (a change, a cancellation, a refusal), in the app
    /// and by push, then by mail.
    pub calendar_invitations: bool,
    pub email_calendar_invitations: bool,
}

/// Where a notification would go: the app and push, or the email digest. Each person chooses, per
/// kind, for each of the two.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    App,
    Email,
}

impl Default for NotificationPrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            sound: false,
            mentions: true,
            channel_mentions: true,
            replies: true,
            direct_messages: true,
            messages: false,
            quiet_hours: false,
            quiet_from: "21:00".to_owned(),
            quiet_to: "08:00".to_owned(),
            utc_offset_minutes: 0,
            email: true,
            email_mentions: true,
            email_broadcasts: false,
            email_replies: true,
            email_direct_messages: true,
            email_messages: false,
            calendar_reminders: true,
            email_calendar_reminders: true,
            calendar_invitations: true,
            email_calendar_invitations: true,
        }
    }
}

/// Minutes since midnight for an `HH:MM` string, or `None` when it is not one.
fn minutes_of_day(hhmm: &str) -> Option<i32> {
    let (h, m) = hhmm.split_once(':')?;
    let (h, m): (i32, i32) = (h.parse().ok()?, m.parse().ok()?);
    ((0..24).contains(&h) && (0..60).contains(&m)).then_some(h * 60 + m)
}

impl NotificationPrefs {
    /// Refuse a document the server could not act on, rather than storing it and guessing later.
    fn validate(&self) -> Result<(), ApiError> {
        if minutes_of_day(&self.quiet_from).is_none() || minutes_of_day(&self.quiet_to).is_none() {
            return Err(ApiError::BadRequest("quiet hours must be HH:MM"));
        }
        if self.utc_offset_minutes.abs() > MAX_OFFSET_MINUTES {
            return Err(ApiError::BadRequest("utc offset out of range"));
        }
        Ok(())
    }

    /// Whether `at` falls inside the quiet window, read in the person's local time.
    ///
    /// The window may run past midnight (21:00 to 08:00 is the ordinary case), so it is read as two
    /// ranges when it starts later than it ends. An empty window (start equals end) is never quiet.
    pub fn in_quiet_hours(&self, at: OffsetDateTime) -> bool {
        if !self.quiet_hours {
            return false;
        }
        let (Some(from), Some(to)) = (
            minutes_of_day(&self.quiet_from),
            minutes_of_day(&self.quiet_to),
        ) else {
            return false;
        };
        if from == to {
            return false;
        }
        let utc = i32::from(at.hour()) * 60 + i32::from(at.minute());
        let now = (utc + self.utc_offset_minutes).rem_euclid(24 * 60);
        if from < to {
            now >= from && now < to
        } else {
            now >= from || now < to
        }
    }
}

/// How much one conversation notifies one person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ConversationPref {
    /// `default` (the space's level), `all` (every message), `mentions` or `none`.
    pub level: String,
    pub muted: bool,
}

impl Default for ConversationPref {
    fn default() -> Self {
        Self {
            level: "default".to_owned(),
            muted: false,
        }
    }
}

/// Everything above the person's own settings that bears on one conversation: its level, and the
/// level of the space it is in.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scope {
    pub conversation: ConversationPref,
    /// The space's level (`all`, `mentions`, `none`), when the person set one.
    pub space_level: Option<String>,
}

impl Scope {
    /// The level in force: the conversation's, else the space's, else `default` (the person's own).
    pub fn level(&self) -> &str {
        match self.conversation.level.as_str() {
            "default" => self.space_level.as_deref().unwrap_or("default"),
            level => level,
        }
    }
}

/// Whether a notification of `kind` should reach someone by `delivery`, given their settings and
/// the conversation's. Mirrors `passesPref` in `apps/web/features/app/notifications.ts`, which applies
/// the same rule to the inbox on screen: the two must agree, or the phone and the app disagree about
/// what was worth saying.
///
/// Quiet hours and "do not disturb" are not part of this: they decide *when*, not *whether*, and
/// the inbox shows the notification either way.
pub fn allows(
    kind: &str,
    prefs: &NotificationPrefs,
    scope: Option<&Scope>,
    delivery: Delivery,
) -> bool {
    if !prefs.enabled {
        return false;
    }
    // A reminder or an invitation belongs to no conversation: its own switches decide.
    if kind == "calendar_reminder" {
        return allows_reminder(prefs, delivery);
    }
    if is_invitation_kind(kind) {
        return match delivery {
            Delivery::App => prefs.calendar_invitations,
            Delivery::Email => prefs.email && prefs.email_calendar_invitations,
        };
    }
    let fallback = Scope::default();
    let scope = scope.unwrap_or(&fallback);
    if scope.conversation.muted {
        return false;
    }
    let level = scope.level();
    if level == "none" {
        return false;
    }
    if kind == "message" {
        if !wants_every_message(prefs, scope) {
            return false;
        }
        return match delivery {
            Delivery::App => true,
            Delivery::Email => prefs.email_messages,
        };
    }
    let wanted = match (delivery, kind) {
        (Delivery::App, "mention") => prefs.mentions,
        (Delivery::App, "broadcast") => prefs.channel_mentions,
        (Delivery::App, "reply") => prefs.replies,
        (Delivery::App, "dm") => prefs.direct_messages,
        (Delivery::Email, "mention") => prefs.email_mentions,
        (Delivery::Email, "broadcast") => prefs.email_broadcasts,
        (Delivery::Email, "reply") => prefs.email_replies,
        (Delivery::Email, "dm") => prefs.email_direct_messages,
        _ => false,
    };
    if !wanted {
        return false;
    }
    if level == "mentions" {
        return matches!(kind, "mention" | "broadcast" | "dm");
    }
    true
}

/// Whether a notification kind is one of an invitation's: the invitation itself, a change, a
/// cancellation, a refusal.
pub fn is_invitation_kind(kind: &str) -> bool {
    matches!(
        kind,
        "calendar_invitation" | "calendar_update" | "calendar_cancel" | "calendar_declined"
    )
}

/// Whether a calendar reminder reaches someone by `delivery`. Quiet hours decide when, not whether,
/// as for every other kind.
pub fn allows_reminder(prefs: &NotificationPrefs, delivery: Delivery) -> bool {
    prefs.enabled
        && match delivery {
            Delivery::App => prefs.calendar_reminders,
            // The mail column's master switch holds them as it holds every other kind.
            Delivery::Email => prefs.email && prefs.email_calendar_reminders,
        }
}

/// Whether someone wants a notification for every message of a conversation: its level (or its
/// space's) says `all`, or nothing says anything and their own default does.
pub fn wants_every_message(prefs: &NotificationPrefs, scope: &Scope) -> bool {
    if !prefs.enabled || scope.conversation.muted {
        return false;
    }
    match scope.level() {
        "all" => true,
        "default" => prefs.messages,
        _ => false,
    }
}

/// Whether someone may be interrupted right now: outside their quiet hours and not in "do not
/// disturb". What cannot interrupt them now is not lost: the inbox has it, and the email fallback
/// waits for the window to close.
pub fn may_interrupt(
    prefs: &NotificationPrefs,
    manual_presence: Option<&str>,
    at: OffsetDateTime,
) -> bool {
    manual_presence != Some("dnd") && !prefs.in_quiet_hours(at)
}

/// Read someone's settings, with the defaults for anything never saved.
pub async fn load<C: ConnectionTrait>(
    db: &C,
    user_id: Uuid,
) -> Result<NotificationPrefs, ApiError> {
    let row = user_preferences::Entity::find_by_id(user_id)
        .one(db)
        .await?;
    Ok(row
        .and_then(|row| row.notifications)
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default())
}

/// One person's [`Scope`] for a set of conversations, keyed by conversation id. A conversation
/// absent from the map has no membership row for them and takes the defaults.
pub async fn scopes<C: ConnectionTrait>(
    db: &C,
    user_id: Uuid,
    conversation_ids: &[Uuid],
) -> Result<HashMap<Uuid, Scope>, ApiError> {
    let mut out = HashMap::new();
    if conversation_ids.is_empty() {
        return Ok(out);
    }
    let space_of: HashMap<Uuid, Uuid> = conversations::Entity::find()
        .filter(conversations::Column::Id.is_in(conversation_ids.to_vec()))
        .all(db)
        .await?
        .into_iter()
        .map(|c| (c.id, c.space_id))
        .collect();
    let space_ids: Vec<Uuid> = space_of.values().copied().collect();
    let space_levels: HashMap<Uuid, String> = space_notification_prefs::Entity::find()
        .filter(space_notification_prefs::Column::UserId.eq(user_id))
        .filter(space_notification_prefs::Column::SpaceId.is_in(space_ids))
        .all(db)
        .await?
        .into_iter()
        .map(|row| (row.space_id, row.level))
        .collect();
    let mut conversation: HashMap<Uuid, ConversationPref> = HashMap::new();
    // A conversation is a channel or a direct message, never both, and the two share its id.
    for row in channel_members::Entity::find()
        .filter(channel_members::Column::UserId.eq(user_id))
        .filter(channel_members::Column::ChannelId.is_in(conversation_ids.to_vec()))
        .all(db)
        .await?
    {
        conversation.insert(
            row.channel_id,
            ConversationPref {
                level: row.notification_level,
                muted: row.muted,
            },
        );
    }
    for row in dm_participants::Entity::find()
        .filter(dm_participants::Column::UserId.eq(user_id))
        .filter(dm_participants::Column::DmId.is_in(conversation_ids.to_vec()))
        .all(db)
        .await?
    {
        conversation.insert(
            row.dm_id,
            ConversationPref {
                level: row.notification_level,
                muted: row.muted,
            },
        );
    }
    for id in conversation_ids {
        out.insert(
            *id,
            Scope {
                conversation: conversation.remove(id).unwrap_or_default(),
                space_level: space_of
                    .get(id)
                    .and_then(|space| space_levels.get(space).cloned()),
            },
        );
    }
    Ok(out)
}

/// Among `candidates` (members of a channel, the author and anyone already notified left out), the
/// ones who asked for a notification for every message of it. A handful of queries whatever the
/// number of candidates.
pub async fn every_message_recipients<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    channel_id: Uuid,
    candidates: &[Uuid],
) -> Result<Vec<Uuid>, ApiError> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let prefs: HashMap<Uuid, NotificationPrefs> = user_preferences::Entity::find()
        .filter(user_preferences::Column::UserId.is_in(candidates.to_vec()))
        .all(db)
        .await?
        .into_iter()
        .filter_map(|row| {
            let prefs = row
                .notifications
                .and_then(|json| serde_json::from_str(&json).ok())?;
            Some((row.user_id, prefs))
        })
        .collect();
    let levels: HashMap<Uuid, ConversationPref> = channel_members::Entity::find()
        .filter(channel_members::Column::ChannelId.eq(channel_id))
        .filter(channel_members::Column::UserId.is_in(candidates.to_vec()))
        .all(db)
        .await?
        .into_iter()
        .map(|row| {
            (
                row.user_id,
                ConversationPref {
                    level: row.notification_level,
                    muted: row.muted,
                },
            )
        })
        .collect();
    let space_levels: HashMap<Uuid, String> = space_notification_prefs::Entity::find()
        .filter(space_notification_prefs::Column::SpaceId.eq(space_id))
        .filter(space_notification_prefs::Column::UserId.is_in(candidates.to_vec()))
        .all(db)
        .await?
        .into_iter()
        .map(|row| (row.user_id, row.level))
        .collect();
    let default_prefs = NotificationPrefs::default();
    Ok(candidates
        .iter()
        .copied()
        .filter(|user| {
            let scope = Scope {
                conversation: levels.get(user).cloned().unwrap_or_default(),
                space_level: space_levels.get(user).cloned(),
            };
            wants_every_message(prefs.get(user).unwrap_or(&default_prefs), &scope)
        })
        .collect())
}

/// `GET /api/v1/me/notification-preferences`: the caller's own notification settings.
#[utoipa::path(
    get,
    path = "/api/v1/me/notification-preferences",
    tag = "notifications",
    responses((status = 200, description = "Current settings", body = NotificationPrefs))
)]
pub async fn get_preferences(
    State(state): State<AppState>,
    session: AuthSession,
) -> Result<Json<NotificationPrefs>, ApiError> {
    Ok(Json(load(&state.db, session.user_id).await?))
}

/// `PUT /api/v1/me/notification-preferences`: replace the caller's notification settings.
#[utoipa::path(
    put,
    path = "/api/v1/me/notification-preferences",
    tag = "notifications",
    request_body = NotificationPrefs,
    responses(
        (status = 200, description = "Settings as stored", body = NotificationPrefs),
        (status = 400, description = "A time or offset the server cannot read")
    )
)]
pub async fn put_preferences(
    State(state): State<AppState>,
    session: AuthSession,
    Json(prefs): Json<NotificationPrefs>,
) -> Result<Json<NotificationPrefs>, ApiError> {
    prefs.validate()?;
    let json = serde_json::to_string(&prefs).map_err(|_| ApiError::Internal)?;
    let now = OffsetDateTime::now_utc();
    user_preferences::Entity::insert(user_preferences::ActiveModel {
        user_id: Set(session.user_id),
        notifications: Set(Some(json)),
        updated_at: Set(now),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::column(user_preferences::Column::UserId)
            .update_columns([
                user_preferences::Column::Notifications,
                user_preferences::Column::UpdatedAt,
            ])
            .to_owned(),
    )
    .exec(&state.db)
    .await?;
    Ok(Json(prefs))
}

/// `PUT /api/v1/conversations/{conversation_id}/notification-preference`: how much one channel or
/// direct message notifies the caller.
///
/// Written on the caller's own membership row, so only a member can set it: someone reading a public
/// channel they have not joined is not notified by it in the first place.
#[utoipa::path(
    put,
    path = "/api/v1/conversations/{conversation_id}/notification-preference",
    tag = "notifications",
    params(("conversation_id" = Uuid, Path, description = "Channel or direct-message id")),
    request_body = ConversationPref,
    responses(
        (status = 204, description = "Preference saved"),
        (status = 400, description = "Unknown level"),
        (status = 403, description = "Not a member of the conversation")
    )
)]
pub async fn put_conversation_preference(
    State(state): State<AppState>,
    session: AuthSession,
    Path(conversation_id): Path<Uuid>,
    Json(body): Json<ConversationPref>,
) -> Result<StatusCode, ApiError> {
    if !matches!(body.level.as_str(), "default" | "all" | "mentions" | "none") {
        return Err(ApiError::BadRequest(
            "level must be default, all, mentions or none",
        ));
    }
    if let Some(row) = channel_members::Entity::find_by_id((conversation_id, session.user_id))
        .one(&state.db)
        .await?
    {
        let mut active = row.into_active_model();
        active.notification_level = Set(body.level);
        active.muted = Set(body.muted);
        active.update(&state.db).await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    if let Some(row) = dm_participants::Entity::find_by_id((conversation_id, session.user_id))
        .one(&state.db)
        .await?
    {
        let mut active = row.into_active_model();
        active.notification_level = Set(body.level);
        active.muted = Set(body.muted);
        active.update(&state.db).await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    Err(ApiError::Forbidden)
}

/// How much a whole space notifies the caller.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct SpacePref {
    /// `default` (the caller's own settings), `all`, `mentions` or `none`.
    pub level: String,
}

/// `PUT /api/v1/spaces/{space_id}/notification-preference`: how much a space notifies the caller,
/// for its conversations left on `default`. `default` removes the space's own level.
#[utoipa::path(
    put,
    path = "/api/v1/spaces/{space_id}/notification-preference",
    tag = "notifications",
    params(("space_id" = Uuid, Path, description = "Space id")),
    request_body = SpacePref,
    responses(
        (status = 204, description = "Preference saved"),
        (status = 400, description = "Unknown level"),
        (status = 403, description = "Not a member of the space")
    )
)]
pub async fn put_space_preference(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
    Json(body): Json<SpacePref>,
) -> Result<StatusCode, ApiError> {
    crate::messaging::authz::ensure_space_member(&state.db, space_id, session.user_id).await?;
    match body.level.as_str() {
        "default" => {
            space_notification_prefs::Entity::delete_by_id((session.user_id, space_id))
                .exec(&state.db)
                .await?;
        }
        "all" | "mentions" | "none" => {
            space_notification_prefs::Entity::insert(space_notification_prefs::ActiveModel {
                user_id: Set(session.user_id),
                space_id: Set(space_id),
                level: Set(body.level),
                updated_at: Set(OffsetDateTime::now_utc()),
            })
            .on_conflict(
                OnConflict::columns([
                    space_notification_prefs::Column::UserId,
                    space_notification_prefs::Column::SpaceId,
                ])
                .update_columns([
                    space_notification_prefs::Column::Level,
                    space_notification_prefs::Column::UpdatedAt,
                ])
                .to_owned(),
            )
            .exec(&state.db)
            .await?;
        }
        _ => {
            return Err(ApiError::BadRequest(
                "level must be default, all, mentions or none",
            ))
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// The caller's level for each space that has one, keyed by space id.
pub async fn space_levels(
    db: &sea_orm::DatabaseConnection,
    user_id: Uuid,
) -> Result<HashMap<Uuid, String>, ApiError> {
    Ok(space_notification_prefs::Entity::find()
        .filter(space_notification_prefs::Column::UserId.eq(user_id))
        .all(db)
        .await?
        .into_iter()
        .map(|row| (row.space_id, row.level))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(level: &str, muted: bool) -> Scope {
        Scope {
            conversation: ConversationPref {
                level: level.to_owned(),
                muted,
            },
            space_level: None,
        }
    }

    /// A moment at `h:m` UTC. The date is irrelevant to a daily window.
    fn utc(h: i64, m: i64) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(h * 3600 + m * 60).unwrap()
    }

    fn quiet(from: &str, to: &str, offset: i32) -> NotificationPrefs {
        NotificationPrefs {
            quiet_hours: true,
            quiet_from: from.to_owned(),
            quiet_to: to.to_owned(),
            utc_offset_minutes: offset,
            ..NotificationPrefs::default()
        }
    }

    #[test]
    fn an_overnight_window_is_read_in_local_time() {
        // 21:00 to 08:00 in Paris in summer (UTC+2). 20:30 UTC is 22:30 there: quiet.
        let prefs = quiet("21:00", "08:00", 120);
        assert!(prefs.in_quiet_hours(utc(20, 30)));
        // 06:30 UTC is 08:30 there: awake again.
        assert!(!prefs.in_quiet_hours(utc(6, 30)));
        // 04:00 UTC is 06:00 there: still the night.
        assert!(prefs.in_quiet_hours(utc(4, 0)));
    }

    #[test]
    fn a_daytime_window_and_a_negative_offset() {
        // 12:00 to 14:00 in New York in winter (UTC-5). 17:30 UTC is 12:30 there.
        let prefs = quiet("12:00", "14:00", -300);
        assert!(prefs.in_quiet_hours(utc(17, 30)));
        assert!(!prefs.in_quiet_hours(utc(19, 30)));
    }

    #[test]
    fn switched_off_or_empty_windows_are_never_quiet() {
        let mut prefs = quiet("09:00", "09:00", 0);
        assert!(!prefs.in_quiet_hours(utc(9, 0)));
        prefs.quiet_to = "10:00".to_owned();
        prefs.quiet_hours = false;
        assert!(!prefs.in_quiet_hours(utc(9, 30)));
    }

    #[test]
    fn the_server_rule_matches_the_inbox_rule() {
        let prefs = NotificationPrefs::default();
        let mentions_only = scope("mentions", false);
        assert!(allows("reply", &prefs, None, Delivery::App));
        assert!(!allows(
            "reply",
            &prefs,
            Some(&mentions_only),
            Delivery::App
        ));
        assert!(allows(
            "mention",
            &prefs,
            Some(&mentions_only),
            Delivery::App
        ));
        assert!(allows("dm", &prefs, Some(&mentions_only), Delivery::App));

        let muted = scope("all", true);
        assert!(!allows("mention", &prefs, Some(&muted), Delivery::App));

        let no_broadcasts = NotificationPrefs {
            channel_mentions: false,
            ..NotificationPrefs::default()
        };
        assert!(!allows("broadcast", &no_broadcasts, None, Delivery::App));
        assert!(allows("mention", &no_broadcasts, None, Delivery::App));

        let off = NotificationPrefs {
            enabled: false,
            ..NotificationPrefs::default()
        };
        assert!(!allows("dm", &off, None, Delivery::App));
    }

    #[test]
    fn each_kind_is_chosen_separately_for_the_app_and_for_email() {
        let prefs = NotificationPrefs {
            replies: false,
            email_direct_messages: false,
            ..NotificationPrefs::default()
        };
        assert!(!allows("reply", &prefs, None, Delivery::App));
        assert!(allows("reply", &prefs, None, Delivery::Email));
        assert!(allows("dm", &prefs, None, Delivery::App));
        assert!(!allows("dm", &prefs, None, Delivery::Email));
        // `@channel` reaches the app by default, but not the inbox.
        let defaults = NotificationPrefs::default();
        assert!(allows("broadcast", &defaults, None, Delivery::App));
        assert!(!allows("broadcast", &defaults, None, Delivery::Email));
        // A muted conversation is muted everywhere, whatever the kind says.
        let muted = scope("all", true);
        assert!(!allows("dm", &defaults, Some(&muted), Delivery::Email));
    }

    #[test]
    fn the_nearest_level_wins_and_every_message_is_opt_in() {
        let prefs = NotificationPrefs::default();
        // Nothing set anywhere: addressed messages only.
        assert!(!allows("message", &prefs, None, Delivery::App));
        assert!(allows("mention", &prefs, None, Delivery::App));
        // The space asks for everything: every message of its channels left on `default`.
        let loud_space = Scope {
            conversation: ConversationPref::default(),
            space_level: Some("all".to_owned()),
        };
        assert!(allows("message", &prefs, Some(&loud_space), Delivery::App));
        assert!(!allows(
            "message",
            &prefs,
            Some(&loud_space),
            Delivery::Email
        ));
        // A channel of that space set to mentions overrides it.
        let quiet_channel = Scope {
            conversation: ConversationPref {
                level: "mentions".to_owned(),
                muted: false,
            },
            space_level: Some("all".to_owned()),
        };
        assert!(!allows(
            "message",
            &prefs,
            Some(&quiet_channel),
            Delivery::App
        ));
        assert!(allows(
            "mention",
            &prefs,
            Some(&quiet_channel),
            Delivery::App
        ));
        // A silenced space silences its channels on `default`, mentions included.
        let silent_space = Scope {
            conversation: ConversationPref::default(),
            space_level: Some("none".to_owned()),
        };
        assert!(!allows(
            "mention",
            &prefs,
            Some(&silent_space),
            Delivery::App
        ));
        // The person's own default can ask for every message everywhere, and by email too.
        let chatty = NotificationPrefs {
            messages: true,
            email_messages: true,
            ..NotificationPrefs::default()
        };
        assert!(allows("message", &chatty, None, Delivery::App));
        assert!(allows("message", &chatty, None, Delivery::Email));
        assert!(!allows(
            "message",
            &chatty,
            Some(&silent_space),
            Delivery::App
        ));
    }

    #[test]
    fn do_not_disturb_holds_everything_back() {
        let prefs = NotificationPrefs::default();
        let now = utc(12, 0);
        assert!(may_interrupt(&prefs, None, now));
        assert!(may_interrupt(&prefs, Some("away"), now));
        assert!(!may_interrupt(&prefs, Some("dnd"), now));
    }

    #[test]
    fn a_document_from_before_a_field_existed_still_loads() {
        let old: NotificationPrefs = serde_json::from_str(r#"{"enabled":false}"#).unwrap();
        assert!(!old.enabled);
        assert!(old.email);
        assert_eq!(old.quiet_from, "21:00");
    }

    #[test]
    fn nonsense_times_are_refused() {
        assert!(quiet("25:00", "08:00", 0).validate().is_err());
        assert!(quiet("21:00", "8h", 0).validate().is_err());
        assert!(quiet("21:00", "08:00", 15 * 60).validate().is_err());
        assert!(quiet("21:00", "08:00", -120).validate().is_ok());
    }

    #[test]
    fn calendar_reminders_have_their_own_switches() {
        let mut prefs = NotificationPrefs::default();
        assert!(allows_reminder(&prefs, Delivery::App));
        assert!(allows_reminder(&prefs, Delivery::Email));
        // `allows` agrees for the kind, whatever the conversation scope says.
        assert!(allows("calendar_reminder", &prefs, None, Delivery::App));
        prefs.email_calendar_reminders = false;
        assert!(allows_reminder(&prefs, Delivery::App));
        assert!(!allows_reminder(&prefs, Delivery::Email));
        // The mail column's master switch holds reminders too, as the preferences screen shows it.
        prefs.email_calendar_reminders = true;
        prefs.email = false;
        assert!(!allows_reminder(&prefs, Delivery::Email));
        prefs.email = true;
        prefs.calendar_reminders = false;
        assert!(!allows("calendar_reminder", &prefs, None, Delivery::App));
        prefs.calendar_reminders = true;
        prefs.enabled = false;
        assert!(!allows_reminder(&prefs, Delivery::App));
        // A document saved before the switches existed reads them as on.
        let old: NotificationPrefs = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(old.calendar_reminders && old.email_calendar_reminders);
    }

    #[test]
    fn calendar_invitations_have_their_own_switches() {
        let mut prefs = NotificationPrefs::default();
        for kind in [
            "calendar_invitation",
            "calendar_update",
            "calendar_cancel",
            "calendar_declined",
        ] {
            assert!(allows(kind, &prefs, None, Delivery::App));
            assert!(allows(kind, &prefs, None, Delivery::Email));
        }
        prefs.email_calendar_invitations = false;
        assert!(allows("calendar_invitation", &prefs, None, Delivery::App));
        assert!(!allows(
            "calendar_invitation",
            &prefs,
            None,
            Delivery::Email
        ));
        prefs.calendar_invitations = false;
        assert!(!allows("calendar_update", &prefs, None, Delivery::App));
        // Reminders are not invitations.
        assert!(allows("calendar_reminder", &prefs, None, Delivery::App));
        let old: NotificationPrefs = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(old.calendar_invitations && old.email_calendar_invitations);
    }
}
