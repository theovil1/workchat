// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRule } from "./rule.ts";
import { rulePhrase } from "./rulePhrase.ts";

type Dict = Record<string, unknown>;
const LOCALES = ["fr", "en", "es", "de", "it", "pl"] as const;

/** The dictionary's `calendar.rule` part, read the way i18next reads it (plurals by `count`). */
function translator(locale: string) {
  const dict = JSON.parse(
    readFileSync(new URL(`../../lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8"),
  ) as Dict;
  const lookup = (key: string): string | undefined =>
    key.split(".").reduce<unknown>((at, part) => (at as Dict | undefined)?.[part], dict) as string | undefined;
  return (key: string, vars: Record<string, string | number> = {}) => {
    let text = lookup(key);
    if (typeof vars.count === "number") {
      const form = new Intl.PluralRules(locale).select(vars.count);
      text = lookup(`${key}_${form}`) ?? lookup(`${key}_other`) ?? text;
    }
    if (text === undefined) return key;
    return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ""));
  };
}

const phrase = (rule: string, locale: string, start = "2026-10-08") =>
  rulePhrase(parseRule(rule)!, start, locale, translator(locale));

test("rule_phrase_in_six_languages", () => {
  assert.equal(phrase("FREQ=MONTHLY;BYDAY=2TH;COUNT=10", "fr"), "Le 2e jeudi de chaque mois, 10 fois");
  assert.equal(phrase("FREQ=WEEKLY;BYDAY=MO,FR", "fr"), "Chaque semaine, le lundi et le vendredi");
  assert.equal(phrase("FREQ=DAILY", "fr"), "Tous les jours");
  assert.equal(phrase("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "fr"), "Du lundi au vendredi");
  assert.equal(phrase("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "fr"), "Le dernier jour ouvré de chaque mois");
  assert.equal(phrase("FREQ=MONTHLY", "en"), "Every month on day 8");
  for (const locale of LOCALES) {
    for (const rule of [
      "FREQ=DAILY;INTERVAL=2",
      "FREQ=WEEKLY;INTERVAL=3;BYDAY=WE",
      "FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20270630T235959Z",
      "FREQ=MONTHLY;INTERVAL=2",
      "FREQ=YEARLY;COUNT=5",
    ]) {
      const text = phrase(rule, locale);
      assert.ok(text.length > 0, `${locale} ${rule}`);
      assert.ok(!text.includes("calendar.rule"), `${locale} ${rule}: ${text}`);
      assert.ok(!text.includes("{{"), `${locale} ${rule}: ${text}`);
    }
  }
});
