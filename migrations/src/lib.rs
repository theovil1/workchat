//! Ruchoir database migrations, applied in order by [`Migrator`].
//!
//! Migrations are versioned and forward-only: never edit one that has shipped, add a new one.
//! The API applies them automatically in development and through the explicit `migrate`
//! subcommand in production (see `apps/api`).

pub use sea_orm_migration::prelude::*;

mod m20260901_000001_init_auth;
mod m20260902_000001_spaces_and_channels;
mod m20260902_000002_files;
mod m20260902_000003_messaging;
mod m20260902_000004_user_profiles;
mod m20260902_000005_preferences_and_media;
mod m20260903_000001_user_manual_presence;
mod m20260903_000002_file_thumbnails;
mod m20260904_000001_search_and_notifications;
mod m20260907_000001_space_invitations;
mod m20260907_000002_user_uploads;
mod m20260907_000003_space_slug_history;
mod m20260911_000001_broadcast_notification_kind;
mod m20260912_000001_instance_admin;
mod m20260912_000002_instance_settings;
mod m20260912_000003_user_locale;
mod m20260912_000004_channel_role_access;
mod m20260913_000001_import_jobs;
mod m20260913_000002_instance_events;
mod m20260913_000003_generated_source;
mod m20260922_000001_default_space_channel;
mod m20260923_000001_import_mapping_owner;
mod m20260923_000002_channel_position;
mod m20260924_000001_push_and_email_notifications;
mod m20260924_000002_link_preview_look;
mod m20260924_000003_notification_levels;
mod m20261003_000001_file_trash;
mod m20261003_000002_file_links;
mod m20261003_000003_file_stars;
mod m20261004_000001_calendar;
mod m20261005_000001_calendar_invitations;

/// The ordered list of migrations. New migrations are appended here.
pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260901_000001_init_auth::Migration),
            Box::new(m20260902_000001_spaces_and_channels::Migration),
            Box::new(m20260902_000002_files::Migration),
            Box::new(m20260902_000003_messaging::Migration),
            Box::new(m20260902_000004_user_profiles::Migration),
            Box::new(m20260902_000005_preferences_and_media::Migration),
            Box::new(m20260903_000001_user_manual_presence::Migration),
            Box::new(m20260903_000002_file_thumbnails::Migration),
            Box::new(m20260904_000001_search_and_notifications::Migration),
            Box::new(m20260907_000001_space_invitations::Migration),
            Box::new(m20260907_000002_user_uploads::Migration),
            Box::new(m20260907_000003_space_slug_history::Migration),
            Box::new(m20260911_000001_broadcast_notification_kind::Migration),
            Box::new(m20260912_000001_instance_admin::Migration),
            Box::new(m20260912_000002_instance_settings::Migration),
            Box::new(m20260912_000003_user_locale::Migration),
            Box::new(m20260912_000004_channel_role_access::Migration),
            Box::new(m20260913_000001_import_jobs::Migration),
            Box::new(m20260913_000002_instance_events::Migration),
            Box::new(m20260913_000003_generated_source::Migration),
            Box::new(m20260922_000001_default_space_channel::Migration),
            Box::new(m20260923_000001_import_mapping_owner::Migration),
            Box::new(m20260923_000002_channel_position::Migration),
            Box::new(m20260924_000001_push_and_email_notifications::Migration),
            Box::new(m20260924_000002_link_preview_look::Migration),
            Box::new(m20260924_000003_notification_levels::Migration),
            Box::new(m20261003_000001_file_trash::Migration),
            Box::new(m20261003_000002_file_links::Migration),
            Box::new(m20261003_000003_file_stars::Migration),
            Box::new(m20261004_000001_calendar::Migration),
            Box::new(m20261005_000001_calendar_invitations::Migration),
        ]
    }
}
