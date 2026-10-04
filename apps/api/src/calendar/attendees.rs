//! Invitations: who may be invited to an event, who is, what they answered, and what an invitation
//! lets its invitee see.
//!
//! - **Who may be invited.** To an event of a space's calendar: the space's members who see its
//!   calendars (`member`, `admin`, `owner`). To an event of a personal calendar: anyone who shares a
//!   space with its organiser. And anyone by email address; an address that is a member who may be
//!   invited becomes that member.
//! - **Who changes the list**: whoever may write in the event's calendar. The list belongs to the
//!   series, whatever part of it a change is made to.
//! - **Answers** are the attendee's own: for the series, or for one date of it, which wins there.
//!   Answering for the series again clears the dates' own answers.
//! - **What an invitation shows.** An invitee who does not see the event's calendar (someone's
//!   personal one) sees the event anyway, read only, as long as they still share a space with its
//!   owner. A space calendar's event is seen through the space, as before.
//!
//! The organiser is the event's author. They are not on the list and count as going.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::Json;
use sea_orm::sea_query::{Expr, ExprTrait, Func};
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};
use utoipa::ToSchema;
use uuid::Uuid;

use super::authz::{self, CalendarAccess};
use super::error::CalendarError;
use super::recurrence::RecurrenceId;
use crate::auth::extract::AuthSession;
use crate::entities::{
    calendar_attendee_overrides as overrides, calendar_event_attendees as attendees,
    calendar_events, calendars, space_members, users,
};
use crate::state::AppState;

/// The most attendees one event may have.
pub const MAX_ATTENDEES: usize = 100;

/// How many people the invitee search offers at once.
const SEARCH_LIMIT: u64 = 20;

/// Roles that may be invited to a space calendar's events: those who see the space's calendars.
const INVITABLE_ROLES: [&str; 3] = ["member", "admin", "owner"];

/// An answer.
pub const NEEDS_ACTION: &str = "needs_action";
pub const ACCEPTED: &str = "accepted";
pub const TENTATIVE: &str = "tentative";
pub const DECLINED: &str = "declined";

/// The answers someone may give (waiting is not one).
pub fn is_answer(status: &str) -> bool {
    matches!(status, ACCEPTED | TENTATIVE | DECLINED)
}

/// One person on the list, as the form sends it: an account, or an address (with a name to show).
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct AttendeeInput {
    pub user_id: Option<Uuid>,
    pub email: Option<String>,
    pub name: Option<String>,
}

/// One person on the list, and their answer for the series.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AttendeeDto {
    pub id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<Uuid>,
    /// For someone invited by address only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub name: String,
    /// `needs_action`, `accepted`, `tentative` or `declined`.
    pub status: String,
}

/// Who organises an event: its author.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct OrganizerDto {
    pub user_id: Uuid,
    pub name: String,
}

/// Someone who may be invited, as the search offers them.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct InviteeDto {
    pub user_id: Uuid,
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct InviteeQuery {
    #[serde(default)]
    pub q: String,
}

/// An answer, for the series or for one date of it.
#[derive(Debug, Deserialize, ToSchema)]
pub struct ResponseInput {
    /// `accepted`, `tentative` or `declined`.
    pub status: String,
    /// One occurrence of a series; the whole series when absent.
    pub recurrence_id: Option<String>,
}

// --- Who may be invited ---------------------------------------------------------------------------

/// The spaces someone belongs to, whatever their role.
async fn spaces_of<C: ConnectionTrait>(db: &C, user: Uuid) -> Result<Vec<Uuid>, CalendarError> {
    Ok(space_members::Entity::find()
        .filter(space_members::Column::UserId.eq(user))
        .all(db)
        .await?
        .into_iter()
        .map(|m| m.space_id)
        .collect())
}

/// Among `candidates`, those who may be invited to an event of `calendar` organised by
/// `organizer`. The organiser is never one of them.
pub async fn invitable<C: ConnectionTrait>(
    db: &C,
    calendar: &calendars::Model,
    organizer: Uuid,
    candidates: &[Uuid],
) -> Result<HashSet<Uuid>, CalendarError> {
    if candidates.is_empty() {
        return Ok(HashSet::new());
    }
    let members = space_members::Entity::find()
        .filter(space_members::Column::UserId.is_in(candidates.iter().copied()));
    let members = match calendar.space_id {
        Some(space_id) => {
            members
                .filter(space_members::Column::SpaceId.eq(space_id))
                .filter(space_members::Column::Role.is_in(INVITABLE_ROLES))
                .all(db)
                .await?
        }
        None => {
            let owner = calendar.owner_user_id.unwrap_or(organizer);
            members
                .filter(space_members::Column::SpaceId.is_in(spaces_of(db, owner).await?))
                .all(db)
                .await?
        }
    };
    Ok(members
        .into_iter()
        .map(|m| m.user_id)
        .filter(|u| *u != organizer)
        .collect())
}

/// `GET /api/v1/calendars/{calendar_id}/invitees?q=`: who may be invited to an event of this
/// calendar, matching `q` (a name or an address), for whoever may write in it.
#[utoipa::path(
    get,
    path = "/api/v1/calendars/{calendar_id}/invitees",
    tag = "calendar",
    params(
        ("calendar_id" = Uuid, Path, description = "Calendar id"),
        ("q" = Option<String>, Query, description = "Part of a name or an address")
    ),
    responses(
        (status = 200, description = "Up to twenty people, by name", body = [InviteeDto]),
        (status = 403, description = "May not write in this calendar"),
        (status = 404, description = "No such calendar for the caller")
    )
)]
pub async fn search_invitees(
    State(state): State<AppState>,
    session: AuthSession,
    Path(calendar_id): Path<Uuid>,
    Query(query): Query<InviteeQuery>,
) -> Result<Json<Vec<InviteeDto>>, CalendarError> {
    let access = authz::access(&state.db, session.user_id, calendar_id).await?;
    if !access.can_write_events {
        return Err(CalendarError::Forbidden);
    }
    let calendar = &access.calendar;
    let pool = match calendar.space_id {
        Some(space_id) => {
            space_members::Entity::find()
                .filter(space_members::Column::SpaceId.eq(space_id))
                .filter(space_members::Column::Role.is_in(INVITABLE_ROLES))
                .all(&state.db)
                .await?
        }
        None => {
            let owner = calendar.owner_user_id.unwrap_or(session.user_id);
            space_members::Entity::find()
                .filter(space_members::Column::SpaceId.is_in(spaces_of(&state.db, owner).await?))
                .all(&state.db)
                .await?
        }
    };
    let ids: HashSet<Uuid> = pool
        .into_iter()
        .map(|m| m.user_id)
        .filter(|u| *u != session.user_id)
        .collect();
    let needle = format!(
        "%{}%",
        query.q.trim().to_lowercase().replace(['%', '_'], "")
    );
    let people = users::Entity::find()
        .filter(users::Column::Id.is_in(ids))
        .filter(users::Column::IsBot.eq(false))
        .filter(
            sea_orm::Condition::any()
                .add(Expr::expr(Func::lower(Expr::col(users::Column::DisplayName))).like(&needle))
                .add(Expr::expr(Func::lower(Expr::col(users::Column::Email))).like(&needle)),
        )
        .order_by_asc(users::Column::DisplayName)
        .limit(SEARCH_LIMIT)
        .all(&state.db)
        .await?;
    Ok(Json(
        people
            .into_iter()
            .map(|u| InviteeDto {
                user_id: u.id,
                name: u.display_name,
            })
            .collect(),
    ))
}

// --- The list -------------------------------------------------------------------------------------

/// An event's attendees, in the order they were invited.
pub async fn list<C: ConnectionTrait>(
    db: &C,
    event_id: Uuid,
) -> Result<Vec<attendees::Model>, CalendarError> {
    Ok(attendees::Entity::find()
        .filter(attendees::Column::EventId.eq(event_id))
        .order_by_asc(attendees::Column::InvitedAt)
        .order_by_asc(attendees::Column::Id)
        .all(db)
        .await?)
}

/// What a change to the list did: who was added, who was taken off.
#[derive(Debug, Default)]
pub struct Change {
    pub added: Vec<attendees::Model>,
    pub removed: Vec<attendees::Model>,
}

/// A wanted attendee, once read.
enum Wanted {
    Member(Uuid),
    Address { email: String, name: Option<String> },
}

fn clean_email(raw: &str) -> Result<String, CalendarError> {
    let email = raw.trim();
    let valid = email.len() >= 3
        && email.len() <= 320
        && !email.chars().any(char::is_whitespace)
        && email
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.'));
    if valid {
        Ok(email.to_owned())
    } else {
        Err(CalendarError::Invalid(
            "An attendee's address is not valid.",
        ))
    }
}

/// A fresh token for someone invited by address: the raw token (for the link), its digest (to
/// find them) and the token encrypted with the server's key (to send the same link again).
pub fn new_token(key: &[u8; 32]) -> Result<(String, String, Vec<u8>, Vec<u8>), CalendarError> {
    let raw = crate::auth::tokens::generate_token().map_err(|_| CalendarError::Internal)?;
    let digest = crate::auth::tokens::digest(&raw);
    let (cipher, nonce) =
        crate::auth::crypto::encrypt(key, raw.as_bytes()).map_err(|_| CalendarError::Internal)?;
    Ok((raw, digest, cipher, nonce))
}

/// The token of someone invited by address, read back from its encrypted copy.
pub fn token_of(key: &[u8; 32], row: &attendees::Model) -> Option<String> {
    let (cipher, nonce) = (row.token_cipher.as_ref()?, row.token_nonce.as_ref()?);
    let plain = crate::auth::crypto::decrypt(key, cipher, nonce).ok()?;
    String::from_utf8(plain.to_vec()).ok()
}

async fn insert_row<C: ConnectionTrait>(
    db: &C,
    event_id: Uuid,
    wanted: &Wanted,
    status: &str,
    by: Option<Uuid>,
    key: &[u8; 32],
) -> Result<attendees::Model, CalendarError> {
    let mut row = attendees::ActiveModel {
        id: Set(Uuid::new_v4()),
        event_id: Set(event_id),
        status: Set(status.to_owned()),
        invited_by: Set(by),
        invited_at: Set(OffsetDateTime::now_utc()),
        responded_at: Set(None),
        ..Default::default()
    };
    match wanted {
        Wanted::Member(user) => {
            row.user_id = Set(Some(*user));
            row.email = Set(None);
            row.name = Set(None);
            row.token_digest = Set(None);
            row.token_cipher = Set(None);
            row.token_nonce = Set(None);
        }
        Wanted::Address { email, name } => {
            let (_, digest, cipher, nonce) = new_token(key)?;
            row.user_id = Set(None);
            row.email = Set(Some(email.clone()));
            row.name = Set(name.clone());
            row.token_digest = Set(Some(digest));
            row.token_cipher = Set(Some(cipher));
            row.token_nonce = Set(Some(nonce));
        }
    }
    Ok(row.insert(db).await?)
}

/// Make an event's list the one given: newcomers are added waiting for an answer, those still on it
/// keep theirs, the others are taken off. Refuses someone who may not be invited.
pub async fn replace<C: ConnectionTrait>(
    db: &C,
    event: &calendar_events::Model,
    calendar: &calendars::Model,
    by: Uuid,
    inputs: &[AttendeeInput],
    key: &[u8; 32],
) -> Result<Change, CalendarError> {
    if inputs.len() > MAX_ATTENDEES {
        return Err(CalendarError::Invalid(
            "An event has at most 100 attendees.",
        ));
    }
    let organizer = event.created_by.unwrap_or(by);

    // Read the list: accounts, and addresses (some of which are accounts).
    let mut members: Vec<Uuid> = Vec::new();
    let mut addresses: Vec<(String, Option<String>)> = Vec::new();
    for input in inputs {
        match (input.user_id, input.email.as_deref()) {
            (Some(user), _) => members.push(user),
            (None, Some(email)) => {
                let name = input
                    .name
                    .as_deref()
                    .map(str::trim)
                    .filter(|n| !n.is_empty())
                    .map(|n| n.chars().take(200).collect());
                addresses.push((clean_email(email)?, name));
            }
            (None, None) => {
                return Err(CalendarError::Invalid(
                    "An attendee is an account or an address.",
                ))
            }
        }
    }
    let lowered: Vec<String> = addresses.iter().map(|(e, _)| e.to_lowercase()).collect();
    let by_address: HashMap<String, Uuid> = if lowered.is_empty() {
        HashMap::new()
    } else {
        users::Entity::find()
            .filter(Expr::expr(Func::lower(Expr::col(users::Column::Email))).is_in(lowered))
            .all(db)
            .await?
            .into_iter()
            .map(|u| (u.email.to_lowercase(), u.id))
            .collect()
    };
    let candidates: Vec<Uuid> = members
        .iter()
        .copied()
        .chain(by_address.values().copied())
        .collect();
    let allowed = invitable(db, calendar, organizer, &candidates).await?;
    if members
        .iter()
        .any(|m| *m != organizer && !allowed.contains(m))
    {
        return Err(CalendarError::Invalid(
            "Someone on the list cannot be invited to this event.",
        ));
    }

    let mut wanted: Vec<Wanted> = Vec::new();
    let mut seen_members: HashSet<Uuid> = HashSet::new();
    let mut seen_addresses: HashSet<String> = HashSet::new();
    for user in members {
        if user != organizer && seen_members.insert(user) {
            wanted.push(Wanted::Member(user));
        }
    }
    for (email, name) in addresses {
        let lower = email.to_lowercase();
        match by_address.get(&lower) {
            Some(user) if *user == organizer => {}
            Some(user) if allowed.contains(user) => {
                if seen_members.insert(*user) {
                    wanted.push(Wanted::Member(*user));
                }
            }
            _ => {
                if seen_addresses.insert(lower) {
                    wanted.push(Wanted::Address { email, name });
                }
            }
        }
    }

    let existing = list(db, event.id).await?;
    let mut change = Change::default();
    let keep = |row: &attendees::Model| match (row.user_id, row.email.as_deref()) {
        (Some(user), _) => seen_members.contains(&user),
        (None, Some(email)) => seen_addresses.contains(&email.to_lowercase()),
        _ => false,
    };
    for row in &existing {
        if !keep(row) {
            attendees::Entity::delete_by_id(row.id).exec(db).await?;
            change.removed.push(row.clone());
        }
    }
    for item in &wanted {
        let present = existing.iter().any(|row| match item {
            Wanted::Member(user) => row.user_id == Some(*user),
            Wanted::Address { email, .. } => row
                .email
                .as_deref()
                .is_some_and(|e| e.eq_ignore_ascii_case(email)),
        });
        if !present {
            change
                .added
                .push(insert_row(db, event.id, item, NEEDS_ACTION, Some(by), key).await?);
        }
    }
    Ok(change)
}

/// Shift a recurrence key by `shift` (a series that moved), or `None` when it names nothing.
fn shifted_key(key: &str, shift: Duration) -> Option<String> {
    Some(match RecurrenceId::from_key(key)? {
        RecurrenceId::Instant(at) => RecurrenceId::Instant(at + shift).to_key(),
        RecurrenceId::Date(day) => RecurrenceId::Date(day + shift).to_key(),
    })
}

/// "This and the following ones" made a new series from `from` at `at`: the attendees and their
/// answers go with it, and so do the answers for its dates (moved by `shift` with the series).
pub async fn copy_to<C: ConnectionTrait>(
    db: &C,
    from: Uuid,
    to: Uuid,
    at: &RecurrenceId,
    shift: Duration,
    key: &[u8; 32],
) -> Result<Vec<attendees::Model>, CalendarError> {
    let mut copied = Vec::new();
    for row in list(db, from).await? {
        let wanted = match (row.user_id, row.email.clone()) {
            (Some(user), _) => Wanted::Member(user),
            (None, Some(email)) => Wanted::Address {
                email,
                name: row.name.clone(),
            },
            _ => continue,
        };
        let mut new_row = insert_row(db, to, &wanted, &row.status, row.invited_by, key).await?;
        if row.responded_at.is_some() {
            let mut active: attendees::ActiveModel = new_row.clone().into();
            active.responded_at = Set(row.responded_at);
            new_row = active.update(db).await?;
        }
        for answer in overrides::Entity::find()
            .filter(overrides::Column::AttendeeId.eq(row.id))
            .all(db)
            .await?
        {
            let later = RecurrenceId::from_key(&answer.recurrence_id).is_some_and(|id| id >= *at);
            if let (true, Some(key)) = (later, shifted_key(&answer.recurrence_id, shift)) {
                overrides::ActiveModel {
                    attendee_id: Set(new_row.id),
                    recurrence_id: Set(key),
                    status: Set(answer.status),
                }
                .insert(db)
                .await?;
            }
        }
        copied.push(new_row);
    }
    Ok(copied)
}

/// The list as an event shows it, with each one's name.
pub async fn dtos<C: ConnectionTrait>(
    db: &C,
    rows: &[attendees::Model],
) -> Result<Vec<AttendeeDto>, CalendarError> {
    let names = names(db, rows.iter().filter_map(|r| r.user_id)).await?;
    Ok(rows
        .iter()
        .map(|row| AttendeeDto {
            id: row.id,
            user_id: row.user_id,
            email: row.user_id.is_none().then(|| row.email.clone()).flatten(),
            name: row
                .user_id
                .and_then(|u| names.get(&u).cloned())
                .or_else(|| row.name.clone())
                .or_else(|| row.email.clone())
                .unwrap_or_default(),
            status: row.status.clone(),
        })
        .collect())
}

/// People's display names, by id.
pub async fn names<C: ConnectionTrait>(
    db: &C,
    ids: impl IntoIterator<Item = Uuid>,
) -> Result<HashMap<Uuid, String>, CalendarError> {
    let ids: Vec<Uuid> = ids.into_iter().collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(users::Entity::find()
        .filter(users::Column::Id.is_in(ids))
        .all(db)
        .await?
        .into_iter()
        .map(|u| (u.id, u.display_name))
        .collect())
}

// --- One viewer's answers -------------------------------------------------------------------------

/// A viewer's place in some events: their answer for each series and its dates, and which of the
/// events have attendees at all.
#[derive(Debug, Default)]
pub struct Attendance {
    /// Event → (series answer, date answers by recurrence key).
    mine: HashMap<Uuid, (String, HashMap<String, String>)>,
    with_attendees: HashSet<Uuid>,
}

impl Attendance {
    pub async fn load<C: ConnectionTrait>(
        db: &C,
        user: Uuid,
        event_ids: &[Uuid],
    ) -> Result<Self, CalendarError> {
        if event_ids.is_empty() {
            return Ok(Self::default());
        }
        let rows = attendees::Entity::find()
            .filter(attendees::Column::EventId.is_in(event_ids.iter().copied()))
            .all(db)
            .await?;
        let with_attendees = rows.iter().map(|r| r.event_id).collect();
        let own: Vec<&attendees::Model> = rows.iter().filter(|r| r.user_id == Some(user)).collect();
        let mut dates: HashMap<Uuid, HashMap<String, String>> = HashMap::new();
        if !own.is_empty() {
            for answer in overrides::Entity::find()
                .filter(overrides::Column::AttendeeId.is_in(own.iter().map(|r| r.id)))
                .all(db)
                .await?
            {
                dates
                    .entry(answer.attendee_id)
                    .or_default()
                    .insert(answer.recurrence_id, answer.status);
            }
        }
        let mine = own
            .into_iter()
            .map(|r| {
                (
                    r.event_id,
                    (r.status.clone(), dates.remove(&r.id).unwrap_or_default()),
                )
            })
            .collect();
        Ok(Self {
            mine,
            with_attendees,
        })
    }

    pub fn has_attendees(&self, event_id: Uuid) -> bool {
        self.with_attendees.contains(&event_id)
    }

    /// The viewer's answer for one occurrence (`key`), or for the series when `key` is `None`.
    /// The organiser of an event with attendees is going; anyone else not on the list has none.
    pub fn status(
        &self,
        event: &calendar_events::Model,
        viewer: Uuid,
        key: Option<&str>,
    ) -> Option<String> {
        if let Some((series, dates)) = self.mine.get(&event.id) {
            let own = key.and_then(|k| dates.get(k));
            return Some(own.unwrap_or(series).clone());
        }
        (event.created_by == Some(viewer) && self.has_attendees(event.id))
            .then(|| ACCEPTED.to_owned())
    }
}

// --- What an invitation shows ---------------------------------------------------------------------

/// Whether `user` sees `event` through an invitation alone: they are on its list, its calendar is
/// someone's personal one they do not see, and they still share a space with its owner.
pub async fn invitation_access<C: ConnectionTrait>(
    db: &C,
    user: Uuid,
    event: &calendar_events::Model,
) -> Result<Option<CalendarAccess>, CalendarError> {
    let invited = attendees::Entity::find()
        .filter(attendees::Column::EventId.eq(event.id))
        .filter(attendees::Column::UserId.eq(user))
        .one(db)
        .await?
        .is_some();
    if !invited {
        return Ok(None);
    }
    let Some(calendar) = calendars::Entity::find_by_id(event.calendar_id)
        .one(db)
        .await?
    else {
        return Ok(None);
    };
    let Some(owner) = calendar.owner_user_id.filter(|o| *o != user) else {
        return Ok(None);
    };
    let shared = invitable(db, &calendar, owner, &[user]).await?;
    Ok(shared
        .contains(&user)
        .then(|| CalendarAccess::read_only(calendar)))
}

/// The events `user` sees through an invitation alone (see [`invitation_access`]), with that access.
pub async fn invited_events<C: ConnectionTrait>(
    db: &C,
    user: Uuid,
    seen: &HashSet<Uuid>,
) -> Result<Vec<(calendar_events::Model, CalendarAccess)>, CalendarError> {
    let event_ids: Vec<Uuid> = attendees::Entity::find()
        .filter(attendees::Column::UserId.eq(user))
        .all(db)
        .await?
        .into_iter()
        .map(|r| r.event_id)
        .collect();
    if event_ids.is_empty() {
        return Ok(Vec::new());
    }
    let events: Vec<calendar_events::Model> = calendar_events::Entity::find()
        .filter(calendar_events::Column::Id.is_in(event_ids))
        .all(db)
        .await?
        .into_iter()
        .filter(|e| !seen.contains(&e.calendar_id))
        .collect();
    let calendar_ids: HashSet<Uuid> = events.iter().map(|e| e.calendar_id).collect();
    let mine = spaces_of(db, user).await?;
    let mut granted: HashMap<Uuid, CalendarAccess> = HashMap::new();
    for calendar in calendars::Entity::find()
        .filter(calendars::Column::Id.is_in(calendar_ids))
        .all(db)
        .await?
    {
        let Some(owner) = calendar.owner_user_id.filter(|o| *o != user) else {
            continue;
        };
        let theirs = spaces_of(db, owner).await?;
        if mine.iter().any(|s| theirs.contains(s)) {
            granted.insert(calendar.id, CalendarAccess::read_only(calendar));
        }
    }
    Ok(events
        .into_iter()
        .filter_map(|e| granted.get(&e.calendar_id).cloned().map(|a| (e, a)))
        .collect())
}

/// An attendee's row for an account, if they are on the list.
pub async fn row_of<C: ConnectionTrait>(
    db: &C,
    event_id: Uuid,
    user: Uuid,
) -> Result<Option<attendees::Model>, CalendarError> {
    Ok(attendees::Entity::find()
        .filter(attendees::Column::EventId.eq(event_id))
        .filter(attendees::Column::UserId.eq(user))
        .one(db)
        .await?)
}

/// Record an answer: for the series (clearing the dates' own), or for one date.
pub async fn answer<C: ConnectionTrait>(
    db: &C,
    row: &attendees::Model,
    status: &str,
    date: Option<&RecurrenceId>,
) -> Result<(), CalendarError> {
    match date {
        Some(id) => {
            overrides::Entity::insert(overrides::ActiveModel {
                attendee_id: Set(row.id),
                recurrence_id: Set(id.to_key()),
                status: Set(status.to_owned()),
            })
            .on_conflict(
                sea_orm::sea_query::OnConflict::columns([
                    overrides::Column::AttendeeId,
                    overrides::Column::RecurrenceId,
                ])
                .update_column(overrides::Column::Status)
                .to_owned(),
            )
            .exec(db)
            .await?;
        }
        None => {
            let mut active: attendees::ActiveModel = row.clone().into();
            active.status = Set(status.to_owned());
            active.responded_at = Set(Some(OffsetDateTime::now_utc()));
            active.update(db).await?;
            overrides::Entity::delete_many()
                .filter(overrides::Column::AttendeeId.eq(row.id))
                .exec(db)
                .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_is_checked_but_kept_as_written() {
        assert_eq!(
            clean_email("  Client@Outside.test ").unwrap(),
            "Client@Outside.test"
        );
        for bad in ["", "client", "@outside.test", "client@outside", "a b@c.d"] {
            assert!(clean_email(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_date_answer_moves_with_its_series() {
        assert_eq!(
            shifted_key("2026-11-02T08:00:00Z", Duration::hours(1)).as_deref(),
            Some("2026-11-02T09:00:00Z")
        );
        assert_eq!(
            shifted_key("2026-11-02", Duration::days(1)).as_deref(),
            Some("2026-11-03")
        );
        assert_eq!(shifted_key("nonsense", Duration::ZERO), None);
    }

    #[test]
    fn only_three_answers_are_answers() {
        assert!(is_answer(ACCEPTED) && is_answer(TENTATIVE) && is_answer(DECLINED));
        assert!(!is_answer(NEEDS_ACTION) && !is_answer("maybe"));
    }
}
