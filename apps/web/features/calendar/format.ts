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

/** "09:00", or "9:00 AM" where that is what a clock says. */
export function clock(at: string, timeZone: string): string {
  return new Intl.DateTimeFormat(currentLocale(), { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(at));
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

/** The initial of each weekday, Monday first, for the month grid's head. */
export function weekdayInitials(): string[] {
  // 2026-10-19 is a Monday.
  return Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(currentLocale(), { weekday: "narrow", timeZone: "UTC" }).format(utcNoon(`2026-10-${19 + i}`)),
  );
}

/** What a view's title says: "octobre 2026", or a day for the day view. */
export function periodTitle(view: View, anchor: string): string {
  if (view === "day") return longDay(anchor);
  return capitalized(new Intl.DateTimeFormat(currentLocale(), { month: "long", year: "numeric", timeZone: "UTC" }).format(utcNoon(anchor)));
}
