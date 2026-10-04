"use client";

import type { CSSProperties, ReactNode } from "react";
import { Icon, IconButton } from "@/components/ds";
import type { Calendar } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import type { Filter } from "./model";
import { colorVar } from "./OccurrenceChip";

const pill = (on: boolean): CSSProperties => ({
  flex: "none",
  border: `1px solid ${on ? "var(--action-primary-bg)" : "var(--border-default)"}`,
  background: on ? "var(--action-primary-bg)" : "var(--surface-card)",
  color: on ? "var(--action-primary-fg)" : "var(--text-strong)",
  borderRadius: 999,
  padding: "3px 11px",
  fontSize: "var(--text-xs)",
  cursor: "pointer",
  whiteSpace: "nowrap",
});

/** "All my spaces", then one chip per space with a calendar: which ones are drawn in full. */
export function FilterChips({
  spaces,
  filter,
  onFilter,
}: {
  spaces: { id: string; name: string }[];
  filter: Filter;
  onFilter: (filter: Filter) => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t("calendar.filter")} style={{ display: "flex", gap: 6, overflowX: "auto", scrollbarWidth: "none", minWidth: 0 }}>
      <button type="button" aria-pressed={filter.kind === "all"} style={pill(filter.kind === "all")} onClick={() => onFilter({ kind: "all" })}>
        {t("calendar.allSpaces")}
      </button>
      {spaces.map((space) => {
        const on = filter.kind === "space" && filter.spaceId === space.id;
        return (
          <button key={space.id} type="button" aria-pressed={on} style={pill(on)} onClick={() => onFilter({ kind: "space", spaceId: space.id })}>
            {space.name}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The calendar's column. On a desktop it takes the place of the space's column while the calendar is
 * open, as calendars do: a way back to the space, a small month to jump to a date, then the
 * calendars, grouped (the viewer's own, then each space's). Each one can be shown or hidden (the
 * choice follows the person from one device to another) and, for whoever may, opened for its
 * settings. On a phone the same list (`variant="sheet"`, with neither) fills a panel.
 */
export function CalendarSidebar({
  calendars,
  spaces,
  onToggle,
  onSettings,
  onNewCalendar,
  footer,
  header,
  variant = "column",
}: {
  calendars: Calendar[];
  spaces: { id: string; name: string }[];
  onToggle: (calendar: Calendar) => void;
  onSettings?: (calendar: Calendar) => void;
  onNewCalendar?: (spaceId?: string) => void;
  footer?: ReactNode;
  /** What sits above the list: the way back and the small month. */
  header?: ReactNode;
  variant?: "column" | "sheet";
}) {
  const { t } = useTranslation();
  const groups: { key: string; title: string; spaceId?: string; items: Calendar[] }[] = [
    { key: "me", title: t("calendar.mine"), items: calendars.filter((c) => !c.spaceId) },
    ...spaces
      .map((space) => ({ key: space.id, title: space.name, spaceId: space.id, items: calendars.filter((c) => c.spaceId === space.id) }))
      .filter((g) => g.items.length > 0),
  ];
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
      {groups.map((group) => (
        <section key={group.key} style={{ marginBottom: "var(--space-3)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, margin: "0 0 4px 6px" }}>
            <h3 style={{ flex: 1, margin: 0, fontSize: "var(--text-2xs)", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {group.title}
            </h3>
            {onNewCalendar && (group.key === "me" || group.items.some((c) => c.canManage)) ? (
              <IconButton icon="plus" size="sm" label={t("calendar.newCalendarIn", { name: group.title })} onClick={() => onNewCalendar(group.spaceId)} />
            ) : null}
          </div>
          {group.items.map((calendar) => (
            <div key={calendar.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 6px", borderRadius: "var(--radius-sm)" }}>
              <button
                type="button"
                role="checkbox"
                aria-checked={!calendar.hidden}
                aria-label={t(calendar.hidden ? "calendar.show" : "calendar.hide", { name: calendar.name })}
                onClick={() => onToggle(calendar)}
                style={{
                  width: 16,
                  height: 16,
                  flex: "none",
                  borderRadius: 5,
                  border: `2px solid ${colorVar(calendar.color)}`,
                  background: calendar.hidden ? "transparent" : colorVar(calendar.color),
                  color: "var(--on-pastel)",
                  padding: 0,
                  display: "grid",
                  placeItems: "center",
                  cursor: "pointer",
                }}
              >
                {calendar.hidden ? null : <Icon name="check" size={11} />}
              </button>
              <span style={{ flex: 1, minWidth: 0, fontSize: "var(--text-sm)", color: calendar.hidden ? "var(--text-muted)" : "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {calendar.name}
              </span>
              {onSettings ? (
                <IconButton icon="more-horizontal" size="sm" label={t("calendar.settingsOf", { name: calendar.name })} onClick={() => onSettings(calendar)} />
              ) : null}
            </div>
          ))}
        </section>
      ))}
      {footer}
      </div>
    </nav>
  );
}
