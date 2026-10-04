//! Error type for the calendar surface, and its HTTP representation.
//!
//! A calendar the caller cannot see answers exactly like one that does not exist (`404`), so the API
//! never confirms that someone else's calendar, or a space the caller is not in, is there. `403` is
//! for a calendar the caller sees but may not change.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use super::recurrence::RecurrenceError;

#[derive(Debug)]
pub enum CalendarError {
    /// Not there, or not visible to the caller.
    NotFound,
    /// Visible, but the caller may not do this.
    Forbidden,
    /// The request breaks a rule; the static reason is safe to show.
    Invalid(&'static str),
    /// Deleting a calendar needs its exact name.
    ConfirmMismatch,
    /// A space's or a person's first calendar is renamed, never deleted.
    IsDefault,
    /// Anything unexpected. Never leaks internals.
    Internal,
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
    message: &'static str,
}

impl IntoResponse for CalendarError {
    fn into_response(self) -> Response {
        let (status, error, message) = match self {
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                "calendar_not_found",
                "Calendar not found.",
            ),
            Self::Forbidden => (
                StatusCode::FORBIDDEN,
                "calendar_forbidden",
                "You may not change this calendar.",
            ),
            Self::Invalid(message) => (StatusCode::UNPROCESSABLE_ENTITY, "invalid", message),
            Self::ConfirmMismatch => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "calendar_confirm_mismatch",
                "Type the calendar's name to delete it.",
            ),
            Self::IsDefault => (
                StatusCode::CONFLICT,
                "calendar_is_default",
                "This calendar can be renamed but not deleted.",
            ),
            Self::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "An unexpected error occurred.",
            ),
        };
        (status, Json(ErrorBody { error, message })).into_response()
    }
}

impl From<sea_orm::DbErr> for CalendarError {
    fn from(error: sea_orm::DbErr) -> Self {
        tracing::error!(?error, "calendar database error");
        Self::Internal
    }
}

impl From<RecurrenceError> for CalendarError {
    fn from(error: RecurrenceError) -> Self {
        match error {
            RecurrenceError::InvalidRule(_) => Self::Invalid("The repetition rule is not valid."),
            RecurrenceError::RuleTooFine => {
                Self::Invalid("An event may not repeat more often than daily.")
            }
            RecurrenceError::UnknownTimeZone(_) => Self::Invalid("Unknown time zone."),
            RecurrenceError::TooWide => Self::Invalid("A period may not exceed 400 days."),
        }
    }
}
