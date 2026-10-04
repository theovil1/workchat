"use client";

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAvatar, getPresence, setChannelMembers, setCurrentUser, setSpaceRooms, setUserPresence } from "@/lib/data";
import {
  acceptInvitation,
  addReaction,
  confirmEmailVerification,
  confirmPasswordReset,
  connectRealtime,
  createChannel as apiCreateChannel,
  createDm,
  createInvitation,
  createSpace,
  deleteChannel as apiDeleteChannel,
  deleteMessage,
  deleteSpace as apiDeleteSpace,
  editMessage,
  getChanges,
  getChannelMessages,
  getChannels,
  getDirectMessages,
  getFolder,
  getInvitations,
  getNotificationPreferences,
  getNotifications,
  getReadCursors,
  getReplies,
  getSavedMessages,
  adoptBrowserTimezone,
  getSession,
  syncAccountLocale,
  getSpaceMembers,
  getSpacePresence,
  getWorkspaces,
  joinChannel as apiJoinChannel,
  leaveChannel as apiLeaveChannel,
  leaveSpace as apiLeaveSpace,
  login as apiLogin,
  logout as apiLogout,
  markAllNotificationsRead,
  markNotificationRead,
  previewInvitation,
  register as apiRegister,
  removeMember as apiRemoveMember,
  removeReaction,
  requestEmailVerification,
  requestPasswordReset,
  resetPasswordWithRecoveryCode,
  getInstanceCapabilities,
  resolveSpaceSlug,
  revokeInvitation,
  saveConversationNotify,
  saveNotificationPreferences,
  saveSpaceNotify,
  sendMessage,
  setMessagePinned,
  setMessageSaved,
  setChannelFavorite,
  setChannelOrder as apiSetChannelOrder,
  setDefaultChannel as apiSetDefaultChannel,
  setMemberRole as apiSetMemberRole,
  setMyPresence as apiSetMyPresence,
  setReadCursor,
  type ApiNotification,
  type Member,
  type MfaMethod,
  type RealtimeConnection,
  type RealtimeReaction,
  type SessionUser,
  updateChannel as apiUpdateChannel,
  uploadAttachment as apiUploadAttachment,
  verifyPasskey,
  verifyRecoveryCode,
  verifyTotp,
} from "@/lib/data/api";
import { apiErrorCode, isApiError } from "@/lib/data/http";
import { clearAuthLink, forgetInvite, readAuthLink, readRememberedInvite, rememberInvite } from "@/lib/authLink";
import { fileUrl, readSpaceLocation, writeSpaceLocation } from "@/lib/spaceUrl";
import { OfficeEditor } from "@/features/office/OfficeEditor";
import { CalendarScreen } from "@/features/calendar/CalendarScreen";
import { emitCalendarChanged } from "@/lib/calendarEvents";
import { formatDate, formatTime } from "@/lib/i18n/format";
import { emitFileEvent } from "@/lib/fileEvents";
import type {
  Channel,
  DirectMessage,
  Invitation,
  InvitationPreview,
  Message,
  MessageAttachment,
  SpaceFile,
  Workspace,
} from "@/lib/data";
import { Avatar, Button, Dialog, EmptyState } from "@/components/ds";
import type { Presence } from "@/components/ds";
import type { SavedMessage } from "@/lib/data/api";
import type { PresenceChoice } from "@/lib/data";
import { ChannelScreen } from "@/features/channel/ChannelScreen";
import {
  ChannelNotificationsDialog,
  ChannelSettingsDialog,
  DeleteChannelDialog,
} from "@/features/channel/ChannelDialogs";
import { LoginScreen } from "@/features/auth/LoginScreen";
import { SignupScreen, type SignupValues } from "@/features/auth/SignupScreen";
import { OnboardingFlow } from "@/features/auth/OnboardingFlow";
import { ForgotPasswordScreen } from "@/features/auth/ForgotPasswordScreen";
import { ImportScreen } from "./ImportScreen";
import { useRunningImport } from "./importRun";
import { InstanceAdminScreen } from "./InstanceAdmin";
import { NotificationPrompt } from "./NotificationPrompt";
import { initialLocale, key, type TranslationKey, useTranslation } from "@/lib/i18n";
import { MfaChallengeScreen } from "@/features/auth/MfaChallengeScreen";
import { ResetPasswordScreen } from "@/features/auth/ResetPasswordScreen";
import { InviteScreen, type InviteStatus } from "@/features/auth/InviteScreen";
import { VerifyEmailScreen, type VerifyEmailStatus } from "@/features/auth/VerifyEmailScreen";
import { FilesScreen } from "@/features/files/FilesScreen";
import { WorkspaceSettings } from "@/features/settings/WorkspaceSettings";
import { ActivityView } from "./ActivityView";
import { type ActivityItem, collectMentions, collectSaved, collectThreads, type MessageMap } from "./activity";
import {
  DeleteSpaceDialog,
  HelpDialog,
  InviteDialog,
  LeaveSpaceDialog,
  NewChannelDialog,
  NewMessageDialog,
  NewWorkspaceDialog,
  RemoveMemberDialog,
  TransferOwnershipDialog,
} from "./dialogs";
import { ExternalLinkDialog } from "./ExternalLinkDialog";
import { GettingStarted } from "./GettingStarted";
import { GlobalSearchDialog } from "./GlobalSearchDialog";
import { QuickSwitcher } from "./QuickSwitcher";
import { useGlobalShortcuts } from "./useGlobalShortcuts";
import { useMountAnimation } from "./useMountAnimation";
import {
  type AppNotification,
  type ChannelNotifPref,
  DEFAULT_CHANNEL_PREF,
  DEFAULT_NOTIF_PREFS,
  effectiveLevel,
  type NotifLevel,
  type NotifPrefs,
  sameNotifPrefs,
  isMention,
  type NotifKind,
  notifSummary,
  passesPref,
} from "./notifications";
import {
  appIsAway,
  inQuietHours,
  notificationPermission,
  playNotificationSound,
  requestNotificationPermission,
  showDesktopNotification,
} from "./desktopNotifications";
import {
  disablePush,
  enablePush,
  onPushOpen,
  pushActive,
  pushSupport,
  registerServiceWorker,
  syncPush,
  takePushLink,
  type PushTarget,
} from "./webPush";
import { PreferencesScreen, type PrefTab } from "./PreferencesScreen";
import { SettingsProvider, useSettings } from "./settings";
import { Sidebar } from "./Sidebar";
import type { AppView, ChannelPanel, Toast } from "./types";
import { WorkspaceRail } from "./WorkspaceRail";
import { readDeepLink } from "@/lib/dev/deeplink";
import { lastChannelOf, rememberChannel } from "@/lib/lastChannel";
import { useLayout, useTouch } from "./useLayout";
import { oneLine } from "./preview";
import { BottomTabs } from "./BottomTabs";
import { UploadPanel } from "@/features/files/UploadPanel";
import { ComposeFab, MobileActivity, MobileHeader, MobileMessages, MobileSearchField, QuickLinks, SpaceMark } from "./mobile/MobileScreens";
import { SpaceSwitcherSheet, YouSheet } from "./mobile/MobileSheets";

/** Wraps the app in the settings provider (emoji rendering, etc.). */
export function AppRoot() {
  return (
    <SettingsProvider>
      <AppShell />
    </SettingsProvider>
  );
}

type Modal =
  | "newChannel"
  | "newMessage"
  | "invite"
  | "newWorkspace"
  | "leaveSpace"
  | "deleteSpace"
  | "help"
  | "search"
  | "switcher"
  | null;

const toastStyle: Record<string, CSSProperties> = {
  // Above the dialog scrim (90), not below it: a refusal raised *by* a dialog was drawn behind it,
  // blurred, and the only way to read it was to close the thing that had just failed.
  wrap: { position: "fixed", right: 20, bottom: 20, zIndex: 100 },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    // Never wider than the screen less its margins (a phone at the largest text size is 267 CSS
    // pixels across), and the offset shadow has to fit in the margin too.
    minWidth: "min(240px, calc(var(--ui-vw, 100vw) - 48px))",
    maxWidth: "min(360px, calc(var(--ui-vw, 100vw) - 48px))",
    padding: "10px 14px",
    borderRadius: "var(--radius-md)",
    background: "var(--surface-inverse)",
    color: "var(--text-inverse)",
    // The ink card, lifted on the bee-yellow offset of the product's primary actions.
    boxShadow: "var(--shadow-lift)",
  },
  title: { fontSize: "var(--text-xs)", fontWeight: 600 },
  desc: { fontSize: "var(--text-2xs)", color: "color-mix(in srgb, var(--text-inverse) 78%, var(--surface-inverse))" },
  action: {
    flex: "none",
    minHeight: 32,
    padding: "4px 10px",
    border: "1.5px solid color-mix(in srgb, var(--text-inverse) 45%, transparent)",
    borderRadius: "var(--radius-sm)",
    background: "transparent",
    color: "var(--text-inverse)",
    font: "inherit",
    fontSize: "var(--text-xs)",
    fontWeight: 600,
    cursor: "pointer",
  },
};

/** How many faces a thread shows next to its reply count. The API caps its own list to match. */
const MAX_REPLY_FACES = 3;

/** A message that only exists client-side: an optimistic send not yet acknowledged by the API. */
function isPendingId(id: string): boolean {
  return id.startsWith("tmp-");
}

/** Insert or replace a message in a conversation's list (realtime `message.created`, de-duped by id). */
function upsertMessage(map: MessageMap, conv: string, m: Message): MessageMap {
  const list = map[conv] ?? [];
  const idx = list.findIndex((x) => x.id === m.id);
  if (idx === -1) return { ...map, [conv]: [...list, m] };
  const next = list.slice();
  next[idx] = m;
  return { ...map, [conv]: next };
}

/**
 * Move a thread root's reply counter by `delta` (a reply was posted, or taken back).
 *
 * A reply is not part of the feed, so the only trace it leaves there is the root's counter: without
 * this, a thread opened on a message stayed invisible to everyone else until they reloaded the
 * conversation, and a deleted reply went on being advertised. Mirrors what the API keeps on the
 * row, floor included, so the two agree until the next fetch says otherwise.
 */
function adjustReplyCount(
  map: MessageMap,
  conv: string,
  parentId: string,
  delta: number,
  author?: string,
  /** When the arriving reply was sent: the root's "last reply" moves to it. */
  at?: string,
): MessageMap {
  const list = map[conv] ?? [];
  const idx = list.findIndex((x) => x.id === parentId);
  if (idx === -1) return map;
  const root = list[idx];
  const count = Math.max(0, (root.replies ?? 0) + delta);
  // The faces move with the count, newest first, one per person. Only an arrival is folded in: a
  // reply taken back says nothing about whether its author still has others in the thread, and the
  // next read of the conversation settles it either way.
  const faces =
    author && delta > 0
      ? [author, ...(root.replyAuthors ?? []).filter((a) => a !== author)].slice(0, MAX_REPLY_FACES)
      : root.replyAuthors;
  const next = list.slice();
  // Only an arrival moves the time too, for the same reason as the faces.
  const lastReplyAt = at && delta > 0 ? at : root.lastReplyAt;
  next[idx] = { ...root, replies: count > 0 ? count : undefined, replyAuthors: faces, lastReplyAt: count > 0 ? lastReplyAt : undefined };
  return { ...map, [conv]: next };
}

/** Replace a message already present in a conversation (realtime `message.updated`/`deleted`). */
function replaceMessage(map: MessageMap, conv: string, m: Message): MessageMap {
  const list = map[conv] ?? [];
  if (!list.some((x) => x.id === m.id)) return map;
  return { ...map, [conv]: list.map((x) => (x.id === m.id ? m : x)) };
}

/**
 * Fold what a catch-up returned into the messages held: edits and tombstones replace, new messages
 * are added, and a thread root's counter follows the replies that arrived or were taken back.
 * A deletion of something never held is ignored: there is nothing on screen to take down.
 */
function applyChanges(map: MessageMap, changes: { conversationId: string; message: Message }[]): MessageMap {
  let next = map;
  for (const { conversationId: conv, message: m } of changes) {
    const held = next[conv]?.find((x) => x.id === m.id);
    if (held) {
      next = replaceMessage(next, conv, m);
      if (m.parentId && m.deleted && !held.deleted) next = adjustReplyCount(next, conv, m.parentId, -1);
    } else if (!m.deleted) {
      next = upsertMessage(next, conv, { ...m, fresh: true });
      if (m.parentId) next = adjustReplyCount(next, conv, m.parentId, 1, m.author, m.createdAt);
    }
  }
  return next;
}

/** A notification from the API, as the inbox holds it, labelled from the lists this client has. */
function toAppNotification(
  n: ApiNotification,
  chans: Channel[],
  dmList: DirectMessage[],
  read: boolean,
): AppNotification {
  // The loaded lists first, because they carry what this client knows about the conversation;
  // the server's own names otherwise, which is the only thing that can name a conversation in a
  // space this client has never opened. The identifier is no longer a possible answer.
  const channel = chans.find((x) => x.id === n.conversationId);
  const dm = channel ? undefined : dmList.find((x) => x.id === n.conversationId);
  const { label, isDm } = channel
    ? { label: `#${channel.name}`, isDm: false }
    : dm
      ? { label: dm.name, isDm: true }
      : n.channelName
        ? { label: `#${n.channelName}`, isDm: false }
        : { label: "", isDm: true };
  return {
    id: n.id,
    kind: n.kind as NotifKind,
    channelId: n.conversationId,
    spaceId: n.spaceId,
    label,
    spaceName: n.spaceName,
    isDm,
    actor: n.actor,
    messageId: n.messageId,
    // The server previews the raw body; a list draws it as one line of words.
    preview: oneLine(n.preview),
    createdAt: n.createdAt,
    read,
    reminder: n.reminder,
  };
}

/** Apply another user's reaction delta to a message's buckets (our own deltas are already optimistic). */
function applyReactionDelta(map: MessageMap, conv: string, r: RealtimeReaction): MessageMap {
  const list = map[conv] ?? [];
  const idx = list.findIndex((x) => x.id === r.messageId);
  if (idx === -1) return map;
  const msg = list[idx];
  const reactions = (msg.reactions ?? []).map((x) => ({ ...x }));
  const ri = reactions.findIndex((x) => x.emoji === r.emoji);
  if (r.added) {
    if (ri === -1) reactions.push({ emoji: r.emoji, count: 1 });
    else reactions[ri] = { ...reactions[ri], count: reactions[ri].count + 1 };
  } else if (ri !== -1) {
    const count = reactions[ri].count - 1;
    if (count <= 0) reactions.splice(ri, 1);
    else reactions[ri] = { ...reactions[ri], count };
  }
  const next = list.slice();
  next[idx] = { ...msg, reactions: reactions.length ? reactions : undefined };
  return { ...map, [conv]: next };
}

/**
 * The screen the shell is showing: one of the authentication steps, or the app itself. The flow is
 * login -> (second factor) -> app, with sign-up, password reset and email confirmation branching off
 * it; the emailed links land straight on `verify` and `reset`.
 */
type AuthStage = "login" | "signup" | "mfa" | "forgot" | "reset" | "verify" | "invite" | "onboarding" | "app";

/**
 * French copy for each authentication failure the API can report. The API answers with a
 * machine-readable code (`{ "error": "email_taken", … }`) plus an English message meant for
 * operators; the client owns what the user reads.
 */
const AUTH_MESSAGES: Record<string, TranslationKey> = {
  invalid_credentials: key("error.invalidCredentials"),
  unauthorized: key("error.sessionExpired"),
  email_taken: key("error.emailTaken"),
  weak_password: key("error.passwordShort"),
  breached_password: key("error.passwordBreached"),
  account_locked: key("error.accountLocked"),
  too_many_attempts: key("error.tooManyAttempts"),
  email_not_verified: key("error.confirmEmailFirst"),
  invalid_token: key("error.invalidLink"),
  invalid_code: key("error.wrongCode"),
};

/**
 * The dictionary key for a failed auth request: the mapped code, else the caller's fallback key.
 *
 * Keys rather than sentences, so the table can be built at module load and the text looked up where
 * it is shown.
 */
function authMessage(err: unknown, fallbackKey: TranslationKey): TranslationKey {
  const code = apiErrorCode(err);
  return (code && AUTH_MESSAGES[code]) || fallbackKey;
}

/**
 * Client root of the app shell. Holds the authentication stage, the navigation state and the domain
 * state loaded from the API: it boots against `GET /auth/session`, drives the whole authentication
 * flow, then keeps the space's channels, DMs, feeds and realtime updates in state for the screens.
 */
/** Screen names, for the tab title and the compact top bar. Conversations name themselves. */
const VIEW_TITLES: Record<string, TranslationKey> = {
  files: key("sidebar.spaceFiles"),
  calendar: key("calendar.title"),
  settings: key("sidebar.spaceSettings"),
  prefs: key("prefs.title"),
  "instance-admin": key("admin.screenTitle"),
  threads: key("sidebar.threads"),
  mentions: key("activity.mentions"),
  saved: key("activity.saved"),
};

function AppShell() {
  const settings = useSettings();
  const { t } = useTranslation();
  /** The side panel a conversation opens with, from the preferences. `none` means it opens closed. */
  const defaultPanel: ChannelPanel = settings.defaultPanel === "none" ? null : settings.defaultPanel;
  /**
   * The same value, reachable from the boot effect.
   *
   * That effect runs once per session and must not re-run when a preference changes, so it cannot
   * list `defaultPanel` as a dependency; a ref is how it reads the current one without subscribing
   * to it.
   */
  const defaultPanelRef = useRef(defaultPanel);
  useEffect(() => {
    defaultPanelRef.current = defaultPanel;
  });

  // The signed-in user, resolved from the session at boot. `currentUser` (the display name) is read
  // throughout the shell; it is empty until the session loads, but the app view is gated behind the
  // boot below, so nothing renders against an empty name.
  const [session, setSession] = useState<SessionUser | null>(null);
  const currentUser = session?.name ?? "";
  // An import runs in the server and outlives the screen that started it. Watched from up here so
  // that the sidebar can show it whatever the caller is doing. Anyone signed in may import; the
  // server answers each caller with their own imports only.
  const {
    run: importRun,
    clear: clearImportRun,
    refresh: refreshImportRun,
  } = useRunningImport(session !== null);
  /** Whether the import screen was opened to see a finished run rather than to start one. */
  const [importDetail, setImportDetail] = useState(false);
  // Boot lifecycle: `booting` covers the initial session check and data load; `bootError` holds a
  // fatal load failure (the API being unreachable), distinct from a 401 which sends us to the login.
  const [booting, setBooting] = useState(true);
  /**
   * A space switch in flight.
   *
   * Kept apart from `booting`, which unmounts the entire app for the full-screen boot card: routing
   * a switch through it blanked the window on every click of the rail. This one keeps the shell
   * mounted and only fades what is being replaced.
   */
  const [switchingSpace, setSwitchingSpace] = useState(false);
  /** A space exit in flight (leaving or deleting), so its dialog can refuse a second press. */
  const [spaceBusy, setSpaceBusy] = useState(false);
  /** The member a transfer of ownership is being confirmed for, if any. */
  const [transferTo, setTransferTo] = useState<{ userId: string; name: string } | null>(null);
  /** The member being removed from the space, once confirmed. */
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null);
  /** Why the space exit was refused, said inside the dialog that asked rather than behind it. */
  const [exitError, setExitError] = useState<TranslationKey | null>(null);
  const [bootError, setBootError] = useState<TranslationKey | null>(null);
  // Shared by every screen of the authentication flow: the message under the form, and whether a
  // request is in flight. They are reset on each stage change so an error never leaks across screens.
  const [authError, setAuthError] = useState<TranslationKey | null>(null);
  const [authPending, setAuthPending] = useState(false);
  /** True once a link (verification or reset) has been sent from the current screen. */
  const [authSent, setAuthSent] = useState(false);

  const [authStage, setAuthStage] = useState<AuthStage>("app");
  /** The pending second-factor challenge returned by sign-in, until it is completed or abandoned. */
  const [mfaChallenge, setMfaChallenge] = useState<{ methods: MfaMethod[]; mfaToken: string } | null>(null);
  /** Address awaiting confirmation (just registered, or refused at sign-in as unverified). */
  const [pendingEmail, setPendingEmail] = useState("");
  /** First name of the signed-in user, to greet them through onboarding. */
  const [signupFirst, setSignupFirst] = useState("");
  /** Token carried by an emailed link, held in memory only (the address bar is cleared on arrival). */
  const [linkToken, setLinkToken] = useState("");
  const [verifyStatus, setVerifyStatus] = useState<VerifyEmailStatus>("sent");
  const [resetDone, setResetDone] = useState(false);
  /** True once a recovery code has taken an account back, which is a different outcome from a sent link. */
  const [recoveryDone, setRecoveryDone] = useState(false);
  /**
   * Whether this instance can send email. `undefined` until the answer arrives, which the screens
   * read as "assume it can": a slow answer must not hide the ordinary path.
   */
  const [emailDelivery, setEmailDelivery] = useState<boolean | undefined>(undefined);
  /**
   * An invitation the visitor arrived with, held across the whole authentication flow: they may have
   * to sign in or register first, and the token has to survive that. Kept in memory only, like the
   * other emailed tokens.
   */
  const [inviteToken, setInviteToken] = useState("");
  const [invitePreview, setInvitePreview] = useState<InvitationPreview | null>(null);
  const [inviteStatus, setInviteStatus] = useState<InviteStatus>("loading");
  /** The current space's outstanding invitations, loaded when the invite dialog opens. */
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [dms, setDms] = useState<DirectMessage[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  // The space's files (root folder), for the in-channel file panel and search. The full Files screen
  // manages its own folder navigation separately.
  const [spaceFiles, setSpaceFiles] = useState<SpaceFile[]>([]);
  const [messages, setMessages] = useState<MessageMap>({});
  // Notification inbox, loaded from the API feed and mutated in place (read state); realtime
  // `notification.created` events prepend to it.
  const [notifs, setNotifs] = useState<AppNotification[]>([]);
  // Live presence by user id (space snapshot + realtime events), and who is typing in each
  // conversation (user id -> last-seen ms, so stale signals expire).
  const [presence, setPresence] = useState<Record<string, Presence>>({});
  const [typing, setTyping] = useState<Record<string, Record<string, number>>>({});
  // Per-conversation notification preferences, keyed by channel/DM id. Absent = defaults (all, unmuted).
  const [channelPrefs, setChannelPrefs] = useState<Record<string, ChannelNotifPref>>({});
  const [channelNotifId, setChannelNotifId] = useState<string | null>(null);
  // A notification clicked in the system tray, waiting for its space and conversation to be loaded
  // before it can be opened (see the effect that consumes it).
  const [pendingOpen, setPendingOpen] = useState<PushTarget | null>(null);
  // The notification level of the space on screen, being set.
  const [spaceNotifOpen, setSpaceNotifOpen] = useState(false);
  // A link to another site, held until the warning about leaving Ruchoir is answered.
  const [externalLink, setExternalLink] = useState<string | null>(null);
  // The channel whose deletion is being confirmed, and how that is going.
  const [deletingChannel, setDeletingChannel] = useState<{ id: string; name: string } | null>(null);
  const [deleteChannelBusy, setDeleteChannelBusy] = useState(false);
  const [deleteChannelError, setDeleteChannelError] = useState<string | null>(null);
  /**
   * Take a deleted channel out of everything that shows it: the sidebar, its loaded history, its
   * notifications, and the screen when it was the one open (which then lands on the space's default
   * channel, else the first one left). Through a ref because the realtime handlers, wired once, call
   * it too.
   */
  const dropChannelRef = useRef<(channelId: string) => void>(() => {});

  const [ws, setWs] = useState("");
  const [view, setView] = useState<AppView>("channel");
  /**
   * A document an address named (`/e/<space>/f/<file>`): this tab is that document's, the editor
   * alone across it (documents open in a tab of their own, see `FilesScreen`).
   */
  /**
   * A document's own tab. `opened`: the files list opened it (`?opened=1`), so a script may close it;
   * a tab reached any other way (a reload, which a phone does to a tab left in the background, a link,
   * the installed app) cannot, or must not, be closed by the page.
   */
  const [standalone, setStandalone] = useState<{ fileId: string; convert: boolean; slug: string; opened: boolean } | null>(null);
  /** The folder the files screen opens on, once: where a document closed from its own tab lives. */
  const [filesFolder, setFilesFolder] = useState<string | undefined>(undefined);
  /**
   * The address looks like a document's (`/e/<space>/f/<file>`, `/f/<file>`) and the boot has not yet
   * said whether it is one: nothing live starts meanwhile (no realtime connection), so a document's
   * tab never appears present in the space, not even for the moment the boot takes.
   */
  const [maybeDocumentTab, setMaybeDocumentTab] = useState(
    () => typeof window !== "undefined" && /^\/(?:e\/[^/]+\/)?f\/[^/]+/.test(window.location.pathname),
  );
  /** Whether the office editor is open: it owns the address meanwhile (`/e/<space>/f/<file>`). */
  const [editorOpen, setEditorOpen] = useState(false);
  // The view to restore when the full-screen preferences are closed (they are opened from menus, not the nav).
  const [prevView, setPrevView] = useState<AppView>("channel");
  // Which preferences section to land on when the full-screen preferences open.
  const [prefsTab, setPrefsTab] = useState<PrefTab>("appearance");
  // Dev/audit only: a click-only popover the deep-link asked to open on load (set post-mount, see below).
  const [deepLinkPop, setDeepLinkPop] = useState<string | undefined>(undefined);
  const [channelId, setChannelId] = useState("");
  // Desktop opens a conversation with the panel chosen in the preferences (see `openChannel`).
  // `compact` is false on the first render (SSR-safe, see useCompact), so this matches the server
  // render; the compact shell shows the list first and openChannel resets the panel per navigation
  // anyway. The preference is read after mount, so the first frame uses its default, which is the
  // same value the shell used before this was configurable.
  const [panel, setPanel] = useState<ChannelPanel>("members");
  // True once the user closes the right panel by hand, so opening another conversation stops
  // auto-opening its default panel. Reset when they open a panel again.
  const [panelDismissed, setPanelDismissed] = useState(false);
  const [thread, setThread] = useState<string | null>(null);
  /** The thread whose replies are being fetched, so its panel can draw placeholders meanwhile. */
  const [threadLoading, setThreadLoading] = useState<string | null>(null);
  const [profile, setProfile] = useState<string | null>(null);
  const [profileEdit, setProfileEdit] = useState(false);
  const [unreadMarker, setUnreadMarker] = useState<string | null>(null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  // The availability *choice*, which is the user's instruction. What they and everyone else see is
  // computed by the server from that choice and from a live connection, and arrives in the presence
  // map like anyone else's: this used to be hardcoded to "online", so the menu always claimed the
  // user was connected and always looked as though "En ligne" had been picked.
  const [myChoice, setMyChoice] = useState<PresenceChoice>("auto");
  /**
   * How far each member has read, per conversation: `{ [conversationId]: { [userId]: messageId } }`.
   *
   * Loaded when a conversation is opened and kept live by `read.updated`. It is what turns the read
   * indicator from a decoration into a fact: it used to render "Lu" under every message on hover,
   * with nothing behind it.
   */
  const [readCursors, setReadCursors] = useState<
    Record<string, { members: string[]; at: Record<string, string> }>
  >({});
  const [modal, setModal] = useState<Modal>(null);
  const [channelSettingsId, setChannelSettingsId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  // Toast: `toast` holds the content (kept through the exit so it stays rendered while animating out),
  // `toastVisible` drives the enter/exit, and useMountAnimation keeps it mounted for the exit window.
  const [toast, setToast] = useState<Toast | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  // Bumped on every toast so React remounts the element and replays the enter animation, even when a
  // toast is already on screen.
  const [toastKey, setToastKey] = useState(0);
  const { mounted: toastMounted, closing: toastClosing } = useMountAnimation(toastVisible, 280);

  // Which shell the window calls for (see useLayout). `compact` is the phone's: one screen at a
  // time, `mobileTab` picking the tab and `mobileContent` true when a conversation or a view is
  // pushed full screen over it. The tablet keeps two columns and has no rail, so the space switcher
  // and the account menu are sheets there as on the phone (`spaceSheet`, `youSheet`).
  const layout = useLayout();
  const compact = layout === "phone";
  const touch = useTouch();
  const tablet = layout === "tablet";
  const [mobileTab, setMobileTab] = useState<"home" | "messages" | "calendar" | "activity">("home");
  const [mobileContent, setMobileContent] = useState(false);
  const profileFromTabs = useRef(false);
  const [spaceSheet, setSpaceSheet] = useState(false);
  const [youSheet, setYouSheet] = useState(false);
  // The panel a conversation opens with (the members, by default) is a desktop's: a tablet has no
  // room beside the conversation and a phone shows one thing at a time. The first render cannot
  // know the window yet (see useLayout), so once it does, a panel nobody asked for is put away.
  // The panel put away is remembered, and comes back if the window widens to a desktop again: resizing
  // a browser window across the line should not lose what was open.
  const panelPutAway = useRef<ChannelPanel>(null);
  useEffect(() => {
    if (layout !== "desktop") {
      setPanel((open) => {
        if (open === "members" || open === "files" || open === "pinned") {
          panelPutAway.current = open;
          return null;
        }
        return open;
      });
    } else if (panelPutAway.current) {
      const back = panelPutAway.current;
      panelPutAway.current = null;
      setPanel((open) => open ?? back);
    }
  }, [layout]);

  /** Navigating anywhere closes the switcher and the account sheet it was chosen from. */
  const closeSheets = () => {
    setSpaceSheet(false);
    setYouSheet(false);
  };
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** The space whose load is currently authoritative; see `loadSpace`. */
  const loadingSpaceRef = useRef("");
  /**
   * The latest `markConversationRead`, reachable from `loadSpace`.
   *
   * Through a ref rather than a dependency: `loadSpace` is stable by construction, and marking read
   * closes over the notification inbox, which changes on every push. Same reason the realtime
   * handlers reach the toast through one.
   */
  const markReadRef = useRef<(id: string, loaded?: Message[]) => void>(() => {});

  /**
   * Refresh the per-space counters after an event the client cannot attribute.
   *
   * The transport is user-scoped, so events arrive for every space the account belongs to, but an
   * envelope names a conversation and not a space: one belonging to a space that is not loaded
   * cannot be counted locally. Rather than widen a shared payload, re-read `/me/spaces`, which is one
   * small request. Debounced, because a burst in a busy background space would otherwise fire one
   * request per message.
   */
  const countersTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Both are stable by construction (a ref and a state setter), so they can be dependencies of the
  // realtime effect without tearing its socket down on every render.
  const reloadSpaceCounters = useCallback(
    () =>
      getWorkspaces()
        .then(setWorkspaces)
        .catch(() => {
          // A failed refresh leaves the previous counters: stale beats blank.
        }),
    [],
  );
  /**
   * Fetch where everyone has read up to in a conversation, which is what the read indicator draws.
   *
   * Called from both ways into a conversation, and that is the whole point: hooked onto the click
   * alone, the conversation opened by entering a space never had any, so every one of your own
   * messages read "Non lu" until you left the channel and came back. Live from there on, through
   * `read.updated`.
   */
  const loadReadCursors = useCallback(
    (id: string) =>
      getReadCursors(id)
        .then((cursors) =>
          setReadCursors((prev) => ({
            ...prev,
            [id]: {
              // Everyone who could read, so "everyone has" can be told from "three of them have".
              members: cursors.map((c) => c.userId),
              at: Object.fromEntries(
                cursors
                  .filter((c) => c.lastReadMessageId)
                  .map((c) => [c.userId, c.lastReadMessageId as string]),
              ),
            },
          })),
        )
        .catch(() => {
          // The indicator simply says nothing until the next visit; not worth a message.
        }),
    [],
  );

  /**
   * Re-read the spaces when an import stops, even one watched only from the sidebar: an import
   * creates spaces, and the rail used to keep the list it booted with until the page was reloaded.
   */
  const importEndedRef = useRef<string | null>(null);
  const importRunId = importRun?.job.id;
  const importRunning = importRun?.running;
  useEffect(() => {
    if (!importRunId || importRunning !== false || importEndedRef.current === importRunId) return;
    importEndedRef.current = importRunId;
    void reloadSpaceCounters();
  }, [importRunId, importRunning, reloadSpaceCounters]);

  const refreshSpaceCounters = useCallback(() => {
    clearTimeout(countersTimer.current);
    countersTimer.current = setTimeout(() => void reloadSpaceCounters(), 1500);
  }, [reloadSpaceCounters]);

  /**
   * Seed the shell state for one space, in three waves rather than one batch.
   *
   * 1. **Blocking:** channels, DMs, members and presence. Everything the space cannot be drawn
   *    without, members included, since every message row resolves its author and mentions there.
   * 2. **Blocking, small:** the messages of the one conversation being opened. The space is usable
   *    from this point, which is where the caller's loading state lifts.
   * 3. **Background:** the other conversations' messages, the notification inbox and the space
   *    files. None of it is on screen yet, and the files in particular are not shown until the file
   *    panel or screen is opened.
   *
   * Batching all of it made the whole space wait on the slowest request among six, plus one per
   * conversation, before drawing anything. Each wave checks `loadingSpaceRef` before writing state,
   * so a second switch started mid-flight is never overwritten by the slower one it interrupted.
   *
   * Used both at boot and when the workspace rail switches space, so a switch shows the space it
   * says it does rather than the previous one's conversations.
   */
  const loadSpace = useCallback(async (activeWs: string, preferChannelName?: string, defaultChannelId?: string) => {
    setWs(activeWs);
    // Which space the in-flight waves belong to. A switch started while another is loading must not
    // have the slower one's results land on top of it.
    loadingSpaceRef.current = activeWs;
    // The people of the space being left are not an approximation of the people of the one being
    // entered, not even for the few hundred milliseconds the fetch takes.
    setMembers([]);
    if (!activeWs) {
      setChannels([]);
      setDms([]);
      setMembers([]);
      setPresence({});
      setSpaceFiles([]);
      setMessages({});
      setNotifs([]);
      setChannelId("");
      return;
    }
    // Nothing from the previous space may survive into this one.
    setMessages({});
    setNotifs([]);
    setSpaceFiles([]);

    // First wave: what the space cannot be rendered without. Members are in it because every message
    // row resolves its author, its avatar and its mentions against them; the space files are not,
    // because nothing displays them until the files panel or the files screen is opened. Putting
    // them in the same batch made the whole space wait on a request nobody was looking at.
    const [chans, dmList, memberList, presenceMap, cursor] = await Promise.all([
      getChannels(activeWs),
      getDirectMessages(activeWs),
      getSpaceMembers(activeWs).catch(() => [] as Member[]),
      getSpacePresence(activeWs).catch(() => ({}) as Record<string, Presence>),
      // Where catching up starts from: taken before any message is read, so nothing that happens
      // while the space loads can fall between the pages and the first catch-up.
      getChanges(activeWs).catch(() => null),
    ]);
    // A second switch started while this one was in flight: its results own the screen now.
    if (loadingSpaceRef.current !== activeWs) return;
    syncCursorRef.current = cursor ? { space: activeWs, since: cursor.now } : null;
    staleRef.current.clear();
    setChannels(chans);
    setMembers(memberList);
    setPresence(presenceMap);
    // Each conversation's notification setting comes with it from the server, which is where it is
    // kept (and obeyed, for pushes and emails).
    setChannelPrefs((prev) => {
      const next = { ...prev };
      for (const c of [...chans, ...dmList]) if (c.notify) next[c.id] = c.notify;
      return next;
    });
    // Overlay each 1:1 DM's counterpart presence onto its sidebar row.
    setDms(dmList.map((d) => (d.userId && presenceMap[d.userId] ? { ...d, presence: presenceMap[d.userId] } : d)));

    // Land on the channel the address named, else the conversation last open in this space, else its
    // main public channel (the one newcomers join), else the first of the space (or its first DM).
    // Anything named or remembered that no longer exists, or is no longer reachable, falls through to
    // the next rather than failing: a link shared before a rename should still open the right space.
    const exists = (id: string | undefined) =>
      id !== undefined && (chans.some((c) => c.id === id) || dmList.some((d) => d.id === id));
    const preferred = preferChannelName ? chans.find((c) => c.name === preferChannelName)?.id : undefined;
    const remembered = lastChannelOf(activeWs);
    const opening =
      preferred ??
      (exists(remembered) ? remembered : undefined) ??
      (exists(defaultChannelId) ? defaultChannelId : undefined) ??
      chans.find((c) => c.type === "public")?.id ??
      chans[0]?.id ??
      dmList[0]?.id ??
      "";
    setChannelId(opening);

    // Second wave: only the conversation actually being opened. The space is usable from here, so
    // this is where the caller's loading state can lift.
    if (opening) {
      const page = await getChannelMessages(opening).catch(() => ({ messages: [], nextBefore: undefined }));
      if (loadingSpaceRef.current !== activeWs) return;
      setMessages((prev) => ({ ...prev, [opening]: page.messages }));
      // Being in a conversation is reading it, whether it was clicked or landed on. Without this,
      // entering a space and arriving in the very channel a notification points at left the badge
      // standing until the channel was clicked again, which reads as the notification being stuck.
      // The page is passed in because the read cursor needs its last message and the state holding
      // it was only just set.
      markReadRef.current(opening, page.messages);
      void loadReadCursors(opening);
    }

    // Third wave, behind the screen: everything the first view does not need. The other
    // conversations are still fetched in full because the Threads, Mentions and Saved views derive
    // from the whole message map; they simply no longer hold the space hostage while they load.
    void (async () => {
      const rest = [...chans.map((c) => c.id), ...dmList.map((d) => d.id)].filter((id) => id !== opening);
      const [pages, feed, folder] = await Promise.all([
        Promise.all(
          rest.map((id) => getChannelMessages(id).catch(() => ({ messages: [], nextBefore: undefined }))),
        ),
        getNotifications().catch(() => ({ notifications: [], unreadCount: 0, nextBefore: undefined })),
        getFolder(activeWs).catch(() => ({ folderId: undefined, breadcrumb: [], entries: [] as SpaceFile[] })),
      ]);
      if (loadingSpaceRef.current !== activeWs) return;
      setMessages((prev) => {
        const next = { ...prev };
        rest.forEach((id, i) => {
          next[id] = pages[i].messages;
        });
        return next;
      });
      setSpaceFiles(folder.entries);
      // The inbox lands here, well after the conversation was opened and marked read: at that
      // point it held none of these rows, so a mention pointing at the very channel being read
      // stayed unread on the server and kept the space's badge lit. Anything addressed to the
      // conversation on screen is read by definition, so it is filed as such now, once.
      const openedHere = feed.notifications.filter((n) => n.conversationId === opening && !n.read);
      setNotifs(
        feed.notifications.map((n) => toAppNotification(n, chans, dmList, n.read || n.conversationId === opening)),
      );
      if (openedHere.length > 0) {
        for (const n of openedHere) void markNotificationRead(n.id).catch(() => {});
        refreshSpaceCounters();
      }
    })();
    // Both stable by construction, and listed rather than omitted so the rule stays a rule.
  }, [refreshSpaceCounters, loadReadCursors]);

  /**
   * Load the signed-in user's spaces and enter the first one. Returns the spaces, so the caller can
   * tell an account with no space yet (which is sent to onboarding) from one that landed in a space.
   */
  const loadInitialData = useCallback(async () => {
    const spaces = await getWorkspaces();
    setWorkspaces(spaces);
    // Resolution needs the account's slugs, which is why it happens here and not at the very top of
    // the boot: until the spaces are known, the client cannot tell a space subdomain from a plain
    // hostname. An address naming a space the caller is not in simply falls back to the first.
    const target = readSpaceLocation(spaces.map((s) => s.slug));
    let wanted = target ? spaces.find((s) => s.slug === target.spaceSlug) : undefined;
    // A slug that matches nothing is usually a link written before the space was renamed. The API
    // keeps every slug a space has ever answered to, so ask it once before falling back. The address
    // is not corrected here: `writeSpaceLocation` emits the current slug on its own when the space
    // opens, which is the same replaceState that would have been needed anyway.
    if (target && !wanted) {
      const resolved = await resolveSpaceSlug(target.spaceSlug);
      wanted = resolved ? spaces.find((s) => s.id === resolved.id) : undefined;
    }
    // An address naming a file is a document's own tab: the editor alone. The space is not opened:
    // a channel loaded behind the editor would be marked read, its notifications cleared, on behalf
    // of a member who is looking at a document.
    if (wanted && target?.fileId) {
      const opened = new URLSearchParams(window.location.search).get("opened") === "1";
      setStandalone({ fileId: target.fileId, convert: target.convert === true, slug: wanted.slug, opened });
      setMaybeDocumentTab(false);
      return spaces;
    }
    setMaybeDocumentTab(false);
    const landing = wanted ?? spaces[0];
    await loadSpace(landing?.id ?? "", wanted ? target?.channelName : undefined, landing?.defaultChannelId);
    return spaces;
  }, [loadSpace]);

  // Boot: check for an existing session, then load its data. A 401 sends us to the login screen; any
  // other failure is a fatal boot error (the API being unreachable).
  useEffect(() => {
    let active = true;
    // Dev/audit only: a deep-link renders a specific screen offline, without the API (the responsive
    // and accessibility audits rely on this). Skip the real boot so the shell renders with empty data
    // instead of the boot-error screen. `readDeepLink()` is null in the production static export.
    if (readDeepLink()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBooting(false);
      return;
    }
    void (async () => {
      // An invitation held from an earlier load of this tab (see `rememberInvite`): registering from
      // an invitation means following the address-confirmation link, which reloads the bundle. Pick
      // it back up so the sign-in that follows still joins the space instead of dropping the invitee
      // into the "create your first space" onboarding.
      const held = readRememberedInvite();
      if (held) setInviteToken(held);

      // An emailed link (verification, password reset or invitation) takes precedence over the
      // session check: it addresses an account that is, by definition, not signed in here.
      const link = readAuthLink();
      // An invitation is the one link that can also apply to someone already signed in, so it
      // resolves the token first and only then falls back to asking who they are.
      if (link?.kind === "invite") {
        clearAuthLink();
        if (!active) return;
        setInviteToken(link.token);
        setAuthStage("invite");
        setInviteStatus("loading");
        const preview = link.token ? await previewInvitation(link.token).catch(() => null) : null;
        if (!active) return;
        if (!preview) {
          setInviteStatus("invalid");
          setBooting(false);
          return;
        }
        setInvitePreview(preview);
        rememberInvite(link.token);
        // Already signed in: join without asking for a password again.
        let user: SessionUser;
        try {
          user = await getSession();
        } catch {
          if (active) {
            setInviteStatus("ready");
            setBooting(false);
          }
          return;
        }
        if (!active) return;
        setInviteStatus("joining");
        try {
          await acceptInvitation(link.token);
        } catch {
          if (active) {
            // Most often an invitation addressed to a different address than the open session.
            setInviteStatus("ready");
            setAuthError(key("error.wrongAccountForInvite"));
            setBooting(false);
          }
          return;
        }
        if (!active) return;
        setInviteToken("");
        forgetInvite();
        setSession(user);
        setMyChoice(user.presenceChoice);
        const spaces = await loadInitialData();
        if (!active) return;
        setBooting(false);
        setAuthStage(spaces.length === 0 ? "onboarding" : "app");
        return;
      }
      if (link) {
        clearAuthLink();
        if (!active) return;
        setBooting(false);
        setLinkToken(link.token);
        if (link.kind === "reset-password") {
          setAuthStage("reset");
          if (!link.token) setAuthError(key("error.resetLinkIncomplete"));
          return;
        }
        setAuthStage("verify");
        if (!link.token) {
          setVerifyStatus("error");
          return;
        }
        setVerifyStatus("verifying");
        try {
          await confirmEmailVerification(link.token);
          if (active) setVerifyStatus("done");
        } catch (err) {
          if (!active) return;
          setVerifyStatus("error");
          setAuthError(authMessage(err, key("error.confirmFailed")));
        }
        return;
      }
      try {
        const user = await getSession();
        if (!active) return;
        setSession(user);
        setMyChoice(user.presenceChoice);
        // An account that has never had a timezone gets the browser's, once. Everything that shows
        // a local time depended on a column nothing could write, so it showed nothing.
        void adoptBrowserTimezone(user.timezone);
        // And the language in force, chosen or detected: someone on "follow the browser" reads in a
        // language all the same, and their profile said nothing about it.
        void syncAccountLocale(user.locale, initialLocale());
        await loadInitialData();
        if (!active) return;
        // By now the preferences have loaded (their effect runs on mount, well before this awaits
        // the network), so the first conversation opens on the chosen panel rather than on the
        // initial state's value.
        setPanel(defaultPanelRef.current);
        setAuthStage("app");
      } catch (err) {
        if (!active) return;
        if (isApiError(err, 401)) setAuthStage("login");
        else setBootError(key("error.serverUnreachable"));
      } finally {
        if (active) setBooting(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [loadInitialData]);

  // What this instance supports, read once and kept for the whole session. Unauthenticated on
  // purpose: the screens that need it (password recovery, the invitation dialog) include ones shown
  // before anyone has signed in. A failure leaves it undefined, which every reader treats as "the
  // usual behaviour", so an unreachable endpoint never removes a working path.
  useEffect(() => {
    let active = true;
    void getInstanceCapabilities()
      .then((capabilities) => {
        if (active) setEmailDelivery(capabilities.emailDelivery);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // Load the space's outstanding invitations whenever the invite dialog opens. Fetching on open
  // rather than on space load keeps an administration-only call off the boot path, and means the
  // list is never a stale snapshot from an earlier visit.
  useEffect(() => {
    if (modal !== "invite" || !ws) return;
    let active = true;
    void getInvitations(ws)
      .then((rows) => {
        if (active) setInvitations(rows);
      })
      .catch(() => {
        // A member who is not an administrator gets a 403 here: an empty list is the honest view.
        if (active) setInvitations([]);
      });
    return () => {
      active = false;
    };
  }, [modal, ws]);

  // Publish the signed-in user's name into the data seam, so components that read it synchronously
  // (message ownership, thread reply author, "my profile") reflect the real session, not the mock.
  useEffect(() => {
    if (session) setCurrentUser(session.name);
  }, [session]);

  // The realtime handlers read the latest lists/ids through a ref so the socket does not reconnect on
  // every state change. Updated after each render (not during, to respect the ref rules).
  const rtRef = useRef<RealtimeConnection | null>(null);
  // Our own dot: the server's answer for us, exactly as it is for everyone else in the space.
  const myPresence: Presence = (session?.id ? presence[session.id] : undefined) ?? "offline";

  const liveRef = useRef({ channels, dms, channelId, view, myId: session?.id, ws, spaces: workspaces });
  /**
   * Latest toast function, for the realtime handlers. They are wired once per session, so they
   * cannot close over `showToast` directly: it is a new function on every render, and adding it to
   * the effect's dependencies would tear the WebSocket down and rebuild it on each one.
   */
  const notifyRef = useRef<((toast: Toast) => void) | null>(null);

  /**
   * Latest "reach the person who is not looking" function, for the same reason as `notifyRef`: the
   * handlers are wired once per session and this one has to read preferences that change under it.
   */
  const alertRef = useRef<((n: AppNotification) => void) | null>(null);

  /**
   * The translator, for the same reason as the others: the realtime handlers are wired once per
   * session, and the sentences they raise have to be in the language in force when they fire, not
   * in the one that happened to be on when the socket was opened.
   */
  const tRef = useRef(t);

  /**
   * Latest "this message has been seen" function, for the same reason as the others: the realtime
   * handlers are wired once per session and this one advances a cursor that moves under them.
   */
  const markSeenRef = useRef<(conversationId: string, messageId: string) => void>(() => {});

  /**
   * Latest "take this space off the rail" function, for the same reason as the others: a space can
   * be left from another tab or deleted by its owner, and the handler that hears about it is wired
   * once per session while the space list changes under it.
   */
  const dropSpaceRef = useRef<(spaceId: string) => void>(() => {});

  /** Latest "read this space again from scratch", for the same reason as the others. */
  const reloadSpaceRef = useRef<(spaceId: string) => Promise<void>>(async () => {});
  /** Re-read what is on screen after pushes may have been missed; filled below, see `resync`. */
  const resyncRef = useRef<() => void>(() => {});
  /** Where the next catch-up of the space on screen starts from (see `getChanges`). */
  const syncCursorRef = useRef<{ space: string; since: string } | null>(null);
  /**
   * Conversations whose latest page is re-read when next opened. A catch-up brings what changed,
   * except a reaction taken back, which leaves no dated trace; re-reading on opening covers it.
   */
  const staleRef = useRef(new Set<string>());
  /** `loadThread`, reachable from the resync above its declaration. */
  const loadThreadRef = useRef<(conv: string, parentId: string) => void>(() => {});

  /**
   * Spaces already taken off the rail. A departure arrives twice (the real-time frame and the answer
   * to the call that caused it), and the second arrival must not switch space a second time.
   */
  const droppedSpacesRef = useRef(new Set<string>());

  useEffect(() => {
    liveRef.current = { channels, dms, channelId, view, myId: session?.id, ws, spaces: workspaces };
  });

  // Live realtime channel: connect once per session and dispatch server pushes into state. Mutations
  // still go through REST; this only receives (and sends typing/ping).
  useEffect(() => {
    // A document's own tab listens to nothing: the editor needs no live event, and a connection would
    // count this tab as the member being present in the space.
    if (!session || standalone || maybeDocumentTab) return;
    const conn = connectRealtime({
      onReconnect: () => resyncRef.current(),
      onMessageCreated: (conv, m) => {
        const { channelId: active, myId } = liveRef.current;
        // Our own message is already shown optimistically and reconciled by the POST response; skip
        // the echo so it does not briefly duplicate at the bottom of the feed.
        if (m.authorId && m.authorId === myId) return;
        const parentId = m.parentId;
        setMessages((prev) => {
          const next = upsertMessage(prev, conv, { ...m, fresh: true });
          // A reply is held with the rest of the conversation, and kept out of the feed when the
          // feed is drawn. What the feed does show of it is its root's counter and faces.
          return parentId ? adjustReplyCount(next, conv, parentId, 1, m.author, m.createdAt) : next;
        });
        // The author stopped typing the moment they sent: clear their now-stale typing signal.
        const author = m.authorId;
        if (author) {
          setTyping((prev) => {
            const users = prev[conv];
            if (!users || !(author in users)) return prev;
            const next = { ...users };
            delete next[author];
            return { ...prev, [conv]: next };
          });
        }
        // Everything below is about the feed and the counters that follow it, neither of which a
        // reply takes part in: the history endpoint leaves replies out, and so do the unread counters
        // the server keeps.
        if (parentId) return;
        // The conversation list previews what was just said, whether or not it is being read.
        setDms((prev) =>
          prev.map((d) => (d.id === conv ? { ...d, lastMessage: { excerpt: m.body, mine: false, at: m.createdAt ?? new Date().toISOString() } } : d)),
        );
        // Reading is having it on screen while looking at the screen. Sitting in a conversation
        // never advanced the read cursor: it moved only when a conversation was opened, so someone
        // who stayed in a channel accumulated unread messages they were watching arrive, and their
        // read receipt told the sender "Non lu" about a message they had just answered.
        if (conv === active && liveRef.current.view === "channel" && !appIsAway()) {
          markSeenRef.current(conv, m.id);
          return;
        }
        // Someone else posted in a conversation we are not looking at: bump its unread badge.
        if (conv !== active) {
          setChannels((prev) => prev.map((c) => (c.id === conv ? { ...c, unread: c.unread + 1 } : c)));
          setDms((prev) => prev.map((d) => (d.id === conv ? { ...d, unread: d.unread + 1 } : d)));
        }
        // A conversation we hold nothing about belongs to a space that is not loaded: the rail's
        // counters are the only place it can show, and only the server can attribute it.
        const known = liveRef.current;
        if (!known.channels.some((c) => c.id === conv) && !known.dms.some((d) => d.id === conv)) {
          refreshSpaceCounters();
        }
      },
      onMessageUpdated: (conv, m) => setMessages((prev) => replaceMessage(prev, conv, m)),
      // A deleted reply also comes off its root's counter, the way the API takes it off the stored
      // one, so the feed goes on saying how many replies there are to read.
      onMessageDeleted: (conv, m) => {
        const parentId = m.parentId;
        setMessages((prev) => {
          const next = replaceMessage(prev, conv, m);
          return parentId ? adjustReplyCount(next, conv, parentId, -1) : next;
        });
      },
      onReaction: (conv, r) => {
        // Our own reaction is already applied optimistically; only fold in other users' deltas.
        if (r.userId === liveRef.current.myId) return;
        setMessages((prev) => applyReactionDelta(prev, conv, r));
      },
      onPinned: (conv, messageId, pinned) => {
        setMessages((prev) => {
          const list = prev[conv];
          if (!list || !list.some((m) => m.id === messageId)) return prev;
          return { ...prev, [conv]: list.map((m) => (m.id === messageId ? { ...m, pinned } : m)) };
        });
      },
      onChannelCreated: (channel) => {
        // Only the space on screen: an event for another one is folded in when it is next loaded.
        if (channel.spaceId !== liveRef.current.ws) return;
        setChannels((prev) =>
          prev.some((c) => c.id === channel.id)
            ? prev
            : [
                ...prev,
                {
                  id: channel.id,
                  name: channel.name,
                  type: channel.type,
                  topic: channel.topic,
                  fav: false,
                  unread: 0,
                  // Nobody has joined a channel they have only just been told about. The creator
                  // is the exception, and the response to their own call corrects this row when
                  // it lands, whichever of the two arrives first.
                  member: false,
                },
              ],
        );
      },
      onChannelUpdated: (channel) => {
        const { ws: activeWs, channels: current, channelId: openId } = liveRef.current;
        if (channel.spaceId !== activeWs) return;
        const row = current.find((c) => c.id === channel.id);
        if (!row) return;
        // A channel turned private leaves the sidebar of everyone who is not in it: this event is
        // the only way they learn they lost access to it.
        if (channel.type === "private" && row.member !== true) {
          setChannels((prev) => prev.filter((c) => c.id !== channel.id));
          if (openId === channel.id) {
            // Move off the conversation that just closed. `setChannelId` rather than `openChannel`:
            // the handlers are wired before it is declared, and there is no panel to reset here.
            const fallback = current.find((c) => c.id !== channel.id);
            if (fallback) setChannelId(fallback.id);
          }
          return;
        }
        setChannels((prev) =>
          prev.map((c) =>
            c.id === channel.id ? { ...c, name: channel.name, type: channel.type, topic: channel.topic } : c,
          ),
        );
      },
      onMemberJoined: (member) => {
        // Only the space on screen: an arrival elsewhere is folded in when that space is next
        // loaded. Keeping the roster sorted matches the order the API returns it in, so the list
        // does not reshuffle on the next load.
        if (member.spaceId !== liveRef.current.ws) return;
        setMembers((prev) =>
          prev.some((m) => m.userId === member.userId)
            ? prev
            : [...prev, member].sort((a, b) => a.name.localeCompare(b.name, "fr")),
        );
        // The newcomer is in the audience too; they do not need to be told they arrived.
        if (member.userId !== liveRef.current.myId) {
          notifyRef.current?.({ tone: "info", title: tRef.current("system.memberJoined", { who: member.name }) });
        }
      },
      onMemberLeft: (spaceId, userId) => {
        // Only the space on screen, like an arrival: a departure elsewhere is folded in when that
        // space is next loaded. The channel notice that travels alongside is an ordinary message and
        // lands on its own.
        if (spaceId !== liveRef.current.ws) return;
        setMembers((prev) => prev.filter((m) => m.userId !== userId));
      },
      onChannelDeleted: (spaceId, channelId) => {
        const { ws: activeWs, channels: current, channelId: openId } = liveRef.current;
        if (spaceId !== activeWs) return;
        const row = current.find((c) => c.id === channelId);
        dropChannelRef.current(channelId);
        // Said only to someone who was in it: a channel that disappears from under the reader needs
        // a sentence, one that leaves a sidebar nobody was looking at does not.
        if (row && openId === channelId) {
          notifyRef.current?.({ tone: "info", title: tRef.current("channel.deletedElsewhere", { name: row.name }) });
        }
      },
      onSpaceRemoved: (spaceId, reason) => {
        // This account left the space in another tab, or its owner deleted it, or somebody took
        // this account out of it. The rail has to lose it in all three. The sentence is only for the
        // two the person did not decide: whoever pressed the button in this tab has already been
        // told by the handler that pressed it, and saying it twice is how a confirmation starts
        // reading as an alarm.
        const gone = liveRef.current.spaces.find((w) => w.id === spaceId);
        const ours = droppedSpacesRef.current.has(spaceId);
        dropSpaceRef.current(spaceId);
        if (reason === "left" || !gone || ours) return;
        notifyRef.current?.({
          tone: "info",
          title:
            reason === "deleted"
              ? tRef.current("toast.spaceDeletedElsewhere", { name: gone.name })
              : tRef.current("toast.removedFromSpace", { name: gone.name }),
        });
      },
      onMemberRoleChanged: (spaceId, userId, role) => {
        // Their own role in the space on screen: reload it. A role decides which channels, people
        // and files the server will hand over, so the lists this client is holding were computed
        // under the old one. Demoting someone to guest left them looking at a sidebar they could no
        // longer open anything in, until they happened to reload.
        if (userId === liveRef.current.myId && spaceId === liveRef.current.ws) {
          void reloadSpaceRef.current(spaceId);
        }
        // The roster only when it is the space on screen; the caller's own role in *any* space,
        // because that one decides what the rail and the settings offer and is held per space.
        if (spaceId === liveRef.current.ws) {
          setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, role } : m)));
        }
        if (userId === liveRef.current.myId) {
          setWorkspaces((prev) => prev.map((w) => (w.id === spaceId ? { ...w, role } : w)));
        }
      },
      onMemberUpdated: (member) => {
        // Not filtered by space: a profile is the same everywhere, and the roster on screen is the
        // only one this client holds. Fields are replaced rather than merged, so clearing a photo
        // clears it here too.
        setMembers((prev) =>
          prev.map((m) =>
            m.userId === member.userId
              ? { ...m, name: member.name, title: member.title, avatarUrl: member.avatarUrl }
              : m,
          ),
        );
        setDms((prev) => prev.map((d) => (d.userId === member.userId ? { ...d, name: member.name } : d)));
        // A message row carries the author's name, not their id, so a rename would leave every line
        // already on screen under the old one, and its avatar unresolvable (the seam looks a photo
        // up by name). Rewriting them here is the one moment that name can go stale, and it keeps
        // every view that reads the message map right at once: the feed, threads, mentions, saved
        // items and search.
        setMessages((prev) => {
          let touched = false;
          const next: MessageMap = {};
          for (const [conv, list] of Object.entries(prev)) {
            let inList = false;
            const mapped = list.map((m) => {
              if (m.authorId !== member.userId || m.author === member.name) return m;
              inList = true;
              return { ...m, author: member.name };
            });
            next[conv] = inList ? mapped : list;
            touched = touched || inList;
          }
          return touched ? next : prev;
        });
      },
      onChannelsReordered: (spaceId) => {
        // Only the space on screen: the others are read in their new order when next opened. The
        // list is re-read rather than reordered here, because the event names no channel.
        if (spaceId !== liveRef.current.ws) return;
        void getChannels(spaceId)
          .then((fresh) => {
            if (liveRef.current.ws === spaceId) setChannels(fresh);
          })
          .catch(() => {
            // The order simply stays as it was until the next load.
          });
      },
      onSpaceUpdated: (space) => {
        // Shared settings only: the counters and the caller's role are not in the event, precisely
        // because they differ per recipient, so whatever this client holds for them stands.
        setWorkspaces((prev) =>
          prev.map((w) =>
            w.id === space.id
              ? { ...w, name: space.name, slug: space.slug, iconUrl: space.iconUrl, defaultChannelId: space.defaultChannelId }
              : w,
          ),
        );
      },
      onPresence: (userId, p) => {
        setPresence((prev) => ({ ...prev, [userId]: p }));
        setDms((prev) => prev.map((d) => (d.userId === userId ? { ...d, presence: p } : d)));
      },
      onNotification: (n) => {
        const { channels: chs, dms: dmList, channelId: activeConv, view: activeView } = liveRef.current;
        const channel = chs.find((x) => x.id === n.conversationId);
        const dm = dmList.find((x) => x.id === n.conversationId);
        // Falls back to the server's name, not to the identifier: a notification from a space that
        // is not open used to arrive labelled with a UUID.
        const label = channel
          ? `#${channel.name}`
          : dm
            ? dm.name
            : n.channelName
              ? `#${n.channelName}`
              : "";
        // Addressed to us in a space we have not loaded: it belongs to that space's rail badge, and
        // only the server can say which space that is.
        if (!channel && !dm) refreshSpaceCounters();
        // If the recipient is already looking at that conversation, the notification is redundant:
        // file it as already read (both locally and on the server) and do not bump the unread badge.
        const viewing = n.conversationId === activeConv && activeView === "channel";
        const notif: AppNotification = {
          id: n.id,
          kind: n.kind as NotifKind,
          channelId: n.conversationId,
          spaceId: n.spaceId,
          label,
          spaceName: n.spaceName,
          isDm: dm ? true : !channel && !n.channelName,
          actor: n.actor,
          messageId: n.messageId,
          preview: n.preview,
          createdAt: n.createdAt,
          read: n.read || viewing,
          reminder: n.reminder,
        };
        setNotifs((prev) => [notif, ...prev.filter((x) => x.id !== n.id)]);
        if (viewing) {
          void markNotificationRead(n.id).catch(() => {});
          return;
        }
        // Ensure the source conversation shows as unread. `Math.max` so this never double-counts with
        // the message.created bump when both fire (a mention the viewer also received as a message).
        setChannels((prev) => prev.map((c) => (c.id === n.conversationId ? { ...c, unread: Math.max(c.unread, 1) } : c)));
        setDms((prev) => prev.map((d) => (d.id === n.conversationId ? { ...d, unread: Math.max(d.unread, 1) } : d)));
        // The badge is for when you come back. This is for when you do not.
        alertRef.current?.(notif);
      },
      onTyping: (conv, userId) =>
        setTyping((prev) => ({ ...prev, [conv]: { ...prev[conv], [userId]: Date.now() } })),
      onFilesUpdated: (spaceId, file, conversationId) =>
        emitFileEvent({ type: "updated", spaceId, file, conversationId }),
      onFilesEditing: (spaceId, fileId, editors) => emitFileEvent({ type: "editing", spaceId, fileId, editors }),
      onCalendarChanged: (calendarId) => emitCalendarChanged(calendarId),
      onFilesDeleted: (spaceId, fileIds) => {
        if (fileIds.length === 0) return;
        emitFileEvent({ type: "deleted", spaceId, fileIds });
        const gone = new Set(fileIds);
        // Every loaded conversation, not only the one on screen: the others are in memory and
        // would otherwise keep a working-looking attachment until they were next opened.
        setMessages((prev) => {
          let touched = false;
          const next: typeof prev = {};
          for (const [conversationId, list] of Object.entries(prev)) {
            next[conversationId] = list.map((m) => {
              // An image attachment is held as an image and not as a file, so both have to be
              // looked at: a picture whose bytes are gone draws an empty frame the size of the
              // picture, which is the loudest way to show an absence.
              const fileId = m.attachment?.fileId ?? m.image?.fileId;
              if (!fileId || !gone.has(fileId)) return m;
              touched = true;
              return {
                ...m,
                image: undefined,
                attachment: {
                  fileId,
                  name: m.attachment?.name ?? m.image?.alt ?? tRef.current("message.file"),
                  sizeBytes: m.attachment?.sizeBytes ?? 0,
                  kind: m.attachment?.kind ?? "image",
                  deleted: true,
                },
              };
            });
          }
          return touched ? next : prev;
        });
        if (spaceId === liveRef.current.ws) {
          setSpaceFiles((prev) => prev.filter((f) => !f.id || !gone.has(f.id)));
        }
      },
      onReadCursor: (conv, userId, lastReadMessageId) =>
        setReadCursors((prev) => {
          const known = prev[conv] ?? { members: [], at: {} };
          return {
            ...prev,
            [conv]: {
              members: known.members.includes(userId) ? known.members : [...known.members, userId],
              at: { ...known.at, [userId]: lastReadMessageId },
            },
          };
        }),
    });
    rtRef.current = conn;
    return () => {
      conn.close();
      rtRef.current = null;
    };
  }, [session, refreshSpaceCounters, standalone, maybeDocumentTab]);

  // Expire typing signals a few seconds after the last keystroke, so the indicator does not stick.
  useEffect(() => {
    const timer = setInterval(() => {
      const cutoff = Date.now() - 5000;
      setTyping((prev) => {
        let changed = false;
        const next: Record<string, Record<string, number>> = {};
        for (const [conv, users] of Object.entries(prev)) {
          const fresh: Record<string, number> = {};
          for (const [uid, ts] of Object.entries(users)) {
            if (ts >= cutoff) fresh[uid] = ts;
            else changed = true;
          }
          if (Object.keys(fresh).length > 0) next[conv] = fresh;
        }
        return changed ? next : prev;
      });
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  // Dev-only: land directly on a UI state from query params (see lib/dev/deeplink.ts).
  // A no-op in the production static export; used by tools/responsive-audit to reach every screen.
  useEffect(() => {
    const link = readDeepLink();
    if (!link) return;
    // One-shot dev entry point: apply the URL deep-link to the app's state on mount. Reading it in the
    // state initializers instead would diverge from the server render (readDeepLink is client-only), so
    // the synchronous setStates here are intentional.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (link.stage) setAuthStage(link.stage);
    // The invitation screen has nothing to show without a resolved token, and the audits run
    // offline: seed the card it renders for a real invitation so the state is auditable.
    if (link.stage === "invite") {
      setInviteStatus("ready");
      // i18n-audit-ignore-next-line -- sample data for the offline preview, not interface prose
      setInvitePreview({ spaceName: "Atelier Néon", invitedBy: "Alice Moreau", role: "member" });
    }
    if (link.view) setView(link.view);
    if (link.prefsTab) setPrefsTab(link.prefsTab);
    if (link.channel) setChannelId(link.channel);
    if (link.panel) setPanel(link.panel);
    if (link.modal) setModal(link.modal);
    if (link.push) setMobileContent(true); // compact: land on the pushed content, not the list
    // Appearance is a persisted setting, not component state, so the audit forces it through the store.
    // Write it to localStorage here (this child effect runs before the SettingsProvider's own load
    // effect, so the provider picks the forced value up instead of clobbering it) and reset to the
    // defaults when absent, so a value set by one audit state does not leak into the next (the runner
    // reuses one page, so localStorage persists across navigations).
    try {
      const raw = localStorage.getItem("ruchoir.settings");
      const stored = raw ? JSON.parse(raw) : {};
      localStorage.setItem(
        "ruchoir.settings",
        JSON.stringify({
          ...stored,
          textSize: link.text ?? "m",
          font: link.font ?? "plex",
          // Hidden by default under a deep-link so it does not clutter every audited screen; welcome=1 shows it.
          welcome: { dismissed: !link.welcome, done: [] },
        }),
      );
    } catch {
      // ignore storage failures (dev-only affordance)
    }
    // Dev-only: open a click-only popover on load (audit coverage). Set in the effect, NOT during
    // render, so the server and first client render match (reading it at render time would open the
    // popover only on the client -> hydration mismatch).
    if (link.pop) setDeepLinkPop(link.pop);
    /* eslint-enable react-hooks/set-state-in-effect */
    // Run once on mount; deep-link is an entry point, not a live binding.
  }, []);

  const dm = dms.find((d) => d.id === channelId) ?? null;
  const chan: Channel =
    channels.find((c) => c.id === channelId) ??
    ({ id: channelId, name: dm?.name ?? t("channel.fallbackName"), fav: false, unread: 0, type: "public" } as Channel);
  // Memoised because the `?? []` branch is a fresh array every render, which would re-run anything
  // that depends on the feed (the read receipts below) on every render for no reason.
  //
  // Replies are held with the rest of their conversation, so that saving, reacting to, editing or
  // deleting one goes through the very same handlers as a message in the channel. The feed is where
  // they are taken back out: a thread is read in its panel, and a reply in the channel would be a
  // sentence out of the conversation it belongs to.
  const conversationMessages = useMemo(() => messages[channelId] ?? [], [messages, channelId]);
  const feed = useMemo(() => conversationMessages.filter((m) => !m.parentId), [conversationMessages]);
  /** The open thread's replies, oldest first, from that same list. */
  const threadReplies = useMemo(
    () =>
      thread == null
        ? []
        : conversationMessages
            .filter((m) => m.parentId === thread)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [conversationMessages, thread],
  );

  /**
   * The spaces in the order this person arranged them.
   *
   * The stored order holds ids, not spaces: one they have left is skipped, and one they have joined
   * since arranging the rail appears at the end rather than forcing the arrangement to be redone.
   */
  const orderedWorkspaces = useMemo(() => {
    const order = settings.spaceOrder;
    if (order.length === 0) return workspaces;
    const rank = new Map(order.map((id, i) => [id, i] as const));
    return [...workspaces].sort((a, b) => {
      const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return ra === rb ? 0 : ra - rb;
    });
  }, [workspaces, settings.spaceOrder]);

  /**
   * The direct conversations the sidebar shows.
   *
   * A hidden one comes back the moment it has something unread, and the one being read stays put:
   * hiding the conversation you are looking at and watching it vanish under you would be its own
   * small defect. Hiding is a display choice, so it lives with the preferences and touches nothing
   * on the server.
   */
  const visibleDms = useMemo(() => {
    if (settings.hiddenDms.length === 0) return dms;
    const hidden = new Set(settings.hiddenDms);
    return dms.filter((d) => !hidden.has(d.id) || d.unread > 0 || d.id === channelId);
  }, [dms, settings.hiddenDms, channelId]);

  // A hidden conversation that receives something is back for good, not until it is read: leaving it
  // in the hidden list would make it disappear again the moment the message is seen, which reads as
  // the app losing a conversation.
  useEffect(() => {
    if (settings.hiddenDms.length === 0) return;
    const returning = dms.filter((d) => d.unread > 0 && settings.hiddenDms.includes(d.id)).map((d) => d.id);
    if (returning.length === 0) return;
    settings.set(
      "hiddenDms",
      settings.hiddenDms.filter((id) => !returning.includes(id)),
    );
    // `settings` is a context value rebuilt on every change; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dms, settings.hiddenDms]);

  /** Hide a direct conversation, and leave it if it is the one on screen. */
  const hideDm = (id: string) => {
    if (!settings.hiddenDms.includes(id)) settings.set("hiddenDms", [...settings.hiddenDms, id]);
    if (channelId === id) {
      const fallback = channels[0]?.id;
      if (fallback) openChannel(fallback);
    }
  };

  /** Move a space in the rail and remember the whole resulting order. */
  const reorderWorkspace = (spaceId: string, toIndex: number) => {
    const ids = orderedWorkspaces.map((w) => w.id);
    const from = ids.indexOf(spaceId);
    if (from === -1) return;
    ids.splice(from, 1);
    ids.splice(toIndex, 0, spaceId);
    settings.set("spaceOrder", ids);
  };

  // The space's members with live presence overlaid, feeding the member list, the @-mention
  // autocomplete and the people section of search. Falls back to the mock roster before load.
  const memberRecords = useMemo(
    () =>
      members.map((m) => ({
        // The account id travels with the record: a dialog that acts on a person (adding them to a
        // channel) needs the identifier the API uses, and a display name is not one.
        userId: m.userId,
        name: m.name,
        presence: (presence[m.userId] ?? "offline") as Presence,
        bot: m.bot,
        avatar: m.avatarUrl,
      })),
    [members, presence],
  );
  // Publish the real roster and per-name presence into the data seam, which the composer, message
  // renderer and dialogs read synchronously (getChannelMembers / getMentionNames / getPresence).
  //
  // Published even when it is empty. It used to return early instead, on the reasoning that an
  // empty roster is not worth publishing, which quietly meant the people of the space being left
  // stayed readable in the space being entered: the mention autocomplete offered colleagues who
  // were not in the room.
  useEffect(() => {
    setChannelMembers(memberRecords);
    for (const m of members) {
      if (presence[m.userId]) setUserPresence(m.name, presence[m.userId]);
    }
  }, [memberRecords, members, presence]);

  // The rooms a `#name` can point at: the channels of this space, which is what the composer
  // offers and what the renderer turns into a link.
  useEffect(() => {
    setSpaceRooms(channels.map((c) => c.name));
  }, [channels]);
  const people = memberRecords;

  /**
   * Who has read each message of the conversation on screen, by display name.
   *
   * A cursor names the last message someone read, so everything at or before it in this window has
   * been read by them. A cursor pointing outside the window is older than everything loaded, which
   * is the same as having read none of it. Our own cursor is left out: a receipt is what other
   * people tell you, and reading your own message is not news.
   */
  const readBy = useMemo(() => {
    const conversation = readCursors[channelId] ?? { members: [], at: {} };
    const position = new Map(feed.map((m, index) => [m.id, index] as const));
    const out: Record<string, string[]> = {};
    for (const [userId, messageId] of Object.entries(conversation.at)) {
      if (userId === session?.id) continue;
      const upTo = position.get(messageId);
      if (upTo === undefined) continue;
      const name = members.find((m) => m.userId === userId)?.name;
      if (!name) continue;
      for (let i = 0; i <= upTo; i += 1) {
        (out[feed[i].id] ??= []).push(name);
      }
    }
    return out;
  }, [readCursors, channelId, feed, members, session?.id]);

  /** How many people other than us could read this conversation, which is what a count is out of. */
  const readAudience = Math.max(0, (readCursors[channelId]?.members.length ?? 1) - 1);


  // Reverse lookup (user id -> display name) for realtime signals that arrive as bare ids (typing,
  // presence), built from the DM counterparts and the authors seen in the loaded feeds.
  const userNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const m of members) names[m.userId] = m.name;
    for (const d of dms) if (d.userId) names[d.userId] = d.name;
    for (const list of Object.values(messages)) {
      for (const msg of list) if (msg.authorId) names[msg.authorId] = msg.author;
    }
    return names;
  }, [members, dms, messages]);

  // Names currently typing in the open conversation, excluding the current user. Freshness is kept by
  // the pruning interval below (which drops stale signals), so this stays a pure derivation.
  const typingNames = useMemo(() => {
    const users = typing[channelId] ?? {};
    return Object.keys(users)
      .map((uid) => userNames[uid] ?? "Quelqu'un")
      .filter((name) => name !== currentUser);
  }, [typing, channelId, userNames, currentUser]);

  // The opened profile's user id, when resolvable (DM counterpart, or an author seen in a feed), so
  // the profile panel can fetch the real profile from the API instead of the mock.
  const profileUserId = useMemo(() => {
    if (!profile) return undefined;
    const dm = dms.find((d) => d.name === profile);
    if (dm?.userId) return dm.userId;
    return Object.entries(userNames).find(([, name]) => name === profile)?.[0];
  }, [profile, dms, userNames]);
  /**
   * Bookmarks, from the server, for the whole account.
   *
   * Derived from the loaded messages until the request lands, so the view is never blank, and
   * re-read whenever the Saved view is opened: it is a small list and the alternative is a page
   * that silently omits everything outside the space on screen, which is most of it.
   */
  const [savedRows, setSavedRows] = useState<SavedMessage[] | null>(null);
  useEffect(() => {
    if (view !== "saved") return;
    let active = true;
    getSavedMessages()
      .then((rows) => active && setSavedRows(rows))
      .catch(() => {
        // The derived list stays: fewer bookmarks than there are beats none.
      });
    return () => {
      active = false;
    };
  }, [view]);
  const saved: ActivityItem[] =
    savedRows?.map((row) => ({
      channelId: row.conversationId,
      // The server's name, unless this client knows the conversation and can say it its own way.
      label:
        channels.find((c) => c.id === row.conversationId)?.name !== undefined
          ? `#${channels.find((c) => c.id === row.conversationId)?.name}`
          : (dms.find((d) => d.id === row.conversationId)?.name ??
            (row.channelName ? `#${row.channelName}` : row.message.author)),
      isDm: !row.channelName,
      message: row.message,
    })) ?? collectSaved(messages, channels, dms);
  const mentions = collectMentions(messages, channels, dms, currentUser);
  const threads = collectThreads(messages, channels, dms);

  // The notification level of the space on screen (declared here: the workspace record is read
  // further down, after this point is needed).
  const wsNotifyLevel = workspaces.find((w) => w.id === ws)?.notifyLevel;
  // Notifications the user should actually see, after applying the per-channel and global preferences.
  const visibleNotifs = useMemo(
    // Scoped to the space on screen. The inbox is fetched for the whole account (a notification is
    // addressed to a person, not to a space) and the rail already carries the count for the others,
    // so showing all of them here would report the same mention twice and point at a conversation
    // this space does not contain.
    () =>
      notifs.filter(
        (n) =>
          // A reminder from a personal calendar belongs to no space: every space shows it.
          (n.spaceId === ws || (n.kind === "calendar_reminder" && !n.spaceId)) &&
          passesPref(n, channelPrefs[n.channelId], settings.notif, wsNotifyLevel),
      ),
    [notifs, ws, channelPrefs, settings.notif, wsNotifyLevel],
  );
  const notifUnread = visibleNotifs.filter((n) => !n.read).length;
  /**
   * The Mentions badge: unread mention notifications in this space.
   *
   * Not `mentions.length`, which is every message that ever named you and therefore a number that
   * only ever grows. Counting the notification rows instead ties the badge to the same read state
   * as the rail and the inbox, so the three cannot disagree.
   */
  const mentionUnread = visibleNotifs.filter((n) => isMention(n.kind) && !n.read).length;

  /**
   * The tab title: what is waiting, where you are, and in which space.
   *
   * "Ruchoir" alone told a person with several tabs open nothing about which one held the
   * conversation they were looking for. The unread count comes first because that is what a glance
   * at a background tab is asking, and it is the whole account's, not this space's: a tab that says
   * nothing is waiting while another space is holding a mention would be worse than no count. The
   * product name stays last so the useful part survives the browser's truncation.
   */
  useEffect(() => {
    if (!session) {
      document.title = "Ruchoir";
      return;
    }
    // A document's own tab is named after the document, by the editor.
    if (standalone) return;
    const waiting = notifs.filter((n) => !n.read).length;
    const dmHere = dms.find((d) => d.id === channelId);
    const channelHere = channels.find((c) => c.id === channelId);
    const here =
      view === "channel"
        ? (dmHere?.name ?? (channelHere ? `#${channelHere.name}` : undefined))
        : (VIEW_TITLES[view] ? t(VIEW_TITLES[view]) : undefined);
    const parts = [here, workspaces.find((w) => w.id === ws)?.name, "Ruchoir"].filter(Boolean);
    document.title = `${waiting > 0 ? `(${waiting}) ` : ""}${parts.join(" · ")}`;
  }, [session, notifs, view, channelId, channels, dms, workspaces, ws, t, standalone]);

  /**
   * Switch the main view, and treat opening Mentions as reading them.
   *
   * A list whose whole purpose is to be looked at has to clear when it is looked at; leaving the
   * badge until each conversation is opened one by one is how it came to look permanent.
   */
  const openView = (next: AppView) => {
    setView(next);
    if (next !== "mentions") return;
    const toMark = visibleNotifs.filter((n) => isMention(n.kind) && !n.read);
    if (toMark.length === 0) return;
    const ids = new Set(toMark.map((n) => n.id));
    setNotifs((prev) => prev.map((n) => (ids.has(n.id) ? { ...n, read: true } : n)));
    for (const n of toMark) void markNotificationRead(n.id).catch(() => {});
  };

  const setNotifRead = (id: string, read: boolean) => {
    setNotifs((prev) => prev.map((n) => (n.id === id ? { ...n, read } : n)));
    // The API only marks a notification read (there is no "unread" inverse), so sync only that way.
    if (read) void markNotificationRead(id).catch(() => {});
  };
  const markAllNotifsRead = () => {
    setNotifs((prev) => prev.map((n) => ({ ...n, read: true })));
    void markAllNotificationsRead().catch(() => {});
  };
  /**
   * What a conversation left on `default` currently gets: the space's level, else one's own
   * preferences (which say "every message" or not). Said under "default" in the level dialogs.
   */
  const spaceLevel = effectiveLevel(undefined, wsNotifyLevel);
  const inheritedLevel: NotifLevel =
    spaceLevel === "default" ? (settings.notif.messages ? "all" : "mentions") : spaceLevel;

  /** Set how much a whole space notifies: kept by the server, which obeys it for push and email. */
  const saveSpaceLevel = (spaceId: string, level: NotifLevel) => {
    const before = workspaces.find((w) => w.id === spaceId)?.notifyLevel ?? "default";
    setWorkspaces((prev) => prev.map((w) => (w.id === spaceId ? { ...w, notifyLevel: level } : w)));
    void saveSpaceNotify(spaceId, level).catch(() => {
      setWorkspaces((prev) => prev.map((w) => (w.id === spaceId ? { ...w, notifyLevel: before } : w)));
      showToast({ tone: "danger", title: t("admin.settingsSaveFailed") });
    });
  };
  const saveChannelPref = (id: string, pref: ChannelNotifPref) => {
    const before = channelPrefs[id];
    setChannelPrefs((prev) => ({ ...prev, [id]: pref }));
    // Kept by the server, because the server is what reaches a closed browser or a mailbox: a
    // channel muted here has to be muted there too.
    void saveConversationNotify(id, pref).catch(() => {
      setChannelPrefs((prev) => {
        const next = { ...prev };
        if (before) next[id] = before;
        else delete next[id];
        return next;
      });
      showToast({ tone: "danger", title: t("admin.settingsSaveFailed") });
    });
  };

  /** Mark a whole conversation read: clears its unread badge and any pending notifications from it. */
  const markConversationRead = (id: string, loaded?: Message[]) => {
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
    setDms((prev) => prev.map((d) => (d.id === id ? { ...d, unread: 0 } : d)));
    // Clear this conversation's notifications from the inbox too, locally and on the server, so
    // reading the channel directly (not via the notification center) empties its unread there.
    const toMark = notifs.filter((n) => n.channelId === id && !n.read);
    setNotifs((prev) => prev.map((n) => (n.channelId === id ? { ...n, read: true } : n)));
    for (const n of toMark) void markNotificationRead(n.id).catch(() => {});
    // Advance the server-side read cursor to the latest acknowledged message. Best-effort: a failure
    // only means the badge reappears on reload, so it is not surfaced.
    const list = loaded ?? messages[id] ?? [];
    // A cursor is a position in the conversation as it is read, and replies are read in their
    // thread: the last one of those is not where the channel was left off.
    const last = [...list].reverse().find((m) => !isPendingId(m.id) && !m.parentId);
    if (last) void setReadCursor(id, last.id).catch(() => {});
    // The rail counts the whole account, so reading here changes a number drawn over there. It is
    // re-read rather than decremented: the arithmetic would have to mirror the server's definition
    // of unread, and the two would drift the day one of them changed.
    refreshSpaceCounters();
  };
  useEffect(() => {
    markReadRef.current = markConversationRead;
  });

  /**
   * A message watched arriving is a message read: advance the cursor to it, and clear anything the
   * inbox holds for that conversation.
   *
   * Filed at once rather than debounced. A cursor is a single value and the last write wins, so a
   * burst of messages costs a handful of small requests and never leaves the cursor behind the
   * conversation, which is the failure this exists to prevent.
   */
  useEffect(() => {
    markSeenRef.current = (conversationId, messageId) => {
      void setReadCursor(conversationId, messageId).catch(() => {});
      const waiting = notifs.filter((n) => n.channelId === conversationId && !n.read);
      if (waiting.length === 0) return;
      setNotifs((prev) => prev.map((n) => (n.channelId === conversationId ? { ...n, read: true } : n)));
      for (const n of waiting) void markNotificationRead(n.id).catch(() => {});
      refreshSpaceCounters();
    };
  });

  /**
   * Re-read what is on screen: the open conversation (and its open thread), the sidebar's lists and
   * the rail's counters.
   *
   * Pushes are not replayed. A tab in the background is throttled or frozen by the browser, and its
   * connection is often dropped and reopened; everything sent in between was lost, so coming back
   * showed the conversation as it was when the tab was left. Merged by id, so nothing already on
   * screen is doubled, older history loaded by scrolling is kept, and messages still being sent stay.
   */
  const lastResync = useRef(0);
  useEffect(() => {
    resyncRef.current = () => {
      const space = ws;
      const conv = channelId;
      if (!space) return;
      lastResync.current = Date.now();
      if (conv) {
        void getChannelMessages(conv)
          .then((page) => {
            if (liveRef.current.ws !== space) return;
            setMessages((prev) => page.messages.reduce((map, m) => upsertMessage(map, conv, m), prev));
            // Being on the conversation is reading it, as when it is opened.
            if (document.visibilityState === "visible" && liveRef.current.view === "channel" && liveRef.current.channelId === conv) {
              markReadRef.current(conv, page.messages);
            }
          })
          .catch(() => {
            // The next push or the next return tries again.
          });
        if (thread) loadThreadRef.current(conv, thread);
      }
      // Everything else of the space, in one request: new messages, edits, deletions and replies in
      // every conversation, not only the one on screen.
      const cursor = syncCursorRef.current;
      if (cursor && cursor.space === space) {
        void getChanges(space, cursor.since)
          .then((result) => {
            if (liveRef.current.ws !== space) return;
            if (result.truncated) {
              // Away too long, or too much happened: a list would be slower than starting over.
              void reloadSpaceRef.current(space);
              return;
            }
            syncCursorRef.current = { space, since: result.now };
            if (result.changes.length > 0) setMessages((prev) => applyChanges(prev, result.changes));
            for (const c of [...liveRef.current.channels, ...liveRef.current.dms]) {
              if (c.id !== conv) staleRef.current.add(c.id);
            }
          })
          .catch(() => {
            // The cursor stays where it was, so the next attempt covers this gap as well.
          });
      }
      // The inbox, for the notifications pushed while away.
      void getNotifications()
        .then((feed) => {
          if (liveRef.current.ws !== space) return;
          const { channels: chs, dms: dmList } = liveRef.current;
          setNotifs((prev) => {
            const held = new Map(prev.map((n) => [n.id, n]));
            const merged = feed.notifications.map((n) => {
              const mine = held.get(n.id);
              held.delete(n.id);
              return mine ? { ...mine, read: mine.read || n.read } : toAppNotification(n, chs, dmList, n.read);
            });
            return [...merged, ...held.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          });
        })
        .catch(() => {});
      void getChannels(space)
        .then((fresh) => {
          if (liveRef.current.ws === space) setChannels(fresh);
        })
        .catch(() => {});
      void getDirectMessages(space)
        .then((fresh) => {
          if (liveRef.current.ws !== space) return;
          setDms(fresh.map((d) => (d.userId && presence[d.userId] ? { ...d, presence: presence[d.userId] } : d)));
        })
        .catch(() => {});
      void reloadSpaceCounters();
    };
  });

  /**
   * Coming back to the window catches up on whatever arrived while it was elsewhere.
   *
   * Messages that land while the app is in the background are deliberately left unread, since
   * nobody read them. Returning is what reads them, and without this the conversation on screen
   * stayed unread until it was opened again. Returning to the tab also re-reads the screen (see
   * `resync`), at most every few seconds: switching back and forth is not worth a request each time.
   */
  useEffect(() => {
    const catchUp = () => {
      if (standalone || document.visibilityState !== "visible") return;
      if (Date.now() - lastResync.current > 5000) resyncRef.current();
      if (view !== "channel" || !channelId) return;
      markConversationRead(channelId);
    };
    window.addEventListener("focus", catchUp);
    document.addEventListener("visibilitychange", catchUp);
    return () => {
      window.removeEventListener("focus", catchUp);
      document.removeEventListener("visibilitychange", catchUp);
    };
  });

  /** Jump to the next (dir 1) or previous (dir -1) unread conversation, channels then DMs, cyclically. */
  const gotoUnread = (dir: 1 | -1) => {
    const ids = [...channels, ...dms].filter((c) => c.unread > 0).map((c) => c.id);
    if (ids.length === 0) {
      showToast({ tone: "info", title: t("toast.noUnread") });
      return;
    }
    const cur = ids.indexOf(channelId);
    const next = cur === -1 ? (dir === 1 ? 0 : ids.length - 1) : (cur + dir + ids.length) % ids.length;
    openChannel(ids[next]);
  };

  const showToast = (t: Toast) => {
    setToast(t);
    setToastVisible(true);
    setToastKey((k) => k + 1);
    clearTimeout(toastTimer.current);
    // Long enough to reach for its button, when it has one.
    toastTimer.current = setTimeout(() => setToastVisible(false), t.action ? 8000 : 4000);
  };

  // Keep `notifyRef` (declared with the other realtime refs, and read by handlers wired once per
  // session) pointing at the current `showToast`. It is filled here rather than in the ref-refresh
  // effect above because that effect runs before this declaration, and a forward reference would
  // freeze the first one instead of tracking it.
  useEffect(() => {
    notifyRef.current = showToast;
    tRef.current = t;
  });

  /** Move to an authentication screen with a clean slate (no stale error, notice or pending flag). */
  const goToStage = (stage: AuthStage) => {
    setAuthError(null);
    setAuthSent(false);
    setAuthPending(false);
    setAuthStage(stage);
  };

  /**
   * Leave the authentication flow: keep the session, load the spaces and enter the app. An account
   * that belongs to no space yet (a fresh registration) goes to onboarding instead, which creates
   * its first one: entering an empty shell would be a dead end.
   */
  const enterApp = async (user: SessionUser) => {
    setSession(user);
    setMyChoice(user.presenceChoice);
    setMfaChallenge(null);
    setBooting(true);
    // An invitation the visitor arrived with is accepted before the spaces are loaded, so they land
    // inside the space that invited them rather than in the empty-shell onboarding.
    if (inviteToken) {
      try {
        await acceptInvitation(inviteToken);
      } catch {
        showToast({
          tone: "danger",
          title: t("toast.inviteRefused"),
          description: t("toast.inviteWrongAccount"),
        });
      }
      setInviteToken("");
      forgetInvite();
    }
    const spaces = await loadInitialData();
    setBooting(false);
    setPanel(defaultPanel);
    if (spaces.length === 0) {
      setSignupFirst(user.name.split(" ")[0] ?? "");
      goToStage("onboarding");
      return;
    }
    setAuthStage("app");
    showToast({ tone: "success", title: t("toast.signedIn"), description: t("toast.welcome", { name: user.name.split(" ")[0] }) });
  };

  /**
   * Create the account's first space from onboarding, then enter it. The space is born with a
   * starting channel, so the app opens on a real conversation.
   */
  const handleCreateFirstSpace = async (name: string) => {
    setAuthError(null);
    setAuthPending(true);
    try {
      const space = await createSpace(name);
      setWorkspaces((prev) => [...prev, space]);
      setBooting(true);
      await loadSpace(space.id);
      setBooting(false);
      setAuthStage("app");
      showToast({ tone: "success", title: t("toast.spaceCreated"), description: space.name });
    } catch (err) {
      setBooting(false);
      setAuthError(
        isApiError(err, 400)
          ? key("error.spaceNameUnusable")
          : key("error.createFailed"),
      );
    } finally {
      setAuthPending(false);
    }
  };

  /**
   * Sign in against the API. An account with a second factor answers with a challenge instead of a
   * session: hold it and hand over to the step-up screen. An unconfirmed address is refused with its
   * own code, so the login can offer to send the verification link again.
   */
  const handleLogin = async (email: string, password: string) => {
    setAuthError(null);
    setAuthPending(true);
    try {
      const result = await apiLogin(email, password);
      if (result.kind === "mfa") {
        setMfaChallenge({ methods: result.methods, mfaToken: result.mfaToken });
        goToStage("mfa");
        return;
      }
      await enterApp(result.user);
    } catch (err) {
      if (apiErrorCode(err) === "email_not_verified") setPendingEmail(email);
      setAuthError(authMessage(err, key("error.signInFailed")));
    } finally {
      setAuthPending(false);
    }
  };

  /**
   * Create an account. Registration opens no session: the API emails a confirmation link and refuses
   * sign-in until the address is confirmed, so this lands on the "check your inbox" screen.
   */
  const handleSignup = async ({ email, displayName, password }: SignupValues) => {
    setAuthError(null);
    setAuthPending(true);
    try {
      // The invitation the visitor arrived with, if any: an invitation addressed to this same
      // address proves it, so the account comes back already active and there is no inbox to open.
      const { active } = await apiRegister(email, displayName, password, inviteToken || undefined);
      setPendingEmail(email);
      if (active) {
        goToStage("login");
        showToast({
          tone: "success",
          title: t("toast.accountCreated"),
          description: t("toast.inviteWaiting"),
        });
        return;
      }
      setVerifyStatus("sent");
      goToStage("verify");
    } catch (err) {
      setAuthError(authMessage(err, key("error.createFailed")));
    } finally {
      setAuthPending(false);
    }
  };

  /** Ask for a fresh confirmation link. The API answers the same way for an unknown address. */
  const handleResendVerification = async (email: string) => {
    setAuthPending(true);
    try {
      await requestEmailVerification(email);
      setPendingEmail(email);
      setAuthSent(true);
      setAuthError(null);
    } catch {
      setAuthError(key("error.sendFailed"));
    } finally {
      setAuthPending(false);
    }
  };

  /** Request a password-reset link. The confirmation stays neutral: the API reveals nothing. */
  const handlePasswordResetRequest = async (email: string) => {
    setAuthPending(true);
    try {
      await requestPasswordReset(email);
      setAuthSent(true);
      setAuthError(null);
    } catch {
      setAuthError(key("error.sendFailed"));
    } finally {
      setAuthPending(false);
    }
  };

  /**
   * Take an account back with a recovery code: no message is sent, and nothing here depends on a
   * relay. The failure is deliberately vague, because the API answers the same way for an unknown
   * address and for a wrong code.
   */
  const handleRecoveryReset = async (values: { email: string; code: string; password: string }) => {
    setAuthError(null);
    setAuthPending(true);
    try {
      await resetPasswordWithRecoveryCode(values.email, values.code, values.password);
      setRecoveryDone(true);
    } catch (err) {
      if (isApiError(err, 429)) {
        setAuthError(key("error.tooManyAttemptsWait"));
      } else if (isApiError(err, 422)) {
        setAuthError(key("error.passwordBreached"));
      } else {
        setAuthError(key("error.codeUnknown"));
      }
    } finally {
      setAuthPending(false);
    }
  };

  /** Set the new password behind the emailed token. The server drops every session of that account. */
  const handlePasswordReset = async (password: string) => {
    if (!linkToken) {
      setAuthError(key("error.resetLinkIncomplete"));
      return;
    }
    setAuthError(null);
    setAuthPending(true);
    try {
      await confirmPasswordReset(linkToken, password);
      setLinkToken("");
      setResetDone(true);
    } catch (err) {
      setAuthError(authMessage(err, key("error.resetFailed")));
    } finally {
      setAuthPending(false);
    }
  };

  /** Complete the pending second factor with a typed code (authenticator or recovery). */
  const handleMfaCode = async (method: "totp" | "recovery", code: string) => {
    if (!mfaChallenge) return;
    setAuthError(null);
    setAuthPending(true);
    try {
      const verify = method === "totp" ? verifyTotp : verifyRecoveryCode;
      await enterApp(await verify(mfaChallenge.mfaToken, code));
    } catch (err) {
      // An expired or already-spent challenge cannot be retried: start the sign-in over.
      if (apiErrorCode(err) === "invalid_token") {
        setMfaChallenge(null);
        goToStage("login");
        setAuthError(key("error.signInExpired"));
        return;
      }
      setAuthError(authMessage(err, key("error.verifyFailed")));
    } finally {
      setAuthPending(false);
    }
  };

  /** Complete the pending second factor with a passkey (WebAuthn ceremony, then the assertion). */
  const handleMfaPasskey = async () => {
    if (!mfaChallenge) return;
    setAuthError(null);
    setAuthPending(true);
    try {
      await enterApp(await verifyPasskey(mfaChallenge.mfaToken));
    } catch (err) {
      // The user dismissing the browser prompt is a cancellation, not a failure.
      const cancelled = err instanceof DOMException && err.name === "NotAllowedError";
      setAuthError(
        cancelled
          ? key("error.passkeyCancelled")
          : authMessage(err, key("error.passkeyFailedBody")),
      );
    } finally {
      setAuthPending(false);
    }
  };

  /** End the session server-side, then drop the loaded state and return to the login screen. */
  const handleLogout = async () => {
    // This browser stops receiving pushes for the account leaving it. Before the session ends, since
    // forgetting the subscription on the server is an authenticated call.
    await disablePush().catch(() => {});
    try {
      await apiLogout();
    } catch {
      // Even if the request fails (already-expired session, offline), clear the client state.
    }
    setSession(null);
    setWorkspaces([]);
    setChannels([]);
    setDms([]);
    setMessages({});
    setNotifs([]);
    setMfaChallenge(null);
    setInviteToken("");
    forgetInvite();
    goToStage("login");
  };

  // First-run getting-started checklist, persisted in settings.welcome.
  const markWelcomeDone = (id: string) =>
    settings.set("welcome", { ...settings.welcome, done: Array.from(new Set([...settings.welcome.done, id])) });
  const dismissWelcome = () => settings.set("welcome", { ...settings.welcome, dismissed: true });
  const restartWelcome = () => settings.set("welcome", { dismissed: false, done: settings.welcome.done });
  /** Launch the action for a checklist step and tick it off. */
  const runWelcomeStep = (id: string) => {
    markWelcomeDone(id);
    if (id === "profile") {
      setModal(null);
      setView("channel");
      setThread(null);
      setProfileEdit(true);
      setProfile(currentUser);
    } else if (id === "channel") {
      setModal("newChannel");
    } else if (id === "message") {
      openChannel(channels[0]?.id ?? channelId);
    } else if (id === "invite") {
      setModal("invite");
    }
  };

  /** Open the full-screen preferences on a given section, remembering the current view so closing returns to it. */
  /**
   * Open the instance administration, the same way preferences open: a full-screen view that leaves
   * the underlying space untouched, so closing it comes back exactly where it was.
   */
  const openInstanceAdmin = () => {
    setModal(null);
    if (view !== "instance-admin") setPrevView(view);
    setView("instance-admin");
    setMobileContent(true);
    closeSheets();
  };

  /**
   * Bringing a workspace over from another product. Full-screen like the administration screen, and
   * for the same reason: it is about the instance, never about the space underneath.
   */
  const openImport = () => {
    setModal(null);
    // Opening the screen is how the end of a run is acknowledged: the sidebar stops announcing it.
    // Opened from a run that has ended, it opens on that run, since that is what was clicked.
    setImportDetail(importRun !== null && !importRun.running);
    clearImportRun();
    if (view !== "import") setPrevView(view);
    setView("import");
    setMobileContent(true);
    closeSheets();
  };

  const openPreferences = (tab: PrefTab = "appearance") => {
    setModal(null);
    setPrefsTab(tab);
    if (view !== "prefs") setPrevView(view);
    // Preferences are a full-screen overlay: leave the underlying view, panel and thread untouched so
    // closing them returns to exactly where the user was (with the right panel still open).
    setView("prefs");
    // Compact shell: push the view full-screen over the tab list and close the rail drawer.
    setMobileContent(true);
    closeSheets();
  };

  const openChannel = (id: string) => {
    setView("channel");
    setChannelId(id);
    // Missed while away and not caught up by the catch-up itself (a reaction taken back): the latest
    // page is re-read once, merged into what is held.
    if (staleRef.current.delete(id)) {
      void getChannelMessages(id)
        .then((page) => setMessages((prev) => page.messages.reduce((map, m) => upsertMessage(map, id, m), prev)))
        .catch(() => staleRef.current.add(id));
    }
    // So coming back to this space opens this conversation rather than the first of the list.
    rememberChannel(ws, id);
    // Right panel is app-level state, so reset it per conversation, to whichever panel the
    // preferences name. The compact shell opens with none (there the panel is a full-screen overlay
    // that would hide the conversation), and a panel closed by hand stays closed.
    setPanel(layout !== "desktop" || panelDismissed ? null : defaultPanel);
    setThread(null);
    setProfile(null);
    setProfileEdit(false);
    setUnreadMarker(null);
    setFocusMessageId(null);
    // Opening a conversation marks it read: clears its unread badge, its notifications and advances
    // the read cursor.
    markConversationRead(id);
    // And asks where everyone else has read up to, which is what the read indicator draws. Live
    // afterwards, through `read.updated`.
    void loadReadCursors(id);
  };

  /** Switch the right panel, closing the thread and profile views so it is visible. */
  const openPanel = (next: ChannelPanel) => {
    setPanel(next);
    // Closing the panel (next === null) is a manual dismissal; opening one re-engages the auto-default.
    setPanelDismissed(next === null);
    setThread(null);
    setProfile(null);
  };

  const updateMessage = (targetChannel: string, messageId: string, updater: (m: Message) => Message) => {
    setMessages((prev) => {
      const list = prev[targetChannel] ?? [];
      return { ...prev, [targetChannel]: list.map((m) => (m.id === messageId ? updater(m) : m)) };
    });
  };

  /** Restore a message to a captured snapshot, to undo an optimistic change that the API rejected. */
  const rollbackMessage = (targetChannel: string, snapshot: Message) =>
    updateMessage(targetChannel, snapshot.id, () => snapshot);

  /** Open (or create, via the API) a direct message with a person, then navigate to it. */
  const openDmByName = (name: string) => {
    setModal(null);
    const existing = dms.find((d) => d.name === name);
    if (existing) {
      openChannel(existing.id);
      return;
    }
    const target = members.find((m) => m.name === name);
    if (!target) {
      showToast({ tone: "info", title: t("toast.dmFailed"), description: name });
      return;
    }
    createDm(ws, [target.userId])
      .then((id) => {
        setDms((prev) =>
          prev.some((d) => d.id === id)
            ? prev
            : [
                ...prev,
                {
                  id,
                  name,
                  presence: presence[target.userId] ?? "offline",
                  unread: 0,
                  userId: target.userId,
                  bot: target.bot || undefined,
                },
              ],
        );
        setMessages((prev) => (prev[id] ? prev : { ...prev, [id]: [] }));
        openChannel(id);
      })
      .catch(() => showToast({ tone: "danger", title: t("toast.dmFailed") }));
  };

  /**
   * Read a thread's replies into the conversation they belong to.
   *
   * Called when a thread is opened rather than kept in sync: a conversation's history endpoint
   * deliberately leaves replies out, so a thread nobody has looked at holds nothing but the ones
   * that happened to arrive live. Merged by id, so what is already there is refreshed, not doubled.
   */
  const loadThread = (conv: string, parentId: string) => {
    setThreadLoading(parentId);
    void getReplies(parentId)
      .then((rows) =>
        setMessages((prev) => rows.reduce((map, m) => upsertMessage(map, conv, m), prev)),
      )
      .catch(() => {
        showToast({ tone: "info", title: t("toast.threadNotLoaded") });
      })
      .finally(() => setThreadLoading((current) => (current === parentId ? null : current)));
  };

  useEffect(() => {
    loadThreadRef.current = loadThread;
  });

  const openMessage = (targetChannel: string, messageId: string) => {
    setModal(null);
    openChannel(targetChannel);
    // A reply is read in its thread. Focusing one in the feed looked for a row the feed does not
    // draw, so a notification about an answer led to nothing happening at all; opening the thread
    // puts it where it can be read. Only when we already hold the reply: otherwise the feed still
    // has the better chance of finding it.
    const target = (messages[targetChannel] ?? []).find((m) => m.id === messageId);
    if (target?.parentId) {
      setThread(target.parentId);
      setProfile(null);
      loadThread(targetChannel, target.parentId);
      return;
    }
    setFocusMessageId(messageId);
  };

  /** Open a notification: mark it read, then jump to its source message. */
  const openNotification = (targetChannel: string, messageId: string, id: string) => {
    setNotifRead(id, true);
    // A calendar reminder has no conversation: it opens the calendar.
    if (!targetChannel) {
      if (compact) {
        setMobileContent(false);
        setMobileTab("calendar");
      } else {
        setView("calendar");
      }
      return;
    }
    openMessage(targetChannel, messageId);
  };

  /**
   * Announce a notification outside the app: a sound, and a system notification when the app is not
   * the window being looked at.
   *
   * The same preferences that already decide whether a notification is counted decide this, through
   * `passesPref`, so a muted channel is silent here too and there is one rule rather than two that
   * have to be kept in step. Quiet hours suppress both halves, which is the whole of what quiet
   * hours mean.
   *
   * Something always happens, and which something depends on where the reader is. Away, it is a
   * system notification. On screen, it is a toast, because an operating-system panel laid over the
   * window someone is already working in says nothing that window cannot say itself, and because
   * many browsers refuse to draw one for a focused page at all.
   *
   * The first version only had the away half, with the sound off by default, so a reader watching
   * the app while a mention arrived saw the feature do nothing and had every reason to call it
   * broken.
   */
  useEffect(() => {
    alertRef.current = (n) => {
      const spaceLevel = liveRef.current.spaces.find((w) => w.id === n.spaceId)?.notifyLevel;
      if (!passesPref(n, channelPrefs[n.channelId], settings.notif, spaceLevel)) return;
      if (inQuietHours(settings.notif)) return;
      // With Web Push on in this browser, the service worker draws the system notification (and it
      // does so whether or not this tab is open). Drawing it here too would show it twice.
      if (appIsAway() && pushActive()) return;
      if (settings.notif.sound) playNotificationSound();
      if (n.reminder) {
        const title = notifSummary(n, t);
        const body = `${n.reminder.allDay ? formatDate(`${n.reminder.start}T12:00:00Z`) : formatTime(n.reminder.start)}${n.reminder.location ? ` · ${n.reminder.location}` : ""}`;
        if (appIsAway()) {
          showDesktopNotification({ title, body, tag: n.reminder.eventId, onClick: () => openNotification("", "", n.id) });
          return;
        }
        notifyRef.current?.({ tone: "info", title, description: body });
        return;
      }
      const where = n.spaceId === liveRef.current.ws ? n.label : `${n.label} · ${n.spaceName}`;
      const who = n.isDm && !n.label ? n.actor : `${n.actor} dans ${where}`;
      if (appIsAway()) {
        showDesktopNotification({
          title: who,
          body: n.preview || notifSummary(n, t),
          // One notification per conversation: ten messages from the same channel while you were
          // away should be one line to come back to, not ten to dismiss.
          tag: n.channelId,
          onClick: () => openNotification(n.channelId, n.messageId, n.id),
        });
        return;
      }
      notifyRef.current?.({ tone: "info", title: who, description: n.preview || notifSummary(n, t) });
    };
  });

  const messageActions = {
    react: (messageId: string, emoji: string) => {
      const conv = channelId;
      const target = (messages[conv] ?? []).find((x) => x.id === messageId);
      if (!target || isPendingId(messageId)) return;
      const wasMine = !!target.reactions?.find((r) => r.emoji === emoji)?.mine;
      updateMessage(conv, messageId, (m) => {
        const reactions = m.reactions ? m.reactions.map((r) => ({ ...r })) : [];
        const idx = reactions.findIndex((r) => r.emoji === emoji);
        if (idx === -1) {
          reactions.push({ emoji, count: 1, mine: true });
        } else if (reactions[idx].mine) {
          const count = reactions[idx].count - 1;
          if (count <= 0) reactions.splice(idx, 1);
          else reactions[idx] = { ...reactions[idx], count, mine: false };
        } else {
          reactions[idx] = { ...reactions[idx], count: reactions[idx].count + 1, mine: true };
        }
        return { ...m, reactions };
      });
      const request = wasMine ? removeReaction(messageId, emoji) : addReaction(messageId, emoji);
      // Reacting puts one in the channel too, exactly like writing does.
      request.then(() => !wasMine && notInChannel(conv) && void markJoined(conv));
      request.catch(() => {
        rollbackMessage(conv, target);
        showToast({ tone: "info", title: t("toast.reactionFailed") });
      });
    },
    openThread: (messageId: string) => {
      setThread(messageId);
      setProfile(null);
      loadThread(channelId, messageId);
    },
    openProfile: (name: string) => {
      setProfile(name);
      setProfileEdit(false);
      setThread(null);
    },
    editProfile: (name: string) => {
      setProfile(name);
      setProfileEdit(true);
      setThread(null);
    },
    message: (name: string) => openDmByName(name),
    // A `#room` written in a message opens that room. Only the channels of this space can be
    // named, which is also all the composer offers, so an unknown name simply is not a link.
    openRoom: (name: string) => {
      const room = channels.find((c) => c.name === name);
      if (room) openChannel(room.id);
    },
    toggleSave: (messageId: string) => {
      const conv = channelId;
      const target = (messages[conv] ?? []).find((x) => x.id === messageId);
      if (!target || isPendingId(messageId)) return;
      const nowSaved = !(target.saved ?? false);
      updateMessage(conv, messageId, (m) => ({ ...m, saved: nowSaved }));
      showToast({
        tone: nowSaved ? "success" : "info",
        title: nowSaved ? t("toast.messageSaved") : t("toast.messageUnsaved"),
      });
      setMessageSaved(messageId, nowSaved).catch(() => {
        rollbackMessage(conv, target);
        showToast({ tone: "info", title: t("toast.saveNotSynced") });
      });
    },
    edit: (messageId: string) => {
      const target = conversationMessages.find((x) => x.id === messageId);
      if (target) setEditing({ id: messageId, body: target.body });
    },
    /**
     * Tick or untick one checklist line, in place.
     *
     * A checklist is text, so this is an edit of the body: the same call the composer makes, under
     * the same author-only rule. It does not go through the composer, because opening a message for
     * editing to change one character is exactly what a box you can click is there to avoid, and it
     * says nothing on success: the box itself is the answer.
     */
    toggleTask: (messageId: string, line: number, done: boolean) => {
      const conv = channelId;
      const target = (messages[conv] ?? []).find((x) => x.id === messageId);
      if (!target) return;
      const lines = target.body.split("\n");
      const before = lines[line];
      if (before === undefined) return;
      const after = before.replace(/^([-*] )\[[ xX]\]/, `$1[${done ? "x" : " "}]`);
      // The line is not the item it was when the row was drawn (an edit landed in between): leave
      // the body exactly as it is rather than ticking whatever moved into its place.
      if (after === before) return;
      lines[line] = after;
      const body = lines.join("\n");
      updateMessage(conv, messageId, (m) => ({ ...m, body, edited: true, editedAt: new Date().toISOString() }));
      if (isPendingId(messageId)) return;
      editMessage(messageId, body)
        .then((m) => updateMessage(conv, messageId, () => m))
        .catch(() => {
          rollbackMessage(conv, target);
          showToast({ tone: "info", title: t("toast.editNotSaved") });
        });
    },
    togglePin: (messageId: string) => {
      const conv = channelId;
      const target = (messages[conv] ?? []).find((x) => x.id === messageId);
      if (!target || isPendingId(messageId)) return;
      const nowPinned = !(target.pinned ?? false);
      updateMessage(conv, messageId, (m) => ({ ...m, pinned: nowPinned }));
      showToast({ tone: "info", title: nowPinned ? t("toast.messagePinned") : t("toast.messageUnpinned") });
      // Pins are a channel concept (the endpoint is channel-scoped); DMs keep the toggle client-side.
      if (channels.some((c) => c.id === conv)) {
        setMessagePinned(conv, messageId, nowPinned).catch(() => {
          rollbackMessage(conv, target);
          showToast({ tone: "info", title: t("toast.pinNotSynced") });
        });
      }
    },
    copyLink: () => showToast({ tone: "success", title: t("admin.copiedToast") }),
    copyMessage: (messageId: string) => {
      const target = conversationMessages.find((x) => x.id === messageId);
      navigator.clipboard?.writeText(target?.body ?? "");
      showToast({ tone: "success", title: t("toast.messageCopied") });
    },
    markUnread: (messageId: string) => {
      setUnreadMarker(messageId);
      showToast({ tone: "info", title: t("toast.markedUnread") });
    },
    remove: (messageId: string) => {
      const conv = channelId;
      const target = (messages[conv] ?? []).find((x) => x.id === messageId);
      if (!target) return;
      if (isPendingId(messageId)) {
        // An optimistic message the API never saw: just drop it locally.
        setMessages((prev) => ({ ...prev, [conv]: (prev[conv] ?? []).filter((x) => x.id !== messageId) }));
        return;
      }
      updateMessage(conv, messageId, (m) => ({ ...m, deleted: true, body: "" }));
      showToast({ tone: "info", title: t("message.deleted") });
      deleteMessage(messageId)
        .then((m) => updateMessage(conv, messageId, () => m))
        .catch(() => {
          rollbackMessage(conv, target);
          showToast({ tone: "info", title: t("toast.deleteFailed") });
        });
    },
  };

  /**
   * Store a picked file for the open conversation.
   *
   * Uploading through the conversation is what gives the file its audience: one sent in a private
   * channel or a direct message stays readable only by its participants, one sent in a public
   * channel joins the space's files.
   */
  const uploadAttachment = (file: File): Promise<MessageAttachment> => apiUploadAttachment(channelId, file);

  /**
   * Reflect an image the user just replaced into the lists the rest of the app reads.
   *
   * The screen that uploaded it holds its own copy, but the rail reads the space list and message
   * rows read the member roster: without patching those, a new icon or avatar only appeared after a
   * reload. Patched in place rather than refetched, since the URL is already in hand.
   */
  const applyOwnAvatar = (url?: string) => {
    const me = session?.id;
    if (!me) return;
    setMembers((prev) => prev.map((m) => (m.userId === me ? { ...m, avatarUrl: url } : m)));
  };

  const applySpaceIcon = (url?: string) => {
    setWorkspaces((prev) => prev.map((w) => (w.id === ws ? { ...w, iconUrl: url } : w)));
  };

  const applySpaceName = (name: string) => {
    setWorkspaces((prev) => prev.map((w) => (w.id === ws ? { ...w, name } : w)));
  };

  /** Whether a conversation is a channel this client is only reading. */
  const notInChannel = (id: string) => channels.find((c) => c.id === id)?.member === false;

  /**
   * Record that we are now in a channel, and re-read it.
   *
   * The arrival notice is published to the channel's audience at the moment we join, when this
   * client is not yet subscribed to it, so that one frame can never reach us: the notice and the
   * member count only appeared after a reload. Re-reading the conversation is what closes that gap,
   * and it is needed wherever joining happens, including the writing that joins by itself.
   */
  const markJoined = async (id: string) => {
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, member: true } : c)));
    const page = await getChannelMessages(id).catch(() => null);
    if (!page) return;
    // Merged on ids rather than replaced: a message sent in the same breath may not be in this page
    // yet, and dropping it would make our own line disappear under us.
    setMessages((prev) => {
      const known = new Set(page.messages.map((m) => m.id));
      return { ...prev, [id]: [...page.messages, ...(prev[id] ?? []).filter((m) => !known.has(m.id))] };
    });
  };

  const send = (text: string, attachments?: Message["attachments"]) => {
    if (!text.trim() && !attachments?.length) return;
    const conv = channelId;
    const tempId = `tmp-${Date.now()}`;
    const optimistic: Message = {
      id: tempId,
      fresh: true,
      author: currentUser,
      createdAt: new Date().toISOString(),
      body: text,
      attachments,
      attachment: attachments?.[0],
    };
    setMessages((prev) => ({ ...prev, [conv]: [...(prev[conv] ?? []), optimistic] }));
    // The optimistic row is replaced by the server row (real id, timestamp, hydrated attachment) on
    // success, or removed on failure. An attachment is already stored by this point: the composer
    // uploads on pick, so all that travels here is its id.
    sendMessage(conv, text, { attachments: attachments?.flatMap((attachment) => attachment.fileId ? [attachment.fileId] : []) })
      .then((m) => {
        setDms((prev) =>
          prev.map((d) => (d.id === conv ? { ...d, lastMessage: { excerpt: m.body, mine: true, at: m.createdAt ?? new Date().toISOString() } } : d)),
        );
        // Drop the optimistic row and de-dupe the real id, so a realtime echo of our own message that
        // may have already arrived does not leave a duplicate.
        setMessages((prev) => {
          const list = (prev[conv] ?? []).filter((x) => x.id !== tempId && x.id !== m.id);
          return { ...prev, [conv]: [...list, m] };
        });
        // Writing in a public channel one is only reading puts the writer in it, server-side. The
        // client has to learn that from this call, because nothing else will tell it.
        if (notInChannel(conv)) void markJoined(conv);
      })
      .catch(() => {
        setMessages((prev) => ({ ...prev, [conv]: (prev[conv] ?? []).filter((x) => x.id !== tempId) }));
        showToast({ tone: "info", title: t("toast.messageNotSent") });
      });
  };

  /**
   * Answer in a thread. The same optimistic dance as {@link send}, plus the root's counter: our own
   * reply is never echoed back to us, so nothing else would move it.
   */
  const sendReply = (parentId: string, text: string) => {
    if (!text.trim()) return;
    const conv = channelId;
    const tempId = `tmp-${Date.now()}`;
    const optimistic: Message = {
      id: tempId,
      fresh: true,
      author: currentUser,
      authorId: session?.id,
      createdAt: new Date().toISOString(),
      body: text,
      parentId,
    };
    setMessages((prev) => ({ ...prev, [conv]: [...(prev[conv] ?? []), optimistic] }));
    sendMessage(conv, text, { parentMessageId: parentId })
      .then((m) => {
        setMessages((prev) => {
          const list = (prev[conv] ?? []).filter((x) => x.id !== tempId && x.id !== m.id);
          return adjustReplyCount({ ...prev, [conv]: [...list, m] }, conv, parentId, 1, m.author, m.createdAt);
        });
        if (notInChannel(conv)) void markJoined(conv);
      })
      .catch(() => {
        setMessages((prev) => ({ ...prev, [conv]: (prev[conv] ?? []).filter((x) => x.id !== tempId) }));
        showToast({ tone: "info", title: t("toast.messageNotSent") });
      });
  };

  const saveEdit = (text: string, attachments?: MessageAttachment[]) => {
    if (!editing) return;
    const conv = channelId;
    const { id } = editing;
    const body = text.trim();
    const target = (messages[conv] ?? []).find((x) => x.id === id);
    // An edit with neither text nor a file is a deletion asked for by another route: refuse it
    // rather than silently blanking the message, since the menu already says what deletion does.
    if (!body && !target?.attachments?.length && !target?.attachment && !target?.image && !attachments?.length) {
      showToast({ tone: "info", title: t("toast.cannotEmpty"), description: t("toast.deleteInstead") });
      return;
    }
    updateMessage(conv, id, (m) => ({
      ...m,
      body,
      edited: true,
      editedAt: new Date().toISOString(),
      attachments: [...(m.attachments ?? (m.attachment ? [m.attachment] : [])), ...(attachments ?? [])],
    }));
    setEditing(null);
    showToast({ tone: "success", title: t("toast.messageEdited") });
    if (isPendingId(id)) return;
    editMessage(id, body, attachments?.flatMap((attachment) => attachment.fileId ? [attachment.fileId] : []) ?? [])
      .then((m) => updateMessage(conv, id, () => m))
      .catch(() => {
        if (target) rollbackMessage(conv, target);
        showToast({ tone: "info", title: t("toast.editNotSaved") });
      });
  };

  // Domain mutations wired to the creation dialogs.
  /**
   * Create a channel in the current space. The server normalises the name into a handle, so the row
   * added to the sidebar is the one it will keep, which may differ from what was typed.
   */
  const createChannel = async ({
    name,
    type,
    topic,
    allowedRoles,
  }: {
    name: string;
    type: Channel["type"];
    topic: string;
    allowedRoles?: string[];
  }) => {
    try {
      const channel = await apiCreateChannel(ws, { name, type, topic, allowedRoles });
      // Merged by id, never appended. The server publishes the creation to the space before it
      // answers this call, so our own frame usually arrives first and has already put a row in
      // the sidebar; appending a second one showed the channel twice until the next full load.
      // The response wins where they overlap: it is the complete row, the frame is not.
      setChannels((prev) =>
        prev.some((c) => c.id === channel.id)
          ? prev.map((c) => (c.id === channel.id ? { ...c, ...channel } : c))
          : [...prev, channel],
      );
      // Seed the feed only if the real-time frames have not already put something in it: the server
      // writes the "channel created" notice and pushes it before this call returns, so an
      // unconditional [] threw it away and the notice only appeared after a reload.
      setMessages((prev) => (prev[channel.id]?.length ? prev : { ...prev, [channel.id]: [] }));
      setModal(null);
      openChannel(channel.id);
      showToast({ tone: "success", title: t("toast.channelCreated"), description: `#${channel.name}` });
    } catch (err) {
      showToast({
        tone: "danger",
        title: t("toast.channelFailed"),
        description: isApiError(err, 400)
          ? t("error.nameTaken")
          : t("common.tryAgain"),
      });
    }
  };

  /** Pin or unpin a channel in the caller's own sidebar. */
  const toggleFavorite = (id: string) => {
    const before = channels.find((c) => c.id === id);
    if (!before) return;
    const next = !before.fav;
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, fav: next } : c)));
    setChannelFavorite(id, next).catch(() => {
      setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, fav: before.fav } : c)));
      showToast({ tone: "info", title: t("toast.favouriteNotSaved") });
    });
  };

  /**
   * Put the space's channels in a new order, for everybody in it (administrators only).
   *
   * Optimistic, since a row that springs back while the server answers reads as a drag that failed.
   * A refusal puts the list back as the server holds it: most often it is a 409, a list that changed
   * under the caller, and the server's list is the one worth showing then.
   */
  const reorderChannels = async (orderedIds: string[]) => {
    if (!ws) return;
    const spaceId = ws;
    const rank = new Map(orderedIds.map((id, index) => [id, index]));
    setChannels((prev) => [...prev].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)));
    try {
      await apiSetChannelOrder(spaceId, orderedIds);
    } catch {
      showToast({ tone: "danger", title: t("sidebar.reorderFailed"), description: t("common.tryAgain") });
      const fresh = await getChannels(spaceId).catch(() => null);
      if (fresh && liveRef.current.ws === spaceId) setChannels(fresh);
    }
  };

  /** Choose the public arrival channel from the channel menu. */
  const setDefaultChannel = async (id: string) => {
    if (!ws) return;
    try {
      const space = await apiSetDefaultChannel(ws, id);
      setWorkspaces((prev) =>
        prev.map((workspace) =>
          workspace.id === ws ? { ...workspace, defaultChannelId: space.defaultChannelId ?? id } : workspace,
        ),
      );
      showToast({ tone: "success", title: t("space.defaultChannelUpdated") });
    } catch {
      showToast({ tone: "danger", title: t("space.defaultChannelFailed"), description: t("common.tryAgain") });
    }
  };

  /** Save a channel's settings (name, topic, visibility, archived) against the API. */
  const updateChannel = async (id: string, patch: Partial<Channel>) => {
    const before = channels.find((c) => c.id === id);
    // Optimistic: the settings dialog closes on save, so the sidebar must not lag behind it.
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    try {
      const saved = await apiUpdateChannel(id, {
        name: patch.name,
        type: patch.type,
        topic: patch.topic,
        allowedRoles: patch.allowedRoles,
      });
      setChannels((prev) => prev.map((c) => (c.id === id ? saved : c)));
    } catch (err) {
      if (before) setChannels((prev) => prev.map((c) => (c.id === id ? before : c)));
      showToast({
        tone: "danger",
        title: t("toast.editNotSaved"),
        description: isApiError(err, 403)
          ? t("error.noChannelRights")
          : // A 400 on a name is a name already taken; a 400 without one came from the role
            // reservation, whose only reachable case the dialog already prevents. Saying "that name
            // is taken" about a name nobody submitted would be worse than saying nothing precise.
            isApiError(err, 400) && patch.name
            ? t("error.nameTaken")
            : t("common.tryAgain"),
      });
    }
  };

  /**
   * Leave a channel. Only the caller's membership goes: a public channel stays readable and stays in
   * the sidebar (with a "join" entry to come back), while a private one disappears with its access.
   */
  const leaveChannel = async (id: string) => {
    const channel = channels.find((c) => c.id === id);
    const isPrivate = channel?.type === "private";
    try {
      await apiLeaveChannel(id);
    } catch {
      showToast({ tone: "danger", title: t("toast.leaveFailed"), description: t("common.tryAgain") });
      return;
    }
    if (isPrivate) {
      setChannels((prev) => prev.filter((c) => c.id !== id));
      const fallback = channels.find((c) => c.id !== id);
      if (fallback) openChannel(fallback.id);
    } else {
      setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, member: false, unread: 0 } : c)));
    }
    showToast({
      tone: "info",
      title: t("toast.channelLeft"),
      description: isPrivate ? undefined : t("toast.stillReadable"),
    });
  };

  /** Rejoin a public channel left earlier, so its messages notify again. */
  const joinChannel = async (id: string) => {
    try {
      await apiJoinChannel(id);
      await markJoined(id);
      showToast({ tone: "success", title: t("toast.channelJoined") });
    } catch {
      showToast({ tone: "danger", title: t("toast.joinFailed"), description: t("common.tryAgain") });
    }
  };

  /** Create a space and switch to it. It is born with a starting channel, so it opens on one. */
  const createWorkspace = async (name: string) => {
    try {
      const space = await createSpace(name);
      setWorkspaces((prev) => [...prev, space]);
      setModal(null);
      setSwitchingSpace(true);
      await loadSpace(space.id);
      setSwitchingSpace(false);
      showToast({ tone: "success", title: t("toast.spaceCreated"), description: space.name });
    } catch (err) {
      setSwitchingSpace(false);
      showToast({
        tone: "danger",
        title: t("toast.spaceFailed"),
        description: isApiError(err, 400) ? t("error.nameUnusable") : t("common.tryAgain"),
      });
    }
  };

  /** The space on screen, when there is one: the name and role the two exit dialogs are about. */
  const currentWorkspace = workspaces.find((w) => w.id === ws);

  /**
   * What the caller counts as inside a channel. A space owner or administrator counts as its owner,
   * the way the API reads them: someone who may archive a channel and delete anyone's message in it
   * is already at the top of it. Anyone else is an ordinary member here; the channel settings ask
   * the server for the real roster and its roles.
   */
  const myChannelRole = (_channelId: string): string =>
    ["owner", "admin"].includes(currentWorkspace?.role ?? "") ? "owner" : "member";

  /**
   * Whether the caller may moderate channels here at all.
   *
   * False for a guest, whatever role they hold *inside* a channel: someone who opened a channel and
   * was later made a guest kept an owner row in it, and the menu went on offering them the controls
   * the API had just stopped accepting. The space role is the outer boundary.
   */
  const canModerateChannels = currentWorkspace?.role !== "guest";
  /**
   * Whether the caller runs the space: the settings screen, its people, its identity. The screen
   * itself already refuses every control below this rung, and the API refuses the calls behind them,
   * so what this gates is the entry to it: a door that opens onto nothing actionable reads as a
   * permission somebody has, which is exactly what it is not.
   */
  const canAdministerSpace = ["owner", "admin"].includes(currentWorkspace?.role ?? "");

  /**
   * Take a space off the rail, whether the caller walked out of it or it was deleted under them.
   *
   * Shared by the two handlers below and by the real-time event, which is what makes a second tab
   * (or another member's deletion) land the same way: without it, a space that no longer exists
   * stays on the rail answering 403 to everything until the page is reloaded.
   */
  const dropWorkspace = async (spaceId: string) => {
    // Called twice for the same space, always: the API pushes the frame before it answers the call
    // that caused it, so the real-time handler and the button's own handler both arrive. The second
    // one has to be a no-op rather than a second space switch, and the guard is a ref because both
    // can run before React has re-rendered with the first one's state.
    if (droppedSpacesRef.current.has(spaceId)) return;
    droppedSpacesRef.current.add(spaceId);
    // Read through the live ref for the same reason: whichever of the two callers arrives second
    // closed over the space list as it stood before any of this.
    const { spaces, ws: open } = liveRef.current;
    const remaining = spaces.filter((w) => w.id !== spaceId);
    setWorkspaces(remaining);
    if (spaceId !== open) return;
    // The space being watched is the one that went: land on another, or on the empty shell when
    // there is none left. `loadSpace("")` clears every screen rather than leaving the last space's
    // channels under a rail that no longer offers it.
    setSwitchingSpace(true);
    await loadSpace(remaining[0]?.id ?? "", undefined, remaining[0]?.defaultChannelId);
    setSwitchingSpace(false);
    // Never land on the settings of the next space. They look exactly like the ones just used to
    // delete a space, on a screen whose danger zone is one press away, and the name at the top is
    // the only thing that changed.
    openView("channel");
  };

  // Same reason as `notifyRef`: filled here, after the declaration it points at, so the real-time
  // handler drops the space from the list as it stands now and not as it stood at connection time.
  useEffect(() => {
    dropSpaceRef.current = (spaceId: string) => void dropWorkspace(spaceId);
    reloadSpaceRef.current = async (spaceId: string) => {
      setSwitchingSpace(true);
      await loadSpace(
        spaceId,
        undefined,
        liveRef.current.spaces.find((w) => w.id === spaceId)?.defaultChannelId,
      );
      setSwitchingSpace(false);
    };
  });

  /**
   * Apply the role changes a call came back with: one for an ordinary change, two for a transfer of
   * ownership. Shared with the real-time handler, so a change made in another tab (or by someone
   * else) lands identically.
   */
  const applyRoleChange = (spaceId: string, userId: string, role: string) => {
    setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, role } : m)));
    // The caller's own role is not a detail of the member list: it is what decides whether the space
    // offers its administration at all, and it lives on the space rather than on the roster.
    if (userId === session?.id) {
      setWorkspaces((prev) => prev.map((w) => (w.id === spaceId ? { ...w, role } : w)));
    }
  };

  /**
   * Change what a member may do in the space on screen.
   *
   * Handing the space over is routed through a confirmation instead of being applied: it is the one
   * role change that acts on two people, since the giver steps down to admin in the same write and
   * only the new owner can give it back.
   */
  const changeMemberRole = async (member: { userId: string; name: string }, role: string) => {
    if (role === "owner") {
      setTransferTo(member);
      return;
    }
    const previous = members.find((m) => m.userId === member.userId)?.role;
    try {
      const changes = await apiSetMemberRole(ws, member.userId, role);
      for (const change of changes) applyRoleChange(ws, change.userId, change.role);
      showToast({ tone: "success", title: t("toast.roleChanged"), description: member.name });
    } catch (err) {
      // Nothing was written, so nothing on screen may pretend otherwise.
      if (previous) applyRoleChange(ws, member.userId, previous);
      showToast({
        tone: "danger",
        title: t("toast.roleFailed"),
        description: isApiError(err, 403) ? t("error.noSpaceRights") : t("common.tryAgain"),
      });
    }
  };

  /** Hand the space over, from the confirmation dialog. */
  const transferOwnership = async (member: { userId: string; name: string }) => {
    setSpaceBusy(true);
    try {
      const changes = await apiSetMemberRole(ws, member.userId, "owner");
      for (const change of changes) applyRoleChange(ws, change.userId, change.role);
    } catch (err) {
      setSpaceBusy(false);
      showToast({
        tone: "danger",
        title: t("toast.roleFailed"),
        description: isApiError(err, 403) ? t("error.noSpaceRights") : t("common.tryAgain"),
      });
      return;
    }
    setSpaceBusy(false);
    setTransferTo(null);
    showToast({
      tone: "success",
      title: t("toast.spaceHandedOver"),
      description: t("toast.nowOwner", { name: member.name }),
    });
  };

  /** Take someone out of the space on screen, from the confirmation dialog. */
  const removeMember = async (member: { userId: string; name: string }) => {
    setSpaceBusy(true);
    try {
      await apiRemoveMember(ws, member.userId);
    } catch (err) {
      setSpaceBusy(false);
      showToast({
        tone: "danger",
        title: t("toast.removeFailed"),
        description: isApiError(err, 403) ? t("error.noSpaceRights") : t("common.tryAgain"),
      });
      return;
    }
    setSpaceBusy(false);
    setRemoving(null);
    // The roster is patched here as well as by the frame, for the same reason every other mutation
    // is: whichever arrives first, the screen has to agree with what was just done.
    setMembers((prev) => prev.filter((m) => m.userId !== member.userId));
    showToast({ tone: "info", title: t("toast.memberRemoved"), description: member.name });
  };

  /** Leave the space on screen, from the confirmation dialog. */
  const leaveWorkspace = async (spaceId: string) => {
    const name = workspaces.find((w) => w.id === spaceId)?.name;
    setSpaceBusy(true);
    setExitError(null);
    try {
      await apiLeaveSpace(spaceId);
    } catch (err) {
      setSpaceBusy(false);
      // Said inside the dialog, not behind it: a last owner is not being denied, they are being
      // asked to decide what happens to everyone else's work first, and that sentence is the whole
      // point of the refusal.
      setExitError(isApiError(err, 409) ? key("space.leaveLastOwner") : key("common.tryAgain"));
      return;
    }
    setSpaceBusy(false);
    setModal(null);
    await dropWorkspace(spaceId);
    showToast({ tone: "info", title: t("toast.spaceLeft"), description: name });
  };

  /** Delete the space on screen, from the confirmation dialog. Owner only, and final. */
  const deleteWorkspace = async (spaceId: string) => {
    const name = workspaces.find((w) => w.id === spaceId)?.name;
    setSpaceBusy(true);
    try {
      await apiDeleteSpace(spaceId);
    } catch {
      setSpaceBusy(false);
      setExitError(key("common.tryAgain"));
      return;
    }
    setSpaceBusy(false);
    setModal(null);
    await dropWorkspace(spaceId);
    showToast({ tone: "info", title: t("toast.spaceDeleted"), description: name });
  };

  /** Switch to another space and load it. */
  const switchWorkspace = async (id: string) => {
    if (id === ws) return;
    setSwitchingSpace(true);
    // The space being left shows no indicator while it is open, so whatever was read in it never
    // reached the rail. Re-read the counters on the way out, or its tile would keep the figure it
    // had when the app booted.
    void reloadSpaceCounters();
    // A space-level screen (its settings, its files, the threads or mentions views) belongs to the
    // space being left: arriving in another one lands in a conversation, never on the previous
    // space's screen redrawn with someone else's name at the top.
    setView("channel");
    setThread(null);
    setProfile(null);
    setProfileEdit(false);
    setUnreadMarker(null);
    setFocusMessageId(null);
    try {
      await loadSpace(id, undefined, workspaces.find((w) => w.id === id)?.defaultChannelId);
    } catch {
      showToast({ tone: "danger", title: t("toast.spaceUnreachable"), description: t("common.tryAgain") });
    } finally {
      setSwitchingSpace(false);
    }
  };

  /**
   * Open a notification clicked in the system tray, once the app holds what it points at.
   *
   * The click can come from any space, and even before the app has loaded (a window opened by the
   * service worker), so it waits in `pendingOpen`: first the space is switched to, then, once its
   * conversations are in, the notification is opened like one clicked in the inbox.
   */
  const pushOpenRef = useRef<() => void>(() => {});
  const lastSentNotifRef = useRef("");
  useEffect(() => {
    pushOpenRef.current = () => {
      const target = pendingOpen;
      if (!target || authStage !== "app" || switchingSpace) return;
      if (target.spaceId && target.spaceId !== ws && workspaces.some((w) => w.id === target.spaceId)) {
        void switchWorkspace(target.spaceId);
        return;
      }
      const here = channels.some((c) => c.id === target.conversationId) || dms.some((d) => d.id === target.conversationId);
      if (!here) return;
      setPendingOpen(null);
      if (target.id) openNotification(target.conversationId, target.messageId, target.id);
      else openChannel(target.conversationId);
    };
  });
  useEffect(() => {
    pushOpenRef.current();
  }, [pendingOpen, authStage, switchingSpace, ws, channels, dms]);

  useEffect(() => {
    dropChannelRef.current = (channelId: string) => {
      const { channels: current, channelId: openId, ws: activeWs, spaces } = liveRef.current;
      setChannels((prev) => prev.filter((c) => c.id !== channelId));
      setMessages((prev) => {
        if (!(channelId in prev)) return prev;
        const next = { ...prev };
        delete next[channelId];
        return next;
      });
      setNotifs((prev) => prev.filter((n) => n.channelId !== channelId));
      setChannelPrefs((prev) => {
        if (!(channelId in prev)) return prev;
        const next = { ...prev };
        delete next[channelId];
        return next;
      });
      if (openId === channelId) {
        const defaultId = spaces.find((w) => w.id === activeWs)?.defaultChannelId;
        const fallback =
          current.find((c) => c.id === defaultId && c.id !== channelId) ?? current.find((c) => c.id !== channelId);
        setView("channel");
        setThread(null);
        setChannelId(fallback?.id ?? "");
      }
    };
  });

  const confirmDeleteChannel = async () => {
    if (!deletingChannel) return;
    setDeleteChannelBusy(true);
    setDeleteChannelError(null);
    try {
      await apiDeleteChannel(deletingChannel.id);
      dropChannelRef.current(deletingChannel.id);
      showToast({ tone: "success", title: t("channel.deleted"), description: `#${deletingChannel.name}` });
      setDeletingChannel(null);
      setChannelSettingsId(null);
    } catch (err) {
      setDeleteChannelError(
        isApiError(err, 409) ? t("channel.deleteDefault") : t("toast.channelDeleteFailed"),
      );
    } finally {
      setDeleteChannelBusy(false);
    }
  };

  /**
   * Warn before any link leaves Ruchoir, wherever it is drawn (message text, a preview card, a
   * panel, a profile). One listener on the document, in the capture phase so it runs before the
   * link's own handlers, rather than a wrapper every link component has to remember to use.
   * A link to this instance itself, or anything but http(s), goes through untouched.
   */
  const linkWarningRef = useRef(settings.externalLinkWarning);
  useEffect(() => {
    linkWarningRef.current = settings.externalLinkWarning;
  });
  useEffect(() => {
    const intercept = (e: MouseEvent) => {
      if (!linkWarningRef.current || e.defaultPrevented || e.button > 1) return;
      const anchor = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      let target: URL;
      try {
        target = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (!["http:", "https:"].includes(target.protocol) || target.origin === window.location.origin) return;
      e.preventDefault();
      e.stopPropagation();
      setExternalLink(target.href);
    };
    document.addEventListener("click", intercept, true);
    // The middle button opens a tab too, and says so with `auxclick` rather than `click`.
    document.addEventListener("auxclick", intercept, true);
    return () => {
      document.removeEventListener("click", intercept, true);
      document.removeEventListener("auxclick", intercept, true);
    };
  }, []);

  // The service worker, registered on every load: it is what draws a push, and part of what makes
  // the app installable. It intercepts no request.
  useEffect(() => {
    registerServiceWorker();
    return onPushOpen((target) => setPendingOpen(target));
  }, []);

  /**
   * Once per signed-in session: bring the notification settings and this browser's push
   * subscription in line with the server, and pick up a notification the window was opened for.
   *
   * The settings used to live only in this browser. The server now acts on them (a push, an email),
   * so it holds them; what this browser still has from before is sent up once, the first time the
   * server has nothing of its own, rather than being replaced by the defaults.
   */
  const notifSyncRef = useRef<{ session: string; synced: boolean }>({ session: "", synced: false });
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  });
  useEffect(() => {
    const sessionId = session?.id ?? "";
    if (authStage !== "app" || !sessionId || notifSyncRef.current.session === sessionId) return;
    notifSyncRef.current = { session: sessionId, synced: false };
    const link = takePushLink();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the address at sign-in
    if (link) setPendingOpen(link);
    void syncPush();
    const offset = -new Date().getTimezoneOffset();
    void getNotificationPreferences()
      .then((server) => {
        if (notifSyncRef.current.session !== sessionId) return;
        const local = settingsRef.current.notif;
        const serverIsBlank = sameNotifPrefs(server, DEFAULT_NOTIF_PREFS);
        // Every field the app keeps, taken from the server (which has the offset on top).
        const merged: NotifPrefs = serverIsBlank
          ? { ...DEFAULT_NOTIF_PREFS, ...local }
          : (Object.fromEntries(
              (Object.keys(DEFAULT_NOTIF_PREFS) as (keyof NotifPrefs)[]).map((field) => [field, server[field]]),
            ) as NotifPrefs);
        lastSentNotifRef.current = JSON.stringify(merged);
        settingsRef.current.set("notif", merged);
        notifSyncRef.current.synced = true;
        if (serverIsBlank || server.utcOffsetMinutes !== offset) {
          void saveNotificationPreferences({ ...merged, utcOffsetMinutes: offset }).catch(() => {});
        }
      })
      .catch(() => {
        // Unreachable for now: the local settings stand, and the next change is sent up anyway.
        notifSyncRef.current.synced = true;
      });
  }, [authStage, session]);

  // Every later change of the notification settings goes to the server, which acts on them. A
  // short pause first, so dragging through the quiet-hours fields sends the result, not each step.
  useEffect(() => {
    if (!notifSyncRef.current.synced) return;
    const prefs = settings.notif;
    const serialised = JSON.stringify(prefs);
    if (serialised === lastSentNotifRef.current) return;
    const timer = window.setTimeout(() => {
      lastSentNotifRef.current = serialised;
      void saveNotificationPreferences({ ...prefs, utcOffsetMinutes: -new Date().getTimezoneOffset() }).catch(() =>
        notifyRef.current?.({ tone: "danger", title: tRef.current("admin.settingsSaveFailed") }),
      );
    }, 400);
    return () => window.clearTimeout(timer);
  }, [settings.notif]);

  // Global keyboard shortcuts, using the user's (customizable) bindings. Suspended whenever a modal,
  // dialog, the preferences overlay or the login flow is up, so their own key handling wins.
  const shortcutsEnabled =
    authStage === "app" &&
    !standalone &&
    modal === null &&
    view !== "prefs" &&
    editing === null &&
    channelSettingsId === null &&
    channelNotifId === null;
  useGlobalShortcuts(
    settings.shortcuts,
    {
      search: () => setModal("search"),
      switcher: () => setModal("switcher"),
      newMessage: () => setModal("newMessage"),
      nextUnread: () => gotoUnread(1),
      prevUnread: () => gotoUnread(-1),
      markRead: () => {
        if (view === "channel" && !standalone) markConversationRead(channelId);
      },
      help: () => setModal("help"),
    },
    shortcutsEnabled,
  );

  // Keep the address naming the open space and channel, so a conversation can be bookmarked, shared
  // and reopened where it was left. `writeSpaceLocation` replaces rather than pushes: the app gains
  // an address without pretending to have a history it does not implement.
  useEffect(() => {
    if (authStage !== "app" || !ws || editorOpen || standalone) return;
    const space = workspaces.find((w) => w.id === ws);
    if (!space) return;
    const channel = channels.find((c) => c.id === channelId);
    writeSpaceLocation(
      space.slug,
      channel?.name,
      workspaces.map((w) => w.slug),
    );
  }, [authStage, ws, channelId, channels, workspaces, editorOpen, standalone]);

  if (booting) {
    return (
      <div
        style={{
          height: "var(--ui-vh)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--surface-canvas)",
        }}
        aria-busy
        aria-label={t("boot.loading")}
      >
        <div className="wc-boot">
          <div className="wc-boot__ring">
            <span className="wc-boot__mark">
              {/* eslint-disable-next-line @next/next/no-img-element -- small same-origin brand mark */}
              <img src="/brand/ruchoir-mark.png" alt="" width={30} height={30} />
            </span>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "var(--text-base)", fontWeight: 600, letterSpacing: "var(--tracking-tight)", color: "var(--text-strong)" }}>
              Ruchoir
            </div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", marginTop: 2 }}>{t("boot.preparing")}</div>
          </div>
        </div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div
        style={{
          height: "var(--ui-vh)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          alignItems: "center",
          justifyContent: "center",
          background: "var(--surface-canvas)",
          color: "var(--text-muted)",
          fontSize: "var(--text-sm)",
          padding: 24,
          textAlign: "center",
        }}
      >
        <span>{t(bootError)}</span>
        <Button
          onClick={() => {
            setBootError(null);
            setBooting(true);
            window.location.reload();
          }}
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (authStage !== "app") {
    return (
      <div style={{ height: "var(--ui-vh)", display: "flex", flexDirection: "column", overflow: "auto", background: "var(--surface-canvas)" }}>
        {authStage === "login" ? (
          <LoginScreen
            onSubmit={handleLogin}
            onCreateAccount={() => goToStage("signup")}
            onForgotPassword={() => goToStage("forgot")}
            onSso={() => showToast({ tone: "info", title: t("toast.ssoUnavailable") })}
            onResendVerification={
              // Offered only when the sign-in was refused for an unconfirmed address.
              pendingEmail
                ? (email) => {
                    void handleResendVerification(email || pendingEmail);
                    setVerifyStatus("sent");
                    goToStage("verify");
                  }
                : undefined
            }
            error={authError ? t(authError) : null}
            pending={authPending}
          />
        ) : null}
        {authStage === "signup" ? (
          <SignupScreen
            onSubmit={(values) => void handleSignup(values)}
            onBackToLogin={() => goToStage("login")}
            error={authError ? t(authError) : null}
            pending={authPending}
          />
        ) : null}
        {authStage === "mfa" ? (
          <MfaChallengeScreen
            // Reached with a challenge from a real sign-in; the dev deep-link lands here without one,
            // which renders the default (authenticator) card with its submit handlers inert.
            methods={mfaChallenge?.methods ?? []}
            onSubmitCode={(method, code) => void handleMfaCode(method, code)}
            onPasskey={() => void handleMfaPasskey()}
            onCancel={() => {
              setMfaChallenge(null);
              goToStage("login");
            }}
            error={authError ? t(authError) : null}
            pending={authPending}
          />
        ) : null}
        {authStage === "forgot" ? (
          <ForgotPasswordScreen
            onSubmit={(email) => void handlePasswordResetRequest(email)}
            onRecovery={(values) => void handleRecoveryReset(values)}
            onBackToLogin={() => {
              setRecoveryDone(false);
              goToStage("login");
            }}
            sent={authSent}
            recovered={recoveryDone}
            emailDelivery={emailDelivery}
            error={authError ? t(authError) : null}
            pending={authPending}
          />
        ) : null}
        {authStage === "reset" ? (
          <ResetPasswordScreen
            onSubmit={(password) => void handlePasswordReset(password)}
            onBackToLogin={() => {
              setResetDone(false);
              goToStage("login");
            }}
            done={resetDone}
            error={authError ? t(authError) : null}
            pending={authPending}
          />
        ) : null}
        {authStage === "verify" ? (
          <VerifyEmailScreen
            status={verifyStatus}
            email={pendingEmail || undefined}
            onResend={(email) => void handleResendVerification(email)}
            onBackToLogin={() => goToStage("login")}
            error={authError ? t(authError) : null}
            pending={authPending}
            resent={authSent}
          />
        ) : null}
        {/*
          The invitation landing screen. It shows what the visitor was invited to before asking them
          to sign in or register; the token is held in `inviteToken` across whichever they choose,
          and `enterApp` accepts it once a session exists.
        */}
        {authStage === "invite" ? (
          <InviteScreen
            status={inviteStatus}
            preview={invitePreview}
            error={authError ? t(authError) : null}
            onSignIn={() => goToStage("login")}
            onCreateAccount={() => goToStage("signup")}
            onDismiss={() => {
              setInviteToken("");
              forgetInvite();
              setInvitePreview(null);
              goToStage("login");
            }}
          />
        ) : null}
        {/*
          Onboarding is where an account with no space gets its first one: a fresh sign-in lands here
          instead of on an empty shell. The dev deep-link also reaches this stage for the audits, where
          the creation call simply fails and reports itself.
        */}
        {authStage === "onboarding" ? (
          <OnboardingFlow
            firstName={signupFirst || undefined}
            pending={authPending}
            error={authError ? t(authError) : null}
            onFinish={({ workspaceName }) => void handleCreateFirstSpace(workspaceName)}
          />
        ) : null}
      </div>
    );
  }

  // A document's own tab: the editor alone. Closing it closes the tab when the files list opened it,
  // in a browser. Anywhere else (a reload, a link, the installed app, where closing the window closes
  // Ruchoir) it goes to the space's files, on the document's folder, with the space loaded first:
  // the tab never opened it, and showing the files of no space was an empty screen.
  if (standalone) {
    const slug = standalone.slug;
    const slugs = workspaces.map((w) => w.slug);
    const toFiles = (file?: SpaceFile) => {
      const space = workspaces.find((w) => w.slug === slug);
      setFilesFolder(file?.parentFolderId);
      setStandalone(null);
      void loadSpace(space?.id ?? workspaces[0]?.id ?? "", undefined, space?.defaultChannelId).then(() => {
        setView("files");
        setMobileContent(true);
      });
    };
    const installed = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
    return (
      <OfficeEditor
        // On a phone the band stays, with its close button: the engine's own lives three taps deep in
        // its "…" menu, and a phone lands here mostly after reloading a tab it had set aside.
        bare={!compact}
        fileId={standalone.fileId}
        convert={standalone.convert}
        addressOf={slug ? (id, convert) => fileUrl(slug, id, slugs, convert) : undefined}
        onClose={(file) => {
          if (!standalone.opened || installed) {
            toFiles(file);
            return;
          }
          window.close();
          // Still here: the browser kept the tab after all.
          window.setTimeout(() => toFiles(file), 300);
        }}
      />
    );
  }

  const wsName = workspaces.find((w) => w.id === ws)?.name ?? "espace";
  // The import is a modal now, not a full screen, so the app has to stay drawn behind it rather than
  // going blank. The content pane and its title fall back to whatever view the import was opened
  // over. Prefs and instance admin still replace the screen, so they are not folded in here.
  // The calendar draws times in the viewer's own zone: their profile's, else this browser's.
  const viewerTimeZone = session?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const contentView = view === "import" ? prevView : view;
  const contentTitle = contentView === "channel" ? (dm ? dm.name : `# ${chan.name}`) : (VIEW_TITLES[contentView] ? t(VIEW_TITLES[contentView]) : wsName);

  const setOwnPresence = (choice: PresenceChoice) => {
    setMyChoice(choice);
    // The resulting dot is the server's to decide, not ours to guess: "automatique" reads the
    // connection, and an override only colours a connection that exists. So the answer to this
    // call is what we display.
    void apiSetMyPresence(choice)
      .then((p) => {
        setUserPresence(currentUser, p);
        if (session?.id) setPresence((prev) => ({ ...prev, [session.id]: p }));
      })
      .catch(() => setMyChoice(myChoice));
  };
  /** One's own profile, in the side panel of the conversation (full screen on a phone). */
  const showOwnProfile = (edit: boolean) => {
    setView("channel");
    setThread(null);
    setProfileEdit(edit);
    setProfile(currentUser);
    if (compact) {
      // Opened from the tabs, not from a channel: going back returns there, rather than through the
      // channel's members panel and the channel the profile happens to be drawn over.
      profileFromTabs.current = !mobileContent;
      if (!mobileContent) setPanel(null);
      setMobileContent(true);
    }
  };
  const openOwnProfile = () => showOwnProfile(false);
  const editOwnProfile = () => showOwnProfile(true);

  const rail = (
    <WorkspaceRail
      workspaces={orderedWorkspaces}
      onReorder={reorderWorkspace}
      active={ws}
      currentUser={currentUser}
      onSelect={(id) => {
        closeSheets();
        void switchWorkspace(id);
      }}
      onNew={() => setModal("newWorkspace")}
      onHelp={() => setModal("help")}
      onLogout={handleLogout}
      presence={myPresence}
      presenceChoice={myChoice}
      onSetPresence={setOwnPresence}
      onOpenSettings={() => openPreferences()}
      onOpenInstanceAdmin={session?.isInstanceAdmin === true ? () => openInstanceAdmin() : undefined}
      onOpenOwnProfile={openOwnProfile}
      onEditOwnProfile={editOwnProfile}
    />
  );

  // The phone pushes whatever is opened from a tab over the tabs, full screen.
  const backToTabs = () => setMobileContent(false);
  const openViewPushed = (v: AppView) => {
    openView(v);
    setMobileContent(true);
  };
  const openChannelPushed = (id: string) => {
    openChannel(id);
    setMobileContent(true);
  };
  /** The top of the phone's home tab, above the channels: the search, and the shortcuts. */
  const phoneLead = (
    <>
      <MobileSearchField onOpen={() => setModal("search")} />
      <QuickLinks
        links={[
          { id: "threads", icon: "inbox", label: t("sidebar.threads"), onOpen: () => openViewPushed("threads") },
          { id: "mentions", icon: "at-sign", label: t("activity.mentions"), count: mentionUnread, mention: true, onOpen: () => openViewPushed("mentions") },
          { id: "saved", icon: "bookmark", label: t("activity.saved"), onOpen: () => openViewPushed("saved") },
          ...(currentWorkspace?.role !== "guest"
            ? [{ id: "files", icon: "hard-drive" as const, label: t("gsearch.files"), onOpen: () => openViewPushed("files") }]
            : []),
        ]}
      />
    </>
  );
  /** The tablet's list has no rail beside it: the space and the account are reached from its head. */
  const tabletRailless = {
    onSwitchSpace: () => setSpaceSheet(true),
    you: (
      <button
        type="button"
        className="wc-rail-space"
        aria-label={t("shell.myProfileAndStatus")}
        onClick={() => setYouSheet(true)}
        style={{ display: "flex", border: 0, padding: 0, marginLeft: 4, background: "none", cursor: "pointer" }}
      >
        <Avatar name={currentUser} src={getAvatar(currentUser)} size={30} presence={myPresence} />
      </button>
    ),
  };

  // One set of props for every shell; each shell adds what differs (the phone's single section, the
  // tablet's railless header).
  const renderSidebar = (shell: "desktop" | "tablet" | "phone") => (
    <Sidebar
        workspace={workspaces.find((w) => w.id === ws)}
        channels={channels}
        directMessages={visibleDms}
        onHideDm={hideDm}
        view={view}
        channel={channelId}
        mentionCount={mentionUnread}
        channelPrefs={channelPrefs}
        notifications={visibleNotifs}
        notifUnread={notifUnread}
        onView={shell === "phone" ? openViewPushed : openView}
        onChannel={shell === "phone" ? openChannelPushed : openChannel}
        onNotify={showToast}
        onInvite={() => setModal("invite")}
        onNewChannel={() => setModal("newChannel")}
        // A guest reaches the space only through what they were added to: no space files, no new
        // channel, no invitation. The API refuses all three; this keeps them off the column.
        canBrowseSpace={currentWorkspace?.role !== "guest"}
        canAdministerSpace={canAdministerSpace}
        canImport={session !== null}
        importRun={importRun}
        onImport={openImport}
        onNewMessage={() => setModal("newMessage")}
        onGlobalSearch={() => setModal("search")}
        onLeaveChannel={leaveChannel}
        onJoinChannel={joinChannel}
        onChannelSettings={setChannelSettingsId}
        onChannelNotifications={setChannelNotifId}
        onMarkRead={markConversationRead}
        onToggleFavorite={toggleFavorite}
        onSetDefaultChannel={(id) => void setDefaultChannel(id)}
        onReorderChannels={canAdministerSpace ? (ids) => void reorderChannels(ids) : undefined}
        onOpenNotification={openNotification}
        onToggleNotifRead={setNotifRead}
        onMarkAllNotifsRead={markAllNotifsRead}
        onOpenNotifPrefs={() => openPreferences("notifications")}
        onLeaveSpace={() => setModal("leaveSpace")}
        onSpaceNotifications={() => setSpaceNotifOpen(true)}
        loading={switchingSpace}
        openNotifications={deepLinkPop === "notifications"}
        compact={shell === "phone"}
        only={shell === "phone" ? "channels" : undefined}
        lead={shell === "phone" ? phoneLead : undefined}
        railless={shell === "tablet" ? tabletRailless : undefined}
      />
  );
  const desktopSidebar = renderSidebar("desktop");

  /**
   * What a space switch fades: everything but the rail, which stays live so another space is one
   * click away even mid-switch. A fade rather than a blank screen, and rather than a spinner that
   * would move the layout twice.
   */
  const switchingStyle: CSSProperties = {
    opacity: switchingSpace ? 0.5 : 1,
    transition: "opacity var(--duration-fast) var(--ease-out)",
  };

  const content = (
    // The main landmark: screen-reader users jump here to skip the rail and channel list. Exactly one
    // view renders at a time, so there is always exactly one main. Flex container so the view fills it
    // in both the desktop row shell and the compact column shell.
    <main
      aria-label={t("tabs.mainContent")}
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      {/* No conversation at all: a space just created, the last one left, or a guest nobody has added
          to anything yet. The screen used to draw a channel that did not exist, named from a
          fallback string, with a composer that would have failed on send. */}
      {contentView === "channel" && !channelId ? (
        <EmptyState
          icon="message-square"
          // A heading and not a line of text: this *is* the view's title while there is nothing to
          // show, and the channel's own <h1> is what it replaces. Without one the main landmark has
          // no heading to jump to, and the first heading on the page is no longer an h1.
          title={<h1 style={{ margin: 0, font: "inherit" }}>{t("channel.noConversation")}</h1>}
          description={
            currentWorkspace?.role === "guest"
              ? t("sidebar.noChannelYet")
              : t("channel.noConversationHint")
          }
        />
      ) : null}
      {contentView === "channel" && channelId ? (
        <ChannelScreen
          editing={editing}
          onSaveEdit={saveEdit}
          onCancelEdit={() => setEditing(null)}
          readBy={readBy}
          readAudience={readAudience}
          channel={chan}
          dm={dm}
          messages={feed}
          // Only inside a space: the offline dev deep link opens a channel with no space and no
          // history on purpose, and the audits photograph its empty state, not a placeholder.
          loading={!!ws && !!channelId && messages[channelId] === undefined}
          panel={panel}
          threadId={thread}
          threadReplies={threadReplies}
          threadLoading={thread !== null && threadLoading === thread}
          onSendReply={sendReply}
          profileName={profile}
          profileEditing={profileEdit}
          unreadMarker={unreadMarker}
          focusMessageId={focusMessageId}
          compact={compact}
          overlayPanels={tablet}
          onBack={compact ? backToTabs : undefined}
          onSend={send}
          onUploadAttachment={uploadAttachment}
          onAvatarChanged={applyOwnAvatar}
          onPanel={openPanel}
          onCloseThread={() => setThread(null)}
          onCloseProfile={() => {
            setProfile(null);
            if (compact && profileFromTabs.current) {
              profileFromTabs.current = false;
              setMobileContent(false);
            }
          }}
          onNotify={showToast}
          onUpdateChannel={(patch) => updateChannel(channelId, patch)}
          myRole={currentWorkspace?.role ?? "member"}
          myChannelRole={myChannelRole(channelId)}
          canModerateChannels={canModerateChannels}
          myUserId={session?.id ?? ""}
          onLeaveChannel={() => leaveChannel(channelId)}
          onJoinChannel={() => joinChannel(channelId)}
          notifPref={channelPrefs[channelId] ?? DEFAULT_CHANNEL_PREF}
          onSaveNotifPref={(pref) => saveChannelPref(channelId, pref)}
          notifInherited={inheritedLevel}
          isDefaultChannel={currentWorkspace?.defaultChannelId === channelId}
          onDeleteChannel={
            canAdministerSpace
              ? () => {
                  const target = channels.find((c) => c.id === channelId);
                  if (!target) return;
                  setDeleteChannelError(null);
                  setDeletingChannel({ id: target.id, name: target.name });
                }
              : undefined
          }
          members={memberRecords}
          files={spaceFiles}
          dmPresence={dm?.presence}
          typingNames={typingNames}
          profileUserId={profileUserId}
          profilePresence={profileUserId ? presence[profileUserId] : undefined}
          onTyping={() => rtRef.current?.sendTyping(channelId)}
          actions={messageActions}
        />
      ) : null}
      {contentView === "files" ? (
        <FilesScreen
          spaceId={ws}
          workspaceName={workspaces.find((w) => w.id === ws)?.name ?? "espace"}
          currentUserId={session?.id}
          spaceRole={currentWorkspace?.role}
          compact={compact}
          onBack={compact ? backToTabs : undefined}
          onNotify={showToast}
          spaceSlug={workspaces.find((w) => w.id === ws)?.slug}
          slugs={workspaces.map((w) => w.slug)}
          onEditorChange={setEditorOpen}
          initialFolderId={filesFolder}
          shareTargets={[
            ...channels.filter((c) => c.member !== false).map((c) => ({ id: c.id, name: c.name, kind: "channel" as const, fav: c.fav })),
            ...visibleDms.filter((d) => !d.bot).map((d) => ({ id: d.id, name: d.name, kind: "dm" as const, lastAt: d.lastMessage?.at })),
          ]}
        />
      ) : null}
      {contentView === "calendar" ? (
        <CalendarScreen
          key={ws}
          compact={compact}
          timeZone={viewerTimeZone}
          spaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
          spaceId={ws}
          onBack={compact ? backToTabs : undefined}
          onNotify={showToast}
        />
      ) : null}
      {contentView === "settings" ? (
        <WorkspaceSettings
          // Keyed by the space: the screen holds the name being edited in its own state, seeded once
          // from the space it was opened on. Without this, switching space left the previous name in
          // the field, and pressing save would have renamed the new space to the old one's name.
          key={ws}
          workspaceName={workspaces.find((w) => w.id === ws)?.name ?? "espace"}
          spaceId={ws}
          iconUrl={workspaces.find((w) => w.id === ws)?.iconUrl}
          // The space's name and icon are its identity, and that is the owner's alone. Everything
          // else on this screen (the people, their roles, who is shown the door) stays with the
          // administrators, which is the line the API draws too.
          canEditIdentity={currentWorkspace?.role === "owner"}
          canManageMembers={["owner", "admin"].includes(currentWorkspace?.role ?? "")}
          channels={channels}
          defaultChannelId={currentWorkspace?.defaultChannelId}
          onIconChanged={applySpaceIcon}
          onRenamed={applySpaceName}
          onDefaultChannelChanged={(defaultChannelId) =>
            setWorkspaces((prev) => prev.map((workspace) => (workspace.id === ws ? { ...workspace, defaultChannelId } : workspace)))
          }
          // The real records, so the screen shows the role the server holds rather than a mapping
          // by display name, and can say how many guests and bots there are instead of asserting it.
          members={members.map((m) => ({
            userId: m.userId,
            name: m.name,
            presence: presence[m.userId] ?? "offline",
            role: m.role,
            title: m.title,
            bot: m.bot,
          }))}
          myRole={currentWorkspace?.role ?? "member"}
          onChangeRole={(member, role) => void changeMemberRole(member, role)}
          onRemoveMember={setRemoving}
          compact={compact}
          onBack={compact ? backToTabs : undefined}
          onInvite={() => setModal("invite")}
          onNotify={showToast}
          // Deleting is the owner's alone, which is also what the API enforces: an admin runs the
          // space, they do not get to end it.
          canDelete={currentWorkspace?.role === "owner"}
          onDelete={() => setModal("deleteSpace")}
          onLeave={() => setModal("leaveSpace")}
        />
      ) : null}
      {contentView === "threads" ? <ActivityView kind="threads" items={threads} onOpen={openMessage} onBack={compact ? backToTabs : undefined} /> : null}
      {contentView === "mentions" ? <ActivityView kind="mentions" items={mentions} onOpen={openMessage} onBack={compact ? backToTabs : undefined} /> : null}
      {contentView === "saved" ? <ActivityView kind="saved" items={saved} onOpen={openMessage} onBack={compact ? backToTabs : undefined} /> : null}
    </main>
  );

  const overlays = (
    <>
      {/* What is being sent, wherever the person goes meanwhile. */}
      <UploadPanel compact={compact} />
      {/* Personal preferences take over the whole viewport (covering the rail and sidebar) so it is
          clear they are account-wide, not scoped to the current workspace. Sits below toasts (z 60)
          and dialogs (z 90) so the security sub-dialogs still layer on top. */}
      {view === "prefs" ? (
        <div style={{ position: "fixed", top: 0, left: 0, width: "var(--ui-vw)", height: "var(--ui-vh)", zIndex: 50, display: "flex", flexDirection: "column", background: "var(--surface-canvas)", paddingTop: "env(safe-area-inset-top)" }}>
          <PreferencesScreen
            compact={compact}
            initialTab={prefsTab}
            onClose={() => setView(prevView)}
            onNotify={showToast}
            onSignedOut={() => void handleLogout()}
          />
        </div>
      ) : null}
      {/* Instance administration, full-screen like the preferences and for the same reason: it is
          about the account and the instance, never about the space underneath. */}
      {view === "instance-admin" && session?.isInstanceAdmin ? (
        <div style={{ position: "fixed", top: 0, left: 0, width: "var(--ui-vw)", height: "var(--ui-vh)", zIndex: 50, display: "flex", flexDirection: "column", background: "var(--surface-canvas)", paddingTop: "env(safe-area-inset-top)" }}>
          <InstanceAdminScreen compact={compact} onClose={() => setView(prevView)} onNotify={showToast} />
        </div>
      ) : null}
      {/* A large modal, not a page: it floats over the space it came from on a dimmed scrim, so the
          import reads as something opened rather than somewhere navigated to. The screen keeps its
          own top bar and scrolls inside this shell. Clicking the scrim closes it, like any dialog;
          the run continues regardless, which is what the close button already promised. */}
      {view === "import" && session ? (
        <div
          className="wc-dlg__scrim"
          onClick={(e) => {
            if (e.target === e.currentTarget) setView(prevView);
          }}
        >
          <div className="wc-dlg wc-dlg--xl" role="dialog" aria-modal="true" aria-labelledby="import-title">
            <ImportScreen
              openLast={importDetail}
              onClose={() => {
                setView(prevView);
                // An import started here is running by the time the screen closes; the sidebar
                // should say so now rather than at the end of its idle minute.
                refreshImportRun();
              }}
              onNotify={showToast}
              compact={compact}
              instanceAddress={typeof window === "undefined" ? "" : window.location.host}
              onFinished={reloadSpaceCounters}
              instanceAdmin={session.isInstanceAdmin === true}
            />
          </div>
        </div>
      ) : null}
      {modal === "newChannel" ? (
        <NewChannelDialog
          onClose={() => setModal(null)}
          onCreate={createChannel}
          myRole={currentWorkspace?.role ?? "member"}
        />
      ) : null}
      {modal === "newMessage" ? (
        <NewMessageDialog people={people} onClose={() => setModal(null)} onSelect={openDmByName} />
      ) : null}
      {modal === "invite" ? (
        <InviteDialog
          onClose={() => setModal(null)}
          canInvite={["owner", "admin"].includes(workspaces.find((w) => w.id === ws)?.role ?? "")}
          invitations={invitations}
          emailDelivery={emailDelivery}
          onCreate={async ({ email, role }) => {
            const created = await createInvitation(ws, { email, role });
            setInvitations(await getInvitations(ws));
            showToast({
              tone: "success",
              title: created.emailed ? t("dialogs.inviteSent") : t("toast.inviteLinkCreated"),
              description: email ?? undefined,
            });
            return { url: created.url, emailed: created.emailed };
          }}
          onRevoke={async (id) => {
            await revokeInvitation(ws, id);
            setInvitations(await getInvitations(ws));
            showToast({ tone: "info", title: t("toast.inviteRevoked") });
          }}
        />
      ) : null}
      {/* The `+` offers importing to everyone: anybody may bring a workspace over into spaces of their
          own. Emptying the instance first stays with its administrators, inside the import screen. */}
      {modal === "newWorkspace" ? (
        <NewWorkspaceDialog
          onClose={() => setModal(null)}
          onCreate={createWorkspace}
          onImport={openImport}
        />
      ) : null}
      {removing && currentWorkspace ? (
        <RemoveMemberDialog
          spaceName={currentWorkspace.name}
          memberName={removing.name}
          busy={spaceBusy}
          onClose={() => setRemoving(null)}
          onConfirm={() => void removeMember(removing)}
        />
      ) : null}
      {transferTo && currentWorkspace ? (
        <TransferOwnershipDialog
          spaceName={currentWorkspace.name}
          memberName={transferTo.name}
          busy={spaceBusy}
          onClose={() => setTransferTo(null)}
          onConfirm={() => void transferOwnership(transferTo)}
        />
      ) : null}
      {modal === "leaveSpace" && currentWorkspace ? (
        <LeaveSpaceDialog
          name={currentWorkspace.name}
          busy={spaceBusy}
          error={exitError ? t(exitError) : null}
          onClose={() => {
            setExitError(null);
            setModal(null);
          }}
          onConfirm={() => void leaveWorkspace(currentWorkspace.id)}
        />
      ) : null}
      {modal === "deleteSpace" && currentWorkspace ? (
        <DeleteSpaceDialog
          name={currentWorkspace.name}
          busy={spaceBusy}
          error={exitError ? t(exitError) : null}
          onClose={() => {
            setExitError(null);
            setModal(null);
          }}
          onConfirm={() => void deleteWorkspace(currentWorkspace.id)}
        />
      ) : null}
      {modal === "help" ? (
        <HelpDialog
          onClose={() => setModal(null)}
          onCustomize={() => openPreferences("shortcuts")}
          onGettingStarted={() => {
            setModal(null);
            restartWelcome();
          }}
        />
      ) : null}
      {modal === "switcher" ? (
        <QuickSwitcher
          channels={channels}
          dms={dms}
          spaces={workspaces.filter((w) => w.id !== ws)}
          onClose={() => setModal(null)}
          onOpen={(id) => {
            setModal(null);
            openChannel(id);
          }}
          onOpenSpace={(id) => {
            setModal(null);
            void switchWorkspace(id);
          }}
        />
      ) : null}
      {modal === "search" ? (
        <GlobalSearchDialog
          spaceId={ws}
          people={people}
          onClose={() => setModal(null)}
          onOpenMessage={openMessage}
          onOpenFile={() => {
            setModal(null);
            setView("files");
          }}
          onOpenProfile={(name) => {
            setModal(null);
            setView("channel");
            setThread(null);
            setProfileEdit(false);
            setProfile(name);
          }}
        />
      ) : null}

      {channelSettingsId && channels.find((c) => c.id === channelSettingsId) ? (
        <ChannelSettingsDialog
          channel={channels.find((c) => c.id === channelSettingsId)!}
          onClose={() => setChannelSettingsId(null)}
          onUpdate={(patch) => updateChannel(channelSettingsId, patch)}
          onNotify={showToast}
          myRole={currentWorkspace?.role ?? "member"}
          myChannelRole={canModerateChannels ? myChannelRole(channelSettingsId) : "member"}
          isDefault={currentWorkspace?.defaultChannelId === channelSettingsId}
          onDelete={
            canAdministerSpace
              ? () => {
                  const target = channels.find((c) => c.id === channelSettingsId);
                  if (!target) return;
                  setDeleteChannelError(null);
                  setDeletingChannel({ id: target.id, name: target.name });
                }
              : undefined
          }
        />
      ) : null}

      {deletingChannel ? (
        <DeleteChannelDialog
          name={deletingChannel.name}
          busy={deleteChannelBusy}
          error={deleteChannelError}
          onClose={() => setDeletingChannel(null)}
          onConfirm={() => void confirmDeleteChannel()}
        />
      ) : null}

      {spaceNotifOpen && currentWorkspace ? (
        <ChannelNotificationsDialog
          channelName={currentWorkspace.name}
          isSpace
          inherited={settings.notif.messages ? "all" : "mentions"}
          value={{ level: currentWorkspace.notifyLevel, muted: false }}
          onClose={() => setSpaceNotifOpen(false)}
          onSave={(pref) => saveSpaceLevel(currentWorkspace.id, pref.level)}
          onNotify={showToast}
        />
      ) : null}

      {channelNotifId ? (
        <ChannelNotificationsDialog
          channelName={
            channels.find((c) => c.id === channelNotifId)?.name ??
            dms.find((d) => d.id === channelNotifId)?.name ??
            channelNotifId
          }
          isDm={!channels.some((c) => c.id === channelNotifId) && dms.some((d) => d.id === channelNotifId)}
          inherited={inheritedLevel}
          value={channelPrefs[channelNotifId] ?? DEFAULT_CHANNEL_PREF}
          onClose={() => setChannelNotifId(null)}
          onSave={(pref) => saveChannelPref(channelNotifId, pref)}
          onNotify={showToast}
        />
      ) : null}

      {/*
        Offered once, to someone who has just signed in and has not been asked before. The browser's
        permission is the only thing between them and being told about a message while they are
        elsewhere, and nothing else in the app will bring it up.
      */}
      {authStage === "app" && !settings.notifPrompted && notificationPermission() === "default" ? (
        <NotificationPrompt
          compact={compact}
          onAllow={() => {
            settings.set("notifPrompted", true);
            // Web Push where the browser offers it, so the notifications also reach a closed tab;
            // the page's own notifications otherwise.
            if (pushSupport() === "available") {
              void enablePush().then((outcome) => {
                if (outcome === "enabled") showToast({ tone: "success", title: t("notifPrompt.enabled") });
              });
              return;
            }
            void requestNotificationPermission().then((outcome) => {
              if (outcome === "granted") showToast({ tone: "success", title: t("notifPrompt.enabled") });
            });
          }}
          onDismiss={() => settings.set("notifPrompted", true)}
        />
      ) : null}

      {externalLink ? (
        <ExternalLinkDialog
          url={externalLink}
          onCancel={() => setExternalLink(null)}
          onOpen={(stopWarning) => {
            // No referrer and no handle on this window, like the link itself.
            window.open(externalLink, "_blank", "noopener,noreferrer");
            if (stopWarning) settings.set("externalLinkWarning", false);
            setExternalLink(null);
          }}
        />
      ) : null}

      {/* Not on a touch screen: its steps are a desktop's (shortcuts, the sidebar), and on a phone the
          card covered the tabs. */}
      {!settings.welcome.dismissed && !touch ? (
        <GettingStarted
          done={settings.welcome.done}
          onRun={runWelcomeStep}
          onDismiss={dismissWelcome}
          compact={compact}
        />
      ) : null}

      {toastMounted && toast ? (
        <div
          key={toastKey}
          className={toastClosing ? "wc-toast--out" : "wc-toast--in"}
          // Lift the toast above the getting-started card when it is on screen (desktop only; on compact
          // the card sits above the bottom tabs and the toast keeps its place).
          style={{ ...toastStyle.wrap, bottom: !settings.welcome.dismissed && !compact ? 84 : 20 }}
          role="status"
          aria-live="polite"
        >
          <div style={toast.action ? { ...toastStyle.card, flexDirection: "row", alignItems: "center", gap: 12 } : toastStyle.card}>
            <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
              <span style={toastStyle.title}>{toast.title}</span>
              {toast.description ? <span style={toastStyle.desc}>{toast.description}</span> : null}
            </span>
            {toast.action ? (
              <button
                type="button"
                style={toastStyle.action}
                onClick={() => {
                  const run = toast.action?.onClick;
                  clearTimeout(toastTimer.current);
                  setToastVisible(false);
                  run?.();
                }}
              >
                {toast.action.label}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );

  /** The signed-in person's menu as a sheet, for the shells without the rail that holds it. */
  const you = (
    <YouSheet
      open={youSheet}
      currentUser={currentUser}
      presence={myPresence}
      choice={myChoice}
      onClose={() => setYouSheet(false)}
      onSetPresence={setOwnPresence}
      onOpenProfile={openOwnProfile}
      onEditProfile={editOwnProfile}
      onOpenSettings={() => openPreferences()}
      onOpenInstanceAdmin={session?.isInstanceAdmin === true ? () => openInstanceAdmin() : undefined}
      onHelp={() => setModal("help")}
      onLogout={() => void handleLogout()}
    />
  );
  const spaces = (
    <SpaceSwitcherSheet
      open={spaceSheet}
      workspaces={orderedWorkspaces}
      active={ws}
      onSelect={(id) => void switchWorkspace(id)}
      onNew={() => setModal("newWorkspace")}
      onClose={() => setSpaceSheet(false)}
      onReorder={reorderWorkspace}
    />
  );

  if (compact) {
    const root = (
      <main style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
        {mobileTab === "home" ? (
          <>
            <MobileHeader
              leading={<SpaceMark workspace={currentWorkspace} />}
              title={wsName}
              titleLabel={wsName ? t("sidebar.spaceSwitchNamed", { name: wsName }) : t("sidebar.spaceSwitch")}
              onTitle={() => setSpaceSheet(true)}
              currentUser={currentUser}
              presence={myPresence}
              onYou={() => setYouSheet(true)}
            />
            {renderSidebar("phone")}
          </>
        ) : null}
        {mobileTab === "messages" ? (
          <>
            <MobileHeader title={t("tabs.messages")} currentUser={currentUser} presence={myPresence} onYou={() => setYouSheet(true)} onSearch={() => setModal("search")} />
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
              <MobileMessages
                dms={visibleDms}
                loading={switchingSpace}
                onOpen={openChannelPushed}
                onNew={() => setModal("newMessage")}
              />
            </div>
          </>
        ) : null}
        {mobileTab === "calendar" ? (
          <CalendarScreen
            compact
            timeZone={viewerTimeZone}
            spaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
            rememberFilter
            onNotify={showToast}
          />
        ) : null}
        {mobileTab === "activity" ? (
          <>
            <MobileHeader title={t("tabs.activity")} currentUser={currentUser} presence={myPresence} onYou={() => setYouSheet(true)} onSearch={() => setModal("search")} />
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
              <MobileActivity
                notifications={visibleNotifs}
                onOpen={(channelId, messageId, id) => {
                  openNotification(channelId, messageId, id);
                  setMobileContent(true);
                }}
                onToggleRead={setNotifRead}
              />
            </div>
          </>
        ) : null}
        {mobileTab === "home" || mobileTab === "messages" ? <ComposeFab onClick={() => setModal("newMessage")} /> : null}
      </main>
    );
    return (
      <>
        {/* Clear of the status bar and the notch (the page draws under them, see `viewportFit` in
            layout.tsx): every screen of the phone starts below them, on the canvas's colour. */}
        <div style={{ height: "var(--ui-vh)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--surface-canvas)", paddingTop: "env(safe-area-inset-top)" }}>
          {/* Whatever is pushed over the tabs carries the way back in its own heading (see the
              views' `onBack`), so there is no second bar above it naming it again. */}
          <div
            style={{ ...switchingStyle, flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}
            aria-busy={switchingSpace || undefined}
          >
            {mobileContent ? content : root}
          </div>
          {/* The tabs belong to the root screens: what is pushed over them takes the whole height. */}
          {mobileContent ? null : (
            <BottomTabs
              tabs={[
                { id: "home", label: t("tabs.home"), icon: "house", badge: mentionUnread || undefined },
                { id: "messages", label: t("tabs.messages"), icon: "message-square", badge: visibleDms.reduce((n, d) => n + d.unread, 0) || undefined },
                { id: "calendar", label: t("calendar.title"), icon: "calendar" },
                { id: "activity", label: t("tabs.activity"), icon: "bell", badge: notifUnread || undefined },
              ]}
              active={mobileTab}
              onSelect={(id) => setMobileTab(id as "home" | "messages" | "calendar" | "activity")}
            />
          )}
        </div>
        {spaces}
        {you}
        {overlays}
      </>
    );
  }

  if (tablet) {
    // Two columns: the space's list, railless, and what is open. Side panels cover the conversation
    // (see ChannelScreen's `overlayPanels`) rather than squeezing it.
    return (
      <div style={{ height: "var(--ui-vh)", display: "flex", overflow: "hidden", background: "var(--surface-canvas)" }}>
        <div
          style={{ ...switchingStyle, flex: 1, minWidth: 0, display: "flex", overflow: "hidden" }}
          aria-busy={switchingSpace || undefined}
        >
          {renderSidebar("tablet")}
          {content}
        </div>
        {spaces}
        {you}
        {overlays}
      </div>
    );
  }

  return (
    <div style={{ height: "var(--ui-vh)", display: "flex", overflow: "hidden", background: "var(--surface-canvas)" }}>
      {rail}
      <div
        style={{ ...switchingStyle, flex: 1, minWidth: 0, display: "flex", overflow: "hidden" }}
        aria-busy={switchingSpace || undefined}
      >
        {desktopSidebar}
        {content}
      </div>
      {overlays}
    </div>
  );
}
