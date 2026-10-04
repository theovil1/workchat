"use client";

import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import type { CalendarColor, Occurrence } from "@/lib/data/calendar";
import { clock } from "./format";

/** A calendar's colour: the palette's pastel, with the dark ink on it in every theme. `accent` is
 *  the viewer's own theme accent, itself one of the pastels. */
export function colorVar(color: CalendarColor | undefined): string {
  if (color === "accent") return "var(--acc)";
  return `var(--${color ?? "sky"})`;
}

/** What sits outside the filter: struck through in grey, still readable. */
export const HATCHED =
  "repeating-linear-gradient(45deg, var(--surface-sunken) 0 6px, var(--surface-hover) 6px 12px)";

export type ChipLook = { color?: CalendarColor; dimmed: boolean };

/** The fill, border and ink of an occurrence. */
export function chipStyle(look: ChipLook): CSSProperties {
  return look.dimmed
    ? {
        background: HATCHED,
        border: "1px dashed var(--border-default)",
        color: "var(--text-muted)",
      }
    : {
        background: colorVar(look.color),
        border: "1px solid transparent",
        color: "var(--on-pastel)",
      };
}

/** Activate on Enter and Space, as a button does: chips are `div`s so they can be positioned. */
export function onActivate(action: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: (event: MouseEvent) => {
      event.stopPropagation();
      action();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        action();
      }
    },
  };
}

/** One occurrence as a single line: its colour, its time (when it has one), its title. */
export function OccurrenceChip({
  occurrence,
  look,
  onOpen,
  timeZone,
  showTime = true,
  style,
}: {
  occurrence: Occurrence;
  look: ChipLook;
  onOpen: (occurrence: Occurrence) => void;
  timeZone: string;
  showTime?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      {...onActivate(() => onOpen(occurrence))}
      title={occurrence.title}
      style={{
        ...chipStyle(look),
        borderRadius: "var(--radius-sm)",
        padding: "1px 6px",
        fontSize: "var(--text-2xs)",
        lineHeight: "18px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        cursor: "pointer",
        ...style,
      }}
    >
      {showTime && !occurrence.allDay ? <span style={{ fontWeight: 600, marginRight: 4 }}>{clock(occurrence.start, timeZone)}</span> : null}
      {occurrence.title}
    </div>
  );
}
