//! Free/busy: when someone is taken, without a word of what by.
//!
//! Someone is busy during what they have committed to: the events of their own calendars, those
//! they are invited to and did not decline (that date), and those they organise that have
//! attendees. An event of a space calendar that asks nothing of them (a colleague's leave, a
//! notice) keeps nobody busy. Only the times go out, merged, never a title or a calendar.
//!
//! Asking is for people who share a space: anyone else's diary is not the caller's business.

use std::collections::{HashMap, HashSet};

use axum::extract::State;
use axum::Json;
use sea_orm::{ColumnTrait, Condition, ConnectionTrait, EntityTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};
use utoipa::ToSchema;
use uuid::Uuid;

use super::attendees;
use super::error::CalendarError;
use super::events::{exception_inputs, instant_text, series_of};
use super::recurrence::{self, When};
use super::reminders::reader_time_zone;
use crate::auth::extract::AuthSession;
use crate::entities::{
    calendar_attendee_overrides as overrides, calendar_event_attendees as attendee_rows,
    calendar_event_exceptions as exceptions, calendar_events, calendars, space_members, users,
};
use crate::state::AppState;

/// The most people one question may ask about.
const MAX_PEOPLE: usize = 30;

/// The longest period one question may cover.
const MAX_DAYS: i64 = 31;

#[derive(Debug, Deserialize, ToSchema)]
pub struct FreeBusyQuery {
    pub users: Vec<Uuid>,
    /// RFC 3339.
    pub from: String,
    /// RFC 3339, exclusive.
    pub to: String,
    /// An event to leave out: the one being moved, which should not stand in its own way.
    pub exclude_event: Option<Uuid>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BusyDto {
    /// RFC 3339, in UTC.
    pub start: String,
    pub end: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FreeBusyDto {
    pub user_id: Uuid,
    /// The times they are taken, merged and in order.
    pub busy: Vec<BusyDto>,
}

/// Merge overlapping or touching intervals, in order.
pub fn merge(
    mut intervals: Vec<(OffsetDateTime, OffsetDateTime)>,
) -> Vec<(OffsetDateTime, OffsetDateTime)> {
    intervals.retain(|(start, end)| end > start);
    intervals.sort();
    let mut merged: Vec<(OffsetDateTime, OffsetDateTime)> = Vec::with_capacity(intervals.len());
    for (start, end) in intervals {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

/// When `person` is busy within `[from, to)`, leaving `exclude` out.
pub async fn busy_of<C: ConnectionTrait>(
    db: &C,
    person: Uuid,
    from: OffsetDateTime,
    to: OffsetDateTime,
    exclude: Option<Uuid>,
) -> Result<Vec<(OffsetDateTime, OffsetDateTime)>, CalendarError> {
    let own_calendars: Vec<Uuid> = calendars::Entity::find()
        .filter(calendars::Column::OwnerUserId.eq(person))
        .all(db)
        .await?
        .into_iter()
        .map(|c| c.id)
        .collect();
    let invitations = attendee_rows::Entity::find()
        .filter(attendee_rows::Column::UserId.eq(person))
        .all(db)
        .await?;
    let mut dates: HashMap<Uuid, HashMap<String, String>> = HashMap::new();
    if !invitations.is_empty() {
        for answer in overrides::Entity::find()
            .filter(overrides::Column::AttendeeId.is_in(invitations.iter().map(|r| r.id)))
            .all(db)
            .await?
        {
            dates
                .entry(answer.attendee_id)
                .or_default()
                .insert(answer.recurrence_id, answer.status);
        }
    }
    // Event → (series answer, date answers) for the events they are invited to.
    let answers: HashMap<Uuid, (String, HashMap<String, String>)> = invitations
        .iter()
        .map(|r| {
            (
                r.event_id,
                (r.status.clone(), dates.remove(&r.id).unwrap_or_default()),
            )
        })
        .collect();
    let organised_with_attendees: HashSet<Uuid> = attendee_rows::Entity::find()
        .filter(
            attendee_rows::Column::EventId.in_subquery(
                sea_orm::sea_query::Query::select()
                    .column(calendar_events::Column::Id)
                    .from(calendar_events::Entity)
                    .and_where(calendar_events::Column::CreatedBy.eq(person))
                    .to_owned(),
            ),
        )
        .all(db)
        .await?
        .into_iter()
        .map(|r| r.event_id)
        .collect();

    let day = Duration::days(1);
    let events = calendar_events::Entity::find()
        .filter(
            Condition::any()
                .add(calendar_events::Column::CalendarId.is_in(own_calendars))
                .add(calendar_events::Column::Id.is_in(answers.keys().copied()))
                .add(calendar_events::Column::Id.is_in(organised_with_attendees)),
        )
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
        .all(db)
        .await?;
    if events.is_empty() {
        return Ok(Vec::new());
    }
    let zone = reader_time_zone(users::Entity::find_by_id(person).one(db).await?.as_ref());
    let mut by_event: HashMap<Uuid, Vec<exceptions::Model>> = HashMap::new();
    for row in exceptions::Entity::find()
        .filter(exceptions::Column::EventId.is_in(events.iter().map(|e| e.id)))
        .all(db)
        .await?
    {
        by_event.entry(row.event_id).or_default().push(row);
    }

    let mut busy = Vec::new();
    for event in events.iter().filter(|e| Some(e.id) != exclude) {
        let rows = by_event.remove(&event.id).unwrap_or_default();
        let inputs = exception_inputs(&rows);
        for occurrence in recurrence::expand(&series_of(event, &inputs), from, to)? {
            if let Some((series, dates)) = answers.get(&event.id) {
                let own = occurrence
                    .recurrence_id
                    .and_then(|id| dates.get(&id.to_key()));
                if own.unwrap_or(series) == attendees::DECLINED {
                    continue;
                }
            }
            let (start, end) = match occurrence.when {
                When::Timed { start, end } => (start, end),
                When::AllDay { start, end } => {
                    match (
                        recurrence::local_midnight(start, &zone),
                        recurrence::local_midnight(end, &zone),
                    ) {
                        (Some(a), Some(b)) => (a, b),
                        _ => continue,
                    }
                }
            };
            busy.push((start.max(from), end.min(to)));
        }
    }
    Ok(merge(busy))
}

/// `POST /api/v1/calendar/freebusy`: when some people are busy over a period, for whoever shares a
/// space with each of them.
#[utoipa::path(
    post,
    path = "/api/v1/calendar/freebusy",
    tag = "calendar",
    request_body = FreeBusyQuery,
    responses(
        (status = 200, description = "Each person's busy times", body = [FreeBusyDto]),
        (status = 403, description = "Someone shares no space with the caller"),
        (status = 422, description = "Too many people, or too long or an invalid period")
    )
)]
pub async fn free_busy(
    State(state): State<AppState>,
    session: AuthSession,
    Json(query): Json<FreeBusyQuery>,
) -> Result<Json<Vec<FreeBusyDto>>, CalendarError> {
    let parse = |text: &str| {
        OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
            .map_err(|_| CalendarError::Invalid("A period is two RFC 3339 instants."))
    };
    let (from, to) = (parse(&query.from)?, parse(&query.to)?);
    if to <= from || to - from > Duration::days(MAX_DAYS) {
        return Err(CalendarError::Invalid("A period is at most 31 days."));
    }
    let people: Vec<Uuid> = {
        let mut seen = HashSet::new();
        query
            .users
            .into_iter()
            .filter(|u| seen.insert(*u))
            .collect()
    };
    if people.len() > MAX_PEOPLE {
        return Err(CalendarError::Invalid("At most 30 people at once."));
    }
    let mine: Vec<Uuid> = space_members::Entity::find()
        .filter(space_members::Column::UserId.eq(session.user_id))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|m| m.space_id)
        .collect();
    let reachable: HashSet<Uuid> = space_members::Entity::find()
        .filter(space_members::Column::SpaceId.is_in(mine))
        .filter(space_members::Column::UserId.is_in(people.clone()))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|m| m.user_id)
        .chain([session.user_id])
        .collect();
    if people.iter().any(|p| !reachable.contains(p)) {
        return Err(CalendarError::Forbidden);
    }
    let mut found = Vec::with_capacity(people.len());
    for person in people {
        let busy = busy_of(&state.db, person, from, to, query.exclude_event).await?;
        found.push(FreeBusyDto {
            user_id: person,
            busy: busy
                .into_iter()
                .map(|(start, end)| BusyDto {
                    start: instant_text(start),
                    end: instant_text(end),
                })
                .collect(),
        });
    }
    Ok(Json(found))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(hour: u8, minute: u8) -> OffsetDateTime {
        time::macros::datetime!(2026-10-20 00:00 UTC)
            + Duration::hours(i64::from(hour))
            + Duration::minutes(i64::from(minute))
    }

    #[test]
    fn busy_times_merge_when_they_overlap_or_touch() {
        let merged = merge(vec![
            (at(10, 0), at(11, 0)),
            (at(8, 0), at(9, 0)),
            (at(8, 30), at(9, 30)),
            (at(11, 0), at(11, 30)),
            (at(13, 0), at(13, 0)),
        ]);
        assert_eq!(merged, vec![(at(8, 0), at(9, 30)), (at(10, 0), at(11, 30))]);
    }
}
