"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { Button, Dialog, Field, Icon, Select, Tabs } from "@/components/ds";
import {
  deleteEvent,
  getEvent,
  respondToEvent,
  setEventMe,
  type AttendeeStatus,
  type Calendar,
  type CalendarEvent,
  type EditScope,
  type Occurrence,
} from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import { currentLocale } from "@/lib/i18n/current";
import { clock, longDay } from "./format";
import { addDays, localDay } from "./model";
import { STATUS_LOOK } from "./AttendeesField";
import { colorVar, INVITATIONS_COLOR } from "./OccurrenceChip";
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

const ANSWERS: { status: Exclude<AttendeeStatus, "needs_action">; key: "calendar.answer.accepted" | "calendar.answer.tentative" | "calendar.answer.declined" }[] = [
  { status: "accepted", key: "calendar.answer.accepted" },
  { status: "tentative", key: "calendar.answer.tentative" },
  { status: "declined", key: "calendar.answer.declined" },
];

/**
 * An occurrence opened: when, how it repeats, in which calendar, where, who organises it and who is
 * invited (with their answers), the notes, and the viewer's own reminder (which anyone who sees the
 * event may set, whether or not they may change it). An invitee answers here, for the series or for
 * this date alone. Who may change the event gets "Edit" and "Delete".
 */
export function EventDetails({
  occurrence,
  calendar,
  calendarLabel,
  timeZone,
  viewerId,
  onEdit,
  onDone,
  onChanged,
  onClose,
}: {
  occurrence: Occurrence;
  calendar?: Calendar;
  calendarLabel: string;
  timeZone: string;
  viewerId?: string;
  onEdit: (event: CalendarEvent) => void;
  onDone: (message: "deleted" | "failed") => void;
  /** Something was saved that leaves the window open (an answer): the screen reloads. */
  onChanged: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const [reminder, setReminder] = useState<string>("default");
  const [asking, setAsking] = useState<"scope" | "confirm" | null>(null);
  // This occurrence's answer as shown, and whether a series' answer is for this date alone.
  const [myStatus, setMyStatus] = useState<AttendeeStatus | undefined>(occurrence.myStatus);
  const [onlyThisDate, setOnlyThisDate] = useState(false);
  const [answering, setAnswering] = useState(false);

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

  const isOrganizer = Boolean(event && viewerId && event.organizer?.userId === viewerId);
  const onList = Boolean(event && viewerId && event.attendees.some((a) => a.userId === viewerId));
  const answer = async (status: Exclude<AttendeeStatus, "needs_action">) => {
    setAnswering(true);
    try {
      const recurrenceId = occurrence.isRecurring && onlyThisDate ? occurrence.recurrenceId : undefined;
      const updated = await respondToEvent(occurrence.eventId, status, recurrenceId);
      setEvent(updated);
      setMyStatus(status);
      onChanged();
    } catch {
      onDone("failed");
    } finally {
      setAnswering(false);
    }
  };
  const counts = (event?.attendees ?? []).reduce(
    (acc, a) => ({ ...acc, [a.status]: (acc[a.status] ?? 0) + 1 }),
    {} as Partial<Record<AttendeeStatus, number>>,
  );
  const summary = [
    counts.accepted ? t("calendar.countAccepted", { count: counts.accepted }) : null,
    counts.tentative ? t("calendar.countTentative", { count: counts.tentative }) : null,
    counts.declined ? t("calendar.countDeclined", { count: counts.declined }) : null,
    counts.needs_action ? t("calendar.countWaiting", { count: counts.needs_action }) : null,
  ]
    .filter(Boolean)
    .join(", ");

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
          <span aria-hidden style={{ width: 12, height: 12, margin: 2, borderRadius: 4, flex: "none", background: colorVar(calendar?.color ?? (occurrence.invited ? INVITATIONS_COLOR : undefined)) }} />
          <span>{calendarLabel}</span>
        </div>
        {occurrence.location ? (
          <div style={line}>
            <Icon name="map-pin" size={16} />
            <span>{occurrence.location}</span>
          </div>
        ) : null}
        {event?.organizer && event.attendees.length > 0 ? (
          <div style={line}>
            <Icon name="users" size={16} />
            <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, flex: 1 }}>
              <span>
                {t("calendar.organizedBy", { name: isOrganizer ? t("calendar.me") : event.organizer.name })}
                {summary ? <span style={{ color: "var(--text-muted)" }}> · {summary}</span> : null}
              </span>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 4 }}>
                {event.attendees.map((a) => {
                  const look = STATUS_LOOK[a.status];
                  return (
                    <li
                      key={a.id}
                      title={t(`calendar.status.${a.status}`)}
                      style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px 2px 3px", borderRadius: 999, background: "var(--surface-sunken)", fontSize: "var(--text-xs)" }}
                    >
                      <span aria-hidden style={{ width: 16, height: 16, borderRadius: "50%", background: look.color, color: "var(--on-pastel)", display: "grid", placeItems: "center" }}>
                        <Icon name={look.icon} size={10} />
                      </span>
                      <span>{a.userId === viewerId ? t("calendar.me") : a.name}</span>
                      <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{t(`calendar.status.${a.status}`)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        ) : null}
        {onList && !isOrganizer ? (
          <div role="group" aria-label={t("calendar.yourAnswer")} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", borderRadius: "var(--radius-md)", background: "var(--surface-sunken)" }}>
            <span style={{ fontSize: "var(--text-xs)", fontWeight: 700, color: "var(--text-strong)" }}>{t("calendar.yourAnswer")}</span>
            {occurrence.isRecurring && occurrence.recurrenceId ? (
              <Tabs
                variant="pills"
                className="wc-tabs--accent"
                items={[
                  { value: "series", label: t("calendar.answerSeries") },
                  { value: "date", label: t("calendar.answerThisDate") },
                ]}
                value={onlyThisDate ? "date" : "series"}
                onChange={(v) => setOnlyThisDate(v === "date")}
              />
            ) : null}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {ANSWERS.map(({ status, key }) => {
                const on = myStatus === status;
                return (
                  <Button
                    key={status}
                    size="sm"
                    variant={on ? "primary" : "secondary"}
                    iconLeft={STATUS_LOOK[status].icon}
                    aria-pressed={on}
                    disabled={answering}
                    onClick={() => void answer(status)}
                  >
                    {t(key)}
                  </Button>
                );
              })}
            </div>
          </div>
        ) : null}
        {occurrence.description ? <p style={{ margin: 0, whiteSpace: "pre-wrap", color: "var(--text-body)", fontSize: "var(--text-sm)" }}>{occurrence.description}</p> : null}
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
