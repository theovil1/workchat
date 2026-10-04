//! The calendar: calendars (a space's or a person's), events stored as iCalendar describes them (a
//! rule and its exceptions, unfolded on demand), each person's display and reminder settings, the
//! reminder log, and the iCal subscription addresses.
//!
//! Notifications stop being message-only: a reminder is a notification about an event occurrence,
//! so `conversation_id` and `message_id` become optional, with a CHECK that each kind carries the
//! subject it needs.
//!
//! Every space that already exists receives its default calendar, named after the space, with a
//! ten-minute reminder by default. The spaces take the palette's colours in turn, in the order they
//! were created, so neighbours rarely look alike. `accent` is a colour too: each viewer sees it in
//! their own theme's accent, which is what a person's own calendar wears.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const UP: &str = "\
CREATE TABLE calendars ( \
    id uuid PRIMARY KEY, \
    space_id uuid REFERENCES spaces (id) ON DELETE CASCADE, \
    owner_user_id uuid REFERENCES users (id) ON DELETE CASCADE, \
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200), \
    description text, \
    color text NOT NULL CHECK (color IN ('sky', 'mint', 'violet', 'pink', 'peach', 'lime', 'sun', 'accent')), \
    write_access text NOT NULL DEFAULT 'members' CHECK (write_access IN ('members', 'admins')), \
    default_reminder_minutes integer, \
    is_default boolean NOT NULL DEFAULT false, \
    created_by uuid REFERENCES users (id) ON DELETE SET NULL, \
    created_at timestamptz NOT NULL DEFAULT now(), \
    updated_at timestamptz NOT NULL DEFAULT now(), \
    CONSTRAINT calendars_owner_check CHECK ((space_id IS NULL) <> (owner_user_id IS NULL)) \
); \
CREATE INDEX calendars_space ON calendars (space_id); \
CREATE INDEX calendars_owner ON calendars (owner_user_id); \
CREATE UNIQUE INDEX calendars_one_default_per_space ON calendars (space_id) \
    WHERE is_default AND space_id IS NOT NULL; \
CREATE UNIQUE INDEX calendars_one_default_per_person ON calendars (owner_user_id) \
    WHERE is_default AND owner_user_id IS NOT NULL; \
\
CREATE TABLE calendar_events ( \
    id uuid PRIMARY KEY, \
    calendar_id uuid NOT NULL REFERENCES calendars (id) ON DELETE CASCADE, \
    uid text NOT NULL, \
    title text NOT NULL, \
    description text, \
    location text, \
    all_day boolean NOT NULL, \
    start_at timestamptz, \
    end_at timestamptz, \
    tzid text, \
    start_date date, \
    end_date date, \
    rrule text, \
    rdates timestamptz[], \
    series_until timestamptz, \
    sequence integer NOT NULL DEFAULT 0, \
    ical_extra jsonb NOT NULL DEFAULT '[]'::jsonb, \
    created_by uuid REFERENCES users (id) ON DELETE SET NULL, \
    updated_by uuid REFERENCES users (id) ON DELETE SET NULL, \
    created_at timestamptz NOT NULL DEFAULT now(), \
    updated_at timestamptz NOT NULL DEFAULT now(), \
    CONSTRAINT calendar_events_uid UNIQUE (calendar_id, uid), \
    CONSTRAINT calendar_events_when_check CHECK ( \
        (all_day AND start_date IS NOT NULL AND end_date IS NOT NULL AND end_date > start_date \
             AND start_at IS NULL AND end_at IS NULL AND tzid IS NULL) \
        OR (NOT all_day AND start_at IS NOT NULL AND end_at IS NOT NULL AND end_at >= start_at \
             AND tzid IS NOT NULL AND start_date IS NULL AND end_date IS NULL)) \
); \
CREATE INDEX calendar_events_start_at ON calendar_events (calendar_id, start_at); \
CREATE INDEX calendar_events_start_date ON calendar_events (calendar_id, start_date); \
CREATE INDEX calendar_events_series_until ON calendar_events (calendar_id, series_until); \
\
CREATE TABLE calendar_event_exceptions ( \
    event_id uuid NOT NULL REFERENCES calendar_events (id) ON DELETE CASCADE, \
    recurrence_id text NOT NULL, \
    cancelled boolean NOT NULL DEFAULT false, \
    title text, \
    description text, \
    location text, \
    start_at timestamptz, \
    end_at timestamptz, \
    start_date date, \
    end_date date, \
    ical_extra jsonb NOT NULL DEFAULT '[]'::jsonb, \
    PRIMARY KEY (event_id, recurrence_id) \
); \
\
CREATE TABLE calendar_visibility ( \
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE, \
    calendar_id uuid NOT NULL REFERENCES calendars (id) ON DELETE CASCADE, \
    hidden boolean NOT NULL, \
    PRIMARY KEY (user_id, calendar_id) \
); \
\
CREATE TABLE calendar_reminder_prefs ( \
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE, \
    calendar_id uuid NOT NULL REFERENCES calendars (id) ON DELETE CASCADE, \
    minutes integer, \
    PRIMARY KEY (user_id, calendar_id) \
); \
\
CREATE TABLE calendar_event_reminders ( \
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE, \
    event_id uuid NOT NULL REFERENCES calendar_events (id) ON DELETE CASCADE, \
    minutes integer, \
    PRIMARY KEY (user_id, event_id) \
); \
\
CREATE TABLE calendar_reminder_deliveries ( \
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE, \
    event_id uuid NOT NULL REFERENCES calendar_events (id) ON DELETE CASCADE, \
    occurrence_start timestamptz NOT NULL, \
    sent_at timestamptz NOT NULL, \
    PRIMARY KEY (user_id, event_id, occurrence_start) \
); \
\
CREATE TABLE calendar_feed_tokens ( \
    id uuid PRIMARY KEY, \
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE, \
    calendar_id uuid REFERENCES calendars (id) ON DELETE CASCADE, \
    token_hash text NOT NULL UNIQUE, \
    created_at timestamptz NOT NULL DEFAULT now(), \
    last_used_at timestamptz, \
    revoked_at timestamptz \
); \
CREATE INDEX calendar_feed_tokens_user ON calendar_feed_tokens (user_id); \
\
ALTER TABLE notifications ALTER COLUMN conversation_id DROP NOT NULL; \
ALTER TABLE notifications ALTER COLUMN message_id DROP NOT NULL; \
ALTER TABLE notifications ADD COLUMN event_id uuid REFERENCES calendar_events (id) ON DELETE CASCADE; \
ALTER TABLE notifications ADD COLUMN occurrence_start timestamptz; \
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check; \
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check \
    CHECK (kind IN ('mention', 'broadcast', 'reply', 'dm', 'message', 'calendar_reminder')); \
ALTER TABLE notifications ADD CONSTRAINT notifications_subject_check CHECK ( \
    (kind = 'calendar_reminder' AND event_id IS NOT NULL AND occurrence_start IS NOT NULL \
         AND conversation_id IS NULL AND message_id IS NULL) \
    OR (kind <> 'calendar_reminder' AND conversation_id IS NOT NULL AND message_id IS NOT NULL)); \
\
INSERT INTO calendars (id, space_id, name, color, write_access, default_reminder_minutes, \
                       is_default, created_by, created_at, updated_at) \
SELECT gen_random_uuid(), s.id, left(s.name, 200), \
       (ARRAY['mint', 'violet', 'peach', 'lime', 'sun', 'pink', 'sky']) \
           [(row_number() OVER (ORDER BY s.created_at, s.id) - 1) % 7 + 1], \
       'members', 10, true, o.user_id, now(), now() \
FROM spaces s \
LEFT JOIN LATERAL ( \
    SELECT m.user_id FROM space_members m \
    WHERE m.space_id = s.id AND m.role = 'owner' ORDER BY m.joined_at LIMIT 1 \
) o ON true;";

const DOWN: &str = "\
DELETE FROM notifications WHERE kind = 'calendar_reminder'; \
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_subject_check; \
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check; \
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check \
    CHECK (kind IN ('mention', 'broadcast', 'reply', 'dm', 'message')); \
ALTER TABLE notifications DROP COLUMN IF EXISTS occurrence_start; \
ALTER TABLE notifications DROP COLUMN IF EXISTS event_id; \
ALTER TABLE notifications ALTER COLUMN message_id SET NOT NULL; \
ALTER TABLE notifications ALTER COLUMN conversation_id SET NOT NULL; \
DROP TABLE IF EXISTS calendar_feed_tokens; \
DROP TABLE IF EXISTS calendar_reminder_deliveries; \
DROP TABLE IF EXISTS calendar_event_reminders; \
DROP TABLE IF EXISTS calendar_reminder_prefs; \
DROP TABLE IF EXISTS calendar_visibility; \
DROP TABLE IF EXISTS calendar_event_exceptions; \
DROP TABLE IF EXISTS calendar_events; \
DROP TABLE IF EXISTS calendars;";

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
