// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRule, parseRule, presetOf, presetRule } from "./rule.ts";

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
    assert.equal(buildRule(form, allDay), rule);
  }
  // What the editor cannot show is said so, rather than mangled.
  for (const rule of ["FREQ=YEARLY;BYWEEKNO=20", "FREQ=HOURLY", "FREQ=MONTHLY;BYMONTHDAY=15", "nonsense"]) {
    assert.equal(parseRule(rule), null, rule);
  }
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
