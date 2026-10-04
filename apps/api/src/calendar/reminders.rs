//! Reminders: which one applies to whom, and (later in this module) the sweep that sends them.

/// The reminder a person gets for an event, in minutes: before its start for a timed event, before
/// the local midnight that starts it for an all-day one (`420` the evening before at 17:00, `-540`
/// the same morning at 9:00). `None` is no reminder.
///
/// Their choice for the event wins, then their choice for the calendar, then the calendar's default.
/// The last two speak of timed events only: an all-day event reminds nobody unless they asked.
pub fn effective_minutes(
    event_pref: Option<Option<i32>>,
    calendar_pref: Option<Option<i32>>,
    calendar_default: Option<i32>,
    all_day: bool,
) -> Option<i32> {
    match event_pref {
        Some(chosen) => chosen,
        None if all_day => None,
        None => calendar_pref.unwrap_or(calendar_default),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_most_specific_choice_wins() {
        // Nothing chosen: the calendar's default.
        assert_eq!(effective_minutes(None, None, Some(10), false), Some(10));
        // The person's calendar setting over the default, including "none".
        assert_eq!(
            effective_minutes(None, Some(Some(30)), Some(10), false),
            Some(30)
        );
        assert_eq!(effective_minutes(None, Some(None), Some(10), false), None);
        // The person's event setting over everything.
        assert_eq!(
            effective_minutes(Some(Some(60)), Some(Some(30)), Some(10), false),
            Some(60)
        );
        assert_eq!(
            effective_minutes(Some(None), Some(Some(30)), Some(10), false),
            None
        );
        // A calendar without a default reminds nobody who did not ask.
        assert_eq!(effective_minutes(None, None, None, false), None);
    }

    #[test]
    fn an_all_day_event_reminds_only_who_asked() {
        assert_eq!(effective_minutes(None, None, Some(10), true), None);
        assert_eq!(
            effective_minutes(None, Some(Some(30)), Some(10), true),
            None
        );
        assert_eq!(
            effective_minutes(Some(Some(420)), None, Some(10), true),
            Some(420)
        );
        assert_eq!(
            effective_minutes(Some(Some(-540)), None, None, true),
            Some(-540)
        );
    }
}
