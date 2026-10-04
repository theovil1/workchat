//! Web Push: telling a browser with no Ruchoir page open that something is waiting.
//!
//! **Nothing about the message leaves the instance.** A push carries only a constant marker,
//! encrypted for the subscription ([`super::ece`]), and serves to wake
//! the service worker (`apps/web/public/sw.js`), which then asks this API what to show
//! ([`pending`]) over the same authenticated, same-origin connection the app uses. The push service
//! of the browser's vendor, which the instance does not choose (see ADR 0001), learns that one of its
//! subscribers received something at a given time, and nothing else: not who wrote, not where, not a
//! word of it.
//!
//! **Only known push services are ever called.** A subscription's endpoint is a URL the browser hands
//! over, which means a URL the client chose; posting to whatever it names would let anyone with an
//! account make the server send requests into its own network. Endpoints are therefore checked
//! against [`crate::config::Config::push_allowed_hosts`] when they are stored.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::Json;
use fred::interfaces::KeysInterface;
use fred::types::{Expiration, SetOptions};
use sea_orm::sea_query::{Expr, ExprTrait, OnConflict};
use sea_orm::ActiveValue::Set;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::auth::mail_text::{self, Locale};
use crate::entities::{notifications, push_subscriptions, users};
use crate::messaging::error::ApiError;
use crate::state::AppState;

use super::prefs;
use super::vapid;

/// How long a push service keeps a push for a device that is offline. A day: past that, what it
/// would announce is in the inbox and, most likely, already in an email.
const PUSH_TTL_SECS: u32 = 24 * 60 * 60;

/// Consecutive failures after which a subscription is dropped. A browser that was uninstalled
/// usually answers `410` at once; this catches the ones whose service only ever errors.
const MAX_FAILURES: i32 = 10;

/// How far back the service worker is shown notifications from.
const PENDING_WINDOW_SECS: i64 = 24 * 60 * 60;

/// How many notifications a single wake-up draws. More than that is a backlog, and the inbox is the
/// place for a backlog.
const PENDING_LIMIT: usize = 5;

/// How long a requested test waits for the worker to collect it.
const TEST_TTL_SECS: i64 = 5 * 60;

/// The Valkey key marking that the next wake-up of `user`'s worker should draw the test notification.
fn test_key(user_id: Uuid) -> String {
    format!("push:test:{user_id}")
}

/// Whether a subscription endpoint may be called, and the origin to sign for when it may.
///
/// The endpoint must be `https`, carry no credentials, and name one of `allowed` or a subdomain of
/// it (`web.push.apple.com` for `push.apple.com`).
pub fn endpoint_audience(endpoint: &str, allowed: &[String]) -> Option<String> {
    let uri: Uri = endpoint.parse().ok()?;
    if uri.scheme_str() != Some("https") {
        return None;
    }
    let authority = uri.authority()?;
    if authority.as_str().contains('@') {
        return None;
    }
    let host = authority.host().to_ascii_lowercase();
    let known = allowed.iter().any(|suffix| {
        let suffix = suffix.trim().trim_start_matches('.').to_ascii_lowercase();
        !suffix.is_empty() && (host == suffix || host.ends_with(&format!(".{suffix}")))
    });
    known.then(|| match authority.port_u16() {
        Some(port) if port != 443 => format!("https://{host}:{port}"),
        _ => format!("https://{host}"),
    })
}

/// How the push service can reach whoever runs this instance, as RFC 8292 asks: the public address
/// when it is `https`, the sender address of its mail otherwise.
fn subject(state: &AppState) -> String {
    let base = state.config.public_base_url.trim_end_matches('/');
    if base.starts_with("https://") {
        return base.to_owned();
    }
    let from = state.config.smtp_from.as_str();
    let address = from
        .rsplit_once('<')
        .and_then(|(_, rest)| rest.split_once('>'))
        .map_or(from, |(address, _)| address)
        .trim();
    format!("mailto:{address}")
}

/// Whether the instance offers Web Push, and the key a browser subscribes against.
#[derive(Debug, Serialize, ToSchema)]
pub struct PushConfigDto {
    /// False when an administrator has turned Web Push off for the instance.
    pub available: bool,
    /// The VAPID public key (`applicationServerKey`), base64url. Absent when not available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
}

/// `GET /api/v1/push/config`: whether this instance sends Web Push, and with which key.
#[utoipa::path(
    get,
    path = "/api/v1/push/config",
    tag = "notifications",
    responses((status = 200, description = "Web Push availability", body = PushConfigDto))
)]
pub async fn config(
    State(state): State<AppState>,
    _session: AuthSession,
) -> Result<Json<PushConfigDto>, ApiError> {
    let settings = crate::admin::instance_settings(&state.db).await?;
    if !settings.web_push_enabled {
        return Ok(Json(PushConfigDto {
            available: false,
            public_key: None,
        }));
    }
    let keys = vapid::keys(&state).await?;
    Ok(Json(PushConfigDto {
        available: true,
        public_key: Some(keys.public_key),
    }))
}

/// A browser's subscription keys, as `PushSubscription.toJSON()` lays them out.
#[derive(Debug, Deserialize, ToSchema)]
pub struct SubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// A browser's subscription, as `PushSubscription.toJSON()` lays it out.
#[derive(Debug, Deserialize, ToSchema)]
pub struct SubscriptionRequest {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
}

/// A subscription to forget, named by its endpoint.
#[derive(Debug, Deserialize, ToSchema)]
pub struct UnsubscribeRequest {
    pub endpoint: String,
}

/// A base64url value of plausible length, which is all a key can be checked for before it is used.
fn plausible_key(value: &str) -> bool {
    (16..=256).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'=')
}

/// `PUT /api/v1/push/subscription`: remember this browser's subscription for the caller.
///
/// Keyed by endpoint: the same browser subscribing again refreshes its row, and a browser someone
/// else signed in on is handed to the caller rather than notifying two accounts.
#[utoipa::path(
    put,
    path = "/api/v1/push/subscription",
    tag = "notifications",
    request_body = SubscriptionRequest,
    responses(
        (status = 204, description = "Subscription stored"),
        (status = 400, description = "Not a push service this instance calls"),
        (status = 409, description = "Web Push is turned off on this instance")
    )
)]
pub async fn subscribe(
    State(state): State<AppState>,
    session: AuthSession,
    headers: HeaderMap,
    Json(body): Json<SubscriptionRequest>,
) -> Result<StatusCode, ApiError> {
    let settings = crate::admin::instance_settings(&state.db).await?;
    if !settings.web_push_enabled {
        return Err(ApiError::Conflict(
            "web push is turned off on this instance",
        ));
    }
    if body.endpoint.len() > 2048
        || endpoint_audience(&body.endpoint, &state.config.push_allowed_hosts).is_none()
    {
        return Err(ApiError::BadRequest(
            "not a push service this instance calls",
        ));
    }
    if !plausible_key(&body.keys.p256dh) || !plausible_key(&body.keys.auth) {
        return Err(ApiError::BadRequest("invalid subscription keys"));
    }
    let user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.chars().take(256).collect::<String>());

    push_subscriptions::Entity::insert(push_subscriptions::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(session.user_id),
        endpoint: Set(body.endpoint),
        p256dh: Set(body.keys.p256dh),
        auth: Set(body.keys.auth),
        user_agent: Set(user_agent),
        created_at: Set(OffsetDateTime::now_utc()),
        last_success_at: Set(None),
        failures: Set(0),
    })
    .on_conflict(
        OnConflict::column(push_subscriptions::Column::Endpoint)
            .update_columns([
                push_subscriptions::Column::UserId,
                push_subscriptions::Column::P256dh,
                push_subscriptions::Column::Auth,
                push_subscriptions::Column::UserAgent,
                push_subscriptions::Column::Failures,
            ])
            .to_owned(),
    )
    .exec(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/v1/push/subscription`: forget this browser's subscription. Idempotent, and only
/// ever the caller's own.
#[utoipa::path(
    delete,
    path = "/api/v1/push/subscription",
    tag = "notifications",
    request_body = UnsubscribeRequest,
    responses((status = 204, description = "Forgotten (or was not known)"))
)]
pub async fn unsubscribe(
    State(state): State<AppState>,
    session: AuthSession,
    Json(body): Json<UnsubscribeRequest>,
) -> Result<StatusCode, ApiError> {
    push_subscriptions::Entity::delete_many()
        .filter(push_subscriptions::Column::Endpoint.eq(body.endpoint))
        .filter(push_subscriptions::Column::UserId.eq(session.user_id))
        .exec(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Drop every subscription on the instance, when an administrator turns Web Push off.
pub async fn forget_all_subscriptions(
    db: &sea_orm::DatabaseConnection,
) -> Result<(), sea_orm::DbErr> {
    push_subscriptions::Entity::delete_many().exec(db).await?;
    Ok(())
}

/// What the service worker should draw, since when.
#[derive(Debug, Deserialize)]
pub struct PendingQuery {
    /// Only notifications created after this instant (RFC 3339): the newest one this browser has
    /// already shown. Absent, the last few minutes.
    pub since: Option<String>,
}

/// One notification, worded for the system tray.
#[derive(Debug, Serialize, ToSchema)]
pub struct PushItemDto {
    pub id: Uuid,
    pub kind: String,
    /// Absent for a reminder from a personal calendar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_id: Option<Uuid>,
    /// A message notification's conversation and message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<Uuid>,
    /// A reminder's event.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<Uuid>,
    pub title: String,
    pub body: String,
    /// RFC 3339.
    pub created_at: String,
}

/// What a wake-up draws.
#[derive(Debug, Serialize, ToSchema)]
pub struct PendingDto {
    /// Whether to draw them without a sound (the person's own setting).
    pub silent: bool,
    /// Newest first, at most a handful.
    pub items: Vec<PushItemDto>,
}

/// Word one notification for the system tray, in the reader's language.
fn tray_text(locale: Locale, dto: &crate::messaging::dto::NotificationDto) -> (String, String) {
    let actor = dto
        .actor_name
        .clone()
        .unwrap_or_else(|| mail_text::someone(locale).to_owned());
    match &dto.channel_name {
        // A direct message: who wrote is the title, what they wrote the body.
        None => (format!("{actor} · {}", dto.space_name), dto.preview.clone()),
        Some(channel) => {
            let what = format!(
                "{actor} {}",
                mail_text::notification_verb(locale, &dto.kind)
            );
            let body = if dto.preview.is_empty() {
                what
            } else {
                format!("{what}\n{}", dto.preview)
            };
            (format!("#{channel} · {}", dto.space_name), body)
        }
    }
}

/// `GET /api/v1/push/pending?since=`: the notifications a woken service worker should draw.
///
/// The same rule as the push itself ([`prefs::allows`]), so a muted channel is not drawn even when
/// something else woke the worker, and only what is still unread: a notification opened on another
/// device in the meantime has nothing left to say.
#[utoipa::path(
    get,
    path = "/api/v1/push/pending",
    tag = "notifications",
    params(("since" = Option<String>, Query, description = "RFC 3339: only newer notifications")),
    responses((status = 200, description = "What to draw", body = PendingDto))
)]
pub async fn pending(
    State(state): State<AppState>,
    session: AuthSession,
    Query(query): Query<PendingQuery>,
) -> Result<Json<PendingDto>, ApiError> {
    let now = OffsetDateTime::now_utc();
    let floor = now - time::Duration::seconds(PENDING_WINDOW_SECS);
    let since = query
        .since
        .as_deref()
        .and_then(|value| {
            OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
        })
        .unwrap_or(now - time::Duration::minutes(10));
    let since = std::cmp::Ord::max(since, floor);

    let rows = notifications::Entity::find()
        .filter(notifications::Column::UserId.eq(session.user_id))
        .filter(notifications::Column::ReadAt.is_null())
        .filter(notifications::Column::CreatedAt.gt(since))
        .order_by_desc(notifications::Column::CreatedAt)
        .limit(50)
        .all(&state.db)
        .await?;

    // A test asked for from the preferences, collected once by whichever worker wakes first.
    let test: Option<String> = state
        .hub
        .valkey()
        .getdel(test_key(session.user_id))
        .await
        .unwrap_or(None);

    let user_prefs = prefs::load(&state.db, session.user_id).await?;
    let conversation_ids: Vec<Uuid> = rows.iter().filter_map(|row| row.conversation_id).collect();
    let conversation_prefs = prefs::scopes(&state.db, session.user_id, &conversation_ids).await?;
    let shown: Vec<notifications::Model> = rows
        .into_iter()
        .filter(|row| {
            prefs::allows(
                &row.kind,
                &user_prefs,
                row.conversation_id
                    .and_then(|id| conversation_prefs.get(&id)),
                prefs::Delivery::App,
            )
        })
        .take(PENDING_LIMIT)
        .collect();

    let reader = users::Entity::find_by_id(session.user_id)
        .one(&state.db)
        .await?;
    let locale = reader
        .as_ref()
        .map(|user| Locale::parse(user.locale.as_deref()))
        .unwrap_or_default();
    let zone = crate::calendar::reminders::reader_time_zone(reader.as_ref());
    let mut items: Vec<PushItemDto> = Vec::new();
    if test.is_some() {
        items.push(PushItemDto {
            id: Uuid::nil(),
            kind: "test".to_owned(),
            space_id: None,
            conversation_id: None,
            message_id: None,
            event_id: None,
            title: "Ruchoir".to_owned(),
            body: mail_text::push_test_body(locale).to_owned(),
            created_at: crate::messaging::dto::rfc3339(now),
        });
    }
    let found = crate::messaging::notifications::hydrate(&state.db, shown)
        .await?
        .into_iter()
        .map(|dto| {
            let (title, body) = if dto.kind == "calendar_reminder" {
                let texts = crate::calendar::reminders::texts(locale, &dto, now, &zone);
                (texts.title, texts.body)
            } else if prefs::is_invitation_kind(&dto.kind) {
                crate::calendar::invitations::texts(locale, &dto, &zone)
            } else {
                tray_text(locale, &dto)
            };
            PushItemDto {
                id: dto.id,
                kind: dto.kind,
                space_id: dto.space_id,
                conversation_id: dto.conversation_id,
                message_id: dto.message_id,
                event_id: dto.event_id,
                title,
                body,
                created_at: dto.created_at,
            }
        });
    items.extend(found);
    Ok(Json(PendingDto {
        silent: !user_prefs.sound,
        items,
    }))
}

/// Announce freshly created notifications to their recipients' browsers, in the background.
///
/// Called after the transaction that created them has committed. Never fails the request that
/// caused them: a push that cannot be sent is logged, and the inbox has the notification anyway.
pub fn dispatch(state: &AppState, rows: &[notifications::Model]) {
    if rows.is_empty() {
        return;
    }
    let state = state.clone();
    let rows = rows.to_vec();
    tokio::spawn(async move {
        if let Err(error) = deliver(&state, rows).await {
            tracing::warn!(?error, "could not send web push notifications");
        }
    });
}

/// Send one push per subscription of every recipient who may be interrupted now.
async fn deliver(state: &AppState, rows: Vec<notifications::Model>) -> Result<(), ApiError> {
    let settings = crate::admin::instance_settings(&state.db).await?;
    if !settings.web_push_enabled {
        return Ok(());
    }

    let mut by_user: HashMap<Uuid, Vec<notifications::Model>> = HashMap::new();
    for row in rows {
        by_user.entry(row.user_id).or_default().push(row);
    }

    let now = OffsetDateTime::now_utc();
    let mut keys: Option<vapid::VapidKeys> = None;
    for (user_id, rows) in by_user {
        let subscriptions = push_subscriptions::Entity::find()
            .filter(push_subscriptions::Column::UserId.eq(user_id))
            .all(&state.db)
            .await?;
        if subscriptions.is_empty() {
            continue;
        }
        let Some(user) = users::Entity::find_by_id(user_id).one(&state.db).await? else {
            continue;
        };
        let user_prefs = prefs::load(&state.db, user_id).await?;
        if !prefs::may_interrupt(&user_prefs, user.manual_presence.as_deref(), now) {
            continue;
        }
        let conversation_ids: Vec<Uuid> =
            rows.iter().filter_map(|row| row.conversation_id).collect();
        let conversation_prefs = prefs::scopes(&state.db, user_id, &conversation_ids).await?;
        let allowed: Vec<&notifications::Model> = rows
            .iter()
            .filter(|row| {
                prefs::allows(
                    &row.kind,
                    &user_prefs,
                    row.conversation_id
                        .and_then(|id| conversation_prefs.get(&id)),
                    prefs::Delivery::App,
                )
            })
            .collect();
        if allowed.is_empty() {
            continue;
        }
        // Being named, written to directly or reminded of an event is worth waking a phone for; the
        // rest can wait for the device's next scheduled check.
        let urgency = if allowed
            .iter()
            .any(|row| matches!(row.kind.as_str(), "mention" | "dm" | "calendar_reminder"))
        {
            "high"
        } else {
            "normal"
        };

        if keys.is_none() {
            keys = Some(vapid::keys(state).await?);
        }
        let Some(keys) = keys.as_ref() else {
            continue;
        };
        for subscription in subscriptions {
            send_one(state, keys, subscription, urgency, now).await;
        }
    }
    Ok(())
}

/// What a push service answered.
enum Outcome {
    Delivered,
    /// The subscription is gone for good (unsubscribed, expired, or made against another key).
    Gone,
    Failed,
}

/// The shared HTTP client: rustls with the `ring` provider and bundled roots, a short timeout, and
/// every status handed back rather than turned into an error, since the status is the answer.
fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(10)))
            .http_status_as_error(false)
            .max_redirects(0)
            .build()
            .into()
    })
}

/// Send one push; `true` when the push service accepted it.
async fn send_one(
    state: &AppState,
    keys: &vapid::VapidKeys,
    subscription: push_subscriptions::Model,
    urgency: &'static str,
    now: OffsetDateTime,
) -> bool {
    // Checked again at send time: the allowlist may have been narrowed since this was stored.
    let Some(audience) =
        endpoint_audience(&subscription.endpoint, &state.config.push_allowed_hosts)
    else {
        forget(state, subscription.id).await;
        return false;
    };
    // Keys that cannot be encrypted for were never a working subscription.
    let Some(body) =
        super::ece::encrypt(super::ece::WAKE, &subscription.p256dh, &subscription.auth)
    else {
        tracing::warn!(subscription = %subscription.id, "unusable push subscription keys; dropped");
        forget(state, subscription.id).await;
        return false;
    };
    let authorization = keys.authorization(&audience, &subject(state), now);
    let endpoint = subscription.endpoint.clone();
    let result = tokio::task::spawn_blocking(move || {
        agent()
            .post(&endpoint)
            .header("Authorization", &authorization)
            .header("TTL", &PUSH_TTL_SECS.to_string())
            .header("Urgency", urgency)
            // No `Topic` header. It would collapse pushes queued for an offline device into one, but
            // Apple refuses the push outright with a topic (`400 BadWebPushTopic`), and nothing is
            // lost without it: the worker draws everything unread whenever it wakes.
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .send(&body[..])
            .map(|mut response| {
                let status = response.status().as_u16();
                // The push services say why they refuse in the body (`{"reason": ...}` at Apple,
                // a sentence elsewhere): kept, short, for the log.
                let reason = if (200..300).contains(&status) {
                    String::new()
                } else {
                    response
                        .body_mut()
                        .read_to_string()
                        .unwrap_or_default()
                        .chars()
                        .take(300)
                        .collect()
                };
                (status, reason)
            })
    })
    .await;

    let outcome = match result {
        Ok(Ok((200..=299, _))) => Outcome::Delivered,
        // 404/410: expired or unsubscribed. 401/403: the push service no longer accepts our key for
        // it. Either way it will never work again.
        Ok(Ok((status @ (401 | 403 | 404 | 410), reason))) => {
            tracing::info!(status, %reason, subscription = %subscription.id, "push subscription gone; dropped");
            Outcome::Gone
        }
        Ok(Ok((status, reason))) => {
            tracing::warn!(status, %reason, subscription = %subscription.id, "push service refused a push");
            Outcome::Failed
        }
        Ok(Err(error)) => {
            tracing::warn!(%error, subscription = %subscription.id, "could not reach a push service");
            Outcome::Failed
        }
        Err(error) => {
            tracing::warn!(%error, "push task failed");
            Outcome::Failed
        }
    };

    let delivered = matches!(outcome, Outcome::Delivered);
    let update = push_subscriptions::Entity::update_many()
        .filter(push_subscriptions::Column::Id.eq(subscription.id));
    let written = match outcome {
        Outcome::Delivered => update
            .col_expr(push_subscriptions::Column::LastSuccessAt, Expr::value(now))
            .col_expr(push_subscriptions::Column::Failures, Expr::value(0))
            .exec(&state.db)
            .await
            .map(|_| ()),
        Outcome::Gone => {
            forget(state, subscription.id).await;
            Ok(())
        }
        Outcome::Failed if subscription.failures + 1 >= MAX_FAILURES => {
            forget(state, subscription.id).await;
            Ok(())
        }
        Outcome::Failed => update
            .col_expr(
                push_subscriptions::Column::Failures,
                Expr::col(push_subscriptions::Column::Failures).add(1),
            )
            .exec(&state.db)
            .await
            .map(|_| ()),
    };
    if let Err(error) = written {
        tracing::warn!(%error, "could not record a push outcome");
    }
    delivered
}

/// What a test push did.
#[derive(Debug, Serialize, ToSchema)]
pub struct PushTestDto {
    /// How many of the caller's browsers are subscribed.
    pub subscriptions: usize,
    /// How many of those the push services accepted the test for.
    pub delivered: usize,
}

/// `POST /api/v1/push/test`: send a real push to each of the caller's subscribed browsers.
///
/// The whole chain the notifications take, on purpose: this server, the vendor's push service, the
/// service worker waking up and asking for what to draw. A test drawn by the page itself would only
/// prove that the page can draw, which is exactly what is not in question when the app is closed or
/// installed. Quiet hours and preferences do not apply: it was asked for.
#[utoipa::path(
    post,
    path = "/api/v1/push/test",
    tag = "notifications",
    responses(
        (status = 200, description = "Sent", body = PushTestDto),
        (status = 409, description = "Web Push is off, no browser is subscribed, or a test was just sent")
    )
)]
pub async fn test(
    State(state): State<AppState>,
    session: AuthSession,
) -> Result<Json<PushTestDto>, ApiError> {
    let settings = crate::admin::instance_settings(&state.db).await?;
    if !settings.web_push_enabled {
        return Err(ApiError::Conflict(
            "web push is turned off on this instance",
        ));
    }
    let subscriptions = push_subscriptions::Entity::find()
        .filter(push_subscriptions::Column::UserId.eq(session.user_id))
        .all(&state.db)
        .await?;
    if subscriptions.is_empty() {
        return Err(ApiError::Conflict(
            "no browser is subscribed for this account",
        ));
    }
    // One test every few seconds is plenty, and keeps the button from being a way to hammer a push
    // service from this server.
    let throttle: Option<String> = state
        .hub
        .valkey()
        .set(
            format!("push:test-throttle:{}", session.user_id),
            "1",
            Some(Expiration::EX(5)),
            Some(SetOptions::NX),
            false,
        )
        .await
        .map_err(|_| ApiError::Internal)?;
    if throttle.is_none() {
        return Err(ApiError::Conflict("a test was just sent"));
    }
    let _: () = state
        .hub
        .valkey()
        .set(
            test_key(session.user_id),
            "1",
            Some(Expiration::EX(TEST_TTL_SECS)),
            None,
            false,
        )
        .await
        .map_err(|_| ApiError::Internal)?;

    let keys = vapid::keys(&state).await?;
    let now = OffsetDateTime::now_utc();
    let total = subscriptions.len();
    let mut delivered = 0;
    for subscription in subscriptions {
        if send_one(&state, &keys, subscription, "high", now).await {
            delivered += 1;
        }
    }
    Ok(Json(PushTestDto {
        subscriptions: total,
        delivered,
    }))
}

async fn forget(state: &AppState, id: Uuid) {
    if let Err(error) = push_subscriptions::Entity::delete_by_id(id)
        .exec(&state.db)
        .await
    {
        tracing::warn!(%error, "could not drop a push subscription");
    }
}

#[cfg(test)]
mod tests {
    use super::endpoint_audience;

    fn hosts() -> Vec<String> {
        crate::config::DEFAULT_PUSH_HOSTS
            .split(',')
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn the_browsers_own_push_services_are_accepted() {
        let allowed = hosts();
        assert_eq!(
            endpoint_audience("https://fcm.googleapis.com/fcm/send/abc:def", &allowed).as_deref(),
            Some("https://fcm.googleapis.com")
        );
        assert_eq!(
            endpoint_audience("https://web.push.apple.com/QGx", &allowed).as_deref(),
            Some("https://web.push.apple.com")
        );
        assert_eq!(
            endpoint_audience(
                "https://updates.push.services.mozilla.com/wpush/v2/gAAA",
                &allowed
            )
            .as_deref(),
            Some("https://updates.push.services.mozilla.com")
        );
        assert!(endpoint_audience(
            "https://wns2-par02p.notify.windows.com/w/?token=x",
            &allowed
        )
        .is_some());
    }

    #[test]
    fn anything_else_is_refused() {
        let allowed = hosts();
        for endpoint in [
            // The server's own network.
            "https://127.0.0.1/hook",
            "https://localhost/hook",
            "https://169.254.169.254/latest/meta-data",
            // A look-alike that only ends with an allowed name.
            "https://evilfcm.googleapis.com.attacker.test/x",
            "https://notfcm.googleapis.com/x",
            // Plain HTTP, credentials, garbage.
            "http://fcm.googleapis.com/fcm/send/abc",
            "https://user:pass@fcm.googleapis.com/fcm/send/abc",
            "not a url",
        ] {
            assert!(
                endpoint_audience(endpoint, &allowed).is_none(),
                "{endpoint} must be refused"
            );
        }
    }

    #[test]
    fn a_non_default_port_is_part_of_the_audience() {
        let allowed = vec!["push.example".to_owned()];
        assert_eq!(
            endpoint_audience("https://push.example:8443/x", &allowed).as_deref(),
            Some("https://push.example:8443")
        );
    }
}
