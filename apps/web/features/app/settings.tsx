"use client";

import { createContext, type ReactNode, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { DEFAULT_NOTIF_PREFS, type NotifPrefs } from "./notifications";
import { isLocale, type Locale } from "@/lib/i18n/config";
import { initialLocale, startI18n } from "@/lib/i18n";
import { setCurrentLocale } from "@/lib/i18n/current";
import { DEFAULT_BINDINGS, mergeBindings, type Bindings } from "./shortcuts";
import { calendarPrefs, DEFAULT_CALENDAR_PREFS, type CalendarPrefs } from "@/features/calendar/prefs";

/** The accent a theme paints with: one of the design system's pastels. */
export type ThemeAccent = "sky" | "mint" | "violet" | "pink";
export const THEME_ACCENTS: ThemeAccent[] = ["sky", "mint", "violet", "pink"];
function isAccent(value: unknown): value is ThemeAccent {
  return typeof value === "string" && (THEME_ACCENTS as string[]).includes(value);
}

/**
 * Day, night, or whichever the device is set to. Chosen apart from the accent: which colour is
 * yours and how bright the screen should be are two questions, and "automatic" only makes sense for
 * the second.
 */
export type ThemeMode = "day" | "night" | "auto";
export const THEME_MODES: ThemeMode[] = ["day", "night", "auto"];
function isMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as string[]).includes(value);
}

/**
 * What `data-theme` on <html> carries: the accent, then `-dark` by night (see tokens.css). Sky by
 * day is the bare :root.
 */
export type ThemeName = ThemeAccent | `${ThemeAccent}-dark`;

/** The theme to draw for a choice, given whether the device currently asks for a dark screen. */
export function themeFor(accent: ThemeAccent, mode: ThemeMode, systemDark: boolean): ThemeName {
  const dark = mode === "night" || (mode === "auto" && systemDark);
  return dark ? `${accent}-dark` : accent;
}

/**
 * A stored appearance, read back. The current shape is `accent` + `mode`; before it there was one
 * `theme` field, first with the retired palette's names (`ruchui`, `light`, `ruchui-dark`, `dark`)
 * and then briefly with the eight `<accent>[-dark]` names. Either is read for what it meant, by day
 * or by night, rather than falling back to the default: that would turn a dark interface light under
 * somebody who had chosen it dark.
 */
function storedAppearance(parsed: { accent?: unknown; mode?: unknown; theme?: unknown }): {
  accent: ThemeAccent;
  mode: ThemeMode;
} {
  if (isAccent(parsed.accent)) {
    return { accent: parsed.accent, mode: isMode(parsed.mode) ? parsed.mode : DEFAULTS.mode };
  }
  const legacy = typeof parsed.theme === "string" ? parsed.theme : "";
  const [base, suffix] = legacy.split(/-(?=dark$)/);
  const night = suffix === "dark" || legacy === "dark";
  return { accent: isAccent(base) ? base : DEFAULTS.accent, mode: legacy ? (night ? "night" : "day") : DEFAULTS.mode };
}

/** Whether the device asks for a dark screen, as a store React can subscribe to. */
const DARK_QUERY = "(prefers-color-scheme: dark)";
function subscribeToSystemDark(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
function systemDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}
/** No device during the static export's render pass: assume day, which the pre-paint script corrects. */
function serverSystemDark(): boolean {
  return false;
}

/** Interface typeface: the default IBM Plex, the OS system stack, or the dyslexia-friendly OpenDyslexic. */
export type FontChoice = "plex" | "system" | "dyslexic";
export const FONTS: FontChoice[] = ["plex", "system", "dyslexic"];
function isFont(value: unknown): value is FontChoice {
  return typeof value === "string" && (FONTS as string[]).includes(value);
}

/** First-run "getting started" checklist: whether it is dismissed and which steps are done. */
export type WelcomeState = { dismissed: boolean; done: string[] };
export const DEFAULT_WELCOME: WelcomeState = { dismissed: false, done: [] };

/** How the Files screen lists a folder. */
export type FilesLayout = "list" | "grid";
export const FILES_LAYOUTS: FilesLayout[] = ["list", "grid"];
function isFilesLayout(value: unknown): value is FilesLayout {
  return value === "list" || value === "grid";
}

/**
 * Which side panel a conversation opens with, or `none` to open with none.
 *
 * Stored as a string rather than reusing `ChannelPanel` (which uses `null` for "closed") because a
 * setting has to round-trip through JSON, where `null` and "absent" are the same thing.
 */
export type DefaultPanel = "members" | "files" | "pinned" | "none";
export const DEFAULT_PANELS: DefaultPanel[] = ["members", "files", "pinned", "none"];
function isDefaultPanel(value: unknown): value is DefaultPanel {
  return typeof value === "string" && (DEFAULT_PANELS as string[]).includes(value);
}

/**
 * The thread panel's width: what it opens at, and how far the handle may take it.
 *
 * Here rather than in the panel because the stored value is validated against these bounds before
 * the panel exists, and a preference nobody can see the limits of is a preference that outlives
 * them.
 */
export const THREAD_WIDTH_DEFAULT = 420;
export const THREAD_WIDTH_MIN = 320;
export const THREAD_WIDTH_MAX = 720;

/** Text size, applied as a proportional zoom on the whole interface. */
export type TextSize = "s" | "m" | "l" | "xl";
export const TEXT_SIZES: TextSize[] = ["s", "m", "l", "xl"];
function isTextSize(value: unknown): value is TextSize {
  return typeof value === "string" && (TEXT_SIZES as string[]).includes(value);
}

export type Settings = {
  /** The theme's accent, one of four pastels. Default sky. */
  accent: ThemeAccent;
  /** Day, night, or following the device. With the accent, gives data-theme on <html>. Default day. */
  mode: ThemeMode;
  /** Interface typeface, applied as data-font on <html>. Default IBM Plex. */
  font: FontChoice;
  /** Text size, applied as data-text on <html> (proportional interface zoom). Default medium. */
  textSize: TextSize;
  /** How the Files screen opens: as a table or as cards. Default table. */
  filesLayout: FilesLayout;
  /**
   * Which side panel a conversation opens with. Default the member list, which is what the shell
   * opened with before this was configurable.
   */
  defaultPanel: DefaultPanel;
  /** Whether Fluent emoji should animate (when the pack is available). Default on. */
  emojiAnimated: boolean;
  /**
   * Whether the self-hosted Fluent emoji pack is available. In a real deployment this comes from the
   * server (the operator may or may not install the pack); here it is a simulation so the native
   * fallback can be demonstrated. When false, emoji render with the OS-native glyphs.
   */
  emojiPack: boolean;
  /** Global notification preferences (master switch, sound, quiet hours, @channel). */
  notif: NotifPrefs;
  /** How the calendar reads: its first view, week, clock, working day, a new event's length. */
  calendar: CalendarPrefs;
  /** Personal account security (two-factor, passkeys, recovery codes). */
  /** Customizable keyboard shortcut bindings, keyed by command id. */
  shortcuts: Bindings;
  /** First-run getting-started checklist state. */
  welcome: WelcomeState;
  /**
   * The order of the spaces in the rail, by space id.
   *
   * A person's own arrangement, so it lives with the preferences rather than with the space. Ids
   * absent from it keep their server order, after the ones listed: joining a space must not require
   * rewriting this, and leaving one must not disturb the rest.
   */
  spaceOrder: string[];
  /**
   * Direct conversations hidden from the sidebar, by id.
   *
   * Hiding is not leaving and not archiving: the conversation and its history are untouched, it is
   * out of the list until it has something to say again. A new message brings it straight back,
   * which is what stops this from being a way to miss one.
   */
  hiddenDms: string[];
  /**
   * Sidebar sections folded away, by id (`favourites`, `channels`, `messages`). A folded section
   * still shows the open conversation and anything unread, so folding tidies without hiding news.
   */
  collapsedSections: string[];
  /** Whether the browser-notification prompt has already been offered, so it is offered once. */
  notifPrompted: boolean;
  /**
   * Whether to warn before a link opens a page outside Ruchoir (see `ExternalLinkDialog`). On by
   * default; turned off from the warning itself or in Preferences > Security.
   */
  externalLinkWarning: boolean;
  /**
   * How wide the thread panel is, in pixels.
   *
   * Dragged with the handle on its edge, and kept: a reader who widened it to follow a long thread
   * had to widen it again at every single reopening, because the width lived with the component
   * and died with it.
   */
  threadWidth: number;
  /**
   * The interface language.
   *
   * `null` means "whatever the browser asks for", which is what a fresh account gets: guessing is
   * right until someone says otherwise, and a stored value is a choice that must then be honoured
   * on a borrowed machine too.
   */
  locale: Locale | null;
};

type SettingsContextValue = Settings & {
  /** The theme on screen: the accent and the mode, with "automatic" resolved against the device. */
  theme: ThemeName;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
};

const DEFAULTS: Settings = {
  accent: "sky",
  mode: "day",
  font: "plex",
  textSize: "m",
  filesLayout: "list",
  defaultPanel: "members",
  emojiAnimated: true,
  emojiPack: true,
  notif: DEFAULT_NOTIF_PREFS,
  calendar: DEFAULT_CALENDAR_PREFS,
  shortcuts: DEFAULT_BINDINGS,
  welcome: DEFAULT_WELCOME,
  spaceOrder: [],
  hiddenDms: [],
  collapsedSections: [],
  notifPrompted: false,
  externalLinkWarning: true,
  threadWidth: THREAD_WIDTH_DEFAULT,
  locale: null,
};

const SettingsContext = createContext<SettingsContextValue>({
  ...DEFAULTS,
  theme: "sky",
  set: () => {},
});

const STORAGE_KEY = "ruchoir.settings";

/**
 * Read the theme the pre-paint script (see layout.tsx) already applied, so the first render draws the
 * same one. "Automatic" cannot be told apart from a fixed mode at this point; storage settles it a
 * moment later, and both resolve to the theme already on screen.
 */
function initialAppearance(): { accent: ThemeAccent; mode: ThemeMode } {
  if (typeof document !== "undefined") {
    const t = document.documentElement.dataset.theme ?? "";
    const [base, suffix] = t.split(/-(?=dark$)/);
    if (isAccent(base)) return { accent: base, mode: suffix === "dark" ? "night" : "day" };
  }
  return { accent: DEFAULTS.accent, mode: DEFAULTS.mode };
}

/** Keep a stored width usable: a number inside the handle's own bounds, or the default. */
function threadWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return THREAD_WIDTH_DEFAULT;
  return Math.min(THREAD_WIDTH_MAX, Math.max(THREAD_WIDTH_MIN, Math.round(value)));
}

/** A stored array of ids, keeping only the strings: anything else is somebody's corrupted storage. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => ({ ...DEFAULTS, ...initialAppearance() }));
  const deviceDark = useSyncExternalStore(subscribeToSystemDark, systemDark, serverSystemDark);

  // Load persisted settings once on mount (client only).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const { theme: _retired, ...parsed } = JSON.parse(raw);
        // Hydration-safe: the server renders the defaults, then this reconciles from localStorage after
        // mount. Reading storage in the initializer instead would cause a hydration mismatch, so the
        // one-shot setState here is intentional.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSettings({
          ...DEFAULTS,
          ...parsed,
          ...storedAppearance({ ...parsed, theme: _retired }),
          font: isFont(parsed.font) ? parsed.font : DEFAULTS.font,
          textSize: isTextSize(parsed.textSize) ? parsed.textSize : DEFAULTS.textSize,
          filesLayout: isFilesLayout(parsed.filesLayout) ? parsed.filesLayout : DEFAULTS.filesLayout,
          defaultPanel: isDefaultPanel(parsed.defaultPanel) ? parsed.defaultPanel : DEFAULTS.defaultPanel,
          // Deep-merge notif so a stored object missing newer keys still gets their defaults.
          notif: { ...DEFAULT_NOTIF_PREFS, ...(parsed.notif ?? {}) },
          calendar: calendarPrefs(parsed.calendar),
          // Keep only known commands and string bindings; unknown/missing ones fall back to default.
          shortcuts: mergeBindings(parsed.shortcuts),
          locale: isLocale(parsed.locale) ? parsed.locale : null,
          welcome: {
            dismissed: typeof parsed.welcome?.dismissed === "boolean" ? parsed.welcome.dismissed : false,
            done: Array.isArray(parsed.welcome?.done)
              ? parsed.welcome.done.filter((x: unknown) => typeof x === "string")
              : [],
          },
          spaceOrder: stringList(parsed.spaceOrder),
          hiddenDms: stringList(parsed.hiddenDms),
          collapsedSections: stringList(parsed.collapsedSections),
          notifPrompted: parsed.notifPrompted === true,
          externalLinkWarning: parsed.externalLinkWarning !== false,
          threadWidth: threadWidth(parsed.threadWidth),
        });
      }
    } catch {
      // ignore malformed storage
    }
  }, []);

  /**
   * Keep the translation runtime and `<html lang>` on the chosen language.
   *
   * `lang` is not decoration: it tells a screen reader which voice to use, a browser which
   * dictionary to spell-check against, and CSS which hyphenation rules apply. A French interface
   * announced as English is read aloud as gibberish.
   */
  useEffect(() => {
    const locale = settings.locale ?? initialLocale();
    startI18n(locale);
    setCurrentLocale(locale);
    document.documentElement.lang = locale;
  }, [settings.locale]);

  // Reflect the active theme onto <html> so the CSS [data-theme] blocks apply. In automatic mode it
  // follows the device as it changes (a laptop switching to dark at sunset), with no reload.
  const theme = themeFor(settings.accent, settings.mode, deviceDark);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // The browser's own chrome (the status bar of an installed app, the address bar of Android's
    // browser) takes the canvas of the theme in force, so the edge of the screen is not a band of
    // the default's grey above a night theme.
    const canvas = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta && canvas) meta.content = canvas;
  }, [theme]);

  // Reflect the active typeface and text size onto <html> so the CSS [data-font]/[data-text] blocks apply.
  useEffect(() => {
    document.documentElement.dataset.font = settings.font;
    document.documentElement.dataset.text = settings.textSize;
  }, [settings.font, settings.textSize]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore storage failures
      }
      return next;
    });
  };

  return <SettingsContext.Provider value={{ ...settings, theme, set }}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}
