"use client";

import { useState } from "react";
import { IconButton } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";
import { longDay, periodTitle, weekdayInitials } from "./format";
import { addDays, weekdayOf } from "./model";

/** The month a day is in, as its first day. */
function monthOf(day: string): string {
  return `${day.slice(0, 8)}01`;
}

function shiftMonth(first: string, by: number): string {
  const [y, m] = first.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * A small month to jump to a date, as calendars put at the top of their column. Its own month
 * follows the screen's until the arrows move it; a day picked moves the screen there.
 */
export function MiniMonth({ anchor, today, onPick }: { anchor: string; today: string; onPick: (day: string) => void }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState<{ month: string; from: string } | null>(null);
  // Follow the screen unless the arrows were used since it last moved.
  const month = shown && shown.from === anchor ? shown.month : monthOf(anchor);
  const first = addDays(month, -weekdayOf(month));
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));

  return (
    <div style={{ padding: "4px 4px 8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "0 2px 4px" }}>
        <span style={{ flex: 1, fontSize: "var(--text-xs)", fontWeight: 700, color: "var(--text-strong)" }}>{periodTitle("month", month)}</span>
        <IconButton icon="chevron-left" size="sm" label={t("calendar.previousMonth")} onClick={() => setShown({ month: shiftMonth(month, -1), from: anchor })} />
        <IconButton icon="chevron-right" size="sm" label={t("calendar.nextMonth")} onClick={() => setShown({ month: shiftMonth(month, 1), from: anchor })} />
      </div>
      <div role="grid" aria-label={t("calendar.pickDate")} style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", rowGap: 2 }}>
        {weekdayInitials().map((initial, i) => (
          <span key={`h${i}`} aria-hidden style={{ textAlign: "center", fontSize: 10, color: "var(--text-muted)", paddingBottom: 2 }}>
            {initial}
          </span>
        ))}
        {days.map((day) => {
          const outside = day.slice(0, 7) !== month.slice(0, 7);
          const isToday = day === today;
          const isAnchor = day === anchor;
          return (
            <button
              key={day}
              type="button"
              role="gridcell"
              aria-label={longDay(day)}
              aria-selected={isAnchor || undefined}
              onClick={() => {
                setShown(null);
                onPick(day);
              }}
              style={{
                height: 26,
                border: "none",
                borderRadius: 999,
                padding: 0,
                cursor: "pointer",
                fontSize: "var(--text-2xs)",
                fontWeight: isToday || isAnchor ? 700 : 400,
                background: isAnchor ? "var(--action-primary-bg)" : "transparent",
                color: isAnchor ? "var(--action-primary-fg)" : isToday ? "var(--alarm)" : outside ? "var(--text-disabled)" : "var(--text-strong)",
              }}
            >
              {Number(day.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
