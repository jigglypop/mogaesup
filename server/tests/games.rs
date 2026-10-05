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

async fn open(url: String) -> Result<Stream, u16> {
    let mut request = url.into_client_request().unwrap();
    request.headers_mut().insert(header::ORIGIN, ORIGIN.parse().unwrap());
    connect_async(request).await.map(|(stream, _)| stream).map_err(|error| match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => response.status().as_u16(),
        _ => 0,
    })
}

async fn send(stream: &mut Stream, message: Value) {
    stream.send(Message::text(message.to_string())).await.unwrap();
}

/// The next JSON message of `kind` that `wanted` accepts, skipping others; None when none comes within two seconds.
async fn next_where(stream: &mut Stream, kind: &str, wanted: impl Fn(&Value) -> bool) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
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

async fn next(stream: &mut Stream, kind: &str) -> Option<Value> {
    next_where(stream, kind, |_| true).await
}

/// The next session view `wanted` accepts.
async fn session_where(stream: &mut Stream, wanted: impl Fn(&Value) -> bool) -> Value {
    next_where(stream, "Session", |frame| wanted(&frame["session"])).await.expect("a session view")["session"].clone()
}

fn players(session: &Value) -> usize {
    session["players"].as_array().map_or(0, Vec::len)
}

/// A member in `island`'s live room, standing at `position`: their room socket and the `client_id` it was given.
async fn enter(app: &TestApp, base: &str, island: &str, cookie: &str, position: [f64; 3]) -> (Stream, String) {
    let mut room = open(format!("{base}/api/rooms/{island}?ticket={}", ticket(app, cookie).await)).await.unwrap();
    send(&mut room, json!({"type": "Join", "room_id": island, "color": "#ff7a59"})).await;
    let peer = next(&mut room, "Welcome").await.unwrap()["client_id"].as_str().unwrap().to_owned();
    send(&mut room, json!({"type": "Update", "state": {"position": position}})).await;
    (room, peer)
}

async fn game(app: &TestApp, base: &str, island: &str, cookie: &str, peer: &str) -> Result<Stream, u16> {
    open(format!("{base}/api/games/{island}?ticket={}&peer={peer}", ticket(app, cookie).await)).await
}

#[tokio::test]
async fn 섬에_함께_있는_두_사람이_봇과_임포스터를_열고_시작하고_닫는다() {
    let app = TestApp::new(None).await;
    let host = app.register("hunt_a", "에이").await;
    let guest = app.register("hunt_b", "비").await;
    let outsider = app.register("hunt_c", "씨").await;
    let (a, b) = (app.user_id("hunt_a").await, app.user_id("hunt_b").await);
    let base = serve(&app).await;

    let (_room_a, peer_a) = enter(&app, &base, "hunt_a", &host, [0.0, 0.0, 0.0]).await;
    let (_room_b, peer_b) = enter(&app, &base, "hunt_a", &guest, [10.0, 0.0, 10.0]).await;

    // Only someone in the island's live room gets a game socket, and only with a peer of their own.
    assert_eq!(game(&app, &base, "hunt_a", &outsider, &peer_a).await.err(), Some(409));
    assert_eq!(game(&app, &base, "hunt_a", &guest, &peer_a).await.err(), Some(409));
    let mut game_a = game(&app, &base, "hunt_a", &host, &peer_a).await.unwrap();
    let mut game_b = game(&app, &base, "hunt_a", &guest, &peer_b).await.unwrap();
    assert_eq!(next(&mut game_a, "Session").await.unwrap()["session"], Value::Null);
    assert_eq!(next(&mut game_b, "Session").await.unwrap()["session"], Value::Null);

    send(&mut game_a, json!({"type": "Open", "kind": "impostor"})).await;
    let lobby = session_where(&mut game_b, |session| session["phase"] == "lobby").await;
    assert_eq!(lobby["host"], json!(a));
    assert_eq!(lobby["you"], json!(b));
    assert_eq!(lobby["players"], json!([{"id": a, "name": "에이", "peer": peer_a}]));
    send(&mut game_b, json!({"type": "Join"})).await;
    let joined = session_where(&mut game_a, |session| players(session) == 2).await;
    assert_eq!(joined["players"][1], json!({"id": b, "name": "비", "peer": peer_b}));

    // Only the host starts, and two people need bots to make a table.
    let stations: Vec<[f64; 3]> = (0..6).map(|index| [f64::from(index) * 8.0 - 20.0, 0.0, -30.0]).collect();
    let layout = |bots: u64| json!({"table": [0.0, 0.0, 0.0], "stations": stations, "bots": bots});
    send(&mut game_b, json!({"type": "Start", "layout": layout(2)})).await;
    let refused = next(&mut game_b, "Error").await.unwrap();
    assert_eq!(
        (refused["code"].as_str(), refused["message"].as_str()),
        (Some("not_host"), Some("방장만 할 수 있어요."))
    );
    send(&mut game_a, json!({"type": "Start", "layout": layout(1)})).await;
    assert_eq!(next(&mut game_a, "Error").await.unwrap()["code"], "few_players");
    send(&mut game_a, json!({"type": "Start", "layout": layout(2)})).await;
    let playing = session_where(&mut game_b, |session| session["phase"] == "playing").await;
    let shown = playing["game"]["players"].as_array().unwrap();
    assert_eq!(shown.len(), 4);
    assert_eq!(shown.iter().filter(|player| player["bot"] == true).count(), 2);
    assert_eq!(playing["game"]["bots"].as_array().unwrap().len(), 2);
    assert!(["crew", "impostor"].contains(&playing["game"]["role"].as_str().unwrap()));

    // A refused action reaches only its sender; a ping is answered.
    send(&mut game_b, json!({"type": "Act", "action": {"dig": true}})).await;
    assert_eq!(next(&mut game_b, "Error").await.unwrap()["code"], "bad_action");
    send(&mut game_b, json!({"type": "Ping", "ts": 33})).await;
    assert_eq!(next(&mut game_b, "Pong").await.unwrap()["ts"], 33);

    // The host closes the session for everyone.
    send(&mut game_a, json!({"type": "Close"})).await;
    assert_eq!(session_where(&mut game_b, Value::is_null).await, Value::Null);
    assert_eq!(session_where(&mut game_a, Value::is_null).await, Value::Null);
    app.cleanup().await;
}

#[tokio::test]
async fn 게임_소켓은_출처와_티켓과_로그아웃을_지키고_범람과_깨진_메시지를_끊는다() {
    let app = TestApp::new(None).await;
    let host = app.register("gate_a", "에이").await;
    let base = serve(&app).await;
    let (_room, peer) = enter(&app, &base, "gate_a", &host, [0.0, 0.0, 0.0]).await;

    let used = ticket(&app, &host).await;
    let mut foreign = format!("{base}/api/games/gate_a?ticket={used}&peer={peer}").into_client_request().unwrap();
    foreign.headers_mut().insert(header::ORIGIN, "https://evil.example".parse().unwrap());
    assert!(connect_async(foreign).await.is_err());
    assert!(open(format!("{base}/api/games/gate_a?ticket={used}&peer={peer}")).await.is_ok());
    assert_eq!(open(format!("{base}/api/games/gate_a?ticket={used}&peer={peer}")).await.err(), Some(401));
    assert_eq!(open(format!("{base}/api/games/gate_a?ticket=nope")).await.err(), Some(401));

    let mut noisy = game(&app, &base, "gate_a", &host, &peer).await.unwrap();
    for _ in 0..12 {
        noisy.send(Message::text(r#"{"type":"Nope"}"#)).await.unwrap();
    }
    assert_eq!(closed(&mut noisy).await, Some(4400));
    // A burst is taken (a stalled link catching up); a flood is not.
    let mut flood = game(&app, &base, "gate_a", &host, &peer).await.unwrap();
    for _ in 0..60 {
        send(&mut flood, json!({"type": "Ping", "ts": 1})).await;
    }
    send(&mut flood, json!({"type": "Ping", "ts": 2})).await;
    assert!(next_where(&mut flood, "Pong", |pong| pong["ts"] == 2).await.is_some());
    for _ in 0..150 {
        send(&mut flood, json!({"type": "Ping", "ts": 1})).await;
    }
    assert_eq!(closed(&mut flood).await, Some(4429));

    let mut socket = game(&app, &base, "gate_a", &host, &peer).await.unwrap();
    next(&mut socket, "Session").await.unwrap();
    app.call("POST", "/api/auth/logout", None, Some(&host)).await;
    assert_eq!(closed(&mut socket).await, Some(4401));
    app.cleanup().await;
}

#[tokio::test]
async fn 섬이_닫히면_게임_소켓도_닫히고_방을_떠난_사람은_게임에서_빠진다() {
    let app = TestApp::new(None).await;
    let host = app.register("away_a", "에이").await;
    let guest = app.register("away_b", "비").await;
    let base = serve(&app).await;
    let (_room_a, peer_a) = enter(&app, &base, "away_a", &host, [0.0, 0.0, 0.0]).await;
    let (room_b, peer_b) = enter(&app, &base, "away_a", &guest, [3.0, 0.0, 3.0]).await;
    let mut game_a = game(&app, &base, "away_a", &host, &peer_a).await.unwrap();
    let mut game_b = game(&app, &base, "away_a", &guest, &peer_b).await.unwrap();
    send(&mut game_a, json!({"type": "Open", "kind": "impostor"})).await;
    session_where(&mut game_b, |session| session["phase"] == "lobby").await;
    send(&mut game_b, json!({"type": "Join"})).await;
    session_where(&mut game_a, |session| players(session) == 2).await;

    // B leaves the room: B's avatar is gone at once, and B the player a little later.
    drop(room_b);
    let away = session_where(&mut game_a, |session| session["players"][1]["peer"].is_null()).await;
    assert_eq!(players(&away), 2);

    // Closing the island to its 일촌 closes the guest's game socket too.
    let narrowed = app.call("PATCH", "/api/homes/me", Some(json!({"visibility": "ilchon"})), Some(&host)).await;
    assert_eq!(narrowed.status, axum::http::StatusCode::OK);
    assert_eq!(closed(&mut game_b).await, Some(4403));
    send(&mut game_a, json!({"type": "Ping", "ts": 2})).await;
    assert_eq!(next(&mut game_a, "Pong").await.unwrap()["ts"], 2, "the owner stays");
    app.cleanup().await;
}

/// The code of the close frame the server sends next; None when the stream ends without one or nothing comes in time.
async fn closed(stream: &mut Stream) -> Option<u16> {
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(message) = stream.next().await {
            if let Ok(Message::Close(frame)) = message {
                return frame.map(|frame| u16::from(frame.code));
            }
        }
        None
    })
    .await
    .unwrap_or(None)
}

#[tokio::test]
async fn 한_로그인의_방_소켓과_게임_소켓은_접근_확인_하나를_함께_쓴다() {
    let app = TestApp::new(None).await;
    let host = app.register("watch_a", "에이").await;
    let guest = app.register("watch_b", "비").await;
    let base = serve(&app).await;
    let (room_a, peer_a) = enter(&app, &base, "watch_a", &host, [0.0, 0.0, 0.0]).await;
    let mut game_a = game(&app, &base, "watch_a", &host, &peer_a).await.unwrap();
    next(&mut game_a, "Session").await.unwrap();
    assert_eq!(app.state.rooms.access_checks(), 1, "the room's and the game's socket share one");
    let (room_b, _) = enter(&app, &base, "watch_a", &guest, [1.0, 0.0, 1.0]).await;
    let (room_c, _) = enter(&app, &base, "watch_b", &host, [1.0, 0.0, 1.0]).await;
    assert_eq!(app.state.rooms.access_checks(), 3, "another login, another island");
    drop((room_a, game_a, room_b, room_c));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while app.state.rooms.access_checks() > 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(app.state.rooms.access_checks(), 0, "the last socket stops its check");
    app.cleanup().await;
}

#[tokio::test]
async fn 섬_주인은_다른_사람이_연_게임도_닫는다() {
    let app = TestApp::new(None).await;
    let owner = app.register("own_a", "주인").await;
    let guest = app.register("own_b", "손님").await;
    let base = serve(&app).await;
    let (_room_a, peer_a) = enter(&app, &base, "own_a", &owner, [0.0, 0.0, 0.0]).await;
    let (_room_b, peer_b) = enter(&app, &base, "own_a", &guest, [2.0, 0.0, 2.0]).await;
    let mut game_a = game(&app, &base, "own_a", &owner, &peer_a).await.unwrap();
    let mut game_b = game(&app, &base, "own_a", &guest, &peer_b).await.unwrap();
    send(&mut game_b, json!({"type": "Open", "kind": "impostor"})).await;
    session_where(&mut game_a, |session| session["phase"] == "lobby").await;
    send(&mut game_a, json!({"type": "Close"})).await;
    assert_eq!(session_where(&mut game_b, Value::is_null).await, Value::Null);
    app.cleanup().await;
}
