# The calendar

Personal and space calendars, events and recurring series, reminders, and a read-only iCal
subscription. Why recurring events are stored the way they are: [ADR 0004](adr/0004-calendar-data-model.md).

## Calendars and who does what

- **A personal calendar** belongs to one person and nobody else sees it. Everyone has one ("Personnel",
  named in their language, in the colour `accent`: each viewer's own theme accent), created the
  first time they open the calendar, and may make more.
- **A space calendar** is seen by the space's members (`member`, `admin`, `owner`); a guest sees none.
  Each space starts with one, named after the space (it follows a rename of the space until someone
  names it otherwise), in the colour its creator uses least among their spaces, so two spaces rarely
  look alike. Its administrators make more,
  rename, recolour and delete them, and choose for each **who adds events**: every member, or
  administrators only.
- A calendar someone cannot see answers `404`, exactly like one that does not exist. A space's first
  calendar and a person's are renamed but never deleted; deleting any other one asks for its name.
- Visibility is computed from membership on every request: leaving a space takes its calendars, their
  subscription addresses and their reminders away at once.

Colours are the design system's pastels (`sky`, `mint`, `violet`, `pink`, `peach`, `lime`, `sun`), with
the dark ink on them in every theme.

## Events and series

- A timed event is two instants and the IANA time zone it was written in; an all-day event is two
  dates, the end exclusive (one day on the 7th ends on the 8th) and in no time zone.
- A repetition is an RFC 5545 rule. The screen writes daily, weekly (chosen days), monthly (the
  start's day, "the 2nd Thursday", the last working day) and yearly rules, every N, ending never,
  after N times or on a date; any rule read from elsewhere is kept and shown as "custom rule
  (imported)".
- Changing or deleting an occurrence of a series asks: **this one** (an exception), **this one and the
  following ones** (the series is cut in two), or **the whole series** (when its timing changes, the
  occurrences that had only been moved go back to the series and the cancellations stay).

The API: `GET /api/v1/calendars`, `GET /api/v1/calendar/occurrences?from&to&calendars=` (at most 400
days), `POST /api/v1/calendars/{id}/events`, `GET|PATCH|DELETE /api/v1/events/{id}?scope=&recurrence_id=`,
and each viewer's own settings at `PUT /api/v1/calendars/{id}/me` and `PUT /api/v1/events/{id}/me`.
The OpenAPI document has the details. Every change publishes `calendar.changed` to the calendar's
audience, and open screens reload.

## Reminders

- A reminder belongs to a person, not to an event. Who gets one: the owner of a personal calendar;
  every member who sees a space calendar; for an event with attendees, see Invitations below.
- Each calendar has a **default reminder** for its timed events (10 minutes for the first ones; none
  is a valid choice, for a leave calendar say). Each person may override it for a whole calendar or
  for one event. An all-day event reminds only who asked (the evening before at 17:00, or the same
  morning at 9:00, in their profile's time zone).
- `apps/api/src/calendar/reminders.rs` sweeps every minute. A reminder due in the last fifteen minutes
  goes out; a later one (the server was down) is dropped rather than sent at the wrong moment. A log
  (`calendar_reminder_deliveries`) makes sure no occurrence reminds anyone twice, even with two API
  processes.
- It lands in the notification inbox (and by Web Push, like any notification), and by **mail** to
  whoever has no Ruchoir open, when the instance has a mail relay. Quiet hours and "do not disturb"
  hold back the push and the mail; the inbox keeps it. The preferences have a "Calendar reminders"
  row, for the app and for mail.

## Invitations

- **Who may be invited.** To an event of a space calendar: the space's members who see its calendars
  (`member`, `admin`, `owner`; never a guest). To an event of a personal calendar: anyone sharing a
  space with its owner. And anyone by email address; an address that is such a member becomes them.
  Whoever may write in the calendar changes the list, which belongs to the series (and follows it
  when "this and the following ones" splits it). The organiser is the event's author, off the list,
  counted as going. 100 attendees at most.
- **Answers**: yes, maybe, no, for the series or for one date of it (`calendar_attendee_overrides`);
  answering for the series again clears the dates' own answers. Members answer in the event's details
  or from the notification; people invited by address on a public page, `/i/?t=<token>`, for every
  date. Their token is found by its digest and also kept encrypted with the server's key
  (`RUCHOIR_SECRET_ENCRYPTION_KEY`), so every later mail repeats the same link.
- **Seeing an invitation.** Someone invited to an event of a calendar they do not see (someone's
  personal one) sees that event, read only, as long as they share a space with its owner. The
  screen gathers those under an "Invitations received" calendar of theirs, which they may hide.
- **Reminders.** An event with attendees reminds its organiser and the attendees who still may be
  invited and did not decline (that date); without attendees nothing changes.
- **Telling people** (`apps/api/src/calendar/invitations.rs`): an invitation, a change of time or
  place (to those who did not decline), a cancellation or being taken off the list, and a refusal
  (to the organiser only). Members get a notification (`calendar_invitation`, `calendar_update`,
  `calendar_cancel`, `calendar_declined`), pushed, and a mail when no Ruchoir page is open and the
  "Calendar invitations" preference allows it. People invited by address get a mail in the
  organiser's language with the event attached (`METHOD:REQUEST`, or `CANCEL`). Nobody is told of
  their own doing. A notification keeps the event as it was (`notifications.payload`), so a
  cancellation outlives its event.
- **Free/busy**: `POST /api/v1/calendar/freebusy` gives people's busy times (merged, never a title)
  over 31 days at most, for people sharing a space with the caller. Busy means one's own calendars,
  the events one is invited to and did not decline, and those one organises with attendees; a space
  event that asks nothing of anyone keeps nobody busy. The form shows a line per person on the
  event's day and proposes slots when everyone is free ("Find a time").
- **The feed** names each event's organiser and attendees (a member by `urn:uuid:`, never their
  address), and the address for all of someone's calendars carries their invitations.

API: `attendees` in the event body (the whole list; absent leaves it), `organizer`, `attendees` and
`my_status` on an event, `my_status`, `invited` and `has_attendees` on an occurrence,
`PUT /api/v1/events/{id}/response`, `GET /api/v1/calendars/{id}/invitees?q=`,
`POST /api/v1/calendar/freebusy`, `GET|POST /api/v1/public/invitation/{token}`.

## The screen

- **The column** (desktop and tablet, in place of the space's) lists the viewer's calendars in three
  blocks: their own, the space the screen was opened from, and their other spaces, one line per space
  (a space with several calendars unfolds them), folded on demand and searchable beyond six spaces.
- **The filter** never grows with the number of spaces: "This space" or "All my spaces" when the
  screen was opened from a space, a searchable list of spaces from the phone's tab.
- **New events** start from a small bubble beside the slot clicked (title, times, calendar), which
  opens into the full window; the window is laid out not to scroll, and the custom repetition takes
  its place while it is set. The calendar is chosen from a list laid out as the column is (the
  viewer's own, the current space, the others), with colours and a search. Hovering an empty slot
  shows what a click would create. Every form warns
  (without refusing) when the event overlaps another one, in any calendar the viewer sees.
- **The theme's accent** marks what is chosen: the view, the filter, today, and what the small month
  shows (a faint band for the week on screen, a faint pill for a single day).
- **Preferences > Calendar** (kept on the device, like the other preferences, in
  `features/calendar/prefs.ts`): the view it opens on (computer and phone apart), the first day of the
  week, the clock (as the language writes it, 24 or 12 hours), the weekend in the week view, week
  numbers, the hour the grid opens at, the working hours (off by default; once on, the others are
  greyed), and how long a new event lasts.

## Subscribing from a phone

Each person can make a **personal address** for one calendar, or one address for all of them:
`https://<instance>/api/v1/public/ical/<token>.ics`. It is read without a session, so the token is
the whole credential: it is shown once, only its digest is kept, it can be revoked, and requests are
rate-limited like public file links. The file carries the rules, the cancellations and the changed
occurrences, a `VTIMEZONE` for every zone in use, the calendar's name and colour.

To add it: on an iPhone, Settings > Calendar > Accounts > Add Account > Other > Add Subscribed
Calendar; on Android, an app that reads iCal subscriptions (ICSx⁵, for example); in Thunderbird,
New Calendar > On the Network.

## Limits of this first lot

Not yet: linking an event to a channel and attaching files, importing Nextcloud's `.ics`, sharing a personal calendar, several reminders per event,
a year view, printing, searching events, and two-way sync with other calendars (CalDAV).
