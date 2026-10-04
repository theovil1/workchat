"use client";

import type { Calendar, Occurrence } from "@/lib/data/calendar";
import type { Draft } from "./CalendarScreen";
import type { Filter } from "./model";

/** Which calendar's settings are open: one to change, or a new one (a space's, or the viewer's). */
export type SettingsTarget = { kind: "edit"; calendar: Calendar } | { kind: "new"; spaceId?: string };

export type CalendarOverlaysProps = {
  compact: boolean;
  timeZone: string;
  spaces: { id: string; name: string }[];
  calendars: Calendar[];
  filter: Filter;
  opened: Occurrence | null;
  draft: Draft | null;
  settings: SettingsTarget | null;
  onEdit: (occurrence: Occurrence) => void;
  onClose: () => void;
  onChanged: () => void;
};

/** The calendar's windows: an event's details, the event form, a calendar's settings. */
export function CalendarOverlays(props: CalendarOverlaysProps) {
  void props;
  return null;
}
