"use client";

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, Checkbox, Field, Icon, type IconName, Input, Select, Switch } from "@/components/ds";
import { AccountSecuritySection } from "./AccountSecurity";
import { sendTestPush, updateMyProfile } from "@/lib/data/api";
import { isApiError } from "@/lib/data/http";
import { initialLocale, key, literal, type TranslationKey, useTranslation } from "@/lib/i18n";
import { LanguagePicker } from "./LanguagePicker";
import { Emoji } from "./Emoji";
import { DEFAULT_NOTIF_PREFS, type NotifPrefs, quietHoursLabel } from "./notifications";
import {
  notificationPermission,
  playNotificationSound,
  requestNotificationPermission,
  serverNotificationPermission,
  showDesktopNotification,
  subscribeToNotificationPermission,
} from "./desktopNotifications";
import {
  disablePush,
  enablePush,
  pushActive,
  pushSupport,
  serverPushActive,
  subscribeToPushState,
  type PushSupport,
} from "./webPush";
import {
  useSettings,
  type DefaultPanel,
  type FilesLayout,
  type FontChoice,
  type TextSize,
  THEME_ACCENTS,
  type ThemeAccent,
  type ThemeMode,
} from "./settings";
import { WordmarkLockup } from "./Wordmark";
import {
  COMMANDS,
  DEFAULT_BINDINGS,
  eventToChord,
  FILE_KEYS,
  formatChord,
  isMac,
  type ShortcutId,
} from "./shortcuts";
import type { Toast } from "./types";
import { currentLocale } from "@/lib/i18n/current";
import {
  type CalendarPrefs,
  type ClockFormat,
  DESKTOP_VIEWS,
  type DesktopView,
  DURATIONS,
  PHONE_VIEWS,
  type PhoneView,
  WEEK_STARTS,
  type WeekStart,
} from "@/features/calendar/prefs";

/** The first letter in capitals, as a list of choices writes it: "Lundi". */
function capitalize(text: string, locale: string): string {
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

export type PrefTab = "appearance" | "calendar" | "notifications" | "shortcuts" | "security" | "emojis";

const NAV: [PrefTab, TranslationKey, IconName][] = [
  ["appearance", key("prefs.appearance"), "layout-grid"],
  ["calendar", key("calendar.title"), "calendar"],
  ["notifications", key("notif.title"), "bell"],
  ["shortcuts", key("prefs.shortcuts"), "keyboard"],
  ["security", key("prefs.security"), "shield"],
  ["emojis", key("prefs.emojis"), "smile"],
];


/** The pastel each accent paints with, for the picker's swatches (fixed, not live tokens). */
const ACCENT_PREVIEW: Record<ThemeAccent, { label: TranslationKey; colour: string }> = {
  sky: { label: key("prefs.themeSky"), colour: "#8fd0ff" },
  mint: { label: key("prefs.themeMint"), colour: "#6fe0c2" },
  violet: { label: key("prefs.themeViolet"), colour: "#c9a8ff" },
  pink: { label: key("prefs.themePink"), colour: "#f5b0f0" },
};

/** Canvas, surface and ink of the day and the night, for the same swatches. */
const MODE_PREVIEW = {
  day: { canvas: "#f6f7f9", surface: "#fdfdfe", ink: "#15171c" },
  night: { canvas: "#15171c", surface: "#1d2027", ink: "#f6f7f9" },
};

const MODE_OPTIONS: { id: ThemeMode; label: TranslationKey; icon: IconName }[] = [
  { id: "day", label: key("prefs.modeDay"), icon: "sun" },
  { id: "night", label: key("prefs.modeNight"), icon: "moon" },
  { id: "auto", label: key("prefs.modeAuto"), icon: "monitor" },
];

const st: Record<string, CSSProperties> = {
  top: {
    height: "var(--topbar-height)",
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "0 16px",
    background: "var(--surface-chrome)",
    borderBottom: "1.5px solid var(--border-subtle)",
  },
  mark: { width: 22, height: 22, flex: "none", display: "block" },
  divider: { width: 1, height: 20, flex: "none", background: "var(--border-subtle)", margin: "0 2px" },
  title: {
    margin: 0,
    // Grow to fill the bar and truncate, so the mark + title never push the Retour button off-screen
    // at very narrow widths (mobile + browser zoom + large text size).
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "var(--text-base)",
    fontWeight: 600,
    color: "var(--text-muted)",
  },
  // The row itself never scrolls: the sub-nav and the panel each scroll on their own, so reading a
  // long section does not carry the nav out of reach.
  body: { flex: 1, overflow: "hidden", display: "flex", minWidth: 0, minHeight: 0 },
  nav: {
    width: 220,
    flex: "none",
    padding: "16px 8px",
    background: "var(--surface-chrome)",
    borderRight: "1.5px solid var(--border-subtle)",
    overflowY: "auto",
  },
  /** The scrolling half. Its bottom padding is what keeps the last row off the edge of the window. */
  scroller: { flex: 1, minWidth: 0, overflowY: "auto" },
  main: { padding: "40px 40px 64px", maxWidth: 820 },
  h: {
    fontSize: "clamp(28px, 3.4vw, 40px)",
    fontWeight: 700,
    letterSpacing: "var(--tracking-display)",
    lineHeight: 1.05,
    color: "var(--text-strong)",
    marginBottom: 10,
  },
  sub: { fontSize: "var(--text-md)", color: "var(--text-body)", marginBottom: 8 },
  sect: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    fontWeight: 500,
    color: "var(--text-muted)",
    margin: "32px 0 10px",
  },
};

function navItem(on: boolean, compact = false): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: compact ? "auto" : "100%",
    flex: "none",
    height: compact ? 32 : 36,
    padding: "0 10px",
    border: 0,
    borderRadius: "var(--radius-sm)",
    background: on ? "var(--acc)" : compact ? "var(--surface-sunken)" : "transparent",
    color: on ? "var(--on-pastel)" : "var(--text-body)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    fontWeight: on ? 600 : 400,
    cursor: "pointer",
    textAlign: "left",
    whiteSpace: "nowrap",
  };
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 12,
  rowGap: 8,
  padding: "12px 0",
  borderBottom: "1px solid var(--border-subtle)",
};

/** A title + description on the left, a control on the right. */
function Row({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <div style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" }}>{title}</div>
        {desc ? <div style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginTop: 2, maxWidth: 460 }}>{desc}</div> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * The browser's permission for system notifications, and the one place it can be asked for.
 *
 * Asking is a deliberate act here rather than something the app does on load: a page that prompts
 * the moment it opens is why people refuse notifications for good, and a refusal cannot be undone
 * from the page. Which is also why the refused state says where to go instead of offering a button
 * that would do nothing.
 *
 * The permission is read on mount rather than rendered from the start, because there is no such
 * thing during the static export's render pass and assuming one would flash the wrong state.
 */
function BrowserNotificationRow({ soundOn, onNotify }: { soundOn: boolean; onNotify?: (t: Toast) => void }) {
  const { t } = useTranslation();
  // Read as what it is: a value owned by the browser, not by React. The third argument is the
  // snapshot for the render that happens without one, which is every render of the static export.
  const permission = useSyncExternalStore(
    subscribeToNotificationPermission,
    notificationPermission,
    serverNotificationPermission,
  );

  const test = () => {
    if (soundOn) playNotificationSound();
    showDesktopNotification({
      title: "Ruchoir",
      body: t("prefs.testBody"),
      tag: "ruchoir-test",
      onClick: () => {},
      // Said out loud, because the alternative is a button that looks broken. The browser accepted
      // it; whether anything was drawn is the system's decision and it does not report back.
      onDelivered: (shown) =>
        onNotify?.(
          shown
            ? { tone: "success", title: t("prefs.shown") }
            : {
                tone: "warning",
                title: t("prefs.notShown"),
                description:
                  t("prefs.notShownDesc"),
              },
        ),
    });
  };

  const desc =
    permission === "granted"
      ? t("prefs.notifGranted")
      : permission === "denied"
        ? t("prefs.notifDenied")
        : permission === "unsupported"
          ? t("prefs.notifUnsupported")
          : t("prefs.notifDefault");

  return (
    <Row title={t("prefs.browserNotif")} desc={desc}>
      {permission === "default" ? (
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            void requestNotificationPermission();
          }}
        >
          {t("prefs.allow")}
        </Button>
      ) : permission === "granted" ? (
        <Button size="sm" onClick={test}>
          {t("prefs.test")}
        </Button>
      ) : null}
    </Row>
  );
}

/** The kinds in the table, with the two switches each one has. */
const KINDS: {
  label: TranslationKey;
  desc: TranslationKey;
  app: keyof NotifPrefs;
  email: keyof NotifPrefs;
}[] = [
  { label: key("notif.kindMentions"), desc: key("notif.kindMentionsDesc"), app: "mentions", email: "emailMentions" },
  { label: key("notif.kindBroadcasts"), desc: key("notif.kindBroadcastsDesc"), app: "channelMentions", email: "emailBroadcasts" },
  { label: key("notif.kindReplies"), desc: key("notif.kindRepliesDesc"), app: "replies", email: "emailReplies" },
  { label: key("sidebar.directMessages"), desc: key("notif.kindDmsDesc"), app: "directMessages", email: "emailDirectMessages" },
  { label: key("notif.kindMessages"), desc: key("notif.kindMessagesDesc"), app: "messages", email: "emailMessages" },
  { label: key("notif.kindReminders"), desc: key("notif.kindRemindersDesc"), app: "calendarReminders", email: "emailCalendarReminders" },
];

/**
 * What reaches the person, and how: one row per kind of notification, one column for the app and
 * push, one for the email catch-up (whose master switch heads its column).
 *
 * These are the defaults: a space, a channel or a conversation can say more or less from its own
 * menu, and the nearest one wins. "Every message" is off here, so a busy space does not ring for
 * each line unless someone asked for it there or everywhere.
 */
function NotificationKinds() {
  const { t } = useTranslation();
  const s = useSettings();
  const notif = { ...DEFAULT_NOTIF_PREFS, ...s.notif };
  const set = (field: keyof NotifPrefs, value: boolean) => s.set("notif", { ...notif, [field]: value });
  const cell: CSSProperties = { width: 96, flex: "none", display: "flex", justifyContent: "center" };

  return (
    <div style={{ padding: "16px 0 4px" }}>
      <div style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--text-strong)" }}>{t("notif.whatTitle")}</div>
      <div style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginTop: 2, maxWidth: 560 }}>{t("notif.whatSub")}</div>
      <div
        role="table"
        aria-label={t("notif.whatTitle")}
        style={{ marginTop: 12, border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", overflow: "hidden" }}
      >
        <div
          role="row"
          style={{
            fontFamily: "var(--font-mono)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            background: "var(--surface-sunken)",
            fontSize: "var(--text-2xs)",
            fontWeight: 500,
            color: "var(--text-muted)",
          }}
        >
          <span role="columnheader" style={{ flex: 1 }} />
          <span role="columnheader" style={{ ...cell, textAlign: "center" }}>
            {t("notif.columnApp")}
          </span>
          <span role="columnheader" style={{ ...cell, flexDirection: "column", alignItems: "center", gap: 4 }}>
            {t("notif.columnEmail")}
            <Switch
              checked={notif.email}
              onChange={(e) => set("email", e.target.checked)}
              aria-label={t("prefs.emailCatchUp")}
            />
          </span>
        </div>
        {KINDS.map((kind) => (
          <div
            key={kind.app}
            role="row"
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderTop: "1px solid var(--border-subtle)" }}
          >
            <span role="rowheader" style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--text-strong)" }}>{t(kind.label)}</span>
              <span style={{ display: "block", fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginTop: 1 }}>{t(kind.desc)}</span>
            </span>
            <span role="cell" style={cell}>
              <Checkbox
                checked={Boolean(notif[kind.app])}
                onChange={(e) => set(kind.app, e.target.checked)}
                aria-label={`${t(kind.label)}, ${t("notif.columnApp")}`}
              />
            </span>
            <span role="cell" style={{ ...cell, opacity: notif.email ? 1 : 0.4 }}>
              <Checkbox
                checked={Boolean(notif[kind.email])}
                disabled={!notif.email}
                onChange={(e) => set(kind.email, e.target.checked)}
                aria-label={`${t(kind.label)}, ${t("notif.columnEmail")}`}
              />
            </span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginTop: 8, maxWidth: 560 }}>
        {notif.email ? t("prefs.emailCatchUpDesc") : t("notif.emailOff")}
      </div>
    </div>
  );
}

const noSubscription = () => () => {};

/**
 * Web Push for this device: the notifications that still arrive with every Ruchoir tab closed, or
 * with the app installed and not running.
 *
 * Per browser, so it is set here rather than with the account's settings, and it says plainly what
 * this browser can do: on iPhone and iPad, Safari only offers it to the app once it is on the home
 * screen, and asking anyway would only fail.
 *
 * The test sends a real push from the server, through the browser vendor's push service, to the
 * service worker, which is the path taken when the app is closed or installed. Drawing a
 * notification from the page would only prove that the page can draw one.
 */
function DevicePushRow({ onNotify }: { onNotify?: (t: Toast) => void }) {
  const { t } = useTranslation();
  const support = useSyncExternalStore<PushSupport>(noSubscription, pushSupport, () => "unsupported");
  const active = useSyncExternalStore(subscribeToPushState, pushActive, serverPushActive);
  const [busy, setBusy] = useState(false);

  const enable = async () => {
    setBusy(true);
    const outcome = await enablePush();
    setBusy(false);
    if (outcome === "enabled") onNotify?.({ tone: "success", title: t("notifPrompt.enabled") });
    else if (outcome === "denied") onNotify?.({ tone: "warning", title: t("prefs.notifDenied") });
    else if (outcome === "unavailable") onNotify?.({ tone: "warning", title: t("prefs.pushUnavailable") });
    else onNotify?.({ tone: "danger", title: t("prefs.pushFailed") });
  };

  const test = async () => {
    setBusy(true);
    try {
      const result = await sendTestPush();
      onNotify?.(
        result.delivered > 0
          ? { tone: "success", title: t("prefs.pushTestSent"), description: t("prefs.pushTestSentDesc") }
          : { tone: "warning", title: t("prefs.pushTestRefused") },
      );
    } catch (err) {
      onNotify?.(
        isApiError(err, 409)
          ? { tone: "warning", title: t("prefs.pushTestWait") }
          : { tone: "danger", title: t("prefs.pushFailed") },
      );
    } finally {
      setBusy(false);
    }
  };

  const desc =
    support === "needs-install"
      ? t("prefs.pushNeedsInstall")
      : support === "unsupported"
        ? t("prefs.pushUnsupported")
        : active
          ? t("prefs.pushOnDesc")
          : t("prefs.pushOffDesc");

  return (
    <Row title={t("prefs.pushTitle")} desc={desc}>
      {support === "available" && !active ? (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void enable()}>
          {t("notifPrompt.allow")}
        </Button>
      ) : null}
      {support === "available" && active ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <Button size="sm" disabled={busy} onClick={() => void test()}>
            {t("prefs.test")}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void disablePush()}>
            {t("security.turnOff")}
          </Button>
        </div>
      ) : null}
    </Row>
  );
}

/** Preview font stacks, independent of the live --font-sans so each card always shows its own type. */
const FONT_OPTIONS: { id: FontChoice; label: TranslationKey; desc: TranslationKey; stack: string }[] = [
  { id: "plex", label: literal("IBM Plex Sans"), desc: key("prefs.fontDefault"), stack: '"IBM Plex Sans", "Helvetica Neue", sans-serif' },
  { id: "system", label: key("prefs.fontSystem"), desc: key("prefs.fontSystemDesc"), stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: "dyslexic", label: literal("OpenDyslexic"), desc: key("prefs.fontDyslexic"), stack: '"OpenDyslexic", "Comic Sans MS", sans-serif' },
];

function FontPicker({ value, onChange }: { value: FontChoice; onChange: (f: FontChoice) => void }) {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-label={t("prefs.font")} style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 520 }}>
      {FONT_OPTIONS.map((f) => {
        const selected = f.id === value;
        return (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(f.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "12px 14px",
              cursor: "pointer",
              textAlign: "left",
              borderRadius: "var(--radius-md)",
              background: "var(--surface-card)",
              // Chosen: an ink edge and the offset shadow, as the chosen theme.
              border: `1.5px solid ${selected ? "var(--ink)" : "var(--border-default)"}`,
              boxShadow: selected ? "var(--shadow-popover)" : "none",
              transition: "border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out)",
            }}
          >
            <span aria-hidden style={{ fontFamily: f.stack, fontSize: 30, lineHeight: 1, color: "var(--text-strong)", flex: "none", width: 44, textAlign: "center" }}>
              {t("prefs.fontSampleLetters")}
            </span>
            <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--text-strong)" }}>{t(f.label)}</span>
                {selected ? <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>{t("prefs.active")}</span> : null}
              </span>
              <span style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>{t(f.desc)}</span>
              {/* Sample rendered in the target font so the choice previews before it is applied. */}
              <span style={{ fontFamily: f.stack, fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
                {t("prefs.fontSampleText")}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

const SIZE_OPTIONS: { id: TextSize; label: TranslationKey; sample: number }[] = [
  { id: "s", label: key("prefs.sizeS"), sample: 13 },
  { id: "m", label: key("prefs.sizeM"), sample: 15 },
  { id: "l", label: key("prefs.sizeL"), sample: 17 },
  { id: "xl", label: key("prefs.sizeXL"), sample: 20 },
];

function TextSizePicker({ value, onChange }: { value: TextSize; onChange: (t: TextSize) => void }) {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-label={t("prefs.textSize")} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {SIZE_OPTIONS.map((o) => {
        const selected = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.id)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              width: 96,
              height: 72,
              cursor: "pointer",
              borderRadius: "var(--radius-md)",
              background: "var(--surface-card)",
              // Chosen: an ink edge and the offset shadow, as the chosen theme.
              border: `1.5px solid ${selected ? "var(--ink)" : "var(--border-default)"}`,
              boxShadow: selected ? "var(--shadow-popover)" : "none",
              transition: "border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out)",
            }}
          >
            <span aria-hidden style={{ fontSize: o.sample, fontWeight: 600, lineHeight: 1, color: "var(--text-strong)" }}>A</span>
            <span style={{ fontSize: "var(--text-2xs)", color: selected ? "var(--text-accent)" : "var(--text-muted)" }}>{t(o.label)}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The accent, as four cards. Each swatch is drawn in the mode on screen, so what is chosen here is
 * what the interface will look like right now, by day or by night.
 */
function AccentPicker({ value, night, onChange }: { value: ThemeAccent; night: boolean; onChange: (a: ThemeAccent) => void }) {
  const { t } = useTranslation();
  const colours = MODE_PREVIEW[night ? "night" : "day"];
  return (
    <div
      role="radiogroup"
      aria-label={t("prefs.accent")}
      style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12, maxWidth: 720 }}
    >
      {THEME_ACCENTS.map((accent) => (
        <button
          key={accent}
          type="button"
          role="radio"
          aria-checked={accent === value}
          className="wc-theme-card"
          onClick={() => onChange(accent)}
        >
          {/* The theme in four bands: canvas, surface, accent, ink. */}
          <span aria-hidden className="wc-theme-card__sw">
            <span style={{ background: colours.canvas }} />
            <span style={{ background: colours.surface }} />
            <span style={{ background: ACCENT_PREVIEW[accent].colour }} />
            <span style={{ background: colours.ink }} />
          </span>
          {t(ACCENT_PREVIEW[accent].label)}
        </button>
      ))}
    </div>
  );
}

const MODE_HINT = { auto: key("prefs.modeAutoHint"), fixed: key("prefs.modeFixedHint") };

/** Day, night or automatic: one row of three, drawn as the design system's pill switch. */
function ModePicker({ value, onChange }: { value: ThemeMode; onChange: (m: ThemeMode) => void }) {
  const { t } = useTranslation();
  return (
    <div>
      <div role="radiogroup" aria-label={t("prefs.mode")} className="wc-tabs wc-tabs--pills">
        {MODE_OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={o.id === value}
            className={`wc-tab${o.id === value ? " wc-tab--on" : ""}`}
            onClick={() => onChange(o.id)}
          >
            <Icon name={o.icon} size={14} />
            {t(o.label)}
          </button>
        ))}
      </div>
      <div style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginTop: 8 }}>
        {t(value === "auto" ? MODE_HINT.auto : MODE_HINT.fixed)}
      </div>
    </div>
  );
}

const kbdStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-2xs)",
  color: "var(--text-strong)",
  background: "var(--surface-card)",
  // A key cap: the outline of a control, thicker at the bottom.
  border: "1.5px solid var(--control-line)",
  borderBottomWidth: 3,
  borderRadius: "var(--radius-sm)",
  padding: "2px 8px",
  whiteSpace: "nowrap",
};

/** One editable shortcut row: label + hint on the left, current chord and controls on the right. */
function ShortcutRow({
  id,
  capturing,
  chord,
  isDefault,
  conflict,
  mac,
  onStart,
  onReset,
}: {
  id: ShortcutId;
  capturing: boolean;
  chord: string;
  isDefault: boolean;
  conflict: TranslationKey | null;
  mac: boolean;
  onStart: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const def = COMMANDS.find((c) => c.id === id)!;
  return (
    <div style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--text-strong)" }}>{t(def.label)}</div>
        <div style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginTop: 2, maxWidth: 460 }}>{t(def.hint)}</div>
        {conflict ? (
          <div style={{ fontSize: "var(--text-2xs)", color: "var(--status-danger-fg)", marginTop: 4 }}>
            {t("shortcut.conflict", { label: t(conflict) })}
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {capturing ? (
          <span
            style={{
              ...kbdStyle,
              color: "var(--text-accent)",
              borderColor: "var(--border-accent)",
              background: "var(--surface-selected)",
            }}
          >
            {t("shortcut.pressCombination")}
          </span>
        ) : chord ? (
          <kbd style={kbdStyle}>{formatChord(chord, mac, t)}</kbd>
        ) : (
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--text-subtle)" }}>{t("dialogs.unassigned")}</span>
        )}
        <Button size="sm" variant="secondary" onClick={onStart} aria-label={t("shortcut.editShortcut", { label: t(def.label) })}>
          {capturing ? t("common.cancel") : t("message.edit")}
        </Button>
        {!isDefault ? (
          <Button
            size="sm"
            variant="ghost"
            iconLeft="refresh-cw"
            onClick={onReset}
            aria-label={t("shortcut.resetShortcut", { label: t(def.label) })}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The calendar's own preferences: the view it opens on (one for a desktop, one for a phone, which
 * has no week view), the week, the clock, the working day and how long a new event lasts. Kept on
 * the device with the rest of the preferences.
 */
function CalendarSection() {
  const { t } = useTranslation();
  const s = useSettings();
  const c = s.calendar;
  const set = (patch: Partial<CalendarPrefs>) => s.set("calendar", { ...c, ...patch });
  const locale = currentLocale();
  // Examples drawn by the clock itself, so each choice shows what it looks like.
  const sample = (cycle?: "h23" | "h12", hour = 14, minute = 30) =>
    new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: "UTC", ...(cycle ? { hourCycle: cycle } : {}) }).format(
      new Date(Date.UTC(2026, 0, 1, hour, minute)),
    );
  const cycle = c.clock === "24" ? "h23" : c.clock === "12" ? "h12" : undefined;
  const hours = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i).map((h) => ({ value: String(h), label: h === 24 ? sample(cycle, 23, 59) : sample(cycle, h, 0) }));
  const weekday = (day: number) =>
    capitalize(new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 9, 18 + day, 12))), locale);
  const durationLabel = (minutes: number) =>
    minutes < 60
      ? t("calendar.prefs.durationMinutes", { count: minutes })
      : minutes % 60 === 0
        ? t("calendar.prefs.durationHours", { count: minutes / 60 })
        : t("calendar.prefs.durationHoursMinutes", { h: Math.floor(minutes / 60), m: minutes % 60 });

  return (
    <>
      <h2 style={st.h}>{t("calendar.title")}</h2>
      <p style={st.sub}>{t("calendar.prefs.sub")}</p>

      <div style={st.sect} className="wc-sect">{t("prefs.defaultDisplay")}</div>
      <Row title={t("calendar.prefs.viewDesktop")}>
        <Select
          aria-label={t("calendar.prefs.viewDesktop")}
          value={c.viewDesktop}
          onChange={(e) => set({ viewDesktop: e.target.value as DesktopView })}
          options={DESKTOP_VIEWS.map((v) => ({ value: v, label: t(`calendar.view.${v}`) }))}
        />
      </Row>
      <Row title={t("calendar.prefs.viewPhone")}>
        <Select
          aria-label={t("calendar.prefs.viewPhone")}
          value={c.viewPhone}
          onChange={(e) => set({ viewPhone: e.target.value as PhoneView })}
          options={PHONE_VIEWS.map((v) => ({ value: v, label: t(`calendar.view.${v}`) }))}
        />
      </Row>

      <div style={st.sect} className="wc-sect">{t("calendar.prefs.weekAndTime")}</div>
      <Row title={t("calendar.prefs.weekStart")}>
        <Select
          aria-label={t("calendar.prefs.weekStart")}
          value={String(c.weekStart)}
          onChange={(e) => set({ weekStart: Number(e.target.value) as WeekStart })}
          options={WEEK_STARTS.map((d) => ({ value: String(d), label: weekday(d) }))}
        />
      </Row>
      <Row title={t("calendar.prefs.clock")}>
        <Select
          aria-label={t("calendar.prefs.clock")}
          value={c.clock}
          onChange={(e) => set({ clock: e.target.value as ClockFormat })}
          options={[
            { value: "auto", label: `${t("calendar.prefs.clockAuto")} (${sample()})` },
            { value: "24", label: `${t("calendar.prefs.clock24")} (${sample("h23")})` },
            { value: "12", label: `${t("calendar.prefs.clock12")} (${sample("h12")})` },
          ]}
        />
      </Row>
      <Row title={t("calendar.prefs.weekends")} desc={t("calendar.prefs.weekendsDesc")}>
        <Switch checked={c.weekends} onChange={(e) => set({ weekends: e.target.checked })} aria-label={t("calendar.prefs.weekends")} />
      </Row>
      <Row title={t("calendar.prefs.weekNumbers")} desc={t("calendar.prefs.weekNumbersDesc")}>
        <Switch checked={c.weekNumbers} onChange={(e) => set({ weekNumbers: e.target.checked })} aria-label={t("calendar.prefs.weekNumbers")} />
      </Row>

      <div style={st.sect} className="wc-sect">{t("calendar.prefs.workday")}</div>
      <Row title={t("calendar.prefs.openAt")} desc={t("calendar.prefs.openAtDesc")}>
        <Select aria-label={t("calendar.prefs.openAt")} value={String(c.openAt)} onChange={(e) => set({ openAt: Number(e.target.value) })} options={hours(0, 23)} />
      </Row>
      <Row title={t("calendar.prefs.workHours")} desc={t("calendar.prefs.workHoursDesc")}>
        <Switch checked={c.workHours} onChange={(e) => set({ workHours: e.target.checked })} aria-label={t("calendar.prefs.workHours")} />
      </Row>
      {c.workHours ? (
        <Row title={t("calendar.prefs.workRange")}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Select
              aria-label={t("prefs.from")}
              value={String(c.workStart)}
              onChange={(e) => {
                const start = Number(e.target.value);
                set({ workStart: start, workEnd: Math.max(c.workEnd, start + 1) });
              }}
              options={hours(0, 23)}
            />
            <Icon name="arrow-right" size={14} />
            <Select
              aria-label={t("prefs.to")}
              value={String(c.workEnd)}
              onChange={(e) => {
                const end = Number(e.target.value);
                set({ workEnd: end, workStart: Math.min(c.workStart, end - 1) });
              }}
              options={hours(1, 24)}
            />
          </div>
        </Row>
      ) : null}

      <div style={st.sect} className="wc-sect">{t("calendar.prefs.newEvents")}</div>
      <Row title={t("calendar.prefs.duration")}>
        <Select
          aria-label={t("calendar.prefs.duration")}
          value={String(c.duration)}
          onChange={(e) => set({ duration: Number(e.target.value) })}
          options={DURATIONS.map((d) => ({ value: String(d), label: durationLabel(d) }))}
        />
      </Row>
    </>
  );
}

/** The "Raccourcis clavier" preferences panel: view, rebind, unbind and reset each command. */
function ShortcutsSection({ onNotify }: { onNotify?: (t: Toast) => void }) {
  const { t } = useTranslation();
  const s = useSettings();
  const bindings = s.shortcuts;
  const [capturing, setCapturing] = useState<ShortcutId | null>(null);
  const mac = isMac();

  // Latest-value refs so the capture listener (attached once per capture) always sees fresh state.
  const bindingsRef = useRef(bindings);
  const setRef = useRef(s.set);
  useEffect(() => {
    bindingsRef.current = bindings;
    setRef.current = s.set;
  });

  // While capturing, the next chord replaces the binding. Escape cancels, Backspace/Delete unbinds.
  // A capture-phase listener runs before the preferences' own Escape handler, so cancelling never
  // closes the whole screen.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        setRef.current("shortcuts", { ...bindingsRef.current, [capturing]: "" });
        setCapturing(null);
        return;
      }
      const chord = eventToChord(e);
      if (!chord) return; // lone modifier: keep waiting for the full combination
      setRef.current("shortcuts", { ...bindingsRef.current, [capturing]: chord });
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [capturing]);

  // Map each chord to the commands that use it, to flag duplicates.
  const usedBy: Record<string, ShortcutId[]> = {};
  for (const c of COMMANDS) {
    const ch = bindings[c.id];
    if (ch) (usedBy[ch] ??= []).push(c.id);
  }
  const conflictLabel = (id: ShortcutId): TranslationKey | null => {
    const ch = bindings[id];
    if (!ch) return null;
    const other = (usedBy[ch] ?? []).find((x) => x !== id);
    return other ? COMMANDS.find((c) => c.id === other)!.label : null;
  };

  const resetAll = () => {
    setRef.current("shortcuts", { ...DEFAULT_BINDINGS });
    setCapturing(null);
    onNotify?.({ tone: "info", title: t("prefs.shortcutsReset") });
  };

  return (
    <>
      <h2 style={st.h}>{t("prefs.shortcuts")}</h2>
      <p style={st.sub}>
        {t("shortcut.customizeHint")}
      </p>
      {COMMANDS.map((c) => (
        <ShortcutRow
          key={c.id}
          id={c.id}
          capturing={capturing === c.id}
          chord={bindings[c.id]}
          isDefault={bindings[c.id] === c.defaultChord}
          conflict={conflictLabel(c.id)}
          mac={mac}
          onStart={() => setCapturing((prev) => (prev === c.id ? null : c.id))}
          onReset={() => s.set("shortcuts", { ...bindings, [c.id]: c.defaultChord })}
        />
      ))}
      <div style={{ marginTop: 18 }}>
        <Button variant="secondary" iconLeft="refresh-cw" onClick={resetAll}>
          {t("shortcut.resetAll")}
        </Button>
      </div>
      <h3 style={{ margin: "28px 0 4px", fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" }}>{t("shortcut.inFiles")}</h3>
      <p style={st.sub}>{t("shortcut.inFilesHint")}</p>
      {FILE_KEYS.map((k) => (
        <div key={k.chords.join()} style={rowStyle}>
          <div style={{ flex: 1, minWidth: 0, fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--text-strong)" }}>{t(k.label)}</div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {k.chords.map((c) => (
              <kbd key={c} style={kbdStyle}>
                {formatChord(c, mac, t)}
              </kbd>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

export type PreferencesScreenProps = {
  onClose: () => void;
  onNotify?: (t: Toast) => void;
  /** Every session was just ended: the app returns to the sign-in screen. */
  onSignedOut?: () => void;
  /** Compact (mobile): stack the sub-nav above the panel. */
  compact?: boolean;
  /** Section to open on mount (defaults to appearance). */
  initialTab?: PrefTab;
};

/** Full-screen personal preferences view: appearance, notifications, account security and emojis. */
export function PreferencesScreen({
  onClose,
  onNotify,
  onSignedOut,
  compact = false,
  initialTab = "appearance",
}: PreferencesScreenProps) {
  const s = useSettings();
  const { t } = useTranslation();
  const [tab, setTab] = useState<PrefTab>(initialTab);

  // Escape leaves the preferences, but only when no sub-dialog is open (a dialog handles Escape first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector('[role="dialog"]')) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
      <div style={st.top}>
        {compact ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/brand/ruchoir-mark.png" alt="" style={st.mark} />
        ) : (
          <WordmarkLockup />
        )}
        <span style={st.divider} aria-hidden />
        <h1 style={st.title}>{t("prefs.title")}</h1>
        <Button variant="secondary" iconLeft="arrow-left" onClick={onClose} style={{ flexShrink: 0 }}>
          {compact ? t("common.back") : t("prefs.backToSpace")}
        </Button>
      </div>
      <div style={compact ? { ...st.body, flexDirection: "column" } : st.body}>
        <div
          style={
            compact
              ? { flex: "none", display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 12px", borderBottom: "1px solid var(--border-subtle)" }
              : st.nav
          }
        >
          {NAV.map(([v, l, i]) => (
            <button key={v} style={navItem(v === tab, compact)} onClick={() => setTab(v)}>
              <Icon name={i} size={14} style={{ color: v === tab ? "var(--on-pastel)" : "var(--text-muted)" }} />
              {t(l)}
            </button>
          ))}
        </div>

        <div style={st.scroller}>
          <div style={compact ? { ...st.main, padding: "16px 16px 48px" } : st.main}>
            {tab === "appearance" ? (
              <>
                <h2 style={st.h}>{t("prefs.appearance")}</h2>
                <p style={st.sub}>{t("prefs.appearanceSub")}</p>

                <div style={st.sect} className="wc-sect">{t("language.section")}</div>
                {/*
                  Under its description rather than beside it: the control is wide (a flag, a
                  language named in its own script, a chevron), and squeezed into the right-hand
                  column of a Row it fought the sentence explaining it for the same inches.
                */}
                <div style={{ marginBottom: 4 }}>
                  <div style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--text-strong)" }}>
                    {t("language.title")}
                  </div>
                  <div style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)", margin: "2px 0 10px", maxWidth: 520 }}>
                    {t("language.description")}
                  </div>
                  <LanguagePicker
                    value={s.locale}
                    onChange={(next) => {
                      s.set("locale", next);
                      // Told to the server too, because the server writes: confirmations, password
                      // resets and invitations are the half of the product a browser preference
                      // cannot reach. A blank clears it back to following the browser.
                      // Back to "follow the browser" still means reading in a language: the account
                      // records the one now in force, not a blank, or the profile would go quiet
                      // about something that is plainly true.
                      void updateMyProfile({ locale: next ?? initialLocale() }).catch(() => {
                        // A language that did not reach the account still applies to the interface;
                        // it is not worth an error in the middle of a preferences screen.
                      });
                    }}
                  />
                </div>

                <div style={st.sect} className="wc-sect">{t("prefs.mode")}</div>
                <ModePicker value={s.mode} onChange={(m) => s.set("mode", m)} />
                <div style={st.sect} className="wc-sect">{t("prefs.accent")}</div>
                <AccentPicker value={s.accent} night={s.theme.endsWith("-dark")} onChange={(a) => s.set("accent", a)} />
                <div style={st.sect} className="wc-sect">{t("prefs.font")}</div>
                <FontPicker value={s.font} onChange={(f) => s.set("font", f)} />
                <div style={st.sect} className="wc-sect">{t("prefs.textSize")}</div>
                <TextSizePicker value={s.textSize} onChange={(t) => s.set("textSize", t)} />

                <div style={st.sect} className="wc-sect">{t("prefs.defaultDisplay")}</div>
                <Row title={t("prefs.filesView")} desc={t("prefs.filesViewDesc")}>
                  <Select
                    aria-label={t("prefs.filesViewLabel")}
                    value={s.filesLayout}
                    onChange={(e) => s.set("filesLayout", e.target.value as FilesLayout)}
                    options={[
                      { value: "list", label: t("prefs.table") },
                      { value: "grid", label: t("prefs.cards") },
                    ]}
                  />
                </Row>
                <Row
                  title={t("prefs.rightPanel")}
                  desc={t("prefs.rightPanelDesc")}
                >
                  <Select
                    aria-label={t("prefs.rightPanelLabel")}
                    value={s.defaultPanel}
                    onChange={(e) => s.set("defaultPanel", e.target.value as DefaultPanel)}
                    options={[
                      { value: "members", label: t("conversation.members") },
                      { value: "files", label: t("gsearch.files") },
                      { value: "pinned", label: t("prefs.pinnedShort") },
                      { value: "none", label: t("prefs.none") },
                    ]}
                  />
                </Row>
              </>
            ) : null}

            {tab === "notifications" ? (
              <>
                <h2 style={st.h}>{t("notif.title")}</h2>
                <p style={st.sub}>{t("prefs.notifSub")}</p>
                <DevicePushRow onNotify={onNotify} />
                <BrowserNotificationRow soundOn={s.notif.sound} onNotify={onNotify} />
                <Row title={t("prefs.enableNotif")} desc={t("prefs.enableNotifDesc")}>
                  <Switch checked={s.notif.enabled} onChange={(e) => s.set("notif", { ...s.notif, enabled: e.target.checked })} aria-label={t("prefs.enableNotif")} />
                </Row>
                <Row title={t("prefs.notifSound")} desc={t("prefs.notifSoundDesc")}>
                  <Switch checked={s.notif.sound} onChange={(e) => s.set("notif", { ...s.notif, sound: e.target.checked })} aria-label={t("prefs.notifSound")} />
                </Row>
                <NotificationKinds />
                <Row
                  title={t("prefs.quietHours")}
                  desc={
                    s.notif.quietHours
                      ? t("prefs.quietHoursActive", { window: quietHoursLabel(s.notif) })
                      : t("prefs.quietHoursDesc")
                  }
                >
                  <Switch checked={s.notif.quietHours} onChange={(e) => s.set("notif", { ...s.notif, quietHours: e.target.checked })} aria-label={t("prefs.quietHours")} />
                </Row>
                {s.notif.quietHours ? (
                  <div style={{ display: "flex", gap: 12, padding: "16px 0 4px" }}>
                    <Field label={t("prefs.from")} htmlFor="quiet-from">
                      <Input id="quiet-from" type="time" size="sm" value={s.notif.quietFrom ?? DEFAULT_NOTIF_PREFS.quietFrom} onChange={(e) => s.set("notif", { ...s.notif, quietFrom: e.target.value })} />
                    </Field>
                    <Field label={t("prefs.to")} htmlFor="quiet-to">
                      <Input id="quiet-to" type="time" size="sm" value={s.notif.quietTo ?? DEFAULT_NOTIF_PREFS.quietTo} onChange={(e) => s.set("notif", { ...s.notif, quietTo: e.target.value })} />
                    </Field>
                  </div>
                ) : null}

              </>
            ) : null}

            {tab === "calendar" ? <CalendarSection /> : null}

            {tab === "shortcuts" ? <ShortcutsSection onNotify={onNotify} /> : null}

            {tab === "security" ? (
              <>
                <h2 style={st.h}>{t("prefs.security")}</h2>
                <p style={st.sub}>{t("prefs.securitySub")}</p>
                <Row title={t("prefs.linkWarning")} desc={t("prefs.linkWarningDesc")}>
                  <Switch
                    checked={s.externalLinkWarning}
                    onChange={(e) => s.set("externalLinkWarning", e.target.checked)}
                    aria-label={t("prefs.linkWarning")}
                  />
                </Row>
                <AccountSecuritySection onNotify={onNotify} onSignedOut={onSignedOut} />
              </>
            ) : null}

            {tab === "emojis" ? (
              <>
                <h2 style={st.h}>{t("prefs.emojis")}</h2>
                <p style={st.sub}>{t("prefs.emojisSub")}</p>
                <Row
                  title={
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {t("prefs.animatedEmoji")} <Emoji emoji="🎉" size={18} />
                    </span>
                  }
                  desc={t("prefs.animatedEmojiDesc")}
                >
                  <Switch checked={s.emojiAnimated} onChange={(e) => s.set("emojiAnimated", e.target.checked)} aria-label={t("prefs.animatedEmoji")} />
                </Row>
                {/* Dev-only: simulates the operator NOT installing the pack, to demo the native fallback.
                    In production the pack presence comes from the server, so this toggle has no place there. */}
                {process.env.NODE_ENV !== "production" ? (
                  <Row title={t("prefs.emojiPack")} desc={t("prefs.emojiPackDesc")}>
                    <Switch checked={s.emojiPack} onChange={(e) => s.set("emojiPack", e.target.checked)} aria-label={t("prefs.emojiPack")} />
                  </Row>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
