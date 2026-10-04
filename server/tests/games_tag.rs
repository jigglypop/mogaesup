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
use uuid::Uuid;

type Stream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Long enough for the six-second head start and a slow runner.
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

/// Someone on the island: their account, where they stand, their room socket and their game socket.
struct Member {
    id: Uuid,
    at: [f64; 3],
    room: Stream,
    game: Stream,
}

#[tokio::test]
async fn 세_사람이_술래잡기를_하면_서버가_출발_뒤에_술래에게_닿은_사람을_술래로_만든다() {
    let app = TestApp::new(None).await;
    let base = serve(&app).await;
    let mut members = Vec::new();
    for (username, name, at) in
        [("tag_a", "에이", [0.0, 0.0, 0.0]), ("tag_b", "비", [12.0, 0.0, 0.0]), ("tag_c", "씨", [-12.0, 0.0, 0.0])]
    {
        let cookie = app.register(username, name).await;
        let (room, peer) = enter(&app, &base, "tag_a", &cookie, at).await;
        let game = game(&app, &base, "tag_a", &cookie, &peer).await;
        members.push(Member { id: app.user_id(username).await, at, room, game });
    }

    send(&mut members[0].game, json!({"type": "Open", "kind": "tag"})).await;
    for member in &mut members[1..] {
        session_where(&mut member.game, |session| session["phase"] == "lobby").await;
        send(&mut member.game, json!({"type": "Join"})).await;
    }
    let host = &mut members[0].game;
    session_where(host, |session| session["players"].as_array().is_some_and(|players| players.len() == 3)).await;

    // Too few spots to spread over is refused; twelve on a 4 m grid will do.
    send(host, json!({"type": "Start", "layout": {"spots": [[0, 0, 0], [4, 0, 0]]}})).await;
    assert_eq!(next_where(host, "Error", |_| true).await["code"], "bad_layout");
    let spots: Vec<[f64; 3]> =
        (0..12).map(|index| [f64::from(index % 4) * 4.0 - 6.0, 0.0, f64::from(index / 4) * 4.0 - 4.0]).collect();
    send(host, json!({"type": "Start", "layout": {"spots": spots}})).await;

    // One of three is it. Everyone sees who; each has their own role and start spot.
    let mut views = Vec::new();
    for member in &mut members {
        let session = session_where(&mut member.game, |session| session["phase"] == "playing").await;
        views.push(session["game"].clone());
    }
    let its = views[0]["its"].as_array().unwrap().clone();
    assert_eq!(its.len(), 1);
    assert_eq!(views[0]["runners"].as_array().unwrap().len(), 2);
    assert_eq!(views[0]["counts"], json!({"its": 1, "runners": 2}));
    for (member, view) in members.iter().zip(&views) {
        assert_eq!(view["its"], json!(its));
        let role = if its.contains(&json!(member.id)) { "it" } else { "runner" };
        assert_eq!(view["role"], role);
        let spot: [f64; 3] = serde_json::from_value(view["spot"].clone()).unwrap();
        assert!(spots.contains(&spot), "{spot:?}");
        assert_eq!(view["endsAt"].as_u64(), view["safeUntil"].as_u64().map(|safe| safe + 144_000));
    }

    // Both runners come right up to the it at once; nobody is caught before the head start is over.
    let it = members.iter().position(|member| its.contains(&json!(member.id))).unwrap();
    let target = members[it].at;
    for (index, member) in members.iter_mut().enumerate().filter(|(index, _)| *index != it) {
        let aside = if index < it { -0.5 } else { 0.5 };
        walk(&mut member.room, [target[0] + aside, 0.0, target[2] + 0.4]).await;
    }
    // With nobody left to catch, the its have won: the session says so, then the events tell who caught whom.
    let it_id = members[it].id;
    let watcher = &mut members[it].game;
    let ended = session_where(watcher, |session| session["phase"] == "ended").await;
    for _ in 0..2 {
        let caught = next_where(watcher, "Event", |frame| frame["kind"] == "tag").await["event"].clone();
        assert_eq!((caught["type"].as_str(), caught["by"].clone()), (Some("caught"), json!(it_id)));
    }
    let result = &ended["result"];
    assert_eq!(result["winner"], "its");
    assert_eq!(result["runners"], json!([]));
    assert_eq!(result["its"][0]["id"], json!(it_id));
    let caught = result["caught"].as_array().unwrap();
    assert_eq!(caught.len(), 2);
    for entry in caught {
        assert_eq!(entry["by"], json!(it_id));
        assert!(entry["time"].as_u64().unwrap() >= 6_000, "caught only after the head start: {entry}");
    }
    assert_eq!(ended["game"]["counts"], json!({"its": 3, "runners": 0}));
    app.cleanup().await;
}
