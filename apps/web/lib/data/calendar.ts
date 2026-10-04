/**
 * The calendar's side of the API: calendars, occurrences of a period, events and their series, the
 * viewer's own settings, and iCal subscription addresses.
 *
 * Kept apart from `api.ts`, which is long enough already; the shapes follow the API's DTOs
 * (`apps/api/src/calendar/dto.rs`), renamed to the web's camelCase on the way in.
 */

import { apiDelete, apiGet, apiPatch, apiPost, apiPut, apiRequest } from "./http";

/** The palette's pastels a calendar may wear. */
/** A palette pastel, or `accent`: the viewer's own theme accent (what a personal calendar wears). */
export type CalendarColor = "accent" | "sky" | "mint" | "violet" | "pink" | "peach" | "lime" | "sun";
export const CALENDAR_COLORS: readonly CalendarColor[] = ["accent", "sky", "mint", "violet", "pink", "peach", "lime", "sun"];


export type Calendar = {
  id: string;
  /** Absent for a personal calendar. */
  spaceId?: string;
  name: string;
  description?: string;
  color: CalendarColor;
  writeAccess: "members" | "admins";
  /** The reminder a timed event gets by default, in minutes; `null` is none. */
  defaultReminderMinutes: number | null;
  isDefault: boolean;
  canWriteEvents: boolean;
  canManage: boolean;
  hidden: boolean;
  /** The viewer's own reminder for the whole calendar: `undefined` follows the default, `null` is
   *  off. */
  myReminderMinutes?: number | null;
};

export type Occurrence = {
  eventId: string;
  calendarId: string;
  recurrenceId?: string;
  title: string;
  location?: string;
  /** The occurrence's notes: its own when it was changed apart, else the series'. */
  description?: string;
  allDay: boolean;
  /** RFC 3339 (UTC) for a timed occurrence, `YYYY-MM-DD` for an all-day one. */
  start: string;
  end: string;
  tzid?: string;
  isRecurring: boolean;
  overridden: boolean;
  canEdit: boolean;
  myReminderMinutes?: number;
  /** The viewer's answer for this occurrence; `accepted` for the organiser of an event with
   *  attendees; absent for anyone not on its list. */
  myStatus?: AttendeeStatus;
  /** Seen through an invitation alone: its calendar is not the viewer's to see. */
  invited: boolean;
  hasAttendees: boolean;
};

/** An answer to an invitation. */
export type AttendeeStatus = "needs_action" | "accepted" | "tentative" | "declined";

export type Attendee = {
  id: string;
  userId?: string;
  /** For someone invited by address only. */
  email?: string;
  name: string;
  status: AttendeeStatus;
};

/** Someone on the list as the form sends it: an account, or an address. */
export type AttendeeInput = { userId: string } | { email: string; name?: string };

export type CalendarEvent = Occurrence & {
  rrule?: string;
  createdBy?: string;
  updatedAt: string;
  organizer?: { userId: string; name: string };
  attendees: Attendee[];
};

/** Someone who may be invited. */
export type Invitee = { userId: string; name: string };

/** One person's busy times, RFC 3339 in UTC, merged. */
export type BusyTimes = { userId: string; busy: { start: string; end: string }[] };

/** An invitation as someone invited by address sees it, on its public page. */
export type PublicInvitation = {
  title: string;
  location?: string;
  description?: string;
  start: string;
  end: string;
  allDay: boolean;
  tzid?: string;
  recurring: boolean;
  organizer?: string;
  name?: string;
  status: AttendeeStatus;
};

/** What the form sends for a new event or a change. */
export type EventInput = {
  title: string;
  description?: string;
  location?: string;
  allDay: boolean;
  start: string;
  end: string;
  tzid?: string;
  rrule?: string | null;
  /** `undefined` leaves the author's reminder as it is; `null` turns it off. */
  reminderMinutes?: number | null;
  /** Another calendar to move the event to (whole-series changes only). */
  calendarId?: string;
  /** The whole list of attendees; `undefined` leaves it as it is. */
  attendees?: AttendeeInput[];
};

export type EditScope = "this" | "following" | "all";

export type Feed = { id: string; calendarId?: string; createdAt: string; lastUsedAt?: string };
export type CreatedFeed = { id: string; calendarId?: string; url: string; createdAt: string };

/** Reminder delays the screen offers, in minutes before a timed event starts. */
export const TIMED_REMINDERS = [0, 5, 10, 15, 30, 60, 1440] as const;
/** And for an all-day event: the evening before at 17:00, the same morning at 9:00. */
export const ALL_DAY_REMINDERS = [420, -540] as const;

type CalendarDto = {
  id: string;
  space_id?: string | null;
  name: string;
  description?: string | null;
  color: CalendarColor;
  write_access: "members" | "admins";
  default_reminder_minutes: number | null;
  is_default: boolean;
  can_write_events: boolean;
  can_manage: boolean;
  hidden: boolean;
  my_reminder_minutes?: number | null;
};

type OccurrenceDto = {
  event_id: string;
  calendar_id: string;
  recurrence_id?: string | null;
  title: string;
  location?: string | null;
  description?: string | null;
  all_day: boolean;
  start: string;
  end: string;
  tzid?: string | null;
  is_recurring: boolean;
  overridden: boolean;
  can_edit: boolean;
  my_reminder_minutes?: number | null;
  my_status?: AttendeeStatus | null;
  invited?: boolean;
  has_attendees?: boolean;
};

type AttendeeDto = { id: string; user_id?: string | null; email?: string | null; name: string; status: AttendeeStatus };

type EventDto = OccurrenceDto & {
  rrule?: string | null;
  created_by?: string | null;
  updated_at: string;
  organizer?: { user_id: string; name: string } | null;
  attendees?: AttendeeDto[];
};

type FeedDto = { id: string; calendar_id?: string | null; created_at: string; last_used_at?: string | null; url?: string };

function opt<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

function toCalendar(dto: CalendarDto): Calendar {
  return {
    id: dto.id,
    spaceId: opt(dto.space_id),
    name: dto.name,
    description: opt(dto.description),
    color: dto.color,
    writeAccess: dto.write_access,
    defaultReminderMinutes: dto.default_reminder_minutes,
    isDefault: dto.is_default,
    canWriteEvents: dto.can_write_events,
    canManage: dto.can_manage,
    hidden: dto.hidden,
    ...("my_reminder_minutes" in dto ? { myReminderMinutes: dto.my_reminder_minutes } : {}),
  };
}

function toOccurrence(dto: OccurrenceDto): Occurrence {
  return {
    eventId: dto.event_id,
    calendarId: dto.calendar_id,
    recurrenceId: opt(dto.recurrence_id),
    title: dto.title,
    location: opt(dto.location),
    description: opt(dto.description),
    allDay: dto.all_day,
    start: dto.start,
    end: dto.end,
    tzid: opt(dto.tzid),
    isRecurring: dto.is_recurring,
    overridden: dto.overridden,
    canEdit: dto.can_edit,
    myReminderMinutes: opt(dto.my_reminder_minutes),
    myStatus: opt(dto.my_status),
    invited: dto.invited ?? false,
    hasAttendees: dto.has_attendees ?? false,
  };
}

function toEvent(dto: EventDto): CalendarEvent {
  return {
    ...toOccurrence(dto),
    rrule: opt(dto.rrule),
    createdBy: opt(dto.created_by),
    updatedAt: dto.updated_at,
    organizer: dto.organizer ? { userId: dto.organizer.user_id, name: dto.organizer.name } : undefined,
    attendees: (dto.attendees ?? []).map((a) => ({
      id: a.id,
      userId: opt(a.user_id),
      email: opt(a.email),
      name: a.name,
      status: a.status,
    })),
  };
}

function toFeed(dto: FeedDto): Feed {
  return { id: dto.id, calendarId: opt(dto.calendar_id), createdAt: dto.created_at, lastUsedAt: opt(dto.last_used_at) };
}

function eventBody(input: EventInput) {
  return {
    title: input.title,
    description: input.description,
    location: input.location,
    all_day: input.allDay,
    start: input.start,
    end: input.end,
    tzid: input.tzid,
    rrule: input.rrule ?? null,
    ...(input.reminderMinutes !== undefined ? { reminder_minutes: input.reminderMinutes } : {}),
    calendar_id: input.calendarId,
    ...(input.attendees
      ? { attendees: input.attendees.map((a) => ("userId" in a ? { user_id: a.userId } : { email: a.email, name: a.name })) }
      : {}),
  };
}

/** `GET /calendars`: every calendar the viewer sees, theirs first. */
export async function listCalendars(signal?: AbortSignal): Promise<Calendar[]> {
  return (await apiGet<CalendarDto[]>("/calendars", signal)).map(toCalendar);
}

type CalendarFields = {
  name: string;
  color: CalendarColor;
  description?: string;
  writeAccess?: "members" | "admins";
  defaultReminderMinutes?: number | null;
};

function calendarBody(fields: Partial<CalendarFields>) {
  return {
    name: fields.name,
    color: fields.color,
    description: fields.description,
    write_access: fields.writeAccess,
    ...(fields.defaultReminderMinutes !== undefined ? { default_reminder_minutes: fields.defaultReminderMinutes } : {}),
  };
}

/** A new calendar: the viewer's own, or a space's (its administrators). */
export async function createCalendar(fields: CalendarFields, spaceId?: string): Promise<Calendar> {
  const path = spaceId ? `/spaces/${spaceId}/calendars` : "/calendars";
  return toCalendar(await apiPost<CalendarDto>(path, calendarBody(fields)));
}

export async function updateCalendar(id: string, fields: Partial<CalendarFields>): Promise<Calendar> {
  return toCalendar(await apiPatch<CalendarDto>(`/calendars/${id}`, calendarBody(fields)));
}

/** Delete a calendar and its events, typing its name as a confirmation. */
export async function deleteCalendar(id: string, confirmName: string): Promise<void> {
  await apiRequest<void>("DELETE", `/calendars/${id}`, { json: { confirm_name: confirmName } });
}

/** The viewer's own settings for a calendar: shown or hidden, their reminder (`"default"` follows the
 *  calendar's again). */
export async function setCalendarMe(id: string, me: { hidden?: boolean; reminderMinutes?: number | null | "default" }): Promise<void> {
  await apiPut<void>(`/calendars/${id}/me`, {
    hidden: me.hidden,
    ...(me.reminderMinutes === "default"
      ? { reminder_default: true }
      : me.reminderMinutes !== undefined
        ? { reminder_minutes: me.reminderMinutes }
        : {}),
  });
}

/** What happens in `[from, to)`, in the given calendars (every visible one by default), and the
 *  events seen through an invitation alone unless `invitations` is false. */
export async function listOccurrences(
  from: string,
  to: string,
  calendarIds?: string[],
  signal?: AbortSignal,
  invitations = true,
): Promise<Occurrence[]> {
  const params = new URLSearchParams({ from, to });
  if (calendarIds && calendarIds.length > 0) params.set("calendars", calendarIds.join(","));
  if (!invitations) params.set("invitations", "false");
  return (await apiGet<OccurrenceDto[]>(`/calendar/occurrences?${params}`, signal)).map(toOccurrence);
}

export async function getEvent(id: string, signal?: AbortSignal): Promise<CalendarEvent> {
  return toEvent(await apiGet<EventDto>(`/events/${id}`, signal));
}

export async function createEvent(calendarId: string, input: EventInput): Promise<CalendarEvent> {
  return toEvent(await apiPost<EventDto>(`/calendars/${calendarId}/events`, eventBody(input)));
}

function scopeQuery(scope: EditScope, recurrenceId?: string): string {
  const params = new URLSearchParams({ scope });
  if (recurrenceId) params.set("recurrence_id", recurrenceId);
  return params.toString();
}

/** Change one occurrence, the following ones, or the whole series. Answers the changed event (the new
 *  series for `following`). */
export async function updateEvent(id: string, input: EventInput, scope: EditScope, recurrenceId?: string): Promise<CalendarEvent> {
  return toEvent(await apiPatch<EventDto>(`/events/${id}?${scopeQuery(scope, recurrenceId)}`, eventBody(input)));
}

export async function deleteEvent(id: string, scope: EditScope, recurrenceId?: string): Promise<void> {
  await apiDelete<void>(`/events/${id}?${scopeQuery(scope, recurrenceId)}`);
}

/** The viewer's own reminder for an event (its whole series); `"default"` follows their calendar
 *  setting again. */
export async function setEventMe(id: string, reminderMinutes: number | null | "default"): Promise<void> {
  await apiPut<void>(`/events/${id}/me`, reminderMinutes === "default" ? { reminder_default: true } : { reminder_minutes: reminderMinutes });
}

export async function listFeeds(signal?: AbortSignal): Promise<Feed[]> {
  return (await apiGet<FeedDto[]>("/calendar/feeds", signal)).map(toFeed);
}

/** A new subscription address, for one calendar or (`null`) for all of them. Its URL is shown once. */
export async function createFeed(calendarId: string | null): Promise<CreatedFeed> {
  const dto = await apiPost<FeedDto>("/calendar/feeds", { calendar_id: calendarId });
  return { ...toFeed(dto), url: dto.url ?? "" };
}

export async function revokeFeed(id: string): Promise<void> {
  await apiDelete<void>(`/calendar/feeds/${id}`);
}

/** Answer an invitation, for the series or for one date of it. */
export async function respondToEvent(id: string, status: Exclude<AttendeeStatus, "needs_action">, recurrenceId?: string): Promise<CalendarEvent> {
  return toEvent(await apiPut<EventDto>(`/events/${id}/response`, { status, recurrence_id: recurrenceId }));
}

/** Who may be invited to an event of this calendar, matching `query`. */
export async function searchInvitees(calendarId: string, query: string, signal?: AbortSignal): Promise<Invitee[]> {
  const params = new URLSearchParams({ q: query });
  const found = await apiGet<{ user_id: string; name: string }[]>(`/calendars/${calendarId}/invitees?${params}`, signal);
  return found.map((p) => ({ userId: p.user_id, name: p.name }));
}

/** When some people are busy over `[from, to)` (31 days at most). */
export async function freeBusy(userIds: string[], from: string, to: string, signal?: AbortSignal): Promise<BusyTimes[]> {
  const found = await apiRequest<{ user_id: string; busy: { start: string; end: string }[] }[]>("POST", "/calendar/freebusy", {
    json: { users: userIds, from, to },
    signal,
  });
  return found.map((p) => ({ userId: p.user_id, busy: p.busy }));
}

type PublicInvitationDto = {
  title: string;
  location?: string | null;
  description?: string | null;
  start: string;
  end: string;
  all_day: boolean;
  tzid?: string | null;
  recurring: boolean;
  organizer?: string | null;
  name?: string | null;
  status: AttendeeStatus;
};

function toPublicInvitation(dto: PublicInvitationDto): PublicInvitation {
  return {
    title: dto.title,
    location: opt(dto.location),
    description: opt(dto.description),
    start: dto.start,
    end: dto.end,
    allDay: dto.all_day,
    tzid: opt(dto.tzid),
    recurring: dto.recurring,
    organizer: opt(dto.organizer),
    name: opt(dto.name),
    status: dto.status,
  };
}

/** `GET /public/invitation/{token}`: no session needed. A `404` means it is no longer there. */
export async function readInvitation(token: string, signal?: AbortSignal): Promise<PublicInvitation> {
  return toPublicInvitation(await apiGet<PublicInvitationDto>(`/public/invitation/${encodeURIComponent(token)}`, signal));
}

/** Answer an invitation from its public page, for every date. */
export async function answerInvitation(token: string, status: Exclude<AttendeeStatus, "needs_action">): Promise<PublicInvitation> {
  return toPublicInvitation(await apiPost<PublicInvitationDto>(`/public/invitation/${encodeURIComponent(token)}`, { status }));
}
