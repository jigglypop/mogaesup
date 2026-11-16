//! The decor of a 사주 home's island: the things its owner places on it, and the flags other members give the home.

mod common;

use axum::http::StatusCode;
use common::{Reply, TestApp};
use mogaesup_server::security::rate_record;
use serde_json::{Value, json};
use uuid::Uuid;

/// The props the app has models for, the stars a flag may show and its elements, as the server takes them.
const PROPS: [&str; 12] =
    ["lantern", "bench", "jar", "pot", "barrel", "woodpile", "table", "parasol", "well", "bush", "rock", "tree"];
const STARS: [&str; 15] = [
    "자미", "천기", "태양", "무곡", "천동", "염정", "천부", "태음", "탐랑", "거문", "천상", "천량", "칠살", "파군",
    "공궁",
];
const ELEMENTS: [&str; 5] = ["wood", "fire", "earth", "metal", "water"];
const SEOUL_TODAY: &str = "(now() AT TIME ZONE 'Asia/Seoul')::date";

/// Signs `username` up as `name`; their cookie and id. With `built`, they build their 사주 home too.
async fn member(app: &TestApp, username: &str, name: &str, built: bool) -> (String, Uuid) {
    let cookie = app.register(username, name).await;
    let id = app.user_id(username).await;
    if built {
        build(app, &cookie, id).await;
    }
    (cookie, id)
}

async fn build(app: &TestApp, cookie: &str, id: Uuid) {
    let birth = json!({"calendar": "solar", "year": 1990, "month": 5, "day": 5, "leapMonth": false, "time": null, "gender": "female"});
    let body = json!({"expectedOwnerId": id, "name": "솔", "birth": birth});
    let built = app.call("PUT", "/api/homes/me/saju", Some(body), Some(cookie)).await;
    assert_eq!(built.status, StatusCode::OK, "{:?}", built.body);
}

/// A thing placed a little off the island's middle, a little turned.
fn item(id: &str, kind: &str, reference: &str) -> Value {
    json!({"id": id, "kind": kind, "ref": reference, "x": 1.5, "z": -2.0, "turn": 0.5})
}

/// One lantern, changed by `change`.
fn lantern(change: impl FnOnce(&mut Value)) -> Value {
    let mut lantern = item("a", "prop", "lantern");
    change(&mut lantern);
    json!([lantern])
}

async fn decorate(app: &TestApp, cookie: &str, owner: Uuid, items: &Value) -> Reply {
    let body = json!({"expectedOwnerId": owner, "items": items});
    app.call("PUT", "/api/homes/me/saju/decor", Some(body), Some(cookie)).await
}

async fn decor(app: &TestApp, username: &str, cookie: Option<&str>) -> Reply {
    app.call("GET", &format!("/api/homes/{username}/saju/decor"), None, cookie).await
}

async fn give(app: &TestApp, cookie: &str, username: &str, star: &str, element: &str) -> Reply {
    let body = json!({"design": {"star": star, "element": element}});
    app.call("POST", &format!("/api/homes/{username}/saju/flags"), Some(body), Some(cookie)).await
}

async fn take_down(app: &TestApp, cookie: Option<&str>, id: &str) -> Reply {
    app.call("DELETE", &format!("/api/homes/me/saju/flags/{id}"), None, cookie).await
}

fn refusal(reply: &Reply) -> (StatusCode, &str) {
    (reply.status, reply.body["code"].as_str().unwrap_or_default())
}

fn id(flag: &Value) -> String {
    flag["id"].as_str().unwrap().to_owned()
}

/// The flags `giver` gave today, as if they were given `days` days before.
async fn given_before(app: &TestApp, giver: Uuid, days: i32) {
    sqlx::query(&format!(
        "UPDATE saju_flags SET given_on = given_on - $2 WHERE giver_id = $1 AND given_on = {SEOUL_TODAY}"
    ))
    .bind(giver)
    .bind(days)
    .execute(&app.state.db)
    .await
    .unwrap();
}

#[tokio::test]
async fn 꾸밈은_주인이_사주_집의_섬에_놓고_집을_볼_수_있는_사람이_본다() {
    let app = TestApp::new(None).await;
    let (host, host_id) = member(&app, "decor_host", "주인", false).await;
    let (visitor, visitor_id) = member(&app, "decor_visitor", "손님", false).await;
    let nothing = json!({"items": [], "flags": [], "character": null});
    for cookie in [Some(host.as_str()), Some(visitor.as_str()), None] {
        let shown = decor(&app, "decor_host", cookie).await;
        assert_eq!((shown.status, &shown.body), (StatusCode::OK, &nothing));
    }

    // Only the owner places things, from a page loaded for their account, once their 사주 home stands.
    let items =
        json!([item("lamp-1", "prop", "lantern"), item("my_flag", "flag", "mine"), item("Me", "character", "me")]);
    let path = "/api/homes/me/saju/decor";
    let body = json!({"expectedOwnerId": host_id, "items": items});
    assert_eq!(app.call("PUT", path, Some(body), None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(refusal(&decorate(&app, &host, visitor_id, &items).await), (StatusCode::CONFLICT, "owner_changed"));
    let unsigned = app.call("PUT", path, Some(json!({"items": items})), Some(&host)).await;
    assert_eq!(refusal(&unsigned), (StatusCode::CONFLICT, "owner_changed"));
    assert_eq!(refusal(&decorate(&app, &host, host_id, &items).await), (StatusCode::CONFLICT, "no_home"));
    build(&app, &host, host_id).await;
    let saved = decorate(&app, &host, host_id, &items).await;
    assert_eq!(saved.status, StatusCode::OK, "{:?}", saved.body);
    assert_eq!(saved.body, json!({"items": items, "flags": [], "character": null}));
    // The owner reads what the save answered; a member and anyone else read the same things placed.
    for cookie in [Some(host.as_str()), Some(visitor.as_str()), None] {
        assert_eq!(decor(&app, "decor_host", cookie).await.body, saved.body);
    }

    // The owner's character is there once their look is ready with a model; others see it only while it is placed.
    let model = format!("/models/{}.glb", "c".repeat(64));
    sqlx::query("INSERT INTO user_looks (user_id, request, status, model_url) VALUES ($1, '{}', 'ready', $2)")
        .bind(host_id)
        .bind(&model)
        .execute(&app.state.db)
        .await
        .unwrap();
    let character = json!({"modelUrl": model});
    for cookie in [Some(host.as_str()), Some(visitor.as_str()), None] {
        assert_eq!(decor(&app, "decor_host", cookie).await.body["character"], character);
    }
    let lamp = json!([item("lamp-1", "prop", "lantern")]);
    let saved = decorate(&app, &host, host_id, &lamp).await;
    assert_eq!(saved.body, json!({"items": lamp, "flags": [], "character": character}));
    for cookie in [Some(visitor.as_str()), None] {
        assert_eq!(
            decor(&app, "decor_host", cookie).await.body,
            json!({"items": lamp, "flags": [], "character": null})
        );
    }
    // A look being made again is no character until it is ready.
    sqlx::query("UPDATE user_looks SET status = 'baking' WHERE user_id = $1")
        .bind(host_id)
        .execute(&app.state.db)
        .await
        .unwrap();
    assert_eq!(decor(&app, "decor_host", Some(&host)).await.body["character"], Value::Null);

    // A home its owner keeps to themselves shows its decor to them alone.
    app.call("PATCH", "/api/homes/me", Some(json!({"visibility": "private"})), Some(&host)).await;
    assert_eq!(refusal(&decor(&app, "decor_host", None).await), (StatusCode::FORBIDDEN, "home_private"));
    assert_eq!(refusal(&decor(&app, "decor_host", Some(&visitor)).await), (StatusCode::FORBIDDEN, "home_private"));
    assert_eq!(decor(&app, "decor_host", Some(&host)).await.body["items"], lamp);
    assert_eq!(refusal(&decor(&app, "nobody_here", None).await), (StatusCode::NOT_FOUND, "home_not_found"));
    app.cleanup().await;
}

#[tokio::test]
async fn 꾸밈은_섬에_놓을_수_있는_것만_받는다() {
    let app = TestApp::new(None).await;
    let (host, host_id) = member(&app, "rule_host", "주인", true).await;
    let kept = lantern(|_| {});
    assert_eq!(decorate(&app, &host, host_id, &kept).await.status, StatusCode::OK);
    let rocks: Vec<Value> = (0..25).map(|at| item(&format!("rock-{at}"), "prop", "rock")).collect();
    let never_given = Uuid::new_v4().to_string();
    let refused = [
        ("25 things", json!(rocks)),
        ("an empty id", lantern(|item| item["id"] = json!(""))),
        ("an id of 41 letters", lantern(|item| item["id"] = json!("a".repeat(41)))),
        ("an id with a space", lantern(|item| item["id"] = json!("a b"))),
        ("an id with a dot", lantern(|item| item["id"] = json!("a.b"))),
        ("an id in Hangul", lantern(|item| item["id"] = json!("등불"))),
        ("an id that is a number", lantern(|item| item["id"] = json!(7))),
        ("two things of one id", json!([item("a", "prop", "lantern"), item("a", "prop", "bench")])),
        ("an unknown kind", lantern(|item| item["kind"] = json!("house"))),
        ("a kind in capitals", lantern(|item| item["kind"] = json!("Prop"))),
        ("a prop the app has no model for", lantern(|item| item["ref"] = json!("sofa"))),
        ("a flag that is nobody's", json!([item("f", "flag", "yours")])),
        ("a flag never given", json!([item("f", "flag", &never_given)])),
        ("a character not the owner's", json!([item("c", "character", "you")])),
        ("two characters", json!([item("c1", "character", "me"), item("c2", "character", "me")])),
        ("x past the edge", lantern(|item| item["x"] = json!(40.001))),
        ("z past the edge", lantern(|item| item["z"] = json!(-41))),
        ("turned too far", lantern(|item| item["turn"] = json!(7.5))),
        ("turned too far back", lantern(|item| item["turn"] = json!(-8))),
        ("x written as text", lantern(|item| item["x"] = json!("1"))),
        ("a turn of null", lantern(|item| item["turn"] = Value::Null)),
        (
            "no z",
            lantern(|item| {
                item.as_object_mut().unwrap().remove("z");
            }),
        ),
        (
            "no ref",
            lantern(|item| {
                item.as_object_mut().unwrap().remove("ref");
            }),
        ),
        ("items that are no list", json!({"a": item("a", "prop", "lantern")})),
    ];
    for (case, items) in refused {
        let reply = decorate(&app, &host, host_id, &items).await;
        assert_eq!(refusal(&reply), (StatusCode::BAD_REQUEST, "invalid_decor"), "{case}: {:?}", reply.body);
    }
    // None of them changed what stands on the island.
    assert_eq!(decor(&app, "rule_host", None).await.body["items"], kept);

    // At the edges: 24 things, every prop, an id of 40 letters, digits, `_` and `-`, the island's edge and the most a
    // thing turns. The numbers are kept as they were written.
    let mut edge: Vec<Value> =
        PROPS.iter().enumerate().map(|(at, prop)| item(&format!("prop-{at}"), "prop", prop)).collect();
    edge.extend((0..11).map(|at| item(&format!("flag_{at}"), "flag", "mine")));
    edge.push(item("me", "character", "me"));
    edge[0]["id"] = json!(format!("{}-_09", "Az".repeat(18)));
    edge[1]["x"] = json!(40);
    edge[1]["z"] = json!(-40.0);
    edge[1]["turn"] = json!(-7);
    edge[2]["turn"] = json!(7.0);
    edge[3]["x"] = json!(0.1 + 0.2);
    assert_eq!((edge.len(), edge[0]["id"].as_str().unwrap().len()), (24, 40));
    let saved = decorate(&app, &host, host_id, &json!(edge)).await;
    assert_eq!(saved.status, StatusCode::OK, "{:?}", saved.body);
    assert_eq!(saved.body["items"], json!(edge));
    assert_eq!(decor(&app, "rule_host", None).await.body["items"], json!(edge));
    // Fields this server does not know are not kept; no things at all is a bare island.
    let glowing = lantern(|item| item["glow"] = json!(true));
    assert_eq!(decorate(&app, &host, host_id, &glowing).await.body["items"], kept);
    assert_eq!(decorate(&app, &host, host_id, &json!([])).await.body["items"], json!([]));

    // Sixty saves a member in ten minutes.
    for _ in 0..60 {
        rate_record(&app.state, format!("saju-decor:{host_id}"));
    }
    assert_eq!(refusal(&decorate(&app, &host, host_id, &kept).await), (StatusCode::TOO_MANY_REQUESTS, "too_many"));
    app.cleanup().await;
}

#[tokio::test]
async fn 깃발은_사주_집을_지은_회원이_남의_집에_하루_하나씩_보낸다() {
    let app = TestApp::new(None).await;
    let (host, _) = member(&app, "flag_host", "주인", true).await;
    let (giver, giver_id) = member(&app, "flag_giver", "보내는이", true).await;
    let (loner, _) = member(&app, "flag_loner", "혼자", false).await;
    let (stranger, _) = member(&app, "flag_stranger", "낯선이", true).await;

    let given = give(&app, &giver, "flag_host", "자미", "fire").await;
    assert_eq!(given.status, StatusCode::CREATED, "{:?}", given.body);
    let flag = given.body;
    assert_eq!(flag["giver"], json!({"username": "flag_giver", "name": "보내는이"}));
    assert_eq!(flag["design"], json!({"star": "자미", "element": "fire"}));
    let flag_id = Uuid::parse_str(flag["id"].as_str().unwrap()).unwrap();
    assert!(chrono::DateTime::parse_from_rfc3339(flag["givenAt"].as_str().unwrap()).is_ok(), "{flag}");
    // Given on Seoul's calendar day, and read by the owner as it was answered.
    let seoul: bool = sqlx::query_scalar(&format!("SELECT given_on = {SEOUL_TODAY} FROM saju_flags WHERE id = $1"))
        .bind(flag_id)
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert!(seoul);
    assert_eq!(decor(&app, "flag_host", Some(&host)).await.body["flags"], json!([flag]));

    // One a day from each member to each home. The owner gives their own home none; a member gives one only with a 사주
    // home of their own, and only to a home built.
    let again = give(&app, &giver, "flag_host", "천기", "water").await;
    assert_eq!(refusal(&again), (StatusCode::CONFLICT, "already_given"));
    assert_eq!(refusal(&give(&app, &host, "flag_host", "자미", "fire").await), (StatusCode::BAD_REQUEST, "own_home"));
    assert_eq!(refusal(&give(&app, &loner, "flag_host", "자미", "fire").await), (StatusCode::CONFLICT, "no_home"));
    assert_eq!(refusal(&give(&app, &giver, "flag_loner", "자미", "fire").await), (StatusCode::CONFLICT, "no_home"));
    let path = "/api/homes/flag_host/saju/flags";
    let body = json!({"design": {"star": "자미", "element": "fire"}});
    assert_eq!(app.call("POST", path, Some(body), None).await.status, StatusCode::UNAUTHORIZED);
    // Only the 14 main stars and 공궁, in one of the five elements.
    for (star, element) in
        [("북두", "fire"), ("자미 ", "fire"), ("紫微", "fire"), ("자미", "air"), ("자미", "Fire"), ("", "")]
    {
        let reply = give(&app, &stranger, "flag_host", star, element).await;
        assert_eq!(refusal(&reply), (StatusCode::BAD_REQUEST, "invalid_flag"), "{star} {element}");
    }
    for body in [
        json!({}),
        json!({"design": "자미"}),
        json!({"star": "자미", "element": "fire"}),
        json!({"design": {"star": 1, "element": "fire"}}),
    ] {
        let reply = app.call("POST", path, Some(body.clone()), Some(&stranger)).await;
        assert_eq!(refusal(&reply), (StatusCode::BAD_REQUEST, "invalid_flag"), "{body}");
    }
    // A home its owner keeps to themselves takes no flag from those who may not see it.
    app.call("PATCH", "/api/homes/me", Some(json!({"visibility": "private"})), Some(&host)).await;
    let hidden = give(&app, &stranger, "flag_host", "자미", "fire").await;
    assert_eq!(refusal(&hidden), (StatusCode::FORBIDDEN, "home_private"));
    app.call("PATCH", "/api/homes/me", Some(json!({"visibility": "public"})), Some(&host)).await;

    // Each Seoul day after, the giver gives again: every star, in every element.
    for (at, star) in STARS.iter().enumerate() {
        given_before(&app, giver_id, at as i32 + 1).await;
        let element = ELEMENTS[at % ELEMENTS.len()];
        let given = give(&app, &giver, "flag_host", star, element).await;
        assert_eq!(given.status, StatusCode::CREATED, "{star}: {:?}", given.body);
        assert_eq!(given.body["design"], json!({"star": star, "element": element}));
    }
    assert_eq!(decor(&app, "flag_host", Some(&host)).await.body["flags"].as_array().unwrap().len(), 16);

    // Thirty flags a member in ten minutes.
    for _ in 0..30 {
        rate_record(&app.state, format!("saju-flag:{giver_id}"));
    }
    given_before(&app, giver_id, 100).await;
    let spent = give(&app, &giver, "flag_host", "자미", "fire").await;
    assert_eq!(refusal(&spent), (StatusCode::TOO_MANY_REQUESTS, "too_many"));
    app.cleanup().await;
}

#[tokio::test]
async fn 손님은_놓인_깃발만_보고_주인은_받은_깃발을_모두_보며_내린_깃발은_섬에서도_내려간다() {
    let app = TestApp::new(None).await;
    let (host, host_id) = member(&app, "keep_host", "주인", true).await;
    let (first, _) = member(&app, "keep_first", "첫째", true).await;
    let (second, second_id) = member(&app, "keep_second", "둘째", true).await;
    let early = give(&app, &first, "keep_host", "태양", "fire").await.body;
    let late = give(&app, &second, "keep_host", "태음", "water").await.body;
    let theirs = give(&app, &first, "keep_second", "칠살", "metal").await.body;

    // The owner reads every flag given to them, the newest first; nobody else reads one until it is placed.
    assert_eq!(decor(&app, "keep_host", Some(&host)).await.body["flags"], json!([late, early]));
    for cookie in [Some(first.as_str()), None] {
        assert_eq!(decor(&app, "keep_host", cookie).await.body["flags"], json!([]));
    }
    // A flag given to another home is none to place here, nor is a given one's id written another way.
    for reference in [id(&theirs), id(&early).to_uppercase(), id(&early).replace('-', "")] {
        let reply = decorate(&app, &host, host_id, &json!([item("f", "flag", &reference)])).await;
        assert_eq!(refusal(&reply), (StatusCode::BAD_REQUEST, "invalid_decor"), "{reference}");
    }
    // Placed, a flag is read by whoever sees the home.
    let lamp = item("lamp", "prop", "lantern");
    let mine = item("mine", "flag", "mine");
    let items = json!([item("early-1", "flag", &id(&early)), lamp, item("early-2", "flag", &id(&early)), mine]);
    let saved = decorate(&app, &host, host_id, &items).await;
    assert_eq!(saved.status, StatusCode::OK, "{:?}", saved.body);
    assert_eq!(saved.body, json!({"items": items, "flags": [late, early], "character": null}));
    for cookie in [Some(first.as_str()), Some(second.as_str()), None] {
        let shown = decor(&app, "keep_host", cookie).await.body;
        assert_eq!(shown, json!({"items": items, "flags": [early], "character": null}));
    }

    // Only the owner takes a flag down; it goes from every place it stood, and the rest stay as they were.
    assert_eq!(take_down(&app, None, &id(&early)).await.status, StatusCode::UNAUTHORIZED);
    let not_theirs = (StatusCode::NOT_FOUND, "flag_not_found");
    assert_eq!(refusal(&take_down(&app, Some(&first), &id(&early)).await), not_theirs);
    assert_eq!(refusal(&take_down(&app, Some(&host), &id(&theirs)).await), not_theirs);
    let unreadable = take_down(&app, Some(&host), "not-a-flag").await;
    assert_eq!(refusal(&unreadable), (StatusCode::BAD_REQUEST, "invalid_request"));
    assert_eq!(take_down(&app, Some(&host), &id(&early)).await.status, StatusCode::NO_CONTENT);
    let left = json!([lamp, mine]);
    let shown = decor(&app, "keep_host", Some(&host)).await.body;
    assert_eq!(shown, json!({"items": left, "flags": [late], "character": null}));
    assert_eq!(decor(&app, "keep_host", None).await.body["flags"], json!([]));
    assert_eq!(refusal(&take_down(&app, Some(&host), &id(&early)).await), not_theirs);
    // Another home's flags are its own; a flag never placed goes without touching the island.
    assert_eq!(decor(&app, "keep_second", Some(&second)).await.body["flags"], json!([theirs]));
    assert_eq!(take_down(&app, Some(&host), &id(&late)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(
        decor(&app, "keep_host", Some(&host)).await.body,
        json!({"items": left, "flags": [], "character": null})
    );

    // The owner's own list holds the newest hundred given, and the placed ones besides.
    sqlx::query(&format!(
        "INSERT INTO saju_flags (id, owner_id, giver_id, star, element, given_on, created_at)
         SELECT gen_random_uuid(), $1, $2, '천동', 'earth', {SEOUL_TODAY} - n, now() - make_interval(days => n)
         FROM generate_series(1, 105) AS n"
    ))
    .bind(host_id)
    .bind(second_id)
    .execute(&app.state.db)
    .await
    .unwrap();
    let oldest: Uuid = sqlx::query_scalar("SELECT id FROM saju_flags WHERE owner_id = $1 ORDER BY created_at LIMIT 1")
        .bind(host_id)
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    let given_at = |flag: &Value| chrono::DateTime::parse_from_rfc3339(flag["givenAt"].as_str().unwrap()).unwrap();
    let listed = decor(&app, "keep_host", Some(&host)).await.body["flags"].as_array().unwrap().clone();
    assert_eq!(listed.len(), 100);
    assert!(listed.windows(2).all(|pair| given_at(&pair[0]) > given_at(&pair[1])));
    assert!(listed.iter().all(|flag| flag["id"] != json!(oldest)));
    let saved = decorate(&app, &host, host_id, &json!([item("old", "flag", &oldest.to_string())])).await;
    let listed = saved.body["flags"].as_array().unwrap();
    assert_eq!((listed.len(), &listed[100]["id"]), (101, &json!(oldest)));
    let shown = decor(&app, "keep_host", None).await.body;
    assert_eq!(shown["flags"].as_array().unwrap().iter().map(id).collect::<Vec<_>>(), [oldest.to_string()]);
    app.cleanup().await;
}
