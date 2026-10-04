/**
 * The reminder choices a menu offers, worded in the language in force.
 */

import { ALL_DAY_REMINDERS, TIMED_REMINDERS } from "@/lib/data/calendar";
import type { Translate } from "@/lib/i18n";

/** How a reminder of `minutes` reads: "10 min avant", "La veille à 17 h"; `null` is none. */
export function reminderLabel(minutes: number | null | undefined, t: Translate): string {
  if (minutes === null || minutes === undefined) return t("calendar.reminderNone");
  if (minutes === 420) return t("calendar.reminderEve");
  if (minutes === -540) return t("calendar.reminderMorning");
  if (minutes === 0) return t("calendar.reminderAtStart");
  if (minutes % 1440 === 0) return t("calendar.reminderDays", { count: minutes / 1440 });
  if (minutes % 60 === 0) return t("calendar.reminderHours", { count: minutes / 60 });
  return t("calendar.reminderMinutes", { count: minutes });
}

/** The options of a reminder menu, as `Select` options; the value `none` is no reminder. */
export function reminderOptions(allDay: boolean, t: Translate): { value: string; label: string }[] {
  const delays: readonly number[] = allDay ? ALL_DAY_REMINDERS : TIMED_REMINDERS;
  return [{ value: "none", label: reminderLabel(null, t) }, ...delays.map((m) => ({ value: String(m), label: reminderLabel(m, t) }))];
}

/** Read a reminder menu's value back. */
export function reminderValue(value: string): number | null {
  return value === "none" ? null : Number(value);
}
