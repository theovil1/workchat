//! The real-time event envelope pushed to clients, and the fan-out wire type.
//!
//! Every server-to-client push is a [`RealtimeEnvelope`]: a versioned, self-describing frame the
//! client can switch on without guessing. Handlers never build one by hand: they call the small
//! constructors here so the `type` strings stay in one place and can never drift from the payload.
//!
//! Between API instances, an envelope travels wrapped in a [`FanoutMessage`] that also carries the
//! `audience` (the user ids allowed to receive it). The audience is computed once, at publish time,
//! from membership, so the receiving side never touches the database on the hot path. Clients only
//! ever see the inner `envelope`: the audience is stripped before delivery.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// The current envelope schema version. Bumped only on a breaking shape change so old clients can
/// detect and refuse an envelope they cannot parse.
pub const ENVELOPE_VERSION: u8 = 1;

/// A single server-to-client real-time frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RealtimeEnvelope {
    /// Envelope schema version (see [`ENVELOPE_VERSION`]).
    pub v: u8,
    /// The event discriminator, e.g. `message.created`. See the constructors below for the full set.
    #[serde(rename = "type")]
    pub event_type: String,
    /// The conversation the event belongs to, when it is conversation-scoped (all message, reaction,
    /// pin, typing and read events). `None` for user-global events such as presence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<Uuid>,
    /// The event body. Shape depends on `event_type`; the messaging DTOs define the concrete forms.
    pub payload: Value,
}

impl RealtimeEnvelope {
    /// Build a conversation-scoped envelope from any serializable payload.
    fn conversation(event_type: &str, conversation_id: Uuid, payload: impl Serialize) -> Self {
        Self {
            v: ENVELOPE_VERSION,
            event_type: event_type.to_string(),
            conversation_id: Some(conversation_id),
            payload: serde_json::to_value(payload).unwrap_or(Value::Null),
        }
    }

    /// Build a user-global envelope (no conversation scope).
    fn global(event_type: &str, payload: impl Serialize) -> Self {
        Self {
            v: ENVELOPE_VERSION,
            event_type: event_type.to_string(),
            conversation_id: None,
            payload: serde_json::to_value(payload).unwrap_or(Value::Null),
        }
    }

    /// A new message was posted.
    pub fn message_created(conversation_id: Uuid, message: impl Serialize) -> Self {
        Self::conversation("message.created", conversation_id, message)
    }

    /// An existing message was edited.
    pub fn message_updated(conversation_id: Uuid, message: impl Serialize) -> Self {
        Self::conversation("message.updated", conversation_id, message)
    }

    /// A message was soft-deleted (a tombstone remains).
    pub fn message_deleted(conversation_id: Uuid, message: impl Serialize) -> Self {
        Self::conversation("message.deleted", conversation_id, message)
    }

    /// A reaction was added to a message.
    pub fn reaction_added(conversation_id: Uuid, payload: impl Serialize) -> Self {
        Self::conversation("reaction.added", conversation_id, payload)
    }

    /// A reaction was removed from a message.
    pub fn reaction_removed(conversation_id: Uuid, payload: impl Serialize) -> Self {
        Self::conversation("reaction.removed", conversation_id, payload)
    }

    /// A message was pinned in a channel.
    pub fn message_pinned(conversation_id: Uuid, payload: impl Serialize) -> Self {
        Self::conversation("message.pinned", conversation_id, payload)
    }

    /// A message was unpinned.
    pub fn message_unpinned(conversation_id: Uuid, payload: impl Serialize) -> Self {
        Self::conversation("message.unpinned", conversation_id, payload)
    }

    /// The caller saved a message (delivered only to that user's own connections).
    pub fn message_saved(conversation_id: Uuid, payload: impl Serialize) -> Self {
        Self::conversation("message.saved", conversation_id, payload)
    }

    /// The caller removed a saved message (delivered only to that user's own connections).
    pub fn message_unsaved(conversation_id: Uuid, payload: impl Serialize) -> Self {
        Self::conversation("message.unsaved", conversation_id, payload)
    }

    /// The caller's read cursor advanced (delivered only to that user's own connections).
    pub fn read_updated(conversation_id: Uuid, payload: impl Serialize) -> Self {
        Self::conversation("read.updated", conversation_id, payload)
    }

    /// A channel was created in a space the recipient belongs to.
    pub fn channel_created(conversation_id: Uuid, payload: impl Serialize) -> Self {
        Self::conversation("channel.created", conversation_id, payload)
    }

    /// A channel was renamed, re-topiced, archived, restored, or changed visibility.
    pub fn channel_updated(conversation_id: Uuid, payload: impl Serialize) -> Self {
        Self::conversation("channel.updated", conversation_id, payload)
    }

    /// A space's channels were put in a new order by its administrators.
    ///
    /// Space-scoped and carrying only the space: the recipient re-reads the channels it may see,
    /// rather than being handed an order that would name private channels it is not in.
    pub fn channels_reordered(payload: impl Serialize) -> Self {
        Self::global("channels.reordered", payload)
    }

    /// Someone is typing in a conversation (ephemeral, never stored).
    pub fn typing(conversation_id: Uuid, payload: impl Serialize) -> Self {
        Self::conversation("typing", conversation_id, payload)
    }

    /// Someone joined a space the recipient belongs to.
    ///
    /// Space-scoped rather than conversation-scoped: an arrival changes the member roster, the
    /// mention candidates and the direct-message candidates, none of which hang off a conversation.
    pub fn member_joined(payload: impl Serialize) -> Self {
        Self::global("member.joined", payload)
    }

    /// Someone left a space the recipient belongs to, or was removed from it.
    ///
    /// The counterpart of [`RealtimeEnvelope::member_joined`], and space-scoped for the same
    /// reason: a departure changes the roster, the mention candidates and the direct-message
    /// candidates. Without it the member list goes on offering someone who can no longer read what
    /// is written to them, which is the worst way to be wrong about an audience.
    pub fn member_left(payload: impl Serialize) -> Self {
        Self::global("member.left", payload)
    }

    /// A member's role in a space changed.
    ///
    /// Separate from `member.updated`, which carries an identity and deliberately no role: a name or
    /// a photo is the same in every space, while a role is a fact about one space and decides what
    /// the person receiving the event is allowed to see offered. Delivered to the space, the person
    /// whose role changed included, because their own interface has to gain or lose the controls
    /// that go with it without a reload.
    pub fn member_role_changed(payload: impl Serialize) -> Self {
        Self::global("member.role_changed", payload)
    }

    /// A channel was deleted, with everything in it. Global rather than conversation-scoped: the
    /// conversation no longer exists to scope it, and the client drops the channel from its space
    /// the way it drops a space on `space.removed`. Delivered to everyone who could see it listed.
    pub fn channel_deleted(payload: impl Serialize) -> Self {
        Self::global("channel.deleted", payload)
    }

    /// A space is no longer the recipient's: they left it, or it was deleted under them.
    ///
    /// One event for both because the client does the same thing with either: drop the space from
    /// the rail and move on. The difference matters to the person, not to the state, so it travels
    /// as a `deleted` flag rather than as a second event type. Delivered to the leaver's own
    /// connections when someone leaves, and to every member when a space is deleted.
    pub fn space_removed(payload: impl Serialize) -> Self {
        Self::global("space.removed", payload)
    }

    /// A member's profile changed: display name, title, or avatar.
    ///
    /// Space-scoped like an arrival, and for the same reason: an identity is shown by the member
    /// list, the mention candidates, the message rows and the direct-message list, none of which
    /// hang off a conversation. Delivered to everyone who shares a space with them, the caller's own
    /// other connections included, so a photo changed in one tab lands in the others.
    pub fn member_updated(payload: impl Serialize) -> Self {
        Self::global("member.updated", payload)
    }

    /// A space's name or icon changed.
    ///
    /// Delivered to its members, the one who changed it included, so the rail, the mobile top bar
    /// and the switcher stop showing the mark the space had when they last loaded it.
    pub fn space_updated(payload: impl Serialize) -> Self {
        Self::global("space.updated", payload)
    }

    /// One or more files were removed from a space.
    ///
    /// Delivered to the space's members, the one who deleted them included. A file is not only a
    /// row of the files screen: it may be hanging off a message someone else has on screen, and
    /// without this that message goes on offering bytes that are gone until the page is reloaded.
    pub fn files_deleted(payload: impl Serialize) -> Self {
        Self::global("files.deleted", payload)
    }

    /// A file gained a new version, or was created by the server from bytes it holds (a blank
    /// document, a converted copy).
    ///
    /// Delivered to everyone who can see the file, the author included, so an open file list or
    /// viewer shows the change without a reload.
    pub fn files_updated(payload: impl Serialize) -> Self {
        Self::global("files.updated", payload)
    }

    /// Who is editing a file in the office editor changed.
    ///
    /// Delivered to everyone who can see the file; it carries the whole current list, so a client
    /// only ever replaces what it shows.
    pub fn files_editing(payload: impl Serialize) -> Self {
        Self::global("files.editing", payload)
    }

    /// A user's effective presence changed.
    pub fn presence(payload: impl Serialize) -> Self {
        Self::global("presence", payload)
    }

    /// A new in-app notification was created for a user (delivered only to that user; user-scoped,
    /// not tied to a conversation the recipient may not otherwise be watching).
    pub fn notification_created(payload: impl Serialize) -> Self {
        Self::global("notification.created", payload)
    }

    /// A calendar, its settings or its events changed: whoever shows it reloads what is on screen.
    pub fn calendar_changed(calendar_id: Uuid) -> Self {
        Self::global(
            "calendar.changed",
            serde_json::json!({ "calendar_id": calendar_id }),
        )
    }
}

/// The wire type carried between API instances over the `rt:fanout` Valkey channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FanoutMessage {
    /// User ids permitted to receive `envelope`. Computed once at publish time from membership.
    pub audience: Vec<Uuid>,
    /// The frame to deliver to each locally-connected member of `audience`.
    pub envelope: RealtimeEnvelope,
}
