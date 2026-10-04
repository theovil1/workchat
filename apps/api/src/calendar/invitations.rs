//! What invitations tell people: an invitation, a change of time or place, a cancellation (or being
//! taken off the list), and a refusal for the organiser.
//!
//! - **Members** get a notification in the app (pushed like any other) and, when no Ruchoir page is
//!   open and their preferences allow it, a mail.
//! - **People invited by address** get a mail in the organiser's language, with the event's
//!   `.ics` attached and a button to the page where they answer.
//!
//! Nobody is told of their own doing, and someone who declined (that date) is not told of a change.
//! A notification keeps the event as it was when it was sent ([`Snapshot`]): a cancellation outlives
//! its event. Telling people never fails what told them: an error is logged, the change stands.

use std::collections::HashMap;

use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use super::attendees;
use super::error::CalendarError;
use super::events::{date_text, instant_text, when_of};
use super::ics::{self, People, Person};
use super::recurrence::{self, RecurrenceId, When};
use super::reminders::reader_time_zone;
use crate::auth::mail_text::{self, InvitationMail, InvitationWords, Locale};
use crate::entities::{
    calendar_attendee_overrides as overrides, calendar_event_attendees as attendee_rows,
    calendar_event_exceptions as exceptions, calendar_events, calendars, notifications, spaces,
    users,
};
use crate::messaging::dto::NotificationDto;
use crate::notify::prefs::{self, Delivery};
use crate::realtime::event::RealtimeEnvelope;
use crate::state::AppState;

/// The event as a notification describes it, kept in `notifications.payload`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Snapshot {
    pub title: String,
    /// RFC 3339 in UTC, or `YYYY-MM-DD` for an all-day event.
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub tzid: Option<String>,
    pub location: Option<String>,
    pub calendar_name: String,
    pub space_id: Option<Uuid>,
    pub space_name: Option<String>,
    /// The date it is about, for one occurrence of a series.
    pub recurrence_id: Option<String>,
    pub recurring: bool,
    /// What changed, for a change: `time`, `location`.
    #[serde(default)]
    pub changes: Vec<String>,
    /// Who did it, when they have no account (someone invited by address who declined).
    #[serde(default)]
    pub actor_name: Option<String>,
}

/// Describe `event`, or its occurrence `date`, as it stands.
pub async fn snapshot<C: ConnectionTrait>(
    db: &C,
    event: &calendar_events::Model,
    date: Option<RecurrenceId>,
    changes: Vec<String>,
) -> Result<Snapshot, CalendarError> {
    let calendar = calendars::Entity::find_by_id(event.calendar_id)
        .one(db)
        .await?
        .ok_or(CalendarError::Internal)?;
    let space_name = match calendar.space_id {
        Some(space) => spaces::Entity::find_by_id(space)
            .one(db)
            .await?
            .map(|s| s.name),
        None => None,
    };
    let series = when_of(event);
    let (mut title, mut location, mut when) = (event.title.clone(), event.location.clone(), series);
    if let Some(id) = date {
        when = recurrence::occurrence_when(&series, id);
        if let Some(row) = exceptions::Entity::find_by_id((event.id, id.to_key()))
            .one(db)
            .await?
            .filter(|r| !r.cancelled)
        {
            if let Some(own) = row.title {
                title = own;
            }
            location = row.location;
            when = match (row.start_at, row.end_at, row.start_date, row.end_date) {
                (Some(start), Some(end), _, _) => When::Timed { start, end },
                (_, _, Some(start), Some(end)) => When::AllDay { start, end },
                _ => when,
            };
        }
    }
    let (start, end) = match when {
        When::Timed { start, end } => (instant_text(start), instant_text(end)),
        When::AllDay { start, end } => (date_text(start), date_text(end)),
    };
    Ok(Snapshot {
        title,
        start,
        end,
        all_day: event.all_day,
        tzid: event.tzid.clone(),
        location,
        calendar_name: calendar.name,
        space_id: calendar.space_id,
        space_name,
        recurrence_id: date.map(|d| d.to_key()),
        recurring: event.rrule.is_some(),
        changes,
        actor_name: None,
    })
}

/// An event deleted, in whole or in part. `event` and `snapshot` are read before the deletion;
/// `after` is the series as it stands after, when something is left.
pub struct Cancellation {
    pub event: calendar_events::Model,
    pub snapshot: Snapshot,
    pub attendees: Vec<attendee_rows::Model>,
    pub date: Option<RecurrenceId>,
    pub after: Option<calendar_events::Model>,
}

/// Something to tell the people of an event.
pub enum Notice {
    /// They were invited.
    Invited(Vec<attendee_rows::Model>),
    /// Its time or place changed, for the series or for one `date`; not those just invited.
    Updated {
        changes: Vec<String>,
        date: Option<RecurrenceId>,
        except: Vec<Uuid>,
    },
    /// They were taken off its list.
    Removed(Vec<attendee_rows::Model>),
    /// It was deleted (all of it, or one date, or a date and what follows).
    Cancelled(Box<Cancellation>),
    /// An attendee declined, for the series or for `date`.
    Declined {
        attendee: attendee_rows::Model,
        date: Option<RecurrenceId>,
    },
}

/// Tell people about `event` (absent once deleted), done by `actor` (absent for someone without an
/// account). Never fails: what goes wrong is logged.
pub async fn send(
    state: &AppState,
    event: Option<&calendar_events::Model>,
    actor: Option<Uuid>,
    notice: Notice,
) {
    if let Err(error) = deliver(state, event, actor, notice).await {
        tracing::warn!(?error, "could not tell people about a calendar invitation");
    }
}

/// Open pages of the people of an event that changed reload it: someone invited to a calendar
/// they do not see hears nothing from the calendar itself.
async fn refresh(state: &AppState, calendar_id: Uuid, rows: &[attendee_rows::Model]) {
    let people: Vec<Uuid> = rows.iter().filter_map(|r| r.user_id).collect();
    if !people.is_empty() {
        state
            .hub
            .publish(people, RealtimeEnvelope::calendar_changed(calendar_id))
            .await;
    }
}

async fn deliver(
    state: &AppState,
    event: Option<&calendar_events::Model>,
    actor: Option<Uuid>,
    notice: Notice,
) -> Result<(), CalendarError> {
    let db = &state.db;
    if let Some(event) = event {
        refresh(
            state,
            event.calendar_id,
            &attendees::list(db, event.id).await?,
        )
        .await;
    }
    match notice {
        Notice::Invited(rows) => {
            let Some(event) = event else { return Ok(()) };
            let snap = snapshot(db, event, None, Vec::new()).await?;
            let members = members_of(&rows, actor);
            tell_members(
                state,
                "calendar_invitation",
                Some(event.id),
                &snap,
                &members,
                actor,
            )
            .await?;
            mail_outside(
                state,
                event,
                &snap,
                &rows,
                InvitationMail::Invited,
                "REQUEST",
            )
            .await?;
        }
        Notice::Updated {
            changes,
            date,
            except,
        } => {
            let Some(event) = event else { return Ok(()) };
            let snap = snapshot(db, event, date, changes).await?;
            let rows: Vec<attendee_rows::Model> = going(db, event.id, date)
                .await?
                .into_iter()
                .filter(|r| !except.contains(&r.id))
                .collect();
            let members = members_of(&rows, actor);
            tell_members(
                state,
                "calendar_update",
                Some(event.id),
                &snap,
                &members,
                actor,
            )
            .await?;
            mail_outside(
                state,
                event,
                &snap,
                &rows,
                InvitationMail::Updated,
                "REQUEST",
            )
            .await?;
        }
        Notice::Removed(rows) => {
            let Some(event) = event else { return Ok(()) };
            refresh(state, event.calendar_id, &rows).await;
            let snap = snapshot(db, event, None, Vec::new()).await?;
            let members = members_of(&rows, actor);
            tell_members(
                state,
                "calendar_cancel",
                Some(event.id),
                &snap,
                &members,
                actor,
            )
            .await?;
            mail_outside(
                state,
                event,
                &snap,
                &rows,
                InvitationMail::Cancelled,
                "CANCEL",
            )
            .await?;
        }
        Notice::Cancelled(cancellation) => {
            let Cancellation {
                event: before,
                snapshot: snap,
                attendees,
                date,
                after,
            } = *cancellation;
            refresh(state, before.calendar_id, &attendees).await;
            let rows = not_declined(db, attendees, date).await?;
            let members = members_of(&rows, actor);
            let subject = after.as_ref().map(|e| e.id);
            tell_members(state, "calendar_cancel", subject, &snap, &members, actor).await?;
            // Outside, a whole cancellation cancels; a date taken out sends the series as it is now.
            match &after {
                Some(series) => {
                    mail_outside(
                        state,
                        series,
                        &snap,
                        &rows,
                        InvitationMail::Cancelled,
                        "REQUEST",
                    )
                    .await?;
                }
                None => {
                    mail_outside(
                        state,
                        &before,
                        &snap,
                        &rows,
                        InvitationMail::Cancelled,
                        "CANCEL",
                    )
                    .await?;
                }
            }
        }
        Notice::Declined { attendee, date } => {
            let Some(event) = event else { return Ok(()) };
            let Some(organizer) = event.created_by.filter(|o| Some(*o) != attendee.user_id) else {
                return Ok(());
            };
            let mut snap = snapshot(db, event, date, Vec::new()).await?;
            if attendee.user_id.is_none() {
                snap.actor_name = attendee.name.clone().or_else(|| attendee.email.clone());
            }
            tell_members(
                state,
                "calendar_declined",
                Some(event.id),
                &snap,
                &[organizer],
                attendee.user_id,
            )
            .await?;
        }
    }
    Ok(())
}

/// The members among `rows`, but the one who acted.
fn members_of(rows: &[attendee_rows::Model], actor: Option<Uuid>) -> Vec<Uuid> {
    rows.iter()
        .filter_map(|r| r.user_id)
        .filter(|u| Some(*u) != actor)
        .collect()
}

/// An event's attendees who did not decline it (that `date`).
async fn going<C: ConnectionTrait>(
    db: &C,
    event_id: Uuid,
    date: Option<RecurrenceId>,
) -> Result<Vec<attendee_rows::Model>, CalendarError> {
    not_declined(db, attendees::list(db, event_id).await?, date).await
}

async fn not_declined<C: ConnectionTrait>(
    db: &C,
    rows: Vec<attendee_rows::Model>,
    date: Option<RecurrenceId>,
) -> Result<Vec<attendee_rows::Model>, CalendarError> {
    let dates: HashMap<Uuid, String> = match date {
        Some(id) if !rows.is_empty() => overrides::Entity::find()
            .filter(overrides::Column::AttendeeId.is_in(rows.iter().map(|r| r.id)))
            .filter(overrides::Column::RecurrenceId.eq(id.to_key()))
            .all(db)
            .await?
            .into_iter()
            .map(|o| (o.attendee_id, o.status))
            .collect(),
        _ => HashMap::new(),
    };
    Ok(rows
        .into_iter()
        .filter(|r| dates.get(&r.id).unwrap_or(&r.status) != attendees::DECLINED)
        .collect())
}

/// Write the notifications, push them, show them in open pages, and mail those who have none open.
async fn tell_members(
    state: &AppState,
    kind: &str,
    event_id: Option<Uuid>,
    snap: &Snapshot,
    people: &[Uuid],
    actor: Option<Uuid>,
) -> Result<(), CalendarError> {
    if people.is_empty() {
        return Ok(());
    }
    let now = OffsetDateTime::now_utc();
    let payload = serde_json::to_value(snap).map_err(|_| CalendarError::Internal)?;
    let mut created = Vec::with_capacity(people.len());
    for person in people {
        let row = notifications::ActiveModel {
            id: Set(Uuid::new_v4()),
            user_id: Set(*person),
            kind: Set(kind.to_owned()),
            conversation_id: Set(None),
            message_id: Set(None),
            event_id: Set(event_id),
            occurrence_start: Set(None),
            payload: Set(Some(payload.clone())),
            actor_id: Set(actor),
            created_at: Set(now),
            read_at: Set(None),
            // Mailed below when it should be: the unread digest never takes it.
            email_handled_at: Set(Some(now)),
        };
        created.push(row.insert(&state.db).await?);
    }
    crate::notify::push::dispatch(state, &created);
    let readers: HashMap<Uuid, users::Model> = users::Entity::find()
        .filter(users::Column::Id.is_in(people.iter().copied()))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|u| (u.id, u))
        .collect();
    let recipients: HashMap<Uuid, Uuid> = created.iter().map(|r| (r.id, r.user_id)).collect();
    for dto in hydrate(&state.db, created).await? {
        let Some(person) = recipients.get(&dto.id).copied() else {
            continue;
        };
        state
            .hub
            .publish(vec![person], RealtimeEnvelope::notification_created(&dto))
            .await;
        let Some(reader) = readers.get(&person) else {
            continue;
        };
        let user_prefs = prefs::load(&state.db, person)
            .await
            .map_err(|_| CalendarError::Internal)?;
        let online = crate::realtime::presence::is_online(state.hub.valkey(), person).await;
        if !online
            && prefs::allows(kind, &user_prefs, None, Delivery::Email)
            && prefs::may_interrupt(&user_prefs, reader.manual_presence.as_deref(), now)
        {
            // In the background: a relay that answers slowly must not hold up the change.
            let (state, reader, dto) = (state.clone(), reader.clone(), dto.clone());
            tokio::spawn(async move { mail_member(&state, &reader, &dto).await });
        }
    }
    Ok(())
}

/// The kind of mail a notification kind makes.
fn mail_kind(kind: &str) -> InvitationMail {
    match kind {
        "calendar_update" => InvitationMail::Updated,
        "calendar_cancel" => InvitationMail::Cancelled,
        "calendar_declined" => InvitationMail::Declined,
        _ => InvitationMail::Invited,
    }
}

async fn mail_member(state: &AppState, reader: &users::Model, dto: &NotificationDto) {
    if !state.mailer.can_send() {
        return;
    }
    let locale = Locale::parse(reader.locale.as_deref());
    let zone = reader_time_zone(Some(reader));
    let actor = dto
        .actor_name
        .clone()
        .unwrap_or_else(|| mail_text::someone(locale).to_owned());
    let when = when_words(
        locale,
        dto.event_start.as_deref().unwrap_or_default(),
        &zone,
        false,
    );
    let words = InvitationWords {
        kind: mail_kind(&dto.kind),
        actor: &actor,
        title: dto.event_title.as_deref().unwrap_or_default(),
        when: &when,
        location: dto.event_location.as_deref(),
        link: &state.mailer.base_url,
        external: false,
    };
    let email = mail_text::calendar_invitation(locale, &words, &state.mailer.instance_name());
    if let Err(error) = state.mailer.send(&reader.email, &email).await {
        tracing::warn!(%error, "could not send a calendar invitation by mail");
    }
}

/// Mail the people among `rows` invited by address: the words, the link to answer, the `.ics`.
async fn mail_outside(
    state: &AppState,
    event: &calendar_events::Model,
    snap: &Snapshot,
    rows: &[attendee_rows::Model],
    kind: InvitationMail,
    method: &'static str,
) -> Result<(), CalendarError> {
    let outside: Vec<&attendee_rows::Model> = rows.iter().filter(|r| r.email.is_some()).collect();
    if outside.is_empty() || !state.mailer.can_send() {
        return Ok(());
    }
    let organizer = match event.created_by {
        Some(id) => users::Entity::find_by_id(id).one(&state.db).await?,
        None => None,
    };
    let locale = Locale::parse(organizer.as_ref().and_then(|o| o.locale.as_deref()));
    let actor = organizer
        .as_ref()
        .map(|o| o.display_name.clone())
        .unwrap_or_else(|| mail_text::someone(locale).to_owned());
    let zone = snap
        .tzid
        .clone()
        .unwrap_or_else(|| reader_time_zone(organizer.as_ref()));
    let when = when_words(locale, &snap.start, &zone, !snap.all_day);
    let body = event_ics(&state.db, event, method).await?;
    let base = state.mailer.base_url.trim_end_matches('/');
    for row in outside {
        let Some(address) = row.email.as_deref() else {
            continue;
        };
        let link = match (method, attendees::token_of(&state.secret_key, row)) {
            ("CANCEL", _) | (_, None) => String::new(),
            (_, Some(token)) => format!("{base}/i/?t={token}"),
        };
        let words = InvitationWords {
            kind,
            actor: &actor,
            title: &snap.title,
            when: &when,
            location: snap.location.as_deref(),
            link: &link,
            external: true,
        };
        let mut email =
            mail_text::calendar_invitation(locale, &words, &state.mailer.instance_name());
        email.calendar = Some(mail_text::CalendarPart {
            method,
            body: body.clone(),
        });
        let (state, address) = (state.clone(), address.to_owned());
        tokio::spawn(async move {
            if let Err(error) = state.mailer.send(&address, &email).await {
                tracing::warn!(%error, "could not send a calendar invitation by mail");
            }
        });
    }
    Ok(())
}

/// The people of some events, as iCalendar writes them.
pub async fn people_of<C: ConnectionTrait>(
    db: &C,
    events: &[calendar_events::Model],
) -> Result<HashMap<Uuid, People>, CalendarError> {
    let rows = attendee_rows::Entity::find()
        .filter(attendee_rows::Column::EventId.is_in(events.iter().map(|e| e.id)))
        .all(db)
        .await?;
    let organizers: Vec<Uuid> = events.iter().filter_map(|e| e.created_by).collect();
    let accounts: HashMap<Uuid, users::Model> = users::Entity::find()
        .filter(
            users::Column::Id.is_in(
                organizers
                    .iter()
                    .copied()
                    .chain(rows.iter().filter_map(|r| r.user_id)),
            ),
        )
        .all(db)
        .await?
        .into_iter()
        .map(|u| (u.id, u))
        .collect();
    let mut found: HashMap<Uuid, People> = HashMap::new();
    for row in rows {
        let person = match (row.user_id, row.email.as_deref()) {
            (Some(user), _) => Person {
                name: accounts
                    .get(&user)
                    .map(|u| u.display_name.clone())
                    .unwrap_or_default(),
                address: format!("urn:uuid:{user}"),
                status: row.status.clone(),
            },
            (None, Some(email)) => Person {
                name: row.name.clone().unwrap_or_else(|| email.to_owned()),
                address: format!("mailto:{email}"),
                status: row.status.clone(),
            },
            _ => continue,
        };
        found
            .entry(row.event_id)
            .or_default()
            .attendees
            .push(person);
    }
    for event in events {
        let Some(people) = found.get_mut(&event.id) else {
            continue;
        };
        if let Some(organizer) = event.created_by.and_then(|o| accounts.get(&o)) {
            people.organizer = Some((
                organizer.display_name.clone(),
                format!("mailto:{}", organizer.email),
            ));
        }
    }
    Ok(found)
}

/// One event as an iCalendar message.
async fn event_ics<C: ConnectionTrait>(
    db: &C,
    event: &calendar_events::Model,
    method: &str,
) -> Result<String, CalendarError> {
    let rows = exceptions::Entity::find()
        .filter(exceptions::Column::EventId.eq(event.id))
        .all(db)
        .await?;
    let people = people_of(db, std::slice::from_ref(event)).await?;
    Ok(ics::render_with(
        &event.title,
        None,
        &[(event.clone(), rows)],
        &people,
        Some(method),
    ))
}

/// When an occurrence happens, in words: "20/10 10:00", "20/10" for an all-day one, with the zone
/// for someone outside, who may live in another.
pub fn when_words(locale: Locale, start: &str, zone: &str, with_zone: bool) -> String {
    match RecurrenceId::from_key(start) {
        Some(RecurrenceId::Instant(at)) => match recurrence::local_parts(at, zone) {
            Some((date, hour, minute)) => {
                let text = format!(
                    "{} {hour:02}:{minute:02}",
                    mail_text::short_date(locale, date)
                );
                if with_zone {
                    format!("{text} ({zone})")
                } else {
                    text
                }
            }
            None => start.to_owned(),
        },
        Some(RecurrenceId::Date(date)) => mail_text::short_date(locale, date),
        None => start.to_owned(),
    }
}

/// Draw invitation notifications from what they kept, with each reader's answer as it stands now.
pub async fn hydrate<C: ConnectionTrait>(
    db: &C,
    rows: Vec<notifications::Model>,
) -> Result<Vec<NotificationDto>, CalendarError> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let names = attendees::names(db, rows.iter().filter_map(|r| r.actor_id)).await?;
    // (event, reader) → their answer for the series and for its dates.
    let mut answers: HashMap<(Uuid, Uuid), (String, HashMap<String, String>)> = HashMap::new();
    let event_ids: Vec<Uuid> = rows.iter().filter_map(|r| r.event_id).collect();
    if !event_ids.is_empty() {
        let readers: Vec<Uuid> = rows.iter().map(|r| r.user_id).collect();
        let lists = attendee_rows::Entity::find()
            .filter(attendee_rows::Column::EventId.is_in(event_ids))
            .filter(attendee_rows::Column::UserId.is_in(readers))
            .all(db)
            .await?;
        let mut dates: HashMap<Uuid, HashMap<String, String>> = HashMap::new();
        if !lists.is_empty() {
            for answer in overrides::Entity::find()
                .filter(overrides::Column::AttendeeId.is_in(lists.iter().map(|r| r.id)))
                .all(db)
                .await?
            {
                dates
                    .entry(answer.attendee_id)
                    .or_default()
                    .insert(answer.recurrence_id, answer.status);
            }
        }
        for row in lists {
            if let Some(user) = row.user_id {
                answers.insert(
                    (row.event_id, user),
                    (
                        row.status.clone(),
                        dates.remove(&row.id).unwrap_or_default(),
                    ),
                );
            }
        }
    }
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let snap: Snapshot = serde_json::from_value(row.payload.clone()?).ok()?;
            let my_status = row.event_id.and_then(|event| {
                let (series, dates) = answers.get(&(event, row.user_id))?;
                let own = snap.recurrence_id.as_ref().and_then(|k| dates.get(k));
                Some(own.unwrap_or(series).clone())
            });
            Some(NotificationDto {
                id: row.id,
                kind: row.kind.clone(),
                conversation_id: None,
                space_id: snap.space_id,
                channel_name: None,
                space_name: snap.space_name.clone().unwrap_or_default(),
                message_id: None,
                actor_id: row.actor_id,
                actor_name: row
                    .actor_id
                    .and_then(|a| names.get(&a).cloned())
                    .or_else(|| snap.actor_name.clone()),
                preview: String::new(),
                created_at: instant_text(row.created_at),
                read: row.read_at.is_some(),
                event_id: row.event_id,
                recurrence_id: snap.recurrence_id.clone(),
                event_title: Some(snap.title.clone()),
                event_start: Some(snap.start.clone()),
                event_all_day: Some(snap.all_day),
                event_location: snap.location.clone(),
                calendar_name: Some(snap.calendar_name.clone()),
                event_changes: (row.kind == "calendar_update").then(|| snap.changes.clone()),
                event_my_status: my_status,
            })
        })
        .collect())
}

/// An invitation notification in words, for a push: its subject, then when and where.
pub fn texts(locale: Locale, dto: &NotificationDto, zone: &str) -> (String, String) {
    let actor = dto
        .actor_name
        .clone()
        .unwrap_or_else(|| mail_text::someone(locale).to_owned());
    let title = mail_text::invitation_subject(
        locale,
        mail_kind(&dto.kind),
        &actor,
        dto.event_title.as_deref().unwrap_or_default(),
    );
    let when = when_words(
        locale,
        dto.event_start.as_deref().unwrap_or_default(),
        zone,
        false,
    );
    let body = match dto.event_location.as_deref() {
        Some(place) => format!("{when} · {place}"),
        None => when,
    };
    (title, body)
}

/// Compare an event before and after a change: what its people should hear about.
pub fn changes_between(
    before: &When,
    after: &When,
    before_place: Option<&str>,
    after_place: Option<&str>,
) -> Vec<String> {
    let mut changes = Vec::new();
    if before != after {
        changes.push("time".to_owned());
    }
    if before_place.map(str::trim).filter(|p| !p.is_empty())
        != after_place.map(str::trim).filter(|p| !p.is_empty())
    {
        changes.push("location".to_owned());
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::Duration;

    #[test]
    fn a_change_names_what_changed() {
        let at = time::macros::datetime!(2026-10-20 08:00 UTC);
        let one = When::Timed {
            start: at,
            end: at + Duration::hours(1),
        };
        let later = When::Timed {
            start: at + Duration::hours(1),
            end: at + Duration::hours(2),
        };
        assert!(changes_between(&one, &one, Some("A"), Some(" A ")).is_empty());
        assert_eq!(changes_between(&one, &later, None, None), vec!["time"]);
        assert_eq!(
            changes_between(&one, &one, None, Some("Salle")),
            vec!["location"]
        );
        assert_eq!(
            changes_between(&one, &one, Some(""), None),
            Vec::<String>::new()
        );
    }

    #[test]
    fn when_is_read_in_the_readers_zone() {
        assert_eq!(
            when_words(Locale::Fr, "2026-10-20T08:00:00Z", "Europe/Paris", false),
            "20/10 10:00"
        );
        assert_eq!(
            when_words(Locale::En, "2026-10-20T08:00:00Z", "Europe/Paris", true),
            "10/20 10:00 (Europe/Paris)"
        );
        assert_eq!(
            when_words(Locale::Fr, "2026-10-20", "Europe/Paris", true),
            "20/10"
        );
    }
}
