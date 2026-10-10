//! SeaORM entity models, mapping the database schema created by the migrations.

// Auth core.
pub mod recovery_codes;
pub mod totp_secrets;
pub mod users;
pub mod webauthn_credentials;

// Spaces, membership and channels.
pub mod channel_members;
pub mod channels;
pub mod conversations;
pub mod dm_conversations;
pub mod dm_participants;
pub mod space_invitations;
pub mod space_members;
pub mod space_slugs;
pub mod spaces;

// Files.
pub mod file_links;
pub mod file_shares;
pub mod file_stars;
pub mod file_versions;
pub mod files;

// The calendar.
pub mod calendar_attendee_overrides;
pub mod calendar_event_attendees;
pub mod calendar_event_exceptions;
pub mod calendar_event_reminders;
pub mod calendar_events;
pub mod calendar_feed_tokens;
pub mod calendar_reminder_prefs;
pub mod calendar_visibility;
pub mod calendars;

// Messaging.
pub mod channel_pins;
pub mod channel_role_access;
pub mod message_attachments;
pub mod message_link_previews;
pub mod message_mentions;
pub mod message_reactions;
pub mod messages;
pub mod notifications;
pub mod read_cursors;
pub mod user_saved_messages;

// Bringing a workspace over from another product.
pub mod import_jobs;
pub mod import_mappings;

// Per-user client preferences.
pub mod space_notification_prefs;
pub mod user_preferences;

// Browsers that asked to be told about notifications while no Ruchoir page is open.
pub mod push_subscriptions;

// What happened to the instance itself: backups taken, replacements run.
pub mod instance_events;

// Server-wide settings, one row.
pub mod instance_settings;
