/**
 * The set of UI states the audit visits. Each state is reached through the dev deep-link
 * (see lib/dev/deeplink.ts): the runner appends `query` to the base URL, so no click-scripting
 * is needed to open a modal or switch view. `waitFor` is an optional selector the runner waits
 * for before probing, to be sure the state has actually rendered.
 *
 * Channel and DM ids come from the mock fixtures (lib/mock/fixtures.ts). Keep them in sync if
 * the seed changes.
 */

/** @typedef {{ id: string, label: string, query: string, waitFor?: string }} AuditState */

/**
 * Appearance cross-product (text size x typeface). The larger text sizes zoom the whole UI
 * (globals.css --ui-zoom), which is where viewport-unit, overlay and popover overflow bugs live;
 * the typefaces swap --font-sans (OpenDyslexic in particular is noticeably wider). We sweep EVERY
 * non-default size and EVERY non-default font across the key layout surfaces below. The m/plex
 * baseline is already covered by the base states, except the click-only popover, whose default-size
 * baseline is added explicitly.
 */
const APPEARANCE_SCREENS = [
  { key: "channel", label: "Canal", query: "stage=app&view=channel&channel=general" },
  { key: "files", label: "Fichiers", query: "stage=app&view=files" },
  { key: "settings", label: "Reglages espace", query: "stage=app&view=settings" },
  { key: "prefs", label: "Preferences", query: "stage=app&view=prefs" },
  { key: "dialog", label: "Dialog", query: "stage=app&modal=newChannel" },
  { key: "login", label: "Connexion", query: "stage=login" },
  {
    key: "notifications",
    label: "Centre de notifications",
    query: "stage=app&view=channel&channel=general&pop=notifications",
    waitFor: ".wc-pop",
  },
];

// Non-default text sizes (m is the baseline). See the appearance setting / deeplink `text` param.
const TEXT_SIZES = [
  { key: "s", label: "texte petit" },
  { key: "l", label: "texte grand" },
  { key: "xl", label: "texte tres grand" },
];

// Non-default typefaces (plex is the baseline). See the appearance setting / deeplink `font` param.
const FONTS = [
  { key: "system", label: "police systeme" },
  { key: "dyslexic", label: "police OpenDyslexic" },
];

/** Carry a screen's optional waitFor selector onto a generated state. */
const withWaitFor = (screen, state) => (screen.waitFor ? { ...state, waitFor: screen.waitFor } : state);

/** @type {AuditState[]} */
const APPEARANCE_STATES = [
  // Default-size popover baseline (every other surface has its m/plex baseline in the base states).
  {
    id: "pop-notifications",
    label: "Centre de notifications",
    query: "stage=app&view=channel&channel=general&pop=notifications",
    waitFor: ".wc-pop",
  },
  // Every text size on every key surface.
  ...APPEARANCE_SCREENS.flatMap((s) =>
    TEXT_SIZES.map((t) =>
      withWaitFor(s, { id: `text-${t.key}-${s.key}`, label: `${s.label} (${t.label})`, query: `${s.query}&text=${t.key}` }),
    ),
  ),
  // Every typeface on every key surface.
  ...APPEARANCE_SCREENS.flatMap((s) =>
    FONTS.map((f) =>
      withWaitFor(s, { id: `font-${f.key}-${s.key}`, label: `${s.label} (${f.label})`, query: `${s.query}&font=${f.key}` }),
    ),
  ),
];

/** @type {AuditState[]} */
export const STATES = [
  // Auth flow (full-screen, centered layouts).
  { id: "login", label: "Connexion", query: "stage=login" },
  { id: "signup", label: "Creation de compte", query: "stage=signup" },
  { id: "mfa", label: "Second facteur", query: "stage=mfa" },
  { id: "forgot", label: "Mot de passe oublie", query: "stage=forgot" },
  { id: "reset", label: "Nouveau mot de passe", query: "stage=reset" },
  { id: "verify", label: "Confirmation d'adresse", query: "stage=verify" },
  { id: "onboarding", label: "Onboarding", query: "stage=onboarding" },

  // Main app shell across its views.
  { id: "channel", label: "Canal (public)", query: "stage=app&view=channel&channel=general" },
  { id: "channel-private", label: "Canal (prive, importe)", query: "stage=app&view=channel&channel=compta" },
  { id: "dm", label: "Message direct", query: "stage=app&view=channel&channel=yanis" },
  { id: "channel-members", label: "Canal + panneau membres", query: "stage=app&view=channel&channel=general&panel=members" },
  { id: "channel-files", label: "Canal + panneau fichiers", query: "stage=app&view=channel&channel=general&panel=files" },
  { id: "files", label: "Fichiers de l'espace", query: "stage=app&view=files" },
  { id: "calendar", label: "Calendrier", query: "stage=app&view=calendar" },

  // Compact-only: the pushed content full-screen (in the desktop shell these render the same as
  // their non-pushed twin, but on narrow viewports they exercise the conversation/content views
  // that the bottom-tab list would otherwise hide). `push=1` sets mobileContent on mount.
  { id: "channel-open", label: "Canal ouvert (compact)", query: "stage=app&view=channel&channel=general&push=1" },
  { id: "dm-open", label: "Message direct ouvert (compact)", query: "stage=app&view=channel&channel=yanis&push=1" },
  { id: "files-open", label: "Fichiers ouvert (compact)", query: "stage=app&view=files&push=1" },
  { id: "calendar-open", label: "Calendrier ouvert (compact)", query: "stage=app&view=calendar&push=1" },
  { id: "settings-open", label: "Reglages ouvert (compact)", query: "stage=app&view=settings&push=1" },
  { id: "settings", label: "Reglages de l'espace", query: "stage=app&view=settings" },
  { id: "prefs", label: "Preferences", query: "stage=app&view=prefs" },
  { id: "prefs-shortcuts", label: "Preferences (raccourcis)", query: "stage=app&view=prefs&prefsTab=shortcuts" },
  { id: "prefs-open", label: "Preferences ouvert (compact)", query: "stage=app&view=prefs&push=1" },
  { id: "threads", label: "Fils", query: "stage=app&view=threads" },
  { id: "mentions", label: "Mentions", query: "stage=app&view=mentions" },
  { id: "saved", label: "Enregistres", query: "stage=app&view=saved" },

  // Modals / overlays (deep-linked open).
  { id: "modal-import", label: "Assistant d'import", query: "stage=app&modal=import" },
  { id: "modal-search", label: "Recherche globale", query: "stage=app&modal=search" },
  { id: "modal-newChannel", label: "Nouveau canal", query: "stage=app&modal=newChannel" },
  { id: "modal-newMessage", label: "Nouveau message", query: "stage=app&modal=newMessage" },
  { id: "modal-invite", label: "Inviter des personnes", query: "stage=app&modal=invite" },
  { id: "modal-newWorkspace", label: "Nouvel espace", query: "stage=app&modal=newWorkspace" },
  { id: "modal-help", label: "Aide", query: "stage=app&modal=help" },
  { id: "modal-switcher", label: "Aller a une conversation", query: "stage=app&modal=switcher" },
  { id: "welcome", label: "Prise en main (premiere ouverture)", query: "stage=app&view=channel&channel=general&welcome=1" },

  // Appearance: every text size and every typeface across the key surfaces (generated above).
  ...APPEARANCE_STATES,
];

/** Filter helper used by the runner: keep states whose id is in the requested list. */
export function filterStates(states, ids) {
  if (!ids || ids.length === 0) return states;
  const wanted = new Set(ids);
  return states.filter((s) => wanted.has(s.id));
}
