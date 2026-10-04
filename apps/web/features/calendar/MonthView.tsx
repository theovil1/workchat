"use client";

import { useState } from "react";
import type { Occurrence } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import { longDay, weekdayInitials } from "./format";
import { ListView } from "./ListView";
import { addDays, localDay, occursOn } from "./model";
import { colorVar, OccurrenceChip, type ChipLook } from "./OccurrenceChip";
import { rowWeek } from "./prefs";

/** How many events a desktop month cell lists before "+ n more". */
const SHOWN_PER_DAY = 3;

/**
 * The month view: six weeks from the first day of the week on or before the 1st, each line with its
 * week number when the viewer asked for them. On a desktop each day lists its
 * first events; on a phone it shows one dot per event (grey outside the filter), and the day touched
 * lists its events underneath.
 */
export function MonthView({
  from,
  weekStart,
  weekNumbers,
  anchor,
  occurrences,
  timeZone,
  lookOf,
  calendarName,
  onOpen,
  onPickDay,
  compact,
}: {
  from: string;
  weekStart: number;
  weekNumbers: boolean;
  anchor: string;
  occurrences: Occurrence[];
  timeZone: string;
  lookOf: (occurrence: Occurrence) => ChipLook;
  calendarName: (occurrence: Occurrence) => string;
  onOpen: (occurrence: Occurrence) => void;
  onPickDay: (day: string) => void;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const today = localDay(new Date().toISOString(), timeZone);
  const [selected, setSelected] = useState(anchor);
  const month = anchor.slice(0, 7);
  const days = Array.from({ length: 42 }, (_, i) => addDays(from, i));
  const on = (day: string) => occurrences.filter((o) => occursOn(o, day, timeZone));

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflowY: compact ? "auto" : undefined }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", flex: "none" }} aria-hidden>
        {weekdayInitials(weekStart).map((initial, i) => (
          <div key={i} style={{ textAlign: "center", fontSize: "var(--text-2xs)", color: "var(--text-muted)", padding: "6px 0 2px" }}>
            {initial}
          </div>
        ))}
      </div>
      <div
        role="grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gridAutoRows: compact ? 44 : "minmax(0, 1fr)",
          flex: compact ? "none" : 1,
          minHeight: 0,
          borderTop: compact ? undefined : "1px solid var(--border-subtle)",
        }}
      >
        {days.map((day, i) => {
          const items = on(day);
          const outside = day.slice(0, 7) !== month;
          const isToday = day === today;
          const isSelected = compact && day === selected;
          return (
            <div
              key={day}
              role="gridcell"
              aria-label={longDay(day)}
              aria-selected={isSelected || undefined}
              tabIndex={0}
              onClick={() => (compact ? setSelected(day) : onPickDay(day))}
              onKeyDown={(event) => {
                if (event.key === "Enter") (compact ? setSelected : onPickDay)(day);
              }}
              style={{
                minWidth: 0,
                overflow: "hidden",
                padding: compact ? "4px 0 0" : 4,
                textAlign: compact ? "center" : undefined,
                borderRight: compact ? undefined : "1px solid var(--border-subtle)",
                borderBottom: compact ? undefined : "1px solid var(--border-subtle)",
                cursor: "pointer",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  minWidth: 22,
                  height: 22,
                  lineHeight: "22px",
                  textAlign: "center",
                  borderRadius: 999,
                  fontSize: "var(--text-xs)",
                  fontWeight: isToday || isSelected ? 700 : 400,
                  color: isSelected || (!compact && isToday) ? "var(--on-pastel)" : isToday ? "var(--alarm)" : outside ? "var(--text-disabled)" : "var(--text-strong)",
                  background: isSelected || (!compact && isToday) ? "var(--acc)" : undefined,
                }}
              >
                {Number(day.slice(8))}
              </span>
              {weekNumbers && i % 7 === 0 && !compact ? (
                <span style={{ marginLeft: 6, padding: "1px 5px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>
                  {t("calendar.weekNumber", { n: rowWeek(day) })}
                </span>
              ) : null}
              {compact ? (
                <div aria-hidden style={{ display: "flex", gap: 2, justifyContent: "center", marginTop: 2 }}>
                  {items.slice(0, 4).map((o) => {
                    const look = lookOf(o);
                    return (
                      <i
                        key={`${o.eventId}:${o.recurrenceId ?? ""}`}
                        style={{ width: 5, height: 5, borderRadius: "50%", background: look.dimmed ? "var(--border-strong)" : colorVar(look.color) }}
                      />
                    );
                  })}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 2 }}>
                  {items.slice(0, SHOWN_PER_DAY).map((o) => (
                    <OccurrenceChip key={`${o.eventId}:${o.recurrenceId ?? ""}`} occurrence={o} look={lookOf(o)} onOpen={onOpen} timeZone={timeZone} />
                  ))}
                  {items.length > SHOWN_PER_DAY ? (
                    <span style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)", paddingLeft: 4 }}>
                      {t("calendar.more", { count: items.length - SHOWN_PER_DAY })}
                    </span>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {compact ? (
        <div style={{ borderTop: "1px solid var(--border-subtle)", marginTop: 4 }}>
          <ListView
            from={selected}
            days={1}
            occurrences={occurrences}
            timeZone={timeZone}
            lookOf={lookOf}
            calendarName={calendarName}
            onOpen={onOpen}
          />
        </div>
      ) : null}
    </div>
  );
}
