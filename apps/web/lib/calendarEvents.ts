/**
 * Calendar events, from the realtime connection to whichever screen shows the calendar.
 *
 * The connection lives in `AppRoot`; the calendar screen comes and goes. `AppRoot` emits here and
 * the screen listens while mounted, and reloads what it shows. Nothing is buffered: a screen that
 * mounts later loads the current state from the API.
 */

const listeners = new Set<(calendarId: string) => void>();

/** A calendar, its settings or its events changed. */
export function emitCalendarChanged(calendarId: string): void {
  for (const listener of listeners) listener(calendarId);
}

/** Listen until the returned function is called. */
export function onCalendarChanged(listener: (calendarId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
