//! Personal iCal subscription addresses: one per calendar, or one that mixes every calendar the
//! person sees, read by a phone or a desktop client without a session.
//!
//! The token is the whole credential, so it is shown once, when the address is made, and only its
//! digest is kept. The address answers with what its owner sees *now*: once they leave a space, the
//! address of one of its calendars answers `404` and the mixed address leaves its events out.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use utoipa::ToSchema;
use uuid::Uuid;

use super::authz;
use super::error::CalendarError;
use super::events::instant_text;
use super::{attendees, ics, invitations};
use crate::auth::extract::AuthSession;
use crate::auth::tokens;
use crate::entities::{
    calendar_event_exceptions as exceptions, calendar_events, calendar_feed_tokens,
};
use crate::state::AppState;

/// How stale `last_used_at` may get before a fetch refreshes it.
const LAST_USED_GRAIN: time::Duration = time::Duration::hours(1);

/// What the mixed address is called in a client.
const MIXED_NAME: &str = "Ruchoir";

/// A subscription address, without its secret.
#[derive(Debug, Serialize, ToSchema)]
pub struct FeedDto {
    pub id: Uuid,
    /// The calendar it carries; absent for the address that mixes them all.
    pub calendar_id: Option<Uuid>,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339; absent until a client first read it.
    pub last_used_at: Option<String>,
}

/// A new subscription address: the only time its URL is given.
#[derive(Debug, Serialize, ToSchema)]
pub struct CreatedFeedDto {
    pub id: Uuid,
    pub calendar_id: Option<Uuid>,
    pub url: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateFeed {
    /// The calendar to carry; `null` for all of them.
    pub calendar_id: Option<Uuid>,
}

fn dto(row: calendar_feed_tokens::Model) -> FeedDto {
    FeedDto {
        id: row.id,
        calendar_id: row.calendar_id,
        created_at: instant_text(row.created_at),
        last_used_at: row.last_used_at.map(instant_text),
    }
}

/// `GET /api/v1/calendar/feeds`: the caller's live subscription addresses, newest first.
#[utoipa::path(
    get,
    path = "/api/v1/calendar/feeds",
    tag = "calendar",
    responses((status = 200, description = "The addresses, without their secret", body = [FeedDto]))
)]
pub async fn list_feeds(
    State(state): State<AppState>,
    session: AuthSession,
) -> Result<Json<Vec<FeedDto>>, CalendarError> {
    let rows = calendar_feed_tokens::Entity::find()
        .filter(calendar_feed_tokens::Column::UserId.eq(session.user_id))
        .filter(calendar_feed_tokens::Column::RevokedAt.is_null())
        .order_by_desc(calendar_feed_tokens::Column::CreatedAt)
        .all(&state.db)
        .await?;
    Ok(Json(rows.into_iter().map(dto).collect()))
}

/// `POST /api/v1/calendar/feeds`: a new address for one calendar, or for all of them.
#[utoipa::path(
    post,
    path = "/api/v1/calendar/feeds",
    tag = "calendar",
    request_body = CreateFeed,
    responses(
        (status = 201, description = "Created; the URL is never shown again", body = CreatedFeedDto),
        (status = 404, description = "No such calendar for the caller")
    )
)]
pub async fn create_feed(
    State(state): State<AppState>,
    session: AuthSession,
    Json(body): Json<CreateFeed>,
) -> Result<(StatusCode, Json<CreatedFeedDto>), CalendarError> {
    if let Some(calendar_id) = body.calendar_id {
        authz::access(&state.db, session.user_id, calendar_id).await?;
    }
    let token = tokens::generate_token().map_err(|_| CalendarError::Internal)?;
    let now = OffsetDateTime::now_utc();
    let row = calendar_feed_tokens::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(session.user_id),
        calendar_id: Set(body.calendar_id),
        token_hash: Set(tokens::digest(&token)),
        created_at: Set(now),
        last_used_at: Set(None),
        revoked_at: Set(None),
    }
    .insert(&state.db)
    .await?;
    let base = state.config.public_base_url.trim_end_matches('/');
    Ok((
        StatusCode::CREATED,
        Json(CreatedFeedDto {
            id: row.id,
            calendar_id: row.calendar_id,
            url: format!("{base}/api/v1/public/ical/{token}.ics"),
            created_at: instant_text(row.created_at),
        }),
    ))
}

/// `DELETE /api/v1/calendar/feeds/{feed_id}`: stop an address for good.
#[utoipa::path(
    delete,
    path = "/api/v1/calendar/feeds/{feed_id}",
    tag = "calendar",
    params(("feed_id" = Uuid, Path, description = "Address id")),
    responses(
        (status = 204, description = "Revoked"),
        (status = 404, description = "No such address for the caller")
    )
)]
pub async fn revoke_feed(
    State(state): State<AppState>,
    session: AuthSession,
    Path(feed_id): Path<Uuid>,
) -> Result<StatusCode, CalendarError> {
    let row = calendar_feed_tokens::Entity::find_by_id(feed_id)
        .one(&state.db)
        .await?
        .filter(|r| r.user_id == session.user_id && r.revoked_at.is_none())
        .ok_or(CalendarError::NotFound)?;
    let mut active = row.into_active_model();
    active.revoked_at = Set(Some(OffsetDateTime::now_utc()));
    active.update(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/v1/public/ical/{token}.ics`: the calendar file, without a session.
pub async fn serve_feed(
    State(state): State<AppState>,
    Path(file): Path<String>,
) -> Result<Response, CalendarError> {
    let token = file.strip_suffix(".ics").ok_or(CalendarError::NotFound)?;
    let row = calendar_feed_tokens::Entity::find()
        .filter(calendar_feed_tokens::Column::TokenHash.eq(tokens::digest(token)))
        .filter(calendar_feed_tokens::Column::RevokedAt.is_null())
        .one(&state.db)
        .await?
        .ok_or(CalendarError::NotFound)?;

    let mixed = row.calendar_id.is_none();
    let (name, color, calendars) = match row.calendar_id {
        Some(calendar_id) => {
            let access = authz::access(&state.db, row.user_id, calendar_id).await?;
            let calendar = access.calendar;
            (
                calendar.name.clone(),
                Some(calendar.color.clone()),
                vec![calendar.id],
            )
        }
        None => {
            let ids = authz::visible(&state.db, row.user_id)
                .await?
                .into_iter()
                .map(|a| a.calendar.id)
                .collect();
            (MIXED_NAME.to_owned(), None, ids)
        }
    };
    // The address for all of someone's calendars also carries what they are invited to from
    // calendars they do not see.
    let invited: Vec<uuid::Uuid> = if mixed {
        let seen = calendars.iter().copied().collect();
        attendees::invited_events(&state.db, row.user_id, &seen)
            .await?
            .into_iter()
            .map(|(event, _)| event.id)
            .collect()
    } else {
        Vec::new()
    };
    let events = calendar_events::Entity::find()
        .filter(
            sea_orm::Condition::any()
                .add(calendar_events::Column::CalendarId.is_in(calendars))
                .add(calendar_events::Column::Id.is_in(invited)),
        )
        .order_by_asc(calendar_events::Column::CreatedAt)
        .all(&state.db)
        .await?;
    let people = invitations::people_of(&state.db, &events).await?;
    let mut by_event: HashMap<Uuid, Vec<exceptions::Model>> = HashMap::new();
    for row in exceptions::Entity::find()
        .filter(exceptions::Column::EventId.is_in(events.iter().map(|e| e.id)))
        .all(&state.db)
        .await?
    {
        by_event.entry(row.event_id).or_default().push(row);
    }
    let pairs: Vec<_> = events
        .into_iter()
        .map(|event| {
            let rows = by_event.remove(&event.id).unwrap_or_default();
            (event, rows)
        })
        .collect();
    let body = ics::render_with(&name, color.as_deref(), &pairs, &people, None);

    let now = OffsetDateTime::now_utc();
    if row
        .last_used_at
        .is_none_or(|last| now - last > LAST_USED_GRAIN)
    {
        let mut active = row.into_active_model();
        active.last_used_at = Set(Some(now));
        active.update(&state.db).await?;
    }
    Ok((
        [
            (header::CONTENT_TYPE, "text/calendar; charset=utf-8"),
            (header::CACHE_CONTROL, "private, max-age=300"),
        ],
        body,
    )
        .into_response())
}

/// The routes that answer without a session, kept apart so they get the public rate limit.
pub fn public_router() -> Router<AppState> {
    Router::new().route("/api/v1/public/ical/{file}", get(serve_feed))
}
