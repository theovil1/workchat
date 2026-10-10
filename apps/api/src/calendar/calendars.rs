//! The calendars themselves: listing, creating, changing, deleting, and each viewer's own settings
//! (shown or hidden, their reminder for the whole calendar).

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, IntoActiveModel, QueryFilter,
};
use time::OffsetDateTime;
use uuid::Uuid;

use super::authz::{self, CalendarAccess, PALETTE};
use super::dto::{CalendarDto, CalendarMe, CreateCalendar, DeleteCalendar, UpdateCalendar};
use super::error::CalendarError;
use super::TIMED_REMINDERS;
use crate::auth::extract::AuthSession;
use crate::entities::{calendar_reminder_prefs, calendar_visibility, calendars, space_members};
use crate::realtime::event::RealtimeEnvelope;
use crate::state::AppState;

const NAME_MAX: usize = 200;
const DESCRIPTION_MAX: usize = 20_000;

/// A calendar name, trimmed, between 1 and 200 characters.
fn clean_name(name: &str) -> Result<String, CalendarError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > NAME_MAX {
        return Err(CalendarError::Invalid(
            "A calendar name has 1 to 200 characters.",
        ));
    }
    Ok(name.to_owned())
}

fn check_color(color: &str) -> Result<(), CalendarError> {
    if PALETTE.contains(&color) {
        Ok(())
    } else {
        Err(CalendarError::Invalid("Unknown calendar colour."))
    }
}

fn check_write_access(value: &str) -> Result<(), CalendarError> {
    if value == "members" || value == "admins" {
        Ok(())
    } else {
        Err(CalendarError::Invalid(
            "Who may write is `members` or `admins`.",
        ))
    }
}

fn check_timed_reminder(minutes: Option<i32>) -> Result<(), CalendarError> {
    match minutes {
        Some(m) if !TIMED_REMINDERS.contains(&m) => {
            Err(CalendarError::Invalid("Unknown reminder delay."))
        }
        _ => Ok(()),
    }
}

fn clean_description(description: Option<String>) -> Result<Option<String>, CalendarError> {
    match description.map(|d| d.trim().to_owned()) {
        Some(d) if d.chars().count() > DESCRIPTION_MAX => Err(CalendarError::Invalid(
            "A description has at most 20,000 characters.",
        )),
        Some(d) if d.is_empty() => Ok(None),
        other => Ok(other),
    }
}

/// Tell everyone who sees `calendar` that it changed.
pub(crate) async fn announce(
    state: &AppState,
    calendar: &calendars::Model,
) -> Result<(), CalendarError> {
    let audience = authz::audience(&state.db, calendar).await?;
    state
        .hub
        .publish(audience, RealtimeEnvelope::calendar_changed(calendar.id))
        .await;
    Ok(())
}

/// Turn accesses into what the viewer is shown, with their own settings.
async fn dtos<C: ConnectionTrait>(
    db: &C,
    user_id: Uuid,
    accesses: Vec<CalendarAccess>,
) -> Result<Vec<CalendarDto>, CalendarError> {
    let ids: Vec<Uuid> = accesses.iter().map(|a| a.calendar.id).collect();
    let hidden: HashMap<Uuid, bool> = calendar_visibility::Entity::find()
        .filter(calendar_visibility::Column::UserId.eq(user_id))
        .filter(calendar_visibility::Column::CalendarId.is_in(ids.clone()))
        .all(db)
        .await?
        .into_iter()
        .map(|v| (v.calendar_id, v.hidden))
        .collect();
    let reminders: HashMap<Uuid, Option<i32>> = calendar_reminder_prefs::Entity::find()
        .filter(calendar_reminder_prefs::Column::UserId.eq(user_id))
        .filter(calendar_reminder_prefs::Column::CalendarId.is_in(ids))
        .all(db)
        .await?
        .into_iter()
        .map(|p| (p.calendar_id, p.minutes))
        .collect();
    Ok(accesses
        .into_iter()
        .map(|access| {
            let id = access.calendar.id;
            CalendarDto::from_access(
                access,
                hidden.get(&id).copied().unwrap_or(false),
                reminders.get(&id).copied(),
            )
        })
        .collect())
}

async fn one_dto(
    state: &AppState,
    user_id: Uuid,
    calendar_id: Uuid,
) -> Result<CalendarDto, CalendarError> {
    let access = authz::access(&state.db, user_id, calendar_id).await?;
    dtos(&state.db, user_id, vec![access])
        .await?
        .pop()
        .ok_or(CalendarError::Internal)
}

/// `GET /api/v1/calendars`: every calendar the caller sees, theirs first.
#[utoipa::path(
    get,
    path = "/api/v1/calendars",
    tag = "calendar",
    responses((status = 200, description = "The caller's calendars", body = [CalendarDto]))
)]
pub async fn list_calendars(
    State(state): State<AppState>,
    session: AuthSession,
) -> Result<Json<Vec<CalendarDto>>, CalendarError> {
    let mut accesses = authz::visible(&state.db, session.user_id).await?;
    accesses.sort_by(|a, b| {
        let key = |x: &CalendarAccess| {
            (
                x.calendar.space_id.is_some(),
                x.calendar.space_id,
                !x.calendar.is_default,
                x.calendar.name.to_lowercase(),
            )
        };
        key(a).cmp(&key(b))
    });
    Ok(Json(dtos(&state.db, session.user_id, accesses).await?))
}

async fn insert_calendar(
    state: &AppState,
    session: &AuthSession,
    space_id: Option<Uuid>,
    body: CreateCalendar,
) -> Result<(StatusCode, Json<CalendarDto>), CalendarError> {
    let name = clean_name(&body.name)?;
    check_color(&body.color)?;
    let write_access = body.write_access.unwrap_or_else(|| "members".to_owned());
    check_write_access(&write_access)?;
    let reminder = body.default_reminder_minutes.unwrap_or(Some(10));
    check_timed_reminder(reminder)?;
    let now = OffsetDateTime::now_utc();
    let calendar = calendars::ActiveModel {
        id: Set(Uuid::new_v4()),
        space_id: Set(space_id),
        owner_user_id: Set(space_id.is_none().then_some(session.user_id)),
        name: Set(name),
        description: Set(clean_description(body.description)?),
        color: Set(body.color),
        write_access: Set(write_access),
        default_reminder_minutes: Set(reminder),
        is_default: Set(false),
        created_by: Set(Some(session.user_id)),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&state.db)
    .await?;
    announce(state, &calendar).await?;
    Ok((
        StatusCode::CREATED,
        Json(one_dto(state, session.user_id, calendar.id).await?),
    ))
}

/// `POST /api/v1/calendars`: a new personal calendar.
#[utoipa::path(
    post,
    path = "/api/v1/calendars",
    tag = "calendar",
    request_body = CreateCalendar,
    responses(
        (status = 201, description = "Created", body = CalendarDto),
        (status = 422, description = "Invalid name, colour or reminder")
    )
)]
pub async fn create_personal_calendar(
    State(state): State<AppState>,
    session: AuthSession,
    Json(body): Json<CreateCalendar>,
) -> Result<(StatusCode, Json<CalendarDto>), CalendarError> {
    insert_calendar(&state, &session, None, body).await
}

/// `POST /api/v1/spaces/{space_id}/calendars`: a new calendar for a space (its administrators).
#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/calendars",
    tag = "calendar",
    params(("space_id" = Uuid, Path, description = "Space id")),
    request_body = CreateCalendar,
    responses(
        (status = 201, description = "Created", body = CalendarDto),
        (status = 403, description = "Not an administrator of the space"),
        (status = 404, description = "Not a member of the space"),
        (status = 422, description = "Invalid name, colour or reminder")
    )
)]
pub async fn create_space_calendar(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
    Json(body): Json<CreateCalendar>,
) -> Result<(StatusCode, Json<CalendarDto>), CalendarError> {
    let role = space_members::Entity::find_by_id((space_id, session.user_id))
        .one(&state.db)
        .await?
        .map(|m| m.role);
    match role.as_deref() {
        Some("admin" | "owner") => insert_calendar(&state, &session, Some(space_id), body).await,
        Some("member") => Err(CalendarError::Forbidden),
        _ => Err(CalendarError::NotFound),
    }
}

/// `PATCH /api/v1/calendars/{calendar_id}`: rename, recolour, change its settings.
#[utoipa::path(
    patch,
    path = "/api/v1/calendars/{calendar_id}",
    tag = "calendar",
    params(("calendar_id" = Uuid, Path, description = "Calendar id")),
    request_body = UpdateCalendar,
    responses(
        (status = 200, description = "Updated", body = CalendarDto),
        (status = 403, description = "May not manage this calendar"),
        (status = 404, description = "No such calendar for the caller"),
        (status = 422, description = "Invalid value")
    )
)]
pub async fn update_calendar(
    State(state): State<AppState>,
    session: AuthSession,
    Path(calendar_id): Path<Uuid>,
    Json(body): Json<UpdateCalendar>,
) -> Result<Json<CalendarDto>, CalendarError> {
    let access = authz::access(&state.db, session.user_id, calendar_id).await?;
    if !access.can_manage {
        return Err(CalendarError::Forbidden);
    }
    let personal = access.calendar.space_id.is_none();
    let mut calendar = access.calendar.into_active_model();
    if let Some(name) = body.name {
        calendar.name = Set(clean_name(&name)?);
    }
    if let Some(color) = body.color {
        check_color(&color)?;
        calendar.color = Set(color);
    }
    if let Some(description) = body.description {
        calendar.description = Set(clean_description(description)?);
    }
    if let Some(write_access) = body.write_access {
        check_write_access(&write_access)?;
        if !personal {
            calendar.write_access = Set(write_access);
        }
    }
    if let Some(reminder) = body.default_reminder_minutes {
        check_timed_reminder(reminder)?;
        calendar.default_reminder_minutes = Set(reminder);
    }
    calendar.updated_at = Set(OffsetDateTime::now_utc());
    let calendar = calendar.update(&state.db).await?;
    announce(&state, &calendar).await?;
    Ok(Json(one_dto(&state, session.user_id, calendar_id).await?))
}

/// `DELETE /api/v1/calendars/{calendar_id}`: delete a calendar and its events, naming it.
#[utoipa::path(
    delete,
    path = "/api/v1/calendars/{calendar_id}",
    tag = "calendar",
    params(("calendar_id" = Uuid, Path, description = "Calendar id")),
    request_body = DeleteCalendar,
    responses(
        (status = 204, description = "Deleted"),
        (status = 403, description = "May not manage this calendar"),
        (status = 404, description = "No such calendar for the caller"),
        (status = 409, description = "A default calendar is never deleted"),
        (status = 422, description = "The name does not match")
    )
)]
pub async fn delete_calendar(
    State(state): State<AppState>,
    session: AuthSession,
    Path(calendar_id): Path<Uuid>,
    Json(body): Json<DeleteCalendar>,
) -> Result<StatusCode, CalendarError> {
    let access = authz::access(&state.db, session.user_id, calendar_id).await?;
    if !access.can_manage {
        return Err(CalendarError::Forbidden);
    }
    if access.calendar.is_default {
        return Err(CalendarError::IsDefault);
    }
    if body.confirm_name.trim() != access.calendar.name {
        return Err(CalendarError::ConfirmMismatch);
    }
    let audience = authz::audience(&state.db, &access.calendar).await?;
    calendars::Entity::delete_by_id(calendar_id)
        .exec(&state.db)
        .await?;
    state
        .hub
        .publish(audience, RealtimeEnvelope::calendar_changed(calendar_id))
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `PUT /api/v1/calendars/{calendar_id}/me`: the caller's own settings for a calendar.
#[utoipa::path(
    put,
    path = "/api/v1/calendars/{calendar_id}/me",
    tag = "calendar",
    params(("calendar_id" = Uuid, Path, description = "Calendar id")),
    request_body = CalendarMe,
    responses(
        (status = 204, description = "Saved"),
        (status = 404, description = "No such calendar for the caller"),
        (status = 422, description = "Unknown reminder delay")
    )
)]
pub async fn put_calendar_me(
    State(state): State<AppState>,
    session: AuthSession,
    Path(calendar_id): Path<Uuid>,
    Json(body): Json<CalendarMe>,
) -> Result<StatusCode, CalendarError> {
    authz::access(&state.db, session.user_id, calendar_id).await?;
    if let Some(hidden) = body.hidden {
        calendar_visibility::Entity::insert(calendar_visibility::ActiveModel {
            user_id: Set(session.user_id),
            calendar_id: Set(calendar_id),
            hidden: Set(hidden),
        })
        .on_conflict(
            sea_orm::sea_query::OnConflict::columns([
                calendar_visibility::Column::UserId,
                calendar_visibility::Column::CalendarId,
            ])
            .update_column(calendar_visibility::Column::Hidden)
            .to_owned(),
        )
        .exec(&state.db)
        .await?;
    }
    if body.reminder_default {
        calendar_reminder_prefs::Entity::delete_by_id((session.user_id, calendar_id))
            .exec(&state.db)
            .await?;
    } else if let Some(minutes) = body.reminder_minutes {
        check_timed_reminder(minutes)?;
        calendar_reminder_prefs::Entity::insert(calendar_reminder_prefs::ActiveModel {
            user_id: Set(session.user_id),
            calendar_id: Set(calendar_id),
            minutes: Set(minutes),
        })
        .on_conflict(
            sea_orm::sea_query::OnConflict::columns([
                calendar_reminder_prefs::Column::UserId,
                calendar_reminder_prefs::Column::CalendarId,
            ])
            .update_column(calendar_reminder_prefs::Column::Minutes)
            .to_owned(),
        )
        .exec(&state.db)
        .await?;
    }
    // The caller's other devices redraw too.
    state
        .hub
        .publish(
            vec![session.user_id],
            RealtimeEnvelope::calendar_changed(calendar_id),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}
