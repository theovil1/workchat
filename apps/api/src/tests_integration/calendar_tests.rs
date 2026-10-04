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

/// A space created through the API, as its owner sees it in the response.
async fn create_space(app: &TestApp, cookie: &str, prefix: &str) -> Value {
    let created = app
        .req(reqwest::Method::POST, "/api/v1/spaces", cookie)
        .json(&json!({ "name": format!("{prefix} {}", Uuid::new_v4().simple()) }))
        .send()
        .await
        .expect("create space");
    assert_eq!(created.status(), 201);
    created.json().await.expect("json")
}

async fn rename_space(app: &TestApp, cookie: &str, space: &Value, name: &str) {
    let response = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/spaces/{}", space["id"].as_str().expect("id")),
            cookie,
        )
        .json(&json!({ "name": name }))
        .send()
        .await
        .expect("rename space");
    assert_eq!(response.status(), 200);
}

async fn default_of(app: &TestApp, cookie: &str, space: &Value) -> Value {
    calendars_of(app, cookie)
        .await
        .into_iter()
        .find(|c| c["space_id"] == space["id"] && c["is_default"] == true)
        .expect("the space's default calendar")
}

#[tokio::test]
async fn each_new_space_gets_a_colour_its_owner_does_not_use_yet() {
    let Some(app) = boot().await else { return };
    let alice = make_user(&app.db, "alice").await;
    let cookie = app.cookie_for(alice).await;

    let mut colours = Vec::new();
    for _ in 0..6 {
        let space = create_space(&app, &cookie, "Espace").await;
        colours.push(default_of(&app, &cookie, &space).await["color"].clone());
    }
    let mut distinct = colours.clone();
    distinct.sort_by_key(|c| c.to_string());
    distinct.dedup();
    assert_eq!(distinct.len(), 6, "six spaces, six colours: {colours:?}");
    assert!(!colours.contains(&json!("accent")));
}

#[tokio::test]
async fn a_space_default_calendar_follows_the_space_name_until_renamed_by_hand() {
    let Some(app) = boot().await else { return };
    let alice = make_user(&app.db, "alice").await;
    let cookie = app.cookie_for(alice).await;

    let space = create_space(&app, &cookie, "Atelier").await;
    let fresh = format!("Studio {}", Uuid::new_v4().simple());
    rename_space(&app, &cookie, &space, &fresh).await;
    let calendar = default_of(&app, &cookie, &space).await;
    assert_eq!(calendar["name"], fresh.as_str());

    // Once someone names the calendar themselves, the space's name no longer carries over.
    let renamed = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/calendars/{}", calendar["id"].as_str().expect("id")),
            &cookie,
        )
        .json(&json!({ "name": "Planning" }))
        .send()
        .await
        .expect("rename calendar");
    assert_eq!(renamed.status(), 200);
    rename_space(
        &app,
        &cookie,
        &space,
        &format!("Lumen {}", Uuid::new_v4().simple()),
    )
    .await;
    assert_eq!(default_of(&app, &cookie, &space).await["name"], "Planning");
}

#[tokio::test]
async fn a_calendar_may_follow_the_accent() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.alice).await;
    let alice = app.cookie_for(fx.alice).await;
    let made = create_space_calendar(
        &app,
        &alice,
        fx.space_id,
        json!({ "name": "Accent", "color": "accent" }),
    )
    .await;
    assert_eq!(made.status(), 201);
}

#[tokio::test]
async fn a_space_starts_with_a_calendar_named_after_it_and_a_person_gets_a_personal_one() {
    let Some(app) = boot().await else { return };
    let alice = make_user(&app.db, "alice").await;
    set_locale(&app.db, alice, "fr").await;
    let cookie = app.cookie_for(alice).await;

    let space = create_space(&app, &cookie, "Atelier").await;

    let calendars = calendars_of(&app, &cookie).await;
    let general = calendars
        .iter()
        .find(|c| c["space_id"] == space["id"])
        .expect("the space's calendar");
    assert_eq!(general["name"], space["name"]);
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
    assert_eq!(personal[0]["name"], "Personnel");
    // The personal calendar wears the viewer's own accent, whichever it is.
    assert_eq!(personal[0]["color"], "accent");
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

// --- iCal subscriptions ---------------------------------------------------------------------------

/// Ask for a subscription address; returns (feed id, path to fetch it without a session).
async fn subscribe(app: &TestApp, cookie: &str, calendar_id: Value) -> (Value, String) {
    let created = app
        .req(reqwest::Method::POST, "/api/v1/calendar/feeds", cookie)
        .json(&json!({ "calendar_id": calendar_id }))
        .send()
        .await
        .expect("create feed");
    assert_eq!(created.status(), 201);
    let feed: Value = created.json().await.expect("json");
    let url = feed["url"].as_str().expect("url").to_owned();
    let path = url[url.find("/api/v1/public/ical/").expect("feed path")..].to_owned();
    assert!(path.ends_with(".ics"));
    (feed["id"].clone(), path)
}

/// Fetch a feed the way a phone does: no cookie. Returns the status and the unfolded text.
async fn fetch_feed(app: &TestApp, path: &str) -> (u16, String) {
    let response = app
        .http
        .get(format!("{}{}", app.base, path))
        .send()
        .await
        .expect("fetch feed");
    let status = response.status().as_u16();
    if status == 200 {
        assert_eq!(
            response.headers()["content-type"],
            "text/calendar; charset=utf-8"
        );
    }
    let text = response.text().await.expect("text");
    (status, text.replace("\r\n ", "").replace("\r\n\t", ""))
}

#[tokio::test]
async fn feed_keeps_tzid_and_local_time() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let mut meeting = weekly_meeting("Point équipe; salle 2, étage");
    meeting["location"] = json!("Salle Ouest");
    let event: Value = create_event(&app, &alice, &general["id"], meeting)
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
    let mut moved = weekly_meeting("Point déplacé");
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

    let (_, path) = subscribe(&app, &alice, general["id"].clone()).await;
    let (status, text) = fetch_feed(&app, &path).await;
    assert_eq!(status, 200);
    let calendar = icalendar::parser::read_calendar(&text).expect("a calendar the parser reads");
    let kinds: Vec<String> = calendar
        .components
        .iter()
        .map(|c| c.name.to_string())
        .collect();
    assert_eq!(
        kinds.iter().filter(|k| k.as_str() == "VEVENT").count(),
        2,
        "{text}"
    );
    assert!(kinds.iter().any(|k| k == "VTIMEZONE"), "{text}");
    for line in [
        "BEGIN:VCALENDAR",
        "TZID:Europe/Paris",
        "BEGIN:DAYLIGHT",
        "DTSTART;TZID=Europe/Paris:20261019T090000",
        "DTEND;TZID=Europe/Paris:20261019T094500",
        "RRULE:FREQ=WEEKLY;BYDAY=MO",
        "EXDATE;TZID=Europe/Paris:20261026T090000",
        "RECURRENCE-ID;TZID=Europe/Paris:20261102T090000",
        "DTSTART;TZID=Europe/Paris:20261102T150000",
        "SUMMARY:Point déplacé",
        r"SUMMARY:Point équipe\; salle 2\, étage",
        "LOCATION:Salle Ouest",
        &format!("UID:{}@ruchoir", event["event_id"].as_str().unwrap()),
        &format!("X-WR-CALNAME:{}", general["name"].as_str().unwrap()),
        "X-APPLE-CALENDAR-COLOR:#6fe0c2",
    ] {
        assert!(
            text.lines().any(|l| l == line),
            "missing {line:?} in:\n{text}"
        );
    }
}

#[tokio::test]
async fn the_all_feed_mixes_every_visible_calendar() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let other: Value = app
        .req(reqwest::Method::POST, "/api/v1/spaces", &alice)
        .json(&json!({ "name": format!("Autre {}", Uuid::new_v4().simple()) }))
        .send()
        .await
        .expect("space")
        .json()
        .await
        .expect("json");
    let calendars = calendars_of(&app, &alice).await;
    let personal = calendars
        .iter()
        .find(|c| c["space_id"].is_null())
        .expect("personal");
    let other_general = calendars
        .iter()
        .find(|c| c["space_id"] == other["id"])
        .expect("other space");
    for (calendar, title) in [
        (&general, "Dans l'espace"),
        (personal, "Chez moi"),
        (other_general, "Ailleurs"),
    ] {
        assert_eq!(
            create_event(&app, &alice, &calendar["id"], weekly_meeting(title))
                .await
                .status(),
            201
        );
    }
    let (_, path) = subscribe(&app, &alice, Value::Null).await;
    let (status, text) = fetch_feed(&app, &path).await;
    assert_eq!(status, 200);
    for title in ["Dans l'espace", "Chez moi", "Ailleurs"] {
        assert!(
            text.lines().any(|l| l == format!("SUMMARY:{title}")),
            "missing {title} in:\n{text}"
        );
    }
}

#[tokio::test]
async fn a_revoked_feed_answers_404() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let (id, path) = subscribe(&app, &alice, general["id"].clone()).await;
    assert_eq!(fetch_feed(&app, &path).await.0, 200);
    let revoked = app
        .req(
            reqwest::Method::DELETE,
            &format!("/api/v1/calendar/feeds/{}", id.as_str().unwrap()),
            &alice,
        )
        .send()
        .await
        .expect("revoke");
    assert_eq!(revoked.status(), 204);
    assert_eq!(fetch_feed(&app, &path).await.0, 404);
    // Nonsense answers the same.
    assert_eq!(
        fetch_feed(&app, "/api/v1/public/ical/not-a-token.ics")
            .await
            .0,
        404
    );
    // And someone else cannot revoke what is not theirs.
    let (bob_feed, _) = subscribe(&app, &app.cookie_for(fx.bob).await, Value::Null).await;
    let foreign = app
        .req(
            reqwest::Method::DELETE,
            &format!("/api/v1/calendar/feeds/{}", bob_feed.as_str().unwrap()),
            &alice,
        )
        .send()
        .await
        .expect("foreign revoke");
    assert_eq!(foreign.status(), 404);
}

#[tokio::test]
async fn a_feed_stops_when_its_owner_leaves_the_space() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    create_event(
        &app,
        &alice,
        &general["id"],
        weekly_meeting("Réunion d'équipe"),
    )
    .await;
    let (_, one) = subscribe(&app, &bob, general["id"].clone()).await;
    let (_, all) = subscribe(&app, &bob, Value::Null).await;
    assert!(fetch_feed(&app, &all).await.1.contains("Réunion d'équipe"));

    app.req(
        reqwest::Method::DELETE,
        &format!("/api/v1/spaces/{}/membership", fx.space_id),
        &bob,
    )
    .send()
    .await
    .expect("leave");
    assert_eq!(fetch_feed(&app, &one).await.0, 404);
    let (status, text) = fetch_feed(&app, &all).await;
    assert_eq!(status, 200);
    assert!(!text.contains("Réunion d'équipe"));
}

#[tokio::test]
async fn a_feed_token_is_never_listed_again() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let (id, path) = subscribe(&app, &alice, general["id"].clone()).await;
    fetch_feed(&app, &path).await;
    let listed: Vec<Value> = app
        .req(reqwest::Method::GET, "/api/v1/calendar/feeds", &alice)
        .send()
        .await
        .expect("list")
        .json()
        .await
        .expect("json");
    let mine = listed.iter().find(|f| f["id"] == id).expect("listed");
    assert_eq!(mine["calendar_id"], general["id"]);
    assert!(mine["created_at"].is_string());
    assert!(mine["last_used_at"].is_string());
    let token = &path["/api/v1/public/ical/".len()..path.len() - ".ics".len()];
    let raw = serde_json::to_string(&listed).unwrap();
    assert!(!raw.contains(token));
    assert!(mine.get("url").is_none());
}

// --- Reminders ------------------------------------------------------------------------------------

/// A Wednesday morning in 2031, one per test (`day` of March), so two tests running at once never
/// sweep each other's reminders.
fn sweep_moment(day: u8) -> OffsetDateTime {
    OffsetDateTime::parse(
        &format!("2031-03-{day:02}T10:00:00Z"),
        &time::format_description::well_known::Rfc3339,
    )
    .expect("moment")
}

fn rfc(instant: OffsetDateTime) -> String {
    instant
        .format(&time::format_description::well_known::Rfc3339)
        .expect("format")
}

/// A one-off event starting `minutes` after `now`, in the space's general calendar.
async fn event_in(
    app: &TestApp,
    cookie: &str,
    calendar_id: &Value,
    title: &str,
    now: OffsetDateTime,
    minutes: i64,
) -> Value {
    let start = now + time::Duration::minutes(minutes);
    let created = create_event(
        app,
        cookie,
        calendar_id,
        json!({ "title": title, "all_day": false, "start": rfc(start),
                "end": rfc(start + time::Duration::minutes(30)), "tzid": "Europe/Paris" }),
    )
    .await;
    assert_eq!(created.status(), 201);
    created.json().await.expect("json")
}

/// Who a sweep reminded of `event`.
fn reminded(report: &crate::calendar::reminders::SweepReport, event: &Value) -> Vec<Uuid> {
    let id: Uuid = event["event_id"].as_str().unwrap().parse().unwrap();
    let mut people: Vec<Uuid> = report
        .notified
        .iter()
        .filter(|(_, e, _)| *e == id)
        .map(|(u, _, _)| *u)
        .collect();
    people.sort();
    people
}

fn sorted(mut people: Vec<Uuid>) -> Vec<Uuid> {
    people.sort();
    people
}

#[tokio::test]
async fn space_members_get_the_calendar_default_reminder() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let now = sweep_moment(3);
    // Starts in ten minutes: the default reminder is due now.
    let event = event_in(&app, &alice, &general["id"], "Revue client", now, 10).await;
    // Starts in an hour: not yet.
    let later = event_in(&app, &alice, &general["id"], "Plus tard", now, 60).await;

    let report = crate::calendar::reminders::sweep(&app.state, now)
        .await
        .expect("sweep");
    assert_eq!(
        reminded(&report, &event),
        sorted(vec![fx.alice, fx.bob, fx.carol])
    );
    assert!(reminded(&report, &later).is_empty());

    let inbox: Value = app
        .req(reqwest::Method::GET, "/api/v1/notifications", &bob)
        .send()
        .await
        .expect("inbox")
        .json()
        .await
        .expect("json");
    let reminder = inbox["notifications"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["event_id"] == event["event_id"])
        .expect("the reminder is in bob's inbox");
    assert_eq!(reminder["kind"], "calendar_reminder");
    assert_eq!(reminder["event_title"], "Revue client");
    assert_eq!(
        reminder["event_start"],
        rfc(now + time::Duration::minutes(10))
    );
    assert_eq!(reminder["event_all_day"], false);
    assert_eq!(reminder["space_id"], fx.space_id.to_string());
    assert_eq!(reminder["read"], false);
}

#[tokio::test]
async fn muting_a_calendar_or_an_event_stops_it() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let now = sweep_moment(4);
    let event = event_in(&app, &alice, &general["id"], "Point", now, 10).await;
    app.req(
        reqwest::Method::PUT,
        &format!("/api/v1/calendars/{}/me", general["id"].as_str().unwrap()),
        &app.cookie_for(fx.bob).await,
    )
    .json(&json!({ "reminder_minutes": null }))
    .send()
    .await
    .expect("mute calendar");
    app.req(
        reqwest::Method::PUT,
        &format!("/api/v1/events/{}/me", event["event_id"].as_str().unwrap()),
        &app.cookie_for(fx.carol).await,
    )
    .json(&json!({ "reminder_minutes": null }))
    .send()
    .await
    .expect("mute event");

    let report = crate::calendar::reminders::sweep(&app.state, now)
        .await
        .expect("sweep");
    assert_eq!(reminded(&report, &event), vec![fx.alice]);
}

#[tokio::test]
async fn two_sweeps_send_one_reminder() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let personal = calendars_of(&app, &alice)
        .await
        .into_iter()
        .find(|c| c["space_id"].is_null())
        .expect("personal");
    let now = sweep_moment(5);
    let event = event_in(&app, &alice, &personal["id"], "Dentiste", now, 10).await;

    let (first, second) = tokio::join!(
        crate::calendar::reminders::sweep(&app.state, now),
        crate::calendar::reminders::sweep(&app.state, now)
    );
    let together = reminded(&first.expect("first"), &event).len()
        + reminded(&second.expect("second"), &event).len();
    assert_eq!(together, 1);
    let again = crate::calendar::reminders::sweep(&app.state, now + time::Duration::minutes(1))
        .await
        .expect("third");
    assert!(reminded(&again, &event).is_empty());
    let rows = notifications::Entity::find()
        .filter(notifications::Column::UserId.eq(fx.alice))
        .filter(
            notifications::Column::EventId.eq(event["event_id"]
                .as_str()
                .unwrap()
                .parse::<Uuid>()
                .unwrap()),
        )
        .all(&app.db)
        .await
        .expect("rows");
    assert_eq!(rows.len(), 1);
    // The reminder's own mail was decided when it was made: the unread digest never takes it.
    assert!(rows[0].email_handled_at.is_some());
}

#[tokio::test]
async fn a_late_reminder_is_dropped() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let now = sweep_moment(6);
    let event = event_in(&app, &alice, &general["id"], "Rattrapé", now, 10).await;
    // The server was down: the first sweep runs sixteen minutes after the reminder was due.
    let report = crate::calendar::reminders::sweep(&app.state, now + time::Duration::minutes(16))
        .await
        .expect("sweep");
    assert!(reminded(&report, &event).is_empty());
    // Fifteen minutes late is still on time.
    let report = crate::calendar::reminders::sweep(&app.state, now + time::Duration::minutes(15))
        .await
        .expect("sweep");
    assert_eq!(reminded(&report, &event).len(), 3);
}

#[tokio::test]
async fn a_former_member_gets_no_reminder() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let now = sweep_moment(7);
    let event = event_in(&app, &alice, &general["id"], "Sans Bob", now, 10).await;
    app.req(
        reqwest::Method::DELETE,
        &format!("/api/v1/spaces/{}/membership", fx.space_id),
        &app.cookie_for(fx.bob).await,
    )
    .send()
    .await
    .expect("leave");
    let report = crate::calendar::reminders::sweep(&app.state, now)
        .await
        .expect("sweep");
    assert_eq!(reminded(&report, &event), sorted(vec![fx.alice, fx.carol]));
}

#[tokio::test]
async fn an_all_day_reminder_comes_the_evening_before() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    // 2031-03-11 in Paris starts at 2031-03-10T23:00Z; 17:00 the evening before is 16:00Z.
    let created = create_event(
        &app,
        &alice,
        &general["id"],
        json!({ "title": "Congé", "all_day": true, "start": "2031-03-11", "end": "2031-03-12",
                "reminder_minutes": 420 }),
    )
    .await;
    assert_eq!(created.status(), 201);
    let event: Value = created.json().await.expect("json");
    let evening = OffsetDateTime::parse(
        "2031-03-10T16:00:00Z",
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap();
    let early = crate::calendar::reminders::sweep(&app.state, evening - time::Duration::minutes(1))
        .await
        .expect("sweep");
    assert!(reminded(&early, &event).is_empty());
    let report = crate::calendar::reminders::sweep(&app.state, evening)
        .await
        .expect("sweep");
    // Only who asked: an all-day event takes no calendar default.
    assert_eq!(reminded(&report, &event), vec![fx.alice]);
}

#[tokio::test]
async fn no_mail_when_connected_or_turned_off() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let carol = app.cookie_for(fx.carol).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let now = sweep_moment(12);
    let event = event_in(&app, &alice, &general["id"], "Par mail", now, 10).await;
    // Bob turns reminder mail off; Carol has Ruchoir open.
    let saved = app
        .req(
            reqwest::Method::PUT,
            "/api/v1/me/notification-preferences",
            &bob,
        )
        .json(&json!({ "email_calendar_reminders": false }))
        .send()
        .await
        .expect("prefs");
    assert!(saved.status().is_success());
    let _carol_ws = app.connect_ws(&carol).await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let report = crate::calendar::reminders::sweep(&app.state, now)
        .await
        .expect("sweep");
    assert_eq!(reminded(&report, &event).len(), 3);
    assert!(report.mailed.contains(&fx.alice));
    assert!(!report.mailed.contains(&fx.bob));
    assert!(!report.mailed.contains(&fx.carol));
}

// --- Final review fixes ---------------------------------------------------------------------------

#[tokio::test]
async fn following_from_a_moved_occurrence_keeps_the_edit() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let event: Value = create_event(&app, &alice, &general["id"], weekly_meeting("Point équipe"))
        .await
        .json()
        .await
        .expect("json");
    let mut moved = weekly_meeting("Point équipe");
    moved["start"] = json!("2026-11-02T13:00:00Z");
    moved["end"] = json!("2026-11-02T13:45:00Z");
    edit(
        &app,
        &alice,
        &event["event_id"],
        "scope=this&recurrence_id=2026-11-02T08:00:00Z",
        moved,
    )
    .await;

    // From that moved occurrence on, a new name.
    let mut renamed = weekly_meeting("Nouveau point");
    renamed["start"] = json!("2026-11-02T13:00:00Z");
    renamed["end"] = json!("2026-11-02T13:45:00Z");
    let split = edit(
        &app,
        &alice,
        &event["event_id"],
        "scope=following&recurrence_id=2026-11-02T08:00:00Z",
        renamed,
    )
    .await;
    assert_eq!(split.status(), 200);
    let found = occurrences(&app, &alice, "2026-11-02T00:00:00Z", "2026-11-03T00:00:00Z").await;
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0]["title"], "Nouveau point");
    assert_eq!(found[0]["start"], "2026-11-02T13:00:00Z");
}

#[tokio::test]
async fn following_into_all_day_carries_no_timed_exception() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let event: Value = create_event(&app, &alice, &general["id"], weekly_meeting("Point équipe"))
        .await
        .json()
        .await
        .expect("json");
    let mut moved = weekly_meeting("Point équipe");
    moved["start"] = json!("2026-11-09T13:00:00Z");
    moved["end"] = json!("2026-11-09T13:45:00Z");
    edit(
        &app,
        &alice,
        &event["event_id"],
        "scope=this&recurrence_id=2026-11-09T08:00:00Z",
        moved,
    )
    .await;
    let whole_day = json!({ "title": "Journée d'équipe", "all_day": true, "start": "2026-11-02",
                            "end": "2026-11-03", "rrule": "FREQ=WEEKLY;BYDAY=MO" });
    edit(
        &app,
        &alice,
        &event["event_id"],
        "scope=following&recurrence_id=2026-11-02T08:00:00Z",
        whole_day,
    )
    .await;
    let found = occurrences(&app, &alice, "2026-11-01T00:00:00Z", "2026-11-17T00:00:00Z").await;
    for o in &found {
        let start = o["start"].as_str().unwrap();
        assert_eq!(
            o["all_day"] == true,
            start.len() == 10,
            "mixed occurrence {o}"
        );
    }
    assert!(
        found.iter().all(|o| o["title"] == "Journée d'équipe"),
        "{found:?}"
    );
}

#[tokio::test]
async fn a_new_rule_leaves_no_phantom_occurrence() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let event: Value = create_event(&app, &alice, &general["id"], weekly_meeting("Point équipe"))
        .await
        .json()
        .await
        .expect("json");
    // The 26th is renamed, then the series turns fortnightly: the 26th is no longer one of it.
    let mut renamed = weekly_meeting("Point spécial");
    renamed["start"] = json!("2026-10-26T08:00:00Z");
    renamed["end"] = json!("2026-10-26T08:45:00Z");
    edit(
        &app,
        &alice,
        &event["event_id"],
        "scope=this&recurrence_id=2026-10-26T08:00:00Z",
        renamed,
    )
    .await;
    let mut fortnightly = weekly_meeting("Point équipe");
    fortnightly["rrule"] = json!("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO");
    assert_eq!(
        edit(&app, &alice, &event["event_id"], "scope=all", fortnightly)
            .await
            .status(),
        200
    );
    let found = occurrences(&app, &alice, "2026-10-19T00:00:00Z", "2026-11-10T00:00:00Z").await;
    assert_eq!(
        starts(&found),
        vec!["2026-10-19T07:00:00Z", "2026-11-02T08:00:00Z"]
    );
    // And an exception for a day the series does not have is refused.
    let mut stray = weekly_meeting("Ailleurs");
    stray["start"] = json!("2026-10-21T08:00:00Z");
    stray["end"] = json!("2026-10-21T08:45:00Z");
    assert_eq!(
        edit(
            &app,
            &alice,
            &event["event_id"],
            "scope=this&recurrence_id=2026-10-21T08:00:00Z",
            stray
        )
        .await
        .status(),
        422
    );
}

#[tokio::test]
async fn an_occurrence_keeps_its_own_notes() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let mut meeting = weekly_meeting("Point équipe");
    meeting["description"] = json!("Ordre du jour habituel");
    let event: Value = create_event(&app, &alice, &general["id"], meeting)
        .await
        .json()
        .await
        .expect("json");
    let mut special = weekly_meeting("Point équipe");
    special["start"] = json!("2026-10-26T08:00:00Z");
    special["end"] = json!("2026-10-26T08:45:00Z");
    special["description"] = json!("Bilan du trimestre");
    edit(
        &app,
        &alice,
        &event["event_id"],
        "scope=this&recurrence_id=2026-10-26T08:00:00Z",
        special,
    )
    .await;
    let found = occurrences(&app, &alice, "2026-10-19T00:00:00Z", "2026-11-02T00:00:00Z").await;
    assert_eq!(found[0]["description"], "Ordre du jour habituel");
    assert_eq!(found[1]["description"], "Bilan du trimestre");
}

#[tokio::test]
async fn a_reminder_names_the_moved_occurrence() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let now = sweep_moment(13);
    // A daily 9:00 series; today's occurrence is moved to 11:10 in another room.
    let first = now - time::Duration::days(2);
    let created = create_event(
        &app,
        &alice,
        &general["id"],
        json!({ "title": "Tous les jours", "all_day": false, "start": rfc(first),
                "end": rfc(first + time::Duration::minutes(30)), "tzid": "Europe/Paris",
                "rrule": "FREQ=DAILY", "location": "Salle Ouest" }),
    )
    .await;
    let event: Value = created.json().await.expect("json");
    let moved_start = now + time::Duration::minutes(10);
    let edited = edit(
        &app,
        &alice,
        &event["event_id"],
        &format!("scope=this&recurrence_id={}", rfc(now)),
        json!({ "title": "Exceptionnel", "all_day": false, "start": rfc(moved_start),
                "end": rfc(moved_start + time::Duration::minutes(30)), "tzid": "Europe/Paris",
                "rrule": "FREQ=DAILY", "location": "Salle Est" }),
    )
    .await;
    assert_eq!(edited.status(), 200);
    crate::calendar::reminders::sweep(&app.state, now)
        .await
        .expect("sweep");
    let inbox: Value = app
        .req(reqwest::Method::GET, "/api/v1/notifications", &alice)
        .send()
        .await
        .expect("inbox")
        .json()
        .await
        .expect("json");
    let reminder = inbox["notifications"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["event_id"] == event["event_id"])
        .expect("reminder");
    assert_eq!(reminder["event_title"], "Exceptionnel");
    assert_eq!(reminder["event_location"], "Salle Est");
    assert_eq!(reminder["recurrence_id"], rfc(now).replace("+00:00", "Z"));
}

mod invitation_tests;
