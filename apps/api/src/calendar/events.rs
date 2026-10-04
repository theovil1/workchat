//! Events and their series: creating, reading, changing and deleting them, one occurrence, the
//! following ones or the whole series at a time, and each viewer's own reminder.
//!
//! - **This occurrence** writes an exception (moved, renamed, or cancelled).
//! - **This and the following ones** cuts the series in two, as Google and Outlook do: the old
//!   series ends just before the occurrence and a new one, with a new UID, starts with it. The
//!   exceptions after the cut follow the new series.
//! - **The whole series** changes its head. When its timing changes, the exceptions that only moved
//!   an occurrence are dropped and the cancellations are kept, shifted with the series.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, IntoActiveModel, QueryFilter,
    TransactionTrait,
};
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

use super::attendees::{self, Attendance, OrganizerDto, ResponseInput};
use super::authz::{self, CalendarAccess};
use super::calendars::announce;
use super::dto::{EditQuery, EditScope, EventDto, EventInput, EventMe, OccurrenceDto};
use super::error::CalendarError;
use super::invitations::{self, Cancellation, Notice};
use super::recurrence::{self, ExceptionInput, RecurrenceId, RuleOrigin, SeriesInput, When};
use super::reminders::effective_minutes;
use super::{ALL_DAY_REMINDERS, TIMED_REMINDERS};
use crate::auth::extract::AuthSession;
use crate::entities::{
    calendar_event_exceptions as exceptions, calendar_event_reminders, calendar_events,
    calendar_reminder_prefs, calendars, users,
};
use crate::realtime::event::RealtimeEnvelope;
use crate::state::AppState;

const TITLE_MAX: usize = 500;
const LOCATION_MAX: usize = 500;
const DESCRIPTION_MAX: usize = 20_000;

/// The time zone a timed event gets when its author gave none and has none in their profile.
pub const FALLBACK_TIME_ZONE: &str = "Europe/Paris";

// --- Reading rows as series -----------------------------------------------------------------------

/// When an event's first occurrence happens.
pub(crate) fn when_of(event: &calendar_events::Model) -> When {
    match (
        event.start_date,
        event.end_date,
        event.start_at,
        event.end_at,
    ) {
        (Some(start), Some(end), _, _) if event.all_day => When::AllDay { start, end },
        (_, _, Some(start), Some(end)) => When::Timed { start, end },
        // The CHECK constraint makes this unreachable; a zero-length instant keeps it harmless.
        _ => When::Timed {
            start: event.created_at,
            end: event.created_at,
        },
    }
}

/// When an exception moved its occurrence to, if it did.
fn exception_when(row: &exceptions::Model) -> Option<When> {
    match (row.start_at, row.end_at, row.start_date, row.end_date) {
        (Some(start), Some(end), _, _) => Some(When::Timed { start, end }),
        (_, _, Some(start), Some(end)) => Some(When::AllDay { start, end }),
        _ => None,
    }
}

pub(crate) fn exception_inputs(rows: &[exceptions::Model]) -> Vec<ExceptionInput> {
    rows.iter()
        .filter_map(|row| {
            Some(ExceptionInput {
                recurrence_id: RecurrenceId::from_key(&row.recurrence_id)?,
                cancelled: row.cancelled,
                when: exception_when(row),
            })
        })
        .collect()
}

pub(crate) fn series_of<'a>(
    event: &'a calendar_events::Model,
    exceptions: &'a [ExceptionInput],
) -> SeriesInput<'a> {
    SeriesInput {
        when: when_of(event),
        tzid: event.tzid.as_deref(),
        rrule: event.rrule.as_deref(),
        rdates: event.rdates.as_deref().unwrap_or(&[]),
        exceptions,
    }
}

/// An instant as the API writes it: RFC 3339, UTC, whole seconds.
pub(crate) fn instant_text(instant: OffsetDateTime) -> String {
    RecurrenceId::Instant(instant).to_key()
}

pub(crate) fn date_text(date: Date) -> String {
    RecurrenceId::Date(date).to_key()
}

pub(crate) fn when_texts(when: &When) -> (String, String) {
    match *when {
        When::Timed { start, end } => (instant_text(start), instant_text(end)),
        When::AllDay { start, end } => (date_text(start), date_text(end)),
    }
}

// --- Reminders as the viewer sees them ------------------------------------------------------------

/// A viewer's own reminder choices for some events and calendars.
pub(crate) struct ViewerReminders {
    events: HashMap<Uuid, Option<i32>>,
    calendars: HashMap<Uuid, Option<i32>>,
}

impl ViewerReminders {
    pub(crate) async fn load<C: ConnectionTrait>(
        db: &C,
        user_id: Uuid,
        event_ids: Vec<Uuid>,
        calendar_ids: Vec<Uuid>,
    ) -> Result<Self, CalendarError> {
        let events = calendar_event_reminders::Entity::find()
            .filter(calendar_event_reminders::Column::UserId.eq(user_id))
            .filter(calendar_event_reminders::Column::EventId.is_in(event_ids))
            .all(db)
            .await?
            .into_iter()
            .map(|r| (r.event_id, r.minutes))
            .collect();
        let calendars = calendar_reminder_prefs::Entity::find()
            .filter(calendar_reminder_prefs::Column::UserId.eq(user_id))
            .filter(calendar_reminder_prefs::Column::CalendarId.is_in(calendar_ids))
            .all(db)
            .await?
            .into_iter()
            .map(|r| (r.calendar_id, r.minutes))
            .collect();
        Ok(Self { events, calendars })
    }

    pub(crate) fn effective(
        &self,
        event: &calendar_events::Model,
        calendar: &calendars::Model,
    ) -> Option<i32> {
        effective_minutes(
            self.events.get(&event.id).copied(),
            self.calendars.get(&calendar.id).copied(),
            calendar.default_reminder_minutes,
            event.all_day,
        )
    }
}

async fn event_dto<C: ConnectionTrait>(
    db: &C,
    user_id: Uuid,
    event: calendar_events::Model,
    access: &CalendarAccess,
) -> Result<EventDto, CalendarError> {
    let reminders =
        ViewerReminders::load(db, user_id, vec![event.id], vec![access.calendar.id]).await?;
    let attendance = Attendance::load(db, user_id, &[event.id]).await?;
    let invited = attendees::row_of(db, event.id, user_id).await?.is_some()
        && authz::access(db, user_id, event.calendar_id).await.is_err();
    let list = attendees::list(db, event.id).await?;
    let organizer = match event.created_by {
        Some(author) => attendees::names(db, [author])
            .await?
            .remove(&author)
            .map(|name| OrganizerDto {
                user_id: author,
                name,
            }),
        None => None,
    };
    let (start, end) = when_texts(&when_of(&event));
    let head = OccurrenceDto {
        event_id: event.id,
        calendar_id: event.calendar_id,
        recurrence_id: None,
        title: event.title.clone(),
        location: event.location.clone(),
        description: event.description.clone(),
        all_day: event.all_day,
        start,
        end,
        tzid: event.tzid.clone(),
        is_recurring: event.rrule.is_some(),
        overridden: false,
        can_edit: access.can_write_events,
        my_reminder_minutes: reminders.effective(&event, &access.calendar),
        my_status: attendance.status(&event, user_id, None),
        invited,
        has_attendees: attendance.has_attendees(event.id),
    };
    Ok(EventDto {
        head,
        rrule: event.rrule,
        created_by: event.created_by,
        updated_at: instant_text(event.updated_at),
        organizer,
        attendees: attendees::dtos(db, &list).await?,
    })
}

// --- Input ----------------------------------------------------------------------------------------

/// A form, checked and read.
struct Parsed {
    title: String,
    description: Option<String>,
    location: Option<String>,
    when: When,
    tzid: Option<String>,
    rrule: Option<String>,
}

fn optional_text(
    value: &Option<String>,
    max: usize,
    message: &'static str,
) -> Result<Option<String>, CalendarError> {
    match value.as_deref().map(str::trim) {
        Some(text) if text.chars().count() > max => Err(CalendarError::Invalid(message)),
        Some("") | None => Ok(None),
        Some(text) => Ok(Some(text.to_owned())),
    }
}

fn parse_date(text: &str) -> Result<Date, CalendarError> {
    match RecurrenceId::from_key(text.trim()) {
        Some(RecurrenceId::Date(date)) => Ok(date),
        _ => Err(CalendarError::Invalid(
            "An all-day event takes dates (YYYY-MM-DD).",
        )),
    }
}

fn parse_instant(text: &str) -> Result<OffsetDateTime, CalendarError> {
    OffsetDateTime::parse(text.trim(), &time::format_description::well_known::Rfc3339)
        .map_err(|_| CalendarError::Invalid("A timed event takes RFC 3339 instants."))
}

fn parse_input(input: &EventInput, default_tz: &str) -> Result<Parsed, CalendarError> {
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > TITLE_MAX {
        return Err(CalendarError::Invalid("A title has 1 to 500 characters."));
    }
    let location = optional_text(
        &input.location,
        LOCATION_MAX,
        "A place has at most 500 characters.",
    )?;
    let description = optional_text(
        &input.description,
        DESCRIPTION_MAX,
        "A description has at most 20,000 characters.",
    )?;
    let (when, tzid) = if input.all_day {
        let (start, end) = (parse_date(&input.start)?, parse_date(&input.end)?);
        if end <= start {
            return Err(CalendarError::Invalid(
                "An all-day event ends after it starts.",
            ));
        }
        (When::AllDay { start, end }, None)
    } else {
        let (start, end) = (parse_instant(&input.start)?, parse_instant(&input.end)?);
        if end < start {
            return Err(CalendarError::Invalid("An event ends after it starts."));
        }
        let tzid = input
            .tzid
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .unwrap_or(default_tz)
            .to_owned();
        if !recurrence::known_time_zone(&tzid) {
            return Err(CalendarError::Invalid("Unknown time zone."));
        }
        (When::Timed { start, end }, Some(tzid))
    };
    let rrule = match input.rrule.as_deref().map(str::trim) {
        Some("") | None => None,
        Some(rule) => {
            recurrence::validate_rule(rule, RuleOrigin::Ui)?;
            Some(rule.to_owned())
        }
    };
    Ok(Parsed {
        title: title.to_owned(),
        description,
        location,
        when,
        tzid,
        rrule,
    })
}

fn check_reminder(minutes: Option<i32>, all_day: bool) -> Result<(), CalendarError> {
    let allowed: &[i32] = if all_day {
        &ALL_DAY_REMINDERS
    } else {
        &TIMED_REMINDERS
    };
    match minutes {
        Some(m) if !allowed.contains(&m) => Err(CalendarError::Invalid("Unknown reminder delay.")),
        _ => Ok(()),
    }
}

/// The time zone of the author's profile, when it is one this server knows.
async fn profile_time_zone<C: ConnectionTrait>(
    db: &C,
    user_id: Uuid,
) -> Result<String, CalendarError> {
    Ok(users::Entity::find_by_id(user_id)
        .one(db)
        .await?
        .and_then(|u| u.timezone)
        .filter(|tz| recurrence::known_time_zone(tz))
        .unwrap_or_else(|| FALLBACK_TIME_ZONE.to_owned()))
}

fn put_when(event: &mut calendar_events::ActiveModel, when: &When, tzid: Option<String>) {
    match *when {
        When::Timed { start, end } => {
            event.all_day = Set(false);
            event.start_at = Set(Some(start));
            event.end_at = Set(Some(end));
            event.tzid = Set(tzid);
            event.start_date = Set(None);
            event.end_date = Set(None);
        }
        When::AllDay { start, end } => {
            event.all_day = Set(true);
            event.start_at = Set(None);
            event.end_at = Set(None);
            event.tzid = Set(None);
            event.start_date = Set(Some(start));
            event.end_date = Set(Some(end));
        }
    }
}

/// Recompute and store when an event's series ends, from what is stored now.
async fn refresh_until<C: ConnectionTrait>(
    db: &C,
    event_id: Uuid,
) -> Result<calendar_events::Model, CalendarError> {
    let event = calendar_events::Entity::find_by_id(event_id)
        .one(db)
        .await?
        .ok_or(CalendarError::NotFound)?;
    let rows = exceptions::Entity::find()
        .filter(exceptions::Column::EventId.eq(event_id))
        .all(db)
        .await?;
    let inputs = exception_inputs(&rows);
    let until = recurrence::series_until(&series_of(&event, &inputs))?;
    let mut active = event.into_active_model();
    active.series_until = Set(until);
    Ok(active.update(db).await?)
}

async fn set_my_reminder<C: ConnectionTrait>(
    db: &C,
    user_id: Uuid,
    event_id: Uuid,
    minutes: Option<i32>,
) -> Result<(), CalendarError> {
    calendar_event_reminders::Entity::insert(calendar_event_reminders::ActiveModel {
        user_id: Set(user_id),
        event_id: Set(event_id),
        minutes: Set(minutes),
    })
    .on_conflict(
        sea_orm::sea_query::OnConflict::columns([
            calendar_event_reminders::Column::UserId,
            calendar_event_reminders::Column::EventId,
        ])
        .update_column(calendar_event_reminders::Column::Minutes)
        .to_owned(),
    )
    .exec(db)
    .await?;
    Ok(())
}

/// The event and the caller's access to it: through its calendar, or read only through an
/// invitation; `NotFound` when they cannot see it.
async fn load_event<C: ConnectionTrait>(
    db: &C,
    user_id: Uuid,
    event_id: Uuid,
) -> Result<(calendar_events::Model, CalendarAccess), CalendarError> {
    let event = calendar_events::Entity::find_by_id(event_id)
        .one(db)
        .await?
        .ok_or(CalendarError::NotFound)?;
    match authz::access(db, user_id, event.calendar_id).await {
        Ok(access) => Ok((event, access)),
        Err(CalendarError::NotFound) => {
            match attendees::invitation_access(db, user_id, &event).await? {
                Some(access) => Ok((event, access)),
                None => Err(CalendarError::NotFound),
            }
        }
        Err(other) => Err(other),
    }
}

fn required_recurrence_id(query: &EditQuery) -> Result<RecurrenceId, CalendarError> {
    query
        .recurrence_id
        .as_deref()
        .and_then(RecurrenceId::from_key)
        .ok_or(CalendarError::Invalid(
            "This change needs the occurrence's recurrence_id.",
        ))
}

/// Whether `id` is an occurrence of the event's series as it stands.
fn names_an_occurrence(
    event: &calendar_events::Model,
    id: &RecurrenceId,
) -> Result<bool, CalendarError> {
    Ok(recurrence::is_occurrence(&series_of(event, &[]), id)?)
}

/// The series' own first occurrence, as a recurrence id.
fn first_id(event: &calendar_events::Model) -> RecurrenceId {
    match when_of(event) {
        When::Timed { start, .. } => RecurrenceId::Instant(start),
        When::AllDay { start, .. } => RecurrenceId::Date(start),
    }
}

/// How far a change moves a series' start.
fn delta(from: &When, to: &When) -> Duration {
    match (from, to) {
        (When::Timed { start: a, .. }, When::Timed { start: b, .. }) => *b - *a,
        (When::AllDay { start: a, .. }, When::AllDay { start: b, .. }) => *b - *a,
        _ => Duration::ZERO,
    }
}

/// Rewrite an exception's key (its primary key, so by delete and insert).
async fn rekey<C: ConnectionTrait>(
    db: &C,
    row: exceptions::Model,
    event_id: Uuid,
    shift: Duration,
) -> Result<(), CalendarError> {
    let Some(id) = RecurrenceId::from_key(&row.recurrence_id) else {
        return Ok(());
    };
    exceptions::Entity::delete_by_id((row.event_id, row.recurrence_id.clone()))
        .exec(db)
        .await?;
    let mut moved = row.into_active_model();
    moved.event_id = Set(event_id);
    moved.recurrence_id = Set(id.shifted(shift).to_key());
    exceptions::Entity::insert(moved).exec(db).await?;
    Ok(())
}

// --- Handlers -------------------------------------------------------------------------------------

/// `POST /api/v1/calendars/{calendar_id}/events`: a new event or series.
#[utoipa::path(
    post,
    path = "/api/v1/calendars/{calendar_id}/events",
    tag = "calendar",
    params(("calendar_id" = Uuid, Path, description = "Calendar id")),
    request_body = EventInput,
    responses(
        (status = 201, description = "Created", body = EventDto),
        (status = 403, description = "May not write in this calendar"),
        (status = 404, description = "No such calendar for the caller"),
        (status = 422, description = "Invalid event")
    )
)]
pub async fn create_event(
    State(state): State<AppState>,
    session: AuthSession,
    Path(calendar_id): Path<Uuid>,
    Json(input): Json<EventInput>,
) -> Result<(StatusCode, Json<EventDto>), CalendarError> {
    let access = authz::access(&state.db, session.user_id, calendar_id).await?;
    if !access.can_write_events {
        return Err(CalendarError::Forbidden);
    }
    let tz = profile_time_zone(&state.db, session.user_id).await?;
    let parsed = parse_input(&input, &tz)?;
    let all_day = matches!(parsed.when, When::AllDay { .. });
    if let Some(minutes) = input.reminder_minutes {
        check_reminder(minutes, all_day)?;
    }
    let txn = state.db.begin().await?;
    let event = insert_event(&txn, calendar_id, session.user_id, parsed).await?;
    if let Some(minutes) = input.reminder_minutes {
        set_my_reminder(&txn, session.user_id, event.id, minutes).await?;
    }
    let invited = match &input.attendees {
        Some(list) => {
            attendees::replace(
                &txn,
                &event,
                &access.calendar,
                session.user_id,
                list,
                &state.secret_key,
            )
            .await?
            .added
        }
        None => Vec::new(),
    };
    txn.commit().await?;
    announce(&state, &access.calendar).await?;
    if !invited.is_empty() {
        invitations::send(
            &state,
            Some(&event),
            Some(session.user_id),
            Notice::Invited(invited),
        )
        .await;
    }
    Ok((
        StatusCode::CREATED,
        Json(event_dto(&state.db, session.user_id, event, &access).await?),
    ))
}

async fn insert_event<C: ConnectionTrait>(
    db: &C,
    calendar_id: Uuid,
    author: Uuid,
    parsed: Parsed,
) -> Result<calendar_events::Model, CalendarError> {
    let id = Uuid::new_v4();
    let now = OffsetDateTime::now_utc();
    let mut event = calendar_events::ActiveModel {
        id: Set(id),
        calendar_id: Set(calendar_id),
        uid: Set(format!("{id}@ruchoir")),
        title: Set(parsed.title),
        description: Set(parsed.description),
        location: Set(parsed.location),
        rrule: Set(parsed.rrule),
        rdates: Set(None),
        series_until: Set(None),
        sequence: Set(0),
        ical_extra: Set(serde_json::json!([])),
        created_by: Set(Some(author)),
        updated_by: Set(Some(author)),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    };
    put_when(&mut event, &parsed.when, parsed.tzid);
    event.insert(db).await?;
    refresh_until(db, id).await
}

/// `GET /api/v1/events/{event_id}`: an event or a series' head.
#[utoipa::path(
    get,
    path = "/api/v1/events/{event_id}",
    tag = "calendar",
    params(("event_id" = Uuid, Path, description = "Event id")),
    responses(
        (status = 200, description = "The event", body = EventDto),
        (status = 404, description = "No such event for the caller")
    )
)]
pub async fn get_event(
    State(state): State<AppState>,
    session: AuthSession,
    Path(event_id): Path<Uuid>,
) -> Result<Json<EventDto>, CalendarError> {
    let (event, access) = load_event(&state.db, session.user_id, event_id).await?;
    Ok(Json(
        event_dto(&state.db, session.user_id, event, &access).await?,
    ))
}

/// `PATCH /api/v1/events/{event_id}?scope=&recurrence_id=`: change an occurrence, the following
/// ones, or the whole series.
#[utoipa::path(
    patch,
    path = "/api/v1/events/{event_id}",
    tag = "calendar",
    params(
        ("event_id" = Uuid, Path, description = "Event id"),
        ("scope" = Option<EditScope>, Query, description = "this, following or all (the default)"),
        ("recurrence_id" = Option<String>, Query, description = "The occurrence, for this and following")
    ),
    request_body = EventInput,
    responses(
        (status = 200, description = "The changed event (the new series for `following`)", body = EventDto),
        (status = 403, description = "May not write in this calendar"),
        (status = 404, description = "No such event for the caller"),
        (status = 422, description = "Invalid event")
    )
)]
pub async fn update_event(
    State(state): State<AppState>,
    session: AuthSession,
    Path(event_id): Path<Uuid>,
    Query(query): Query<EditQuery>,
    Json(input): Json<EventInput>,
) -> Result<Json<EventDto>, CalendarError> {
    let (event, access) = load_event(&state.db, session.user_id, event_id).await?;
    if !access.can_write_events {
        return Err(CalendarError::Forbidden);
    }
    let tz = profile_time_zone(&state.db, session.user_id).await?;
    let parsed = parse_input(&input, &tz)?;
    let all_day = matches!(parsed.when, When::AllDay { .. });
    if let Some(minutes) = input.reminder_minutes {
        check_reminder(minutes, all_day)?;
    }

    let mut scope = if event.rrule.is_none() {
        EditScope::All
    } else {
        query.scope
    };
    if scope == EditScope::Following && required_recurrence_id(&query)? == first_id(&event) {
        scope = EditScope::All;
    }

    let mut touched = vec![access.calendar.clone()];
    // What the attendees will hear about: what changed, and for which date.
    let before_when = when_of(&event);
    let mut changes: Vec<String>;
    let mut change_date: Option<RecurrenceId> = None;
    let txn = state.db.begin().await?;
    let result_id = match scope {
        EditScope::This => {
            let id = required_recurrence_id(&query)?;
            if !names_an_occurrence(&event, &id)? {
                return Err(CalendarError::Invalid(
                    "This occurrence is not one of the series.",
                ));
            }
            changes = invitations::changes_between(
                &recurrence::occurrence_when(&before_when, id),
                &parsed.when,
                event.location.as_deref(),
                parsed.location.as_deref(),
            );
            change_date = Some(id);
            if all_day != event.all_day {
                return Err(CalendarError::Invalid(
                    "An occurrence keeps its series' all-day setting.",
                ));
            }
            let (start_at, end_at, start_date, end_date) = match parsed.when {
                When::Timed { start, end } => (Some(start), Some(end), None, None),
                When::AllDay { start, end } => (None, None, Some(start), Some(end)),
            };
            let row = exceptions::ActiveModel {
                event_id: Set(event.id),
                recurrence_id: Set(id.to_key()),
                cancelled: Set(false),
                title: Set(Some(parsed.title)),
                description: Set(parsed.description),
                location: Set(parsed.location),
                start_at: Set(start_at),
                end_at: Set(end_at),
                start_date: Set(start_date),
                end_date: Set(end_date),
                ical_extra: Set(serde_json::json!([])),
            };
            exceptions::Entity::insert(row)
                .on_conflict(
                    sea_orm::sea_query::OnConflict::columns([
                        exceptions::Column::EventId,
                        exceptions::Column::RecurrenceId,
                    ])
                    .update_columns([
                        exceptions::Column::Cancelled,
                        exceptions::Column::Title,
                        exceptions::Column::Description,
                        exceptions::Column::Location,
                        exceptions::Column::StartAt,
                        exceptions::Column::EndAt,
                        exceptions::Column::StartDate,
                        exceptions::Column::EndDate,
                    ])
                    .to_owned(),
                )
                .exec(&txn)
                .await?;
            bump(&txn, event.id, session.user_id).await?;
            refresh_until(&txn, event.id).await?;
            event.id
        }
        EditScope::Following => {
            let at = required_recurrence_id(&query)?;
            changes = invitations::changes_between(
                &recurrence::occurrence_when(&before_when, at),
                &parsed.when,
                event.location.as_deref(),
                parsed.location.as_deref(),
            );
            let old_rule = event.rrule.clone().unwrap_or_default();
            let (first_rule, second_rule) =
                recurrence::split_rule(&old_rule, &when_of(&event), event.tzid.as_deref(), &at)?;
            let new_rule = if parsed.rrule.as_deref() == Some(old_rule.as_str()) {
                Some(second_rule)
            } else {
                parsed.rrule.clone()
            };
            let shift = match (at, &parsed.when) {
                (RecurrenceId::Instant(a), When::Timed { start, .. }) => *start - a,
                (RecurrenceId::Date(a), When::AllDay { start, .. }) => *start - a,
                _ => Duration::ZERO,
            };
            let mut old = event.clone().into_active_model();
            old.rrule = Set(Some(first_rule));
            old.sequence = Set(event.sequence + 1);
            old.updated_by = Set(Some(session.user_id));
            old.updated_at = Set(OffsetDateTime::now_utc());
            old.update(&txn).await?;

            let new_event = insert_event(
                &txn,
                event.calendar_id,
                session.user_id,
                Parsed {
                    rrule: new_rule,
                    ..parsed
                },
            )
            .await?;
            // The occurrence being edited is the new series' first one, as the form now says it:
            // its old exception goes. Later ones follow the new series, unless it changed between
            // timed and all-day, where their keys no longer name anything.
            let kind_changed = event.all_day != all_day;
            for row in exceptions::Entity::find()
                .filter(exceptions::Column::EventId.eq(event.id))
                .all(&txn)
                .await?
            {
                let Some(id) = RecurrenceId::from_key(&row.recurrence_id) else {
                    continue;
                };
                if id < at {
                    continue;
                }
                if id == at || kind_changed {
                    exceptions::Entity::delete_by_id((row.event_id, row.recurrence_id))
                        .exec(&txn)
                        .await?;
                } else {
                    rekey(&txn, row, new_event.id, shift).await?;
                }
            }
            // The attendees and their answers go with the new series.
            attendees::copy_to(&txn, event.id, new_event.id, &at, shift, &state.secret_key).await?;
            // Everyone's choice of reminder for the series carries over.
            for pref in calendar_event_reminders::Entity::find()
                .filter(calendar_event_reminders::Column::EventId.eq(event.id))
                .all(&txn)
                .await?
            {
                set_my_reminder(&txn, pref.user_id, new_event.id, pref.minutes).await?;
            }
            refresh_until(&txn, event.id).await?;
            refresh_until(&txn, new_event.id).await?;
            new_event.id
        }
        EditScope::All => {
            if let Some(target) = input.calendar_id.filter(|c| *c != event.calendar_id) {
                let destination = authz::access(&txn, session.user_id, target).await?;
                if !destination.can_write_events {
                    return Err(CalendarError::Forbidden);
                }
                touched.push(destination.calendar);
            }
            let before = when_of(&event);
            let timing_changed = before != parsed.when || event.tzid != parsed.tzid;
            changes = invitations::changes_between(
                &before,
                &parsed.when,
                event.location.as_deref(),
                parsed.location.as_deref(),
            );
            if !changes.iter().any(|c| c == "time")
                && (event.rrule != parsed.rrule || event.tzid != parsed.tzid)
            {
                changes.insert(0, "time".to_owned());
            }
            if timing_changed {
                let shift = delta(&before, &parsed.when);
                let kind_changed = event.all_day != all_day;
                for row in exceptions::Entity::find()
                    .filter(exceptions::Column::EventId.eq(event.id))
                    .all(&txn)
                    .await?
                {
                    let moved = row.start_at.is_some() || row.start_date.is_some();
                    if kind_changed || moved || !row.cancelled {
                        exceptions::Entity::delete_by_id((row.event_id, row.recurrence_id))
                            .exec(&txn)
                            .await?;
                    } else {
                        rekey(&txn, row, event.id, shift).await?;
                    }
                }
            }
            let mut active = event.clone().into_active_model();
            active.calendar_id = Set(touched.last().map_or(event.calendar_id, |c| c.id));
            active.title = Set(parsed.title);
            active.description = Set(parsed.description);
            active.location = Set(parsed.location);
            active.rrule = Set(parsed.rrule);
            put_when(&mut active, &parsed.when, parsed.tzid);
            active.update(&txn).await?;
            bump(&txn, event.id, session.user_id).await?;
            refresh_until(&txn, event.id).await?;
            event.id
        }
    };
    if let Some(minutes) = input.reminder_minutes {
        set_my_reminder(&txn, session.user_id, result_id, minutes).await?;
    }
    let list_change = match &input.attendees {
        Some(list) => {
            let result = calendar_events::Entity::find_by_id(result_id)
                .one(&txn)
                .await?
                .ok_or(CalendarError::Internal)?;
            let calendar = touched.last().unwrap_or(&access.calendar);
            attendees::replace(
                &txn,
                &result,
                calendar,
                session.user_id,
                list,
                &state.secret_key,
            )
            .await?
        }
        None => attendees::Change::default(),
    };
    txn.commit().await?;
    for calendar in &touched {
        announce(&state, calendar).await?;
    }
    let result = calendar_events::Entity::find_by_id(result_id)
        .one(&state.db)
        .await?;
    let actor = Some(session.user_id);
    if !list_change.removed.is_empty() {
        invitations::send(
            &state,
            result.as_ref(),
            actor,
            Notice::Removed(list_change.removed),
        )
        .await;
    }
    let newcomers: Vec<Uuid> = list_change.added.iter().map(|r| r.id).collect();
    if !list_change.added.is_empty() {
        invitations::send(
            &state,
            result.as_ref(),
            actor,
            Notice::Invited(list_change.added),
        )
        .await;
    }
    if !changes.is_empty() {
        invitations::send(
            &state,
            result.as_ref(),
            actor,
            Notice::Updated {
                changes,
                date: change_date,
                except: newcomers,
            },
        )
        .await;
    }
    let (result, result_access) = load_event(&state.db, session.user_id, result_id).await?;
    Ok(Json(
        event_dto(&state.db, session.user_id, result, &result_access).await?,
    ))
}

/// Raise an event's iCalendar sequence and record who changed it.
async fn bump<C: ConnectionTrait>(db: &C, event_id: Uuid, by: Uuid) -> Result<(), CalendarError> {
    let event = calendar_events::Entity::find_by_id(event_id)
        .one(db)
        .await?
        .ok_or(CalendarError::NotFound)?;
    let sequence = event.sequence + 1;
    let mut active = event.into_active_model();
    active.sequence = Set(sequence);
    active.updated_by = Set(Some(by));
    active.updated_at = Set(OffsetDateTime::now_utc());
    active.update(db).await?;
    Ok(())
}

/// `DELETE /api/v1/events/{event_id}?scope=&recurrence_id=`: delete an occurrence, the following
/// ones, or the whole series.
#[utoipa::path(
    delete,
    path = "/api/v1/events/{event_id}",
    tag = "calendar",
    params(
        ("event_id" = Uuid, Path, description = "Event id"),
        ("scope" = Option<EditScope>, Query, description = "this, following or all (the default)"),
        ("recurrence_id" = Option<String>, Query, description = "The occurrence, for this and following")
    ),
    responses(
        (status = 204, description = "Deleted"),
        (status = 403, description = "May not write in this calendar"),
        (status = 404, description = "No such event for the caller")
    )
)]
pub async fn delete_event(
    State(state): State<AppState>,
    session: AuthSession,
    Path(event_id): Path<Uuid>,
    Query(query): Query<EditQuery>,
) -> Result<StatusCode, CalendarError> {
    let (event, access) = load_event(&state.db, session.user_id, event_id).await?;
    if !access.can_write_events {
        return Err(CalendarError::Forbidden);
    }
    let mut scope = if event.rrule.is_none() {
        EditScope::All
    } else {
        query.scope
    };
    if scope == EditScope::Following && required_recurrence_id(&query)? == first_id(&event) {
        scope = EditScope::All;
    }
    // Its attendees are told, with the event as it was.
    let listed = attendees::list(&state.db, event.id).await?;
    let cancelled_date = match scope {
        EditScope::All => None,
        _ => Some(required_recurrence_id(&query)?),
    };
    let cancelled = if listed.is_empty() {
        None
    } else {
        Some(invitations::snapshot(&state.db, &event, cancelled_date, Vec::new()).await?)
    };
    let txn = state.db.begin().await?;
    match scope {
        EditScope::All => {
            calendar_events::Entity::delete_by_id(event.id)
                .exec(&txn)
                .await?;
        }
        EditScope::This => {
            let id = required_recurrence_id(&query)?;
            if !names_an_occurrence(&event, &id)? {
                return Err(CalendarError::Invalid(
                    "This occurrence is not one of the series.",
                ));
            }
            exceptions::Entity::insert(exceptions::ActiveModel {
                event_id: Set(event.id),
                recurrence_id: Set(id.to_key()),
                cancelled: Set(true),
                title: Set(None),
                description: Set(None),
                location: Set(None),
                start_at: Set(None),
                end_at: Set(None),
                start_date: Set(None),
                end_date: Set(None),
                ical_extra: Set(serde_json::json!([])),
            })
            .on_conflict(
                sea_orm::sea_query::OnConflict::columns([
                    exceptions::Column::EventId,
                    exceptions::Column::RecurrenceId,
                ])
                .update_columns([
                    exceptions::Column::Cancelled,
                    exceptions::Column::Title,
                    exceptions::Column::Description,
                    exceptions::Column::Location,
                    exceptions::Column::StartAt,
                    exceptions::Column::EndAt,
                    exceptions::Column::StartDate,
                    exceptions::Column::EndDate,
                ])
                .to_owned(),
            )
            .exec(&txn)
            .await?;
            bump(&txn, event.id, session.user_id).await?;
            refresh_until(&txn, event.id).await?;
        }
        EditScope::Following => {
            let at = required_recurrence_id(&query)?;
            let (first_rule, _) = recurrence::split_rule(
                event.rrule.as_deref().unwrap_or_default(),
                &when_of(&event),
                event.tzid.as_deref(),
                &at,
            )?;
            for row in exceptions::Entity::find()
                .filter(exceptions::Column::EventId.eq(event.id))
                .all(&txn)
                .await?
            {
                if RecurrenceId::from_key(&row.recurrence_id).is_some_and(|id| id >= at) {
                    exceptions::Entity::delete_by_id((row.event_id, row.recurrence_id))
                        .exec(&txn)
                        .await?;
                }
            }
            let mut active = event.clone().into_active_model();
            active.rrule = Set(Some(first_rule));
            active.update(&txn).await?;
            bump(&txn, event.id, session.user_id).await?;
            refresh_until(&txn, event.id).await?;
        }
    }
    txn.commit().await?;
    announce(&state, &access.calendar).await?;
    if let Some(snapshot) = cancelled {
        let after = match scope {
            EditScope::All => None,
            _ => {
                calendar_events::Entity::find_by_id(event.id)
                    .one(&state.db)
                    .await?
            }
        };
        invitations::send(
            &state,
            after.as_ref(),
            Some(session.user_id),
            Notice::Cancelled(Box::new(Cancellation {
                event: event.clone(),
                snapshot,
                attendees: listed,
                date: cancelled_date,
                after: after.clone(),
            })),
        )
        .await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `PUT /api/v1/events/{event_id}/me`: the caller's own reminder for an event (its whole series).
/// Allowed to everyone who sees the event, writer or not.
#[utoipa::path(
    put,
    path = "/api/v1/events/{event_id}/me",
    tag = "calendar",
    params(("event_id" = Uuid, Path, description = "Event id")),
    request_body = EventMe,
    responses(
        (status = 204, description = "Saved"),
        (status = 404, description = "No such event for the caller"),
        (status = 422, description = "Unknown reminder delay")
    )
)]
pub async fn put_event_me(
    State(state): State<AppState>,
    session: AuthSession,
    Path(event_id): Path<Uuid>,
    Json(body): Json<EventMe>,
) -> Result<StatusCode, CalendarError> {
    let (event, _) = load_event(&state.db, session.user_id, event_id).await?;
    if body.reminder_default {
        calendar_event_reminders::Entity::delete_by_id((session.user_id, event.id))
            .exec(&state.db)
            .await?;
    } else if let Some(minutes) = body.reminder_minutes {
        check_reminder(minutes, event.all_day)?;
        set_my_reminder(&state.db, session.user_id, event.id, minutes).await?;
    }
    state
        .hub
        .publish(
            vec![session.user_id],
            RealtimeEnvelope::calendar_changed(event.calendar_id),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `PUT /api/v1/events/{event_id}/response`: the caller's answer to an invitation, for the series or
/// for one date of it.
#[utoipa::path(
    put,
    path = "/api/v1/events/{event_id}/response",
    tag = "calendar",
    params(("event_id" = Uuid, Path, description = "Event id")),
    request_body = ResponseInput,
    responses(
        (status = 200, description = "The event, with the answer", body = EventDto),
        (status = 403, description = "Not invited to it"),
        (status = 404, description = "No such event for the caller"),
        (status = 422, description = "Not an answer, or not a date of the series")
    )
)]
pub async fn respond(
    State(state): State<AppState>,
    session: AuthSession,
    Path(event_id): Path<Uuid>,
    Json(body): Json<ResponseInput>,
) -> Result<Json<EventDto>, CalendarError> {
    let (event, access) = load_event(&state.db, session.user_id, event_id).await?;
    let row = attendees::row_of(&state.db, event.id, session.user_id)
        .await?
        .ok_or(CalendarError::Forbidden)?;
    if !attendees::is_answer(&body.status) {
        return Err(CalendarError::Invalid(
            "An answer is accepted, tentative or declined.",
        ));
    }
    let date = match body.recurrence_id.as_deref() {
        None => None,
        Some(key) => {
            let id = RecurrenceId::from_key(key).ok_or(CalendarError::Invalid(
                "This occurrence is not one of the series.",
            ))?;
            if event.rrule.is_none() || !names_an_occurrence(&event, &id)? {
                return Err(CalendarError::Invalid(
                    "This occurrence is not one of the series.",
                ));
            }
            Some(id)
        }
    };
    attendees::answer(&state.db, &row, &body.status, date.as_ref()).await?;
    if body.status == attendees::DECLINED {
        invitations::send(
            &state,
            Some(&event),
            Some(session.user_id),
            Notice::Declined {
                attendee: row,
                date,
            },
        )
        .await;
    }
    announce(&state, &access.calendar).await?;
    state
        .hub
        .publish(
            vec![session.user_id],
            RealtimeEnvelope::calendar_changed(event.calendar_id),
        )
        .await;
    Ok(Json(
        event_dto(&state.db, session.user_id, event, &access).await?,
    ))
}
