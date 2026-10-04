//! Invitations and free/busy: who may be invited, who sees an invitation, answers for a series and
//! for one date, reminders, notifications, the public answer page and the busy times.

use super::*;

/// The caller's own default calendar.
async fn personal_of(app: &TestApp, cookie: &str) -> Value {
    calendars_of(app, cookie)
        .await
        .into_iter()
        .find(|c| c["space_id"].is_null() && c["is_default"] == true)
        .expect("a personal calendar")
}

fn meeting(title: &str, attendees: Value) -> Value {
    json!({
        "title": title,
        "all_day": false,
        "start": "2026-10-20T08:00:00Z",
        "end": "2026-10-20T09:00:00Z",
        "tzid": "Europe/Paris",
        "attendees": attendees,
    })
}

async fn get_event(app: &TestApp, cookie: &str, event_id: &Value) -> reqwest::Response {
    app.req(
        reqwest::Method::GET,
        &format!("/api/v1/events/{}", event_id.as_str().unwrap()),
        cookie,
    )
    .send()
    .await
    .expect("get event")
}

async fn respond(app: &TestApp, cookie: &str, event_id: &Value, body: Value) -> reqwest::Response {
    app.req(
        reqwest::Method::PUT,
        &format!("/api/v1/events/{}/response", event_id.as_str().unwrap()),
        cookie,
    )
    .json(&body)
    .send()
    .await
    .expect("respond")
}

async fn email_of(db: &DatabaseConnection, user: Uuid) -> String {
    users::Entity::find_by_id(user)
        .one(db)
        .await
        .expect("user")
        .expect("user row")
        .email
}

fn statuses(event: &Value) -> Vec<(String, String)> {
    let mut found: Vec<(String, String)> = event["attendees"]
        .as_array()
        .expect("attendees")
        .iter()
        .map(|a| {
            (
                a["name"].as_str().unwrap_or_default().to_owned(),
                a["status"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    found.sort();
    found
}

#[tokio::test]
async fn inviting_follows_who_may_be_invited() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    make_guest(&app.db, fx.space_id, fx.carol).await;
    let dave = make_user(&app.db, "dave").await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;

    // A guest of the space, or a stranger to it, cannot be invited to the space's calendar.
    for refused in [fx.carol, dave] {
        let response = create_event(
            &app,
            &alice,
            &general["id"],
            meeting("Point", json!([{ "user_id": refused }])),
        )
        .await;
        assert_eq!(response.status(), 422, "{refused} should be refused");
    }

    // A member by account, the same member again by address, and someone from outside.
    let bob_email = email_of(&app.db, fx.bob).await.to_uppercase();
    let created = create_event(
        &app,
        &alice,
        &general["id"],
        meeting(
            "Point",
            json!([
                { "user_id": fx.bob },
                { "email": bob_email },
                { "email": "client@outside.test", "name": "Client" },
            ]),
        ),
    )
    .await;
    assert_eq!(created.status(), 201);
    let event: Value = created.json().await.expect("json");
    assert_eq!(
        statuses(&event),
        vec![
            ("Client".to_owned(), "needs_action".to_owned()),
            ("bob".to_owned(), "needs_action".to_owned()),
        ]
    );
    assert_eq!(event["organizer"]["user_id"], fx.alice.to_string());
    assert_eq!(event["organizer"]["name"], "alice");
    // The organizer counts as going.
    assert_eq!(event["my_status"], "accepted");

    // From a personal calendar: anyone sharing a space, never a stranger.
    let mine = personal_of(&app, &alice).await;
    let stranger = create_event(
        &app,
        &alice,
        &mine["id"],
        meeting("Déjeuner", json!([{ "user_id": dave }])),
    )
    .await;
    assert_eq!(stranger.status(), 422);
    let lunch = create_event(
        &app,
        &alice,
        &mine["id"],
        meeting("Déjeuner", json!([{ "user_id": fx.carol }])),
    )
    .await;
    assert_eq!(lunch.status(), 201, "a guest of a shared space shares it");
}

#[tokio::test]
async fn the_invitee_search_offers_who_may_be_invited() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    make_guest(&app.db, fx.space_id, fx.carol).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;

    let found: Vec<Value> = app
        .req(
            reqwest::Method::GET,
            &format!(
                "/api/v1/calendars/{}/invitees?q=",
                general["id"].as_str().unwrap()
            ),
            &alice,
        )
        .send()
        .await
        .expect("search")
        .json()
        .await
        .expect("json");
    let names: Vec<&str> = found.iter().map(|p| p["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["bob"], "neither the caller nor a guest");

    let none: Vec<Value> = app
        .req(
            reqwest::Method::GET,
            &format!(
                "/api/v1/calendars/{}/invitees?q=zzz",
                general["id"].as_str().unwrap()
            ),
            &alice,
        )
        .send()
        .await
        .expect("search")
        .json()
        .await
        .expect("json");
    assert!(none.is_empty());
}

#[tokio::test]
async fn an_invitee_sees_but_cannot_edit() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let carol = app.cookie_for(fx.carol).await;
    let mine = personal_of(&app, &alice).await;
    let created: Value = create_event(
        &app,
        &alice,
        &mine["id"],
        meeting("Déjeuner", json!([{ "user_id": fx.bob }])),
    )
    .await
    .json()
    .await
    .expect("json");

    let seen = get_event(&app, &bob, &created["event_id"]).await;
    assert_eq!(seen.status(), 200);
    let seen: Value = seen.json().await.expect("json");
    assert_eq!(seen["can_edit"], false);
    assert_eq!(seen["my_status"], "needs_action");

    let found = occurrences(&app, &bob, "2026-10-19T00:00:00Z", "2026-10-26T00:00:00Z").await;
    let lunch = found
        .iter()
        .find(|o| o["title"] == "Déjeuner")
        .expect("bob sees his invitation");
    assert_eq!(lunch["invited"], true);
    assert_eq!(lunch["my_status"], "needs_action");
    assert_eq!(lunch["has_attendees"], true);

    let changed = edit(
        &app,
        &bob,
        &created["event_id"],
        "",
        meeting("Déjeuner pris", json!([])),
    )
    .await;
    assert_eq!(changed.status(), 403);

    // Someone not invited sees nothing of it.
    assert_eq!(
        get_event(&app, &carol, &created["event_id"]).await.status(),
        404
    );
    let theirs = occurrences(&app, &carol, "2026-10-19T00:00:00Z", "2026-10-26T00:00:00Z").await;
    assert!(theirs.iter().all(|o| o["title"] != "Déjeuner"));
}

#[tokio::test]
async fn an_invitee_without_a_shared_space_loses_the_event() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let mine = personal_of(&app, &alice).await;
    let created: Value = create_event(
        &app,
        &alice,
        &mine["id"],
        meeting("Déjeuner", json!([{ "user_id": fx.bob }])),
    )
    .await
    .json()
    .await
    .expect("json");

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
    assert_eq!(
        get_event(&app, &bob, &created["event_id"]).await.status(),
        404
    );
    let found = occurrences(&app, &bob, "2026-10-19T00:00:00Z", "2026-10-26T00:00:00Z").await;
    assert!(found.iter().all(|o| o["title"] != "Déjeuner"));
}

#[tokio::test]
async fn answering_for_the_series_and_for_one_date() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let carol = app.cookie_for(fx.carol).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let mut body = weekly_meeting("Point équipe");
    body["attendees"] = json!([{ "user_id": fx.bob }]);
    let created: Value = create_event(&app, &alice, &general["id"], body)
        .await
        .json()
        .await
        .expect("json");

    // Someone who is not invited has nothing to answer.
    assert_eq!(
        respond(
            &app,
            &carol,
            &created["event_id"],
            json!({ "status": "accepted" })
        )
        .await
        .status(),
        403
    );
    // "No answer" is not an answer.
    assert_eq!(
        respond(
            &app,
            &bob,
            &created["event_id"],
            json!({ "status": "needs_action" })
        )
        .await
        .status(),
        422
    );
    assert_eq!(
        respond(
            &app,
            &bob,
            &created["event_id"],
            json!({ "status": "accepted" })
        )
        .await
        .status(),
        200
    );
    let answered = respond(
        &app,
        &bob,
        &created["event_id"],
        json!({ "status": "declined", "recurrence_id": "2026-10-26T08:00:00Z" }),
    )
    .await;
    assert_eq!(answered.status(), 200);
    // A date that is not one of the series.
    assert_eq!(
        respond(
            &app,
            &bob,
            &created["event_id"],
            json!({ "status": "declined", "recurrence_id": "2026-10-27T07:00:00Z" }),
        )
        .await
        .status(),
        422
    );

    let found = occurrences(&app, &bob, "2026-10-19T00:00:00Z", "2026-11-03T00:00:00Z").await;
    let mine: Vec<(String, String)> = found
        .iter()
        .map(|o| {
            (
                o["start"].as_str().unwrap().to_owned(),
                o["my_status"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        mine,
        vec![
            ("2026-10-19T07:00:00Z".to_owned(), "accepted".to_owned()),
            ("2026-10-26T08:00:00Z".to_owned(), "declined".to_owned()),
            ("2026-11-02T08:00:00Z".to_owned(), "accepted".to_owned()),
        ]
    );
    // Carol is in the space and sees the meeting, but it asks nothing of her.
    let hers = occurrences(&app, &carol, "2026-10-19T00:00:00Z", "2026-10-20T00:00:00Z").await;
    assert_eq!(hers[0]["my_status"], Value::Null);
    assert_eq!(hers[0]["invited"], false);
    let event: Value = get_event(&app, &alice, &created["event_id"])
        .await
        .json()
        .await
        .expect("json");
    assert_eq!(
        statuses(&event),
        vec![("bob".to_owned(), "accepted".to_owned())]
    );

    // Answering for the series again clears the date's own answer.
    respond(
        &app,
        &bob,
        &created["event_id"],
        json!({ "status": "tentative" }),
    )
    .await;
    let again = occurrences(&app, &bob, "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z").await;
    assert_eq!(again[0]["my_status"], "tentative");
}

#[tokio::test]
async fn following_copies_the_attendees() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let mut body = weekly_meeting("Point équipe");
    body["attendees"] = json!([{ "user_id": fx.bob }]);
    let created: Value = create_event(&app, &alice, &general["id"], body)
        .await
        .json()
        .await
        .expect("json");
    respond(
        &app,
        &bob,
        &created["event_id"],
        json!({ "status": "accepted" }),
    )
    .await;

    let mut later = weekly_meeting("Point équipe (nouveau)");
    later["start"] = json!("2026-11-02T09:00:00Z");
    later["end"] = json!("2026-11-02T09:45:00Z");
    let split = edit(
        &app,
        &alice,
        &created["event_id"],
        "scope=following&recurrence_id=2026-11-02T08:00:00Z",
        later,
    )
    .await;
    assert_eq!(split.status(), 200);
    let new_series: Value = split.json().await.expect("json");
    assert_ne!(new_series["event_id"], created["event_id"]);
    assert_eq!(
        statuses(&new_series),
        vec![("bob".to_owned(), "accepted".to_owned())]
    );
}

#[tokio::test]
async fn attendees_change_only_when_sent() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let created: Value = create_event(
        &app,
        &alice,
        &general["id"],
        meeting("Point", json!([{ "user_id": fx.bob }])),
    )
    .await
    .json()
    .await
    .expect("json");

    // A change without `attendees` keeps them.
    let mut renamed = meeting("Point renommé", json!(null));
    renamed.as_object_mut().unwrap().remove("attendees");
    let kept: Value = edit(&app, &alice, &created["event_id"], "", renamed)
        .await
        .json()
        .await
        .expect("json");
    assert_eq!(kept["attendees"].as_array().unwrap().len(), 1);

    // An empty list removes them.
    let cleared: Value = edit(
        &app,
        &alice,
        &created["event_id"],
        "",
        meeting("Point", json!([])),
    )
    .await
    .json()
    .await
    .expect("json");
    assert!(cleared["attendees"].as_array().unwrap().is_empty());
    assert_eq!(cleared["my_status"], Value::Null);
}

/// An event starting `minutes` after `now`, with attendees, and a weekly rule when asked.
async fn invited_event(
    app: &TestApp,
    cookie: &str,
    calendar_id: &Value,
    now: OffsetDateTime,
    minutes: i64,
    attendees: Value,
    weekly: bool,
) -> Value {
    let start = now + time::Duration::minutes(minutes);
    let mut body = json!({ "title": "Revue", "all_day": false, "start": rfc(start),
        "end": rfc(start + time::Duration::minutes(30)), "tzid": "Europe/Paris",
        "attendees": attendees });
    if weekly {
        body["rrule"] = json!("FREQ=WEEKLY");
    }
    let created = create_event(app, cookie, calendar_id, body).await;
    assert_eq!(created.status(), 201);
    created.json().await.expect("json")
}

#[tokio::test]
async fn with_attendees_only_they_are_reminded() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let mine = personal_of(&app, &alice).await;
    let now = sweep_moment(12);
    let bob_only = json!([{ "user_id": fx.bob }]);

    // A space event with attendees: its organiser and its attendees, not the rest of the space.
    let space_event = invited_event(
        &app,
        &alice,
        &general["id"],
        now,
        10,
        bob_only.clone(),
        false,
    )
    .await;
    // A personal event: its invitee too, who does not see the calendar.
    let personal = invited_event(&app, &alice, &mine["id"], now, 10, bob_only.clone(), false).await;
    // Declined: not reminded.
    let declined = invited_event(
        &app,
        &alice,
        &general["id"],
        now,
        10,
        bob_only.clone(),
        false,
    )
    .await;
    respond(
        &app,
        &bob,
        &declined["event_id"],
        json!({ "status": "declined" }),
    )
    .await;
    // Declined for this date only.
    let series = invited_event(&app, &alice, &general["id"], now, 10, bob_only, true).await;
    respond(
        &app,
        &bob,
        &series["event_id"],
        json!({ "status": "declined", "recurrence_id": rfc(now + time::Duration::minutes(10)) }),
    )
    .await;

    let report = crate::calendar::reminders::sweep(&app.state, now)
        .await
        .expect("sweep");
    assert_eq!(
        reminded(&report, &space_event),
        sorted(vec![fx.alice, fx.bob])
    );
    assert_eq!(reminded(&report, &personal), sorted(vec![fx.alice, fx.bob]));
    assert_eq!(reminded(&report, &declined), vec![fx.alice]);
    assert_eq!(reminded(&report, &series), vec![fx.alice]);
}

async fn freebusy(app: &TestApp, cookie: &str, users: Value) -> reqwest::Response {
    app.req(reqwest::Method::POST, "/api/v1/calendar/freebusy", cookie)
        .json(&json!({ "users": users, "from": "2026-10-20T00:00:00Z", "to": "2026-10-21T00:00:00Z" }))
        .send()
        .await
        .expect("freebusy")
}

fn slot(title: &str, start: &str, end: &str, attendees: Value) -> Value {
    json!({ "title": title, "all_day": false, "start": start, "end": end,
            "tzid": "Europe/Paris", "attendees": attendees })
}

#[tokio::test]
async fn freebusy_hides_titles_and_strangers() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let dave = make_user(&app.db, "dave").await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let bobs = personal_of(&app, &bob).await;

    // Bob's own calendar: busy, twice, overlapping.
    create_event(
        &app,
        &bob,
        &bobs["id"],
        slot(
            "Dentiste",
            "2026-10-20T08:00:00Z",
            "2026-10-20T09:00:00Z",
            json!([]),
        ),
    )
    .await;
    create_event(
        &app,
        &bob,
        &bobs["id"],
        slot(
            "Trajet",
            "2026-10-20T08:30:00Z",
            "2026-10-20T09:30:00Z",
            json!([]),
        ),
    )
    .await;
    // A space event that asks nothing of him: not busy.
    create_event(
        &app,
        &alice,
        &general["id"],
        slot(
            "Congé Carol",
            "2026-10-20T10:00:00Z",
            "2026-10-20T11:00:00Z",
            json!([]),
        ),
    )
    .await;
    // Invited and not declined: busy. Declined: free.
    create_event(
        &app,
        &alice,
        &general["id"],
        slot(
            "Revue",
            "2026-10-20T12:00:00Z",
            "2026-10-20T13:00:00Z",
            json!([{ "user_id": fx.bob }]),
        ),
    )
    .await;
    let declined: Value = create_event(
        &app,
        &alice,
        &general["id"],
        slot(
            "Comité",
            "2026-10-20T14:00:00Z",
            "2026-10-20T15:00:00Z",
            json!([{ "user_id": fx.bob }]),
        ),
    )
    .await
    .json()
    .await
    .expect("json");
    respond(
        &app,
        &bob,
        &declined["event_id"],
        json!({ "status": "declined" }),
    )
    .await;
    // Organising an event with attendees makes Alice busy.
    let answer = freebusy(&app, &alice, json!([fx.bob, fx.alice])).await;
    assert_eq!(answer.status(), 200);
    let answer: Value = answer.json().await.expect("json");
    let text = answer.to_string();
    assert!(
        !text.contains("Dentiste") && !text.contains("Revue"),
        "no titles: {text}"
    );
    let busy_of = |user: Uuid| -> Vec<(String, String)> {
        answer
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["user_id"] == user.to_string())
            .expect("a person")["busy"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| {
                (
                    b["start"].as_str().unwrap().to_owned(),
                    b["end"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    };
    assert_eq!(
        busy_of(fx.bob),
        vec![
            (
                "2026-10-20T08:00:00Z".to_owned(),
                "2026-10-20T09:30:00Z".to_owned()
            ),
            (
                "2026-10-20T12:00:00Z".to_owned(),
                "2026-10-20T13:00:00Z".to_owned()
            ),
        ]
    );
    assert_eq!(
        busy_of(fx.alice),
        vec![
            (
                "2026-10-20T12:00:00Z".to_owned(),
                "2026-10-20T13:00:00Z".to_owned()
            ),
            (
                "2026-10-20T14:00:00Z".to_owned(),
                "2026-10-20T15:00:00Z".to_owned()
            ),
        ]
    );

    // Someone sharing no space with the caller is not anyone's business.
    assert_eq!(freebusy(&app, &alice, json!([dave])).await.status(), 403);
}
