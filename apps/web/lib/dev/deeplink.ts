/**
 * Development-only initial-state deep linking.
 *
 * The app is a state machine (auth stage + active view + optional modal), not a set of
 * routes, so there is no URL to jump straight to a given screen. This helper lets tooling
 * (see `tools/responsive-audit`) and manual testing land directly on any UI state through
 * query parameters, for example:
 *
 *   /?stage=login
 *   /?stage=forgot
 *   /?stage=app&view=files
 *   /?stage=app&modal=import
 *   /?stage=app&view=channel&channel=compta&panel=members
 *
 * It is strictly a dev affordance: the static production export is built with
 * `NODE_ENV=production`, where `readDeepLink()` returns `null` and reads nothing. Values are
 * validated against fixed allowlists so an unknown parameter is ignored rather than trusted.
 */

const STAGES = ["login", "signup", "mfa", "forgot", "reset", "verify", "invite", "onboarding", "app"] as const;
const VIEWS = ["channel", "files", "calendar", "settings", "prefs", "threads", "mentions", "saved"] as const;
const PANELS = ["files", "members", "pinned", "search"] as const;
const MODALS = [
  "newChannel",
  "newMessage",
  "invite",
  "newWorkspace",
  "help",
  "search",
  "switcher",
] as const;
const TEXT_SIZES = ["s", "m", "l", "xl"] as const;
const FONTS = ["plex", "system", "dyslexic"] as const;
const POPOVERS = ["notifications"] as const;
const PREF_TABS = ["appearance", "notifications", "shortcuts", "security", "emojis"] as const;

export type DeepLink = {
  stage?: (typeof STAGES)[number];
  view?: (typeof VIEWS)[number];
  channel?: string;
  panel?: (typeof PANELS)[number];
  modal?: (typeof MODALS)[number];
  /** Force a text size (appearance setting) so the audit can exercise the zoomed layout. */
  text?: (typeof TEXT_SIZES)[number];
  /** Force a typeface (appearance setting). */
  font?: (typeof FONTS)[number];
  /** Open a click-only popover on load so the audit can probe it (e.g. the notification center). */
  pop?: (typeof POPOVERS)[number];
  /** Preferences section to open when `view=prefs` (defaults to appearance). */
  prefsTab?: (typeof PREF_TABS)[number];
  /** Show the first-run getting-started checklist (audits hide it by default to keep screens clean). */
  welcome?: boolean;
  /** Compact shell only: push the content view full-screen (instead of showing the list). */
  push?: boolean;
};

/**
 * Parse the current location's query string into a validated {@link DeepLink}, or `null`
 * when disabled (production build) or when no recognised parameter is present.
 */
export function readDeepLink(): DeepLink | null {
  if (process.env.NODE_ENV === "production") return null;
  if (typeof window === "undefined") return null;

  const q = new URLSearchParams(window.location.search);
  const pick = <T extends readonly string[]>(key: string, allow: T): T[number] | undefined => {
    const v = q.get(key);
    return v && (allow as readonly string[]).includes(v) ? (v as T[number]) : undefined;
  };

  const link: DeepLink = {
    stage: pick("stage", STAGES),
    view: pick("view", VIEWS),
    channel: q.get("channel") || undefined,
    panel: pick("panel", PANELS),
    modal: pick("modal", MODALS),
    text: pick("text", TEXT_SIZES),
    font: pick("font", FONTS),
    pop: pick("pop", POPOVERS),
    prefsTab: pick("prefsTab", PREF_TABS),
    welcome: q.get("welcome") === "1" || q.get("welcome") === "true" ? true : undefined,
    push: q.get("push") === "1" || q.get("push") === "true" ? true : undefined,
  };

  return Object.values(link).some((v) => v !== undefined) ? link : null;
}
