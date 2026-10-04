"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { Button, Dialog, Field, Input, Radio, Select } from "@/components/ds";
import {
  CALENDAR_COLORS,
  createCalendar,
  createFeed,
  deleteCalendar,
  listFeeds,
  revokeFeed,
  setCalendarMe,
  TIMED_REMINDERS,
  updateCalendar,
  type Calendar,
  type CalendarColor,
  type Feed,
} from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import { formatDate } from "@/lib/i18n/format";
import { colorVar } from "./OccurrenceChip";
import { reminderLabel, reminderValue } from "./reminders";

const section: CSSProperties = { display: "flex", flexDirection: "column", gap: 10, paddingTop: 14, borderTop: "1px solid var(--border-subtle)" };
const heading: CSSProperties = { margin: 0, fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--text-strong)" };
const muted: CSSProperties = { margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" };

/** The palette's names: the four the themes share are the themes' own words. */
const COLOR_KEYS = {
  sky: "prefs.themeSky",
  mint: "prefs.themeMint",
  violet: "prefs.themeViolet",
  pink: "prefs.themePink",
  peach: "calendar.color.peach",
  lime: "calendar.color.lime",
  sun: "calendar.color.sun",
} as const satisfies Record<CalendarColor, string>;

/**
 * The subscription addresses of one calendar (or, with `calendarId` null, of all of them together):
 * make one and copy it (it is shown once), see those already made and when a client last read
 * them, revoke one. With a short word on where to paste it.
 */
export function FeedsSection({ calendarId, onError }: { calendarId: string | null; onError: () => void }) {
  const { t } = useTranslation();
  const [feeds, setFeeds] = useState<Feed[] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    listFeeds(abort.signal)
      .then((all) => setFeeds(all.filter((f) => (f.calendarId ?? null) === calendarId)))
      .catch(() => {});
    return () => abort.abort();
  }, [calendarId]);

  const make = async () => {
    try {
      const made = await createFeed(calendarId);
      setFresh(made.url);
      setCopied(false);
      setFeeds((list) => [{ id: made.id, calendarId: made.calendarId, createdAt: made.createdAt }, ...(list ?? [])]);
    } catch {
      onError();
    }
  };
  const revoke = async (id: string) => {
    try {
      await revokeFeed(id);
      setFeeds((list) => list?.filter((f) => f.id !== id) ?? null);
    } catch {
      onError();
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={muted}>{calendarId ? t("calendar.subscribeIntro") : t("calendar.subscribeAllIntro")}</p>
      {fresh ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <Input readOnly value={fresh} aria-label={t("calendar.address")} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 0 }} />
            <Button
              onClick={() =>
                void navigator.clipboard?.writeText(fresh).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              {copied ? t("common.copied") : t("admin.copy")}
            </Button>
          </div>
          <p style={{ ...muted, color: "var(--text-strong)" }}>{t("calendar.addressOnce")}</p>
        </div>
      ) : (
        <div>
          <Button iconLeft="rss" onClick={() => void make()}>
            {t("calendar.newAddress")}
          </Button>
        </div>
      )}
      {feeds && feeds.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {feeds.map((f) => (
            <li key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
              <span style={{ flex: 1 }}>
                {t("calendar.addressCreated", { date: formatDate(f.createdAt) })}
                {" · "}
                {f.lastUsedAt ? t("calendar.addressUsed", { date: formatDate(f.lastUsedAt) }) : t("calendar.addressNeverUsed")}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void revoke(f.id)}>
                {t("dialogs.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <details>
        <summary style={{ cursor: "pointer", fontSize: "var(--text-xs)", color: "var(--text-link)" }}>{t("calendar.howTo")}</summary>
        <ul style={{ ...muted, paddingLeft: 18, marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
          <li>{t("calendar.howToIphone")}</li>
          <li>{t("calendar.howToAndroid")}</li>
          <li>{t("calendar.howToThunderbird")}</li>
        </ul>
      </details>
    </div>
  );
}

/** Subscribing to every calendar at once, from the sidebar. */
export function FeedsDialog({ onClose, onError }: { onClose: () => void; onError: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog size="md" title={t("calendar.subscribeAll")} onClose={onClose} closeLabel={t("common.close")} footer={<Button onClick={onClose}>{t("common.close")}</Button>}>
      <FeedsSection calendarId={null} onError={onError} />
    </Dialog>
  );
}

/**
 * A calendar's settings, or a new calendar. Its name and colour; for a space's calendar, who may add
 * events and the reminder its timed events get by default (for whoever manages it); the viewer's
 * own reminder for it; its subscription address; and deleting it, by typing its name.
 */
export function CalendarSettingsDialog({
  calendar,
  spaceId,
  spaceName,
  onDone,
  onClose,
}: {
  /** Absent for a new calendar. */
  calendar?: Calendar;
  /** For a new calendar: the space it goes in (none: the viewer's own). */
  spaceId?: string;
  spaceName?: string;
  onDone: (message: "saved" | "created" | "deleted" | "failed") => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const manage = !calendar || calendar.canManage;
  const inSpace = Boolean(calendar ? calendar.spaceId : spaceId);
  const [name, setName] = useState(calendar?.name ?? "");
  const [color, setColor] = useState<CalendarColor>(calendar?.color ?? (inSpace ? "mint" : "violet"));
  const [writeAccess, setWriteAccess] = useState(calendar?.writeAccess ?? "members");
  const [defaultReminder, setDefaultReminder] = useState(calendar ? (calendar.defaultReminderMinutes === null ? "none" : String(calendar.defaultReminderMinutes)) : "10");
  const [mine, setMine] = useState(calendar?.myReminderMinutes === undefined ? "default" : calendar.myReminderMinutes === null ? "none" : String(calendar.myReminderMinutes));
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const fields = {
        name: name.trim(),
        color,
        writeAccess: inSpace ? writeAccess : undefined,
        defaultReminderMinutes: reminderValue(defaultReminder),
      };
      if (calendar) {
        if (manage) await updateCalendar(calendar.id, fields);
        const before = calendar.myReminderMinutes === undefined ? "default" : calendar.myReminderMinutes === null ? "none" : String(calendar.myReminderMinutes);
        if (mine !== before) await setCalendarMe(calendar.id, { reminderMinutes: mine === "default" ? "default" : reminderValue(mine) });
        onDone("saved");
      } else {
        await createCalendar(fields, spaceId);
        onDone("created");
      }
    } catch {
      setBusy(false);
      onDone("failed");
    }
  };

  const remove = async () => {
    if (!calendar) return;
    setBusy(true);
    try {
      await deleteCalendar(calendar.id, confirm.trim());
      onDone("deleted");
    } catch {
      setBusy(false);
      onDone("failed");
    }
  };

  const timedOptions = [{ value: "none", label: reminderLabel(null, t) }, ...TIMED_REMINDERS.map((m) => ({ value: String(m), label: reminderLabel(m, t) }))];

  return (
    <Dialog
      size="md"
      title={calendar ? calendar.name : t("calendar.newCalendar")}
      subtitle={spaceName}
      onClose={onClose}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void save()}>
            {calendar ? t("common.save") : t("common.create")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {manage ? (
          <>
            <Field label={t("files.name")} htmlFor="calendar-name">
              <Input id="calendar-name" autoFocus={!calendar} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div role="radiogroup" aria-label={t("calendar.colorLabel")} style={{ display: "flex", gap: 8 }}>
              {CALENDAR_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={t(COLOR_KEYS[c])}
                  onClick={() => setColor(c)}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    background: colorVar(c),
                    border: color === c ? "2px solid var(--ink)" : "2px solid transparent",
                    outline: color === c ? "2px solid var(--surface)" : undefined,
                    outlineOffset: -4,
                    cursor: "pointer",
                  }}
                />
              ))}
            </div>
            {inSpace ? (
              <div role="radiogroup" aria-label={t("calendar.whoWrites")} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-strong)" }}>{t("calendar.whoWrites")}</span>
                <Radio name="write" checked={writeAccess === "members"} onChange={() => setWriteAccess("members")} label={t("calendar.writeMembers")} />
                <Radio name="write" checked={writeAccess === "admins"} onChange={() => setWriteAccess("admins")} label={t("calendar.writeAdmins")} />
              </div>
            ) : null}
            <Field label={t("calendar.defaultReminder")} hint={t("calendar.defaultReminderHint")} htmlFor="calendar-default-reminder">
              <Select id="calendar-default-reminder" value={defaultReminder} onChange={(e) => setDefaultReminder(e.target.value)} options={timedOptions} />
            </Field>
          </>
        ) : null}

        {calendar ? (
          <Field label={t("calendar.myReminder")} hint={t("calendar.myReminderHint")} htmlFor="calendar-my-reminder">
            <Select
              id="calendar-my-reminder"
              value={mine}
              onChange={(e) => setMine(e.target.value)}
              options={[
                { value: "default", label: t("calendar.reminderFollowsCalendar", { label: reminderLabel(calendar.defaultReminderMinutes, t) }) },
                ...timedOptions,
              ]}
            />
          </Field>
        ) : null}

        {calendar ? (
          <section style={section}>
            <h3 style={heading}>{t("calendar.subscribe")}</h3>
            <FeedsSection calendarId={calendar.id} onError={() => onDone("failed")} />
          </section>
        ) : null}

        {calendar && manage ? (
          <section style={section}>
            <h3 style={heading}>{t("calendar.deleteCalendar")}</h3>
            {calendar.isDefault ? (
              <p style={muted}>{t("calendar.isDefaultHint")}</p>
            ) : (
              <>
                <p style={muted}>{t("calendar.deleteCalendarHint", { name: calendar.name })}</p>
                <div style={{ display: "flex", gap: 8 }}>
                  <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label={t("calendar.typeName")} style={{ flex: 1 }} />
                  <Button variant="danger" disabled={busy || confirm.trim() !== calendar.name} onClick={() => void remove()}>
                    {t("common.delete")}
                  </Button>
                </div>
              </>
            )}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
