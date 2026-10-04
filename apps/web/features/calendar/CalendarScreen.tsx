"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Dialog, Icon, IconButton, Tabs } from "@/components/ds";
import {
  setCalendarMe,
  type Calendar,
  type Occurrence,
} from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import { CalendarOverlays, type SettingsTarget } from "./CalendarOverlays";
import { CalendarSidebar, ScopeSwitch, SpacePicker } from "./CalendarSidebar";
import { useSettings } from "@/features/app/settings";
import { periodTitle, setClockFormat } from "./format";
import { ListView } from "./ListView";
import {
  addDays,
  inFilter,
  localDay,
  rangeFor,
  weekOffset,
  type Filter,
  type View,
} from "./model";
import { MiniMonth } from "./MiniMonth";
import { MonthView } from "./MonthView";
import { INVITATIONS_COLOR, type ChipLook } from "./OccurrenceChip";
import { rowWeek, weekDays } from "./prefs";
import { TimeGrid } from "./TimeGrid";
import { useCalendarData } from "./useCalendarData";

/** Where the phone's tab keeps the last filter chosen. */
const FILTER_KEY = "ruchoir.calendar.filter";

/** Where the device keeps whether the invitations from others' calendars are hidden. */
const INVITATIONS_KEY = "ruchoir.calendar.invitationsHidden";


function storedFilter(): Filter | null {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    return raw ? (JSON.parse(raw) as Filter) : null;
  } catch {
    return null;
  }
}

/** What a new event starts from: a day, and a time of that day for a timed one. `at` is where it was
 *  asked for on screen, for the quick form to open beside it (a desktop's). */
export type Draft = { day: string; minutes?: number; calendarId?: string; at?: { x: number; y: number } };

export type CalendarScreenProps = {
  compact: boolean;
  /** The viewer's time zone: their profile's, else the browser's. */
  timeZone: string;
  /** The viewer's own id: theirs is the first line of an event's availability. */
  viewerId?: string;
  spaces: { id: string; name: string }[];
  /** The space the screen was opened from: its filter at first. */
  spaceId?: string;
  /** The phone's tab remembers the last filter rather than following a space. */
  rememberFilter?: boolean;
  onBack?: () => void;
  /** Desktop and tablet: back to the space's conversations, whose column the calendar's replaces. */
  onLeave?: () => void;
  /** The space it was opened from, named on the way back. */
  spaceName?: string;
  /** An event to open (a clicked reminder): the screen starts on its day, with its details. */
  focus?: { eventId: string; start: string; allDay: boolean };
  onNotify?: (toast: {
    tone: "info" | "success" | "danger";
    title: string;
  }) => void;
};

/**
 * The calendar: one screen whatever door it was opened by. A space's "Calendar" entry opens it
 * filtered on that space; the phone's tab opens it on the last filter chosen. Whatever falls outside
 * the filter stays on screen, struck through, so being free or not can be read without switching
 * spaces; the viewer's own calendars are always drawn in full.
 */
export function CalendarScreen({
  compact,
  timeZone,
  viewerId,
  spaces,
  spaceId,
  rememberFilter,
  onBack,
  onLeave,
  spaceName: leaveLabel,
  focus,
  onNotify,
}: CalendarScreenProps) {
  const { t } = useTranslation();
  const today = localDay(new Date().toISOString(), timeZone);
  const prefs = useSettings().calendar;
  // The clock is read by every time on screen: set as the screen draws, so a change in the
  // preferences shows the next time the calendar opens.
  setClockFormat(prefs.clock);
  const [view, setView] = useState<View>(compact ? prefs.viewPhone : prefs.viewDesktop);
  const focusDay = focus
    ? focus.allDay
      ? focus.start
      : localDay(focus.start, timeZone)
    : null;
  const [anchor, setAnchor] = useState(focusDay ?? today);
  const [filter, setFilterState] = useState<Filter>(() => {
    const kept = rememberFilter ? storedFilter() : null;
    if (kept) return kept;
    return spaceId ? { kind: "space", spaceId } : { kind: "all" };
  });
  const [opened, setOpened] = useState<Occurrence | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [settings, setSettings] = useState<SettingsTarget | null>(null);
  // The phone's panel listing the calendars.
  const [listOpen, setListOpen] = useState(false);

  const range = useMemo(
    () => rangeFor(view, anchor, timeZone, prefs.weekStart),
    [view, anchor, timeZone, prefs.weekStart],
  );
  const [invitationsHidden, setInvitationsHidden] = useState(() => {
    try {
      return localStorage.getItem(INVITATIONS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleInvitations = () => {
    setInvitationsHidden((hidden) => {
      try {
        localStorage.setItem(INVITATIONS_KEY, hidden ? "0" : "1");
      } catch {
        // No storage: the choice lasts as long as the screen.
      }
      return !hidden;
    });
  };
  const { calendars, occurrences, failed, reload, setCalendars } =
    useCalendarData(range, !invitationsHidden);
  const hasInvitations = invitationsHidden || (occurrences ?? []).some((o) => o.invited);

  // Once the focused event's day is loaded, open it, once.
  const focused = useRef(false);
  useEffect(() => {
    if (!focus || focused.current || !occurrences) return;
    const found = occurrences.find(
      (o) =>
        o.eventId === focus.eventId &&
        (o.start === focus.start || o.start.slice(0, 10) === focusDay),
    );
    if (found) {
      focused.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpened(found);
    }
  }, [focus, focusDay, occurrences]);

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

  const byId = useMemo(
    () => new Map((calendars ?? []).map((c) => [c.id, c])),
    [calendars],
  );
  const chipCalendars = useMemo(
    () => (calendars ?? []).map((c) => ({ id: c.id, spaceId: c.spaceId })),
    [calendars],
  );
  const lookOf = useCallback(
    (o: Occurrence): ChipLook => ({
      color: o.invited ? INVITATIONS_COLOR : byId.get(o.calendarId)?.color,
      dimmed: !inFilter(o, chipCalendars, filter),
      // An attendee's answer shows; "accepted" (an organiser's too) looks as any event.
      status: o.myStatus,
    }),
    [byId, chipCalendars, filter],
  );
  const spaceName = useCallback(
    (id?: string) => spaces.find((s) => s.id === id)?.name,
    [spaces],
  );
  const calendarName = useCallback(
    (o: Occurrence) => {
      if (o.invited) return t("calendar.invitations");
      const calendar = byId.get(o.calendarId);
      if (!calendar) return "";
      const space = spaceName(calendar.spaceId);
      return space && space !== calendar.name ? `${space} · ${calendar.name}` : calendar.name;
    },
    [byId, spaceName, t],
  );
  // Only the spaces the viewer has calendars in can be picked.
  const chipSpaces = spaces.filter((s) =>
    (calendars ?? []).some((c) => c.spaceId === s.id),
  );

  const step = (direction: 1 | -1) => {
    if (view === "day") setAnchor((a) => addDays(a, direction));
    else if (view === "week") setAnchor((a) => addDays(a, 7 * direction));
    else if (view === "list") setAnchor((a) => addDays(a, 30 * direction));
    else {
      const [y, m] = anchor.split("-").map(Number);
      const next = new Date(Date.UTC(y, m - 1 + direction, 1));
      setAnchor(
        `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`,
      );
    }
  };

  const toggleMany = (many: Calendar[], hidden: boolean) => {
    const ids = new Set(many.map((c) => c.id));
    setCalendars((list) => list?.map((c) => (ids.has(c.id) ? { ...c, hidden } : c)) ?? null);
    Promise.all(many.filter((c) => c.hidden !== hidden).map((c) => setCalendarMe(c.id, { hidden }))).catch(() => reload());
  };

  const toggle = (calendar: Calendar) => {
    setCalendars(
      (list) =>
        list?.map((c) =>
          c.id === calendar.id ? { ...c, hidden: !c.hidden } : c,
        ) ?? null,
    );
    setCalendarMe(calendar.id, { hidden: !calendar.hidden }).catch(() =>
      reload(),
    );
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
            if (
              start === null ||
              end === undefined ||
              Math.abs(end - start) < 60
            )
              return;
            step(end < start ? 1 : -1);
          },
        }
      : {};

  const writable = (calendars ?? []).filter((c) => c.canWriteEvents);
  const startDraft = (day: string, minutes?: number, at?: { x: number; y: number }) => {
    if (writable.length === 0) return;
    setDraft({ day, minutes, at: compact ? undefined : at });
  };
  // The space listed first in the column: the one the screen was opened from, else the one filtered.
  const currentSpaceId = spaceId ?? (filter.kind === "space" ? filter.spaceId : undefined);
  const filterControl = spaceId ? (
    <ScopeSwitch spaceId={spaceId} filter={filter} onFilter={setFilter} />
  ) : (
    <SpacePicker spaces={chipSpaces} filter={filter} onFilter={setFilter} />
  );

  const viewTabs = (
    compact
      ? (["list", "day", "month"] as const)
      : (["month", "week", "day", "list"] as const)
  ).map((v) => ({
    value: v,
    label: t(`calendar.view.${v}`),
  }));

  const bar: CSSProperties = {
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: compact ? "8px 12px" : "6px 16px",
    minHeight: compact ? undefined : "var(--topbar-height)",
    borderBottom: compact ? undefined : "1.5px solid var(--border-subtle)",
    // A tablet's narrower screen puts the filter and the views on a second line.
    flexWrap: "wrap",
    rowGap: 6,
  };

  const body = (() => {
    if (!calendars || !occurrences) {
      return (
        <p
          role="status"
          style={{
            padding: "var(--space-8)",
            color: "var(--text-muted)",
            textAlign: "center",
            margin: 0,
          }}
        >
          {failed ? t("calendar.loadFailed") : t("calendar.loading")}
        </p>
      );
    }
    if (view === "month") {
      const monthStart = `${anchor.slice(0, 8)}01`;
      return (
        <MonthView
          key={anchor.slice(0, 7)}
          from={addDays(monthStart, -weekOffset(monthStart, prefs.weekStart))}
          weekStart={prefs.weekStart}
          weekNumbers={prefs.weekNumbers}
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
          <ListView
            from={anchor}
            days={30}
            occurrences={occurrences}
            timeZone={timeZone}
            lookOf={lookOf}
            calendarName={calendarName}
            onOpen={setOpened}
          />
        </div>
      );
    }
    const days = view === "week" ? weekDays(anchor, prefs.weekStart, prefs.weekends) : [anchor];
    return (
      <TimeGrid
        days={days}
        occurrences={occurrences}
        timeZone={timeZone}
        lookOf={lookOf}
        onOpen={setOpened}
        onCreateAt={writable.length > 0 ? startDraft : undefined}
        pending={draft && draft.minutes !== undefined ? { day: draft.day, minutes: draft.minutes } : undefined}
        openAt={prefs.openAt}
        work={prefs.workHours ? { start: prefs.workStart, end: prefs.workEnd } : undefined}
        duration={prefs.duration}
        compact={compact}
      />
    );
  })();

  // The calendar's own column, in place of the space's (desktop and tablet).
  const column =
    !compact && calendars ? (
      <CalendarSidebar
        calendars={calendars}
        spaces={spaces}
        currentSpaceId={currentSpaceId}
        invitations={hasInvitations ? { hidden: invitationsHidden, color: INVITATIONS_COLOR, onToggle: toggleInvitations } : undefined}
        onToggle={toggle}
        onToggleMany={toggleMany}
        onSettings={(c) => setSettings({ kind: "edit", calendar: c })}
        onNewCalendar={(space) => setSettings({ kind: "new", spaceId: space })}
        header={
          <>
            {onLeave ? (
              <div
                style={{
                  height: "var(--topbar-height)",
                  flex: "none",
                  display: "flex",
                  alignItems: "center",
                  padding: "0 8px",
                  borderBottom: "1.5px solid var(--border-subtle)",
                }}
              >
                <Button
                  variant="ghost"
                  iconLeft="arrow-left"
                  onClick={onLeave}
                  aria-label={t("calendar.backTo", { name: leaveLabel ?? "" })}
                >
                  {leaveLabel}
                </Button>
              </div>
            ) : null}
            <div
              style={{
                flex: "none",
                padding: "8px 10px 0",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <MiniMonth
                anchor={anchor}
                today={today}
                shown={view === "week" ? weekDays(anchor, prefs.weekStart, prefs.weekends) : [anchor]}
                band={view === "week"}
                weekStart={prefs.weekStart}
                weekNumbers={prefs.weekNumbers}
                onPick={setAnchor}
              />
            </div>
          </>
        }
        footer={
          <Button
            size="sm"
            variant="ghost"
            iconLeft="rss"
            onClick={() => setSettings({ kind: "feeds" })}
            style={{ whiteSpace: "normal", height: "auto", textAlign: "left" }}
          >
            {t("calendar.subscribeAll")}
          </Button>
        }
      />
    ) : null;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        background: "var(--surface)",
      }}
    >
      {column}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          position: "relative",
        }}
      >
        <h1
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            overflow: "hidden",
            clip: "rect(0 0 0 0)",
            margin: -1,
          }}
        >
          {t("calendar.title")}
        </h1>
        <div style={bar}>
          {onBack ? (
            <IconButton
              icon="arrow-left"
              size={compact ? "lg" : "md"}
              label={t("common.back")}
              onClick={onBack}
            />
          ) : null}
          {!compact ? (
            <Button size="sm" onClick={() => setAnchor(today)}>
              {t("conversation.today")}
            </Button>
          ) : null}
          <IconButton
            icon="chevron-left"
            size={compact ? "lg" : "md"}
            label={t("calendar.previous")}
            onClick={() => step(-1)}
          />
          <IconButton
            icon="chevron-right"
            size={compact ? "lg" : "md"}
            label={t("calendar.next")}
            onClick={() => step(1)}
          />
          {compact ? (
            <IconButton
              icon="list"
              size="lg"
              label={t("calendar.calendars")}
              onClick={() => setListOpen(true)}
            />
          ) : null}
          <h2
            style={{
              margin: 0,
              fontSize: compact ? "var(--text-lg)" : "var(--text-md)",
              fontWeight: 700,
              color: "var(--text-strong)",
              whiteSpace: "nowrap",
              flex: compact ? 1 : undefined,
              cursor: compact ? "pointer" : undefined,
            }}
            onClick={compact ? () => setAnchor(today) : undefined}
          >
            {periodTitle(view, anchor)}
            {prefs.weekNumbers && (view === "week" || view === "day") ? (
              <span style={{ marginLeft: 8, fontWeight: 400, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                {t("calendar.weekNumber", { n: rowWeek(addDays(anchor, -weekOffset(anchor, prefs.weekStart))) })}
              </span>
            ) : null}
          </h2>
          {!compact ? (
            <>
              <div style={{ flex: 1 }} />
              {filterControl}
              <Tabs
                variant="pills"
                className="wc-tabs--accent"
                items={viewTabs}
                value={view}
                onChange={(v) => setView(v as View)}
              />
              {writable.length > 0 ? (
                <Button
                  variant="primary"
                  size="sm"
                  iconLeft="plus"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    startDraft(anchor, undefined, { x: r.right, y: r.bottom });
                  }}
                >
                  {t("calendar.newEvent")}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
        {compact ? (
          <div
            style={{
              flex: "none",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
              padding: "0 12px 8px",
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            {filterControl}
            <Tabs
              variant="pills"
              className="wc-tabs--accent"
              items={viewTabs}
              value={view}
              onChange={(v) => setView(v as View)}
            />
          </div>
        ) : null}
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
            }}
            {...swipeHandlers}
          >
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
        {compact && listOpen && calendars && !settings ? (
          <Dialog
            size="md"
            title={t("calendar.calendars")}
            onClose={() => setListOpen(false)}
            closeLabel={t("common.close")}
          >
            <CalendarSidebar
              variant="sheet"
              calendars={calendars}
              spaces={spaces}
              currentSpaceId={currentSpaceId}
              invitations={hasInvitations ? { hidden: invitationsHidden, color: INVITATIONS_COLOR, onToggle: toggleInvitations } : undefined}
              onToggle={toggle}
              onToggleMany={toggleMany}
              onSettings={(c) => setSettings({ kind: "edit", calendar: c })}
              onNewCalendar={(space) =>
                setSettings({ kind: "new", spaceId: space })
              }
              footer={
                <Button
                  size="sm"
                  variant="ghost"
                  iconLeft="rss"
                  onClick={() => setSettings({ kind: "feeds" })}
                >
                  {t("calendar.subscribeAll")}
                </Button>
              }
            />
          </Dialog>
        ) : null}
        {calendars ? (
          <CalendarOverlays
            compact={compact}
            timeZone={timeZone}
            spaces={spaces}
            calendars={calendars}
            filter={filter}
            currentSpaceId={currentSpaceId}
            viewerId={viewerId}
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
            onNotify={onNotify}
          />
        ) : null}
      </div>
    </div>
  );
}
