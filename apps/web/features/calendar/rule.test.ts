// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRule, parseRule, presetOf, presetRule } from "./rule.ts";

/** The end of a day in UTC, as a timed rule's UNTIL needs it; Paris for these tests. */
const parisEnd = (day: string) => {
  const summer = day >= "2026-03-29" && day < "2026-10-25";
  return `${day.replaceAll("-", "")}T${summer ? "215959" : "225959"}Z`;
};
const utcEnd = (day: string) => `${day.replaceAll("-", "")}T235959Z`;

test("rule_round_trip", () => {
  for (const [rule, allDay] of [
    ["FREQ=DAILY", false],
    ["FREQ=DAILY;INTERVAL=3", false],
    ["FREQ=WEEKLY;BYDAY=MO", false],
    ["FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", false],
    ["FREQ=WEEKLY;BYDAY=MO;COUNT=10", false],
    ["FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20270630T235959Z", false],
    ["FREQ=MONTHLY", false],
    ["FREQ=MONTHLY;INTERVAL=3", false],
    ["FREQ=MONTHLY;BYDAY=2TH", false],
    ["FREQ=MONTHLY;BYDAY=-1FR", false],
    ["FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", false],
    ["FREQ=YEARLY", true],
    ["FREQ=YEARLY;UNTIL=20300101", true],
  ] as const) {
    const form = parseRule(rule);
    assert.ok(form, rule);
    assert.equal(buildRule(form, allDay, utcEnd), rule);
  }
  // What the editor cannot show is said so, rather than mangled.
  for (const rule of ["FREQ=YEARLY;BYWEEKNO=20", "FREQ=HOURLY", "FREQ=MONTHLY;BYMONTHDAY=15", "nonsense"]) {
    assert.equal(parseRule(rule), null, rule);
  }
});

test("a timed rule ends at the end of the chosen day in the event's zone", () => {
  const form = parseRule("FREQ=WEEKLY;BYDAY=MO")!;
  form.end = { kind: "until", date: "2026-11-09" };
  assert.equal(buildRule(form, false, parisEnd), "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261109T225959Z");
  // An all-day rule takes the date itself.
  assert.equal(buildRule(form, true, parisEnd), "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261109");
});

test("presets are the screen's quick choices", () => {
  // Thursday 8 October 2026.
  const start = "2026-10-08";
  assert.equal(presetRule("none", start), null);
  assert.equal(presetRule("daily", start), "FREQ=DAILY");
  assert.equal(presetRule("workdays", start), "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
  assert.equal(presetRule("weekly", start), "FREQ=WEEKLY;BYDAY=TH");
  assert.equal(presetRule("monthly", start), "FREQ=MONTHLY");
  assert.equal(presetRule("yearly", start), "FREQ=YEARLY");
  assert.equal(presetOf(null, start), "none");
  assert.equal(presetOf("FREQ=WEEKLY;BYDAY=TH", start), "weekly");
  assert.equal(presetOf("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", start), "workdays");
  assert.equal(presetOf("FREQ=WEEKLY;BYDAY=MO", start), "custom");
  assert.equal(presetOf("FREQ=MONTHLY;BYDAY=2TH", start), "custom");
});
