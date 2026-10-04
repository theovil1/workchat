//! The occurrences of a period, unfolded from every visible series, ready to draw.

use std::collections::{HashMap, HashSet};

use axum::extract::{Query, State};
use axum::Json;
use sea_orm::{ColumnTrait, Condition, EntityTrait, QueryFilter};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use super::authz::{self, CalendarAccess};
use super::dto::{OccurrenceDto, OccurrencesQuery};
use super::error::CalendarError;
use super::events::{exception_inputs, series_of, when_texts, ViewerReminders};
use super::recurrence::{self, RecurrenceError};
use crate::auth::extract::AuthSession;
use crate::entities::{calendar_event_exceptions as exceptions, calendar_events};
use crate::state::AppState;

fn parse_bound(text: &str) -> Result<OffsetDateTime, CalendarError> {
    OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
        .map_err(|_| CalendarError::Invalid("A period is two RFC 3339 instants."))
}

/// `GET /api/v1/calendar/occurrences?from=&to=&calendars=`: what happens in `[from, to)`.
#[utoipa::path(
    get,
    path = "/api/v1/calendar/occurrences",
    tag = "calendar",
    params(
        ("from" = String, Query, description = "RFC 3339"),
        ("to" = String, Query, description = "RFC 3339, exclusive; at most 400 days after from"),
        ("calendars" = Option<String>, Query, description = "Comma-separated calendar ids; all visible ones when absent")
    ),
    responses(
        (status = 200, description = "The occurrences, in order", body = [OccurrenceDto]),
        (status = 422, description = "Invalid or too wide a period")
    )
)]
pub async fn list_occurrences(
    State(state): State<AppState>,
    session: AuthSession,
    Query(query): Query<OccurrencesQuery>,
) -> Result<Json<Vec<OccurrenceDto>>, CalendarError> {
    let (from, to) = (parse_bound(&query.from)?, parse_bound(&query.to)?);
    if to <= from {
        return Err(CalendarError::Invalid("A period ends after it starts."));
    }
    if to - from > Duration::days(recurrence::MAX_WINDOW_DAYS) {
        return Err(RecurrenceError::TooWide.into());
    }
    let wanted: Option<HashSet<Uuid>> = match query.calendars.as_deref() {
        None | Some("") => None,
        Some(list) => Some(
            list.split(',')
                .map(|id| id.trim().parse::<Uuid>())
                .collect::<Result<_, _>>()
                .map_err(|_| CalendarError::Invalid("Calendar ids are UUIDs."))?,
        ),
    };
    let accesses: HashMap<Uuid, CalendarAccess> = authz::visible(&state.db, session.user_id)
        .await?
        .into_iter()
        .filter(|a| wanted.as_ref().is_none_or(|w| w.contains(&a.calendar.id)))
        .map(|a| (a.calendar.id, a))
        .collect();
    let calendar_ids: Vec<Uuid> = accesses.keys().copied().collect();
    if calendar_ids.is_empty() {
        return Ok(Json(Vec::new()));
    }

    // Series that may reach into the period: started before its end, not over before its start.
    // All-day bounds are a day wider, as in `recurrence::expand`.
    let day = Duration::days(1);
    let events = calendar_events::Entity::find()
        .filter(calendar_events::Column::CalendarId.is_in(calendar_ids.clone()))
        .filter(
            Condition::any()
                .add(calendar_events::Column::SeriesUntil.is_null())
                .add(calendar_events::Column::SeriesUntil.gt(from - day)),
        )
        .filter(
            Condition::any()
                .add(calendar_events::Column::StartAt.lt(to))
                .add(calendar_events::Column::StartDate.lte((to + day).date())),
        )
        .all(&state.db)
        .await?;
    let event_ids: Vec<Uuid> = events.iter().map(|e| e.id).collect();
    let mut by_event: HashMap<Uuid, Vec<exceptions::Model>> = HashMap::new();
    for row in exceptions::Entity::find()
        .filter(exceptions::Column::EventId.is_in(event_ids.clone()))
        .all(&state.db)
        .await?
    {
        by_event.entry(row.event_id).or_default().push(row);
    }
    let reminders =
        ViewerReminders::load(&state.db, session.user_id, event_ids, calendar_ids).await?;

    let mut found = Vec::new();
    for event in &events {
        let Some(access) = accesses.get(&event.calendar_id) else {
            continue;
        };
        let rows = by_event.remove(&event.id).unwrap_or_default();
        let inputs = exception_inputs(&rows);
        let texts: HashMap<&str, &exceptions::Model> = rows
            .iter()
            .filter(|r| !r.cancelled)
            .map(|r| (r.recurrence_id.as_str(), r))
            .collect();
        let my_reminder = reminders.effective(event, &access.calendar);
        for occurrence in recurrence::expand(&series_of(event, &inputs), from, to)? {
            let key = occurrence.recurrence_id.map(|id| id.to_key());
            let exception = key.as_deref().and_then(|k| texts.get(k));
            let (start, end) = when_texts(&occurrence.when);
            found.push(OccurrenceDto {
                event_id: event.id,
                calendar_id: event.calendar_id,
                recurrence_id: key.clone(),
                title: exception
                    .and_then(|e| e.title.clone())
                    .unwrap_or_else(|| event.title.clone()),
                location: match exception {
                    Some(e) => e.location.clone(),
                    None => event.location.clone(),
                },
                description: match exception {
                    Some(e) => e.description.clone(),
                    None => event.description.clone(),
                },
                all_day: event.all_day,
                start,
                end,
                tzid: event.tzid.clone(),
                is_recurring: event.rrule.is_some(),
                overridden: exception.is_some(),
                can_edit: access.can_write_events,
                my_reminder_minutes: my_reminder,
            });
        }
    }
    // RFC 3339 in UTC and plain dates sort together correctly as text.
    found.sort_by(|a, b| a.start.cmp(&b.start).then(a.title.cmp(&b.title)));
    Ok(Json(found))
}
