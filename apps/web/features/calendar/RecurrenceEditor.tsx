"use client";

import type { CSSProperties } from "react";
import { Input, Radio, Select } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";
import { currentLocale } from "@/lib/i18n/current";
import { WEEKDAYS, type Frequency, type MonthlyMode, type RuleForm, type Weekday } from "./rule";
import { rulePhrase } from "./rulePhrase";

const DAY_KEYS = {
  MO: "calendar.rule.mo",
  TU: "calendar.rule.tu",
  WE: "calendar.rule.we",
  TH: "calendar.rule.th",
  FR: "calendar.rule.fr",
  SA: "calendar.rule.sa",
  SU: "calendar.rule.su",
} as const;

const NTH_KEYS = { 1: "calendar.rule.nth1", 2: "calendar.rule.nth2", 3: "calendar.rule.nth3", 4: "calendar.rule.nth4", [-1]: "calendar.rule.nthLast" } as const;

const row: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };
const group: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, padding: "10px 0", borderTop: "1px solid var(--border-subtle)" };
const groupTitle: CSSProperties = { fontSize: "var(--text-2xs)", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)" };

/** The initial of each weekday, Monday first, in the language in force. */
function initials(): string[] {
  return Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(currentLocale(), { weekday: "narrow", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 9, 19 + i, 12))),
  );
}

/**
 * The custom repetition: every N days, weeks, months or years; which days of the week; for a month,
 * the start's day, "the 2nd Thursday" or the last working day; and when it stops. A sentence under
 * it says the rule back in words, to check it at a glance.
 */
export function RecurrenceEditor({ form, start, onChange }: { form: RuleForm; start: string; onChange: (form: RuleForm) => void }) {
  const { t } = useTranslation();
  const set = (patch: Partial<RuleForm>) => onChange({ ...form, ...patch });
  const units: { value: Frequency; key: "calendar.unitDay" | "calendar.unitWeek" | "calendar.unitMonth" | "calendar.unitYear" }[] = [
    { value: "DAILY", key: "calendar.unitDay" },
    { value: "WEEKLY", key: "calendar.unitWeek" },
    { value: "MONTHLY", key: "calendar.unitMonth" },
    { value: "YEARLY", key: "calendar.unitYear" },
  ];
  const toggleDay = (day: Weekday) => {
    const days = form.days.includes(day) ? form.days.filter((d) => d !== day) : [...form.days, day];
    if (days.length > 0) set({ days: WEEKDAYS.filter((d) => days.includes(d)) });
  };
  const monthly = form.monthly;
  const nthDay: Extract<MonthlyMode, { mode: "nth" }> = monthly.mode === "nth" ? monthly : { mode: "nth", nth: 1, day: form.days[0] ?? "MO" };
  const startDay = Number(start.slice(8));
  const weekly = form.freq === "WEEKLY";
  const byMonth = form.freq === "MONTHLY";

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ ...row, paddingBottom: 10 }}>
        <span>{t("calendar.repeatEvery")}</span>
        <Input
          type="number"
          min={1}
          max={99}
          value={String(form.interval)}
          onChange={(e) => set({ interval: Math.max(1, Math.min(99, Number(e.target.value) || 1)) })}
          aria-label={t("calendar.interval")}
          style={{ width: 72 }}
        />
        <Select
          value={form.freq}
          onChange={(e) => set({ freq: e.target.value as Frequency })}
          aria-label={t("calendar.unit")}
          options={units.map((u) => ({ value: u.value, label: t(u.key, { count: form.interval }) }))}
        />
      </div>

      {weekly ? (
        <div style={group}>
          <span style={groupTitle}>{t("calendar.onDays")}</span>
          <div style={{ display: "flex", gap: 6 }}>
            {WEEKDAYS.map((day, i) => {
              const on = form.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  aria-label={t(DAY_KEYS[day])}
                  onClick={() => toggleDay(day)}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: "50%",
                    border: `1px solid ${on ? "var(--action-primary-bg)" : "var(--border-default)"}`,
                    background: on ? "var(--action-primary-bg)" : "var(--surface-card)",
                    color: on ? "var(--action-primary-fg)" : "var(--text-strong)",
                    cursor: "pointer",
                  }}
                >
                  {initials()[i]}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {byMonth ? (
        <div style={group}>
          <Radio name="monthly" checked={monthly.mode === "day"} onChange={() => set({ monthly: { mode: "day" } })} label={t("calendar.monthlyOnDay", { day: startDay })} />
          <div style={row}>
            <Radio name="monthly" checked={monthly.mode === "nth"} onChange={() => set({ monthly: nthDay })} label={t("calendar.monthlyOnWeekday")} />
            <Select
              value={String(nthDay.nth)}
              aria-label={t("calendar.whichWeek")}
              onChange={(e) => set({ monthly: { ...nthDay, nth: Number(e.target.value) as 1 | 2 | 3 | 4 | -1 } })}
              options={([1, 2, 3, 4, -1] as const).map((n) => ({ value: String(n), label: t(NTH_KEYS[n]) }))}
            />
            <Select
              value={nthDay.day}
              aria-label={t("calendar.whichDay")}
              onChange={(e) => set({ monthly: { ...nthDay, day: e.target.value as Weekday } })}
              options={WEEKDAYS.map((d) => ({ value: d, label: t(DAY_KEYS[d]) }))}
            />
          </div>
          <Radio
            name="monthly"
            checked={monthly.mode === "lastWorkday"}
            onChange={() => set({ monthly: { mode: "lastWorkday" } })}
            label={t("calendar.rule.lastWorkday", { count: 1 })}
          />
        </div>
      ) : null}

      <div style={group}>
        <span style={groupTitle}>{t("calendar.ends")}</span>
        <Radio name="end" checked={form.end.kind === "never"} onChange={() => set({ end: { kind: "never" } })} label={t("calendar.endNever")} />
        <div style={row}>
          <Radio name="end" checked={form.end.kind === "count"} onChange={() => set({ end: { kind: "count", count: 10 } })} label={t("calendar.endAfter")} />
          <Input
            type="number"
            min={1}
            max={999}
            disabled={form.end.kind !== "count"}
            value={form.end.kind === "count" ? String(form.end.count) : "10"}
            onChange={(e) => set({ end: { kind: "count", count: Math.max(1, Math.min(999, Number(e.target.value) || 1)) } })}
            aria-label={t("calendar.occurrences")}
            style={{ width: 80 }}
          />
          <span>{t("calendar.times")}</span>
        </div>
        <div style={row}>
          <Radio name="end" checked={form.end.kind === "until"} onChange={() => set({ end: { kind: "until", date: start } })} label={t("calendar.endUntil")} />
          <Input
            type="date"
            disabled={form.end.kind !== "until"}
            value={form.end.kind === "until" ? form.end.date : start}
            min={start}
            onChange={(e) => e.target.value && set({ end: { kind: "until", date: e.target.value } })}
            aria-label={t("calendar.endDate")}
            style={{ width: 170 }}
          />
        </div>
      </div>

      <p role="status" style={{ margin: "4px 0 0", padding: "8px 10px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", color: "var(--text-strong)", fontSize: "var(--text-xs)" }}>
        {rulePhrase(form, start, currentLocale(), (key, vars) => t(key as Parameters<typeof t>[0], vars))}
      </p>
    </div>
  );
}
