# The calendar

Personal and space calendars, events and recurring series, reminders, and a read-only iCal
subscription. Why recurring events are stored the way they are: [ADR 0004](adr/0004-calendar-data-model.md).

## Calendars and who does what

- **A personal calendar** belongs to one person and nobody else sees it. Everyone has one ("Perso",
  named in their language), created the first time they open the calendar, and may make more.
- **A space calendar** is seen by the space's members (`member`, `admin`, `owner`); a guest sees none.
  Each space starts with one ("Général", in its owner's language). Its administrators make more,
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
  every member who sees a space calendar.
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

Not yet: inviting people and their answers, linking an event to a channel and attaching files,
free/busy, importing Nextcloud's `.ics`, sharing a personal calendar, several reminders per event,
a year view, printing, searching events, and two-way sync with other calendars (CalDAV).
