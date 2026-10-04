/**
 * The calendar's dates and times, in the language in force and the viewer's time zone.
 *
 * `lib/i18n/format.ts` reads times in the browser's zone; the calendar reads them in the zone of the
 * viewer's profile, which is the one their events are drawn in.
 */

import { currentLocale } from "@/lib/i18n/current";
import type { View } from "./model";

/** The first letter in capitals, as a heading starts: "Lundi 5 octobre", not "Lundi 5 Octobre". */
export function capitalized(text: string): string {
  return text.charAt(0).toLocaleUpperCase(currentLocale()) + text.slice(1);
}

function utcNoon(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

let clockFormat: "auto" | "24" | "12" = "auto";

/** The clock the viewer chose in their preferences: the calendar screen sets it as it draws. */
export function setClockFormat(format: "auto" | "24" | "12"): void {
  clockFormat = format;
}

/** "09:00", or "9:00 AM" where that is what a clock says (or what the viewer chose). */
export function clock(at: string, timeZone: string): string {
  const cycle = clockFormat === "24" ? { hourCycle: "h23" as const } : clockFormat === "12" ? { hourCycle: "h12" as const } : {};
  return new Intl.DateTimeFormat(currentLocale(), { hour: "2-digit", minute: "2-digit", timeZone, ...cycle }).format(new Date(at));
}

/** An hour in the grid's margin: "09:00", or "9 AM" on a 12-hour clock, short enough for it. */
export function hourLabel(hour: number): string {
  const cycle = clockFormat === "24" ? { hourCycle: "h23" as const } : clockFormat === "12" ? { hourCycle: "h12" as const } : {};
  const format = new Intl.DateTimeFormat(currentLocale(), { hour: "numeric", timeZone: "UTC", ...cycle });
  const at = new Date(Date.UTC(2000, 0, 1, hour));
  return format.resolvedOptions().hour12 ? format.format(at) : clock(at.toISOString(), "UTC");
}

/** A day as a heading: "lundi 19 octobre". */
export function longDay(day: string): string {
  return capitalized(new Intl.DateTimeFormat(currentLocale(), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(utcNoon(day)));
}

/** A day in a column head: "lun. 19". */
export function shortDay(day: string): { weekday: string; date: string } {
  const at = utcNoon(day);
  return {
    weekday: new Intl.DateTimeFormat(currentLocale(), { weekday: "short", timeZone: "UTC" }).format(at),
    date: String(at.getUTCDate()),
  };
}

/** The initial of each weekday, from the first day of the week (Sunday 0, Monday 1, Saturday 6),
 *  for the month grid's head. */
export function weekdayInitials(weekStart = 1): string[] {
  // 2026-10-18 is a Sunday.
  return Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(currentLocale(), { weekday: "narrow", timeZone: "UTC" }).format(utcNoon(`2026-10-${18 + ((weekStart + i) % 7)}`)),
  );
}

/** What a view's title says: "octobre 2026", or a day for the day view. */
export function periodTitle(view: View, anchor: string): string {
  if (view === "day") return longDay(anchor);
  return capitalized(new Intl.DateTimeFormat(currentLocale(), { month: "long", year: "numeric", timeZone: "UTC" }).format(utcNoon(anchor)));
}
