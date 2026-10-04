"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { Occurrence } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import { clock, longDay, shortDay } from "./format";
import { addDays, layoutDay, localDay, localMinutes, occursOn } from "./model";
import { chipStyle, onActivate, OccurrenceChip, type ChipLook } from "./OccurrenceChip";

/** Height of one hour on the grid, in pixels. */
const HOUR = 48;
/** Where the grid opens, scrolled: the start of a working day. */
const OPEN_AT_HOUR = 8;
const GUTTER = 52;

/**
 * The week and day views: a column per day, hours down the side, the all-day events in a band above,
 * a line at the current time. Events that overlap share their column's width. Clicking (or tapping)
 * an empty slot asks for a new event at that half hour.
 */
export function TimeGrid({
  days,
  occurrences,
  timeZone,
  lookOf,
  onOpen,
  onCreateAt,
  compact,
}: {
  days: string[];
  occurrences: Occurrence[];
  timeZone: string;
  lookOf: (occurrence: Occurrence) => ChipLook;
  onOpen: (occurrence: Occurrence) => void;
  onCreateAt?: (day: string, minutes: number) => void;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const today = localDay(new Date(now).toISOString(), timeZone);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = OPEN_AT_HOUR * HOUR - 8;
  }, []);

  const allDay = (day: string) => occurrences.filter((o) => o.allDay && occursOn(o, day, timeZone));
  const bandRows = Math.max(0, ...days.map((d) => allDay(d).length));
  const nowTop = (localMinutes(new Date(now).toISOString(), timeZone) / 60) * HOUR;

  const column: CSSProperties = { flex: 1, minWidth: 0, position: "relative", borderLeft: "1px solid var(--border-subtle)" };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* Day heads, and the all-day band. */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--border-subtle)", flex: "none" }}>
        <div style={{ width: GUTTER, flex: "none" }} />
        {days.map((day) => {
          const head = shortDay(day);
          const isToday = day === today;
          return (
            <div key={day} style={{ ...column, padding: "6px 4px 4px", textAlign: "center" }}>
              {days.length > 1 ? (
                <div style={{ fontSize: "var(--text-2xs)", color: isToday ? "var(--text-accent)" : "var(--text-muted)" }}>
                  {head.weekday}{" "}
                  <span
                    style={{
                      fontWeight: 700,
                      color: isToday ? "var(--action-primary-fg)" : "var(--text-strong)",
                      background: isToday ? "var(--action-primary-bg)" : undefined,
                      borderRadius: 999,
                      padding: isToday ? "1px 6px" : undefined,
                    }}
                  >
                    {head.date}
                  </span>
                </div>
              ) : null}
              <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: days.length > 1 ? 4 : 0, minHeight: bandRows * 22 }}>
                {allDay(day).map((o) => (
                  <OccurrenceChip key={`${o.eventId}:${o.recurrenceId ?? ""}`} occurrence={o} look={lookOf(o)} onOpen={onOpen} timeZone={timeZone} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div ref={scroller} style={{ flex: 1, minHeight: 0, overflowY: "auto", position: "relative" }}>
        <div style={{ display: "flex", height: 24 * HOUR, position: "relative" }}>
          <div style={{ width: GUTTER, flex: "none", position: "relative" }} aria-hidden>
            {Array.from({ length: 24 }, (_, hour) => (
              <div key={hour} style={{ position: "absolute", top: hour * HOUR - 7, right: 8, fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>
                {hour === 0 ? "" : clock(`2000-01-01T${String(hour).padStart(2, "0")}:00:00Z`, "UTC")}
              </div>
            ))}
          </div>
          {days.map((day) => {
            const laid = layoutDay(
              occurrences.filter((o) => !o.allDay),
              day,
              timeZone,
            );
            return (
              <div
                key={day}
                style={{
                  ...column,
                  backgroundImage: `repeating-linear-gradient(to bottom, var(--border-subtle) 0 1px, transparent 1px ${HOUR}px)`,
                  cursor: onCreateAt ? "copy" : undefined,
                }}
                onClick={(event) => {
                  if (!onCreateAt) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  const minutes = Math.floor(((event.clientY - rect.top) / HOUR) * 2) * 30;
                  onCreateAt(day, Math.max(0, Math.min(23 * 60 + 30, minutes)));
                }}
                aria-label={t("calendar.newEventOn", { day: longDay(day) })}
              >
                {laid.map((p) => {
                  const o = p.item;
                  const width = 100 / p.columns;
                  return (
                    <div
                      key={`${o.eventId}:${o.recurrenceId ?? ""}`}
                      {...onActivate(() => onOpen(o))}
                      title={o.title}
                      style={{
                        ...chipStyle(lookOf(o)),
                        position: "absolute",
                        top: (p.top / 60) * HOUR,
                        height: (p.height / 60) * HOUR - 2,
                        left: `calc(${p.column * width}% + 2px)`,
                        width: `calc(${width}% - 4px)`,
                        borderRadius: "var(--radius-sm)",
                        padding: "2px 6px",
                        fontSize: "var(--text-2xs)",
                        lineHeight: 1.3,
                        overflow: "hidden",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.title}</div>
                      {p.height >= 40 && !compact ? (
                        <div style={{ opacity: 0.85, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {clock(o.start, timeZone)}
                          {o.location ? ` · ${o.location}` : ""}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {day === today ? (
                  <div aria-hidden style={{ position: "absolute", left: 0, right: 0, top: nowTop, borderTop: "2px solid var(--alarm)", pointerEvents: "none" }}>
                    <span style={{ position: "absolute", left: -4, top: -5, width: 8, height: 8, borderRadius: "50%", background: "var(--alarm)" }} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The days a week or day view shows. */
export function daysOf(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(from, i));
}
