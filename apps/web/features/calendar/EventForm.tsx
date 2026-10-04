"use client";

import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, Icon, type IconName, Input, Popover, Select, Switch, Textarea } from "@/components/ds";
import {
  createEvent,
  listOccurrences,
  updateEvent,
  type Calendar,
  type CalendarEvent,
  type EditScope,
  type EventInput,
  type Occurrence,
} from "@/lib/data/calendar";
import { useSettings } from "@/features/app/settings";
import { useTranslation } from "@/lib/i18n";
import { currentLocale } from "@/lib/i18n/current";
import { clock } from "./format";
import { addDays, clashes, localDay, localMinutes, zonedTime } from "./model";
import { RecurrenceEditor } from "./RecurrenceEditor";
import { reminderOptions, reminderValue } from "./reminders";
import { colorVar } from "./OccurrenceChip";
import { buildRule, formFor, parseRule, presetOf, presetRule, type Preset, type RuleForm } from "./rule";
import { rulePhrase } from "./rulePhrase";
import { SeriesScopeDialog } from "./SeriesScopeDialog";

const line: CSSProperties = { display: "flex", gap: 10, alignItems: "center", minHeight: 40 };
const lineIcon: CSSProperties = { width: 18, flex: "none", display: "grid", placeItems: "center", color: "var(--text-muted)" };

/** One line of the form: an icon for what it is, then its control. */
function Line({ icon, swatch, children }: { icon?: IconName; swatch?: string; children: ReactNode }) {
  return (
    <div style={line}>
      <span aria-hidden style={lineIcon}>
        {swatch ? <span style={{ width: 12, height: 12, borderRadius: 4, background: swatch }} /> : icon ? <Icon name={icon} size={16} /> : null}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>{children}</div>
    </div>
  );
}

function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function minutesOf(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export type EventFormProps = {
  compact: boolean;
  calendars: Calendar[];
  spaces: { id: string; name: string }[];
  timeZone: string;
  /** A new event: where it starts, and in which calendar it goes first. */
  draft?: { day: string; minutes?: number; calendarId?: string; at?: { x: number; y: number } };
  /** An existing one: the occurrence opened, and its event. */
  editing?: { occurrence: Occurrence; event: CalendarEvent };
  onDone: (message: "saved" | "failed") => void;
  onCancel: () => void;
};

/**
 * Creating or changing an event: its title, calendar, times (or the whole day), repetition, the
 * author's own reminder, place and notes. The time zone shows only when it is not the viewer's.
 *
 * Built not to scroll. On a desktop, a slot clicked opens a small bubble beside it (title, times,
 * calendar), which is all most events need; "More options" turns it into the full window, in two
 * columns (when and how on the left, where and what on the right). The custom repetition replaces
 * the window's content while it is set, rather than lengthening it. On a phone the form is a short
 * panel of compact lines, the place and notes folded until asked for.
 */
export function EventForm({ compact, calendars, spaces, timeZone, draft, editing, onDone, onCancel }: EventFormProps) {
  const { t } = useTranslation();
  const duration = useSettings().calendar.duration;
  const writable = calendars.filter((c) => c.canWriteEvents);
  const occurrence = editing?.occurrence;
  const event = editing?.event;
  const zone = occurrence?.tzid ?? timeZone;

  const initial = useMemo(() => {
    if (occurrence) {
      if (occurrence.allDay) {
        return { startDay: occurrence.start, startTime: "09:00", endDay: addDays(occurrence.end, -1), endTime: "10:00" };
      }
      return {
        startDay: localDay(occurrence.start, zone),
        startTime: hhmm(localMinutes(occurrence.start, zone)),
        endDay: localDay(occurrence.end, zone),
        endTime: hhmm(localMinutes(occurrence.end, zone)),
      };
    }
    const now = new Date();
    const today = localDay(now.toISOString(), timeZone);
    const day = draft?.day ?? today;
    const start =
      draft?.minutes ?? (day === today ? Math.min(23 * 60, (Math.floor(localMinutes(now.toISOString(), timeZone) / 60) + 1) * 60) : 9 * 60);
    return { startDay: day, startTime: hhmm(start), endDay: start + duration >= 1440 ? addDays(day, 1) : day, endTime: hhmm(start + duration) };
  }, [occurrence, draft, zone, timeZone, duration]);

  const [title, setTitle] = useState(occurrence?.title ?? "");
  const [calendarId, setCalendarId] = useState(
    occurrence?.calendarId ?? draft?.calendarId ?? (writable.find((c) => !c.spaceId) ?? writable[0])?.id ?? "",
  );
  const [allDay, setAllDay] = useState(occurrence?.allDay ?? false);
  const [startDay, setStartDay] = useState(initial.startDay);
  const [startTime, setStartTime] = useState(initial.startTime);
  const [endDay, setEndDay] = useState(initial.endDay);
  const [endTime, setEndTime] = useState(initial.endTime);
  const [tz, setTz] = useState(zone);
  const originalRule = event?.rrule ?? null;
  const readable = originalRule ? parseRule(originalRule) : null;
  const [preset, setPreset] = useState<Preset | "imported">(originalRule && !readable ? "imported" : presetOf(originalRule, initial.startDay));
  const [custom, setCustom] = useState<RuleForm>(formFor(originalRule, initial.startDay));
  const [reminder, setReminder] = useState<string | undefined>(undefined);
  const [location, setLocation] = useState(occurrence?.location ?? "");
  const [description, setDescription] = useState(occurrence?.description ?? "");
  /** Whether the repetition was touched: an untouched rule is sent back exactly as it came. */
  const [ruleTouched, setRuleTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askScope, setAskScope] = useState(false);
  const [mode, setMode] = useState<"quick" | "full">(draft?.at && !compact ? "quick" : "full");
  const [panel, setPanel] = useState<"main" | "rule">("main");
  const [more, setMore] = useState(Boolean(occurrence?.location || occurrence?.description));
  const anchor = useRef<HTMLSpanElement>(null);
  // The title takes the focus once its window is in place: the bubble is measured hidden first, and
  // a hidden field cannot take it.
  useEffect(() => {
    const frame = requestAnimationFrame(() => document.getElementById("event-title")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [mode, panel]);

  // What the event would overlap, in every calendar the viewer sees, shown hidden ones included: a
  // warning, never a refusal.
  const [clash, setClash] = useState<Occurrence[] | null>(null);
  const span = allDay
    ? { start: zonedTime(startDay, 0, tz), end: zonedTime(addDays(endDay, 1), 0, tz) }
    : { start: zonedTime(startDay, minutesOf(startTime), tz), end: zonedTime(endDay, minutesOf(endTime), tz) };
  const spanKey = Date.parse(span.end) > Date.parse(span.start) ? `${span.start}/${span.end}` : "";
  useEffect(() => {
    if (!spanKey) return;
    const [from, to] = spanKey.split("/");
    const abort = new AbortController();
    const wait = setTimeout(() => {
      listOccurrences(from, to, calendars.map((c) => c.id), abort.signal)
        .then((found) => setClash(clashes(found, { start: from, end: to }, tz, event?.eventId ?? occurrence?.eventId)))
        .catch(() => {});
    }, 300);
    return () => {
      clearTimeout(wait);
      abort.abort();
    };
  }, [spanKey, tz, calendars, event?.eventId, occurrence?.eventId]);
  const calendarLabel = (id: string) => {
    const c = calendars.find((k) => k.id === id);
    if (!c) return "";
    const space = spaceName(c.spaceId);
    return space && space !== c.name ? `${space} · ${c.name}` : c.name;
  };
  const clashWhen = (o: Occurrence) => (o.allDay ? t("calendar.allDay") : `${clock(o.start, tz)} - ${clock(o.end, tz)}`);

  const spaceName = (id?: string) => spaces.find((s) => s.id === id)?.name;
  const calendarGroups = [
    { label: t("calendar.mine"), items: writable.filter((c) => !c.spaceId) },
    ...spaces.map((s) => ({ label: s.name, items: writable.filter((c) => c.spaceId === s.id) })),
  ].filter((g) => g.items.length > 0);

  /** The last second of a day in the event's zone, in UTC, as a timed rule's UNTIL writes it. */
  const endOfDay = (day: string) =>
    new Date(Date.parse(zonedTime(addDays(day, 1), 0, tz)) - 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  const rule = (): string | null => {
    if (!ruleTouched || preset === "imported") return originalRule;
    if (preset === "custom") return buildRule(custom, allDay, endOfDay);
    return presetRule(preset, startDay);
  };

  const input = (): EventInput | string => {
    if (!title.trim()) return t("calendar.titleRequired");
    const base = { title: title.trim(), description: description.trim() || undefined, location: location.trim() || undefined, rrule: rule() };
    const withReminder = reminder === undefined ? {} : { reminderMinutes: reminderValue(reminder) };
    if (allDay) {
      if (endDay < startDay) return t("calendar.endBeforeStart");
      return { ...base, ...withReminder, allDay: true, start: startDay, end: addDays(endDay, 1) };
    }
    const start = zonedTime(startDay, minutesOf(startTime), tz);
    const end = zonedTime(endDay, minutesOf(endTime), tz);
    if (Date.parse(end) < Date.parse(start)) return t("calendar.endBeforeStart");
    return { ...base, ...withReminder, allDay: false, start, end, tzid: tz };
  };

  const save = async (scope?: EditScope) => {
    const body = input();
    if (typeof body === "string") {
      setError(body);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!occurrence || !event) {
        await createEvent(calendarId, body);
      } else if (!event.isRecurring || scope === "all" || !scope) {
        // The whole series moves by as much as the occurrence on screen was moved, and what was not
        // changed on screen keeps the series' own value (the occurrence may have its own).
        const kept = (shown: string | undefined, own: string | undefined, series: string | undefined) =>
          (shown ?? "") === (own ?? "") ? series : shown;
        let whole: EventInput = {
          ...body,
          title: kept(body.title, occurrence.title, event.title) ?? body.title,
          location: kept(body.location, occurrence.location, event.location),
          description: kept(body.description, occurrence.description, event.description),
          calendarId: calendarId !== event.calendarId ? calendarId : undefined,
        };
        if (event.isRecurring && occurrence.recurrenceId) {
          if (body.allDay && event.allDay) {
            const shift = dayDiff(occurrence.start, body.start);
            const length = dayDiff(body.start, body.end);
            const start = addDays(event.start, shift);
            whole = { ...whole, start, end: addDays(start, length) };
          } else if (!body.allDay && !event.allDay) {
            const shift = Date.parse(body.start) - Date.parse(occurrence.start);
            const length = Date.parse(body.end) - Date.parse(body.start);
            const start = new Date(Date.parse(event.start) + shift).toISOString();
            whole = { ...whole, start, end: new Date(Date.parse(start) + length).toISOString() };
          }
        }
        await updateEvent(event.eventId, whole, "all");
      } else {
        await updateEvent(event.eventId, body, scope, occurrence.recurrenceId);
      }
      onDone("saved");
    } catch {
      setBusy(false);
      onDone("failed");
    }
  };

  const submit = () => {
    if (event?.isRecurring && occurrence?.recurrenceId) {
      if (typeof input() === "string") {
        setError(input() as string);
        return;
      }
      setAskScope(true);
      return;
    }
    void save();
  };

  const repeatOptions: { value: Preset | "imported"; label: string }[] = [
    { value: "none", label: t("calendar.repeatNone") },
    ...(["daily", "workdays", "weekly", "monthly", "yearly"] as const).map((p) => ({
      value: p,
      label: rulePhrase(parseRule(presetRule(p, startDay)!)!, startDay, currentLocale(), (k, v) => t(k as Parameters<typeof t>[0], v)),
    })),
    ...(preset === "imported" ? [{ value: "imported" as const, label: t("calendar.importedRule") }] : []),
    { value: "custom", label: t("calendar.repeatCustom") },
  ];
  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [tz];
    }
  }, [tz]);

  if (askScope) {
    return (
      <SeriesScopeDialog
        title={title.trim() || (occurrence?.title ?? "")}
        action="edit"
        onCancel={() => setAskScope(false)}
        onChoose={(scope) => {
          setAskScope(false);
          void save(scope);
        }}
      />
    );
  }

  const chosen = writable.find((c) => c.id === calendarId);
  const errorLine = error ? (
    <p role="alert" style={{ margin: 0, color: "var(--action-danger-bg)", fontSize: "var(--text-xs)" }}>
      {error}
    </p>
  ) : null;

  const titleInput = (big: boolean) => (
    <Input
      id="event-title"
      autoFocus
      size={big ? "lg" : "md"}
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      maxLength={500}
      placeholder={t("calendar.eventTitlePlaceholder")}
      aria-label={t("calendar.eventTitle")}
    />
  );

  const changeStartDay = (day: string) => {
    if (!day) return;
    setEndDay(addDays(endDay, dayDiff(startDay, day)));
    setStartDay(day);
  };
  const changeStartTime = (next: string) => {
    if (!next) return;
    // The end follows, keeping the length.
    const length = minutesOf(endTime) - minutesOf(startTime) + dayDiff(startDay, endDay) * 1440;
    const end = minutesOf(next) + Math.max(0, length);
    setEndDay(addDays(startDay, Math.floor(end / 1440)));
    setEndTime(hhmm(end));
    setStartTime(next);
  };
  const changeEndTime = (next: string) => {
    if (!next) return;
    setEndTime(next);
    // Within a day of the start, an end before the start runs past midnight, to the next day.
    if (dayDiff(startDay, endDay) <= 1) setEndDay(minutesOf(next) <= minutesOf(startTime) ? addDays(startDay, 1) : startDay);
  };
  const field = (flex: string, input: ReactNode) => <div style={{ flex, minWidth: 0 }}>{input}</div>;
  const dateInput = (id: string, value: string, onChange: (v: string) => void, label: string, min?: string) =>
    field(
      compact ? "1 1 0" : "0 1 170px",
      <Input id={id} type="date" size="sm" value={value} min={min} aria-label={label} onChange={(e) => onChange(e.target.value)} style={{ width: "100%", minWidth: 0 }} />,
    );
  const timeInput = (id: string, value: string, onChange: (v: string) => void, label: string) =>
    field(compact ? "0 0 92px" : "0 0 112px", <Input id={id} type="time" size="sm" value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} style={{ width: "100%", minWidth: 0 }} />);

  /** When, on one line: the day and the start, then the end. The end's day shows only when it is not
   *  the start's (and always for whole days). */
  const when = (
    <div role="group" aria-label={t("calendar.when")} style={{ display: "flex", alignItems: "center", gap: compact ? 4 : 6, flexWrap: allDay || endDay !== startDay ? "wrap" : "nowrap" }}>
      {dateInput("event-start-day", startDay, changeStartDay, t("prefs.from"))}
      {!allDay ? timeInput("event-start-time", startTime, changeStartTime, t("calendar.startTime")) : null}
      <Icon name="arrow-right" size={14} />
      {!allDay ? timeInput("event-end-time", endTime, changeEndTime, t("calendar.endTime")) : null}
      {allDay || endDay !== startDay ? dateInput("event-end-day", endDay, (v) => v && setEndDay(v), t("prefs.to"), startDay) : null}
    </div>
  );

  const clashLine =
    clash && clash.length > 0 ? (
      <p role="status" style={{ margin: 0, display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 10px", borderRadius: "var(--radius-sm)", background: "color-mix(in srgb, var(--bee) 22%, transparent)", color: "var(--text-strong)", fontSize: "var(--text-xs)" }}>
        <Icon name="alert-triangle" size={14} style={{ flex: "none", marginTop: 1 }} />
        <span>
          {clash.length === 1
            ? t("calendar.clash", { count: 1, title: clash[0].title, where: calendarLabel(clash[0].calendarId), when: clashWhen(clash[0]) })
            : t("calendar.clash", { count: clash.length, titles: clash.slice(0, 3).map((o) => o.title).join(", ") + (clash.length > 3 ? ", …" : "") })}
        </span>
      </p>
    ) : null;

  const calendarSelect = (
    <Select
      id="event-calendar"
      size="sm"
      aria-label={t("calendar.title")}
      value={calendarId}
      onChange={(e) => setCalendarId(e.target.value)}
      disabled={Boolean(event?.isRecurring && occurrence?.recurrenceId)}
      style={{ width: "100%" }}
    >
      {calendarGroups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.spaceId && c.name !== spaceName(c.spaceId) ? `${spaceName(c.spaceId) ?? ""} · ${c.name}` : c.name}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );

  const repeatSelect = (
    <>
      <Select
        id="event-repeat"
        size="sm"
        aria-label={t("calendar.repeat")}
        value={preset}
        onChange={(e) => {
          const next = e.target.value as Preset | "imported";
          if (next === "custom") {
            setCustom(formFor(rule(), startDay));
            setPanel("rule");
          }
          setRuleTouched(true);
          setPreset(next);
        }}
        options={repeatOptions}
        style={{ width: "100%" }}
      />
      {preset === "custom" ? (
        <Button type="button" size="sm" variant="ghost" iconLeft="square-pen" onClick={() => setPanel("rule")} style={{ whiteSpace: "normal", height: "auto", textAlign: "left" }}>
          {rulePhrase(custom, startDay, currentLocale(), (k, v) => t(k as Parameters<typeof t>[0], v))}
        </Button>
      ) : null}
    </>
  );

  const reminderSelect = (
    <Select
      id="event-reminder"
      size="sm"
      aria-label={t("calendar.myReminder")}
      title={reminder === undefined ? t("calendar.reminderFollows") : undefined}
      value={reminder ?? "default"}
      onChange={(e) => setReminder(e.target.value === "default" ? undefined : e.target.value)}
      options={[{ value: "default", label: t("calendar.reminderAsCalendar") }, ...reminderOptions(allDay, t)]}
      style={{ width: "100%" }}
    />
  );

  const placeInput = (
    <Input id="event-location" size="sm" style={{ width: "100%" }} value={location} onChange={(e) => setLocation(e.target.value)} maxLength={500} placeholder={t("calendar.addLocation")} aria-label={t("calendar.location")} />
  );
  const notesInput = (rows: number) => (
    <Textarea id="event-notes" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={20000} rows={rows} placeholder={t("calendar.addNotes")} aria-label={t("calendar.notes")} />
  );
  const zoneLine =
    !allDay && tz !== timeZone ? (
      <Line icon="globe">
        <Select id="event-zone" size="sm" aria-label={t("profile.timezone")} value={tz} onChange={(e) => setTz(e.target.value)} options={zones} style={{ width: "100%" }} />
      </Line>
    ) : null;

  const formProps = {
    onSubmit: (e: React.FormEvent) => {
      e.preventDefault();
      submit();
    },
  };
  const saveLabel = occurrence ? t("common.save") : t("common.create");

  // The quick bubble, beside the slot clicked (a desktop's new event).
  if (mode === "quick" && draft?.at) {
    const at = draft.at;
    return (
      <>
        <span ref={anchor} hidden />
        <Popover anchorRef={anchor} getAnchorRect={() => new DOMRect(at.x, at.y, 0, 0)} open onClose={onCancel} placement="bottom">
          <form
            {...formProps}
            role="dialog"
            aria-label={t("calendar.newEvent")}
            style={{
              width: 420,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: 14,
              background: "var(--surface-card)",
              border: "2px solid var(--ink)",
              borderRadius: "var(--radius-lg)",
              boxShadow: "var(--shadow-popover)",
            }}
          >
            {titleInput(true)}
            {when}
            <Line swatch={colorVar(chosen?.color)}>{calendarSelect}</Line>
            {clashLine}
            {errorLine}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
              <Button type="button" size="sm" variant="ghost" onClick={() => setMode("full")}>
                {t("calendar.moreOptions")}
              </Button>
              <Button size="sm" variant="primary" type="submit" disabled={busy || !calendarId}>
                {saveLabel}
              </Button>
            </div>
          </form>
        </Popover>
      </>
    );
  }

  // The custom repetition, in place of the form while it is set.
  if (panel === "rule") {
    return (
      <Dialog
        size="md"
        title={t("calendar.customRule")}
        onClose={() => setPanel("main")}
        closeLabel={t("common.back")}
        footer={
          <Button variant="primary" onClick={() => setPanel("main")}>
            {t("calendar.ruleDone")}
          </Button>
        }
      >
        <RecurrenceEditor
          form={custom}
          start={startDay}
          onChange={(next) => {
            setRuleTouched(true);
            setCustom(next);
          }}
        />
      </Dialog>
    );
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
      <Button variant="primary" onClick={submit} disabled={busy || !calendarId}>
        {saveLabel}
      </Button>
    </>
  );
  const dialogTitle = occurrence ? t("calendar.editEvent") : t("calendar.newEvent");
  const allDaySwitch = <Switch label={t("calendar.allDayEvent")} checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />;

  if (compact) {
    return (
      <Dialog size="md" title={dialogTitle} onClose={onCancel} closeLabel={t("common.close")} footer={footer}>
        <form {...formProps} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {titleInput(true)}
          <div style={{ padding: "8px 0 4px" }}>{when}</div>
          {clashLine}
          {allDaySwitch}
          {zoneLine}
          <Line swatch={colorVar(chosen?.color)}>{calendarSelect}</Line>
          <Line icon="repeat">{repeatSelect}</Line>
          <Line icon="bell">{reminderSelect}</Line>
          {more ? (
            <>
              <Line icon="map-pin">{placeInput}</Line>
              <Line icon="file-text">{notesInput(3)}</Line>
            </>
          ) : (
            <div>
              <Button type="button" size="sm" variant="ghost" iconLeft="plus" onClick={() => setMore(true)}>
                {t("calendar.placeAndNotes")}
              </Button>
            </div>
          )}
          {errorLine}
          <button type="submit" hidden />
        </form>
      </Dialog>
    );
  }

  return (
    <Dialog size="lg" title={dialogTitle} onClose={onCancel} closeLabel={t("common.close")} footer={footer}>
      <form {...formProps} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {titleInput(true)}
        {when}
        {clashLine}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1fr)", gap: 20 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ padding: "4px 0" }}>{allDaySwitch}</div>
            {zoneLine}
            <Line icon="repeat">{repeatSelect}</Line>
            <Line icon="bell">{reminderSelect}</Line>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Line swatch={colorVar(chosen?.color)}>{calendarSelect}</Line>
            <Line icon="map-pin">{placeInput}</Line>
            <div style={{ ...line, alignItems: "flex-start" }}>
              <span aria-hidden style={{ ...lineIcon, paddingTop: 8 }}>
                <Icon name="file-text" size={16} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>{notesInput(5)}</div>
            </div>
          </div>
        </div>
        {errorLine}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
