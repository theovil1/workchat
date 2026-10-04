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

/// Wait for a `calendar.changed` event, or `None` within a short window.
async fn calendar_change(ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>) -> Option<Value> {
    let deadline = Duration::from_millis(800);
    while let Ok(Some(Ok(WsMessage::Text(text)))) = tokio::time::timeout(deadline, ws.next()).await
    {
        let Ok(event) = serde_json::from_str::<Value>(text.as_str()) else {
            continue;
        };
        if event["type"] == "calendar.changed" {
            return Some(event);
        }
    }
    None
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

    let event = calendar_change(&mut bob_ws).await.expect("bob is told");
    assert_eq!(event["payload"]["calendar_id"], general["id"]);
    assert!(calendar_change(&mut carol_ws).await.is_none());
    assert!(calendar_change(&mut dave_ws).await.is_none());
}
