"use client";

import { type CSSProperties, useCallback, useMemo, useRef, useState } from "react";
import { Button, Icon, IconButton, Tabs } from "@/components/ds";
import { setCalendarMe, type Calendar, type Occurrence } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import { CalendarOverlays, type SettingsTarget } from "./CalendarOverlays";
import { CalendarSidebar, FilterChips } from "./CalendarSidebar";
import { periodTitle } from "./format";
import { ListView } from "./ListView";
import { addDays, inFilter, localDay, rangeFor, weekdayOf, type Filter, type View } from "./model";
import { MonthView } from "./MonthView";
import type { ChipLook } from "./OccurrenceChip";
import { daysOf, TimeGrid } from "./TimeGrid";
import { useCalendarData } from "./useCalendarData";

/** Where the phone's tab keeps the last filter chosen. */
const FILTER_KEY = "ruchoir.calendar.filter";

function storedFilter(): Filter | null {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    return raw ? (JSON.parse(raw) as Filter) : null;
  } catch {
    return null;
  }
}

/** What a new event starts from: a day, and a time of that day for a timed one. */
export type Draft = { day: string; minutes?: number; calendarId?: string };

export type CalendarScreenProps = {
  compact: boolean;
  /** The viewer's time zone: their profile's, else the browser's. */
  timeZone: string;
  spaces: { id: string; name: string }[];
  /** The space the screen was opened from: its filter at first. */
  spaceId?: string;
  /** The phone's tab remembers the last filter rather than following a space. */
  rememberFilter?: boolean;
  onBack?: () => void;
};

/**
 * The calendar: one screen whatever door it was opened by. A space's "Calendar" entry opens it
 * filtered on that space; the phone's tab opens it on the last filter chosen. Whatever falls outside
 * the filter stays on screen, struck through, so being free or not can be read without switching
 * spaces; the viewer's own calendars are always drawn in full.
 */
export function CalendarScreen({ compact, timeZone, spaces, spaceId, rememberFilter, onBack }: CalendarScreenProps) {
  const { t } = useTranslation();
  const today = localDay(new Date().toISOString(), timeZone);
  const [view, setView] = useState<View>(compact ? "list" : "week");
  const [anchor, setAnchor] = useState(today);
  const [filter, setFilterState] = useState<Filter>(() => {
    const kept = rememberFilter ? storedFilter() : null;
    if (kept) return kept;
    return spaceId ? { kind: "space", spaceId } : { kind: "all" };
  });
  const [opened, setOpened] = useState<Occurrence | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [settings, setSettings] = useState<SettingsTarget | null>(null);

  const range = useMemo(() => rangeFor(view, anchor, timeZone), [view, anchor, timeZone]);
  const { calendars, occurrences, failed, reload, setCalendars } = useCalendarData(range);

  const setFilter = (next: Filter) => {
    setFilterState(next);
    if (rememberFilter) {
      try {
        localStorage.setItem(FILTER_KEY, JSON.stringify(next));
      } catch {
        // A private window without storage: the choice lasts until the tab closes.
      }
    }
  };

  const byId = useMemo(() => new Map((calendars ?? []).map((c) => [c.id, c])), [calendars]);
  const chipCalendars = useMemo(() => (calendars ?? []).map((c) => ({ id: c.id, spaceId: c.spaceId })), [calendars]);
  const lookOf = useCallback(
    (o: Occurrence): ChipLook => ({ color: byId.get(o.calendarId)?.color, dimmed: !inFilter(o, chipCalendars, filter) }),
    [byId, chipCalendars, filter],
  );
  const spaceName = useCallback((id?: string) => spaces.find((s) => s.id === id)?.name, [spaces]);
  const calendarName = useCallback(
    (o: Occurrence) => {
      const calendar = byId.get(o.calendarId);
      if (!calendar) return "";
      const space = spaceName(calendar.spaceId);
      return space ? `${space} · ${calendar.name}` : calendar.name;
    },
    [byId, spaceName],
  );
  // Only the spaces the viewer has calendars in get a chip.
  const chipSpaces = spaces.filter((s) => (calendars ?? []).some((c) => c.spaceId === s.id));

  const step = (direction: 1 | -1) => {
    if (view === "day") setAnchor((a) => addDays(a, direction));
    else if (view === "week") setAnchor((a) => addDays(a, 7 * direction));
    else if (view === "list") setAnchor((a) => addDays(a, 30 * direction));
    else {
      const [y, m] = anchor.split("-").map(Number);
      const next = new Date(Date.UTC(y, m - 1 + direction, 1));
      setAnchor(`${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`);
    }
  };

  const toggle = (calendar: Calendar) => {
    setCalendars((list) => list?.map((c) => (c.id === calendar.id ? { ...c, hidden: !c.hidden } : c)) ?? null);
    setCalendarMe(calendar.id, { hidden: !calendar.hidden }).catch(() => reload());
  };

  // Swiping across the day view changes day, as a phone's calendar does.
  const swipe = useRef<number | null>(null);
  const swipeHandlers =
    compact && view === "day"
      ? {
          onTouchStart: (e: React.TouchEvent) => {
            swipe.current = e.touches[0]?.clientX ?? null;
          },
          onTouchEnd: (e: React.TouchEvent) => {
            const start = swipe.current;
            swipe.current = null;
            const end = e.changedTouches[0]?.clientX;
            if (start === null || end === undefined || Math.abs(end - start) < 60) return;
            step(end < start ? 1 : -1);
          },
        }
      : {};

  const writable = (calendars ?? []).filter((c) => c.canWriteEvents);
  const startDraft = (day: string, minutes?: number) => {
    if (writable.length === 0) return;
    setDraft({ day, minutes });
  };

  const viewTabs = (compact ? (["list", "day", "month"] as const) : (["month", "week", "day", "list"] as const)).map((v) => ({
    value: v,
    label: t(`calendar.view.${v}`),
  }));

  const bar: CSSProperties = {
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: compact ? "8px 12px" : "0 16px",
    minHeight: compact ? undefined : "var(--topbar-height)",
    borderBottom: compact ? undefined : "1.5px solid var(--border-subtle)",
    flexWrap: compact ? "wrap" : undefined,
  };

  const body = (() => {
    if (!calendars || !occurrences) {
      return (
        <p role="status" style={{ padding: "var(--space-8)", color: "var(--text-muted)", textAlign: "center", margin: 0 }}>
          {failed ? t("calendar.loadFailed") : t("calendar.loading")}
        </p>
      );
    }
    if (view === "month") {
      const monthStart = `${anchor.slice(0, 8)}01`;
      return (
        <MonthView
          key={anchor.slice(0, 7)}
          from={addDays(monthStart, -weekdayOf(monthStart))}
          anchor={anchor}
          occurrences={occurrences}
          timeZone={timeZone}
          lookOf={lookOf}
          calendarName={calendarName}
          onOpen={setOpened}
          onPickDay={(day) => {
            setAnchor(day);
            setView("day");
          }}
          compact={compact}
        />
      );
    }
    if (view === "list") {
      return (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <ListView from={anchor} days={30} occurrences={occurrences} timeZone={timeZone} lookOf={lookOf} calendarName={calendarName} onOpen={setOpened} />
        </div>
      );
    }
    const days = view === "week" ? daysOf(addDays(anchor, -weekdayOf(anchor)), 7) : [anchor];
    return (
      <TimeGrid
        days={days}
        occurrences={occurrences}
        timeZone={timeZone}
        lookOf={lookOf}
        onOpen={setOpened}
        onCreateAt={writable.length > 0 ? startDraft : undefined}
        compact={compact}
      />
    );
  })();

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--surface)" }}>
      <h1 style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", margin: -1 }}>{t("calendar.title")}</h1>
      <div style={bar}>
        {onBack ? <IconButton icon="arrow-left" label={t("common.back")} onClick={onBack} /> : null}
        {!compact ? (
          <Button size="sm" onClick={() => setAnchor(today)}>
            {t("conversation.today")}
          </Button>
        ) : null}
        <IconButton icon="chevron-left" label={t("calendar.previous")} onClick={() => step(-1)} />
        <IconButton icon="chevron-right" label={t("calendar.next")} onClick={() => step(1)} />
        <h2
          style={{ margin: 0, fontSize: compact ? "var(--text-lg)" : "var(--text-md)", fontWeight: 700, color: "var(--text-strong)", flex: compact ? 1 : undefined, cursor: compact ? "pointer" : undefined }}
          onClick={compact ? () => setAnchor(today) : undefined}
        >
          {periodTitle(view, anchor)}
        </h2>
        {!compact ? (
          <>
            <div style={{ flex: 1 }} />
            <Tabs variant="pills" items={viewTabs} value={view} onChange={(v) => setView(v as View)} />
            {writable.length > 0 ? (
              <Button variant="primary" size="sm" iconLeft="plus" onClick={() => startDraft(anchor)}>
                {t("calendar.newEvent")}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      <div
        style={{
          flex: "none",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: compact ? "0 12px 8px" : "8px 16px",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <FilterChips spaces={chipSpaces} filter={filter} onFilter={setFilter} />
        {compact ? <Tabs variant="pills" items={viewTabs} value={view} onChange={(v) => setView(v as View)} /> : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {!compact && calendars ? (
          <CalendarSidebar
            calendars={calendars}
            spaces={spaces}
            onToggle={toggle}
            onSettings={(c) => setSettings({ kind: "edit", calendar: c })}
            onNewCalendar={(space) => setSettings({ kind: "new", spaceId: space })}
          />
        ) : null}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }} {...swipeHandlers}>
          {body}
        </div>
      </div>
      {compact && writable.length > 0 ? (
        <button
          type="button"
          aria-label={t("calendar.newEvent")}
          onClick={() => startDraft(anchor)}
          style={{
            position: "absolute",
            right: 16,
            bottom: 16,
            width: 52,
            height: 52,
            borderRadius: 14,
            border: "none",
            background: "var(--action-primary-bg)",
            color: "var(--action-primary-fg)",
            boxShadow: "3px 3px 0 var(--bee)",
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
            zIndex: 2,
          }}
        >
          <Icon name="plus" size={22} />
        </button>
      ) : null}
      {calendars ? (
        <CalendarOverlays
          compact={compact}
          timeZone={timeZone}
          spaces={spaces}
          calendars={calendars}
          filter={filter}
          opened={opened}
          draft={draft}
          settings={settings}
          onEdit={(occurrence) => setOpened(occurrence)}
          onClose={() => {
            setOpened(null);
            setDraft(null);
            setSettings(null);
          }}
          onChanged={reload}
        />
      ) : null}
    </div>
  );
}
