//! The calendar router. Absolute `/api/v1/...` paths, merged into the main router in `http.rs`.

use axum::routing::{get, patch, post, put};
use axum::Router;

use crate::state::AppState;

use super::calendars;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/calendars",
            get(calendars::list_calendars).post(calendars::create_personal_calendar),
        )
        .route(
            "/api/v1/spaces/{space_id}/calendars",
            post(calendars::create_space_calendar),
        )
        .route(
            "/api/v1/calendars/{calendar_id}",
            patch(calendars::update_calendar).delete(calendars::delete_calendar),
        )
        .route(
            "/api/v1/calendars/{calendar_id}/me",
            put(calendars::put_calendar_me),
        )
}
