"use client";

import { createContext, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, useContext, useRef, useState } from "react";
import { Avatar, Badge, Icon, IconButton, Input, Popover, Sheet, SheetGroup, SheetItem, Skeleton, SkeletonGroup, Tag, Tooltip, type IconName, type TagTone } from "@/components/ds";
import { haptic } from "@/lib/haptics";
import type { Channel, DirectMessage, Workspace } from "@/lib/data";
import { MenuPopover } from "./MenuPopover";
import { NotificationCenter } from "./NotificationCenter";
import { type AppNotification, type ChannelNotifPref, isMention } from "./notifications";
import type { ImportTicker } from "./importRun";
import type { AppView, Toast } from "./types";
import { Wordmark } from "./Wordmark";
import { useSettings } from "./settings";
import { useDragReorder } from "./useDragReorder";
import { formatChord, isMac } from "./shortcuts";
import { getAvatar } from "@/lib/data";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";

const styles: Record<string, CSSProperties> = {
  side: {
    width: "var(--sidebar-width)",
    flex: "none",
    background: "var(--surface-chrome)",
    borderRight: "1.5px solid var(--border-subtle)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  head: {
    height: "var(--topbar-height)",
    flex: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 8px 0 12px",
    borderBottom: "1.5px solid var(--border-subtle)",
  },
  wsName: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    border: 0,
    background: "none",
    padding: "4px 6px",
    marginLeft: -6,
    borderRadius: "var(--radius-sm)",
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-base)",
    fontWeight: 700,
    letterSpacing: "var(--tracking-tight)",
    color: "var(--text-strong)",
    minWidth: 0,
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  scroll: { flex: 1, overflow: "auto", padding: "8px 10px 16px" },
  empty: {
    margin: "2px 6px 4px",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--leading-snug)",
    color: "var(--text-subtle)",
  },
  sect: {
    fontFamily: "var(--font-mono)",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "18px 6px 6px",
    fontSize: "var(--text-2xs)",
    fontWeight: 500,
    color: "var(--text-muted)",
  },
  name: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
};

/**
 * Rows at a finger's size: 44px tall and a size larger, on a phone. Carried by context rather than
 * threaded through every row, since it is the column's density and not any one row's.
 */
const TouchRows = createContext(false);

function item(on: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    height: 34,
    padding: "0 8px",
    border: 0,
    borderRadius: "var(--radius-sm)",
    background: on ? "var(--acc)" : "transparent",
    // The active row is filled with the theme's pastel, and a pastel always carries the dark ink.
    color: on ? "var(--on-pastel)" : "var(--text-body)",
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    fontWeight: on ? 600 : 400,
    textAlign: "left",
    transition: "background-color var(--duration-fast) var(--ease-out)",
  };
}

/** Icon for a channel row, using the space's persisted default channel. */
function channelIcon(channel: Channel, favouriteSection: boolean, defaultChannelId?: string): IconName {
  if (favouriteSection) return "bookmark";
  if (channel.type === "archived") return "archive";
  if (channel.type === "private") return "lock";
  if (channel.id === defaultChannelId) return "house";
  return "hash";
}

export type SideMenuItem = { icon: string; label: string; onClick: () => void; danger?: boolean };

const menuStyle: CSSProperties = {
  minWidth: 200,
  padding: 4,
  background: "var(--surface-raised)",
  border: "2px solid var(--ink)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-popover)",
};

const menuItemStyle: CSSProperties = {
  display: "flex",
  transition: "background-color var(--duration-fast) var(--ease-out)",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 8px",
  border: 0,
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--text-body)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  textAlign: "left",
  cursor: "pointer",
};

/** How a finished import reads in the sidebar: its own word, in its own colour. */
const ENDED_TONE: Record<string, TagTone> = {
  running: "accent",
  completed: "success",
  failed: "danger",
  cancelled: "warning",
};
const ENDED_LABEL: Record<string, TranslationKey> = {
  completed: key("import.done"),
  failed: key("import.interrupted"),
  cancelled: key("import.stopped"),
};

type SideItemProps = {
  icon?: string;
  label: string;
  active?: boolean;
  unread?: number;
  /** Something unread here names the reader: the count is drawn as a mention, not as activity. */
  mentioned?: boolean;
  muted?: boolean;
  /** Notifications silenced (muted or level "none"): shows a bell-off and dims the unread badge. */
  notifMuted?: boolean;
  tag?: ReactNode;
  onClick?: () => void;
  children?: ReactNode;
  menuItems?: SideMenuItem[];
  /** Present when the row can be moved: dragged, or moved with alt and the arrow keys. */
  reorder?: RowReorder;
};

/** What a movable row needs from the list that owns the order. */
type RowReorder = {
  /** From the section's `useDragReorder`: the row's element, where it is drawn, and its press. */
  ref: (el: HTMLElement | null) => void;
  style: CSSProperties | undefined;
  onPointerDown: (e: ReactPointerEvent) => void;
  /** Alt with an arrow key: one step up (-1) or down (1). */
  onStep: (step: -1 | 1) => void;
};

/**
 * A section's label, and the way to fold it when `onToggle` is given. The label is the button, so the
 * whole word is the target and a screen reader hears "Canaux, développé". The chevron turns with the
 * state; anything else on the line (the `+` of the channels) follows as children.
 */
function SectionHead({ label, collapsed, onToggle, children }: { label: string; collapsed?: boolean; onToggle?: () => void; children?: ReactNode }) {
  return (
    <div style={styles.sect} className="wc-sect">
      {onToggle ? (
        <button type="button" className="wc-sect__toggle" aria-expanded={!collapsed} onClick={onToggle}>
          {label}
          <Icon
            name="chevron-down"
            size={12}
            style={{ transform: collapsed ? "rotate(-90deg)" : undefined, transition: "transform var(--duration-fast) var(--ease-out)" }}
          />
        </button>
      ) : (
        label
      )}
      {children}
    </div>
  );
}

function SideItem({ icon, label, active: activeProp, unread, mentioned, muted, notifMuted, tag, onClick, children, menuItems, reorder }: SideItemProps) {
  const { t } = useTranslation();
  const touch = useContext(TouchRows);
  // On a phone the list is its own screen: the conversation it would mark as open is not on it.
  const active = activeProp && !touch;
  const [hover, setHover] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  // A mention outranks a mute: being named is the one thing silencing a channel is not meant to hide.
  const badgeTone = mentioned ? "mention" : notifMuted ? "neutral" : "accent";
  // Active fill: the theme's pastel, whole, so the open conversation is legible at a glance in the
  // day and the night themes alike.
  const bg = active
    ? "var(--acc)"
    : hover || menuOpen
      ? "var(--surface-hover)"
      : "transparent";
  const showMore = !!menuItems && menuItems.length > 0 && (hover || menuOpen);
  // Press and hold, on a touch screen: the row's actions rise from the bottom, as a message's do.
  // A finger that moves is scrolling, and lets go of the press.
  const [sheetOpen, setSheetOpen] = useState(false);
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  const hasMenu = !!menuItems && menuItems.length > 0;

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="wc-side-item"
        onClick={onClick}
        onPointerDown={(e) => {
          if (e.pointerType !== "touch") {
            reorder?.onPointerDown(e);
            return;
          }
          if (!hasMenu) return;
          cancelPress();
          const timer = window.setTimeout(() => {
            press.current = null;
            haptic("medium");
            setSheetOpen(true);
            // Lifting the finger sends a click where it was: it would open the channel under the sheet.
            const swallow = (ev: MouseEvent) => {
              ev.stopPropagation();
              ev.preventDefault();
            };
            window.addEventListener("click", swallow, { capture: true, once: true });
            window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 700);
          }, 450);
          press.current = { x: e.clientX, y: e.clientY, timer };
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancelPress();
        }}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={touch && hasMenu ? (e) => e.preventDefault() : undefined}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick?.();
          } else if (reorder && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            // Moving is a keyboard gesture too, as it is for the spaces in the rail.
            e.preventDefault();
            reorder.onStep(e.key === "ArrowUp" ? -1 : 1);
          }
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        ref={reorder?.ref}
        style={{
          ...item(!!active),
          ...(touch ? { height: 44, fontSize: "var(--text-base)", gap: 12 } : null),
          background: bg,
          // Pressed and moved with a mouse or a pen, the row follows the pointer and the others make
          // room (a finger's press opens the actions instead, which carry the moves).
          ...reorder?.style,
        }}
      >
        {children ?? <Icon name={icon ?? "hash"} size={14} style={{ color: active ? "var(--on-pastel)" : muted ? "var(--text-subtle)" : "var(--text-muted)" }} />}
        <span
          style={{
            ...styles.name,
            fontWeight: unread ? 500 : undefined,
            // De-emphasise muted (archived) channels with a token, not opacity, so contrast stays measurable.
            color: active ? "var(--on-pastel)" : unread ? "var(--text-strong)" : muted ? "var(--text-subtle)" : undefined,
          }}
        >
          {label}
        </span>
        {tag}
        {notifMuted ? (
          <Icon name="bell-off" size={13} title={t("sidebar.muted")} style={{ flex: "none", color: "var(--text-subtle)" }} />
        ) : null}
        {menuItems && menuItems.length > 0 ? (
          // Fixed-width slot: the more-button is always mounted (opacity toggled) so the popover anchor
          // never moves as hover changes, and the unread badge shows underneath when it is hidden.
          <span style={{ position: "relative", flex: "none", minWidth: 24, height: 20, display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
            {!showMore && unread ? <Badge count={unread} tone={badgeTone} /> : null}
            <IconButton
              ref={moreRef}
              icon="more-horizontal"
              label={t("sidebar.actionsFor", { name: label })}
              size="sm"
              tabIndex={showMore ? 0 : -1}
              aria-hidden={!showMore}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((o) => !o);
              }}
              style={{
                position: "absolute",
                right: 0,
                opacity: showMore ? 1 : 0,
                pointerEvents: showMore ? "auto" : "none",
                transition: "opacity var(--duration-fast) var(--ease-out)",
              }}
            />
            <Popover anchorRef={moreRef} open={menuOpen} onClose={() => setMenuOpen(false)} placement="bottom" align="end">
              <div style={menuStyle} role="menu" onClick={(e) => e.stopPropagation()}>
                {menuItems.map((mi) => (
                  <button
                    key={mi.label}
                    type="button"
                    role="menuitem"
                    onClick={(e) => {
                      e.stopPropagation();
                      mi.onClick();
                      setMenuOpen(false);
                    }}
                    style={{ ...menuItemStyle, color: mi.danger ? "var(--status-danger-fg)" : "var(--text-body)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <Icon name={mi.icon} size={14} />
                    {mi.label}
                  </button>
                ))}
              </div>
            </Popover>
          </span>
        ) : unread ? (
          <Badge count={unread} tone={badgeTone} />
        ) : null}
      </div>
      {hasMenu && sheetOpen ? (
        <Sheet label={label} heading onClose={() => setSheetOpen(false)}>
          <SheetGroup>
            {menuItems.map((mi) => (
              <SheetItem
                key={mi.label}
                icon={mi.icon as IconName}
                label={mi.label}
                danger={mi.danger}
                onClick={() => {
                  setSheetOpen(false);
                  mi.onClick();
                }}
              />
            ))}
          </SheetGroup>
        </Sheet>
      ) : null}
    </>
  );
}

export type SidebarProps = {
  workspace: Workspace | undefined;
  channels: Channel[];
  directMessages: DirectMessage[];
  /** Take a direct conversation out of the list until it has a new message. */
  onHideDm: (id: string) => void;
  view: AppView;
  channel: string;
  mentionCount: number;
  /** Per-conversation notification preferences, keyed by channel/DM id. */
  channelPrefs: Record<string, ChannelNotifPref>;
  /** Notifications already filtered by the channel and global preferences. */
  notifications: AppNotification[];
  /** Unread count among the visible notifications (drives the bell badge). */
  notifUnread: number;
  onView: (view: AppView) => void;
  onChannel: (id: string) => void;
  onNotify: (toast: Toast) => void;
  onInvite: () => void;
  onNewChannel: () => void;
  /**
   * Whether the caller reaches the space at large: its files, a new channel, an invitation. False
   * for a guest, who is in the space only through the conversations they were added to. The API
   * refuses all three either way; this keeps the column from offering them.
   */
  canBrowseSpace: boolean;
  /**
   * Whether the caller administers the space: its name, its icon, its people. False below the
   * administrator rung, and the settings entry is then not offered at all. The screen behind it
   * holds nothing else they could act on, and leaving the space is on this menu already, so showing
   * it was a door that opened onto somebody else's job.
   */
  canAdministerSpace: boolean;
  /**
   * Whether bringing a workspace over is offered. Anyone signed in may: an import by somebody who
   * does not administer the instance only creates spaces of their own (the server scopes it).
   */
  canImport: boolean;
  /**
   * The import going on right now, when there is one.
   *
   * An import outlives the screen that started it, so while it runs its state belongs somewhere
   * always in sight. Null when nothing is happening, which is nearly always.
   */
  importRun?: ImportTicker | null;
  /** Open the screen that brings a workspace over from another product. */
  onImport: () => void;
  onNewMessage: () => void;
  /** Pin or unpin a channel in the caller's own sidebar. */
  onToggleFavorite: (id: string) => void;
  /** Make an eligible public channel the arrival point for new members. */
  onSetDefaultChannel: (id: string) => void;
  /**
   * Put the space's channels in a new order, the same for everybody in it. Given only to the space's
   * administrators: without it the rows do not move.
   */
  onReorderChannels?: (orderedIds: string[]) => void;
  onGlobalSearch: () => void;
  onLeaveChannel: (id: string) => void;
  /** Rejoin a public channel the user had left (the menu offers one or the other, never both). */
  onJoinChannel: (id: string) => void;
  onChannelSettings: (id: string) => void;
  onChannelNotifications: (id: string) => void;
  onMarkRead: (id: string) => void;
  onOpenNotification: (channelId: string, messageId: string, id: string) => void;
  onToggleNotifRead: (id: string, read: boolean) => void;
  onMarkAllNotifsRead: () => void;
  onOpenNotifPrefs: () => void;
  /**
   * Leave the space on screen. This menu sits under the space's name, so its last entry acts on the
   * space: it used to be "sign out", which ended the whole session from a menu about one space.
   */
  onLeaveSpace: () => void;
  /** Open the space's own notification level. */
  onSpaceNotifications: () => void;
  /**
   * A space is being entered: its channels and conversations are not known yet, so placeholders
   * stand for them rather than the lists of the space being left.
   */
  loading?: boolean;
  /** Compact (mobile) mode: full width, no wordmark/header/search (the mobile top bar owns those). */
  compact?: boolean;
  /** Drawn at the top of the scrolling list, above the channels: the phone's search and shortcuts. */
  lead?: ReactNode;
  /**
   * The column stands without the rail (a tablet): the space's icon, which opens the space switcher,
   * leads the header, and the signed-in person's avatar ends it, in place of the wordmark bar.
   */
  railless?: { onSwitchSpace: () => void; you: ReactNode };
  /** Render only one section, for the compact bottom-tab panels. Omit for the full desktop column. */
  only?: "channels" | "messages" | "activity";
  /** Dev/audit only: open the notification center on mount so the popover can be probed under zoom. */
  openNotifications?: boolean;
};

/** Placeholder rows at the size of sidebar rows, while a space's lists load. */
function SideSkeleton({ widths, round = false, label }: { widths: number[]; round?: boolean; label?: string }) {
  const rows = widths.map((width, i) => (
    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, height: 32, padding: "0 8px" }}>
      <Skeleton circle={round} width={round ? 20 : 14} height={round ? 20 : 14} />
      <Skeleton width={`${width * 100}%`} height={10} />
    </div>
  ));
  // Announced once for the whole column: the second group is only drawn.
  return label ? <SkeletonGroup label={label}>{rows}</SkeletonGroup> : <div className="wc-skel-group">{rows}</div>;
}

/** Channel/DM navigation column for the active workspace. */
export function Sidebar({
  workspace,
  channels,
  directMessages,
  onHideDm,
  view,
  channel,
  mentionCount,
  channelPrefs,
  notifications,
  notifUnread,
  onView,
  onChannel,
  onNotify,
  onInvite,
  onNewChannel,
  canBrowseSpace,
  canAdministerSpace,
  canImport,
  importRun,
  onImport,
  onNewMessage,
  onToggleFavorite,
  onSetDefaultChannel,
  onReorderChannels,
  onGlobalSearch,
  onLeaveChannel,
  onJoinChannel,
  onChannelSettings,
  onChannelNotifications,
  onMarkRead,
  onOpenNotification,
  onToggleNotifRead,
  onMarkAllNotifsRead,
  onOpenNotifPrefs,
  onLeaveSpace,
  onSpaceNotifications,
  loading = false,
  compact = false,
  lead,
  railless,
  only,
  openNotifications = false,
}: SidebarProps) {
  const { t } = useTranslation();
  const showActivity = !only || only === "activity";
  const showChannels = !only || only === "channels";
  const showMessages = !only || only === "messages";
  const showFooter = !only || only === "channels";
  /**
   * Folding, on the desktop column only (a bottom-tab panel is one section already). A folded section
   * keeps the open conversation and anything unread in view.
   */
  const settings = useSettings();
  const foldable = !compact && !only;
  const isFolded = (id: string) => foldable && settings.collapsedSections.includes(id);
  const toggleFold = (id: string) =>
    settings.set(
      "collapsedSections",
      settings.collapsedSections.includes(id)
        ? settings.collapsedSections.filter((x) => x !== id)
        : [...settings.collapsedSections, id],
    );
  /** Channels holding an unread mention of the reader, from the notification inbox. */
  const mentionedIn = new Set(notifications.filter((n) => !n.read && isMention(n.kind)).map((n) => n.channelId));
  const stays = (id: string, unread?: number) => (view === "channel" && channel === id) || (unread ?? 0) > 0;
  /**
   * The space's order with `id` moved next to `target`. The order is one list for the whole space;
   * the favourites and the rest are two views of it, so a move is made in the whole list.
   */
  const moved = (id: string, target: string, where: "before" | "after"): string[] | null => {
    if (id === target) return null;
    const ids = channels.map((c) => c.id).filter((x) => x !== id);
    const at = ids.indexOf(target);
    if (at === -1) return null;
    ids.splice(where === "before" ? at : at + 1, 0, id);
    return ids.join() === channels.map((c) => c.id).join() ? null : ids;
  };
  /** One step within the section the channel is shown in, which is the neighbour the reader sees. */
  const stepped = (channel: Channel, step: -1 | 1): string[] | null => {
    const section = channels.filter((c) => c.fav === channel.fav);
    const neighbour = section[section.findIndex((c) => c.id === channel.id) + step];
    return neighbour ? moved(channel.id, neighbour.id, step === -1 ? "before" : "after") : null;
  };
  // The two sections as drawn, each dragged within itself: a favourite lands among the favourites.
  const favRows = channels.filter((c) => c.fav && (!isFolded("favourites") || stays(c.id, c.unread)));
  const channelRows = channels.filter((c) => !c.fav && (!isFolded("channels") || stays(c.id, c.unread)));
  const dragWithin = (rows: Channel[]) => (from: number, to: number) => {
    const next = moved(rows[from].id, rows[to].id, to > from ? "after" : "before");
    if (next) onReorderChannels?.(next);
  };
  const favDrag = useDragReorder({ count: favRows.length, onMove: dragWithin(favRows) });
  const channelDrag = useDragReorder({ count: channelRows.length, onMove: dragWithin(channelRows) });
  const reorderFor = (channel: Channel, index: number): RowReorder | undefined => {
    if (!onReorderChannels) return undefined;
    const drag = channel.fav ? favDrag : channelDrag;
    return {
      ref: drag.itemRef(index),
      style: drag.itemStyle(index),
      onPointerDown: drag.onPointerDown(index),
      onStep: (step) => {
        const next = stepped(channel, step);
        if (next) onReorderChannels(next);
      },
    };
  };
  const channelMenu = (channel: Channel): SideMenuItem[] => [
    {
      icon: channel.fav ? "star-off" : "star",
      label: channel.fav ? t("sidebar.unfavourite") : t("sidebar.favourite"),
      onClick: () => onToggleFavorite(channel.id),
    },
    { icon: "check-check", label: t("sidebar.markRead"), onClick: () => onMarkRead(channel.id) },
    { icon: "bell", label: t("notif.title"), onClick: () => onChannelNotifications(channel.id) },
    { icon: "settings", label: t("sidebar.channelSettings"), onClick: () => onChannelSettings(channel.id) },
    ...(canAdministerSpace
      && channel.id !== workspace?.defaultChannelId
      && channel.type === "public"
      && !channel.allowedRoles?.length
      ? [{ icon: "house", label: t("sidebar.setDefaultChannel"), onClick: () => onSetDefaultChannel(channel.id) }]
      : []),
    // The pointer-free way to arrange the space, and the only one on a touch screen.
    ...(onReorderChannels && stepped(channel, -1)
      ? [{ icon: "arrow-up", label: t("sidebar.moveUp"), onClick: () => onReorderChannels(stepped(channel, -1) ?? []) }]
      : []),
    ...(onReorderChannels && stepped(channel, 1)
      ? [{ icon: "arrow-down", label: t("sidebar.moveDown"), onClick: () => onReorderChannels(stepped(channel, 1) ?? []) }]
      : []),
    // A public channel stays readable after leaving it, so the entry flips to rejoining rather than
    // disappearing: leaving is not a one-way door.
    channel.member === false
      ? { icon: "user-plus", label: t("sidebar.joinChannel"), onClick: () => onJoinChannel(channel.id) }
      : { icon: "log-out", label: t("sidebar.leaveChannel"), danger: true, onClick: () => onLeaveChannel(channel.id) },
  ];
  const dmMenu = (id: string, name: string): SideMenuItem[] => [
    { icon: "check-check", label: t("sidebar.markRead"), onClick: () => onMarkRead(id) },
    { icon: "bell", label: t("notif.title"), onClick: () => onChannelNotifications(id) },
    // Hiding used to be a toast and nothing else. It now takes the conversation out of the list
    // until it has something to say again; the history is untouched and a new message brings it
    // back, which is what keeps this from being a way to miss one.
    {
      icon: "x",
      label: t("sidebar.hideConversation"),
      onClick: () => {
        onHideDm(id);
        onNotify({
          tone: "info",
          title: t("sidebar.hidden"),
          description: t("sidebar.hiddenHint", { name }),
        });
      },
    },
  ];
  const notifMutedFor = (id: string): boolean => {
    const p = channelPrefs[id];
    return !!p && (p.muted || p.level === "none");
  };
  const [wsMenu, setWsMenu] = useState(false);
  const wsRef = useRef<HTMLButtonElement>(null);
  const [notifClicked, setNotifClicked] = useState(false);
  // Derive the open state from the user toggle OR the dev/audit deep-link flag (which arrives post-mount
  // as a prop). Deriving avoids a set-state-in-effect and any server/first-client render divergence.
  const notifOpen = notifClicked || openNotifications;
  const setNotifOpen = setNotifClicked;
  const bellRef = useRef<HTMLButtonElement>(null);

  return (
    <nav
      aria-label={t("sidebar.channelsAndMessages")}
      // On a phone the list is the screen itself: the canvas, like its header, not a column's white.
      style={{
        ...styles.side,
        width: compact ? "100%" : styles.side.width,
        flex: compact ? 1 : styles.side.flex,
        ...(compact ? { background: "var(--surface-canvas)", borderRight: 0 } : null),
      }}
    >
      {!compact ? (
        <>
          {railless ? null : <Wordmark />}
          <div style={railless ? { ...styles.head, gap: 8, padding: "0 8px 0 10px" } : styles.head}>
            {railless ? (
              <button
                type="button"
                className="wc-rail-space"
                onClick={railless.onSwitchSpace}
                aria-label={t("shell.workspaces")}
                style={{ flex: "none", display: "flex", border: 0, padding: 0, background: "none", cursor: "pointer" }}
              >
                <Avatar name={workspace?.name ?? ""} src={workspace?.iconUrl} kind="workspace" size={30} />
              </button>
            ) : null}
            <button
              ref={wsRef}
              style={styles.wsName}
              onClick={() => setWsMenu((o) => !o)}
              aria-expanded={wsMenu}
              // The visible label is the workspace name; give the control a stable accessible name so
              // it is announced even before a workspace has loaded (empty name).
              aria-label={workspace?.name ? t("sidebar.spaceSwitchNamed", { name: workspace.name }) : t("sidebar.spaceSwitch")}
            >
              {/* A long name ends in an ellipsis and keeps its chevron; the menu opened here says it whole. */}
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{workspace?.name}</span>
              <Icon name="chevron-down" size={14} style={{ flex: "none" }} />
            </button>
            <MenuPopover
              anchorRef={wsRef}
              open={wsMenu}
              onClose={() => setWsMenu(false)}
              items={[
                { type: "label", label: workspace?.name ?? t("sidebar.space") },
                // Inviting is administration, not browsing: the endpoint that issues an invitation
                // takes an administrator, so a plain member was being offered a dialog that could
                // only end in a refusal.
                ...(canAdministerSpace
                  ? [{ icon: "user-plus", label: t("sidebar.invitePeople"), onClick: onInvite }]
                  : []),
                ...(canAdministerSpace
                  ? [{ icon: "settings", label: t("sidebar.spaceSettings"), onClick: () => onView("settings") }]
                  : []),
                ...(canBrowseSpace
                  ? [{ icon: "hard-drive", label: t("sidebar.spaceFiles"), onClick: () => onView("files") }]
                  : []),
                { icon: "bell", label: t("notif.spaceNotifications"), onClick: onSpaceNotifications },
                { type: "separator" },
                { icon: "log-out", label: t("space.leave"), danger: true, onClick: onLeaveSpace },
              ]}
            />
            <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <span style={{ position: "relative", display: "flex" }}>
                <Tooltip label={t("notif.title")} disabled={notifOpen}>
                  <IconButton
                    ref={bellRef}
                    icon="bell"
                    label={t("notif.title")}
                    size="sm"
                    aria-expanded={notifOpen}
                    onClick={() => setNotifOpen((o) => !o)}
                  />
                </Tooltip>
                {notifUnread > 0 ? (
                  <span style={{ position: "absolute", top: -3, right: -3, pointerEvents: "none" }}>
                    <Badge count={notifUnread} />
                  </span>
                ) : null}
              </span>
              <Tooltip label={t("shell.newMessage")}>
                <IconButton icon="square-pen" label={t("shell.newMessage")} size="sm" onClick={onNewMessage} />
              </Tooltip>
              {railless?.you}
            </span>
            <NotificationCenter
              anchorRef={bellRef}
              open={notifOpen}
              onClose={() => setNotifOpen(false)}
              notifications={notifications}
              onOpen={(channelId, messageId, id) => {
                setNotifOpen(false);
                onOpenNotification(channelId, messageId, id);
              }}
              onToggleRead={onToggleNotifRead}
              onMarkAllRead={onMarkAllNotifsRead}
              onOpenPrefs={() => {
                setNotifOpen(false);
                onOpenNotifPrefs();
              }}
            />
          </div>
          <div style={{ padding: "8px 8px 0" }}>
            <Input
              size="sm"
              icon="search"
              placeholder={t("sidebar.searchPlaceholder")}
              readOnly
              onClick={onGlobalSearch}
              // The shortcut, as a key cap: the field is a door to the search dialog, and this says
              // how to open it without reaching for the mouse. Follows a rebinding.
              suffix={settings.shortcuts.search ? <kbd className="wc-kbd">{formatChord(settings.shortcuts.search, isMac(), t)}</kbd> : undefined}
            />
          </div>
        </>
      ) : null}
      <div style={compact ? { ...styles.scroll, padding: "0 0 96px" } : styles.scroll}>
        {lead}
        <TouchRows.Provider value={compact}>
        <div style={compact ? { padding: "0 8px" } : undefined}>
        {showActivity ? (
          <>
            <SideItem icon="inbox" label={t("sidebar.threads")} active={view === "threads"} onClick={() => onView("threads")} />
            <SideItem icon="at-sign" label={t("activity.mentions")} active={view === "mentions"} unread={mentionCount} mentioned onClick={() => onView("mentions")} />
            {canBrowseSpace ? (
              <SideItem icon="hard-drive" label={t("sidebar.spaceFiles")} active={view === "files"} onClick={() => onView("files")} />
            ) : null}
            <SideItem icon="calendar" label={t("calendar.title")} active={view === "calendar"} onClick={() => onView("calendar")} />
            <SideItem icon="bookmark" label={t("activity.saved")} active={view === "saved"} onClick={() => onView("saved")} />
          </>
        ) : null}

        {showChannels && loading ? (
          <>
            <div style={styles.sect} className="wc-sect">{t("tabs.channels")}</div>
            <SideSkeleton widths={[0.55, 0.4, 0.62, 0.35, 0.48]} label={t("common.loading")} />
          </>
        ) : showChannels ? (
          <>
            <SectionHead
              label={t("sidebar.favourites")}
              collapsed={isFolded("favourites")}
              onToggle={foldable ? () => toggleFold("favourites") : undefined}
            />
            {channels.every((c) => !c.fav) && !isFolded("favourites") ? (
              // Says how to fill it, since there is no button that could: a favourite is set on the
              // channel itself, from its own menu. One line, so an empty section stays small.
              <p style={styles.empty}>{compact ? t("sidebar.favouriteHintTouch") : t("sidebar.favouriteHintShort")}</p>
            ) : null}
            {favRows.map((c, index) => (
                <SideItem
                  key={c.id}
                  label={c.name}
                  unread={c.unread}
                  mentioned={mentionedIn.has(c.id)}
                  notifMuted={notifMutedFor(c.id)}
                  active={view === "channel" && channel === c.id}
                  onClick={() => onChannel(c.id)}
                  menuItems={channelMenu(c)}
                  reorder={reorderFor(c, index)}
                >
                  <Icon
                    name={channelIcon(c, true, workspace?.defaultChannelId)}
                    size={13}
                    title={c.type === "private" ? t("sidebar.privateChannel") : undefined}
                    style={{ color: "var(--text-muted)" }}
                  />
                </SideItem>
              ))}

            <SectionHead
              label={t("tabs.channels")}
              collapsed={isFolded("channels")}
              onToggle={foldable ? () => toggleFold("channels") : undefined}
            >
              {canBrowseSpace ? (
                <button
                  onClick={onNewChannel}
                  aria-label={t("sidebar.newChannel")}
                  style={{ border: 0, background: "none", padding: 0, marginLeft: "auto", cursor: "pointer", color: "var(--text-subtle)", display: "flex" }}
                >
                  <Icon name="plus" size={13} />
                </button>
              ) : null}
            </SectionHead>
            {channels.every((c) => c.fav) && !isFolded("channels") ? (
              // Favouriting the only channel of a space emptied this section, which then read as a
              // space with no channels at all. What is true is said instead, and the two cases are
              // not the same sentence.
              <p style={styles.empty}>
                {channels.length > 0
                  ? t("sidebar.allFavourites")
                  : canBrowseSpace
                    ? t("sidebar.noChannel")
                    : // A guest has no `+`, so telling them to press it would be the third sentence
                      // in this column that describes somebody else's product.
                      t("sidebar.noChannelYet")}
              </p>
            ) : null}
            {channelRows.map((c, index) => (
                <SideItem
                  key={c.id}
                  label={c.name}
                  unread={c.unread}
                  mentioned={mentionedIn.has(c.id)}
                  muted={c.type === "archived"}
                  notifMuted={notifMutedFor(c.id)}
                  active={view === "channel" && channel === c.id}
                  onClick={() => onChannel(c.id)}
                  menuItems={channelMenu(c)}
                  reorder={reorderFor(c, index)}
                >
                  <Icon
                    name={channelIcon(c, false, workspace?.defaultChannelId)}
                    size={13}
                    title={c.type === "archived" ? t("sidebar.archivedChannel") : c.type === "private" ? t("sidebar.privateChannel") : undefined}
                    style={{ color: "var(--text-muted)" }}
                  />
                </SideItem>
              ))}
          </>
        ) : null}

        {showMessages && loading ? (
          <>
            <div style={styles.sect} className="wc-sect">{t("sidebar.directMessages")}</div>
            <SideSkeleton widths={[0.5, 0.42, 0.58]} round />
          </>
        ) : showMessages ? (
          <>
            <SectionHead
              label={t("sidebar.directMessages")}
              collapsed={isFolded("messages")}
              onToggle={foldable ? () => toggleFold("messages") : undefined}
            />
            {directMessages.length === 0 && !isFolded("messages") ? (
              <SideItem icon="square-pen" label={t("sidebar.startConversation")} onClick={onNewMessage} />
            ) : null}
            {directMessages.filter((d) => !isFolded("messages") || stays(d.id, d.unread)).map((d) => (
              <SideItem
                key={d.id}
                label={d.name}
                unread={d.unread}
                notifMuted={notifMutedFor(d.id)}
                active={view === "channel" && channel === d.id}
                tag={d.bot ? <Tag>{t("sidebar.bot")}</Tag> : undefined}
                onClick={() => onChannel(d.id)}
                menuItems={dmMenu(d.id, d.name)}
              >
                <Avatar name={d.name} src={getAvatar(d.name)} size={20} presence={d.presence} kind={d.bot ? "bot" : "person"} shape={d.bot ? "round" : "square"} />
              </SideItem>
            ))}
          </>
        ) : null}

        {showFooter && (canAdministerSpace || canImport) ? (
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border-subtle)" }}>
            {canAdministerSpace ? (
              <SideItem icon="settings" label={t("sidebar.spaceSettings")} active={view === "settings"} onClick={() => onView("settings")} />
            ) : null}
            {/* Last, and below the rule: it is done once, by one person, and then never again. */}
            {canImport ? (
              <>
                <SideItem
                  icon="import"
                  label={t(key("import.screenTitle"))}
                  active={view === "import"}
                  onClick={onImport}
                  tag={
                    importRun ? (
                      <Tag tone={ENDED_TONE[importRun.running ? "running" : importRun.job.status] ?? "warning"}>
                        {!importRun.running
                          ? t(ENDED_LABEL[importRun.job.status] ?? key("import.stopped"))
                          : importRun.share === null
                            ? t(key("import.reading"))
                            : t(key("import.percent"), { value: importRun.share })}
                      </Tag>
                    ) : undefined
                  }
                />
                {/* The bar is the same one the import screen shows, thinned down: the same shape for
                    the same thing, so the entry reads as that run rather than as a second reading of
                    it. The tag above already says it in words, which is what a reader hears. */}
                {importRun?.running ? (
                  <div
                    className={`wc-imp-bar wc-imp-bar--thin${importRun.share === null ? " wc-imp-bar--waiting" : ""}`}
                    aria-hidden
                  >
                    <span style={{ width: `${importRun.share ?? 0}%` }} />
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        </div>
        </TouchRows.Provider>
      </div>
    </nav>
  );
}
