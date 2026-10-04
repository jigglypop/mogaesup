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

/// Long enough for the eight-second 준비 and a slow runner.
const WAIT: Duration = Duration::from_secs(20);

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

/// The next JSON message of `kind` that `wanted` accepts, skipping others; panics when none comes in time.
async fn next_where(stream: &mut Stream, kind: &str, wanted: impl Fn(&Value) -> bool) -> Value {
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, stream.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["type"] == kind && wanted(&value) {
                    return value;
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("no {kind} came: {other:?}"),
        }
    }
}

/// The next session view `wanted` accepts.
async fn session_where(stream: &mut Stream, wanted: impl Fn(&Value) -> bool) -> Value {
    next_where(stream, "Session", |frame| wanted(&frame["session"])).await["session"].clone()
}

/// The next event of this game whose `type` is `kind`.
async fn event(stream: &mut Stream, kind: &str) -> Value {
    next_where(stream, "Event", |frame| frame["kind"] == "redlight" && frame["event"]["type"] == kind).await["event"]
        .clone()
}

/// A member in `island`'s live room, standing at `position`: their room socket and the `client_id` it was given.
async fn enter(app: &TestApp, base: &str, island: &str, cookie: &str, position: [f64; 3]) -> (Stream, String) {
    let mut room = open(format!("{base}/api/rooms/{island}?ticket={}", ticket(app, cookie).await)).await;
    send(&mut room, json!({"type": "Join", "room_id": island, "color": "#ff7a59"})).await;
    let peer = next_where(&mut room, "Welcome", |_| true).await["client_id"].as_str().unwrap().to_owned();
    walk(&mut room, position).await;
    (room, peer)
}

async fn walk(room: &mut Stream, position: [f64; 3]) {
    send(room, json!({"type": "Update", "state": {"position": position}})).await;
}

async fn game(app: &TestApp, base: &str, island: &str, cookie: &str, peer: &str) -> Stream {
    open(format!("{base}/api/games/{island}?ticket={}&peer={peer}", ticket(app, cookie).await)).await
}

#[tokio::test]
async fn 두_사람이_무궁화_꽃이_피었습니다를_하면_서버가_출발선과_도착선을_판정한다() {
    let app = TestApp::new(None).await;
    let host = app.register("redlight_a", "에이").await;
    let guest = app.register("redlight_b", "비").await;
    let (a, b) = (app.user_id("redlight_a").await, app.user_id("redlight_b").await);
    let base = serve(&app).await;
    let (mut room_a, peer_a) = enter(&app, &base, "redlight_a", &host, [0.0, 0.0, 0.0]).await;
    let (mut room_b, peer_b) = enter(&app, &base, "redlight_a", &guest, [3.0, 0.0, 2.0]).await;
    let mut game_a = game(&app, &base, "redlight_a", &host, &peer_a).await;
    let mut game_b = game(&app, &base, "redlight_a", &guest, &peer_b).await;

    send(&mut game_a, json!({"type": "Open", "kind": "redlight"})).await;
    session_where(&mut game_b, |session| session["phase"] == "lobby").await;
    send(&mut game_b, json!({"type": "Join"})).await;
    session_where(&mut game_a, |session| session["players"].as_array().is_some_and(|players| players.len() == 2)).await;

    // The host's track is checked: ten meters is too short.
    send(&mut game_a, json!({"type": "Start", "layout": {"start": [0, 0, 0], "finish": [10, 0, 0]}})).await;
    assert_eq!(next_where(&mut game_a, "Error", |_| true).await["code"], "bad_track");

    // Twenty meters east. Each player's view has their own place on the start line, across the track.
    send(&mut game_a, json!({"type": "Start", "layout": {"start": [0, 0, 0], "finish": [20, 0, 0]}})).await;
    let seen_b = session_where(&mut game_b, |session| session["phase"] == "playing").await;
    let view = &seen_b["game"];
    assert_eq!(view["phase"], "ready");
    assert_eq!(view["slot"], json!([0.0, 0.0, 0.5]));
    assert_eq!(view["state"], "running");
    assert_eq!(view["track"], json!({"start": [0.0, 0.0, 0.0], "finish": [20.0, 0.0, 0.0]}));
    assert_eq!(view["counts"], json!({"running": 2, "finished": 0, "out": 0}));
    let begins = view["phaseEndsAt"].as_u64().unwrap();
    assert_eq!(view["endsAt"].as_u64(), Some(begins + 90_000));
    assert!(begins > seen_b["now"].as_u64().unwrap() + 7_000, "about eight seconds to line up");
    let seen_a = session_where(&mut game_a, |session| session["phase"] == "playing").await;
    assert_eq!(seen_a["game"]["slot"], json!([0.0, 0.0, -0.5]));

    // A goes to their place; B stands five meters past the line as the race begins.
    walk(&mut room_a, [0.0, 0.0, -0.5]).await;
    walk(&mut room_b, [5.0, 0.0, 0.5]).await;
    let light = event(&mut game_a, "light").await;
    assert_eq!(light["phase"], "green");
    assert_eq!(event(&mut game_a, "out").await, json!({"type": "out", "player": b, "reason": "early"}));
    let green = session_where(&mut game_b, |session| session["game"]["state"] == "out").await;
    assert_eq!(green["game"]["slot"], Value::Null, "nobody is sent to the line once the race is on");
    assert_eq!(green["game"]["phase"], "green");

    // The first green light lasts two seconds at least: A runs to the finish and the race is over (the session says
    // so first, then the event).
    walk(&mut room_a, [19.5, 0.0, -0.5]).await;
    let ended = session_where(&mut game_b, |session| session["phase"] == "ended").await;
    let finished = event(&mut game_b, "finished").await;
    assert_eq!((finished["player"].clone(), finished["rank"].clone()), (json!(a), json!(1)));
    let result = &ended["result"];
    assert_eq!(result["finished"][0]["id"], json!(a));
    assert_eq!(result["finished"][0]["time"], finished["time"]);
    assert_eq!(result["out"], json!([{"id": b, "name": "비"}]));
    assert_eq!(result["unfinished"], json!([]));
    app.cleanup().await;
}
