//! Who sees and changes which calendar: the one place that answers it.
//!
//! - A personal calendar belongs to its owner alone.
//! - A space calendar is seen by the space's members of role `member`, `admin` and `owner`; a guest
//!   inherits nothing. Its events are written by everyone who sees it when its `write_access` is
//!   `members`, by `admin` and `owner` only when it is `admins`. The calendar itself (name, colour,
//!   settings, deletion) is managed by `admin` and `owner`.
//!
//! Visibility is computed from membership on every request, so leaving a space takes its calendars,
//! their subscription addresses and their reminders away at once, with nothing to clean up.
//!
//! Default calendars are created where they are first needed: a space's when the space is created
//! (and, for spaces that came another way, such as an import, the first time a member lists their
//! calendars), a person's the first time they list theirs. Both inserts tolerate a concurrent twin.
//! A space's default calendar carries the space's name, and follows it when the space is renamed
//! until someone names the calendar otherwise; a person's wears their theme's accent.

use std::collections::HashMap;

use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbBackend, EntityTrait, QueryFilter, Statement,
};
use uuid::Uuid;

use super::error::CalendarError;
use crate::entities::{calendars, space_members, users};

/// The colours a calendar may wear: the design system's pastels, or `accent`, which each viewer
/// sees in their own theme's accent.
pub const PALETTE: [&str; 8] = [
    "sky", "mint", "violet", "pink", "peach", "lime", "sun", "accent",
];

/// The order in which new space calendars take their colour: the least used among the creator's
/// spaces wins, ties going to the first here. Sky, the default accent, comes last so a space rarely
/// looks like the personal calendar.
const SPACE_COLOURS: [&str; 7] = ["mint", "violet", "peach", "lime", "sun", "pink", "sky"];

/// Roles that see a space's calendars.
const SEEING_ROLES: [&str; 3] = ["member", "admin", "owner"];

/// Roles that manage a space's calendars, and write in every one of them.
const MANAGING_ROLES: [&str; 2] = ["admin", "owner"];

/// A calendar the caller sees, and what they may do with it.
#[derive(Debug, Clone)]
pub struct CalendarAccess {
    pub calendar: calendars::Model,
    pub can_write_events: bool,
    pub can_manage: bool,
}

impl CalendarAccess {
    /// What an invitation alone grants: reading the event and answering, never changing it.
    pub fn read_only(calendar: calendars::Model) -> Self {
        Self {
            calendar,
            can_write_events: false,
            can_manage: false,
        }
    }

    fn new(calendar: calendars::Model, space_role: Option<String>) -> Self {
        let (can_write_events, can_manage) = match space_role.as_deref() {
            None => (true, true),
            Some(role) => {
                let manages = MANAGING_ROLES.contains(&role);
                (manages || calendar.write_access == "members", manages)
            }
        };
        Self {
            calendar,
            can_write_events,
            can_manage,
        }
    }
}

/// The name of a person's own calendar, in a language of the interface.
pub fn personal_name(locale: Option<&str>) -> &'static str {
    match locale {
        Some("fr") => "Personnel",
        Some("es") => "Personal",
        Some("de") => "Persönlich",
        Some("it") => "Personale",
        Some("pl") => "Osobisty",
        _ => "Personal",
    }
}

/// The calendar `calendar_id` as `user_id` may use it; `NotFound` when they cannot see it.
pub async fn access<C: ConnectionTrait>(
    db: &C,
    user_id: Uuid,
    calendar_id: Uuid,
) -> Result<CalendarAccess, CalendarError> {
    let calendar = calendars::Entity::find_by_id(calendar_id)
        .one(db)
        .await?
        .ok_or(CalendarError::NotFound)?;
    match (calendar.owner_user_id, calendar.space_id) {
        (Some(owner), _) if owner == user_id => Ok(CalendarAccess::new(calendar, None)),
        (None, Some(space_id)) => {
            let role = seeing_role(db, space_id, user_id)
                .await?
                .ok_or(CalendarError::NotFound)?;
            Ok(CalendarAccess::new(calendar, Some(role)))
        }
        _ => Err(CalendarError::NotFound),
    }
}

/// A calendar, whoever asks: for telling its audience something happened from outside (a guest
/// answering through a link).
pub async fn access_any<C: ConnectionTrait>(
    db: &C,
    calendar_id: Uuid,
) -> Result<calendars::Model, CalendarError> {
    calendars::Entity::find_by_id(calendar_id)
        .one(db)
        .await?
        .ok_or(CalendarError::NotFound)
}

/// Every calendar `user_id` sees: their own, then their spaces'. Creates the defaults that are
/// missing on the way.
pub async fn visible<C: ConnectionTrait>(
    db: &C,
    user_id: Uuid,
) -> Result<Vec<CalendarAccess>, CalendarError> {
    ensure_personal(db, user_id).await?;
    let roles: HashMap<Uuid, String> = space_members::Entity::find()
        .filter(space_members::Column::UserId.eq(user_id))
        .filter(space_members::Column::Role.is_in(SEEING_ROLES))
        .all(db)
        .await?
        .into_iter()
        .map(|m| (m.space_id, m.role))
        .collect();
    let space_ids: Vec<Uuid> = roles.keys().copied().collect();
    if !space_ids.is_empty() {
        let with_default: Vec<Uuid> = calendars::Entity::find()
            .filter(calendars::Column::SpaceId.is_in(space_ids.clone()))
            .filter(calendars::Column::IsDefault.eq(true))
            .all(db)
            .await?
            .into_iter()
            .filter_map(|c| c.space_id)
            .collect();
        for space_id in space_ids.iter().filter(|s| !with_default.contains(s)) {
            create_space_default(db, *space_id, None).await?;
        }
    }

    let rows = calendars::Entity::find()
        .filter(
            Condition::any()
                .add(calendars::Column::OwnerUserId.eq(user_id))
                .add(calendars::Column::SpaceId.is_in(space_ids)),
        )
        .all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|calendar| {
            let role = calendar.space_id.and_then(|s| roles.get(&s).cloned());
            CalendarAccess::new(calendar, role)
        })
        .collect())
}

/// Who is told about a calendar and reminded of its events: its owner, or its space's members who
/// see it.
pub async fn audience<C: ConnectionTrait>(
    db: &C,
    calendar: &calendars::Model,
) -> Result<Vec<Uuid>, CalendarError> {
    if let Some(owner) = calendar.owner_user_id {
        return Ok(vec![owner]);
    }
    let Some(space_id) = calendar.space_id else {
        return Ok(Vec::new());
    };
    Ok(space_members::Entity::find()
        .filter(space_members::Column::SpaceId.eq(space_id))
        .filter(space_members::Column::Role.is_in(SEEING_ROLES))
        .all(db)
        .await?
        .into_iter()
        .map(|m| m.user_id)
        .collect())
}

/// The caller's role in a space when it lets them see its calendars.
async fn seeing_role<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<Option<String>, CalendarError> {
    Ok(space_members::Entity::find_by_id((space_id, user_id))
        .one(db)
        .await?
        .map(|m| m.role)
        .filter(|role| SEEING_ROLES.contains(&role.as_str())))
}

/// A person's own calendar, created the first time it is needed, named in their language.
pub async fn ensure_personal<C: ConnectionTrait>(
    db: &C,
    user_id: Uuid,
) -> Result<calendars::Model, CalendarError> {
    let find = || {
        calendars::Entity::find()
            .filter(calendars::Column::OwnerUserId.eq(user_id))
            .filter(calendars::Column::IsDefault.eq(true))
    };
    if let Some(found) = find().one(db).await? {
        return Ok(found);
    }
    let locale = users::Entity::find_by_id(user_id)
        .one(db)
        .await?
        .and_then(|u| u.locale);
    let name = personal_name(locale.as_deref());
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO calendars (id, owner_user_id, name, color, default_reminder_minutes, \
                                is_default, created_by) \
         VALUES ($1, $2, $3, 'accent', 10, true, $2) \
         ON CONFLICT (owner_user_id) WHERE is_default AND owner_user_id IS NOT NULL DO NOTHING",
        [Uuid::new_v4().into(), user_id.into(), name.into()],
    ))
    .await?;
    find().one(db).await?.ok_or(CalendarError::Internal)
}

/// A space's first calendar, named after the space, in the colour its first owner (or
/// `created_by`) uses least among their spaces' calendars.
pub async fn create_space_default<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    created_by: Option<Uuid>,
) -> Result<(), CalendarError> {
    let owner = match created_by {
        Some(user) => Some(user),
        None => space_members::Entity::find()
            .filter(space_members::Column::SpaceId.eq(space_id))
            .filter(space_members::Column::Role.eq("owner"))
            .one(db)
            .await?
            .map(|m| m.user_id),
    };
    let colours = SPACE_COLOURS
        .iter()
        .map(|c| format!("'{c}'"))
        .collect::<Vec<_>>()
        .join(", ");
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        format!(
            "INSERT INTO calendars (id, space_id, name, color, write_access, \
                                    default_reminder_minutes, is_default, created_by) \
             SELECT $1, s.id, left(s.name, 200), \
                    (SELECT p.color FROM unnest(ARRAY[{colours}]) WITH ORDINALITY AS p (color, ord) \
                     ORDER BY (SELECT count(*) FROM calendars c \
                               JOIN space_members m ON m.space_id = c.space_id \
                               WHERE m.user_id = $3 AND c.color = p.color), p.ord \
                     LIMIT 1), \
                    'members', 10, true, $3 \
             FROM spaces s WHERE s.id = $2 \
             ON CONFLICT (space_id) WHERE is_default AND space_id IS NOT NULL DO NOTHING"
        ),
        [Uuid::new_v4().into(), space_id.into(), owner.into()],
    ))
    .await?;
    Ok(())
}

/// A space renamed from `old` to `new`: its default calendar takes the new name, unless someone
/// had named it otherwise. Returns the calendar when it changed, for its audience to be told.
pub async fn follow_space_name<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    old: &str,
    new: &str,
) -> Result<Option<calendars::Model>, CalendarError> {
    let Some(calendar) = calendars::Entity::find()
        .filter(calendars::Column::SpaceId.eq(space_id))
        .filter(calendars::Column::IsDefault.eq(true))
        .filter(calendars::Column::Name.eq(old))
        .one(db)
        .await?
    else {
        return Ok(None);
    };
    let mut active: calendars::ActiveModel = calendar.into();
    active.name = sea_orm::ActiveValue::Set(new.chars().take(200).collect());
    active.updated_at = sea_orm::ActiveValue::Set(time::OffsetDateTime::now_utc());
    Ok(Some(sea_orm::ActiveModelTrait::update(active, db).await?))
}
