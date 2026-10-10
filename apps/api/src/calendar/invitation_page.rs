//! The page someone invited by address answers on, without an account: the event as it stands, and
//! their answer for it (the whole series; a date apart is for members).
//!
//! The token in the link is looked up by its digest, as feed tokens are; the route is limited like
//! every public one, so a token cannot be guessed by trying.

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::attendees;
use super::error::CalendarError;
use super::events::{date_text, instant_text, when_of};
use super::invitations::{self, Notice};
use super::recurrence::When;
use crate::auth::tokens;
use crate::entities::{calendar_event_attendees as attendee_rows, calendar_events, users};
use crate::state::AppState;

/// An invitation as its guest sees it.
#[derive(Debug, Serialize, ToSchema)]
pub struct PublicInvitationDto {
    pub title: String,
    pub location: Option<String>,
    pub description: Option<String>,
    /// RFC 3339 in UTC, or `YYYY-MM-DD` for an all-day event.
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub tzid: Option<String>,
    /// Whether it repeats (the answer is for every date).
    pub recurring: bool,
    /// Who invited them.
    pub organizer: Option<String>,
    /// The name they were invited under.
    pub name: Option<String>,
    /// `needs_action`, `accepted`, `tentative` or `declined`.
    pub status: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PublicAnswer {
    /// `accepted`, `tentative` or `declined`.
    pub status: String,
}

async fn find(
    state: &AppState,
    token: &str,
) -> Result<(attendee_rows::Model, calendar_events::Model), CalendarError> {
    let row = attendee_rows::Entity::find()
        .filter(attendee_rows::Column::TokenDigest.eq(tokens::digest(token)))
        .one(&state.db)
        .await?
        .ok_or(CalendarError::NotFound)?;
    let event = calendar_events::Entity::find_by_id(row.event_id)
        .one(&state.db)
        .await?
        .ok_or(CalendarError::NotFound)?;
    Ok((row, event))
}

async fn dto(
    state: &AppState,
    row: &attendee_rows::Model,
    event: &calendar_events::Model,
) -> Result<PublicInvitationDto, CalendarError> {
    let organizer = match event.created_by {
        Some(id) => users::Entity::find_by_id(id)
            .one(&state.db)
            .await?
            .map(|u| u.display_name),
        None => None,
    };
    let (start, end) = match when_of(event) {
        When::Timed { start, end } => (instant_text(start), instant_text(end)),
        When::AllDay { start, end } => (date_text(start), date_text(end)),
    };
    Ok(PublicInvitationDto {
        title: event.title.clone(),
        location: event.location.clone(),
        description: event.description.clone(),
        start,
        end,
        all_day: event.all_day,
        tzid: event.tzid.clone(),
        recurring: event.rrule.is_some(),
        organizer,
        name: row.name.clone(),
        status: row.status.clone(),
    })
}

/// `GET /api/v1/public/invitation/{token}`: the invitation, without a session.
#[utoipa::path(
    get,
    path = "/api/v1/public/invitation/{token}",
    tag = "calendar",
    params(("token" = String, Path, description = "The token from the invitation mail")),
    responses(
        (status = 200, description = "The invitation", body = PublicInvitationDto),
        (status = 404, description = "No such invitation (or no longer)")
    )
)]
pub async fn read_invitation(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<PublicInvitationDto>, CalendarError> {
    let (row, event) = find(&state, &token).await?;
    Ok(Json(dto(&state, &row, &event).await?))
}

/// `POST /api/v1/public/invitation/{token}`: answer it, for every date.
#[utoipa::path(
    post,
    path = "/api/v1/public/invitation/{token}",
    tag = "calendar",
    params(("token" = String, Path, description = "The token from the invitation mail")),
    request_body = PublicAnswer,
    responses(
        (status = 200, description = "The invitation, with the answer", body = PublicInvitationDto),
        (status = 404, description = "No such invitation (or no longer)"),
        (status = 422, description = "Not an answer")
    )
)]
pub async fn answer_invitation(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(body): Json<PublicAnswer>,
) -> Result<Json<PublicInvitationDto>, CalendarError> {
    let (row, event) = find(&state, &token).await?;
    if !attendees::is_answer(&body.status) {
        return Err(CalendarError::Invalid(
            "An answer is accepted, tentative or declined.",
        ));
    }
    attendees::answer(&state.db, &row, &body.status, None).await?;
    if body.status == attendees::DECLINED && row.status != attendees::DECLINED {
        invitations::send(
            &state,
            Some(&event),
            None,
            Notice::Declined {
                attendee: row.clone(),
                date: None,
            },
        )
        .await;
    }
    let row = attendee_rows::Entity::find_by_id(row.id)
        .one(&state.db)
        .await?
        .ok_or(CalendarError::NotFound)?;
    if let Ok(calendar) = super::authz::access_any(&state.db, event.calendar_id).await {
        let _ = super::calendars::announce(&state, &calendar).await;
    }
    Ok(Json(dto(&state, &row, &event).await?))
}

pub fn public_router() -> Router<AppState> {
    Router::new().route(
        "/api/v1/public/invitation/{token}",
        get(read_invitation).post(answer_invitation),
    )
}
