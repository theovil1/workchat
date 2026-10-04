/**
 * Notification model for the app shell.
 *
 * The inbox comes from the API (`GET /notifications`), for the whole account rather than one space,
 * since a notification is addressed to a person. It is held as a flat, mutable list the notification
 * center reads, filtered to the space on screen at display time. Read state lives on each item so
 * marking one (or all) read never rebuilds the list. Per-channel preferences are
 * applied at display time (see `passesPref`) so muting a channel hides its notifications and drops
 * them from the unread count without discarding the read state of the others.
 */

import type { ReminderInfo } from "@/lib/data/api";
import { key, type Translate, type TranslationKey } from "@/lib/i18n";

/**
 * Why a notification exists.
 *
 * `mention` is someone typing your name. `broadcast` is `@canal` or `@ici`, which reaches you as
 * one of the room rather than as yourself: a weaker claim on your attention, and the one people
 * most often want to turn off, which is why it is a kind of its own rather than a mention like any
 * other. `message` is any other message, for someone who asked to hear about every one of them in
 * that conversation (its level, its space's, or their own default).
 */
export type NotifKind = "mention" | "broadcast" | "reply" | "dm" | "message" | "calendar_reminder" | "calendar_invitation" | "calendar_update" | "calendar_cancel" | "calendar_declined";

/** Whether a kind is one of an invitation's: the invitation, a change, a cancellation, a refusal. */
export function isInvitationKind(kind: NotifKind): boolean {
  return kind === "calendar_invitation" || kind === "calendar_update" || kind === "calendar_cancel" || kind === "calendar_declined";
}

/** Whether a kind belongs under the Mentions badge: named directly, or addressed with the room. */
export function isMention(kind: NotifKind): boolean {
  return kind === "mention" || kind === "broadcast";
}

export type AppNotification = {
  id: string;
  kind: NotifKind;
  channelId: string;
  /**
   * The space it happened in.
   *
   * The inbox is fetched for the whole account, since a notification is addressed to a person and
   * not to a space, but it is *shown* for the space on screen: the rail already carries a per-space
   * count, and a mention in one space appearing in the sidebar of every other one double-reports it
   * and points at a conversation that is not there.
   */
  spaceId: string;
  /** "#canal" for channels, the person's name for direct messages. */
  label: string;
  /** The space's name, so a notification from another space can say where it happened. */
  spaceName: string;
  isDm: boolean;
  /** Who triggered the notification (drives the avatar). */
  actor: string;
  /** The message to jump to when the notification is opened. */
  messageId: string;
  /** Short one-line preview of the triggering message. */
  preview: string;
  /** When the triggering message was sent (RFC 3339): the words around it are drawn per reader. */
  createdAt: string;
  read: boolean;
  /** A calendar reminder's event; its `channelId` and `messageId` are empty. */
  reminder?: ReminderInfo;
};

/**
 * How much a conversation notifies. `default` follows its space's level, and the space's `default`
 * follows the person's own preferences. `all` is every message, `mentions` only what names or
 * addresses the person, `none` nothing.
 */
export type NotifLevel = "default" | "all" | "mentions" | "none";

export type ChannelNotifPref = {
  level: NotifLevel;
  muted: boolean;
};

export const DEFAULT_CHANNEL_PREF: ChannelNotifPref = { level: "default", muted: false };

/** The level in force for a conversation: its own, else its space's, else `default` (one's own). */
export function effectiveLevel(pref: ChannelNotifPref | undefined, spaceLevel?: NotifLevel): NotifLevel {
  const own = pref?.level ?? "default";
  if (own !== "default") return own;
  return spaceLevel ?? "default";
}

/** Global notification preferences, persisted with the rest of the settings. */
export type NotifPrefs = {
  /** Master switch: off silences every channel. */
  enabled: boolean;
  /** Play a sound on a new notification. */
  sound: boolean;
  /**
   * Which kinds reach the person in the app and by push. `channelMentions` is `@canal` / `@ici`;
   * `messages` is every other message, where nothing nearer (the conversation, the space) decides.
   */
  mentions: boolean;
  channelMentions: boolean;
  replies: boolean;
  directMessages: boolean;
  messages: boolean;
  /** Suppress notifications during the configured quiet hours. */
  quietHours: boolean;
  /** Quiet-hours start, "HH:MM" (24h). May be later than `quietTo` for an overnight window. */
  quietFrom: string;
  /** Quiet-hours end, "HH:MM" (24h). */
  quietTo: string;
  /**
   * Email what is still unread after a while, when no Ruchoir page is open. The server acts on it
   * (see `apps/api/src/notify/email.rs`); the app itself has nothing to do with it.
   */
  email: boolean;
  /** The same kinds, by email. `@canal` and every message are off by default there. */
  emailMentions: boolean;
  emailBroadcasts: boolean;
  emailReplies: boolean;
  emailDirectMessages: boolean;
  emailMessages: boolean;
  /** Reminders before an event of the person's calendars, in the app and by mail. */
  calendarReminders: boolean;
  emailCalendarReminders: boolean;
  /** Invitations to an event, and their changes, cancellations and refusals; in the app and by mail. */
  calendarInvitations: boolean;
  emailCalendarInvitations: boolean;
};

export const DEFAULT_NOTIF_PREFS: NotifPrefs = {
  enabled: true,
  sound: false,
  mentions: true,
  channelMentions: true,
  replies: true,
  directMessages: true,
  messages: false,
  quietHours: false,
  quietFrom: "21:00",
  quietTo: "08:00",
  email: true,
  emailMentions: true,
  emailBroadcasts: false,
  emailReplies: true,
  emailDirectMessages: true,
  emailMessages: false,
  calendarReminders: true,
  emailCalendarReminders: true,
  calendarInvitations: true,
  emailCalendarInvitations: true,
};

/** Whether two sets of global preferences say the same thing, field by field. */
export function sameNotifPrefs(a: NotifPrefs, b: NotifPrefs): boolean {
  return (Object.keys(DEFAULT_NOTIF_PREFS) as (keyof NotifPrefs)[]).every((k) => a[k] === b[k]);
}

/** Human summary of the quiet-hours window, e.g. "21 h 00 - 8 h 00" (French, no leading zero on hours). */
export function quietHoursLabel(prefs: NotifPrefs): string {
  // Defensive: settings persisted before these keys existed (or kept across an HMR reload) may lack
  // them, so fall back to the defaults rather than crashing on an undefined value.
  const fmt = (t: string) => {
    const [h = "0", m = "00"] = (t || "").split(":");
    return `${Number(h)} h ${m}`;
  };
  return `${fmt(prefs.quietFrom ?? DEFAULT_NOTIF_PREFS.quietFrom)} - ${fmt(prefs.quietTo ?? DEFAULT_NOTIF_PREFS.quietTo)}`;
}

/** The dictionary key naming what happened, per notification kind. */
const KIND_VERB: Record<NotifKind, TranslationKey> = {
  mention: key("notif.mentioned"),
  broadcast: key("notif.broadcast"),
  reply: key("notif.replied"),
  dm: key("notif.dm"),
  message: key("notif.wrote"),
  calendar_reminder: key("notif.reminder"),
  calendar_invitation: key("notif.invitation"),
  calendar_update: key("notif.invitationUpdate"),
  calendar_cancel: key("notif.invitationCancel"),
  calendar_declined: key("notif.invitationDeclined"),
};

/**
 * Short sentence for a notification, e.g. "Alice vous a mentionné".
 *
 * Takes the translator rather than reaching for one: this is a plain function called from
 * components, and each of them already holds it.
 */
export function notifSummary(n: AppNotification, t: Translate): string {
  if (n.reminder && isInvitationKind(n.kind)) return t(KIND_VERB[n.kind], { actor: n.actor, title: n.reminder.title });
  if (n.reminder) return t(KIND_VERB.calendar_reminder, { title: n.reminder.title });
  return `${n.actor} ${t(KIND_VERB[n.kind])}`;
}

/**
 * Whether a notification should be shown, given the conversation's, the space's and the person's
 * own preferences. The same rule as `allows` in `apps/api/src/notify/prefs.rs` (for the app and
 * push): the two must agree, or the phone and the app disagree about what was worth saying.
 */
export function passesPref(
  n: AppNotification,
  channelPref: ChannelNotifPref | undefined,
  prefs: NotifPrefs,
  spaceLevel?: NotifLevel,
): boolean {
  if (!prefs.enabled) return false;
  // A reminder belongs to no conversation: its own switch decides.
  if (n.kind === "calendar_reminder") return prefs.calendarReminders ?? true;
  if (isInvitationKind(n.kind)) return prefs.calendarInvitations ?? true;
  if (channelPref?.muted) return false;
  const level = effectiveLevel(channelPref, spaceLevel);
  if (level === "none") return false;
  if (n.kind === "message") return level === "all" || (level === "default" && prefs.messages);
  const wanted: Partial<Record<NotifKind, boolean>> = {
    mention: prefs.mentions ?? true,
    broadcast: prefs.channelMentions ?? true,
    reply: prefs.replies ?? true,
    dm: prefs.directMessages ?? true,
  };
  if (!wanted[n.kind]) return false;
  if (level === "mentions") return isMention(n.kind) || n.kind === "dm";
  return true;
}
