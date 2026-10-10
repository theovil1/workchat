# AGENTS.md - apps/api

The Rust backend: the single production service. It owns all business logic, auth,
authorization, real-time transport and data access, and it also serves the static web
bundle. See the root `AGENTS.md` for project-wide rules; this file adds crate-specific
context and takes precedence here.

## Layout

- `src/main.rs`   - entrypoint: config load, tracing, datastore connections, migrations, server
  bind (HTTP, or HTTPS with the `tls` feature), graceful shutdown. Also handles the `migrate`
  subcommand.
- `src/config.rs` - environment-driven configuration with dev defaults.
- `src/db.rs`     - PostgreSQL connection pool via SeaORM.
- `src/cache.rs`  - Valkey connection pool via fred.
- `src/state.rs`  - `AppState` (db + Valkey + config) shared with handlers.
- `src/entities/` - SeaORM entity models mapping the database schema. The auth tables plus the
  collaboration domain: spaces/membership/invitations, the `conversations` supertype with `channels` and
  `dm_conversations`, `messages` and their satellites (reactions, mentions, link previews,
  attachments, pins, saved, read cursors), and `files`/`file_versions`/`file_shares`. Relations are
  added when query code needs them.
- `src/calendar/` - the calendar (`docs/calendar.md`, ADR 0004): `recurrence` (pure: unfolding a
  rule over a period in the event's own time zone, cutting a series, `VTIMEZONE` blocks; the only
  place `chrono` is used), `authz` (who sees and changes which calendar, and the lazily created
  default calendars), `calendars` and `events` (the handlers; `scope` = this / following / all),
  `occurrences` (a period, unfolded), `feeds` and `ics` (the read-only subscription, public under
  `/api/v1/public/ical/`), and `reminders` (the minute sweep, the per-person effective reminder, and
  how a reminder is drawn in the inbox, a push and a mail). Its tests are in
  `src/tests_integration/calendar_tests.rs`, a child module of the integration tests.
- `src/bootstrap.rs` - the `bootstrap` subcommand: creates the first administrator of a fresh
  instance (and optionally their first space), from the environment or with the password piped on
  standard input. Refuses once any account exists, so it cannot mint a second identity later.
  Deliberately a command and not something the server does on its own: an instance that quietly
  minted an administrator from its environment would be one restart from a surprise. Everyone after
  the first joins through an invitation.
- `src/seed.rs`   - the `seed` subcommand: populates a realistic dev workspace (6 fixture accounts +
  an import bot, **two** spaces, channels, messages/threads/reactions, a file with a version and a
  share, DMs, and unread mention notifications). Dev-guarded (`RUCHOIR_ENV=dev` or `--force`).
  **Idempotent per space, not per workspace**: each space is guarded by its own slug, so a space
  added to `seed.rs` later lands in a database that was seeded before it existed instead of being
  skipped. The second space is owned by someone other than the demo account and left unread on
  purpose: it is the one the workspace rail has something to show for.
- `src/auth/`     - the auth core: password hashing (argon2id) + policy with an offline breach
  check, opaque Valkey sessions, the `__Host-` session cookie, the `AuthSession` extractor
  (authorization guard), per-account anti-bruteforce throttle, SMTP mailer + single-use email
  tokens (verification / reset; **an invitation addressed to the registering address activates the
  account outright**, since delivery to that mailbox is the same proof a confirmation email would
  collect, while a shareable link proves nothing about an address and changes nothing), MFA (TOTP with AES-GCM-encrypted secrets, WebAuthn passkeys,
  HMAC-hashed recovery codes) with a login step-up flow, error type, and the `/api/v1/auth` routes.
- `src/messaging/` - the REST surface over the collaboration schema: `authz` (the conversation
  membership choke point plus audience computation), `error` (`ApiError`), `dto` (response/request
  shapes, kept close to the web data seam), `mentions` (`@`-parsing + resolution), `slug` (the one
  definition of a channel-name / space-slug handle: lowercase, diacritics folded, dashes), and the
  handlers `messages`/`reactions`/`read`/`pins`/`saved`/`conversations`/`channels`/`spaces`/`search`/
  `notifications`. `conversations` also carries the per-space counters behind `GET /me/spaces` (`unread`, from the
  conversations the caller has joined, and `mentions`, from their unread notification inbox): both are
  one grouped SQL statement each, deliberately not the per-conversation `unread_count` helper, which
  is fine for the one space on screen and quadratic for every space on every boot.
  `invitations` is how anyone but a space's creator gets in: an invitation is a durable, listable and
  revocable row (unlike the fire-and-forget Valkey tokens of the auth core) holding only the SHA-256
  digest of its token, addressed to one email or open as a shareable link, and accepting one joins the
  space plus its configured default channel so the arrival is live at once. A default channel is
  one public, active, unrestricted channel per space, chosen and changed by its administrators,
  publishes `member.joined`
  to the space and writes a `member_joined` system message into that channel in the same transaction
  (only on a real arrival: an existing member re-opening their link announces nothing). A system row
  stores the *event* and an empty body, never a sentence: user-facing copy belongs to the client,
  like the auth error codes. **A channel keeps its own history of who came and went** the same way:
  `channel_created` when one is created, `channel_joined` when someone joins or is added,
  `channel_left` when they leave. All three had a sentence, an icon and a renderer in the client from
  the start and **nothing on the server ever wrote them**, so only seeded channels announced their
  creation and a channel's membership changed in silence. Its `author_id` is the person the notice is about, so the client can name
  them without a second lookup; it stays `None` for a notice about nothing in particular. `spaces` and `channels` carry
  the lifecycle: creating a space (the caller becomes
  its owner and it is born with one public channel, so it is never an empty shell), creating a
  channel, updating one (rename, topic, visibility, and archiving, which is a state that makes it
  read-only rather than a deletion), and joining or leaving one. A member is taken out of a space by
  `DELETE /spaces/{id}/members/{user_id}`, under the same rank rule as a role change (an owner may
  remove an admin, an admin may not), which is the only coherent answer: an administrator who cannot
  demote someone must not be able to expel them instead. Leaving and being removed are one withdrawal
  decided by two different people, so they share `withdraw_membership`, but they write different
  notices (`member_left` / `member_removed`) and `space.removed` carries a `reason`
  (`left`/`deleted`/`removed`) rather than a boolean: the client drops the space in all three cases
  and says something in the two the person did not decide. A space has two exits, and they are
  different acts: **leaving** (`DELETE /spaces/{id}/membership`) takes the caller's own membership
  and their channel memberships inside that space, leaves everything they wrote where it was
  written, and is refused with a `409` for the space's last owner, who would otherwise leave it with
  nobody able to administer it; **deleting** (`DELETE /spaces/{id}`) is the owner's alone (not an
  admin's) and is immediate and total, with no grace period. Every child table cascades off
  `spaces.id`, so one row deletion empties the schema, but the stored objects are not in the
  database: the file versions' keys are collected *before* the delete and removed behind it, or a
  deleted space would leave its bytes in the store while the interface reported them gone.
  **Reading a channel grants reading it, and nothing else.** Everything a channel pushes goes to its
  members, so *taking part* from outside reached everyone but its own author: writing and reacting
  therefore join the channel (`join_before_taking_part`), once, with the arrival in its history. A
  **pin** is the other shape of the same mistake and takes the opposite answer: it changes what
  everyone sees at the top, so it needs membership and refuses a guest, and taking down a pin that
  is not yours is moderation. `MessageDto.pinned_by` exists so the client can offer what would be
  accepted rather than what would be refused.
  **Adding someone to a channel is moderation**, not a member's errand: being in a channel is not
  the same as deciding who else is, and anyone who had walked into a public one could put anybody in
  it, an external guest included. It takes `is_channel_moderator`, like every other act of
  moderation.
  **A guest moderates nothing**, whatever a channel's own table says: someone who opened a channel
  and was later made a guest kept an `owner` row in it, and with it the right to add and remove
  people in a space they are only visiting. The space role is the outer boundary, and a demotion
  takes back what the old one opened, here as everywhere else.
  **A channel has its own shorter ladder** (`member` < `admin` < `owner`, no guests: being in a
  channel is already the explicit thing a guest is given). `PATCH`/`DELETE
  /channels/{id}/members/{user_id}` set a role and take someone out, under the rule the space roles
  use: only below your own rank, on someone below it. A space owner or administrator counts as the
  channel's owner (`effective_channel_rank`), because someone who may archive it and delete anyone's
  message in it is already at the top of it. No transfer exception here, unlike a space: `owner` is
  the mark of whoever opened the room, the space's administrators moderate it regardless, and a
  channel with nobody holding the title is not stuck the way an ownerless space would be.
  **A channel can be reserved to roles** (`channel_role_access`, one row per admitted role, *no row*
  meaning no restriction, so "open to everyone" and "reserved to nobody" can never be the same
  value). It stacks on the channel type rather than replacing it: the type answers "who may walk in",
  the list answers "who may be in it at all". The list is checked even for someone holding a
  membership row, so a demotion takes back the channels the old role opened; it filters the listing,
  the search, the join, the "add people" call and even the real-time frames. **Both reasons someone
  would not see a channel have to filter those frames**, the reservation *and* being a guest: a
  frame that ignores either one puts a channel in a sidebar that the next page load takes away
  again, which is how a guest was told about every public channel the moment it was created. A list
  that excludes its own author is allowed: a room for the externals, or for the people who run the
  place, is a real thing to want. **The space's `owner` is admitted whatever the list says**
  (`role_admitted`), and that is the only exception: reserving a channel to the administrators used
  to take it out of the owner's own sidebar with no way back that did not go through the API. It
  grants nothing else on a channel's own roles or its audience.
  **The space's owner also reads every private channel**, joined or not (`is_space_owner`, decided
  2026-09-30 after an import left the owner unable to see the private channels they had just
  migrated): it is listed for them, opens, searches, shows its members and can be joined through the
  ordinary membership endpoint. It is reading, not belonging: they are not pushed its messages
  (like a public channel they have not joined) and do not count among its members until they join.
  An administrator is not the owner and still needs an invitation.
  **`guest` is a real restriction, not a label.** For that role every channel behaves like a private
  one: the member reaches a conversation only where they hold an explicit `channel_members` /
  `dm_participants` row, public or not. Everything else follows from that one rule rather than being
  re-enforced: `accessible_conversation_ids` (so search cannot find what opening refuses),
  `visible_member_ids` (the roster, the mention and direct-message candidates, and the profile
  endpoint, narrowed to the people they share a conversation with), `space_co_members` (presence, or
  a guest's socket would enumerate the space by id after the member list stopped serving it), no
  channel creation, no self-join, and no space file tree. A guest still reads a file that hangs off a
  message they can read, which matters because an attachment posted in a *public* channel carries no
  `conversation_id` and lives in the space tree. Before this, `guest` was accepted by the schema and
  read by nothing, so an "external guest" saw exactly what a member saw.
  **An administrator runs a space, an owner holds it.** Three guards, narrowing:
  `ensure_space_member` ("may they see it"), `ensure_space_admin` ("may they run it": invitations,
  roles below their own, removals, moderation) and `ensure_space_owner` ("is it theirs": the name,
  the icon, the transfer, the deletion, and the billing the day it exists). Two roles allowed to do
  exactly the same things would be one role with two names.
  **Roles** (`PATCH /spaces/{id}/members/{user_id}`) run on one rule applied twice: you may only act
  on someone ranked strictly below you, and only hand out a rank strictly below your own
  (`guest` < `member` < `admin` < `owner`, ordered in `authz::SPACE_ROLES`). Nobody changing their own
  role, an admin not naming other admins and not demoting one, and the owner being untouchable are
  all consequences, not separate checks. The single exception is the **transfer**: an owner may set
  someone else to `owner` and becomes an `admin` in the same transaction, so a space always has
  exactly one owner. Invitations cannot grant `owner` either (the schema constrains them to
  `admin`/`member`/`guest`), which is what makes that invariant hold and what lets `leave_space`
  treat "the last owner" as a fact rather than a question. A public channel is joinable by any
  space member; a private one is joined by invitation only, so the join endpoint refuses it. `search` is
  native-Postgres full-text over messages and file names (a generated `tsvector` with a French
  accent-folding config, plus `pg_trgm` trigram indexes for partial/fuzzy matches), scoped by
  membership. `notifications` is a persisted per-user inbox (mentions, DMs, thread replies) written
  inside the send transaction and pushed over the hub. A thread root carries a denormalized
  `reply_count`, moved in the same transaction as the reply that changed it (`adjust_reply_count`):
  posting adds one, deleting takes one back, and deleting an already-deleted row takes nothing, so
  the number the feed shows without reading the thread stays the number of replies there are. It
  also carries `reply_authors`, the last few people who answered (distinct, most recent first,
  capped at `MAX_REPLY_FACES`), so a feed can draw their faces next to that number without one
  request per message on screen. Every mutation authorizes server-side,
  commits, then hands the resulting event to `realtime` for fan-out.
- `src/realtime/`  - real-time transport and presence: `event` (the versioned push envelope + the
  fan-out wire type, including `channel.created` / `channel.updated`, whose payload is deliberately
  the shared `ChannelSummaryDto` rather than a `ChannelDto`: the latter carries per-caller state that
  must not be broadcast, plus `member.joined`, which is space-scoped rather than
  conversation-scoped because an arrival changes the roster, the mention candidates and the DM
  candidates and hangs off no conversation, and `member.updated`, its counterpart for a display
  name, title or avatar changing, whose payload serialises every field including `null` because it
  replaces an identity rather than patching one: an absent avatar has to mean the photo was removed),
  and `space.updated`, the same idea for a space's name and icon, carrying `SpaceUpdatedDto` rather
  than `SpaceDto` because that one holds the caller's role and unread counters, plus `member.role_changed`, which is deliberately not
  `member.updated`: an identity is the same in every space, a role is a fact about one space and
  decides which controls the person receiving it is offered, plus the two
  departure events: `member.left`, the counterpart of `member.joined` for the roster, and
  `space.removed`, which says "this space is no longer yours" to the person who left it and to
  everyone when it is deleted, carrying a `deleted` flag because the client does the same thing
  either way and only the sentence differs), `hub` (the local connection registry plus the Valkey pub/sub bridge; a single
  `SubscriberClient` on `rt:fanout`, delivery gated by a publish-time audience), `presence`
  (ephemeral heartbeat + the persistent `users.manual_presence` override; **its audience is frozen at
  connect time**, computed from the space co-members the user had when their socket opened, so any
  code that changes someone's membership while they may already be connected has to call
  `refresh_and_broadcast` afterwards or the new space will show them offline until it reloads), `typing` (throttled,
  ephemeral), and the two transports `ws` (WebSocket) / `sse` (read-only fallback + typing POST).
  State-changing operations are never accepted over the socket; they are REST handlers in
  `messaging`.
- `src/files/`    - the files feature over the collaboration schema: `authz` (space-membership read
  access, **except a file carrying a `conversation_id`, whose audience is that conversation's**;
  owner/space-admin for mutations), `mime` (magic-byte sniffing + kind mapping), `thumbnail`
  (image decode/resize), `tree` (folder listing, create, rename/move, recursive soft-delete),
  `uploads` (multipart upload), `versions` (the one path every new version and every server-made
  file goes through, announced as `files.updated`), `download` (download/preview/thumbnail, streamed back
  through the API), `shares`, `trash` (the space's trash: a removal's root is marked `trashed`, listed
  with who removed it and from where, restored with everything removed with it, at the root when its
  folder is gone; erasing for good deletes the bytes and keeps the row as a tombstone, `purged_at`,
  an object still used by a living version being kept; an hourly sweep erases what is past
  `RUCHOIR_TRASH_RETENTION_DAYS`, 30 by default, 0 to keep everything), `history` (a file's
  versions, each downloadable; restoring an old one adds a version that copies it, sharing its
  object, so the history stays linear), `links` (public links: managed by the file's managers,
  never a guest, each with an optional end and argon2id password, counted and revoked; answered
  without a session by `links::public_router`, merged in `http.rs` behind the same per-IP rate
  limit as sign-in; a dead link, whatever killed it, is the same `404`; a password earns an hour's
  grant in Valkey that the download carries; `RUCHOIR_PUBLIC_LINKS=false` turns it off; the link
  says how its page can show the file (`preview`), served by `preview`, ranged for players and a
  text always as `text/plain`, `document`, the office file as a cached PDF, and `page`, its first
  page as a cached JPEG; a text upload sniffs as `application/octet-stream`, so a known text
  extension is what makes it a text there), `views`
  (recent, favourites in `file_stars`, shared with me, a search of the whole space by name, each
  entry with its path; `FileDto.starred` is set by the listings that know who asks, never in an
  event a whole space shares), and `routes`. Bytes are proxied through the API (the browser never
  contacts the object store), validated server-side (size + sniffed type), stored under opaque keys
  (`spaces/{space}/{file}/{version}`); image uploads get intrinsic dimensions and a stored thumbnail.
  A message attachment uploads through its **conversation**, not its space, because that is what
  decides its audience: a public channel's attachment joins the space files (in the folder marked
  `system_key = 'attachments'`, found by that marker so renaming it is harmless), while a private
  channel's or a DM's carries `conversation_id`, stays out of the tree and out of search, and is
  readable only by that conversation's participants. An **imported** file follows the same rule
  (`Place` in `importer/run.rs`, shared `uploads::attachments_folder`): it once landed at the root
  of the first space whatever it was, which published private attachments to the whole space.
  `images` is deliberately outside all of this:
  avatars and space icons are not files (`files.space_id` is `NOT NULL`, and an avatar belongs to an
  account), so they live under their own object keys recorded in `users.avatar_key` /
  `spaces.icon_key`, carrying a fresh id per upload so the URL changes with the image.
- `src/storage/`  - the S3 object-store boundary (`S3Store` over `rust-s3`, path-style addressing).
  Built once at startup and held as `AppState.storage: Option<Arc<S3Store>>`: absent when no
  credentials are configured, in which case file metadata still works and the byte endpoints return
  503. `probe()` runs once at startup so a store that is configured but not set up says so in the
  log (naming `scripts/bootstrap-garage.sh`) instead of surfacing as a 502 on someone's first
  upload. Swapping the backend is a config change (`S3_ENDPOINT`/`S3_REGION`/`S3_BUCKET`/
  `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`), never a code change. Dev talks plaintext to Garage over
  the Docker network; `rust-s3` is built without any TLS backend (no `aws-lc-rs`, no OpenSSL), so
  TLS-to-store is a later hardening step (the `ring` path).
- `src/office/`   - live office editing (ADR 0003, `docs/office-editing.md`), on only when
  `RUCHOIR_OFFICE_URL` is set. `discovery` (what the engine opens, read every minute, every five seconds while absent, from its
  `/hosting/discovery`), `tokens` (opaque access tokens in Valkey, one member, one file, never
  logged), `locks` (WOPI locks in Valkey, remembering the version the session started on),
  `wopi` (the internal listener the engine calls, `RUCHOIR_WOPI_LISTEN`, never published; rights
  checked again on every call), `sessions` (opening a file, blank documents from
  `assets/office/`, the editor's heartbeat per tab, the copy a conversion produced), `presence`
  (who is editing, per tab, read for a whole folder at once, with a 30 s sweep publishing
  `files.editing` when a tab dies without a goodbye) and
  `proxy` (the outermost router layer: a request for the office hostname is relayed to the engine,
  HTTP and WebSocket, cookies and credentials stripped, only the editor's paths allowed).
- `src/http.rs`   - router, health endpoints (incl. DB/Valkey readiness probe, shared as `probe`),
  static web hosting, security headers. A page navigation (see `og::is_page_request`: a `GET` with
  no file extension, outside `/api/`, `/_next/`, `/emoji/`, whose `Accept` is missing, `*/*` or
  `text/html`, because link scrapers rarely send `text/html`) is answered by `og::page` with the
  shell and a `200`, because the client resolves the route: the address-confirmation and
  password-reset links the API emails point at paths that are not files in the bundle. Any other
  request for a missing path keeps a truthful `404`, so a wrong asset path fails loudly instead of
  receiving HTML. The `messaging`, `realtime` and `files` routers use
  absolute `/api/v1/...` paths and are merged in (not a second `/api/v1` nest) to avoid path overlap.
  The files router carries a raised request-body limit (`RUCHOIR_UPLOAD_MAX_BYTES`, default 100 MiB).
  `same_site_guard` refuses any state-changing request a browser marks as sent from another site
  (`Sec-Fetch-Site: same-site`/`cross-site`, or an `Origin` that is not `Config::public_origin`):
  the session cookie is `SameSite=Lax`, which does not stop a same-site request, and the office
  editor's hostname is the same site as Ruchoir's. A client that is not a browser sends neither header.
  The real-time socket (`realtime::ws`) refuses a handshake whose `Origin` is not Ruchoir's for the
  same reason: a WebSocket has no CORS, and a page on the office host would otherwise read live messages.
- `src/messaging/unfurl.rs` - link previews, read by this server only (never a third-party service,
  never the readers' browsers). A message's first link outside code is fetched in the background
  after a send or an edit, stored in `message_link_previews`, returned as `MessageDto.link`, and the
  message is pushed again as `message.updated`. **Every fetch is fenced against request forgery**:
  the name is resolved by `PublicOnlyResolver` (plugged into `ureq` as its resolver, so the check and
  the connection use the same answer, redirects included), which keeps public addresses only; ports
  80/443, three redirects, five seconds, HTML only and only up to the end of its `<head>` (2 MiB
  at most: a YouTube video page's head runs past 700 KB); and the instance's own host and parent
  domain are never read (`RUCHOIR_UNFURL_DENY_HOSTS` adds more), because services published next to
  it behind an address filter would otherwise be readable through it. Kept: title, description,
  the site's colour (`theme-color` as plain hex, else the dominant vivid colour of its image) and a
  JPEG thumbnail of its `og:image`, fetched through the same fence, re-encoded (never stored as
  received), kept in the object store under `link-previews/<sha256 of the image URL>.jpg` and served
  by `GET /link-previews/{id}/image` to members of the conversation only. A thumbnail (about 13 KB) is removed from the
  store with the last preview that shows it; every failed fetch is logged as a warning with why.
  `RUCHOIR_UNFURL_ENABLED=false` turns it off.
- `src/og/`       - link preview cards (ADR 0002). `page` adds Open Graph / Twitter tags to the shell
  for the path being opened (home, invitation valid or not, channel or message, space, personal
  email link, status), `render` draws the matching 1200x630 card from an SVG template with `resvg`,
  `text` holds the cards' words in the six languages. **A card never says more than the link:** a
  conversation or a space is anonymous, only a usable invitation names its space and inviter (and
  counts public, active channels only). Language: `RUCHOIR_DEFAULT_LOCALE`. Every asset (fonts, bee,
  emoji, avatars, mark) is embedded from `assets/og` and the image resolver refuses anything else.
  After changing a card or a sentence, `RUCHOIR_OG_DUMP=<dir> cargo test og::` writes them all out.
- `src/notify/`   - reaching someone with no Ruchoir page open (ADR 0001). `prefs`: the notification
  preferences, held server-side, in three layers where **the nearest one that says something wins**:
  the conversation's level (`channel_members` / `dm_participants`: `default`, `all`, `mentions`,
  `none`, plus a mute), the space's (`space_notification_prefs`, no row = default), and the person's
  own (`user_preferences.notifications`: which kinds reach them in the app and push, which by email,
  and whether "every message" is their default). One rule, `allows(kind, prefs, scope, delivery)`,
  is shared by every channel below and mirrored by `passesPref` in the web client. A level of `all`
  creates a notification of kind `message` for every root message of a channel (thread replies
  aside), in `send_message`; it is activity, so the rail's `mentions` counter leaves it out. `vapid` + `push` + `ece`: content-free Web Push (a constant marker, RFC 8291-encrypted, and no
  `Topic` header, which Apple refuses with `400 BadWebPushTopic`); the instance's VAPID key pair is made
  on first use and kept encrypted in `instance_settings`, endpoints are only ever called when their
  host is in `RUCHOIR_PUSH_ALLOWED_HOSTS` (anti-SSRF), and the service worker learns what to draw
  from `GET /push/pending`. `POST /push/test` sends a real push through the whole chain.
  `email`: a sweep a minute that emails one digest per person for what is still unread after
  `RUCHOIR_NOTIFY_EMAIL_DELAY_SECS`, skipping anyone connected, holding back in quiet hours and
  "do not disturb", and deciding each row once (`notifications.email_handled_at`, rows locked with
  `SKIP LOCKED`). A push is sent from `send_message` after the commit, in a background task.
- `src/openapi.rs`- OpenAPI document generated from the code with `utoipa`.

**The permission matrix is tested from the refused side.** `tests_integration` walks one test per
rank (`an_ordinary_member_administers_nothing`,
`an_external_guest_administers_nothing_and_sees_nothing_extra`) through the same list of acts,
because the interesting failure is never "does this endpoint work" but "does it refuse the person it
should". Two-session tests (`two_sessions_see_the_same_membership_change`,
`a_demoted_member_loses_the_space_in_the_same_breath`, `a_guest_is_not_told_about_a_channel_they_are_not_in`)
open real sockets and assert what each side receives, which is the only way the "a frame reached
somebody it should not have" class of defect shows up at all.

The API needs PostgreSQL and Valkey at startup (see `docker-compose.yml`). Migrations live in the
`ruchoir-migration` crate (`../../migrations`): applied automatically in dev
(`RUCHOIR_AUTO_MIGRATE=true`), or explicitly in prod with `ruchoir-api migrate`.

## Conventions

- Run `cargo fmt` and `cargo clippy --all-targets --all-features -- -D warnings` before any
  commit. CI enforces both.
- Add new routes as typed handlers annotated with `#[utoipa::path(...)]`, then register them
  in `openapi.rs` so `/api/openapi.json` stays complete and in sync.
- The API never trusts the client: authenticate and authorize every request server-side
  (when authentication lands).
- Never log secrets, tokens, passwords or private message content.
- **Reject an input you do not recognise; never drain it.** A multipart field or a body key the
  handler does not know is a client sending something it believes matters. Swallowing it turns a
  disagreement into silence: an upload once answered `201` while quietly dropping the folder it was
  given, and the file went to the root of the space with nothing to show for it.
- **Static assets ship with a caching policy, and it is two policies.** The app shell and anything
  whose name does not carry a content hash answer `no-cache`, so a browser revalidates on every load
  and a deployment reaches people; `/_next/static` is content-hashed and answers `immutable`. Serving
  either with no `Cache-Control` hands the decision to heuristic caching, which is how a fixed client
  goes on running its old version for hours after the fix is live.
- **A new value for an existing column needs a migration.** Several text columns are constrained to
  the values that existed when their table was created (`notifications.kind`,
  `message_mentions.mention_type`, `conversations.kind`, `users.manual_presence`). Adding a variant
  in Rust compiles, passes every unit test, and then fails at the insert, taking the whole request
  with it: a new notification kind made sending a message answer `500`. Grep the migrations for the
  column before adding a value to it, and change the constraint in the same change.
- **Presence is evidence, not a timer.** A heartbeat may only be refreshed on proof the client is
  still there (an inbound frame, a pong), and a connection that says nothing for a whole presence
  window is closed. A TTL that a server-side ticker keeps rewriting can never lapse, which is how a
  laptop that went to sleep stayed online for ever. Equally, a manual override says how to read
  someone who is reachable: it must never make an unreachable user look present.

> **Known CSP deviation (temporary).** `script-src`/`style-src` include `'unsafe-inline'` in
> `http.rs` because the Next.js static export emits inline hydration scripts/styles and a static
> export cannot use per-request nonces (without it, the client never hydrates). Planned hardening: inject a per-request nonce into `index.html` and the CSP header at the API layer, then
> drop `'unsafe-inline'`.

## Dev TLS (optional)

Plain HTTP by default. For the HTTPS path: `scripts/dev-tls.sh`, then set
`RUCHOIR_TLS_CERT` / `RUCHOIR_TLS_KEY` and build with `--features tls`. TLS uses rustls
with the community `ring` provider (never AWS `aws-lc-rs`), per the no-US-dependency rule.

## Commands

- Run: `cargo run -p ruchoir-api` (loads a local `.env` via dotenvy; real env vars win). Set
  `RUCHOIR_API_PORT=0` for a random free port when 8080 is taken; the bound port is logged.
- Seed dev data: `RUCHOIR_ENV=dev cargo run -p ruchoir-api -- seed` (applies migrations first,
  then populates a demo workspace; refuses to run outside dev, idempotent).
- Test: `cargo test --all-features` (the migration round-trip test needs
  `RUCHOIR_TEST_DATABASE_URL` and is skipped otherwise).
- Serves `RUCHOIR_WEB_DIST` (defaults to `./apps/web/out`), so build the web app first to
  see the full app locally.
- Optionally serves a self-hosted emoji pack under `/emoji` when `RUCHOIR_EMOJI_DIR` is set
  (layout: `sprite.svg`, `animated/*.png`, `manifest.json`). Kept out of the web bundle because it
  can be large; missing files 404 and the client falls back to native emoji. `ServeDir` guards path
  traversal, and a `Cache-Control: public, max-age=604800` layer caps the pack at a couple of
  requests per client per week (not `immutable`, so a rebuilt pack still propagates).
