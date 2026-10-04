"use client";

import { type CSSProperties, type ReactNode, useState } from "react";
import { Button, Dialog, Icon, IconButton, Input, Tabs } from "@/components/ds";
import type { Calendar } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import type { Filter } from "./model";
import { colorVar } from "./OccurrenceChip";

/** Beyond this many spaces, the list of the others gets a search field. */
const SEARCH_FROM = 6;

/** Where the column keeps whether "My other spaces" is folded. */
const OTHERS_KEY = "ruchoir.calendar.othersFolded";

type Space = { id: string; name: string };

function byName(a: Space, b: Space): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function matches(space: Space, query: string): boolean {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  return fold(space.name).includes(fold(query.trim()));
}

/**
 * The filter when the screen was opened from a space: that space, or all of them. Two choices
 * whatever the number of spaces; the chosen one wears the accent.
 */
export function ScopeSwitch({ spaceId, filter, onFilter }: { spaceId: string; filter: Filter; onFilter: (filter: Filter) => void }) {
  const { t } = useTranslation();
  return (
    <Tabs
      variant="pills"
      className="wc-tabs--accent"
      items={[
        { value: "space", label: t("calendar.thisSpace") },
        { value: "all", label: t("calendar.allSpaces") },
      ]}
      value={filter.kind === "space" ? "space" : "all"}
      onChange={(v) => onFilter(v === "space" ? { kind: "space", spaceId } : { kind: "all" })}
    />
  );
}

/**
 * The filter when the screen was opened by the phone's tab, with no space to start from: a button
 * naming the choice, opening the list of spaces (searchable once it is long).
 */
export function SpacePicker({ spaces, filter, onFilter }: { spaces: Space[]; filter: Filter; onFilter: (filter: Filter) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = filter.kind === "space" ? spaces.find((s) => s.id === filter.spaceId) : undefined;
  const sorted = [...spaces].sort(byName).filter((s) => matches(s, query));
  const pick = (next: Filter) => {
    onFilter(next);
    setOpen(false);
    setQuery("");
  };
  const option = (key: string, label: string, on: boolean, next: Filter) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={on}
      onClick={() => pick(next)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        minHeight: 40,
        padding: "6px 10px",
        border: "none",
        borderRadius: "var(--radius-sm)",
        background: on ? "var(--acc)" : "transparent",
        color: on ? "var(--on-pastel)" : "var(--text-strong)",
        fontWeight: on ? 700 : 400,
        fontSize: "var(--text-sm)",
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {on ? <Icon name="check" size={14} /> : null}
    </button>
  );
  return (
    <>
      <Button size="sm" iconRight="chevron-down" onClick={() => setOpen(true)} style={{ maxWidth: "100%", minWidth: 0 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{current?.name ?? t("calendar.allSpaces")}</span>
      </Button>
      {open ? (
        <Dialog size="sm" title={t("calendar.filter")} onClose={() => setOpen(false)} closeLabel={t("common.close")}>
          {spaces.length > SEARCH_FROM ? (
            <Input icon="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("calendar.searchSpace")} aria-label={t("calendar.searchSpace")} style={{ marginBottom: 8 }} />
          ) : null}
          <div role="listbox" aria-label={t("calendar.filter")} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {query.trim() ? null : option("all", t("calendar.allSpaces"), filter.kind === "all", { kind: "all" })}
            {sorted.map((s) => option(s.id, s.name, filter.kind === "space" && filter.spaceId === s.id, { kind: "space", spaceId: s.id }))}
            {sorted.length === 0 ? <p style={{ margin: 8, color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{t("calendar.noSpaceFound")}</p> : null}
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

/** The coloured box that shows or hides: filled and ticked when shown, outlined when hidden, a dash
 *  when a space's calendars are partly shown. */
function Swatch({ color, state, label, onClick }: { color: string; state: "on" | "off" | "mixed"; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "mixed" ? "mixed" : state === "on"}
      aria-label={label}
      onClick={onClick}
      style={{
        width: 16,
        height: 16,
        flex: "none",
        borderRadius: 5,
        border: `2px solid ${color}`,
        background: state === "off" ? "transparent" : color,
        color: "var(--on-pastel)",
        padding: 0,
        display: "grid",
        placeItems: "center",
        cursor: "pointer",
      }}
    >
      {state === "on" ? <Icon name="check" size={11} /> : state === "mixed" ? <Icon name="minus" size={11} /> : null}
    </button>
  );
}

const label = (muted: boolean): CSSProperties => ({
  flex: 1,
  minWidth: 0,
  fontSize: "var(--text-sm)",
  color: muted ? "var(--text-muted)" : "var(--text-strong)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const sub: CSSProperties = { display: "block", fontSize: "var(--text-2xs)", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis" };

/**
 * The calendar's column. On a desktop it takes the place of the space's column while the calendar is
 * open, as calendars do: a way back to the space, a small month to jump to a date, then the
 * calendars in three blocks: the viewer's own, the space the screen was opened from (its calendars
 * one by one), and the viewer's other spaces, folded into one line each (a space with several
 * calendars unfolds them), searchable once there are many. Each calendar can be shown or hidden (the
 * choice follows the person from one device to another) and, for whoever may, opened for its
 * settings. On a phone the same list (`variant="sheet"`) fills a panel.
 */
export function CalendarSidebar({
  calendars,
  spaces,
  currentSpaceId,
  onToggle,
  onToggleMany,
  onSettings,
  onNewCalendar,
  footer,
  header,
  variant = "column",
}: {
  calendars: Calendar[];
  spaces: Space[];
  /** The space the screen is on, listed first and in full. */
  currentSpaceId?: string;
  onToggle: (calendar: Calendar) => void;
  /** Show or hide several calendars at once: a folded space's. */
  onToggleMany: (calendars: Calendar[], hidden: boolean) => void;
  onSettings?: (calendar: Calendar) => void;
  onNewCalendar?: (spaceId?: string) => void;
  footer?: ReactNode;
  /** What sits above the list: the way back and the small month. */
  header?: ReactNode;
  variant?: "column" | "sheet";
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const [othersFolded, setOthersFolded] = useState(() => {
    try {
      return localStorage.getItem(OTHERS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const foldOthers = (folded: boolean) => {
    setOthersFolded(folded);
    try {
      localStorage.setItem(OTHERS_KEY, folded ? "1" : "0");
    } catch {
      // No storage: the choice lasts as long as the screen.
    }
  };

  const mine = calendars.filter((c) => !c.spaceId);
  const of = (spaceId: string) => calendars.filter((c) => c.spaceId === spaceId);
  const current = spaces.find((s) => s.id === currentSpaceId && of(s.id).length > 0);
  const others = spaces.filter((s) => s.id !== current?.id && of(s.id).length > 0).sort(byName);
  const shownOthers = others.filter((s) => matches(s, query));

  const settingsButton = (calendar: Calendar) =>
    onSettings ? (
      <IconButton className="wc-calrow__more" icon="more-horizontal" size="sm" label={t("calendar.settingsOf", { name: calendar.name })} onClick={() => onSettings(calendar)} />
    ) : null;

  const calendarRow = (calendar: Calendar, indent = false, subtitle?: string) => (
    <div key={calendar.id} className="wc-calrow" style={indent ? { paddingLeft: 30 } : undefined}>
      <Swatch
        color={colorVar(calendar.color)}
        state={calendar.hidden ? "off" : "on"}
        label={t(calendar.hidden ? "calendar.show" : "calendar.hide", { name: calendar.name })}
        onClick={() => onToggle(calendar)}
      />
      <span style={label(calendar.hidden)}>
        {subtitle ?? calendar.name}
        {subtitle && subtitle !== calendar.name ? <span style={sub}>{calendar.name}</span> : null}
      </span>
      {settingsButton(calendar)}
    </div>
  );

  const heading = (title: ReactNode, action?: ReactNode, extra?: ReactNode) => (
    <div style={{ display: "flex", alignItems: "center", gap: 4, margin: "0 0 2px 6px", minHeight: 28 }}>
      <h3 style={{ flex: 1, minWidth: 0, margin: 0, fontSize: "var(--text-xs)", fontWeight: 700, color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {title}
        {extra}
      </h3>
      {action}
    </div>
  );

  const newIn = (space?: Space) =>
    onNewCalendar ? (
      <IconButton icon="plus" size="sm" label={t("calendar.newCalendarIn", { name: space?.name ?? t("calendar.mine") })} onClick={() => onNewCalendar(space?.id)} />
    ) : null;

  /** A space other than the current one: one line, its calendars behind it when it has several. */
  const spaceRow = (space: Space) => {
    const items = of(space.id);
    if (items.length === 1) return calendarRow(items[0], false, space.name);
    const shown = items.filter((c) => !c.hidden).length;
    const state = shown === items.length ? "on" : shown === 0 ? "off" : "mixed";
    const main = items.find((c) => c.isDefault) ?? items[0];
    const open = unfolded.has(space.id);
    const unfold = () =>
      setUnfolded((set) => {
        const next = new Set(set);
        if (open) next.delete(space.id);
        else next.add(space.id);
        return next;
      });
    return (
      <div key={space.id}>
        <div className="wc-calrow">
          <Swatch
            color={colorVar(main.color)}
            state={state}
            label={t(state === "on" ? "calendar.hide" : "calendar.show", { name: space.name })}
            onClick={() => onToggleMany(items, state === "on")}
          />
          <span style={label(state === "off")}>{space.name}</span>
          <button
            type="button"
            aria-expanded={open}
            onClick={unfold}
            style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 2, border: "none", background: "none", color: "var(--text-muted)", fontSize: "var(--text-2xs)", cursor: "pointer", padding: "2px 4px" }}
          >
            {t("calendar.calendarCount", { count: items.length })}
            <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
          </button>
        </div>
        {open ? (
          <>
            {items.map((c) => calendarRow(c, true))}
            {onNewCalendar && items.some((c) => c.canManage) ? (
              <div style={{ paddingLeft: 24 }}>
                <Button size="sm" variant="ghost" iconLeft="plus" onClick={() => onNewCalendar(space.id)}>
                  {t("calendar.newCalendar")}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    );
  };

  const section: CSSProperties = { marginBottom: "var(--space-3)" };

  return (
    <nav
      aria-label={t("calendar.calendars")}
      style={
        variant === "column"
          ? {
              width: "var(--sidebar-width)",
              flex: "none",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              borderRight: "1.5px solid var(--border-subtle)",
              background: "var(--surface-chrome)",
            }
          : undefined
      }
    >
      {header}
      <div style={variant === "column" ? { flex: 1, minHeight: 0, overflowY: "auto", padding: "var(--space-3) var(--space-2-5)" } : undefined}>
        <section style={section}>
          {heading(t("calendar.mine"), newIn())}
          {mine.map((c) => calendarRow(c))}
        </section>

        {current ? (
          <section style={section}>
            {heading(
              current.name,
              of(current.id).some((c) => c.canManage) ? newIn(current) : null,
              <span style={{ fontWeight: 400, color: "var(--text-muted)" }}> · {t("calendar.thisSpace").toLocaleLowerCase()}</span>,
            )}
            {of(current.id).map((c) => calendarRow(c))}
          </section>
        ) : null}

        {others.length > 0 ? (
          <section style={section}>
            {heading(
              <button
                type="button"
                aria-expanded={!othersFolded}
                onClick={() => foldOthers(!othersFolded)}
                style={{ display: "inline-flex", alignItems: "center", gap: 4, border: "none", background: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer", maxWidth: "100%" }}
              >
                <Icon name={othersFolded ? "chevron-right" : "chevron-down"} size={12} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{current ? t("calendar.otherSpaces") : t("calendar.mySpaces")}</span>
                <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>· {others.length}</span>
              </button>,
            )}
            {othersFolded ? null : (
              <>
                {others.length > SEARCH_FROM ? (
                  <div style={{ padding: "0 6px 6px" }}>
                    <Input size="sm" icon="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("calendar.searchSpace")} aria-label={t("calendar.searchSpace")} />
                  </div>
                ) : null}
                {shownOthers.map(spaceRow)}
                {shownOthers.length === 0 ? <p style={{ margin: "4px 6px", color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>{t("calendar.noSpaceFound")}</p> : null}
              </>
            )}
          </section>
        ) : null}
        {footer}
      </div>
    </nav>
  );
}
