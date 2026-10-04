/**
 * The calendar screen's pure logic: days and periods in a time zone, which occurrences a filter
 * keeps, and where a day's events sit on its grid.
 *
 * Nothing here imports anything, on purpose: the module runs as is under Node's test runner
 * (`model.test.ts`), and every view (month, week, day, list, phone and desktop) asks it the same
 * questions.
 *
 * Days are written `YYYY-MM-DD` and instants as RFC 3339. A day is always a day of the viewer's time
 * zone, read with `Intl` so that a change of time (a 23- or 25-hour day) lands where it should.
 */

/** Which calendars the screen shows in full: all of them, or one space's (and the viewer's own). */
export type Filter = { kind: "all" } | { kind: "space"; spaceId: string };

/** The views of the screen. */
export type View = "month" | "week" | "day" | "list";

const DAY_MS = 86_400_000;

/** The wall clock of `tz` at an instant, as numbers. */
function wallClock(at: number, tz: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  // Read, never shown: a fixed language keeps the digits and the 24-hour clock predictable.
  // i18n-audit-ignore-next-line
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** How far ahead of UTC `tz` is at an instant, in milliseconds. */
function offsetAt(at: number, tz: string): number {
  const w = wallClock(at, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(at / 1000) * 1000;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dayParts(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y, m, d];
}

/** The day `n` days after `day`. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = dayParts(day);
  const at = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/** Monday 0 to Sunday 6. */
export function weekdayOf(day: string): number {
  const [y, m, d] = dayParts(day);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** The instant at which the wall clock of `tz` shows `minutes` past midnight on `day`. */
export function zonedTime(day: string, minutes: number, tz: string): string {
  const [y, m, d] = dayParts(day);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let at = guess - offsetAt(guess, tz);
  const second = guess - offsetAt(at, tz);
  if (second !== at) at = second;
  return new Date(at).toISOString();
}

/** The day of `tz` an instant falls on. */
export function localDay(at: string, tz: string): string {
  const w = wallClock(Date.parse(at), tz);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** Minutes past local midnight of an instant in `tz`. */
export function localMinutes(at: string, tz: string): number {
  const w = wallClock(Date.parse(at), tz);
  return w.hour * 60 + w.minute;
}

/** The period a view shows around `anchor`: a day, a Monday-to-Sunday week, a six-week month grid,
 *  or thirty days of list. */
export function rangeFor(view: View, anchor: string, tz: string): { from: string; to: string } {
  let first = anchor;
  let days = 1;
  if (view === "week") {
    first = addDays(anchor, -weekdayOf(anchor));
    days = 7;
  } else if (view === "month") {
    const monthStart = `${anchor.slice(0, 8)}01`;
    first = addDays(monthStart, -weekdayOf(monthStart));
    days = 42;
  } else if (view === "list") {
    days = 30;
  }
  return { from: zonedTime(first, 0, tz), to: zonedTime(addDays(first, days), 0, tz) };
}

/** Whether an occurrence is shown in full under `filter`. A personal calendar always is; outside the
 *  filter, the others are drawn struck through, not hidden. */
export function inFilter(
  occurrence: { calendarId: string },
  calendars: ReadonlyArray<{ id: string; spaceId?: string }>,
  filter: Filter,
): boolean {
  const calendar = calendars.find((c) => c.id === occurrence.calendarId);
  if (!calendar) return false;
  if (!calendar.spaceId || filter.kind === "all") return true;
  return calendar.spaceId === filter.spaceId;
}

/** An event placed on a day's grid, in minutes from local midnight. */
export type Positioned<T> = { item: T; top: number; height: number; column: number; columns: number };

/** The shortest an event is drawn, so a five-minute call can still be read and tapped. */
export const MIN_HEIGHT = 15;

/**
 * Where a day's timed events sit: their top and height in minutes, and, for events that overlap,
 * side by side columns sharing the width. An event running over midnight is cut to the part on this
 * day. All-day events are not laid out here (they go in the band above the grid).
 */
export function layoutDay<T extends { allDay: boolean; start: string; end: string }>(
  items: readonly T[],
  day: string,
  tz: string,
): Positioned<T>[] {
  const dayStart = Date.parse(zonedTime(day, 0, tz));
  const dayEnd = Date.parse(zonedTime(addDays(day, 1), 0, tz));
  const placed = items
    .filter((item) => !item.allDay)
    .map((item) => {
      const start = Date.parse(item.start);
      const end = Math.max(Date.parse(item.end), start);
      const from = Math.max(start, dayStart);
      const to = Math.min(end, dayEnd);
      const inside = start === end ? start >= dayStart && start < dayEnd : to > from;
      return { item, from, to, inside };
    })
    .filter((p) => p.inside)
    .sort((a, b) => a.from - b.from || b.to - a.to);

  const out: Positioned<T>[] = [];
  let cluster: Positioned<T>[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -Infinity;
  const close = () => {
    for (const p of cluster) p.columns = columnEnds.length;
    out.push(...cluster);
    cluster = [];
    columnEnds = [];
  };
  for (const p of placed) {
    const shownEnd = Math.max(p.to, p.from + MIN_HEIGHT * 60_000);
    if (p.from >= clusterEnd) {
      close();
      clusterEnd = -Infinity;
    }
    let column = columnEnds.findIndex((end) => end <= p.from);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(shownEnd);
    } else {
      columnEnds[column] = shownEnd;
    }
    clusterEnd = Math.max(clusterEnd, shownEnd);
    const top = p.from === dayStart ? 0 : localMinutes(new Date(p.from).toISOString(), tz);
    cluster.push({
      item: p.item,
      top,
      height: Math.max(MIN_HEIGHT, Math.round((p.to - p.from) / 60_000)),
      column,
      columns: 0,
    });
  }
  close();
  return out;
}
