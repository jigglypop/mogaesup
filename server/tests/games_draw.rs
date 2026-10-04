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

async fn act(stream: &mut Stream, action: Value) {
    send(stream, json!({"type": "Act", "action": action})).await;
}

/// Every JSON message up to and including the first that `last` accepts; panics when none comes within two seconds.
async fn until(stream: &mut Stream, last: impl Fn(&Value) -> bool) -> Vec<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let mut seen = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, stream.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let value: Value = serde_json::from_str(&text).unwrap();
                let done = last(&value);
                seen.push(value);
                if done {
                    return seen;
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => panic!("nothing came; saw {seen:?}"),
        }
    }
}

/// The next game event of `kind`.
async fn event(stream: &mut Stream, kind: &str) -> Value {
    until(stream, |frame| frame["type"] == "Event" && frame["event"]["type"] == kind).await.pop().unwrap()["event"]
        .clone()
}

/// The next session view `wanted` accepts.
async fn session_where(stream: &mut Stream, wanted: impl Fn(&Value) -> bool) -> Value {
    until(stream, |frame| frame["type"] == "Session" && wanted(&frame["session"])).await.pop().unwrap()["session"]
        .clone()
}

/// A member in `island`'s live room: their room socket and the `client_id` it was given.
async fn enter(app: &TestApp, base: &str, island: &str, cookie: &str) -> (Stream, String) {
    let mut room = open(format!("{base}/api/rooms/{island}?ticket={}", ticket(app, cookie).await)).await;
    send(&mut room, json!({"type": "Join", "room_id": island, "color": "#ff7a59"})).await;
    let welcome = until(&mut room, |frame| frame["type"] == "Welcome").await.pop().unwrap();
    let peer = welcome["client_id"].as_str().unwrap().to_owned();
    send(&mut room, json!({"type": "Update", "state": {"position": [0.0, 0.0, 0.0]}})).await;
    (room, peer)
}

async fn game(app: &TestApp, base: &str, island: &str, cookie: &str, peer: &str) -> Stream {
    open(format!("{base}/api/games/{island}?ticket={}&peer={peer}", ticket(app, cookie).await)).await
}

#[tokio::test]
async fn 둘이_캐치마인드를_하면_그림은_다른_사람에게_가고_제시어는_그리는_사람만_안다() {
    let app = TestApp::new(None).await;
    let host = app.register("draw_a", "에이").await;
    let guest = app.register("draw_b", "비").await;
    let onlooker = app.register("draw_c", "씨").await;
    let (a, b) = (app.user_id("draw_a").await, app.user_id("draw_b").await);
    let base = serve(&app).await;
    let (_room_a, peer_a) = enter(&app, &base, "draw_a", &host).await;
    let (_room_b, peer_b) = enter(&app, &base, "draw_a", &guest).await;
    let (_room_c, peer_c) = enter(&app, &base, "draw_a", &onlooker).await;
    let mut game_a = game(&app, &base, "draw_a", &host, &peer_a).await;
    let mut game_b = game(&app, &base, "draw_a", &guest, &peer_b).await;
    let mut game_c = game(&app, &base, "draw_a", &onlooker, &peer_c).await;

    send(&mut game_a, json!({"type": "Open", "kind": "draw"})).await;
    session_where(&mut game_b, |session| session["phase"] == "lobby").await;
    send(&mut game_b, json!({"type": "Join"})).await;
    session_where(&mut game_a, |session| session["players"].as_array().map_or(0, Vec::len) == 2).await;
    send(&mut game_a, json!({"type": "Start", "layout": {}})).await;

    // A draws first and alone knows the word; B and C, who only watches, see how long it is.
    let drawing = session_where(&mut game_a, |session| session["phase"] == "playing").await["game"].clone();
    let word = drawing["word"].as_str().unwrap().to_owned();
    assert_eq!((drawing["role"].as_str(), drawing["drawer"].clone()), (Some("drawer"), json!(a)));
    assert_eq!((drawing["turn"].as_u64(), drawing["turns"].as_u64()), (Some(1), Some(2)));
    let guessing = session_where(&mut game_b, |session| session["phase"] == "playing").await;
    let watching = session_where(&mut game_c, |session| session["phase"] == "playing").await;
    assert_eq!(
        (guessing["game"]["role"].as_str(), watching["game"]["role"].as_str()),
        (Some("guesser"), Some("watcher"))
    );
    for seen in [&guessing, &watching] {
        assert_eq!(seen["game"]["word"], Value::Null);
        assert_eq!(seen["game"]["letters"], word.chars().count());
        assert!(!seen.to_string().contains(&word));
    }

    // A's stroke goes to B and to C, but not back to A.
    let line = json!({"points": [[0.1, 0.2], [0.3, 0.4]], "color": "#e5484d", "size": 2});
    act(&mut game_a, json!({"stroke": line})).await;
    act(&mut game_a, json!({"stroke": {"points": [[0.5, 0.6]], "color": "#e5484d", "size": 2, "join": true}})).await;
    for socket in [&mut game_b, &mut game_c] {
        let first = event(socket, "stroke").await;
        assert_eq!(
            first,
            json!({"type": "stroke", "turn": 1, "stroke": {
                "points": [[0.1, 0.2], [0.3, 0.4]], "color": "#e5484d", "size": 2, "join": false,
            }})
        );
        assert_eq!(event(socket, "stroke").await["stroke"]["join"], true);
    }

    // A wrong guess is said to everyone; the drawer cannot guess.
    act(&mut game_b, json!({"guess": "모르겠어요"})).await;
    let said = until(&mut game_a, |frame| frame["event"]["type"] == "chat").await;
    assert!(said.iter().all(|frame| frame["event"]["type"] != "stroke"), "the drawer gets no strokes back: {said:?}");
    assert_eq!(said.last().unwrap()["event"], json!({"type": "chat", "player": b, "text": "모르겠어요"}));
    act(&mut game_a, json!({"guess": word})).await;
    let refused = until(&mut game_a, |frame| frame["type"] == "Error").await.pop().unwrap();
    assert_eq!(refused["code"], "drawer_guess");

    // C, joining the drawing late, asks for the board and gets it alone.
    act(&mut game_c, json!({"replay": true})).await;
    let replay = event(&mut game_c, "replay").await;
    assert_eq!((replay["part"].as_u64(), replay["parts"].as_u64()), (Some(0), Some(1)));
    assert_eq!(
        replay["strokes"],
        json!([{
            "points": [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]], "color": "#e5484d", "size": 2, "join": false,
        }])
    );
    act(&mut game_c, json!({"guess": word})).await;
    assert_eq!(until(&mut game_c, |frame| frame["type"] == "Error").await.pop().unwrap()["code"], "bad_action");

    // B guesses it: everyone hears that B did, not what it was, and then the turn ends and tells the word.
    act(&mut game_b, json!({"guess": format!("  {word} ")})).await;
    let guessed = event(&mut game_c, "guessed").await;
    assert_eq!(guessed["player"], json!(b));
    assert!(!guessed.to_string().contains(&word));
    let points = guessed["points"].as_u64().unwrap();
    assert!((19..=20).contains(&points), "{points}");
    let reveal = event(&mut game_c, "reveal").await;
    assert_eq!(reveal, json!({"type": "reveal", "turn": 1, "drawer": a, "word": word}));
    let paused = session_where(&mut game_b, |session| session["game"]["phase"] == "reveal").await["game"].clone();
    assert_eq!(paused["word"], json!(word));
    assert_eq!(paused["guessed"], json!([b]));
    assert_eq!(
        paused["scores"],
        json!([{"id": a, "name": "에이", "score": 5}, {"id": b, "name": "비", "score": points}])
    );
    app.cleanup().await;
}
