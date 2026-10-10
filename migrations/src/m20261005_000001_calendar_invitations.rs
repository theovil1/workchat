//! Invitations: who is asked to an event and what they answered, for the whole series and, where
//! they said otherwise, for one date of it.
//!
//! An attendee is an account or an email address. Someone invited by address answers through a
//! link: its token is looked up by digest and also kept encrypted with the server's key, so the
//! same link goes out again in every later mail about the event.
//!
//! Notifications learn four calendar kinds (an invitation, a change, a cancellation, a refusal for
//! the organiser). Each carries a `payload` describing the event as it was when it was sent: a
//! cancellation outlives its event, so it cannot read it back.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const UP: &str = "\
CREATE TABLE calendar_event_attendees ( \
    id uuid PRIMARY KEY, \
    event_id uuid NOT NULL REFERENCES calendar_events (id) ON DELETE CASCADE, \
    user_id uuid REFERENCES users (id) ON DELETE CASCADE, \
    email text CHECK (email IS NULL OR char_length(email) BETWEEN 3 AND 320), \
    name text CHECK (name IS NULL OR char_length(name) <= 200), \
    status text NOT NULL DEFAULT 'needs_action' \
        CHECK (status IN ('needs_action', 'accepted', 'tentative', 'declined')), \
    token_digest text, \
    token_cipher bytea, \
    token_nonce bytea, \
    invited_by uuid REFERENCES users (id) ON DELETE SET NULL, \
    invited_at timestamptz NOT NULL DEFAULT now(), \
    responded_at timestamptz, \
    CONSTRAINT calendar_event_attendees_who CHECK ((user_id IS NULL) <> (email IS NULL)), \
    CONSTRAINT calendar_event_attendees_token CHECK ( \
        (email IS NULL) = (token_digest IS NULL) \
        AND (token_digest IS NULL) = (token_cipher IS NULL) \
        AND (token_cipher IS NULL) = (token_nonce IS NULL)) \
); \
CREATE UNIQUE INDEX calendar_event_attendees_user ON calendar_event_attendees (event_id, user_id) \
    WHERE user_id IS NOT NULL; \
CREATE UNIQUE INDEX calendar_event_attendees_email ON calendar_event_attendees (event_id, lower(email)) \
    WHERE email IS NOT NULL; \
CREATE UNIQUE INDEX calendar_event_attendees_token ON calendar_event_attendees (token_digest) \
    WHERE token_digest IS NOT NULL; \
CREATE INDEX calendar_event_attendees_person ON calendar_event_attendees (user_id) \
    WHERE user_id IS NOT NULL; \
\
CREATE TABLE calendar_attendee_overrides ( \
    attendee_id uuid NOT NULL REFERENCES calendar_event_attendees (id) ON DELETE CASCADE, \
    recurrence_id text NOT NULL, \
    status text NOT NULL CHECK (status IN ('needs_action', 'accepted', 'tentative', 'declined')), \
    PRIMARY KEY (attendee_id, recurrence_id) \
); \
\
ALTER TABLE notifications ADD COLUMN payload jsonb; \
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check; \
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ( \
    'mention', 'broadcast', 'reply', 'dm', 'message', 'calendar_reminder', \
    'calendar_invitation', 'calendar_update', 'calendar_cancel', 'calendar_declined')); \
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_subject_check; \
ALTER TABLE notifications ADD CONSTRAINT notifications_subject_check CHECK ( \
    (kind = 'calendar_reminder' AND event_id IS NOT NULL AND occurrence_start IS NOT NULL \
         AND conversation_id IS NULL AND message_id IS NULL) \
    OR (kind IN ('calendar_invitation', 'calendar_update', 'calendar_declined') \
         AND event_id IS NOT NULL AND payload IS NOT NULL \
         AND conversation_id IS NULL AND message_id IS NULL) \
    OR (kind = 'calendar_cancel' AND payload IS NOT NULL \
         AND conversation_id IS NULL AND message_id IS NULL) \
    OR (kind NOT LIKE 'calendar\\_%' AND conversation_id IS NOT NULL AND message_id IS NOT NULL));";

const DOWN: &str = "\
DELETE FROM notifications \
    WHERE kind IN ('calendar_invitation', 'calendar_update', 'calendar_cancel', 'calendar_declined'); \
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_subject_check; \
ALTER TABLE notifications ADD CONSTRAINT notifications_subject_check CHECK ( \
    (kind = 'calendar_reminder' AND event_id IS NOT NULL AND occurrence_start IS NOT NULL \
         AND conversation_id IS NULL AND message_id IS NULL) \
    OR (kind <> 'calendar_reminder' AND conversation_id IS NOT NULL AND message_id IS NOT NULL)); \
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check; \
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check \
    CHECK (kind IN ('mention', 'broadcast', 'reply', 'dm', 'message', 'calendar_reminder')); \
ALTER TABLE notifications DROP COLUMN IF EXISTS payload; \
DROP TABLE IF EXISTS calendar_attendee_overrides; \
DROP TABLE IF EXISTS calendar_event_attendees;";

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(UP).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(DOWN).await?;
        Ok(())
    }
}
