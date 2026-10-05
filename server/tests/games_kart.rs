//! 카트 over real sockets: one person in an island's live room races three bots, from the start through the countdown.

mod common;

use common::{ORIGIN, TestApp};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{net::TcpStream, time::Instant};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::header},
};

type Stream = WebSocketStream<MaybeTlsStream<TcpStream>>;

const ISLAND: &str = "kart_a";
const Y: f64 = 80.0;

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

/// The next JSON message of `kind` that `wanted` accepts, skipping others; None when none comes within `window`.
async fn next_where(
    stream: &mut Stream,
    kind: &str,
    window: Duration,
    wanted: impl Fn(&Value) -> bool,
) -> Option<Value> {
    let deadline = Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
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

/// The next session view `wanted` accepts, within `window`.
async fn session(stream: &mut Stream, window: Duration, wanted: impl Fn(&Value) -> bool) -> Value {
    let frame = next_where(stream, "Session", window, |frame| wanted(&frame["session"])).await;
    frame.expect("a session view")["session"].clone()
}

fn spot(x: f64, z: f64) -> [f64; 3] {
    [x, Y, z]
}

/// An 80 by 80 m loop 80 m up, the line in the middle of its first side; the grid behind it.
fn layout() -> Value {
    let gates: Vec<[f64; 3]> =
        [(0.0, 0.0), (40.0, 0.0), (40.0, 40.0), (40.0, 80.0), (0.0, 80.0), (-40.0, 80.0), (-40.0, 40.0), (-40.0, 0.0)]
            .map(|(x, z)| spot(x, z))
            .to_vec();
    let grid: Vec<[f64; 3]> =
        (0..8).map(|index| spot(-6.0 - 6.0 * (index / 2) as f64, if index % 2 == 0 { -2.5 } else { 2.5 })).collect();
    json!({"checkpoints": gates, "radius": 6.0, "grid": grid, "boxes": [spot(20.0, 0.0)], "laps": 2, "bots": 3})
}

#[tokio::test]
async fn 혼자_봇_셋과_카트를_시작하면_카운트다운_뒤에_봇이_달린다() {
    let app = TestApp::new(None).await;
    let base = serve(&app).await;
    let cookie = app.register(ISLAND, "에이").await;
    let id = app.user_id(ISLAND).await.to_string();
    let mut room = open(format!("{base}/api/rooms/{ISLAND}?ticket={}", ticket(&app, &cookie).await)).await;
    send(&mut room, json!({"type": "Join", "room_id": ISLAND, "color": "#ff7a59"})).await;
    let welcome = next_where(&mut room, "Welcome", Duration::from_secs(2), |_| true).await.unwrap();
    let peer = welcome["client_id"].as_str().unwrap().to_owned();
    send(&mut room, json!({"type": "Update", "state": {"position": [3.0, 0.0, 3.0]}})).await;
    let url = format!("{base}/api/games/{ISLAND}?ticket={}&peer={peer}", ticket(&app, &cookie).await);
    let mut game = open(url).await;
    let first = session(&mut game, Duration::from_secs(2), |_| true).await;
    assert!(first.is_null());

    // Alone, the host opens 카트 and starts it with three bots.
    send(&mut game, json!({"type": "Open", "kind": "kart"})).await;
    session(&mut game, Duration::from_secs(2), |session| session["phase"] == "lobby").await;
    send(&mut game, json!({"type": "Start", "layout": layout()})).await;
    let started = session(&mut game, Duration::from_secs(2), |session| session["phase"] == "playing").await;
    let view = &started["game"];
    assert_eq!(view["phase"], "countdown");
    assert_eq!(view["startsAt"], json!(view["endsAt"].as_u64().unwrap() - 6 * 60_000));
    let racers = view["racers"].as_array().unwrap();
    assert_eq!(racers.len(), 4);
    assert_eq!(racers.iter().filter(|racer| racer["bot"] == true).count(), 3);
    assert!(racers.iter().any(|racer| racer["id"] == json!(id) && racer["name"] == "에이"));
    assert_eq!(view["me"], json!({"lap": 0, "next": 1, "item": null}));
    assert_eq!(view["spawn"][1], json!(Y));
    assert_eq!(view["bots"].as_array().unwrap().len(), 3);
    assert_eq!(view["boxes"], json!([{"id": 0, "position": spot(20.0, 0.0), "ready": true}]));
    // An item before the start is refused.
    send(&mut game, json!({"type": "Act", "action": {"do": "item"}})).await;
    let refused = next_where(&mut game, "Error", Duration::from_secs(2), |_| true).await.unwrap();
    assert_eq!(refused["code"], "not_now");

    // The page goes to its slot; three seconds on, the race is on and the bots are under way.
    send(&mut room, json!({"type": "Update", "state": {"position": view["spawn"]}})).await;
    let starts_at = view["startsAt"].as_u64().unwrap();
    let racing = session(&mut game, Duration::from_secs(5), |session| session["game"]["phase"] == "race").await;
    assert!(racing["now"].as_u64().unwrap() >= starts_at);
    for bot in racing["game"]["bots"].as_array().unwrap() {
        let route = &bot["route"];
        assert!(route["departAt"].as_u64().unwrap() >= starts_at);
        assert!(route["speed"].as_f64().unwrap() > 10.0);
        assert!(route["points"].as_array().unwrap().len() >= 2);
    }
    // A bot crosses the line and its next gate moves on.
    let moved = session(&mut game, Duration::from_secs(5), |session| {
        session["game"]["racers"].as_array().is_some_and(|racers| racers.iter().any(|racer| racer["next"] == 2))
    })
    .await;
    assert_eq!(moved["game"]["racers"][0]["bot"], true);
    app.cleanup().await;
}
