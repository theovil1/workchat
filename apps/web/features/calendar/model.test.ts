// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { clashes, freeColor, inFilter, layoutDay, localDay, MIN_HEIGHT, occursOn, rangeFor, zonedTime } from "./model.ts";

const PARIS = "Europe/Paris";

test("overlapping_events_share_the_width", () => {
  const items = [
    { id: "a", allDay: false, start: "2026-10-20T07:00:00Z", end: "2026-10-20T08:00:00Z" },
    { id: "b", allDay: false, start: "2026-10-20T07:30:00Z", end: "2026-10-20T08:30:00Z" },
    { id: "c", allDay: false, start: "2026-10-20T12:00:00Z", end: "2026-10-20T13:00:00Z" },
    // Another day, and an all-day one: not laid out on this day's grid.
    { id: "d", allDay: false, start: "2026-10-21T07:00:00Z", end: "2026-10-21T08:00:00Z" },
    { id: "e", allDay: true, start: "2026-10-20", end: "2026-10-21" },
  ];
  const laid = layoutDay(items, "2026-10-20", PARIS);
  const by = Object.fromEntries(laid.map((p) => [p.item.id, p]));
  assert.deepEqual(Object.keys(by).sort(), ["a", "b", "c"]);
  assert.deepEqual([by.a.top, by.a.height, by.a.column, by.a.columns], [540, 60, 0, 2]);
  assert.deepEqual([by.b.top, by.b.height, by.b.column, by.b.columns], [570, 60, 1, 2]);
  assert.deepEqual([by.c.top, by.c.column, by.c.columns], [840, 0, 1]);
});

test("a short or overnight event stays readable on its day", () => {
  const items = [
    { id: "short", allDay: false, start: "2026-10-20T07:00:00Z", end: "2026-10-20T07:05:00Z" },
    { id: "night", allDay: false, start: "2026-10-20T20:00:00Z", end: "2026-10-21T06:00:00Z" },
  ];
  const laid = Object.fromEntries(layoutDay(items, "2026-10-20", PARIS).map((p) => [p.item.id, p]));
  assert.equal(laid.short.height, MIN_HEIGHT);
  // 22:00 to midnight on the 20th.
  assert.deepEqual([laid.night.top, laid.night.height], [1320, 120]);
  const next = layoutDay(items, "2026-10-21", PARIS);
  assert.deepEqual(next.map((p) => [p.item.id, p.top, p.height]), [["night", 0, 480]]);
});

test("personal_calendars_are_always_in_the_filter", () => {
  const calendars = [{ id: "perso" }, { id: "general", spaceId: "s1" }];
  assert.equal(inFilter({ calendarId: "perso" }, calendars, { kind: "space", spaceId: "s2" }), true);
  assert.equal(inFilter({ calendarId: "perso" }, calendars, { kind: "all" }), true);
});

test("other_spaces_are_out_of_a_space_filter", () => {
  const calendars = [{ id: "general", spaceId: "s1" }, { id: "velo", spaceId: "s2" }];
  assert.equal(inFilter({ calendarId: "general" }, calendars, { kind: "space", spaceId: "s1" }), true);
  assert.equal(inFilter({ calendarId: "velo" }, calendars, { kind: "space", spaceId: "s1" }), false);
  assert.equal(inFilter({ calendarId: "velo" }, calendars, { kind: "all" }), true);
});

test("periods start on local midnights, across a change of time", () => {
  // The week of Wednesday 21 October 2026 in Paris: Monday 19 (summer) to Monday 26 (winter).
  assert.deepEqual(rangeFor("week", "2026-10-21", PARIS), {
    from: "2026-10-18T22:00:00.000Z",
    to: "2026-10-25T23:00:00.000Z",
  });
  assert.deepEqual(rangeFor("day", "2026-10-25", PARIS), {
    from: "2026-10-24T22:00:00.000Z",
    to: "2026-10-25T23:00:00.000Z",
  });
  // A month grid: six weeks from the Monday on or before the 1st.
  const month = rangeFor("month", "2026-10-21", PARIS);
  assert.equal(month.from, "2026-09-27T22:00:00.000Z");
  assert.equal(month.to, "2026-11-08T23:00:00.000Z");
  const list = rangeFor("list", "2026-10-21", PARIS);
  assert.equal(list.from, "2026-10-20T22:00:00.000Z");
  assert.equal(list.to, "2026-11-19T23:00:00.000Z");
});

test("local days and wall times read in the zone", () => {
  assert.equal(localDay("2026-10-20T22:30:00Z", PARIS), "2026-10-21");
  assert.equal(localDay("2026-10-20T22:30:00Z", "America/New_York"), "2026-10-20");
  assert.equal(zonedTime("2026-10-26", 9 * 60, PARIS), "2026-10-26T08:00:00.000Z");
  assert.equal(zonedTime("2026-07-01", 9 * 60, PARIS), "2026-07-01T07:00:00.000Z");
});

test("an occurrence is on every local day it touches", () => {
  const night = { allDay: false, start: "2026-10-20T20:00:00Z", end: "2026-10-21T06:00:00Z" };
  assert.equal(occursOn(night, "2026-10-20", PARIS), true);
  assert.equal(occursOn(night, "2026-10-21", PARIS), true);
  assert.equal(occursOn(night, "2026-10-22", PARIS), false);
  // Ending exactly at midnight does not spill over.
  const evening = { allDay: false, start: "2026-10-20T18:00:00Z", end: "2026-10-20T22:00:00Z" };
  assert.equal(occursOn(evening, "2026-10-21", PARIS), false);
  const leave = { allDay: true, start: "2026-10-07", end: "2026-10-09" };
  assert.deepEqual(["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"].map((d) => occursOn(leave, d, PARIS)), [false, true, true, false]);
  const instant = { allDay: false, start: "2026-10-20T07:00:00Z", end: "2026-10-20T07:00:00Z" };
  assert.equal(occursOn(instant, "2026-10-20", PARIS), true);
});

test("short events drawn at their minimum height never overlap", () => {
  // 9:00-9:10 and 9:15-9:30: each is drawn taller than it lasts, so they must sit side by side.
  const items = [
    { id: "a", allDay: false, start: "2026-10-20T07:00:00Z", end: "2026-10-20T07:10:00Z" },
    { id: "b", allDay: false, start: "2026-10-20T07:15:00Z", end: "2026-10-20T07:30:00Z" },
  ];
  const laid = layoutDay(items, "2026-10-20", PARIS);
  for (const p of laid) assert.ok(p.height >= MIN_HEIGHT);
  assert.deepEqual(laid.map((p) => [p.item.id, p.column, p.columns]), [["a", 0, 2], ["b", 1, 2]]);
  // The grid draws an hour 48 px tall: the minimum is what a title needs (18 px).
  assert.ok((MIN_HEIGHT / 60) * 48 >= 18);
});

test("a_new_calendar_takes_the_colour_used_least", () => {
  assert.equal(freeColor([]), "mint");
  assert.equal(freeColor([{ color: "accent" }, { color: "mint" }]), "violet");
  assert.equal(freeColor([{ color: "mint" }, { color: "violet" }, { color: "peach" }, { color: "mint" }]), "lime");
});

test("a_new_event_clashes_with_what_overlaps_it_in_any_calendar", () => {
  const timed = (eventId: string, start: string, end: string) => ({ eventId, allDay: false, start, end });
  const found = [
    timed("a", "2026-10-08T08:00:00Z", "2026-10-08T09:00:00Z"), // 10:00 - 11:00 in Paris
    timed("b", "2026-10-08T09:00:00Z", "2026-10-08T10:00:00Z"), // starts as ours ends: no clash
    timed("c", "2026-10-08T07:30:00Z", "2026-10-08T08:30:00Z"),
    { eventId: "d", allDay: true, start: "2026-10-08", end: "2026-10-09" },
    { eventId: "e", allDay: true, start: "2026-10-09", end: "2026-10-10" },
  ];
  // 10:30 - 11:00 in Paris.
  const ours = { start: "2026-10-08T08:30:00Z", end: "2026-10-08T09:00:00Z" };
  assert.deepEqual(clashes(found, ours, PARIS).map((o) => o.eventId), ["a", "d"]);
  // The event being edited does not clash with itself.
  assert.deepEqual(clashes(found, ours, PARIS, "a").map((o) => o.eventId), ["d"]);
});
