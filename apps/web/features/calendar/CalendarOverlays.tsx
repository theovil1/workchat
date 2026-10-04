"use client";

import { useState } from "react";
import type { Calendar, CalendarEvent, Occurrence } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import { CalendarSettingsDialog, FeedsDialog } from "./CalendarSettingsDialog";
import type { Draft } from "./CalendarScreen";
import { EventDetails } from "./EventDetails";
import { EventForm } from "./EventForm";
import { freeColor, type Filter } from "./model";

/** Which calendar's settings are open: one to change, a new one (a space's, or the viewer's), or
 *  the subscription to all of them. */
export type SettingsTarget = { kind: "edit"; calendar: Calendar } | { kind: "new"; spaceId?: string } | { kind: "feeds" };

export type CalendarOverlaysProps = {
  compact: boolean;
  timeZone: string;
  spaces: { id: string; name: string }[];
  calendars: Calendar[];
  filter: Filter;
  /** The space the screen is on, offered first when choosing a calendar. */
  currentSpaceId?: string;
  opened: Occurrence | null;
  draft: Draft | null;
  settings: SettingsTarget | null;
  onEdit: (occurrence: Occurrence) => void;
  onClose: () => void;
  onChanged: () => void;
  onNotify?: (toast: { tone: "info" | "success" | "danger"; title: string }) => void;
};

/** The calendar's windows: an event's details, the event form, a calendar's settings. */
export function CalendarOverlays({ compact, timeZone, spaces, calendars, filter, currentSpaceId, opened, draft, settings, onClose, onChanged, onNotify }: CalendarOverlaysProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<{ occurrence: Occurrence; event: CalendarEvent } | null>(null);
  const spaceName = (id?: string) => spaces.find((s) => s.id === id)?.name;
  const label = (calendar?: Calendar) => {
    if (!calendar) return "";
    const space = spaceName(calendar.spaceId);
    return space && space !== calendar.name ? `${space} · ${calendar.name}` : calendar.name;
  };
  const close = () => {
    setEditing(null);
    onClose();
  };
  const finish = (message: "saved" | "created" | "deleted" | "failed") => {
    if (message === "failed") {
      onNotify?.({ tone: "danger", title: t("calendar.actionFailed") });
      return;
    }
    onNotify?.({
      tone: "success",
      title: t(message === "deleted" ? "calendar.deleted" : message === "created" ? "calendar.created" : "calendar.saved"),
    });
    onChanged();
    close();
  };

  if (settings?.kind === "feeds") return <FeedsDialog onClose={close} onError={() => finish("failed")} />;
  if (settings) {
    const calendar = settings.kind === "edit" ? settings.calendar : undefined;
    const spaceId = settings.kind === "new" ? settings.spaceId : calendar?.spaceId;
    return <CalendarSettingsDialog calendar={calendar} spaceId={spaceId} spaceName={spaceName(spaceId)} suggestedColor={freeColor(calendars)} onDone={finish} onClose={close} />;
  }
  if (editing) {
    return <EventForm compact={compact} calendars={calendars} currentSpaceId={currentSpaceId} spaces={spaces} timeZone={timeZone} editing={editing} onDone={finish} onCancel={close} />;
  }
  if (draft) {
    // A new event goes first in the filtered space's default calendar, when the viewer may write in it.
    const preferred =
      draft.calendarId ??
      (filter.kind === "space" ? calendars.find((c) => c.spaceId === filter.spaceId && c.isDefault && c.canWriteEvents)?.id : undefined);
    return (
      <EventForm
        compact={compact}
        calendars={calendars}
        currentSpaceId={currentSpaceId}
        spaces={spaces}
        timeZone={timeZone}
        draft={{ ...draft, calendarId: preferred }}
        onDone={finish}
        onCancel={close}
      />
    );
  }
  if (opened) {
    const calendar = calendars.find((c) => c.id === opened.calendarId);
    return (
      <EventDetails
        occurrence={opened}
        calendar={calendar}
        calendarLabel={label(calendar)}
        timeZone={timeZone}
        onEdit={(event) => setEditing({ occurrence: opened, event })}
        onDone={finish}
        onClose={close}
      />
    );
  }
  return null;
}
