//! Response and request shapes for the messaging surface.
//!
//! These are kept deliberately close to the web data seam (`apps/web/lib/data/types.ts`) so wiring
//! the client to the real API later is mechanical: a `MessageDto` carries its reactions (with the
//! derived `count`/`mine`), thread `reply_count`, the edited/deleted/pinned/saved flags and resolved
//! mention ids. Unlike the mock, ids are real UUIDs and timestamps are RFC 3339 strings.

use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::files::AttachmentDto;

/// A reaction bucket on a message: the emoji, how many reacted, and whether the caller did.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ReactionDto {
    /// Native Unicode emoji.
    pub emoji: String,
    /// Total reactors for this emoji.
    pub count: i64,
    /// Whether the current caller is one of them (drives the toggle highlight).
    pub mine: bool,
    /// Display names of the reactors, in first-reaction order (for the "who reacted" tooltip).
    pub users: Vec<String>,
}

/// A message as returned to clients, with its satellites folded in.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MessageDto {
    pub id: Uuid,
    pub conversation_id: Uuid,
    /// `None` for a system message about nothing in particular; a notice about someone (a join)
    /// carries that person.
    pub author_id: Option<Uuid>,
    /// Author display name, denormalized for direct rendering. Follows `author_id`, so a join notice
    /// names the person who arrived and the client needs no second lookup.
    pub author_name: Option<String>,
    /// `message` or `system`.
    pub kind: String,
    /// Raw markdown (rendered client-side). Blank for a deleted tombstone.
    pub body: String,
    /// System-event discriminator for `system` messages (join/leave and similar).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_event: Option<String>,
    /// Parent message for a threaded reply; `None` for a root message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<Uuid>,
    /// Number of replies in this message's thread.
    pub reply_count: i32,
    /// When the thread was last answered (RFC 3339), for "last reply at 14:32" beside the count.
    /// Absent for a message without replies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_reply_at: Option<String>,
    /// The preview of the message's first link, read by the server (see `messaging::unfurl`).
    /// Absent until it has been fetched, and for a message without a readable link.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<LinkPreviewDto>,
    /// Display names of the last few people who answered in this thread, most recent first.
    ///
    /// Denormalized on purpose: a feed draws a face next to "3 replies" without opening the thread,
    /// and doing that from the client would cost one request per message on screen.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reply_authors: Vec<String>,
    /// Whether the message was migrated from another tool.
    pub imported: bool,
    /// Whether the message was edited.
    pub edited: bool,
    /// Whether the message is a deleted tombstone.
    pub deleted: bool,
    /// Whether the message is pinned in its channel.
    pub pinned: bool,
    /// Who pinned it, when it is pinned. Carried so a client can offer taking a pin down only to
    /// the person who put it there (a moderator may take down anyone's, which it knows already).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned_by: Option<Uuid>,
    /// Whether the caller saved (bookmarked) this message.
    pub saved: bool,
    /// RFC 3339 creation timestamp.
    pub created_at: String,
    /// RFC 3339 edit timestamp, when edited.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<String>,
    /// Reaction buckets, sorted by first appearance.
    pub reactions: Vec<ReactionDto>,
    /// Resolved mention target user ids.
    pub mentions: Vec<Uuid>,
    /// Files attached to the message, in attachment order.
    pub attachments: Vec<AttachmentDto>,
}

/// A page of messages, newest-last, with an opaque cursor for the previous (older) page.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MessagePage {
    pub messages: Vec<MessageDto>,
    /// Pass as `before` to fetch the next older page; `None` when the start was reached.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_before: Option<Uuid>,
}

/// What changed in a space's conversations since a moment, for a client catching up.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ChangesDto {
    /// The server's clock when the answer was computed: pass it as the next `since`. Taken before
    /// the query, so a change made while it ran is sent again rather than skipped.
    pub now: String,
    /// The messages created, edited, deleted (as tombstones) or reacted to since then, replies
    /// included, oldest first.
    pub messages: Vec<MessageDto>,
    /// Too much changed, or too long ago, to be sent as a list: reload the space instead.
    pub truncated: bool,
}

/// A space the caller belongs to: the workspace-switcher entry and the bootstrap the SPA needs to
/// discover its channels (which are queried per space).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SpaceDto {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    /// The caller's role in the space: `owner`, `admin`, `member` or `guest`.
    pub role: String,
    /// Total members in the space (drives the workspace member count in the UI).
    pub members: i64,
    /// Unread root messages across the conversations the caller has joined in this space.
    ///
    /// Drives the rail's discreet activity dot, deliberately not a number: one busy channel would
    /// turn every space into a large figure that stops carrying information.
    pub unread: i64,
    /// Unread notifications in this space (mention, thread reply, direct message): the things
    /// addressed to the caller personally, and the only counter the rail shows as a number. A
    /// notification for "every message" is not one of them: it says there is activity, which
    /// `unread` already does.
    pub mentions: i64,
    /// The public channel every newly invited person joins.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_channel_id: Option<Uuid>,
    /// Same-origin URL of the uploaded icon; absent means the generated mark.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    /// How much this space notifies the caller: `default` (their own settings), `all`, `mentions`
    /// or `none`.
    pub notify_level: String,
}

/// A link preview, as the server read it from the page.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct LinkPreviewDto {
    pub url: String,
    /// The host, without a leading `www.`.
    pub domain: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The site's colour (`theme-color`), as `#rrggbb`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Same-origin address of the thumbnail of the site's preview image.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    /// The original image's size, for the aspect ratio to reserve.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_height: Option<i32>,
}

/// A channel in a space's sidebar list.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ChannelDto {
    pub id: Uuid,
    pub name: String,
    /// `public`, `private` or `archived`.
    #[serde(rename = "type")]
    pub channel_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported: Option<String>,
    /// Per-user sidebar favourite.
    pub favorite: bool,
    /// How much this channel notifies the caller: `default` (the space's setting), `all` (every
    /// message), `mentions` or `none`. `default` when they have not joined it.
    pub notify_level: String,
    /// Whether the caller has muted this channel.
    pub muted: bool,
    /// Whether the caller has joined this channel. A public channel is readable either way, but only
    /// members are pushed to in real time, so the client offers "join" or "leave" accordingly.
    pub member: bool,
    /// Count of unread messages for the caller (derived from the read cursor).
    pub unread: i64,
    /// The space roles this channel admits, when it is reserved to some of them. Absent means it
    /// admits everyone, which is every channel until somebody says otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_roles: Option<Vec<String>>,
}

/// A channel's shared facts, pushed in real time when one is created or changed.
///
/// Deliberately not a [`ChannelDto`]: that shape carries per-caller state (favourite, membership,
/// unread count) which differs for every recipient, so a broadcast would hand one member's view to
/// everyone. Clients patch only the fields here and keep their own.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ChannelSummaryDto {
    pub id: Uuid,
    pub space_id: Uuid,
    pub name: String,
    /// `public`, `private` or `archived`.
    #[serde(rename = "type")]
    pub channel_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
}

/// A direct-message conversation in a space's sidebar list.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DirectMessageDto {
    pub id: Uuid,
    /// Display label: the other participant, or a comma-joined list for a group.
    pub name: String,
    pub is_group: bool,
    /// The sole counterpart's user id for a 1:1 DM, so the client can overlay their live presence;
    /// `None` for a group DM (no single counterpart to track).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<Uuid>,
    /// Whether the sole counterpart is a bot account.
    pub bot: bool,
    pub unread: i64,
    /// How much this conversation notifies the caller: `default`, `all`, `mentions` or `none`.
    pub notify_level: String,
    /// Whether the caller has muted this conversation.
    pub muted: bool,
    /// The latest message of the conversation, for the preview line of a conversation list.
    /// Absent while nothing has been said.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message: Option<LastMessageDto>,
}

/// The latest message of a conversation, as a list of conversations shows it: the start of what was
/// said, who said it and when. A reply in a thread is not it, nor a system notice: what a list
/// previews is the conversation itself.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct LastMessageDto {
    /// The first characters of the body, raw markdown (the client flattens it for one line).
    pub excerpt: String,
    /// Whether the caller wrote it, so the list can say "You: ...".
    pub mine: bool,
    /// Sent at, RFC 3339.
    pub created_at: String,
}

/// A user's effective presence as seen by others.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PresenceDto {
    pub user_id: Uuid,
    /// `active`, `away`, `dnd` or `offline`.
    pub presence: String,
}

/// A member's global profile, as shown in the profile card and member list. Presence is not folded
/// in here: it is volatile and sourced separately (`GET /spaces/{id}/presence` and realtime events),
/// so this stays the stable, self-editable profile. Returned only for a user who shares a space with
/// the caller.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct UserProfileDto {
    pub id: Uuid,
    pub display_name: String,
    pub email: String,
    /// Free-text job title / role label (e.g. "Gérante"); `None` if unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pronouns: Option<String>,
    /// IANA timezone (e.g. "Europe/Paris"); the client derives the local time from it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    /// Interface language (`fr`, `en`, ...), or absent when they have not chosen one.
    ///
    /// On the profile for the same reason the timezone is: it says something about working with
    /// this person. Nothing else reads it, and it is the language *they* read, not one to write to
    /// them in from the interface.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    /// Whether this is a service account (e.g. the import assistant).
    pub is_bot: bool,
    /// Whether this person administers the instance.
    ///
    /// Not a privacy leak but the point: recovering an account that has lost both its password and
    /// its recovery codes means asking an administrator, and nobody can ask someone they cannot
    /// identify. It says nothing about what the account can see, only who to go to.
    pub is_instance_admin: bool,
    /// Same-origin URL of the uploaded avatar. Absent means there is none, and the client generates
    /// one from the display name, which is what it already does by default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

/// Who to add to a channel.
#[derive(Debug, Deserialize, ToSchema)]
pub struct AddChannelMembersRequest {
    /// Accounts to bring in. Anyone already in the channel is skipped rather than refused.
    pub user_ids: Vec<Uuid>,
}

/// Who was actually added, which is the request minus whoever was already there.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AddedMembersDto {
    pub added: Vec<Uuid>,
}

/// A space member row: identity plus the caller-independent role in the space. Presence is overlaid
/// client-side from the presence map, so it is not carried here.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MemberDto {
    pub user_id: Uuid,
    pub display_name: String,
    /// Free-text job title / role label; `None` if unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Membership role in the space: `owner`, `admin`, `member` or `guest`.
    pub role: String,
    pub is_bot: bool,
    /// Same-origin URL of the uploaded avatar; absent means the generated one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

/// A space's shared identity after it changed, pushed in real time.
///
/// Deliberately not `SpaceDto`: that one carries the caller's role and their unread counters, which
/// are per-recipient and must never be broadcast. Same split as `ChannelSummaryDto`. Every field is
/// serialised, `null` included, for the reason `MemberUpdatedDto` gives: this replaces an identity
/// rather than patching one, so a removed icon has to be sayable.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SpaceUpdatedDto {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub icon_url: Option<String>,
    pub default_channel_id: Option<Uuid>,
}

/// A member's identity after a profile change, pushed in real time.
///
/// Carries no role: a profile is the same in every space, and the roles the recipient holds for
/// this person are already on screen. Every field is always serialised, `null` included, because
/// this is a replacement and not a patch: an absent `avatar_url` has to mean "the photo was
/// removed", which is indistinguishable from "unchanged" if the field is allowed to disappear.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MemberUpdatedDto {
    pub user_id: Uuid,
    pub display_name: String,
    pub title: Option<String>,
    pub is_bot: bool,
    pub avatar_url: Option<String>,
}

/// A member's arrival in a space, pushed in real time.
///
/// Carries the space it happened in, because a client holds one space on screen and ignores events
/// for the others, plus exactly the shape the member list already renders: the roster is patched
/// rather than refetched, which is also what keeps the mention and direct-message candidates live.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MemberJoinedDto {
    pub space_id: Uuid,
    pub member: MemberDto,
}

/// A member's departure from a space, pushed in real time.
///
/// The counterpart of [`MemberJoinedDto`], and carries only the two ids: an arrival has to describe
/// someone the recipient may never have seen, a departure names someone whose row is already on
/// screen and is only being taken off it.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MemberLeftDto {
    pub space_id: Uuid,
    pub user_id: Uuid,
}

/// Change what a member is allowed to do in a space.
///
/// One of `owner`, `admin`, `member`, `guest`. Setting `owner` is a transfer rather than a
/// promotion: a space has one owner, so the one who hands it over becomes an `admin` in the same
/// write.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateMemberRoleRequest {
    pub role: String,
}

/// A channel membership's role after a change.
///
/// Its own shape rather than the space one: the ladder is different (a channel has no guests) and so
/// is the audience, since a channel's roles are read by the people in it and by nobody else.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ChannelMemberRoleDto {
    pub channel_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
}

/// A membership whose role changed, returned by the call and pushed in real time.
///
/// A transfer produces two of these (the new owner and the former one), which is why the endpoint
/// answers with a list rather than with the one member it was addressed at: the caller has to be
/// able to draw both, and so does everyone watching.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MemberRoleChangedDto {
    pub space_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
}

/// A space that stopped being the recipient's, pushed in real time.
///
/// `reason` separates the three ways that happens: they walked out (`left`), the space is gone for
/// everyone (`deleted`), or someone took them out of it (`removed`). The client drops it from the
/// rail in all three; what differs is what it says, and whether it says anything at all. A person
/// who left knows they left; a person who was removed has to be told, or a space simply vanishes
/// from under them.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SpaceRemovedDto {
    pub space_id: Uuid,
    pub reason: String,
}

/// Edit the caller's own profile. Absent fields are left unchanged; an empty string clears the field
/// (except `display_name`, which is required and ignored when blank).
#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateProfileRequest {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub pronouns: Option<String>,
    #[serde(default)]
    pub bio: Option<String>,
    /// IANA timezone (e.g. `Europe/Paris`), or blank to clear it.
    ///
    /// The column existed and was read by the profile card from the start, and nothing could ever
    /// write it: every profile reported a timezone nobody had chosen.
    #[serde(default)]
    pub timezone: Option<String>,
    /// Interface language, so what the server writes arrives in the language the reader chose.
    #[serde(default)]
    pub locale: Option<String>,
}

// --- Search & notifications ---

/// One in-app notification in the caller's inbox.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct NotificationDto {
    pub id: Uuid,
    /// `mention`, `broadcast`, `reply`, `dm`, `message`, or `calendar_reminder`.
    pub kind: String,
    /// The conversation a message notification is about; absent for a reminder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<Uuid>,
    /// The space it happened in. Carried so the inbox can be shown for the space on screen: without
    /// it a client holding one space cannot tell which of its notifications belong there, and would
    /// show a mention from another space in every space it opens. Absent for a reminder from a
    /// personal calendar, which belongs to every space.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_id: Option<Uuid>,
    /// The channel's name, absent for a direct message.
    ///
    /// Carried because a notification routinely arrives for a space the client has not loaded, and
    /// a client cannot name a conversation it has never seen. Without it the only thing left to
    /// show was the conversation's identifier, which is what a notification looked like whenever it
    /// came from anywhere but the space on screen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
    /// The space's name, for the same reason: a notification says where it happened. Empty for a
    /// reminder from a personal calendar.
    pub space_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_name: Option<String>,
    /// A short plain-text excerpt of the source message; empty for a reminder.
    pub preview: String,
    pub created_at: String,
    /// Whether the caller has read the notification.
    pub read: bool,
    /// A reminder's event and occurrence: what it is about and when it starts (RFC 3339 in UTC for
    /// a timed event, `YYYY-MM-DD` for an all-day one).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_all_day: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calendar_name: Option<String>,
}

/// A page of notifications, newest first, with the caller's total unread count.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct NotificationPage {
    pub notifications: Vec<NotificationDto>,
    /// Cursor for the next (older) page, or `None` at the end.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_before: Option<Uuid>,
    pub unread_count: i64,
}

/// A file matched by a search, enough to render a result row and open it.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FileHitDto {
    pub id: Uuid,
    pub name: String,
    /// `file`, `folder`, `image`, ...
    pub kind: String,
}

/// Combined search results: matching messages and file names the caller can see.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SearchResults {
    pub messages: Vec<MessageDto>,
    pub files: Vec<FileHitDto>,
}

// --- Request bodies ---

/// Post a new message (optionally as a threaded reply).
#[derive(Debug, Deserialize, ToSchema)]
pub struct SendMessageRequest {
    pub body: String,
    #[serde(default)]
    pub parent_message_id: Option<Uuid>,
    /// Ids of already-uploaded files to attach (the caller must be able to read each, and each must
    /// belong to the conversation's space).
    #[serde(default)]
    pub attachments: Vec<Uuid>,
}

/// Edit an existing message.
#[derive(Debug, Deserialize, ToSchema)]
pub struct EditMessageRequest {
    pub body: String,
    /// Ids of already-uploaded files to add to the message. Existing attachments are preserved.
    #[serde(default)]
    pub attachments: Vec<Uuid>,
}

/// A bookmarked message, with where it was said.
///
/// The saved list is the caller's whole account, so most of it points at conversations the client
/// has not loaded and cannot name on its own.
#[derive(Debug, Serialize, ToSchema)]
pub struct SavedMessageDto {
    #[serde(flatten)]
    pub message: MessageDto,
    pub space_id: Uuid,
    pub space_name: String,
    /// The channel's name, absent for a direct message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
}

/// Pin a channel to the caller's favourites, or unpin it.
#[derive(Debug, Deserialize, ToSchema)]
pub struct FavoriteRequest {
    pub favorite: bool,
}

/// Advance the caller's read cursor in a conversation.
#[derive(Debug, Deserialize, ToSchema)]
pub struct ReadRequest {
    pub last_read_message_id: Uuid,
}

/// Open (or fetch) a direct-message conversation with a set of users.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateDmRequest {
    /// The other participant(s); the caller is added implicitly.
    pub user_ids: Vec<Uuid>,
}

/// A new space to create. The caller becomes its owner.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateSpaceRequest {
    /// Display name. The URL slug is derived from it and made unique.
    pub name: String,
}

/// Where a slug leads: the space, and the slug it currently answers to.
///
/// Deliberately minimal. The caller already holds the space in its list; what it is missing is which
/// one an address from before a rename refers to, and what that address should now read as.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SpaceRefDto {
    pub id: Uuid,
    /// The space's current slug, which may differ from the one that was looked up.
    pub slug: String,
}

/// A change to a space's shared identity. Only the name for now.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateSpaceRequest {
    /// New display name. The slug is re-derived from it, and the one it replaces keeps resolving to
    /// the same space, so the addresses people already hold keep arriving.
    pub name: String,
}

/// The order a space's administrators give its channels: the ones they can see, first to last.
///
/// Channels the caller cannot see (someone else's private channel) are not theirs to name and keep
/// their place among the others.
#[derive(Debug, Deserialize, ToSchema)]
pub struct ChannelOrderRequest {
    pub channel_ids: Vec<Uuid>,
}

/// Sent to a space's members when its channels were reordered. Carries only the space: each
/// client re-reads the list it may see, so no private channel is named to someone outside it.
#[derive(Debug, Serialize, ToSchema)]
pub struct ChannelsReorderedDto {
    pub space_id: Uuid,
}

/// The channel administrators select for every newly invited person.
#[derive(Debug, Deserialize, ToSchema)]
pub struct SetDefaultChannelRequest {
    pub channel_id: Uuid,
}

/// An outstanding invitation into a space, as listed to an administrator.
///
/// Deliberately carries no token: only its digest is stored, and the usable link is returned once,
/// at creation. A lost link is replaced by revoking this row and issuing another.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct InvitationDto {
    pub id: Uuid,
    pub space_id: Uuid,
    /// Address this invitation was addressed to; `None` for a shareable link.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Role granted on acceptance: `admin`, `member` or `guest`.
    pub role: String,
    /// Display name of whoever issued it, when that account still exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invited_by: Option<String>,
    /// How many times it has been accepted.
    pub uses: i32,
    /// Maximum acceptances; `None` means unlimited.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_uses: Option<i32>,
    /// RFC 3339 expiry, when it expires.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    pub created_at: String,
    /// Whether it would be accepted right now: not revoked, not expired, uses left.
    pub usable: bool,
    /// Why it is in that state: `active`, `accepted`, `revoked` or `expired`.
    ///
    /// `usable` alone flattens four situations into one word, and the interface showed all of them
    /// as "inactive" next to a Revoke button: an invitation someone had just accepted looked like a
    /// failure that still needed cleaning up. An accepted invitation is a finished one.
    pub status: String,
}

/// The response to creating an invitation: the row, plus the link, shown exactly once.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct CreatedInvitationDto {
    #[serde(flatten)]
    pub invitation: InvitationDto,
    /// Absolute link to hand to the invitee. Never retrievable again.
    pub url: String,
    /// Whether the invitation email actually went out. False when the invitation is a shareable
    /// link (nothing to send) or when the relay refused it, in which case the `url` above is the
    /// only way to deliver it.
    pub emailed: bool,
}

/// What someone holding an invitation token is told before they sign in.
///
/// Enough to decide whether to accept, and nothing more: never the member list, never whether the
/// address already has an account. Returned only for an invitation that is usable right now;
/// unknown, revoked, expired and exhausted tokens all get the same `404`, so the reason is never
/// disclosed.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct InvitationPreviewDto {
    pub space_name: String,
    /// Display name of whoever issued it, when that account still exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invited_by: Option<String>,
    /// Address the invitation is addressed to, so the screen can say which account to use.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub role: String,
}

/// Create an invitation into a space.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateInvitationRequest {
    /// Address to send it to. Omit for a shareable link.
    #[serde(default)]
    pub email: Option<String>,
    /// `admin`, `member` or `guest`. Defaults to `member`; `owner` is refused.
    #[serde(default)]
    pub role: Option<String>,
    /// Lifetime in hours. Defaults to 7 days, capped at 30.
    #[serde(default)]
    pub expires_in_hours: Option<i64>,
    /// Maximum acceptances. Defaults to 1 for an addressed invitation, unlimited for a link.
    #[serde(default)]
    pub max_uses: Option<i32>,
}

/// A new channel to create in a space.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateChannelRequest {
    /// Display name; normalised to the lowercase, dash-separated form channels use.
    pub name: String,
    /// `public` or `private`. A channel cannot be created already archived.
    #[serde(rename = "type")]
    pub channel_type: String,
    #[serde(default)]
    pub topic: Option<String>,
    /// Reserve the channel to these space roles. Absent or empty leaves it open to every role, and
    /// the caller's own role has to be in the list: a room you are shut out of is not a room you
    /// meant to make.
    #[serde(default)]
    pub allowed_roles: Option<Vec<String>>,
}

/// Fields to change on a channel. An absent field is left untouched; an empty `topic` clears it.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateChannelRequest {
    #[serde(default)]
    pub name: Option<String>,
    /// `public`, `private` or `archived`. Moving to `archived` makes the channel read-only.
    #[serde(default, rename = "type")]
    pub channel_type: Option<String>,
    #[serde(default)]
    pub topic: Option<String>,
    /// Replace the roles the channel admits. An empty list lifts the restriction; absent leaves it
    /// as it is, like every other field here.
    #[serde(default)]
    pub allowed_roles: Option<Vec<String>>,
}

/// A reference to a just-created or fetched conversation.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ConversationRef {
    pub id: Uuid,
}

/// Set (or clear) the caller's manual presence override.
#[derive(Debug, Deserialize, ToSchema)]
pub struct SetPresenceRequest {
    /// `active`, `away`, `dnd`, `invisible`, or `null`/absent to return to automatic presence.
    #[serde(default)]
    pub manual_presence: Option<String>,
}

/// A typing signal for a conversation (SSE-fallback clients POST this; WS clients send it inline).
#[derive(Debug, Deserialize, ToSchema)]
pub struct TypingRequest {
    pub conversation_id: Uuid,
}

/// Format an `OffsetDateTime` as RFC 3339, falling back to an empty string on the impossible error.
pub fn rfc3339(ts: OffsetDateTime) -> String {
    ts.format(&Rfc3339).unwrap_or_default()
}
