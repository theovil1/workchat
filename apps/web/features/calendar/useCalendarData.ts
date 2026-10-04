"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { onCalendarChanged } from "@/lib/calendarEvents";
import { listCalendars, listOccurrences, type Calendar, type Occurrence } from "@/lib/data/calendar";

/** How long a burst of changes is gathered before the screen reloads once. */
const SETTLE_MS = 250;

/**
 * What the calendar screen shows: the viewer's calendars, and the occurrences of the period on screen
 * in the calendars they have not hidden, with what they are invited to from calendars they do not see
 * unless they hid that too. Both reload when the realtime connection says a calendar
 * changed (someone else's edit, or this person's on another device).
 */
export function useCalendarData(range: { from: string; to: string }, invitations = true) {
  const [calendars, setCalendars] = useState<Calendar[] | null>(null);
  const [occurrences, setOccurrences] = useState<Occurrence[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const stop = onCalendarChanged(() => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(reload, SETTLE_MS);
    });
    return () => {
      stop();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [reload]);

  useEffect(() => {
    const abort = new AbortController();
    listCalendars(abort.signal)
      .then((found) => {
        setCalendars(found);
        setFailed(false);
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name !== "AbortError") setFailed(true);
      });
    return () => abort.abort();
  }, [version]);

  const shown = calendars?.filter((c) => !c.hidden).map((c) => c.id);
  const shownKey = shown?.join(",");
  useEffect(() => {
    // Not loaded yet, or every calendar hidden: nothing to ask for.
    if (!shownKey) return;
    const abort = new AbortController();
    listOccurrences(range.from, range.to, shownKey.split(","), abort.signal, invitations)
      .then((found) => {
        setOccurrences(found);
        setFailed(false);
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name !== "AbortError") setFailed(true);
      });
    return () => abort.abort();
  }, [range.from, range.to, shownKey, version, invitations]);

  return { calendars, occurrences: shownKey === "" ? [] : occurrences, failed, reload, setCalendars };
}
