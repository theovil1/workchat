"use client";

import { type CSSProperties, useMemo, useState } from "react";
import { Button, Dialog, Field, Input, Select, Switch, Textarea } from "@/components/ds";
import {
  createEvent,
  updateEvent,
  type Calendar,
  type CalendarEvent,
  type EditScope,
  type EventInput,
  type Occurrence,
} from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import { currentLocale } from "@/lib/i18n/current";
import { addDays, localDay, localMinutes, zonedTime } from "./model";
import { RecurrenceEditor } from "./RecurrenceEditor";
import { reminderOptions, reminderValue } from "./reminders";
import { buildRule, formFor, parseRule, presetOf, presetRule, type Preset, type RuleForm } from "./rule";
import { rulePhrase } from "./rulePhrase";
import { SeriesScopeDialog } from "./SeriesScopeDialog";

const row: CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" };

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
  calendars: Calendar[];
  spaces: { id: string; name: string }[];
  timeZone: string;
  /** A new event: where it starts, and in which calendar it goes first. */
  draft?: { day: string; minutes?: number; calendarId?: string };
  /** An existing one: the occurrence opened, and its event. */
  editing?: { occurrence: Occurrence; event: CalendarEvent };
  onDone: (message: "saved" | "failed") => void;
  onCancel: () => void;
};

/**
 * Creating or changing an event: its title, calendar, times (or the whole day), repetition, the
 * author's own reminder, place and notes. The time zone shows only when it is not the viewer's. On a
 * phone it rises as a full-height panel, on a desktop it is a window.
 */
export function EventForm({ calendars, spaces, timeZone, draft, editing, onDone, onCancel }: EventFormProps) {
  const { t } = useTranslation();
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
    return { startDay: day, startTime: hhmm(start), endDay: start + 60 >= 1440 ? addDays(day, 1) : day, endTime: hhmm(start + 60) };
  }, [occurrence, draft, zone, timeZone]);

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

  return (
    <Dialog
      size="md"
      title={occurrence ? t("calendar.editEvent") : t("calendar.newEvent")}
      onClose={onCancel}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !calendarId}>
            {occurrence ? t("common.save") : t("common.create")}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
        <Field label={t("calendar.eventTitle")} htmlFor="event-title">
          <Input id="event-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={500} placeholder={t("calendar.eventTitlePlaceholder")} />
        </Field>
        <Field label={t("calendar.title")} htmlFor="event-calendar">
          <Select id="event-calendar" value={calendarId} onChange={(e) => setCalendarId(e.target.value)} disabled={Boolean(event?.isRecurring && occurrence?.recurrenceId)}>
            {calendarGroups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.spaceId ? `${spaceName(c.spaceId) ?? ""} · ${c.name}` : c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        <Switch label={t("calendar.allDayEvent")} checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        <div style={row}>
          <Field label={t("prefs.from")} htmlFor="event-start-day">
            <Input
              id="event-start-day"
              type="date"
              value={startDay}
              onChange={(e) => {
                const day = e.target.value;
                if (!day) return;
                setEndDay(addDays(endDay, dayDiff(startDay, day)));
                setStartDay(day);
              }}
              style={{ width: 170 }}
            />
          </Field>
          {!allDay ? (
            <Field label={t("calendar.startTime")} htmlFor="event-start-time">
              <Input
                id="event-start-time"
                type="time"
                value={startTime}
                onChange={(e) => {
                  const next = e.target.value;
                  if (!next) return;
                  // The end follows, keeping the length.
                  const length = minutesOf(endTime) - minutesOf(startTime) + dayDiff(startDay, endDay) * 1440;
                  const end = minutesOf(next) + Math.max(0, length);
                  setEndDay(addDays(startDay, Math.floor(end / 1440)));
                  setEndTime(hhmm(end));
                  setStartTime(next);
                }}
                style={{ width: 130 }}
              />
            </Field>
          ) : null}
        </div>
        <div style={row}>
          <Field label={t("prefs.to")} htmlFor="event-end-day">
            <Input id="event-end-day" type="date" value={endDay} min={startDay} onChange={(e) => e.target.value && setEndDay(e.target.value)} style={{ width: 170 }} />
          </Field>
          {!allDay ? (
            <Field label={t("calendar.endTime")} htmlFor="event-end-time">
              <Input id="event-end-time" type="time" value={endTime} onChange={(e) => e.target.value && setEndTime(e.target.value)} style={{ width: 130 }} />
            </Field>
          ) : null}
        </div>
        {!allDay && tz !== timeZone ? (
          <Field label={t("profile.timezone")} htmlFor="event-zone">
            <Select id="event-zone" value={tz} onChange={(e) => setTz(e.target.value)} options={zones} />
          </Field>
        ) : null}
        <Field label={t("calendar.repeat")} htmlFor="event-repeat">
          <Select
            id="event-repeat"
            value={preset}
            onChange={(e) => {
              const next = e.target.value as Preset | "imported";
              if (next === "custom") setCustom(formFor(rule(), startDay));
              setRuleTouched(true);
              setPreset(next);
            }}
            options={repeatOptions}
          />
        </Field>
        {preset === "custom" ? (
          <RecurrenceEditor
            form={custom}
            start={startDay}
            onChange={(next) => {
              setRuleTouched(true);
              setCustom(next);
            }}
          />
        ) : null}
        <Field label={t("calendar.myReminder")} htmlFor="event-reminder" hint={reminder === undefined ? t("calendar.reminderFollows") : undefined}>
          <Select
            id="event-reminder"
            value={reminder ?? "default"}
            onChange={(e) => setReminder(e.target.value === "default" ? undefined : e.target.value)}
            options={[{ value: "default", label: t("calendar.reminderAsCalendar") }, ...reminderOptions(allDay, t)]}
          />
        </Field>
        <Field label={t("calendar.location")} htmlFor="event-location" optional>
          <Input id="event-location" icon="map-pin" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={500} />
        </Field>
        <Field label={t("calendar.notes")} htmlFor="event-notes" optional>
          <Textarea id="event-notes" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={20000} rows={3} />
        </Field>
        {error ? (
          <p role="alert" style={{ margin: 0, color: "var(--action-danger-bg)", fontSize: "var(--text-xs)" }}>
            {error}
          </p>
        ) : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
