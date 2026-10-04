# AGENTS.md - apps/web

The Next.js web client, compiled to a **static export** and served by the Rust API. See
the root `AGENTS.md` for project-wide rules; this file adds app-specific context.

## Hard constraints

- **Static export only** (`output: "export"`): no SSR, no Server Actions, no Next API
  routes, no server-side image optimization. All server logic lives in the Rust API.
  Anything that needs a server goes through `fetch` to the API.
- **No Node in production.** Next.js is a build tool; the output in `out/` is what ships.
- **Self-hosted fonts.** IBM Plex Sans/Mono are served from `public/fonts/` as committed woff2
  (latin subset, static per weight: Sans 400/500/600/700, Mono 400/500/600; OFL, see the README and
  `OFL.txt` there). The `@font-face` rules are in `app/globals.css`, one per weight. Never load fonts
  from Google Fonts or any external CDN. The browser-tab icon is `app/icon.png` (the Ruchoir mark);
  the wordmark and login use `public/brand/ruchoir-mark.png`.
- **CSP is strict** (`script-src 'self'`): any script or viewer must be same-origin, with no
  external request. The API reference is our own renderer at `public/docs/index.html`: a single
  self-contained page that fetches the live spec from `/api/openapi.json` and renders it (no
  third-party viewer, no CDN).

## Stack

- Next.js (App Router) + React + TypeScript.
- Tailwind CSS v4, **CSS-first**: theme tokens live in `app/globals.css` under `@theme`,
  not in a JS config; the full token set is `app/tokens.css`. The palette is the Ruchoir design
  system's (see the root `AGENTS.md`): grey canvas, an ink accent, pastels, and a per-theme `--acc`.
  IBM Plex is the type family. Eight themes, `data-theme` on `<html>`: `sky` (the bare `:root`),
  `mint`, `violet`, `pink`, each also as `<accent>-dark`. A retired theme name (`ruchui`, `light`,
  `dark`, `ruchui-dark`) is read as its successor by `SettingsProvider` and the pre-paint script.
- **A token defined as `var(--x)` is resolved where it is declared.** Redefining `--ink` on an
  element does not change `--text-strong` below it, since that was computed on `:root`. This is why
  the themes live on `<html>` itself, and why a pastel band (`.wc-pastel`, the profile's head)
  restates each text and action token it needs rather than only `--ink`.
- ESLint flat config (`eslint.config.mjs`): import and spread `eslint-config-next`'s native
  flat-config array directly. Do not wrap it in `FlatCompat` (it re-processes an already-flat
  config and crashes under ESLint 10).

> **Gotcha - the lint toolchain lags the newest majors.** `eslint-config-next` 16 pulls in
> `typescript-eslint` and `eslint-plugin-react`, which do not support the very latest majors yet:
> - **TypeScript stays on 6.x**: `next build` works with TS 7 (the native compiler) but
>   typescript-eslint does not (issue #10940), so `eslint .` crashes.
> - **ESLint stays on 9.x**: `eslint-plugin-react` 7.x uses `context.getFilename()`, removed in
>   ESLint 10, so linting crashes under ESLint 10.
> Track the newest versions the whole plugin chain supports, not the absolute newest tags; bump
> once the plugins catch up.

## Commands

- Dev server: `pnpm --filter @ruchoir/web dev`
- Build (static export to `out/`): `pnpm --filter @ruchoir/web build`
- Lint: `pnpm --filter @ruchoir/web lint`
- Responsive audit: `pnpm --filter @ruchoir/web audit:responsive` (run against a live dev server)
- Unit tests: `pnpm --filter @ruchoir/web test`, Node's own runner on `features/**/*.test.ts` (types
  stripped by Node, no dependency). Only pure modules with no imports are tested this way (today
  `features/files/model.ts`): a test imports its module with the `.ts` extension, which is why
  `tsconfig.json` excludes `**/*.test.ts` and the i18n audit skips them.

Permission gates in the shell: `canBrowseSpace` (not a guest) hides the space-wide entries (files,
new channel), and `canAdministerSpace` (owner or admin) hides the space settings and the invitation.
Keep an entry on the same rung as the endpoint behind it: a menu item that can only end in a `403`
reads as a permission the person has, which is exactly what it is not.

Lint gotcha: `react-hooks/purity` reports an error on a line that was already there (typically a
`Date.now()` inside an event handler) when that handler calls a helper declared **after** it in the
component body. The compiler cannot see the helper yet and stops treating the handler as an event
handler. Declare the helper above its callers and the error goes away.

## Dev deep-link

The app is a state machine (auth stage + view + optional modal), not routes. `lib/dev/deeplink.ts`
reads query params (`?stage=`, `view=`, `channel=`, `panel=`, `modal=`, `prefsTab=`, `text=`, `font=`,
`pop=`, `welcome=1`, `push=1`) on mount to land directly on any screen. `stage=` covers the whole
authentication flow (`login`, `signup`, `mfa`, `forgot`, `reset`, `verify`, `onboarding`) plus `app`. `prefsTab=` picks the preferences
section when `view=prefs` (appearance/notifications/shortcuts/security/emojis). `welcome=1` shows the
first-run checklist (a deep-link otherwise forces it hidden so it does not clutter audited screens). In the compact shell `push=1`
opens the content full-screen instead of the
bottom-tab list, so the audit can reach the mobile conversation/content views. It is **development only**: `readDeepLink()` returns `null` under `NODE_ENV=production`,
so the static export ignores it. Used by the responsive audit to reach every state without click
scripting.

## Data seam (real API)

Screens read domain data only through the seam in `lib/data`. Two layers back it:
- `lib/data/http.ts` is the one sovereign fetch client: same-origin, relative paths, the session
  cookie sent automatically, and a typed `ApiError` carrying the HTTP status. The strict CSP
  (`connect-src 'self'`) forbids any cross-origin call, so every path is API-relative.
- `lib/data/api.ts` maps the Rust DTOs (snake_case, UUIDs, RFC 3339, raw byte sizes) to the front
  shapes in `lib/data/types.ts`. It backs auth/session, the space bootstrap
  (`/me/spaces` -> channels/DMs/members/presence/profiles/files), the message operations, files,
  search, the notification feed and the realtime channel (`connectRealtime`).
- `lib/data/index.ts` holds **no fixtures**: it is a thin bridge of registries the app fills from the
  real API for the few values many components read without prop threading (`setCurrentUser`,
  `setChannelMembers`, `setUserPresence`, read back through `getCurrentUser`/`getChannelMembers`/
  `getMentionNames`/`getPresence`). Member profiles are fetched by id via the `useProfile` hook
  (`features/app/useProfile.ts`), with a minimal name-only placeholder while loading.

**A list fed by two sources is merged, never appended to.** The API publishes a realtime frame for a
mutation *before* it answers the call that made it, so the caller's own frame usually arrives first.
Anything that inserts into a list from a response must therefore merge by id, and the response is the
side that wins: it is the complete row, while a frame cannot know whether the person receiving it is a
member, has favourited it, or has anything unread. Appending blindly is what put a newly created
channel in the sidebar twice.

**A menu acts on what it hangs under.** The menu opened from the space's name ended with "sign
out", which closed the whole session from a control about one space: the only way out of a space was
to leave the product. It now offers **leaving the space** (`DELETE /spaces/{id}/membership`, behind a
confirmation, because coming back needs an invitation), and the space settings carry both exits:
leaving again, because the compact shell draws no space menu and leaving must not be a desktop-only
act, and deleting, owner only and behind typing the space's name. Both drop the space through
the same path as the `space.removed` frame, so leaving in one tab, or an owner deleting under
everyone, takes the space off the rail exactly the way pressing the button does.

**A role is held per space, not per account.** The member list in the space settings sets roles
(`PATCH /spaces/{id}/members/{userId}`), and it offers only what the API would accept: the same rank
rule, mirrored client-side as politeness rather than as a guard. Two consequences worth remembering.
The call can change **two** memberships (handing a space over demotes the giver, since a space has
one owner), so apply every row it returns rather than the one that was asked for. And the caller's
own role does not live in the roster: it is `Workspace.role`, which is what decides whether the
space offers its administration at all, so `member.role_changed` for one's own id has to be written
there too, in whichever space it names, open or not.

**A guest is in the space only through what they were added to.** `Workspace.role === "guest"` is
what the column reads to stop offering the space at large: no space files, no new channel, no
invitation. The API refuses all three, so this is not the guard; it is the difference between a
product that does not offer something and one that offers it and then says no.

**Two settings side by side are one setting nobody reads.** A channel's access was drawn as
"visibility" (public/private) and "access by role" in two abstract blocks, and the product's own
owner could not say what the first one changed: whoever configures a channel was left to build a
two-by-two table in their head. It is one section now, asking two concrete questions ("who may be in
this channel?", "how do people get in?") and writing the result underneath as a sentence, including
the asymmetry that matters: a role reservation *takes access back*, visibility never does. When a
control has to stay ticked, do not draw it disabled either: greyed out reads "unavailable", and this
one is the opposite. Say why it is fixed instead.

**The channel settings show the channel's roster, not the space's.** That block used to list every
member of the space with tick boxes that wrote nowhere: it offered to grant and revoke access to a
private channel and did neither. It now reads `GET /channels/{id}/members` and sets what it shows
(role, removal), offering each control only where the API would accept it. The members panel in the
right dock and the header count had the same defect: a private channel with one person in it
announced eight, and a channel reserved to administrators listed the people it is reserved from.

**A design-system control owns its width; the wrapper owns its place.** `.wc-sel` is `width: 100%`
by design, so a width passed to `<Select>` lands on the inner `<select>` while its shell still takes
the whole flex line. In a row, that ate the member's name. Put the width on a wrapping element
(`flex: "none"`), which is what the channel dialog already did. Same discipline for a column that
holds a control on some rows and plain text on others: give the slot the control's height, or the
rows breathe unevenly down the list.

**A screen that seeds state from a prop needs a key when the prop is the subject.** The space
settings hold the name being edited in `useState(workspaceName)`, seeded once. Switching space kept
the previous name in the field, so one space's settings offered to rename it to another's. `key={ws}`
on the screen: the subject changing restarts the state that was derived from it.

**A module-level registry is shared state, so it needs subscribers.** `lib/data/index.ts` holds a few
values read synchronously rather than threaded through props (the member roster, presence by name).
Read as a plain variable they go stale in two directions at once: a reader that captures one in a
`useMemo` with empty dependencies freezes it for its lifetime, and a writer that skips publishing an
empty value leaves the previous space's contents readable. Both happened at the same time in the
mention autocomplete, which offered the people of the first space opened in every space after it.
Subscribe with `useSyncExternalStore`, publish even when empty, and clear on a space switch.

**Presence is observed, not asserted.** The availability entry a user picks (`PresenceChoice`) is an
instruction; the dot anyone sees is the server's answer, computed from that choice *and* a live
connection, and it arrives through the presence map. Never seed a presence from a local default and
never assume a choice took effect: `setMyPresence` returns what the server decided. `auto` sends
`null` and is the default; it is deliberately not named in the interface, where the ordinary
"En ligne" entry is what sends it.

**Sticking a feed to its bottom follows the reader's position, not the item count.** Use
`features/channel/useStickToBottom.ts`. A count-only effect both moves a reader who scrolled up and
misses every late reflow (an image loading, an edit, a reaction wrapping, padding changing), because
it runs during the commit rather than after layout. The feed's inner column is keyed on the
conversation, so the hook observes children as they are added, not only those present at mount:
watching the first one alone left a detached node observed after the first channel switch, and
every later conversation opened on its first message.

**A mention opens a card, not the panel.** Clicking an `@name` in a message hangs the same
`UserProfileCard` as the author's avatar under the mention (`MentionHandler` receives the clicked
element); the full profile in the right panel is the card's next step, so a glance at who someone is
no longer closes an open thread.

`AppRoot` boots against the API: it checks the session (`GET /auth/session`), and on success loads
the first space's channels, DMs, presence, per-conversation feeds and the notification feed before
showing the app; a 401 lands on the real login (`POST /auth/login`), and an unreachable API shows a
boot error. Message ids are UUID strings end to end (`Message.id: string`).

**Authentication flow.** Every screen is wired to the API. Sign-up posts `/auth/register` (which opens
no session; the account is unverified until the emailed link is confirmed, **unless** it registered
from an invitation addressed to that same address, in which case the response comes back `active` and
the client sends them to sign in rather than to a mailbox) and hands over to the
"check your inbox" screen; password reset and email confirmation use the `request`/`confirm` pairs;
and a sign-in that answers with an MFA challenge instead of a session moves to the step-up screen,
which completes `totp`, `recovery` or `passkey` and enters the app the same way a password-only
sign-in does. `AUTH_MESSAGES` in `AppRoot` maps the API's error codes (read with `apiErrorCode`) to
the French copy; the API's own message is English operator text and is never shown.

> **Emailed links are the one exception to "no routes".** The API mails absolute links back into the
> client (`/verify-email?token=…`, `/reset-password?token=…`, `/invite?token=…`, built from
> `RUCHOIR_PUBLIC_BASE_URL`),
> and its static fallback serves `index.html` for any unknown path, so they land on this bundle.
> `lib/authLink.ts` resolves the location into a stage, reads the token into memory and rewrites the
> address to `/` at once, so no token stays in the history, in a copied URL or in a `Referer`. Unlike
> `lib/dev/deeplink.ts` it is a production affordance. `lib/webauthn.ts` holds the only WebAuthn
> plumbing: base64url between the API's JSON shapes (`webauthn-rs`) and `navigator.credentials`.
>
> An invitation link is the one of the three that can also apply to someone already signed in, so it
> resolves its token first (the preview endpoint needs no session), joins the space straight away
> when a session is open, and otherwise holds the token in memory across sign-in or registration.
> `enterApp` accepts it before loading the spaces, which is why an account created from an invitation
> lands inside that space instead of in the empty-shell onboarding. It is the one token held in
> `sessionStorage` rather than only in memory (`rememberInvite` / `forgetInvite`), because
> registering from an invitation means confirming the address, and that second emailed link reloads
> the bundle: an in-memory token would not survive it. Tab-scoped, guarded on every access, and
> dropped once accepted, refused, abandoned or signed out of. The arrival then reaches everyone
> else as a `member.joined` push, which patches the roster in place (kept sorted) rather than
> refetching it: that one list also feeds the mention autocomplete and the direct-message candidates.
> `member.updated` patches the same roster when someone edits their profile or replaces their photo,
> and `space.updated` patches the space list when a space is renamed or its icon replaced, touching
> only the shared fields: the counters and the caller's role are not in the event, because they
> differ per recipient, so whatever the client already holds for them stands.
> The realtime handlers are wired once per session, so anything they call that changes every render
> (`showToast`) goes through a ref, not through the effect's dependencies.

The tab title is set from `AppRoot` rather than from Next's metadata, which only names the document
at build time: it carries the account's unread count, the conversation or screen on show, the space,
then the product name, so a background tab says what is waiting and where. The screen names live in
`VIEW_TITLES`, shared with the compact top bar so the two cannot drift.

An uploaded avatar reaches a component in one of two ways, and which one applies is decided by what
the component already holds. Where a member record is on hand (the member list, the mention
autocomplete, a message row) the URL is threaded through as a prop. Everywhere else the component
knows only a display name (a notification's actor, a search hit's author, a file's uploader), so it
reads `getAvatar(name)` from the data seam, exactly as it reads `getPresence(name)`. Passing neither
is what silently draws the generated avatar over a real photo, so a new `Avatar` rendered for a
person should always do one or the other.

The personal security section of the preferences (TOTP enrollment, passkey list, recovery codes) is
still on its mock model (`features/app/security.ts`); the endpoints it needs
(`/auth/mfa/totp/enroll|confirm`, `/auth/mfa/passkey/register/*`, `/auth/mfa/recovery-codes/generate`)
exist but are not wired yet. The onboarding flow likewise stays local: creating the first space needs
a space-creation endpoint the API does not expose yet, so registration hands over to the email
confirmation instead.

**Space and channel lifecycle.** Creating a space (`POST /spaces`), creating a channel, saving its
settings (`PATCH /channels/{id}`, including archiving) and joining or leaving one all go through the
API. Two consequences the UI reflects: the server normalises a channel name into a handle, so the
row added to the sidebar carries the name it will keep rather than what was typed; and leaving a
public channel only drops the membership, so the channel stays readable in the sidebar and the menu
offers to rejoin it (`Channel.member`) instead of vanishing. An archived channel is read-only
server-side, so `ChannelScreen` replaces its composer with a note. Switching space in the workspace
rail reloads that space through `loadSpace` (channels, DMs, members, presence, files, feeds): the
loader is shared with the boot path. An account that belongs to no space lands on onboarding, which
creates its first one, rather than on an empty shell.

**Realtime.** `connectRealtime` opens the WebSocket (`/api/v1/realtime/ws`, cookie-authenticated on
the upgrade), reconnects with a capped backoff, pings to hold presence, and dispatches decoded
`RealtimeEnvelope` frames into `AppRoot` state: `message.created/updated/deleted` (upserted, de-duped
by id against the optimistic row), `reaction.added/removed` (other users' deltas only; our own are
optimistic), `presence`, `notification.created`, `typing`, and `channel.created` / `channel.updated` (a channel
appears, is renamed, archived or restored without a reload; one turned private leaves the sidebar of
everyone who is not in it, which is the only way they learn they lost access). Those two carry only a
channel's shared facts, so the client patches name/type/topic and keeps its own membership, favourite
and unread state. Mutations still go through REST; the
socket only receives, plus sends typing/ping. The composer emits a throttled typing signal via
`rtRef.current.sendTyping`.

**Links leave through a warning.** One capture-phase `click`/`auxclick` listener in `AppRoot`
catches every link to another origin, wherever it is drawn, and shows `ExternalLinkDialog` (the
host on its own line, a flag for punycode look-alikes, a few safety tips, the alarmed bee
`public/brand/mascot-bee-alert.svg`). "Do not show again" and Preferences > Security both write
`settings.externalLinkWarning`. Link previews (`LinkPreviewCard`) come from the server with the
site's colour and a same-origin thumbnail; the browser never loads anything from the site.

**Notifications with the app closed (installable PWA + Web Push, ADR 0001).** `public/manifest.webmanifest`
and `public/icons/` (plus `app/apple-icon.png`, drawn by `scripts/build-pwa-icons.mjs`) make the
app installable; `public/sw.js` is a plain, unbundled service worker registered on every load. It
caches nothing and intercepts no request (a worker serving stale bundles would hide deployments). A
push carries no content (a constant encrypted marker, ignored): the worker wakes, calls `GET /api/v1/push/pending` with the session cookie,
and draws what comes back (already worded in the account's language and filtered by its
preferences); a click focuses an open window and posts it `ruchoir:open-notification`, or opens
`/?open=space.conversation.message.notification`, which `AppRoot` resolves through `pendingOpen`
(switch space first, then open like an inbox click). `features/app/webPush.ts` owns the
subscription: opt-in from the preferences or the one-time prompt, re-synced once per session, and
forgotten on logout. **While push is active in a browser, the page draws no system notification of
its own when away** (`alertRef`), or every message would show twice. Levels inherit: a conversation on `default` follows its space (`Workspace.notifyLevel`, set from the
space menu), a space on `default` follows the person's own preferences (the kinds table in
Preferences > Notifications). `effectiveLevel` resolves it and `passesPref` applies it; both mirror the
server. The notification preferences
are **server-side** now (the server obeys them for pushes and emails): the global ones are read at
sign-in and every change is sent back (with the device's UTC offset, which is how the server reads
quiet hours), and each conversation's arrives with `ChannelDto` / `DirectMessageDto` and is saved
with `PUT /conversations/{id}/notification-preference`. The preferences' push test goes through the
server (`POST /push/test`), so it proves the path a closed or installed app depends on.

**A thread reply is held with its conversation, and kept out of the feed.** Replies live in the
same `messages[conversationId]` list as everything else, which is what lets a reply be reacted to,
saved, edited or deleted through the very same handlers as a message in the channel (they all look
the message up in that list). The feed is where they come back out: `feed` filters `!m.parentId`,
and `threadReplies` is the same list filtered the other way. `ThreadPanel` draws them with
`MessageRow`, which drops what only the feed can mean (`inThread`: no thread of its own, no "unread
from here", no pin).

Three things follow from replies being in the list but not in the feed. A `message.created` frame
carrying `parentId` moves no unread badge and no read cursor: the history endpoint and the server's
unread counters both filter on a null parent, so counting one here would only disagree with the
server. The root's `replies` counter and its `replyAuthors` faces are moved client-side
(`adjustReplyCount`), on arrival and on our own send, since our own message is never echoed back to
us; a deletion takes one off the counter, the way the API takes it off the stored one. And a thread
is read into the list by `loadThread` when it is opened, because the conversation's own history
never carried it.

The member roster is loaded from `GET /spaces/{id}/members` and published into the mock seam via
`setChannelMembers`, so the member list, the `@`-mention autocomplete and the people search read the
real members synchronously through `getChannelMembers`/`getMentionNames`. The signed-in user's name is
likewise pushed with `setCurrentUser` so `getCurrentUser()` (message ownership, "my profile", thread
author) reflects the real session, not the mock. Reactions carry their reactor names
(`ReactionDto.users`) for the hover tooltip and the "see reactions" list. Opening a new DM by name
uses the get-or-create `POST /spaces/{id}/dm`; editing one's own profile persists via
`PATCH /users/me`; a file's import badge shows the real connector (`FileDto.imported_source`).

**Remaining gaps are architecture decisions, not wiring.** `readBy` per-message receipts are not
shown (the backend deliberately keeps a light per-conversation read cursor instead); link unfurls are
not rendered (the `message_link_previews` table exists but nothing populates or exposes it, and
server-side link fetching needs a sovereignty/SSRF design first). A member profile still falls back to
the mock by name only when no user id is resolvable for them (the member list now supplies ids).

## Calendar screen (`features/calendar/`)

One screen, two doors: a space's "Calendar" entry opens it filtered on that space, the phone's
"Calendar" tab on the last filter chosen (`localStorage`). On a desktop and a tablet the calendar's
own column (a way back to the space, a small month, the calendars) takes the place of the space's
column while it is open, as calendars do, rather than adding a second one beside it; on a phone the
same list opens as a panel from the header. Outside the filter, occurrences stay drawn,
hatched grey; the viewer's own calendars are always in full. Times are drawn in the profile's time
zone, else the browser's.

- Pure logic, imported by nothing and tested with `node --test`: `model.ts` (days and periods in a
  time zone with `Intl`, `inFilter`, `layoutDay` placing overlapping events side by side, `occursOn`),
  `rule.ts` (RRULE value <-> the repetition form; a rule the form cannot show reads as `null`) and
  `rulePhrase.ts` (the rule in words, from whole sentences per language under `calendar.rule.*`).
  `rule.ts` does not import `model.ts`: Next's TypeScript settings refuse the `.ts` extension Node's
  runner needs.
- `CalendarScreen.tsx` assembles; `TimeGrid` (week, day), `MonthView` (desktop cells, phone dots),
  `ListView`, `CalendarSidebar` (with `FilterChips` and `MiniMonth`), `CalendarOverlays` (the windows: `EventDetails`,
  `EventForm` with `RecurrenceEditor` and `SeriesScopeDialog`, `CalendarSettingsDialog` with the
  subscription `FeedsSection`). Data: `lib/data/calendar.ts`; live changes arrive as
  `calendar.changed` through `lib/calendarEvents.ts` and reload what is on screen.
- Invitations: `AttendeesField` (guests as chips, searched as one types or typed as an address),
  `AvailabilityStrip` (a line per person on the event's day, from free/busy), "Find a time" built on
  `freeSlots` in `model.ts`, the answer in `EventDetails` and in the inbox, and the public page
  `app/i` (`PublicInvitationScreen`). An occurrence's `myStatus` draws its look (`chipStyle`).
- Preferences live in `prefs.ts` (pure, tested by `prefs.test.ts`) and in the device's settings.

## Files screen (`features/files/`)

The space's files, shown one folder at a time as a Drive shows them. `FilesScreen.tsx` only
assembles; each part has its own file:

- `model.ts`: the pure logic, with no imports (tested by `model.test.ts`): ordering (folders first,
  numeric collation), the accent-blind filter, `canManage`, `actionsFor` (the actions an entry offers,
  in menu order) and selection ranges. Every surface asks it the same questions.
- `useFolder.ts` (a folder kept current, live events included), `useSelection.ts` (click, Ctrl/Cmd,
  Shift ranges over the visible order), `useDragMove.ts` (dragging entries onto a folder or a
  breadcrumb step), `useLongPress.ts` (a phone's selection gesture).
- `FileTable.tsx` (desktop: sorted headings, a click on the name opens, elsewhere selects, double
  click opens, right click opens the menu at the pointer, roving focus and keys), `FileRows.tsx`
  (phone), `FileGrid.tsx` (folders as tiles, then files as cards), `FileName.tsx` (a name cut from its
  end with its extension kept).
- `ActionMenu.tsx` draws an entry's actions as a `MenuPopover` or, on a phone, a `Sheet`; `NewMenu`,
  `MoveDialog` (walk the tree, folders being moved greyed out), `DetailsPanel`, `FileDialogs`
  (rename, delete), `FilesHeader` and `Breadcrumb` complete it.

**Uploads** go through `lib/uploads.ts`, an app-wide queue (a module store read with
`useSyncExternalStore`), so sending survives a change of folder or of screen; `UploadPanel` (mounted
in `AppRoot`'s overlays) shows it. Files go three at a time over `XMLHttpRequest` (`sendFile` in
`lib/data/api.ts`), the only browser API that reports upload progress. `useUploader` turns "these
files into this folder" into queue entries: what is over `upload_max_bytes` (from `/instance`) is
refused at once, a dropped or picked folder has its tree made (a folder already there under the
same name is reused, not doubled), and a taken name asks "replace, keep both or skip". The pure part
(`uploadPlan.ts`) is unit tested. A drag from the desktop carries `Files` and is an upload; a drag of
entries carries `application/x-ruchoir-files` and is a move: targets tell them apart by type.

**Trash and versions.** Removing puts entries in the trash at once, with no confirmation, and the
toast carries "Undo" (`Toast.action`); only erasing for good and emptying the trash ask first. The
files screen has two views, "All files" and "Trash" (`TrashView`, its own list, menus and notice of
the retention from `/instance`). A file's versions are in its details (`VersionsSection`), reached
from the details or the "Versions" action; bringing one back is offered to whoever may replace the
file. The open folder drops what `files.deleted` announces.

**Sharing.** "Share" (files only) opens `ShareDialog`: sending the file into a conversation (a message
carrying it as an attachment; the space's members already see its files, so this is how one shows
a file to someone) and, for whoever manages it, public links. A public link's page is a static page
of its own, `app/s/page.tsx` (`/s/?t=<token>`, exported like `/status`, so it needs no session and
loads none of the app): `features/share/PublicShareScreen.tsx`. The dialog lists every
conversation in one scrolling list, grouped as the sidebar is (favourite channels, direct messages
from the most recent, channels by name), the search narrowing it. The public page shows the file
the way its link's `preview` says: an image whole, a PDF or an office document in a frame (the
document converted to PDF by the API), a video or a sound in the browser's own player, a text in a
`<pre>`; on a phone, a document is its first page as a picture that opens the whole PDF, and a PDF
an icon with "Open" (a frame shows a PDF's first page at best there, and no PDF library is
allowed). Anything else keeps its icon and the download.

**Views.** The row of views is All files, Recent, Favourites, Shared with me, Trash (a row that
scrolls sideways on a phone, `.wc-tabs--scroll`). The search field searches the whole space (server
side, `useView`), whichever view it is typed in; a search, Recent, Favourites and Shared with me are
"flat" lists whose entries say where they live (`Item.location`), and opening a folder from them
goes to it in All files. Uploading by drop and moving by drag only happen in a folder. A favourite
is the person's own: a space's `files.updated` event keeps the star the list already had.

**Rights are computed on the client** with the server's own rule (`canManage`: the entry's owner, or
an owner or administrator of the space, as `authz::ensure_readable`'s `can_edit`). They are not sent
per entry because `files.updated` reaches every member with one payload. Rename, move, delete and
"new version" are only offered when `canManage` holds, in every surface (menus, selection bar,
keyboard, drag); the server still decides, and a refusal is still reported.

Gotcha: never mix a `border` shorthand with a `borderColor` that changes in the same style object.
When the colour goes back to `undefined`, React removes `border-color` and the border falls back to
the text colour (black cards after a hover). Write the three longhands instead.

## Responsive shell

Below ~960px (`useCompact()`), `AppRoot` switches from the desktop three-column shell to a compact
Slack-style layout: a `MobileTopBar` (workspace mark opens the rail drawer; back arrow when a
conversation/view is pushed), a single full-width body that shows either the current list or the
pushed content, and `BottomTabs` (Canaux / Messages / Activité / Recherche). The workspace rail is a
left `Drawer` (DS); the channel right-panel (`RightDock`) becomes a full-width overlay via
`ChannelScreen compact`. `Sidebar` takes `compact` (full width, no wordmark/header/search) and `only`
(render just one section for a bottom-tab). At and above ~960px the desktop columns are unchanged.
Breakpoint chosen from the audit (content breaks up to ~900px). Responsive views take a `compact`
prop: `FilesScreen` (rows instead of the table, sheets instead of menus, a floating "+"), `WorkspaceSettings`
(sub-nav wraps above the panel; rows wrap), `ChannelScreen` (header actions in a horizontal scroller,
title/topic truncate). The channel right panel defaults to closed (`panel: null`) and `openChannel` resets it, so you land on
the conversation, not a full-screen dock, and a panel opened in one channel does not carry into the next. Below 600px `.wc-dlg` becomes a full-width bottom sheet whose
body scrolls (first width `@media` in the app, in `components.css`); the top-bar actions are 44px on
mobile. Action fills are the ink (`--action-primary-bg`), with white text; the brand terracotta only
draws the wordmark's point. `--text-subtle` is the muted grey `#5a6070` (6.1:1 on the canvas) so small
subtle labels clear AA on light surfaces. The responsive audit measures overlap on VISIBLE (clip-intersected) rects, so controls
scrolled under a bar are not false positives. Remaining touch-target
(<44px on dense secondary icons) and tiny-text (11px labels) findings are a deliberate density trade-off,
not bugs.

## Responsive audit (`tools/responsive-audit/`)

Automated responsive stress test: sweeps every UI state across a wide viewport matrix (320 -> 3840,
both orientations, zoom levels, breakpoint neighbours), runs an in-page probe, screenshots the
suspect combinations, and writes `report/report.{json,html}`. Exits non-zero on a critical issue or
JS error (CI-gateable). Beyond mechanical layout it also runs UX/a11y checks (finding
`category: "ux"`): low-contrast (WCAG AA), tiny text (<12px), and dialogs taller than the viewport. See its `README.md`. Depends on **Playwright** as a dev-only dependency:
Microsoft (US) governance, flagged under repo rule #2, kept out of the production runtime/export
(locally-executed QA tooling only, consistent with the rule that targets runtime
services/infra, not locally-executed open-source tooling). Install:
`pnpm --dir apps/web add -D playwright && pnpm --dir apps/web exec playwright install chromium`.

## Design system

The UI shell was built first on mocked data, as an exploration ahead of the backend. Recreate
mockups faithfully in React; do not copy prototype internals when they do not fit. Enforce token
usage with the design-system oxlint config.

- **Tokens** live in `app/tokens.css` (the full DS variable set as `:root` custom properties)
  plus a brand subset mirrored in `app/globals.css` `@theme` for Tailwind utilities. Component
  styles are in `app/components.css`, ported once into static CSS (the handoff injected them at
  runtime; we do not, to stay static-export- and CSP-safe).
- **Primitives** are in `components/ds/` (import from `@/components/ds`).
- **Icons: `lucide-react`** (ISC, community-governed), rendered as inline SVG via the map in
  `components/ds/Icon.tsx`. The handoff's `Icon` loads Lucide from `unpkg.com` at runtime: do NOT
  copy that, it breaks sovereignty and the strict CSP. Likewise the handoff's `tokens/fonts.css`
  pulls IBM Plex from Google Fonts: ignore it, fonts are self-hosted (see above). Extend the icon
  map rather than reaching for a URL.
- **No remote media.** In the exploration, images/media are rendered from local sources (inline
  SVG, or same-origin bytes later), never a remote `<img src>`: sovereignty + CSP. See
  `features/channel/InlineImage.tsx` for the pattern.
- **App code** is organized as `features/<area>/` (screens) reading domain data only through the
  data seam `@/lib/data`, never from `lib/mock` directly (this is what lets us later swap mocks for the
  real API without touching views).
- **Floating UI** (menus, emoji picker, profile card) uses `components/ds/Popover.tsx`: portaled to
  `body`, `position: fixed`, viewport-aware (flips/clamps so it never overflows). Do not hand-roll
  absolute-positioned popovers. Enter/exit animations go through `features/app/useMountAnimation.ts`
  plus the `wc-pop` / `wc-dock--in|out` classes in `components.css` (all honour reduced motion).
- **Emoji** render through the `features/app/Emoji.tsx` component as same-origin Fluent assets when
  the self-hosted pack is present, falling back to the OS-native glyph otherwise. Never a remote
  emoji CDN. The component consults the pack manifest (`features/app/emojiManifest.ts`, fetched once
  from `/emoji/manifest.json`) so it only ever requests an asset that exists: static glyphs come from
  a single shared sprite via `<use href="/emoji/sprite.svg#e{codepoint}">` (one cached request for
  the whole picker, prefetched on manifest load), and animated APNGs (`/emoji/animated/{codepoint}.png`)
  are requested only for the curated codepoints that have one. Codepoint key from `lib/emojiCode.ts`.
  This avoids the old one-image-per-tile pattern and the doomed animated requests that flooded the
  network and flickered when the picker opened. Animation is **opt-in per call site** via the
  `Emoji` `animated` prop (default off) and reserved for reaction surfaces: the reaction pills and the
  reaction picker + quick-reaction row (`ReactionMenu` passes `animated` to `EmojiPicker`). Each
  reaction pill is a `ReactionPill` (`features/channel/ReactionPill.tsx`) that plays the animation for
  3s the first time it scrolls into view (message seen), then settles to the static sprite; while the
  whole pill is hovered the animation plays continuously and freezes again on mouse leave. Toggling
  `Emoji`'s `animated` flag remounts the APNG node, so a flip restarts it from frame 0. The picker
  animates while it is open. Message bodies and the composer's emoji picker stay on the static sprite.
  It is still gated by the `emojiAnimated` user setting. `:shortcodes:` resolve via `node-emoji`, in-text emoji are detected with `emoji-regex`.
  The pack is built by `scripts/build-emoji-pack.sh` (one-shot: sparse-clones the Fluent repos without
  the ~5GB, then runs `scripts/prepare-emoji.mjs`, which emits `sprite.svg` + curated `animated/*.png`
  + `manifest.json`) into `public/emoji/` (dev, gitignored) or a dir behind the API's
  `RUCHOIR_EMOJI_DIR` (prod). Fallback chain per emoji: animated (reactions, opt-in) -> static
  (sprite) -> native. Emoji picker data/keywords live in `lib/emoji.ts`.
- **User settings** live in `features/app/settings.tsx` (`SettingsProvider` + `useSettings`,
  persisted to localStorage): theme, typeface, text size, notification prefs, account security,
  emoji animation, the simulated pack-present flag, keyboard-shortcut bindings, and the dragged
  width of the thread panel (`threadWidth`, bounded by `THREAD_WIDTH_MIN`/`MAX`, written on mouse-up
  rather than on every move). A layout the reader adjusts by hand belongs here: one that lives in a
  component's state has to be adjusted again at every reopening.
- **Keyboard shortcuts.** Commands and their default chords live in `features/app/shortcuts.ts`
  (`COMMANDS`, `DEFAULT_BINDINGS`, plus `eventToChord`/`formatChord`; `Mod` = Cmd on macOS, Ctrl
  elsewhere). Bindings persist in the settings and are user-editable in Préférences > Raccourcis
  (`ShortcutsSection` in `PreferencesScreen.tsx`, capture-to-rebind). `features/app/useGlobalShortcuts.ts`
  matches keydowns against the live bindings and runs the handler wired in `AppRoot`; it is suspended
  while any modal/dialog/preferences overlay is open. The `HelpDialog` shortcut list reads the same
  live bindings. The quick switcher (`QuickSwitcher.tsx`, default `Mod+J`) jumps to a channel/DM;
  global search (`GlobalSearchDialog.tsx`, default `Mod+K`) spans messages/files/people. Both support
  arrow + Enter selection.
- **Avatars** are generated locally with DiceBear (`lib/avatar.ts`, `@dicebear/core` v10 +
  `@dicebear/styles` JSON defs), seeded by name, cached, emitted as data URIs (no remote request).
  Styles by subject: person=cameo, bot=gaze, workspace=blobs. Person/bot backgrounds are lively
  pastels chosen for face contrast and **never red** (red reads as an alert).
- **Message text** is rendered by `features/channel/richText.tsx` (bold, italic, inline + fenced
  code, links, "- " and "1." lists, "- [ ] " checklists, "> " quotes, "## " headings, @mentions and
  #channels), building React nodes. A heading starts at two hashes, never one: a single `#` names a
  channel here and in the composer. A **pipe table** (header row, a dashed separator row, then rows)
  is drawn as a table inside its own scroll box, and a named link `[words](https://address)` shows
  its words with the address on the tooltip (http and https only). Nothing else of CommonMark is
  read: no backslash escapes, no nested lists.
- **A checklist in a sent message is ticked in place.** The boxes are the DS `Checkbox`, never a bare
  input (the browser's own is unthemed and a different shape per platform), and the item's text is
  the label, so the sentence is part of the target. Ticking one is an **edit of the body**: it flips
  that line's `[ ]` to `[x]` and goes through `editMessage`, which is why it is offered on your own
  messages only, the API taking an edit from the author alone (`PATCH /messages/{id}` answers 403 to
  anyone else). Elsewhere the box is `disabled`, which the shared rule already draws as "ticked but
  not yours" without dimming the text around it. `renderRichText` takes a `TaskToggle` receiving the
  **line number within the whole body**, counted across the ``` fences (`lineBase`), so a code block
  in the middle does not shift what a click changes; the handler re-reads that line and does nothing
  when it is no longer the item that was drawn. The only `dangerouslySetInnerHTML` is
  highlight.js output for fenced code blocks (`highlight.js`, BSD-3, local, language auto-detect) and
  is safe because highlight.js escapes the code. The composer emits this same lightweight markdown.
  Render message bodies in a `<div>`, never a `<p>` (fenced code / lists produce `<pre>`/`<ul>`,
  which are illegal inside `<p>` and cause a hydration error). A message that is **emoji-only** (only
  emoji + whitespace, no fenced code) renders them larger, tapering with the count (1 -> 44px, 2-3 ->
  36px, 4+ -> 28px; `jumboEmojiCount`/`emojiSizeFor`). Every message emoji shows its `:shortcode:` on
  hover in a styled DS `Tooltip` (not the native `title`), the label from `shortcodeOf` (node-emoji
  `which`).
- **Message input** is a shared rich editor, `features/channel/MessageEditor.tsx`, used by both the
  channel `Composer` and the `ThreadPanel` reply box (the `ProfilePanel` bio stays a plain `Textarea`,
  it is not a message field). It is an **uncontrolled contenteditable** (`.wc-rich-input`), not a
  textarea, so it can render inline Fluent emote **chips**: picking or typing an emoji inserts a
  `contentEditable=false` span carrying `data-emoji` (built by `features/channel/composerEditor.ts`,
  static sprite). `onSend` receives the **serialised plain text** (emotes back to their Unicode glyph,
  `<br>`/blocks to `\n`), so the message pipeline and `richText` rendering are unchanged. The
  surrounding toolbar drives the editor through a ref handle (`MessageEditorHandle`:
  `submit`/`insertEmoji`/`insertText`/`insertTrigger`/`wrapSelection`/`prefixLines`/`numberLines`/
  `codeFormat`/`blockCode`/`isEmpty`/`clear`). Every block tool opens its own line when the caret is
  mid-sentence, because a marker only reads as one at the start of a line; `numberLines` continues
  from the item above instead of writing "1." every time; `blockCode` inserts the fences as a single
  text node (the editor is `white-space: pre-wrap`) so the caret can land between them. `isEmpty`/`clear` let the `Composer` send an attachment-only
  message (empty body) and reset after. Paste is coerced to plain text; caret/offsets are mapped by
  serialising the range from the editor start to the selection focus (`editorState`).
- **The composer toolbar groups its variants, and folds below 640px.** Eight of its fourteen buttons
  were variants on three ideas (three heading levels, three list kinds, two ways to write code), and a
  row that long reads as a wall rather than a set of choices. Each of those is now one button opening
  a small menu (`FamilyMenu` + `FAMILIES` in `Composer.tsx`), leaving bold, italic and quote one click
  away: eleven controls instead of fourteen. Below the breakpoint even that is too wide, so the whole
  lot collapses into one "Mise en forme" menu (`FORMAT_SECTIONS`). Both shapes are composed from the
  same `BlockTool` constants, so a tool added to a family appears in both places or in neither, and
  each tool acts on the editor it is handed rather than closing over the ref (the React compiler
  refuses a ref read during render). The breakpoint is the toolbar's own, not the shell's 960px: the
  row still fits on a tablet.
- **Screens & shell state.** `features/app/AppRoot.tsx` is the client spine: it lifts the seed
  collections (workspaces, channels, DMs, files, and a full per-conversation message map) into
  `useState` so the UI can mutate them, gates the app behind an `authStage` state machine
  (`login -> signup -> onboarding -> app`; boots at `app`, logout returns to `login`), and routes
  every global dialog through a single `modal` union. The auth/onboarding screens live in
  `features/auth/` (`AuthShell` centered layout, `LoginScreen`, `SignupScreen`, and the multi-step
  `OnboardingFlow` that creates the first workspace). Screens live in
  `features/{auth,files,import,settings}/` and `features/channel/`; the Threads/Mentions/Saved views
  are `features/app/ActivityView.tsx` fed by the cross-conversation collectors in
  `features/app/activity.ts`. Small global dialogs (new channel/message/workspace, invite, help) are
  grouped in `features/app/dialogs.tsx`; channel-menu dialogs in `features/channel/ChannelDialogs.tsx`;
  workspace-wide search in `features/app/GlobalSearchDialog.tsx`. A conversation is a direct message
  when its id matches a DM (ChannelScreen takes an optional `dm` prop and adapts its header/intro).
- **Addresses.** `lib/spaceUrl.ts` is the only routing the app has: it reads the open space and
  channel out of the location and writes them back with `replaceState`, never `pushState`, so a
  conversation can be bookmarked and shared without the shell pretending to be a router. The space is
  carried by whichever of the host and the path has it (`/e/atelier/c/general` today, and
  `atelier.ruchoir.fr/c/general` once spaces get subdomains); both forms are read forever and the same
  rule governs writing, so the client will switch on its own with no flag. A host label counts as a
  space only when it matches a slug the account belongs to, which is why no list of reserved
  subdomains is needed and why resolution runs after `/me/spaces` has loaded.
- **Downloading or opening a file is a navigation, so it is an `<a>`.** `IconLink` is the DS primitive
  for that: it shares `IconButton`'s styling without nesting a `<button>` inside a link, which is
  invalid markup and announces two overlapping controls. Reach for it whenever an icon-only control
  navigates rather than acts.
- **The composer uploads on pick, not on send.** A picked file is stored straight away through
  `POST /conversations/{id}/attachments` and the message then carries only its id, so a slow upload
  never blocks the message and a refused one is reported while there is still something to do about
  it. Sending is disabled while any upload is in flight, because there would be no id to attach.
  File picking, dropping and clipboard paste can overlap, so this is tracked as a count rather than
  a boolean: the first group to finish must not re-enable sending while another is still moving.
  The editor also refuses Enter during that interval and keeps its text intact.
- **A message renders every attachment array entry.** `Message.attachment` and `Message.image` are
  first-item compatibility aliases only; full message rows and pinned-message panels read
  `attachments` and `images`, falling back to the aliases for old fixture rows. File cards constrain
  every flex child and ellipsize the original name on one line, so a long name never pushes its
  actions away.
- **A picked avatar or space icon goes through `ImageCropDialog` before it is uploaded**, because
  both are only ever shown as squares and leaving that to CSS means nobody chose the framing. The
  server centre-crops anyway, as the guarantee; the dialog is what decides *which* square.
- **Avatars and space icons are always a URL the server returned**, never a local object URL: those
  vanish on reload and would show a picture that was never stored. Each screen keeps a three-state
  override (uploaded / removed / unchanged) so "removed" is distinguishable from "never had one".
- **No shortcut is ever bound to a digit.** Every modifier plus a digit is some browser's own tab
  switching (Alt under Firefox on Linux, Ctrl under Chrome), and on AZERTY the digit row needs Shift,
  so `e.key` is `&` where the label says `1`. The chord registry is built on `e.key`, so a digit
  binding is wrong twice over.
- **`loadSpace` loads a space in three waves, not one batch.** Blocking: channels, DMs, members and
  presence (members are needed to render any message row). Blocking and small: the messages of the
  conversation being opened, after which the space is usable. Background: the other conversations'
  messages, the notification inbox and the space files, none of which is on screen yet. Each wave
  re-checks `loadingSpaceRef` before writing state, so a switch started mid-flight is never
  overwritten by the slower one it interrupted. Do not move a request back into the first wave
  without asking what on the first screen cannot be drawn without it.
- **`booting` unmounts the entire app** for the full-screen boot card, so it is for the first load
  only. A space switch raises `switchingSpace` instead, which fades the sidebar and content and keeps
  the rail live; routing it through `booting` blanked the window on every switch.
- **The workspace rail carries two counters per space**, not one: a number only for `mentions` (the
  notification inbox) and a discreet ringed dot for `unread` activity. A single "unread messages"
  figure is noise, and the open space shows nothing at all because its per-channel badges are already
  in the sidebar. Events for a conversation the client has not loaded cannot be attributed to a space,
  so they trigger a debounced re-read of `/me/spaces` rather than widening the realtime payload. The
  counters are also re-read when leaving a space, because the space you are in shows no indicator, so
  anything you read in it never reached the rail on its own.
- **DS primitives now include** `Checkbox`, `Radio`, `Switch`, `Select`, `Field` and `Dialog`, ported
  from the handoff into typed React with their CSS appended to `app/components.css` (the handoff
  injected it at runtime; we do not). `Dialog` is the shared modal base (scrim + head + body + footer,
  closes on scrim/Escape); reuse it rather than hand-rolling a scrim.
- **First-run onboarding.** The signup wizard is `features/auth/OnboardingFlow.tsx` (workspace name,
  profile, invites). Inside the app, `features/app/GettingStarted.tsx` is a floating, collapsible
  checklist (create a channel, send a message, invite, import, profile) whose state persists in
  `settings.welcome` (`{ dismissed, done }`). Clicking a step runs the real action and ticks it off;
  the Help dialog's first link reopens it (`restartWelcome` in `AppRoot`).
- **Empty / no-results states** all go through `components/ds/EmptyState.tsx` (icon, title,
  description, optional action). `size="hero"` fills a whole view (icon in a soft badge); `size="compact"`
  suits popovers, side panels and search dropdowns. Do not hand-roll empty placeholders; reuse this so
  they stay consistent.
- **Composer autocomplete** (inside `MessageEditor`): one keyboard-navigable suggestion popup serves
  three triggers, `@mention` (members), `#channel` (the rooms of the open space) and `:shortcode:`
  (emoji, via `searchShortcodes` in
  `lib/shortcodes.ts`, backed by node-emoji `search`, prefix matches ranked first). A single `trigger`
  state (`kind`/`query`/`start`) plus an `active` index drives it; the editor is an ARIA `combobox`
  (`aria-activedescendant` on the options, ids namespaced per instance via `useId`). Keys: Up/Down
  move, Enter/Tab accept, Esc dismisses; hover syncs `active`, and option `onMouseDown` is prevented so
  the editor keeps focus. Picking a mention inserts `@name `, a shortcode inserts an emote chip. The
  shortcode trigger fires from the first character after the colon and only at a token start
  (`(?:^|\s):`), so times like `10:30` do not trigger it. The toolbar's `@` and `#` buttons go through
  `insertTrigger`, which types the space the trigger needs when the caret is against a word: they went
  through `insertText` and opened nothing whenever the caret was not already at a token start, which
  is most of the time. The `Popover` (`components/ds/Popover.tsx`)
  measures before paint on every open render (and via a `ResizeObserver` for async resizes), so a
  shrinking/growing list stays anchored to the input with no stale-gap or flash.
