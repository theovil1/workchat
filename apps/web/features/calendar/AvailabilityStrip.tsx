"use client";

import { useEffect, useState } from "react";
import { freeBusy, type BusyTimes } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import { hourLabel } from "./format";
import { addDays, zonedTime } from "./model";

const NAME_WIDTH = 92;
const ROW = 22;

/**
 * Who is free on the event's day: a line per person (the viewer first), their busy times in grey,
 * the event's own slot in the accent, and where the two meet in red. Read only: free/busy says when,
 * never what. Tells the form who is busy during the event.
 */
export function AvailabilityStrip({
  people,
  day,
  start,
  end,
  timeZone,
  excludeEvent,
  onBusy,
}: {
  people: { userId: string; name: string }[];
  /** The event's day, `YYYY-MM-DD`, read in `timeZone`. */
  day: string;
  /** The event, RFC 3339. */
  start: string;
  end: string;
  timeZone: string;
  /** The event being edited, which keeps nobody busy. */
  excludeEvent?: string;
  /** Called with the people busy during the event, whenever that changes. */
  onBusy: (names: string[]) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<BusyTimes[] | null>(null);
  const ids = people.map((p) => p.userId).join(",");

  useEffect(() => {
    if (!ids) return;
    const abort = new AbortController();
    const wait = setTimeout(() => {
      freeBusy(ids.split(","), zonedTime(day, 0, timeZone), zonedTime(addDays(day, 1), 0, timeZone), abort.signal, excludeEvent)
        .then(setBusy)
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(wait);
      abort.abort();
    };
  }, [ids, day, timeZone, excludeEvent]);

  const [from, to] = [Date.parse(start), Date.parse(end)];
  const takenDuring = (person: string) =>
    busy?.find((b) => b.userId === person)?.busy.some((b) => Date.parse(b.start) < to && from < Date.parse(b.end)) ?? false;
  const names = people.filter((p) => takenDuring(p.userId)).map((p) => p.name).join("\u0000");
  useEffect(() => {
    onBusy(names ? names.split("\u0000") : []);
    // `names` stands for the list it was made from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names]);

  // The part of the day drawn: the working day around the event, an hour on either side.
  const dayStart = Date.parse(zonedTime(day, 0, timeZone));
  const hourOf = (at: number) => (at - dayStart) / 3_600_000;
  const first = Math.max(0, Math.min(7, Math.floor(hourOf(from)) - 1));
  const last = Math.min(24, Math.max(20, Math.ceil(hourOf(to)) + 1));
  const span = last - first;
  const x = (at: number) => `${((Math.min(Math.max(hourOf(at), first), last) - first) / span) * 100}%`;
  const width = (a: number, b: number) =>
    `${((Math.min(Math.max(hourOf(b), first), last) - Math.min(Math.max(hourOf(a), first), last)) / span) * 100}%`;
  const ticks = Array.from({ length: Math.floor(span / 2) + 1 }, (_, i) => first + i * 2).filter((h) => h < last);

  return (
    <div role="group" aria-label={t("calendar.availability")} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", fontSize: 10, color: "var(--text-muted)" }} aria-hidden>
        <span style={{ width: NAME_WIDTH, flex: "none" }} />
        <div style={{ position: "relative", flex: 1, height: 12 }}>
          {ticks.map((h) => (
            <span key={h} style={{ position: "absolute", left: `${((h - first) / span) * 100}%`, transform: "translateX(-2px)", whiteSpace: "nowrap" }}>
              {hourLabel(h)}
            </span>
          ))}
        </div>
      </div>
      {people.map((person) => {
        const theirs = busy?.find((b) => b.userId === person.userId)?.busy ?? [];
        const taken = takenDuring(person.userId);
        return (
          <div key={person.userId} style={{ display: "flex", alignItems: "center" }}>
            <span
              style={{
                width: NAME_WIDTH,
                flex: "none",
                paddingRight: 6,
                fontSize: "var(--text-xs)",
                color: taken ? "var(--alarm)" : "var(--text-strong)",
                fontWeight: taken ? 700 : 400,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {person.name}
            </span>
            <div
              aria-label={taken ? t("calendar.busyDuring", { name: person.name }) : t("calendar.freeDuring", { name: person.name })}
              role="img"
              style={{
                position: "relative",
                flex: 1,
                height: ROW,
                borderRadius: 6,
                background: busy ? "var(--surface-sunken)" : "repeating-linear-gradient(90deg, var(--surface-sunken) 0 8px, transparent 8px 16px)",
                border: "1px solid var(--border-subtle)",
                overflow: "hidden",
              }}
            >
              {theirs.map((b) => {
                const [a, z] = [Date.parse(b.start), Date.parse(b.end)];
                const clash = a < to && from < z;
                return (
                  <span
                    key={b.start}
                    style={{
                      position: "absolute",
                      top: 3,
                      bottom: 3,
                      left: x(a),
                      width: width(a, z),
                      borderRadius: 4,
                      background: clash ? "color-mix(in srgb, var(--alarm) 55%, transparent)" : "color-mix(in srgb, var(--text-muted) 45%, transparent)",
                    }}
                  />
                );
              })}
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: x(from),
                  width: width(from, to),
                  border: "2px solid var(--ink)",
                  borderRadius: 6,
                  background: "color-mix(in srgb, var(--acc) 35%, transparent)",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
