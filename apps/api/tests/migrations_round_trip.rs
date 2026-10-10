//! Migration up/down round-trip against a real PostgreSQL database.
//!
//! This test is **destructive** (it drops and re-applies every table), so it never runs against the
//! ordinary dev database. It is skipped unless `RUCHOIR_TEST_DATABASE_URL` points at a throwaway
//! database dedicated to tests. In CI (no PostgreSQL service) the variable is unset and the test is
//! a no-op, keeping `cargo test` green. To run it locally:
//!
//! ```sh
//! docker compose up -d db
//! createdb -h localhost -U ruchoir ruchoir_test   # or any empty database
//! RUCHOIR_TEST_DATABASE_URL=postgres://ruchoir:ruchoir@localhost:5432/ruchoir_test \
//!   cargo test -p ruchoir-api --test migrations_round_trip -- --nocapture
//! ```

use ruchoir_migration::{Migrator, MigratorTrait};
use sea_orm::Database;

/// Both tests rebuild the same throwaway database: they take turns.
static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn migrations_apply_and_revert_cleanly() {
    let _turn = ONE_AT_A_TIME.lock().await;
    let Ok(url) = std::env::var("RUCHOIR_TEST_DATABASE_URL") else {
        eprintln!("skipping migrations_round_trip: RUCHOIR_TEST_DATABASE_URL not set");
        return;
    };

    let db = Database::connect(url)
        .await
        .expect("connect to the test database");

    // Start from a clean, fully-applied schema regardless of prior state.
    Migrator::fresh(&db).await.expect("fresh apply");

    // Full teardown then full re-apply: proves every `down` and every `up` is correct and that the
    // dependency ordering (foreign keys, shared primary keys) holds in both directions.
    Migrator::down(&db, None)
        .await
        .expect("revert all migrations");
    Migrator::up(&db, None)
        .await
        .expect("re-apply all migrations");

    // A second cycle confirms the round-trip is repeatable, not just correct once.
    Migrator::down(&db, None)
        .await
        .expect("revert all migrations again");
    Migrator::up(&db, None)
        .await
        .expect("re-apply all migrations again");
}

/// The calendar migration gives every space that already exists its default calendar, named in the
/// language of the space's owner.
#[tokio::test]
async fn existing_spaces_receive_a_default_calendar() {
    use sea_orm::{ConnectionTrait, DbBackend, Statement};
    let _turn = ONE_AT_A_TIME.lock().await;

    let Ok(url) = std::env::var("RUCHOIR_TEST_DATABASE_URL") else {
        eprintln!("skipping existing_spaces_receive_a_default_calendar: RUCHOIR_TEST_DATABASE_URL not set");
        return;
    };
    let db = Database::connect(url)
        .await
        .expect("connect to the test database");
    Migrator::fresh(&db).await.expect("fresh apply");
    // Step back to just before the calendar arrived, and fill the instance as it was then.
    let applied = Migrator::get_applied_migrations(&db)
        .await
        .expect("applied");
    let calendar_steps = applied
        .iter()
        .rev()
        .take_while(|m| m.name() != "m20261003_000003_file_stars")
        .count();
    Migrator::down(&db, Some(calendar_steps as u32))
        .await
        .expect("revert the calendar");

    let people = [
        (
            "00000000-0000-0000-0000-0000000000a1",
            "fr",
            "00000000-0000-0000-0000-0000000000b1",
        ),
        (
            "00000000-0000-0000-0000-0000000000a2",
            "de",
            "00000000-0000-0000-0000-0000000000b2",
        ),
        // No language chosen: English.
        (
            "00000000-0000-0000-0000-0000000000a3",
            "",
            "00000000-0000-0000-0000-0000000000b3",
        ),
    ];
    for (age, (user, locale, space)) in people.into_iter().enumerate() {
        // The oldest space first, for the colours to be handed out in a known order.
        let minutes = 10 - age;
        let sql_locale = if locale.is_empty() {
            "NULL".to_owned()
        } else {
            format!("'{locale}'")
        };
        let slug = if locale.is_empty() { "none" } else { locale };
        db.execute_unprepared(&format!(
            "INSERT INTO users (id, email, display_name, status, mfa_enforced, is_instance_admin, \
                                is_bot, locale, created_at, updated_at) \
             VALUES ('{user}', '{user}@example.test', 'Owner', 'active', false, false, false, \
                     {sql_locale}, now(), now()); \
             INSERT INTO spaces (id, name, slug, created_at, updated_at) \
             VALUES ('{space}', 'Atelier {slug}', 'space-{slug}', \
                     now() - interval '{minutes} minutes', now()); \
             INSERT INTO space_members (space_id, user_id, role, joined_at) \
             VALUES ('{space}', '{user}', 'owner', now());"
        ))
        .await
        .expect("seed a space");
    }

    Migrator::up(&db, None).await.expect("apply the calendar");
    let rows = db
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT s.slug, c.name, c.color, c.write_access, c.default_reminder_minutes \
             FROM calendars c JOIN spaces s ON s.id = c.space_id \
             WHERE c.is_default ORDER BY s.slug;",
        ))
        .await
        .expect("read calendars");
    let found: Vec<(String, String, String, String, Option<i32>)> = rows
        .iter()
        .map(|r| {
            (
                r.try_get("", "slug").unwrap(),
                r.try_get("", "name").unwrap(),
                r.try_get("", "color").unwrap(),
                r.try_get("", "write_access").unwrap(),
                r.try_get("", "default_reminder_minutes").unwrap(),
            )
        })
        .collect();
    let expected = |slug: &str, name: &str, color: &str| {
        (
            slug.to_owned(),
            name.to_owned(),
            color.to_owned(),
            "members".to_owned(),
            Some(10),
        )
    };
    assert_eq!(
        found,
        vec![
            // Named after their space, whatever their owner's language, in turn through the palette.
            expected("space-de", "Atelier de", "violet"),
            expected("space-fr", "Atelier fr", "mint"),
            expected("space-none", "Atelier none", "peach"),
        ]
    );
}
