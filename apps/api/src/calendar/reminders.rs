//! Reminders: which one applies to whom, the sweep that sends them, and how one is worded.
//!
//! Every minute the sweep looks at the occurrences of the next two days, works out each person's
//! reminder for them, and sends those that fell due in the last fifteen minutes: a notification in
//! the app (pushed to the browser like any other), and a mail to whoever has no Ruchoir open. A
//! reminder later than that is dropped rather than sent at the wrong moment.
//!
//! `calendar_reminder_deliveries` holds one row per person and occurrence, written in the same
//! transaction as the notification and inserted with `ON CONFLICT DO NOTHING`, so two sweeps at the
//! same moment (two API processes) never remind anyone twice.

use std::collections::{HashMap, HashSet};
use std::time::Duration as StdDuration;

use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbBackend, EntityTrait, QueryFilter, Statement,
    TransactionTrait,
};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use super::attendees;
use super::authz;
use super::error::CalendarError;
use super::events::{date_text, exception_inputs, instant_text, series_of, FALLBACK_TIME_ZONE};
use super::recurrence::{self, RecurrenceId, When};
use crate::auth::mail_text::{self, Locale, ReminderDay};
use crate::entities::{
    calendar_attendee_overrides as attendee_overrides, calendar_event_attendees as attendee_rows,
    calendar_event_exceptions as exceptions, calendar_event_reminders, calendar_events,
    calendar_reminder_prefs, calendars, notifications, spaces, users,
};
use crate::messaging::dto::NotificationDto;
use crate::notify::prefs::{self, NotificationPrefs};
use crate::realtime::event::RealtimeEnvelope;
use crate::state::AppState;

/// How often the sweep runs.
const SWEEP_INTERVAL: StdDuration = StdDuration::from_secs(60);

/// How late a reminder may still be sent.
pub const LATE_LIMIT: Duration = Duration::minutes(15);

/// The reminder a person gets for an event, in minutes: before its start for a timed event, before
/// the local midnight that starts it for an all-day one (`420` the evening before at 17:00, `-540`
/// the same morning at 9:00). `None` is no reminder.
///
/// Their choice for the event wins, then their choice for the calendar, then the calendar's default.
/// The last two speak of timed events only: an all-day event reminds nobody unless they asked.
pub fn effective_minutes(
    event_pref: Option<Option<i32>>,
    calendar_pref: Option<Option<i32>>,
    calendar_default: Option<i32>,
    all_day: bool,
) -> Option<i32> {
    match event_pref {
        Some(chosen) => chosen,
        None if all_day => None,
        None => calendar_pref.unwrap_or(calendar_default),
    }
}

/// Whether a reminder also goes out by mail: the person has no Ruchoir open, wants reminders by
/// mail, and may be interrupted now (quiet hours and "do not disturb" hold it back, and a reminder
/// held back has nothing left to say afterwards).
pub fn should_mail(
    online: bool,
    prefs: &NotificationPrefs,
    manual_presence: Option<&str>,
    now: OffsetDateTime,
) -> bool {
    !online
        && prefs::allows_reminder(prefs, prefs::Delivery::Email)
        && prefs::may_interrupt(prefs, manual_presence, now)
}

/// What one sweep did.
#[derive(Debug, Default)]
pub struct SweepReport {
    /// (person, event, occurrence start) for every reminder sent.
    pub notified: Vec<(Uuid, Uuid, OffsetDateTime)>,
    /// The people a reminder mail was decided for. It goes out when the instance has a mail relay.
    pub mailed: Vec<Uuid>,
}

/// Start the minute-by-minute sweep.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            match sweep(&state, OffsetDateTime::now_utc()).await {
                Ok(report) if report.notified.is_empty() => {}
                Ok(report) => tracing::info!(
                    sent = report.notified.len(),
                    mailed = report.mailed.len(),
                    "sent calendar reminders"
                ),
                Err(error) => tracing::warn!(?error, "calendar reminder sweep failed"),
            }
        }
    });
}

/// The time zone a person reads times in: their profile's, or the instance's fallback.
pub fn reader_time_zone(user: Option<&users::Model>) -> String {
    user.and_then(|u| u.timezone.clone())
        .filter(|tz| recurrence::known_time_zone(tz))
        .unwrap_or_else(|| FALLBACK_TIME_ZONE.to_owned())
}

/// When a reminder of `minutes` falls due for an occurrence, read in `zone` for an all-day one.
fn due_at(when: &When, minutes: i32, zone: &str) -> Option<OffsetDateTime> {
    let start = match *when {
        When::Timed { start, .. } => start,
        When::AllDay { start, .. } => recurrence::local_midnight(start, zone)?,
    };
    Some(start - Duration::minutes(i64::from(minutes)))
}

/// The instant that names an occurrence in the reminder log: its start, or its date's UTC midnight.
fn occurrence_key(when: &When) -> OffsetDateTime {
    match *when {
        When::Timed { start, .. } => start,
        When::AllDay { start, .. } => start.midnight().assume_utc(),
    }
}

/// Who an event with attendees reminds, and who declined which of its dates.
#[derive(Default)]
struct Invited {
    /// Event → the people it reminds: its organiser and attendees who may still be invited.
    audiences: HashMap<Uuid, Vec<Uuid>>,
    /// (event, person) → their answer for the series, and for its dates.
    answers: HashMap<(Uuid, Uuid), (String, HashMap<String, String>)>,
}

impl Invited {
    async fn load<C: ConnectionTrait>(
        db: &C,
        events: &[calendar_events::Model],
        calendars: &HashMap<Uuid, calendars::Model>,
        audiences: &HashMap<Uuid, Vec<Uuid>>,
    ) -> Result<Self, CalendarError> {
        let rows = attendee_rows::Entity::find()
            .filter(attendee_rows::Column::EventId.is_in(events.iter().map(|e| e.id)))
            .filter(attendee_rows::Column::UserId.is_not_null())
            .all(db)
            .await?;
        if rows.is_empty() {
            return Ok(Self::default());
        }
        let mut dates: HashMap<Uuid, HashMap<String, String>> = HashMap::new();
        for answer in attendee_overrides::Entity::find()
            .filter(attendee_overrides::Column::AttendeeId.is_in(rows.iter().map(|r| r.id)))
            .all(db)
            .await?
        {
            dates
                .entry(answer.attendee_id)
                .or_default()
                .insert(answer.recurrence_id, answer.status);
        }
        let mut found = Self::default();
        let mut by_event: HashMap<Uuid, Vec<&attendee_rows::Model>> = HashMap::new();
        for row in &rows {
            by_event.entry(row.event_id).or_default().push(row);
        }
        for event in events {
            let Some(list) = by_event.get(&event.id) else {
                continue;
            };
            let Some(calendar) = calendars.get(&event.calendar_id) else {
                continue;
            };
            let seeing = audiences.get(&calendar.id).cloned().unwrap_or_default();
            let invitees: Vec<Uuid> = list.iter().filter_map(|r| r.user_id).collect();
            let still: HashSet<Uuid> = match calendar.owner_user_id {
                Some(owner) => attendees::invitable(db, calendar, owner, &invitees).await?,
                None => invitees
                    .iter()
                    .copied()
                    .filter(|u| seeing.contains(u))
                    .collect(),
            };
            let mut people: Vec<Uuid> = event
                .created_by
                .filter(|o| seeing.contains(o))
                .into_iter()
                .collect();
            for row in list {
                let Some(user) = row.user_id.filter(|u| still.contains(u)) else {
                    continue;
                };
                people.push(user);
                found.answers.insert(
                    (event.id, user),
                    (
                        row.status.clone(),
                        dates.remove(&row.id).unwrap_or_default(),
                    ),
                );
            }
            found.audiences.insert(event.id, people);
        }
        Ok(found)
    }

    fn people(&self) -> impl Iterator<Item = Uuid> + '_ {
        self.audiences.values().flatten().copied()
    }

    fn audience(&self, event_id: Uuid) -> Option<&[Uuid]> {
        self.audiences.get(&event_id).map(Vec::as_slice)
    }

    fn declined(&self, event_id: Uuid, person: Uuid, date: Option<RecurrenceId>) -> bool {
        let Some((series, dates)) = self.answers.get(&(event_id, person)) else {
            return false;
        };
        let own = date.and_then(|d| dates.get(&d.to_key()));
        own.unwrap_or(series) == attendees::DECLINED
    }
}

/// Run one sweep as of `now`.
pub async fn sweep(state: &AppState, now: OffsetDateTime) -> Result<SweepReport, CalendarError> {
    let (from, to) = (now - Duration::days(1), now + Duration::days(2));
    let events = calendar_events::Entity::find()
        .filter(
            Condition::any()
                .add(calendar_events::Column::SeriesUntil.is_null())
                .add(calendar_events::Column::SeriesUntil.gt(from - Duration::days(1))),
        )
        .filter(
            Condition::any()
                .add(calendar_events::Column::StartAt.lt(to))
                .add(calendar_events::Column::StartDate.lte((to + Duration::days(1)).date())),
        )
        .all(&state.db)
        .await?;
    if events.is_empty() {
        return Ok(SweepReport::default());
    }
    let event_ids: Vec<Uuid> = events.iter().map(|e| e.id).collect();
    let calendar_ids: Vec<Uuid> = events
        .iter()
        .map(|e| e.calendar_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let calendars: HashMap<Uuid, calendars::Model> = calendars::Entity::find()
        .filter(calendars::Column::Id.is_in(calendar_ids.clone()))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|c| (c.id, c))
        .collect();
    let mut by_event: HashMap<Uuid, Vec<exceptions::Model>> = HashMap::new();
    for row in exceptions::Entity::find()
        .filter(exceptions::Column::EventId.is_in(event_ids.clone()))
        .all(&state.db)
        .await?
    {
        by_event.entry(row.event_id).or_default().push(row);
    }
    let mut event_prefs: HashMap<(Uuid, Uuid), Option<i32>> = HashMap::new();
    for row in calendar_event_reminders::Entity::find()
        .filter(calendar_event_reminders::Column::EventId.is_in(event_ids))
        .all(&state.db)
        .await?
    {
        event_prefs.insert((row.user_id, row.event_id), row.minutes);
    }
    let mut calendar_prefs: HashMap<(Uuid, Uuid), Option<i32>> = HashMap::new();
    for row in calendar_reminder_prefs::Entity::find()
        .filter(calendar_reminder_prefs::Column::CalendarId.is_in(calendar_ids))
        .all(&state.db)
        .await?
    {
        calendar_prefs.insert((row.user_id, row.calendar_id), row.minutes);
    }
    let mut audiences: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for calendar in calendars.values() {
        audiences.insert(calendar.id, authz::audience(&state.db, calendar).await?);
    }
    // An event with attendees reminds its organiser and its attendees who still may be invited,
    // and only them; each one's answer for a date decides that date.
    let invited = Invited::load(&state.db, &events, &calendars, &audiences).await?;
    let people: Vec<Uuid> = audiences
        .values()
        .flatten()
        .copied()
        .chain(invited.people())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let readers: HashMap<Uuid, users::Model> = users::Entity::find()
        .filter(users::Column::Id.is_in(people))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|u| (u.id, u))
        .collect();

    let mut due: Vec<(Uuid, Uuid, OffsetDateTime)> = Vec::new();
    for event in &events {
        let Some(calendar) = calendars.get(&event.calendar_id) else {
            continue;
        };
        let rows = by_event.remove(&event.id).unwrap_or_default();
        let inputs = exception_inputs(&rows);
        let occurrences = recurrence::expand(&series_of(event, &inputs), from, to)?;
        if occurrences.is_empty() {
            continue;
        }
        let audience: Vec<Uuid> = match invited.audience(event.id) {
            Some(people) => people.to_vec(),
            None => audiences.get(&calendar.id).cloned().unwrap_or_default(),
        };
        for person in &audience {
            let Some(minutes) = effective_minutes(
                event_prefs.get(&(*person, event.id)).copied(),
                calendar_prefs.get(&(*person, calendar.id)).copied(),
                calendar.default_reminder_minutes,
                event.all_day,
            ) else {
                continue;
            };
            let zone = reader_time_zone(readers.get(person));
            for occurrence in &occurrences {
                if invited.declined(event.id, *person, occurrence.recurrence_id) {
                    continue;
                }
                let Some(at) = due_at(&occurrence.when, minutes, &zone) else {
                    continue;
                };
                if at <= now && now - at <= LATE_LIMIT {
                    due.push((*person, event.id, occurrence_key(&occurrence.when)));
                }
            }
        }
    }

    let mut report = SweepReport::default();
    let mut created: Vec<notifications::Model> = Vec::new();
    for (person, event_id, occurrence) in due {
        let txn = state.db.begin().await?;
        let claimed = txn
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO calendar_reminder_deliveries (user_id, event_id, occurrence_start, sent_at) \
                 VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
                [person.into(), event_id.into(), occurrence.into(), now.into()],
            ))
            .await?
            .rows_affected();
        if claimed == 0 {
            txn.rollback().await?;
            continue;
        }
        let row = notifications::ActiveModel {
            id: sea_orm::ActiveValue::Set(Uuid::new_v4()),
            user_id: sea_orm::ActiveValue::Set(person),
            kind: sea_orm::ActiveValue::Set("calendar_reminder".to_owned()),
            conversation_id: sea_orm::ActiveValue::Set(None),
            message_id: sea_orm::ActiveValue::Set(None),
            event_id: sea_orm::ActiveValue::Set(Some(event_id)),
            occurrence_start: sea_orm::ActiveValue::Set(Some(occurrence)),
            payload: sea_orm::ActiveValue::Set(None),
            actor_id: sea_orm::ActiveValue::Set(None),
            created_at: sea_orm::ActiveValue::Set(now),
            read_at: sea_orm::ActiveValue::Set(None),
            // The reminder's own mail is decided below: the unread digest never takes it.
            email_handled_at: sea_orm::ActiveValue::Set(Some(now)),
        };
        let row = sea_orm::ActiveModelTrait::insert(row, &txn).await?;
        txn.commit().await?;
        report.notified.push((person, event_id, occurrence));
        created.push(row);
    }
    if created.is_empty() {
        return Ok(report);
    }

    crate::notify::push::dispatch(state, &created);
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
        if should_mail(online, &user_prefs, reader.manual_presence.as_deref(), now) {
            report.mailed.push(person);
            send_mail(state, reader, &dto, now).await;
        }
    }
    Ok(report)
}

/// Send one reminder mail, when the instance can. A mail that fails is logged; the app has the
/// reminder anyway.
async fn send_mail(
    state: &AppState,
    reader: &users::Model,
    dto: &NotificationDto,
    now: OffsetDateTime,
) {
    if !state.mailer.can_send() {
        return;
    }
    let locale = Locale::parse(reader.locale.as_deref());
    let zone = reader_time_zone(Some(reader));
    let words = texts(locale, dto, now, &zone);
    let email = mail_text::calendar_reminder(
        locale,
        &words.lead,
        dto.event_title.as_deref().unwrap_or_default(),
        &words.when,
        dto.event_location.as_deref(),
        &state.mailer.base_url,
        &state.mailer.instance_name(),
    );
    if let Err(error) = state.mailer.send(&reader.email, &email).await {
        tracing::warn!(%error, "could not send a calendar reminder by mail");
    }
}

/// A reminder in words, for a push and a mail.
pub struct ReminderTexts {
    /// "Dans 10 min".
    pub lead: String,
    /// "Dans 10 min : Point équipe".
    pub title: String,
    /// "07/10 09:00", or "07/10" for an all-day event.
    pub when: String,
    /// "09:00 · Salle Ouest": the time (with the date when it is not today) and the place.
    pub body: String,
}

/// Word a reminder for its reader, in their language and time zone.
pub fn texts(
    locale: Locale,
    dto: &NotificationDto,
    now: OffsetDateTime,
    zone: &str,
) -> ReminderTexts {
    let title = dto.event_title.clone().unwrap_or_default();
    let place = dto
        .event_location
        .as_deref()
        .map(|l| format!(" · {l}"))
        .unwrap_or_default();
    let today = recurrence::local_parts(now, zone).map(|(date, _, _)| date);
    let (lead, when, time_part) = match dto.event_start.as_deref().and_then(RecurrenceId::from_key)
    {
        Some(RecurrenceId::Instant(start)) => {
            // Rounded up: the sweep runs some seconds after the reminder fell due.
            let minutes = ((start - now).whole_seconds() + 59).div_euclid(60);
            let lead = mail_text::reminder_lead(locale, minutes, ReminderDay::Timed);
            match recurrence::local_parts(start, zone) {
                Some((date, hour, minute)) => {
                    let clock = format!("{hour:02}:{minute:02}");
                    let day = mail_text::short_date(locale, date);
                    let shown = if Some(date) == today {
                        clock.clone()
                    } else {
                        format!("{day} {clock}")
                    };
                    (lead, format!("{day} {clock}"), shown)
                }
                None => (lead, String::new(), String::new()),
            }
        }
        Some(RecurrenceId::Date(date)) => {
            let day = if Some(date) == today {
                ReminderDay::Today
            } else {
                ReminderDay::Tomorrow
            };
            let shown = mail_text::short_date(locale, date);
            (
                mail_text::reminder_lead(locale, 0, day),
                shown.clone(),
                shown,
            )
        }
        None => (String::new(), String::new(), String::new()),
    };
    ReminderTexts {
        title: mail_text::reminder_title(locale, &lead, &title),
        lead,
        when,
        body: format!("{time_part}{place}")
            .trim_start_matches(" · ")
            .to_owned(),
    }
}

/// Draw reminder notifications: their event, the occurrence (as changed, if it was), where it is.
pub async fn hydrate<C: ConnectionTrait>(
    db: &C,
    rows: Vec<notifications::Model>,
) -> Result<Vec<NotificationDto>, CalendarError> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let event_ids: Vec<Uuid> = rows.iter().filter_map(|r| r.event_id).collect();
    let events: HashMap<Uuid, calendar_events::Model> = calendar_events::Entity::find()
        .filter(calendar_events::Column::Id.is_in(event_ids.clone()))
        .all(db)
        .await?
        .into_iter()
        .map(|e| (e.id, e))
        .collect();
    let calendars: HashMap<Uuid, calendars::Model> = calendars::Entity::find()
        .filter(calendars::Column::Id.is_in(events.values().map(|e| e.calendar_id)))
        .all(db)
        .await?
        .into_iter()
        .map(|c| (c.id, c))
        .collect();
    let space_names: HashMap<Uuid, String> = spaces::Entity::find()
        .filter(spaces::Column::Id.is_in(calendars.values().filter_map(|c| c.space_id)))
        .all(db)
        .await?
        .into_iter()
        .map(|s| (s.id, s.name))
        .collect();
    let mut changed: HashMap<(Uuid, String), exceptions::Model> = HashMap::new();
    for row in exceptions::Entity::find()
        .filter(exceptions::Column::EventId.is_in(event_ids))
        .all(db)
        .await?
    {
        changed.insert((row.event_id, row.recurrence_id.clone()), row);
    }

    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let event = events.get(&row.event_id?)?;
            let calendar = calendars.get(&event.calendar_id);
            let occurrence = row.occurrence_start?;
            let id = if event.all_day {
                RecurrenceId::Date(occurrence.date())
            } else {
                RecurrenceId::Instant(occurrence)
            };
            // The log keeps the occurrence's start as it happens: for a moved occurrence that is
            // its new start, so the exception is also looked for by where it moved to.
            let moved_here = |e: &&exceptions::Model| {
                e.event_id == event.id
                    && !e.cancelled
                    && (e.start_at == Some(occurrence)
                        || (event.all_day && e.start_date == Some(occurrence.date())))
            };
            let exception = changed
                .get(&(event.id, id.to_key()))
                .or_else(|| changed.values().find(moved_here));
            let id = exception
                .and_then(|e| RecurrenceId::from_key(&e.recurrence_id))
                .unwrap_or(id);
            let start = match (
                exception.and_then(|e| e.start_at),
                exception.and_then(|e| e.start_date),
                id,
            ) {
                (Some(moved), _, _) => instant_text(moved),
                (_, Some(moved), _) => date_text(moved),
                (_, _, RecurrenceId::Instant(at)) => instant_text(at),
                (_, _, RecurrenceId::Date(day)) => date_text(day),
            };
            let space_id = calendar.and_then(|c| c.space_id);
            Some(NotificationDto {
                id: row.id,
                kind: row.kind,
                conversation_id: None,
                space_id,
                channel_name: None,
                space_name: space_id
                    .and_then(|s| space_names.get(&s).cloned())
                    .unwrap_or_default(),
                message_id: None,
                actor_id: None,
                actor_name: None,
                preview: String::new(),
                created_at: instant_text(row.created_at),
                read: row.read_at.is_some(),
                event_id: Some(event.id),
                recurrence_id: event.rrule.as_ref().map(|_| id.to_key()),
                event_title: Some(
                    exception
                        .and_then(|e| e.title.clone())
                        .unwrap_or_else(|| event.title.clone()),
                ),
                event_start: Some(start),
                event_all_day: Some(event.all_day),
                event_location: match exception {
                    Some(e) => e.location.clone(),
                    None => event.location.clone(),
                },
                calendar_name: calendar.map(|c| c.name.clone()),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reminder_is_mailed_only_to_whom_it_may_reach() {
        let now = OffsetDateTime::from_unix_timestamp(1_790_000_000).unwrap();
        let prefs = NotificationPrefs::default();
        assert!(should_mail(false, &prefs, None, now));
        // Connected: the app has already told them.
        assert!(!should_mail(true, &prefs, None, now));
        // Do not disturb.
        assert!(!should_mail(false, &prefs, Some("dnd"), now));
        // Quiet hours around the clock.
        let quiet = NotificationPrefs {
            quiet_hours: true,
            quiet_from: "00:00".to_owned(),
            quiet_to: "23:59".to_owned(),
            ..NotificationPrefs::default()
        };
        assert!(!should_mail(false, &quiet, None, now));
        // Turned off by mail.
        let no_mail = NotificationPrefs {
            email_calendar_reminders: false,
            ..NotificationPrefs::default()
        };
        assert!(!should_mail(false, &no_mail, None, now));
    }

    #[test]
    fn the_most_specific_choice_wins() {
        // Nothing chosen: the calendar's default.
        assert_eq!(effective_minutes(None, None, Some(10), false), Some(10));
        // The person's calendar setting over the default, including "none".
        assert_eq!(
            effective_minutes(None, Some(Some(30)), Some(10), false),
            Some(30)
        );
        assert_eq!(effective_minutes(None, Some(None), Some(10), false), None);
        // The person's event setting over everything.
        assert_eq!(
            effective_minutes(Some(Some(60)), Some(Some(30)), Some(10), false),
            Some(60)
        );
        assert_eq!(
            effective_minutes(Some(None), Some(Some(30)), Some(10), false),
            None
        );
        // A calendar without a default reminds nobody who did not ask.
        assert_eq!(effective_minutes(None, None, None, false), None);
    }

    #[test]
    fn an_all_day_event_reminds_only_who_asked() {
        assert_eq!(effective_minutes(None, None, Some(10), true), None);
        assert_eq!(
            effective_minutes(None, Some(Some(30)), Some(10), true),
            None
        );
        assert_eq!(
            effective_minutes(Some(Some(420)), None, Some(10), true),
            Some(420)
        );
        assert_eq!(
            effective_minutes(Some(Some(-540)), None, None, true),
            Some(-540)
        );
    }

    #[test]
    fn the_lead_counts_whole_minutes_from_a_sweep_a_little_late() {
        let start = OffsetDateTime::from_unix_timestamp(1_790_000_000).unwrap();
        let dto = NotificationDto {
            id: Uuid::nil(),
            kind: "calendar_reminder".to_owned(),
            conversation_id: None,
            space_id: None,
            channel_name: None,
            space_name: String::new(),
            message_id: None,
            actor_id: None,
            actor_name: None,
            preview: String::new(),
            created_at: String::new(),
            read: false,
            event_id: Some(Uuid::nil()),
            recurrence_id: None,
            event_title: Some("Point".to_owned()),
            event_start: Some(instant_text(start)),
            event_all_day: Some(false),
            event_location: None,
            calendar_name: None,
        };
        // Due ten minutes before; the sweep runs 30 seconds after that.
        let now = start - Duration::minutes(10) + Duration::seconds(30);
        let words = texts(Locale::En, &dto, now, "Europe/Paris");
        assert_eq!(words.lead, "In 10 min");
        let a_day = texts(
            Locale::En,
            &dto,
            start - Duration::days(1) + Duration::seconds(40),
            "Europe/Paris",
        );
        assert_eq!(a_day.lead, "Tomorrow");
    }
}
