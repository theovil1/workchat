// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarPrefs, DEFAULT_CALENDAR_PREFS, isoWeek, startOfWeek, weekDays } from "./prefs.ts";

test("a_week_starts_on_the_chosen_day", () => {
  // 2026-10-08 is a Thursday.
  assert.equal(startOfWeek("2026-10-08", 1), "2026-10-05");
  assert.equal(startOfWeek("2026-10-08", 0), "2026-10-04");
  assert.equal(startOfWeek("2026-10-08", 6), "2026-10-03");
  // The first day itself starts its own week.
  assert.equal(startOfWeek("2026-10-04", 0), "2026-10-04");
});

test("the_week_view_can_leave_out_the_weekend", () => {
  assert.deepEqual(weekDays("2026-10-08", 1, true).length, 7);
  assert.deepEqual(weekDays("2026-10-08", 1, false), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
  // Starting on Sunday, the five working days are still Monday to Friday.
  assert.deepEqual(weekDays("2026-10-08", 0, false), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
});

test("iso_week_numbers", () => {
  assert.equal(isoWeek("2026-10-08"), 41);
  assert.equal(isoWeek("2026-01-01"), 1);
  // 2027-01-01 is a Friday: it belongs to the last week of 2026.
  assert.equal(isoWeek("2027-01-01"), 53);
  assert.equal(isoWeek("2024-12-30"), 1);
});

test("stored_preferences_are_read_back_safely", () => {
  assert.deepEqual(calendarPrefs(undefined), DEFAULT_CALENDAR_PREFS);
  assert.deepEqual(calendarPrefs("nonsense"), DEFAULT_CALENDAR_PREFS);
  const read = calendarPrefs({ viewDesktop: "month", weekStart: 0, clock: "12", weekends: false, workStart: 20, workEnd: 7, duration: 7, viewPhone: "week" });
  assert.equal(read.viewDesktop, "month");
  assert.equal(read.weekStart, 0);
  assert.equal(read.clock, "12");
  assert.equal(read.weekends, false);
  // The phone has no week view; a duration off the list, or working hours the wrong way round, fall back.
  assert.equal(read.viewPhone, DEFAULT_CALENDAR_PREFS.viewPhone);
  assert.equal(read.duration, DEFAULT_CALENDAR_PREFS.duration);
  assert.equal(read.workStart, DEFAULT_CALENDAR_PREFS.workStart);
  assert.equal(read.workEnd, DEFAULT_CALENDAR_PREFS.workEnd);
});

test("working_hours_are_off_until_turned_on", () => {
  assert.equal(DEFAULT_CALENDAR_PREFS.workHours, false);
  assert.equal(calendarPrefs({ workHours: true }).workHours, true);
  assert.equal(calendarPrefs({ workHours: "yes" }).workHours, false);
});
