//! The email fallback: what is still unread after a while goes out as one digest per person.
//!
//! The one channel that reaches someone with no Ruchoir page open and no push subscription, and the
//! one that goes through no service the instance did not choose: its own mail relay. It is meant as
//! a catch-up, not as a second notification stream, so:
//!
//! - it waits ([`crate::config::Config::notify_email_delay_secs`], fifteen minutes by default), which
//!   leaves the time to read the notification in the app or on a phone first;
//! - it skips anyone who is connected right now: they have the app open, and the app has already
//!   told them;
//! - it sends one message per person per sweep, listing what is waiting, rather than one per
//!   notification;
//! - it follows the same preferences as everything else ([`super::prefs::allows`]), plus its own
//!   switch, and holds back during quiet hours and "do not disturb" instead of dropping the
//!   notifications: they go out once the window closes, if still unread.
//!
//! Every row is decided exactly once (`notifications.email_handled_at`), and the rows being decided
//! are locked with `SKIP LOCKED`, so two API processes sweeping at the same moment never email the
//! same notification twice.

use std::collections::BTreeMap;
use std::time::Duration;

use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, DatabaseBackend, DatabaseTransaction, EntityTrait, QueryFilter, Statement,
    TransactionTrait,
};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::mail_text::{self, DigestItem, Locale};
use crate::entities::{notifications, users};
use crate::messaging::error::ApiError;
use crate::state::AppState;

use super::prefs;

/// How often the sweep runs.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

/// Past this age a notification is never emailed: a day-old mention belongs to the inbox.
const MAX_AGE_SECS: i64 = 24 * 60 * 60;

/// How many notifications one sweep considers. The rest wait for the next one, a minute later.
const BATCH: u64 = 500;

/// How many lines a digest lists before summing up the rest.
const LISTED: usize = 8;

/// Start the periodic sweep, when this instance can deliver mail and the fallback is not turned off.
pub fn spawn(state: AppState) {
    if !state.mailer.can_send() {
        tracing::info!("no mail relay: the unread-notification email fallback is off");
        return;
    }
    if state.config.notify_email_delay_secs <= 0 {
        tracing::info!("RUCHOIR_NOTIFY_EMAIL_DELAY_SECS is 0: the email fallback is off");
        return;
    }
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            match sweep(&state, OffsetDateTime::now_utc()).await {
                Ok(0) => {}
                Ok(sent) => tracing::info!(sent, "sent unread-notification digests"),
                Err(error) => tracing::warn!(?error, "unread-notification sweep failed"),
            }
        }
    });
}

/// Mark rows as decided, whatever the decision was.
async fn mark_handled(
    txn: &DatabaseTransaction,
    ids: Vec<Uuid>,
    now: OffsetDateTime,
) -> Result<(), ApiError> {
    if ids.is_empty() {
        return Ok(());
    }
    notifications::Entity::update_many()
        .col_expr(notifications::Column::EmailHandledAt, Expr::value(now))
        .filter(notifications::Column::Id.is_in(ids))
        .exec(txn)
        .await?;
    Ok(())
}

/// Run one sweep as of `now`, returning how many digests were sent.
pub async fn sweep(state: &AppState, now: OffsetDateTime) -> Result<usize, ApiError> {
    let delay = time::Duration::seconds(state.config.notify_email_delay_secs.max(0));
    let too_old = now - time::Duration::seconds(MAX_AGE_SECS);

    // What can no longer be emailed is settled first, in bulk: read in the meantime, or too old.
    // That keeps the pending index the size of the real backlog.
    notifications::Entity::update_many()
        .col_expr(notifications::Column::EmailHandledAt, Expr::value(now))
        .filter(notifications::Column::EmailHandledAt.is_null())
        .filter(
            sea_orm::Condition::any()
                .add(notifications::Column::ReadAt.is_not_null())
                .add(notifications::Column::CreatedAt.lt(too_old)),
        )
        .exec(&state.db)
        .await?;

    let txn = state.db.begin().await?;
    let rows = notifications::Entity::find()
        .from_raw_sql(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT * FROM notifications \
             WHERE email_handled_at IS NULL AND read_at IS NULL AND created_at <= $1 \
             ORDER BY created_at \
             LIMIT $2 \
             FOR UPDATE SKIP LOCKED",
            [(now - delay).into(), (BATCH as i64).into()],
        ))
        .all(&txn)
        .await?;

    // Ordered by user so a run is deterministic, and newest first within one person's digest.
    let mut by_user: BTreeMap<Uuid, Vec<notifications::Model>> = BTreeMap::new();
    for row in rows {
        by_user.entry(row.user_id).or_default().push(row);
    }

    let mut sent = 0;
    for (user_id, mut rows) in by_user {
        rows.sort_by_key(|row| std::cmp::Reverse(row.created_at));
        let ids: Vec<Uuid> = rows.iter().map(|row| row.id).collect();

        let user = users::Entity::find_by_id(user_id).one(&txn).await?;
        let Some(user) = user.filter(|user| user.status == "active" && !user.is_bot) else {
            mark_handled(&txn, ids, now).await?;
            continue;
        };
        let user_prefs = prefs::load(&txn, user_id).await?;
        if !user_prefs.enabled || !user_prefs.email {
            mark_handled(&txn, ids, now).await?;
            continue;
        }
        // Not now, but not never: left undecided, they go out once the window closes.
        if !prefs::may_interrupt(&user_prefs, user.manual_presence.as_deref(), now) {
            continue;
        }
        // Connected somewhere: the app has shown them already, and an email on top would be noise.
        if crate::realtime::presence::is_online(state.hub.valkey(), user_id).await {
            mark_handled(&txn, ids, now).await?;
            continue;
        }

        let conversation_ids: Vec<Uuid> =
            rows.iter().filter_map(|row| row.conversation_id).collect();
        let conversation_prefs = prefs::scopes(&txn, user_id, &conversation_ids).await?;
        let wanted: Vec<notifications::Model> = rows
            .into_iter()
            .filter(|row| {
                prefs::allows(
                    &row.kind,
                    &user_prefs,
                    row.conversation_id
                        .and_then(|id| conversation_prefs.get(&id)),
                    prefs::Delivery::Email,
                )
            })
            .collect();
        if wanted.is_empty() {
            mark_handled(&txn, ids, now).await?;
            continue;
        }

        let total = wanted.len();
        let locale = Locale::parse(user.locale.as_deref());
        let listed = crate::messaging::notifications::hydrate(
            &txn,
            wanted.into_iter().take(LISTED).collect(),
        )
        .await?;
        let items = listed
            .into_iter()
            .map(|dto| {
                let actor = dto
                    .actor_name
                    .clone()
                    .unwrap_or_else(|| mail_text::someone(locale).to_owned());
                let verb = mail_text::notification_verb(locale, &dto.kind);
                let headline = match &dto.channel_name {
                    Some(channel) => format!("{actor} {verb} · #{channel}"),
                    None => format!("{actor} {verb}"),
                };
                DigestItem {
                    headline,
                    excerpt: dto.preview,
                }
            })
            .collect();
        let link = format!("{}/", state.mailer.base_url.trim_end_matches('/'));
        let email =
            mail_text::unread_digest(locale, items, total, &link, &state.mailer.instance_name());
        match state.mailer.send(&user.email, &email).await {
            Ok(()) => {
                mark_handled(&txn, ids, now).await?;
                sent += 1;
            }
            // Left undecided: the next sweep tries again, until the rows age out of the window.
            Err(error) => {
                tracing::warn!(%error, user = %user_id, "could not send an unread digest")
            }
        }
    }
    txn.commit().await?;
    Ok(sent)
}
