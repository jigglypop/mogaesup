//! OX 퀴즈 over real sockets: players stand in the island's live room, the game reads where they stand from it, and a
//! round runs on the server's own clock (12 s to walk, 4 s of answer).

mod common;

use common::{ORIGIN, TestApp};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::header},
};

type Stream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// How long a statement is asked, and how long its answer shows, on the server's clock.
const ASKING: Duration = Duration::from_secs(12);
const SHOWING: Duration = Duration::from_secs(4);
/// Room on top of those for a slow runner.
const SLACK: Duration = Duration::from_secs(4);
/// How long a message that follows at once may take.
const SOON: Duration = Duration::from_secs(2);
/// The zones every test lays out: O to the west, X to the east, 16 m apart.
const LAYOUT: &str = r#"{"o": [-8, 0, 0], "x": [8, 0, 0]}"#;

async fn serve(app: &TestApp) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = app.router.clone();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("ws://{address}")
}

async fn ticket(app: &TestApp, cookie: &str) -> String {
    app.call("POST", "/api/auth/realtime-ticket", None, Some(cookie)).await.body["ticket"].as_str().unwrap().to_owned()
}

async fn open(url: String) -> Stream {
    let mut request = url.into_client_request().unwrap();
    request.headers_mut().insert(header::ORIGIN, ORIGIN.parse().unwrap());
    connect_async(request).await.unwrap().0
}

async fn send(stream: &mut Stream, message: Value) {
    stream.send(Message::text(message.to_string())).await.unwrap();
}

/// The next JSON message of `kind` that `wanted` accepts within `wait`, skipping others; None when none comes.
async fn next_within(
    stream: &mut Stream,
    wait: Duration,
    kind: &str,
    wanted: impl Fn(&Value) -> bool,
) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, stream.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["type"] == kind && wanted(&value) {
                    return Some(value);
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => return None,
        }
    }
}

/// The game's next event of `kind` (`round`, `answer`).
async fn event(stream: &mut Stream, kind: &str) -> Value {
    next_within(stream, SOON, "Event", |frame| frame["kind"] == "ox" && frame["event"]["type"] == kind)
        .await
        .unwrap_or_else(|| panic!("an {kind} event"))["event"]
        .clone()
}

async fn refusal(stream: &mut Stream) -> String {
    next_within(stream, SOON, "Error", |_| true).await.expect("a refusal")["code"].as_str().unwrap().to_owned()
}

/// The next session view `wanted` accepts within `wait`.
async fn session_within(stream: &mut Stream, wait: Duration, wanted: impl Fn(&Value) -> bool) -> Value {
    next_within(stream, wait, "Session", |frame| wanted(&frame["session"])).await.expect("a session view")["session"]
        .clone()
}

async fn session_where(stream: &mut Stream, wanted: impl Fn(&Value) -> bool) -> Value {
    session_within(stream, SOON, wanted).await
}

fn players(session: &Value) -> usize {
    session["players"].as_array().map_or(0, Vec::len)
}

/// A member in `island`'s live room, standing at `position`: their room socket and the `client_id` it was given.
async fn enter(app: &TestApp, base: &str, island: &str, cookie: &str, position: [f64; 3]) -> (Stream, String) {
    let mut room = open(format!("{base}/api/rooms/{island}?ticket={}", ticket(app, cookie).await)).await;
    send(&mut room, json!({"type": "Join", "room_id": island, "color": "#ff7a59"})).await;
    let welcome = next_within(&mut room, SOON, "Welcome", |_| true).await.expect("a welcome");
    let peer = welcome["client_id"].as_str().unwrap().to_owned();
    walk(&mut room, position).await;
    (room, peer)
}

/// Moves a member in the live room, as their page would.
async fn walk(room: &mut Stream, position: [f64; 3]) {
    send(room, json!({"type": "Update", "state": {"position": position}})).await;
}

async fn game(app: &TestApp, base: &str, island: &str, cookie: &str, peer: &str) -> Stream {
    let mut socket = open(format!("{base}/api/games/{island}?ticket={}&peer={peer}", ticket(app, cookie).await)).await;
    assert_eq!(session_where(&mut socket, |_| true).await, Value::Null);
    socket
}

fn person(id: uuid::Uuid, name: &str) -> Value {
    json!({"id": id, "name": name})
}

#[tokio::test]
async fn 세_사람이_ox_퀴즈를_하면_맞는_구역에_선_사람만_남아_이긴다() {
    let app = TestApp::new(None).await;
    let host = app.register("quiz_a", "에이").await;
    let second = app.register("quiz_b", "비").await;
    let third = app.register("quiz_c", "씨").await;
    let (a, b, c) = (app.user_id("quiz_a").await, app.user_id("quiz_b").await, app.user_id("quiz_c").await);
    let base = serve(&app).await;
    let (mut room_a, peer_a) = enter(&app, &base, "quiz_a", &host, [0.0, 0.0, 0.0]).await;
    let (mut room_b, peer_b) = enter(&app, &base, "quiz_a", &second, [0.0, 0.0, 1.0]).await;
    let (_room_c, peer_c) = enter(&app, &base, "quiz_a", &third, [0.0, 0.0, -1.0]).await;
    let mut game_a = game(&app, &base, "quiz_a", &host, &peer_a).await;
    let mut game_b = game(&app, &base, "quiz_a", &second, &peer_b).await;
    let mut game_c = game(&app, &base, "quiz_a", &third, &peer_c).await;
    let layout: Value = serde_json::from_str(LAYOUT).unwrap();

    send(&mut game_a, json!({"type": "Open", "kind": "ox"})).await;
    session_where(&mut game_b, |session| session["phase"] == "lobby").await;
    // It takes two.
    send(&mut game_a, json!({"type": "Start", "layout": layout})).await;
    assert_eq!(refusal(&mut game_a).await, "too_few");
    send(&mut game_b, json!({"type": "Join"})).await;
    send(&mut game_c, json!({"type": "Join"})).await;
    session_where(&mut game_a, |session| players(session) == 3).await;
    // Zones that would nearly touch are refused, and the lobby stays.
    send(&mut game_a, json!({"type": "Start", "layout": {"o": [-4, 0, 0], "x": [4, 0, 0]}})).await;
    assert_eq!(refusal(&mut game_a).await, "bad_layout");

    send(&mut game_a, json!({"type": "Start", "layout": layout})).await;
    let playing = session_where(&mut game_b, |session| session["phase"] == "playing").await;
    let quiz = &playing["game"];
    assert_eq!((&quiz["round"], &quiz["rounds"], &quiz["phase"]), (&json!(1), &json!(10), &json!("question")));
    let statement = quiz["statement"].as_str().unwrap();
    assert!(!statement.is_empty());
    assert_eq!(quiz["answer"], Value::Null, "the answer stays hidden while it is asked");
    assert_eq!(quiz["zones"], json!({"o": [-8.0, 0.0, 0.0], "x": [8.0, 0.0, 0.0], "radius": 4.5}));
    assert_eq!(quiz["survivors"], json!([person(a, "에이"), person(b, "비"), person(c, "씨")]));
    assert_eq!(quiz["me"], json!({"state": "in", "zone": null}));
    let left = quiz["endsAt"].as_u64().unwrap() - playing["now"].as_u64().unwrap();
    assert!((11_000..=12_000).contains(&left), "{left} ms to walk");
    let round = event(&mut game_b, "round").await;
    assert_eq!((round["round"].clone(), round["statement"].as_str()), (json!(1), Some(statement)));

    // A walks into O and B into X; C stays between them. Each sees the zone they stand in.
    walk(&mut room_a, [-8.0, 0.0, 2.0]).await;
    walk(&mut room_b, [9.5, 0.0, -1.0]).await;
    session_where(&mut game_a, |session| session["game"]["me"]["zone"] == "o").await;
    session_where(&mut game_b, |session| session["game"]["me"]["zone"] == "x").await;

    // Time is up: C, in neither zone, and whichever of A and B stands on the wrong one go out.
    let shown = session_within(&mut game_c, ASKING + SLACK, |session| session["game"]["phase"] == "answer").await;
    let answer = shown["game"]["answer"].as_str().unwrap().to_owned();
    let (winner, loser) =
        if answer == "o" { (person(a, "에이"), person(b, "비")) } else { (person(b, "비"), person(a, "에이")) };
    assert_eq!(shown["game"]["fallen"], json!([loser, person(c, "씨")]));
    assert_eq!(shown["game"]["survivors"], json!([winner]));
    assert_eq!(shown["game"]["me"], json!({"state": "out", "zone": null}));
    assert_eq!(shown["phase"], "playing", "the answer shows before the game ends");
    let revealed = event(&mut game_c, "answer").await;
    assert_eq!(
        revealed,
        json!({"type": "answer", "round": 1, "answer": answer, "out": [loser["id"], c], "spared": false})
    );

    // One player is left in: the game ends once the answer has shown.
    let ended = session_within(&mut game_a, SHOWING + SLACK, |session| session["phase"] == "ended").await;
    assert!(ended["now"].as_u64().unwrap() >= shown["now"].as_u64().unwrap() + 4_000);
    let mut out_loser = loser.clone();
    out_loser["round"] = json!(1);
    assert_eq!(ended["result"], json!({"winners": [winner], "out": [out_loser, {"id": c, "name": "씨", "round": 1}]}));

    send(&mut game_a, json!({"type": "Close"})).await;
    assert_eq!(session_where(&mut game_c, Value::is_null).await, Value::Null);
    app.cleanup().await;
}

#[tokio::test]
async fn 둘이_하다_한_사람이_나가면_남은_사람이_바로_이기고_구경하는_사람에게는_자리가_없다() {
    let app = TestApp::new(None).await;
    let host = app.register("duel_a", "에이").await;
    let guest = app.register("duel_b", "비").await;
    let watcher = app.register("duel_w", "구경").await;
    let a = app.user_id("duel_a").await;
    let base = serve(&app).await;
    // A already stands on O's ground.
    let (_room_a, peer_a) = enter(&app, &base, "duel_a", &host, [-6.0, 0.0, 3.0]).await;
    let (_room_b, peer_b) = enter(&app, &base, "duel_a", &guest, [0.0, 0.0, 0.0]).await;
    let (_room_w, peer_w) = enter(&app, &base, "duel_a", &watcher, [0.0, 0.0, 6.0]).await;
    let mut game_a = game(&app, &base, "duel_a", &host, &peer_a).await;
    let mut game_b = game(&app, &base, "duel_a", &guest, &peer_b).await;
    let mut game_w = game(&app, &base, "duel_a", &watcher, &peer_w).await;

    send(&mut game_a, json!({"type": "Open", "kind": "ox"})).await;
    session_where(&mut game_b, |session| session["phase"] == "lobby").await;
    send(&mut game_b, json!({"type": "Join"})).await;
    session_where(&mut game_a, |session| players(session) == 2).await;
    let layout: Value = serde_json::from_str(LAYOUT).unwrap();
    send(&mut game_a, json!({"type": "Start", "layout": layout})).await;
    let watched = session_where(&mut game_w, |session| session["phase"] == "playing").await;
    assert_eq!(watched["game"]["me"], Value::Null, "someone watching has no zone or state");
    assert_eq!(watched["game"]["survivors"].as_array().map(Vec::len), Some(2));
    session_where(&mut game_a, |session| session["game"]["me"]["zone"] == "o").await;

    // Where you stand is the answer: there is nothing to send.
    send(&mut game_a, json!({"type": "Act", "action": {"answer": "o"}})).await;
    assert_eq!(refusal(&mut game_a).await, "bad_action");

    // B leaves while the statement is asked: A, the only one left in, has won.
    send(&mut game_b, json!({"type": "Leave"})).await;
    let ended = session_where(&mut game_w, |session| session["phase"] == "ended").await;
    assert_eq!(players(&ended), 1);
    assert_eq!(ended["result"], json!({"winners": [person(a, "에이")], "out": []}));
    app.cleanup().await;
}
