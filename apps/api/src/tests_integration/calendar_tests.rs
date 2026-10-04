//! End-to-end tests for the calendar: calendars and their rights, events and series, the iCal
//! subscription and reminders. Same harness as the parent module, same skip rule.

use super::*;

/// Every calendar the caller sees, as the API lists them.
async fn calendars_of(app: &TestApp, cookie: &str) -> Vec<Value> {
    let response = app
        .req(reqwest::Method::GET, "/api/v1/calendars", cookie)
        .send()
        .await
        .expect("list calendars");
    assert_eq!(response.status(), 200);
    response.json().await.expect("json")
}

fn named<'a>(calendars: &'a [Value], name: &str) -> &'a Value {
    calendars
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("no calendar named {name} in {calendars:?}"))
}

async fn set_locale(db: &DatabaseConnection, user_id: Uuid, locale: &str) {
    let mut user = users::Entity::find_by_id(user_id)
        .one(db)
        .await
        .expect("user")
        .expect("user row")
        .into_active_model();
    user.locale = Set(Some(locale.to_owned()));
    user.update(db).await.expect("locale");
}

/// The default calendar of a seeded space (the seed builds spaces by hand, so it appears the first
/// time someone lists their calendars).
async fn space_default(app: &TestApp, cookie: &str, space_id: Uuid) -> Value {
    calendars_of(app, cookie)
        .await
        .into_iter()
        .find(|c| c["space_id"] == space_id.to_string() && c["is_default"] == true)
        .expect("the space's default calendar")
}

async fn create_space_calendar(
    app: &TestApp,
    cookie: &str,
    space_id: Uuid,
    body: Value,
) -> reqwest::Response {
    app.req(
        reqwest::Method::POST,
        &format!("/api/v1/spaces/{space_id}/calendars"),
        cookie,
    )
    .json(&body)
    .send()
    .await
    .expect("create calendar")
}

#[tokio::test]
async fn a_space_starts_with_a_general_calendar_and_a_person_gets_a_personal_one_on_first_visit() {
    let Some(app) = boot().await else { return };
    let alice = make_user(&app.db, "alice").await;
    set_locale(&app.db, alice, "fr").await;
    let cookie = app.cookie_for(alice).await;

    let created = app
        .req(reqwest::Method::POST, "/api/v1/spaces", &cookie)
        .json(&json!({ "name": format!("Atelier {}", Uuid::new_v4().simple()) }))
        .send()
        .await
        .expect("create space");
    assert_eq!(created.status(), 201);
    let space: Value = created.json().await.expect("json");

    let calendars = calendars_of(&app, &cookie).await;
    let general = calendars
        .iter()
        .find(|c| c["space_id"] == space["id"])
        .expect("the space's calendar");
    assert_eq!(general["name"], "Général");
    assert_eq!(general["is_default"], true);
    assert_eq!(general["color"], "mint");
    assert_eq!(general["write_access"], "members");
    assert_eq!(general["default_reminder_minutes"], 10);
    assert_eq!(general["can_manage"], true);
    assert_eq!(general["can_write_events"], true);
    assert_eq!(general["hidden"], false);

    let personal: Vec<&Value> = calendars
        .iter()
        .filter(|c| c["space_id"].is_null())
        .collect();
    assert_eq!(personal.len(), 1);
    assert_eq!(personal[0]["name"], "Perso");
    assert_eq!(personal[0]["color"], "sky");
    assert_eq!(personal[0]["is_default"], true);
    assert_eq!(personal[0]["default_reminder_minutes"], 10);

    // A second visit finds the same calendars, not new ones.
    let again = calendars_of(&app, &cookie).await;
    assert_eq!(again.len(), calendars.len());
}

#[tokio::test]
async fn calendar_rights_follow_roles_and_write_access() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.alice).await;
    make_guest(&app.db, fx.space_id, fx.carol).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let carol = app.cookie_for(fx.carol).await;

    let leave = create_space_calendar(
        &app,
        &alice,
        fx.space_id,
        json!({ "name": "Congés", "color": "peach", "write_access": "admins", "default_reminder_minutes": null }),
    )
    .await;
    assert_eq!(leave.status(), 201);
    let leave: Value = leave.json().await.expect("json");
    assert_eq!(leave["default_reminder_minutes"], Value::Null);

    // A member neither creates nor manages a space calendar.
    let refused = create_space_calendar(
        &app,
        &bob,
        fx.space_id,
        json!({ "name": "Chantiers", "color": "lime" }),
    )
    .await;
    assert_eq!(refused.status(), 403);

    let seen = calendars_of(&app, &bob).await;
    assert_eq!(named(&seen, "Congés")["can_write_events"], false);
    assert_eq!(named(&seen, "Congés")["can_manage"], false);
    let general = space_default(&app, &bob, fx.space_id).await;
    assert_eq!(general["can_write_events"], true);
    assert_eq!(general["can_manage"], false);
    let renamed = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/calendars/{}", leave["id"].as_str().unwrap()),
            &bob,
        )
        .json(&json!({ "name": "Vacances" }))
        .send()
        .await
        .expect("patch");
    assert_eq!(renamed.status(), 403);

    // A guest sees no space calendar, and one addressed by id does not exist for them.
    let guest_sees = calendars_of(&app, &carol).await;
    assert!(guest_sees.iter().all(|c| c["space_id"].is_null()));
    let hidden = app
        .req(
            reqwest::Method::PUT,
            &format!("/api/v1/calendars/{}/me", leave["id"].as_str().unwrap()),
            &carol,
        )
        .json(&json!({ "hidden": true }))
        .send()
        .await
        .expect("put me");
    assert_eq!(hidden.status(), 404);

    // Someone else's personal calendar does not exist either.
    let alice_personal = calendars_of(&app, &alice)
        .await
        .into_iter()
        .find(|c| c["space_id"].is_null())
        .expect("personal");
    for (method, path) in [
        (
            reqwest::Method::PUT,
            format!(
                "/api/v1/calendars/{}/me",
                alice_personal["id"].as_str().unwrap()
            ),
        ),
        (
            reqwest::Method::PATCH,
            format!(
                "/api/v1/calendars/{}",
                alice_personal["id"].as_str().unwrap()
            ),
        ),
    ] {
        let response = app
            .req(method, &path, &bob)
            .json(&json!({ "hidden": true, "name": "Mine" }))
            .send()
            .await
            .expect("foreign personal");
        assert_eq!(response.status(), 404);
    }

    // An administrator closes the general calendar to members, and it shows.
    let closed = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/calendars/{}", general["id"].as_str().unwrap()),
            &alice,
        )
        .json(&json!({ "write_access": "admins", "default_reminder_minutes": 15 }))
        .send()
        .await
        .expect("patch general");
    assert_eq!(closed.status(), 200);
    let general = space_default(&app, &bob, fx.space_id).await;
    assert_eq!(general["can_write_events"], false);
    assert_eq!(general["default_reminder_minutes"], 15);

    // Each person hides and sets their own reminder, whatever their rights.
    let mine = app
        .req(
            reqwest::Method::PUT,
            &format!("/api/v1/calendars/{}/me", general["id"].as_str().unwrap()),
            &bob,
        )
        .json(&json!({ "hidden": true, "reminder_minutes": null }))
        .send()
        .await
        .expect("put me");
    assert_eq!(mine.status(), 204);
    let general = space_default(&app, &bob, fx.space_id).await;
    assert_eq!(general["hidden"], true);
    assert_eq!(general["my_reminder_minutes"], Value::Null);
    assert!(general
        .as_object()
        .unwrap()
        .contains_key("my_reminder_minutes"));
    let for_alice = space_default(&app, &alice, fx.space_id).await;
    assert_eq!(for_alice["hidden"], false);
    assert!(!for_alice
        .as_object()
        .unwrap()
        .contains_key("my_reminder_minutes"));

    // Out-of-palette colours and unknown reminder values are refused.
    for body in [
        json!({ "name": "Rouge", "color": "red" }),
        json!({ "name": "Bizarre", "color": "mint", "default_reminder_minutes": 7 }),
        json!({ "name": "  ", "color": "mint" }),
    ] {
        let refused = create_space_calendar(&app, &alice, fx.space_id, body).await;
        assert_eq!(refused.status(), 422);
    }
}

#[tokio::test]
async fn deleting_a_calendar_needs_its_name_and_never_the_defaults() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.alice).await;
    let alice = app.cookie_for(fx.alice).await;

    let works: Value = create_space_calendar(
        &app,
        &alice,
        fx.space_id,
        json!({ "name": "Chantiers", "color": "lime" }),
    )
    .await
    .json()
    .await
    .expect("json");
    let delete = |id: String, name: String| {
        let request = app
            .req(
                reqwest::Method::DELETE,
                &format!("/api/v1/calendars/{id}"),
                &alice,
            )
            .json(&json!({ "confirm_name": name }));
        async move { request.send().await.expect("delete").status() }
    };
    let id = works["id"].as_str().unwrap().to_owned();
    assert_eq!(delete(id.clone(), "Chantier".to_owned()).await, 422);
    assert_eq!(delete(id.clone(), "Chantiers".to_owned()).await, 204);
    assert!(calendars_of(&app, &alice)
        .await
        .iter()
        .all(|c| c["id"] != id.as_str()));

    let general = space_default(&app, &alice, fx.space_id).await;
    assert_eq!(
        delete(
            general["id"].as_str().unwrap().to_owned(),
            general["name"].as_str().unwrap().to_owned()
        )
        .await,
        409
    );
    let personal = calendars_of(&app, &alice)
        .await
        .into_iter()
        .find(|c| c["space_id"].is_null())
        .expect("personal");
    assert_eq!(
        delete(
            personal["id"].as_str().unwrap().to_owned(),
            personal["name"].as_str().unwrap().to_owned()
        )
        .await,
        409
    );
}

#[tokio::test]
async fn leaving_a_space_hides_its_calendars() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let bob = app.cookie_for(fx.bob).await;
    let general = space_default(&app, &bob, fx.space_id).await;

    let left = app
        .req(
            reqwest::Method::DELETE,
            &format!("/api/v1/spaces/{}/membership", fx.space_id),
            &bob,
        )
        .send()
        .await
        .expect("leave");
    assert_eq!(left.status(), 204);

    let after = calendars_of(&app, &bob).await;
    assert!(after
        .iter()
        .all(|c| c["space_id"] != fx.space_id.to_string()));
    let gone = app
        .req(
            reqwest::Method::PUT,
            &format!("/api/v1/calendars/{}/me", general["id"].as_str().unwrap()),
            &bob,
        )
        .json(&json!({ "hidden": true }))
        .send()
        .await
        .expect("put me");
    assert_eq!(gone.status(), 404);
}

/// Wait for a `calendar.changed` event, or `None` once `window` has passed. Every other frame
/// (presence, pings) is skipped.
async fn calendar_change(
    ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>,
    window: Duration,
) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(left, ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(event) = serde_json::from_str::<Value>(text.as_str()) {
                    if event["type"] == "calendar.changed" {
                        return Some(event);
                    }
                }
            }
            Ok(Some(Ok(_))) => continue,
            _ => return None,
        }
    }
}

#[tokio::test]
async fn a_calendar_change_reaches_its_audience_only() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.alice).await;
    make_guest(&app.db, fx.space_id, fx.carol).await;
    let outsider = make_user(&app.db, "dave").await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;

    let mut bob_ws = app.connect_ws(&app.cookie_for(fx.bob).await).await;
    let mut carol_ws = app.connect_ws(&app.cookie_for(fx.carol).await).await;
    let mut dave_ws = app.connect_ws(&app.cookie_for(outsider).await).await;
    // Let the sockets settle, as the messaging tests do, so the change is not sent before them.
    for ws in [&mut bob_ws, &mut carol_ws, &mut dave_ws] {
        let _ = tokio::time::timeout(Duration::from_millis(300), ws.next()).await;
    }

    let renamed = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/calendars/{}", general["id"].as_str().unwrap()),
            &alice,
        )
        .json(&json!({ "name": "Planning" }))
        .send()
        .await
        .expect("rename");
    assert_eq!(renamed.status(), 200);

    let event = calendar_change(&mut bob_ws, Duration::from_secs(3))
        .await
        .expect("bob is told");
    assert_eq!(event["payload"]["calendar_id"], general["id"]);
    assert!(calendar_change(&mut carol_ws, Duration::from_millis(800))
        .await
        .is_none());
    assert!(calendar_change(&mut dave_ws, Duration::from_millis(800))
        .await
        .is_none());
}

// --- Events, occurrences and series ---------------------------------------------------------------

/// A Monday 9:00 Paris weekly meeting starting on 2026-10-19 (07:00Z, summer time).
fn weekly_meeting(title: &str) -> Value {
    json!({
        "title": title,
        "all_day": false,
        "start": "2026-10-19T07:00:00Z",
        "end": "2026-10-19T07:45:00Z",
        "tzid": "Europe/Paris",
        "rrule": "FREQ=WEEKLY;BYDAY=MO",
    })
}

async fn create_event(
    app: &TestApp,
    cookie: &str,
    calendar_id: &Value,
    body: Value,
) -> reqwest::Response {
    app.req(
        reqwest::Method::POST,
        &format!("/api/v1/calendars/{}/events", calendar_id.as_str().unwrap()),
        cookie,
    )
    .json(&body)
    .send()
    .await
    .expect("create event")
}

async fn occurrences(app: &TestApp, cookie: &str, from: &str, to: &str) -> Vec<Value> {
    let response = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/calendar/occurrences?from={from}&to={to}"),
            cookie,
        )
        .send()
        .await
        .expect("occurrences");
    assert_eq!(response.status(), 200);
    response.json().await.expect("json")
}

fn starts(found: &[Value]) -> Vec<String> {
    found
        .iter()
        .map(|o| o["start"].as_str().unwrap().to_owned())
        .collect()
}

async fn edit(
    app: &TestApp,
    cookie: &str,
    event_id: &Value,
    query: &str,
    body: Value,
) -> reqwest::Response {
    app.req(
        reqwest::Method::PATCH,
        &format!("/api/v1/events/{}?{query}", event_id.as_str().unwrap()),
        cookie,
    )
    .json(&body)
    .send()
    .await
    .expect("edit event")
}

async fn remove(app: &TestApp, cookie: &str, event_id: &Value, query: &str) -> reqwest::StatusCode {
    app.req(
        reqwest::Method::DELETE,
        &format!("/api/v1/events/{}?{query}", event_id.as_str().unwrap()),
        cookie,
    )
    .send()
    .await
    .expect("delete event")
    .status()
}

#[tokio::test]
async fn occurrences_unfold_a_series_and_respect_visibility() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let created = create_event(&app, &alice, &general["id"], weekly_meeting("Point équipe")).await;
    assert_eq!(created.status(), 201);
    let event: Value = created.json().await.expect("json");
    assert_eq!(event["rrule"], "FREQ=WEEKLY;BYDAY=MO");
    assert_eq!(event["is_recurring"], true);

    // Someone in another space, with an event of their own.
    let dave = make_user(&app.db, "dave").await;
    let dave_cookie = app.cookie_for(dave).await;
    let other: Value = app
        .req(reqwest::Method::POST, "/api/v1/spaces", &dave_cookie)
        .json(&json!({ "name": format!("Autre {}", Uuid::new_v4().simple()) }))
        .send()
        .await
        .expect("space")
        .json()
        .await
        .expect("json");
    let other_calendar = calendars_of(&app, &dave_cookie)
        .await
        .into_iter()
        .find(|c| c["space_id"] == other["id"])
        .expect("their calendar");
    assert_eq!(
        create_event(
            &app,
            &dave_cookie,
            &other_calendar["id"],
            weekly_meeting("Ailleurs")
        )
        .await
        .status(),
        201
    );

    let found = occurrences(&app, &alice, "2026-10-19T00:00:00Z", "2026-11-02T00:00:00Z").await;
    assert_eq!(
        starts(&found),
        vec!["2026-10-19T07:00:00Z", "2026-10-26T08:00:00Z"]
    );
    assert!(found.iter().all(|o| o["title"] == "Point équipe"));
    assert_eq!(found[1]["recurrence_id"], "2026-10-26T08:00:00Z");
    assert_eq!(found[1]["calendar_id"], general["id"]);
    assert_eq!(found[1]["can_edit"], true);
    assert_eq!(found[1]["my_reminder_minutes"], 10);

    // Asking for a calendar one cannot see changes nothing.
    let narrowed = app
        .req(
            reqwest::Method::GET,
            &format!(
                "/api/v1/calendar/occurrences?from=2026-10-19T00:00:00Z&to=2026-11-02T00:00:00Z&calendars={}",
                other_calendar["id"].as_str().unwrap()
            ),
            &alice,
        )
        .send()
        .await
        .expect("narrowed");
    let narrowed: Vec<Value> = narrowed.json().await.expect("json");
    assert!(narrowed.is_empty());

    let too_wide = app
        .req(
            reqwest::Method::GET,
            "/api/v1/calendar/occurrences?from=2026-01-01T00:00:00Z&to=2027-02-06T00:00:00Z",
            &alice,
        )
        .send()
        .await
        .expect("too wide");
    assert_eq!(too_wide.status(), 422);
}

#[tokio::test]
async fn editing_this_occurrence_writes_an_exception() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let event: Value = create_event(&app, &alice, &general["id"], weekly_meeting("Point équipe"))
        .await
        .json()
        .await
        .expect("json");

    let mut moved = weekly_meeting("Point spécial");
    moved["start"] = json!("2026-10-26T13:00:00Z");
    moved["end"] = json!("2026-10-26T13:45:00Z");
    let edited = edit(
        &app,
        &alice,
        &event["event_id"],
        "scope=this&recurrence_id=2026-10-26T08:00:00Z",
        moved,
    )
    .await;
    assert_eq!(edited.status(), 200);

    let found = occurrences(&app, &alice, "2026-10-19T00:00:00Z", "2026-11-02T00:00:00Z").await;
    assert_eq!(
        starts(&found),
        vec!["2026-10-19T07:00:00Z", "2026-10-26T13:00:00Z"]
    );
    assert_eq!(found[0]["title"], "Point équipe");
    assert_eq!(found[0]["overridden"], false);
    assert_eq!(found[1]["title"], "Point spécial");
    assert_eq!(found[1]["overridden"], true);
    assert_eq!(found[1]["recurrence_id"], "2026-10-26T08:00:00Z");
}

#[tokio::test]
async fn deleting_this_occurrence_cancels_it() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let event: Value = create_event(&app, &alice, &general["id"], weekly_meeting("Point équipe"))
        .await
        .json()
        .await
        .expect("json");

    assert_eq!(
        remove(
            &app,
            &alice,
            &event["event_id"],
            "scope=this&recurrence_id=2026-11-02T08:00:00Z"
        )
        .await,
        204
    );
    let found = occurrences(&app, &alice, "2026-10-19T00:00:00Z", "2026-11-10T00:00:00Z").await;
    assert_eq!(
        starts(&found),
        vec![
            "2026-10-19T07:00:00Z",
            "2026-10-26T08:00:00Z",
            "2026-11-09T08:00:00Z"
        ]
    );

    // A one-off event goes away whole, whatever the scope says.
    let single: Value = create_event(
        &app,
        &alice,
        &general["id"],
        json!({ "title": "Café", "all_day": false, "start": "2026-10-20T08:00:00Z",
                "end": "2026-10-20T08:30:00Z", "tzid": "Europe/Paris" }),
    )
    .await
    .json()
    .await
    .expect("json");
    assert_eq!(
        remove(&app, &alice, &single["event_id"], "scope=this").await,
        204
    );
    let found = occurrences(&app, &alice, "2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z").await;
    assert!(found.iter().all(|o| o["title"] != "Café"));
}

#[tokio::test]
async fn editing_following_moves_later_exceptions() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let event: Value = create_event(&app, &alice, &general["id"], weekly_meeting("Point équipe"))
        .await
        .json()
        .await
        .expect("json");
    // The 2nd of November (third Monday) moves to the afternoon.
    let mut moved = weekly_meeting("Point équipe");
    moved["start"] = json!("2026-11-02T14:00:00Z");
    moved["end"] = json!("2026-11-02T14:45:00Z");
    assert_eq!(
        edit(
            &app,
            &alice,
            &event["event_id"],
            "scope=this&recurrence_id=2026-11-02T08:00:00Z",
            moved
        )
        .await
        .status(),
        200
    );

    // From the second Monday on, the meeting has a new name.
    let mut renamed = weekly_meeting("Nouveau point");
    renamed["start"] = json!("2026-10-26T08:00:00Z");
    renamed["end"] = json!("2026-10-26T08:45:00Z");
    let split = edit(
        &app,
        &alice,
        &event["event_id"],
        "scope=following&recurrence_id=2026-10-26T08:00:00Z",
        renamed,
    )
    .await;
    assert_eq!(split.status(), 200);
    let second: Value = split.json().await.expect("json");
    assert_ne!(second["event_id"], event["event_id"]);

    let first: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/events/{}", event["event_id"].as_str().unwrap()),
            &alice,
        )
        .send()
        .await
        .expect("get")
        .json()
        .await
        .expect("json");
    assert_eq!(
        first["rrule"],
        "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261026T075959Z"
    );

    let found = occurrences(&app, &alice, "2026-10-19T00:00:00Z", "2026-11-10T00:00:00Z").await;
    assert_eq!(
        starts(&found),
        vec![
            "2026-10-19T07:00:00Z",
            "2026-10-26T08:00:00Z",
            "2026-11-02T14:00:00Z",
            "2026-11-09T08:00:00Z"
        ]
    );
    assert_eq!(found[0]["title"], "Point équipe");
    assert_eq!(found[0]["event_id"], event["event_id"]);
    for later in &found[1..] {
        assert_eq!(later["event_id"], second["event_id"]);
    }
    assert_eq!(found[2]["overridden"], true);
}

#[tokio::test]
async fn editing_all_with_a_new_time_drops_moves_and_keeps_cancellations() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let event: Value = create_event(&app, &alice, &general["id"], weekly_meeting("Point équipe"))
        .await
        .json()
        .await
        .expect("json");
    assert_eq!(
        remove(
            &app,
            &alice,
            &event["event_id"],
            "scope=this&recurrence_id=2026-10-26T08:00:00Z"
        )
        .await,
        204
    );
    let mut moved = weekly_meeting("Point équipe");
    moved["start"] = json!("2026-11-02T14:00:00Z");
    moved["end"] = json!("2026-11-02T14:45:00Z");
    assert_eq!(
        edit(
            &app,
            &alice,
            &event["event_id"],
            "scope=this&recurrence_id=2026-11-02T08:00:00Z",
            moved
        )
        .await
        .status(),
        200
    );

    // The whole series moves an hour later: 10:00 in Paris.
    let mut later = weekly_meeting("Point équipe");
    later["start"] = json!("2026-10-19T08:00:00Z");
    later["end"] = json!("2026-10-19T08:45:00Z");
    assert_eq!(
        edit(&app, &alice, &event["event_id"], "scope=all", later)
            .await
            .status(),
        200
    );

    let found = occurrences(&app, &alice, "2026-10-19T00:00:00Z", "2026-11-10T00:00:00Z").await;
    assert_eq!(
        starts(&found),
        vec![
            "2026-10-19T08:00:00Z",
            "2026-11-02T09:00:00Z",
            "2026-11-09T09:00:00Z"
        ]
    );
    assert!(found.iter().all(|o| o["overridden"] == false));
}

#[tokio::test]
async fn the_ui_cannot_create_an_hourly_rule() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let mut hourly = weekly_meeting("Trop souvent");
    hourly["rrule"] = json!("FREQ=HOURLY");
    assert_eq!(
        create_event(&app, &alice, &general["id"], hourly)
            .await
            .status(),
        422
    );
}

#[tokio::test]
async fn limits_on_text_fields() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let mut bodies = Vec::new();
    bodies.push(weekly_meeting(&"a".repeat(501)));
    bodies.push(weekly_meeting("   "));
    let mut far_place = weekly_meeting("Lieu");
    far_place["location"] = json!("b".repeat(501));
    bodies.push(far_place);
    let mut long_text = weekly_meeting("Texte");
    long_text["description"] = json!("c".repeat(20_001));
    bodies.push(long_text);
    let mut backwards = weekly_meeting("À l'envers");
    backwards["end"] = json!("2026-10-19T06:00:00Z");
    bodies.push(backwards);
    bodies.push(
        json!({ "title": "Vide", "all_day": true, "start": "2026-10-20", "end": "2026-10-20" }),
    );
    let mut nowhere = weekly_meeting("Nulle part");
    nowhere["tzid"] = json!("Mars/Olympus");
    bodies.push(nowhere);
    for body in bodies {
        assert_eq!(
            create_event(&app, &alice, &general["id"], body)
                .await
                .status(),
            422
        );
    }
    // The limits themselves are allowed.
    let mut longest = weekly_meeting(&"a".repeat(500));
    longest["location"] = json!("b".repeat(500));
    longest["description"] = json!("c".repeat(20_000));
    assert_eq!(
        create_event(&app, &alice, &general["id"], longest)
            .await
            .status(),
        201
    );
}

#[tokio::test]
async fn a_member_without_write_access_can_still_set_their_reminder() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.alice).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    app.req(
        reqwest::Method::PATCH,
        &format!("/api/v1/calendars/{}", general["id"].as_str().unwrap()),
        &alice,
    )
    .json(&json!({ "write_access": "admins" }))
    .send()
    .await
    .expect("close");

    assert_eq!(
        create_event(&app, &bob, &general["id"], weekly_meeting("Moi aussi"))
            .await
            .status(),
        403
    );
    let event: Value = create_event(&app, &alice, &general["id"], weekly_meeting("Point équipe"))
        .await
        .json()
        .await
        .expect("json");
    assert_eq!(
        edit(
            &app,
            &bob,
            &event["event_id"],
            "scope=all",
            weekly_meeting("Changé")
        )
        .await
        .status(),
        403
    );

    let mine = app
        .req(
            reqwest::Method::PUT,
            &format!("/api/v1/events/{}/me", event["event_id"].as_str().unwrap()),
            &bob,
        )
        .json(&json!({ "reminder_minutes": 30 }))
        .send()
        .await
        .expect("my reminder");
    assert_eq!(mine.status(), 204);
    let for_bob = occurrences(&app, &bob, "2026-10-19T00:00:00Z", "2026-10-20T00:00:00Z").await;
    assert_eq!(for_bob[0]["my_reminder_minutes"], 30);
    assert_eq!(for_bob[0]["can_edit"], false);
    let for_alice = occurrences(&app, &alice, "2026-10-19T00:00:00Z", "2026-10-20T00:00:00Z").await;
    assert_eq!(for_alice[0]["my_reminder_minutes"], 10);

    // An all-day event takes only the all-day delays.
    let off_day = app
        .req(
            reqwest::Method::PUT,
            &format!("/api/v1/events/{}/me", event["event_id"].as_str().unwrap()),
            &bob,
        )
        .json(&json!({ "reminder_minutes": 420 }))
        .send()
        .await
        .expect("bad delay");
    assert_eq!(off_day.status(), 422);
}
