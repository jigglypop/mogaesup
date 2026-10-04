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

async fn open(url: String) -> Stream {
    let mut request = url.into_client_request().unwrap();
    request.headers_mut().insert(header::ORIGIN, ORIGIN.parse().unwrap());
    connect_async(request).await.unwrap().0
}

async fn send(stream: &mut Stream, message: Value) {
    stream.send(Message::text(message.to_string())).await.unwrap();
}

/// The next JSON message of `kind` that `wanted` accepts within `wait`, skipping others.
async fn next_where(stream: &mut Stream, kind: &str, wait: Duration, wanted: impl Fn(&Value) -> bool) -> Option<Value> {
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

/// The next session view `wanted` accepts within `wait`.
async fn session_where(stream: &mut Stream, wait: Duration, wanted: impl Fn(&Value) -> bool) -> Value {
    next_where(stream, "Session", wait, |frame| wanted(&frame["session"])).await.expect("a session view")["session"]
        .clone()
}

/// The next refusal's code.
async fn refused(stream: &mut Stream) -> String {
    let error = next_where(stream, "Error", Duration::from_secs(2), |_| true).await.expect("a refusal");
    error["code"].as_str().unwrap().to_owned()
}

/// A member in `island`'s live room, standing at `position`: their room socket and the `client_id` it was given.
async fn enter(app: &TestApp, base: &str, island: &str, cookie: &str, position: [f64; 3]) -> (Stream, String) {
    let mut room = open(format!("{base}/api/rooms/{island}?ticket={}", ticket(app, cookie).await)).await;
    send(&mut room, json!({"type": "Join", "room_id": island, "color": "#ff7a59"})).await;
    let welcome = next_where(&mut room, "Welcome", Duration::from_secs(2), |_| true).await.unwrap();
    let peer = welcome["client_id"].as_str().unwrap().to_owned();
    send(&mut room, json!({"type": "Update", "state": {"position": position}})).await;
    (room, peer)
}

async fn game(app: &TestApp, base: &str, island: &str, cookie: &str, peer: &str) -> Stream {
    open(format!("{base}/api/games/{island}?ticket={}&peer={peer}", ticket(app, cookie).await)).await
}

const SHORT: Duration = Duration::from_secs(2);
/// Longer than a kickoff's three seconds.
const KICKOFF: Duration = Duration::from_secs(6);

#[tokio::test]
async fn 두_사람이_축구를_열고_공을_차_골을_넣는다() {
    let app = TestApp::new(None).await;
    let host = app.register("ball_a", "에이").await;
    let guest = app.register("ball_b", "비").await;
    let (a, b) = (app.user_id("ball_a").await, app.user_id("ball_b").await);
    let base = serve(&app).await;

    // A watches from beside the field; B starts beside it too.
    let (_room_a, peer_a) = enter(&app, &base, "ball_a", &host, [0.0, 0.0, 20.0]).await;
    let (mut room_b, peer_b) = enter(&app, &base, "ball_a", &guest, [5.0, 0.0, 20.0]).await;
    let mut game_a = game(&app, &base, "ball_a", &host, &peer_a).await;
    let mut game_b = game(&app, &base, "ball_a", &guest, &peer_b).await;
    session_where(&mut game_a, SHORT, Value::is_null).await;
    session_where(&mut game_b, SHORT, Value::is_null).await;

    send(&mut game_a, json!({"type": "Open", "kind": "soccer"})).await;
    session_where(&mut game_b, SHORT, |session| session["phase"] == "lobby").await;
    send(&mut game_b, json!({"type": "Join"})).await;
    session_where(&mut game_a, SHORT, |session| session["players"].as_array().is_some_and(|all| all.len() == 2)).await;

    // A field 20 × 12 m along x around the island's centre: A's goal on x = −10, B's on x = 10.
    let field = json!({"center": [0.0, 0.0, 0.0], "axis": "x", "halfLength": 10, "halfWidth": 6});
    send(&mut game_b, json!({"type": "Start", "layout": field})).await;
    assert_eq!(refused(&mut game_b).await, "not_host");
    send(&mut game_a, json!({"type": "Start", "layout": {"center": [0, 0, 0], "axis": "y"}})).await;
    assert_eq!(refused(&mut game_a).await, "bad_layout");
    send(&mut game_a, json!({"type": "Start", "layout": field})).await;
    let kickoff = session_where(&mut game_b, SHORT, |session| session["phase"] == "playing").await["game"].clone();
    assert_eq!(kickoff["phase"], "kickoff");
    assert_eq!(kickoff["teams"], json!({"a": [a], "b": [b]}));
    assert_eq!(kickoff["team"], "b");
    assert_eq!(kickoff["score"], json!({"a": 0, "b": 0}));
    assert_eq!(kickoff["ball"]["position"], json!([0.0, 0.0, 0.0]));
    assert!(kickoff["kickoff"]["spot"][0].as_f64().unwrap() > 0.0, "B's own half: {}", kickoff["kickoff"]);
    let kicked_off = next_where(&mut game_a, "Event", SHORT, |event| event["event"]["type"] == "kickoff").await;
    assert_eq!(kicked_off.unwrap()["kind"], "soccer");

    // B walks up behind the ball, 1.2 m toward B's own goal, and may not kick before the kickoff is over.
    send(&mut room_b, json!({"type": "Update", "state": {"position": [1.2, 0.0, 0.0]}})).await;
    send(&mut game_b, json!({"type": "Act", "action": {"kick": true}})).await;
    assert_eq!(refused(&mut game_b).await, "kickoff");
    session_where(&mut game_b, KICKOFF, |session| session["game"]["phase"] == "play").await;

    // A, off the field, kicks at nothing; B's kick sends the ball toward A's goal at 12 m/s.
    send(&mut game_a, json!({"type": "Act", "action": {"kick": true}})).await;
    assert_eq!(refused(&mut game_a).await, "off_field");
    send(&mut game_b, json!({"type": "Act", "action": {"kick": true}})).await;
    let rolling = session_where(&mut game_a, SHORT, |session| {
        session["game"]["ball"]["velocity"][0].as_f64().is_some_and(|speed| speed < -1.0)
    })
    .await;
    assert_eq!(rolling["game"]["ball"]["velocity"], json!([-12.0, 0.0, 0.0]));
    let moved = session_where(&mut game_a, SHORT, |session| {
        session["game"]["ball"]["position"][0].as_f64().is_some_and(|x| x < -1.0)
    })
    .await;
    assert!(moved["game"]["ball"]["at"].as_u64() > rolling["game"]["ball"]["at"].as_u64());

    // It rolls into A's goal: B scores, and the ball waits on the centre spot for the next kickoff.
    let scored = session_where(&mut game_b, Duration::from_secs(4), |session| session["game"]["score"]["b"] == 1).await;
    assert_eq!(scored["game"]["score"], json!({"a": 0, "b": 1}));
    assert_eq!(scored["game"]["phase"], "kickoff");
    assert_eq!(scored["game"]["kickoff"]["n"], 2);
    assert_eq!(scored["game"]["ball"]["position"], json!([0.0, 0.0, 0.0]));
    let goal = next_where(&mut game_a, "Event", Duration::from_secs(4), |event| event["event"]["type"] == "goal").await;
    assert_eq!(goal.unwrap()["event"], json!({"type": "goal", "team": "b", "scorer": b}));

    send(&mut game_a, json!({"type": "Close"})).await;
    session_where(&mut game_b, SHORT, Value::is_null).await;
    app.cleanup().await;
}
