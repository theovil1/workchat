"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { Button, Dialog, Field, Icon, Select } from "@/components/ds";
import { deleteEvent, getEvent, setEventMe, type Calendar, type CalendarEvent, type EditScope, type Occurrence } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import { currentLocale } from "@/lib/i18n/current";
import { clock, longDay } from "./format";
import { addDays, localDay } from "./model";
import { colorVar } from "./OccurrenceChip";
import { reminderOptions, reminderValue } from "./reminders";
import { parseRule } from "./rule";
import { rulePhrase } from "./rulePhrase";
import { SeriesScopeDialog } from "./SeriesScopeDialog";

const line: CSSProperties = { display: "flex", gap: 10, alignItems: "flex-start", color: "var(--text-body)", fontSize: "var(--text-sm)" };

/** When an occurrence happens, in words: "Lundi 5 octobre, 09:00 - 09:45", or its days. */
export function whenText(o: Occurrence, timeZone: string): string {
  if (o.allDay) {
    const last = addDays(o.end, -1);
    return last === o.start ? longDay(o.start) : `${longDay(o.start)} - ${longDay(last)}`;
  }
  const startDay = localDay(o.start, timeZone);
  const endDay = localDay(o.end, timeZone);
  if (startDay === endDay) return `${longDay(startDay)}, ${clock(o.start, timeZone)} - ${clock(o.end, timeZone)}`;
  return `${longDay(startDay)}, ${clock(o.start, timeZone)} - ${longDay(endDay)}, ${clock(o.end, timeZone)}`;
}

/**
 * An occurrence opened: when, how it repeats, in which calendar, where, the notes, and the viewer's
 * own reminder (which anyone who sees the event may set, whether or not they may change it). Who
 * may change it gets "Edit" and "Delete".
 */
export function EventDetails({
  occurrence,
  calendar,
  calendarLabel,
  timeZone,
  onEdit,
  onDone,
  onClose,
}: {
  occurrence: Occurrence;
  calendar?: Calendar;
  calendarLabel: string;
  timeZone: string;
  onEdit: (event: CalendarEvent) => void;
  onDone: (message: "deleted" | "failed") => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const [reminder, setReminder] = useState<string>("default");
  const [asking, setAsking] = useState<"scope" | "confirm" | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    getEvent(occurrence.eventId, abort.signal)
      .then(setEvent)
      .catch(() => {});
    return () => abort.abort();
  }, [occurrence.eventId]);

  const form = event?.rrule ? parseRule(event.rrule) : null;
  const repeats = event?.rrule
    ? form
      ? rulePhrase(form, event.allDay ? event.start : localDay(event.start, event.tzid ?? timeZone), currentLocale(), (k, v) => t(k as Parameters<typeof t>[0], v))
      : t("calendar.importedRule")
    : null;

  const remove = async (scope: EditScope) => {
    try {
      await deleteEvent(occurrence.eventId, scope, occurrence.recurrenceId);
      onDone("deleted");
    } catch {
      onDone("failed");
    }
  };

  if (asking === "scope") {
    return <SeriesScopeDialog title={occurrence.title} action="delete" onCancel={() => setAsking(null)} onChoose={(scope) => void remove(scope)} />;
  }
  if (asking === "confirm") {
    return (
      <Dialog
        size="sm"
        title={t("calendar.deleteConfirm", { title: occurrence.title })}
        onClose={() => setAsking(null)}
        closeLabel={t("common.close")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsking(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={() => void remove("all")}>
              {t("common.delete")}
            </Button>
          </>
        }
      />
    );
  }

  return (
    <Dialog
      size="md"
      title={occurrence.title}
      onClose={onClose}
      closeLabel={t("common.close")}
      footer={
        occurrence.canEdit ? (
          <>
            <Button variant="danger" onClick={() => setAsking(occurrence.isRecurring && occurrence.recurrenceId ? "scope" : "confirm")}>
              {t("common.delete")}
            </Button>
            <Button variant="primary" iconLeft="square-pen" disabled={!event} onClick={() => event && onEdit(event)}>
              {t("message.edit")}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>{t("common.close")}</Button>
        )
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={line}>
          <Icon name="clock" size={16} />
          <span>{whenText(occurrence, timeZone)}</span>
        </div>
        {repeats ? (
          <div style={line}>
            <Icon name="repeat" size={16} />
            <span>{repeats}</span>
          </div>
        ) : null}
        <div style={line}>
          <span aria-hidden style={{ width: 12, height: 12, margin: 2, borderRadius: 4, flex: "none", background: colorVar(calendar?.color) }} />
          <span>{calendarLabel}</span>
        </div>
        {occurrence.location ? (
          <div style={line}>
            <Icon name="map-pin" size={16} />
            <span>{occurrence.location}</span>
          </div>
        ) : null}
        {event?.description ? <p style={{ margin: 0, whiteSpace: "pre-wrap", color: "var(--text-body)", fontSize: "var(--text-sm)" }}>{event.description}</p> : null}
        <Field label={t("calendar.myReminder")} htmlFor="details-reminder">
          <Select
            id="details-reminder"
            value={reminder}
            onChange={(e) => {
              const next = e.target.value;
              setReminder(next);
              void setEventMe(occurrence.eventId, next === "default" ? "default" : reminderValue(next)).catch(() => onDone("failed"));
            }}
            options={[{ value: "default", label: t("calendar.reminderAsCalendar") }, ...reminderOptions(occurrence.allDay, t)]}
          />
        </Field>
      </div>
    </Dialog>
  );
}
