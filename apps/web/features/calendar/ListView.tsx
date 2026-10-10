"use client";

import { Icon } from "@/components/ds";
import type { Occurrence } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import { clock, longDay } from "./format";
import { addDays, localDay, occursOn } from "./model";
import { STATUS_LOOK } from "./AttendeesField";
import { chipStyle, onActivate, type ChipLook } from "./OccurrenceChip";

/**
 * The list view, and the phone's default: the days ahead, each with its events in order. A day with
 * nothing is skipped; a period with nothing at all says so.
 */
export function ListView({
  from,
  days,
  occurrences,
  timeZone,
  lookOf,
  calendarName,
  onOpen,
}: {
  from: string;
  days: number;
  occurrences: Occurrence[];
  timeZone: string;
  lookOf: (occurrence: Occurrence) => ChipLook;
  calendarName: (occurrence: Occurrence) => string;
  onOpen: (occurrence: Occurrence) => void;
}) {
  const { t } = useTranslation();
  const today = localDay(new Date().toISOString(), timeZone);
  const groups = Array.from({ length: days }, (_, i) => addDays(from, i))
    .map((day) => ({ day, items: occurrences.filter((o) => occursOn(o, day, timeZone)) }))
    .filter((g) => g.items.length > 0);

  if (groups.length === 0) {
    return (
      <p style={{ padding: "var(--space-8) var(--space-5)", color: "var(--text-muted)", textAlign: "center", margin: 0 }}>
        {t("calendar.nothingPlanned")}
      </p>
    );
  }
  return (
    <div style={{ padding: "var(--space-2) var(--space-3) var(--space-12)" }}>
      {groups.map(({ day, items }) => (
        <section key={day} aria-label={longDay(day)}>
          <h3
            style={{
              margin: "var(--space-3) var(--space-1) var(--space-1-5)",
              fontSize: "var(--text-xs)",
              fontWeight: 700,
              color: day === today ? "var(--alarm)" : "var(--text-strong)",
            }}
          >
            {day === today ? `${t("conversation.today")} · ${longDay(day).toLocaleLowerCase()}` : longDay(day)}
          </h3>
          {items.map((o) => (
            <ListRow key={`${o.eventId}:${o.recurrenceId ?? ""}`} occurrence={o} look={lookOf(o)} timeZone={timeZone} calendar={calendarName(o)} onOpen={onOpen} />
          ))}
        </section>
      ))}
    </div>
  );
}

function ListRow({
  occurrence: o,
  look,
  timeZone,
  calendar,
  onOpen,
}: {
  occurrence: Occurrence;
  look: ChipLook;
  timeZone: string;
  calendar: string;
  onOpen: (occurrence: Occurrence) => void;
}) {
  const { t } = useTranslation();
  const fill = chipStyle(look);
  return (
    <div
      {...onActivate(() => onOpen(o))}
      style={{
        display: "flex",
        gap: "var(--space-2-5)",
        alignItems: "stretch",
        margin: "var(--space-1) 0",
        padding: "var(--space-2) var(--space-2-5)",
        borderRadius: "var(--radius-md, 10px)",
        border: look.dimmed ? fill.border : "1px solid var(--border-subtle)",
        background: look.dimmed ? fill.background : "var(--surface-card)",
        cursor: "pointer",
      }}
    >
      <div style={{ width: 48, flex: "none", fontSize: "var(--text-2xs)", color: "var(--text-muted)", lineHeight: 1.35 }}>
        {o.allDay ? (
          t("calendar.allDay")
        ) : (
          <>
            {clock(o.start, timeZone)}
            <br />
            {clock(o.end, timeZone)}
          </>
        )}
      </div>
      <div aria-hidden style={{ width: 4, borderRadius: 3, flex: "none", background: look.dimmed ? "var(--border-strong)" : fill.background }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span
            style={{
              fontWeight: 600,
              color: look.dimmed ? "var(--text-muted)" : "var(--text-strong)",
              textDecoration: look.status === "declined" ? "line-through" : undefined,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {o.title}
          </span>
          {/* The viewer's answer, when it is not a plain yes: a list has no room for a look alone. */}
          {look.status && look.status !== "accepted" ? (
            <span
              style={{
                flex: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "1px 8px 1px 4px",
                borderRadius: 999,
                background: STATUS_LOOK[look.status].color,
                color: "var(--on-pastel)",
                fontSize: "var(--text-2xs)",
                fontWeight: 600,
              }}
            >
              <Icon name={STATUS_LOOK[look.status].icon} size={10} />
              {t(`calendar.myAnswer.${look.status}`)}
            </span>
          ) : null}
        </div>
        <div style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {calendar}
          {o.location ? ` · ${o.location}` : ""}
        </div>
      </div>
    </div>
  );
}
