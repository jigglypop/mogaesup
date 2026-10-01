mod common;

use axum::http::StatusCode;
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

async fn connect(base: &str, room: &str, ticket: &str, origin: &str) -> Result<Stream, ()> {
    let mut request = format!("{base}/api/rooms/{room}?ticket={ticket}").into_client_request().unwrap();
    request.headers_mut().insert(header::ORIGIN, origin.parse().unwrap());
    connect_async(request).await.map(|(stream, _)| stream).map_err(|_| ())
}

async fn send(stream: &mut Stream, message: Value) {
    stream.send(Message::text(message.to_string())).await.unwrap();
}

/// The next JSON message of `kind`, skipping others; None when nothing arrives within a second.
async fn next(stream: &mut Stream, kind: &str) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, stream.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["type"] == kind {
                    return Some(value);
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => return None,
        }
    }
}

#[tokio::test]
async fn 방에_들어가면_서로_보이고_가까운_사람에게만_말이_닿는다() {
    let app = TestApp::new(None).await;
    let host = app.register("host_r", "호스트").await;
    let guest = app.register("guest_r", "손님").await;
    let far = app.register("far_r", "멀리").await;
    let base = serve(&app).await;

    let mut host_socket = connect(&base, "host_r", &ticket(&app, &host).await, ORIGIN).await.unwrap();
    send(&mut host_socket, json!({"type": "Join", "room_id": "host_r", "name": "위조", "color": "#ff7a59"})).await;
    assert_eq!(next(&mut host_socket, "Welcome").await.unwrap()["room_state"], json!({}));

    let mut guest_socket = connect(&base, "host_r", &ticket(&app, &guest).await, ORIGIN).await.unwrap();
    let model = "http://test.local/gltf/man.glb";
    send(
        &mut guest_socket,
        json!({"type": "Join", "room_id": "host_r", "name": "가짜", "color": "#8b6cf0", "modelUrl": model}),
    )
    .await;
    let welcome = next(&mut guest_socket, "Welcome").await.unwrap();
    let states: Vec<Value> = welcome["room_state"].as_object().unwrap().values().cloned().collect();
    assert_eq!(states[0]["name"], "호스트");
    let joined = next(&mut host_socket, "PlayerJoined").await.unwrap();
    assert_eq!(joined["state"]["name"], "손님");
    assert_eq!(joined["state"]["modelUrl"], model);
    let guest_id = joined["client_id"].as_str().unwrap().to_owned();

    send(&mut guest_socket, json!({"type": "Update", "state": {"position": [3.0, 0.0, 4.0], "rotation": [1.0, 0.0, 0.0, 0.0], "animation": "walk", "name": "바꾼 이름"}})).await;
    let update = next(&mut host_socket, "PlayerUpdate").await.unwrap();
    assert_eq!(update["client_id"], guest_id.as_str());
    assert_eq!(update["state"]["animation"], "walk");
    assert!(update["state"].get("name").is_none());

    let mut far_socket = connect(&base, "host_r", &ticket(&app, &far).await, ORIGIN).await.unwrap();
    send(&mut far_socket, json!({"type": "Join", "room_id": "host_r", "name": "x", "color": "#000000"})).await;
    next(&mut far_socket, "Welcome").await.unwrap();
    send(&mut far_socket, json!({"type": "Update", "state": {"position": [30.0, 0.0, 0.0]}})).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    send(&mut host_socket, json!({"type": "Chat", "text": "안녕!", "range": 10, "ackId": "chat-1"})).await;
    assert_eq!(next(&mut host_socket, "Ack").await.unwrap()["ackId"], "chat-1");
    assert_eq!(next(&mut guest_socket, "Chat").await.unwrap()["text"], "안녕!");
    assert!(next(&mut far_socket, "Chat").await.is_none());
    send(&mut host_socket, json!({"type": "Chat", "text": "안녕!", "range": 10, "ackId": "chat-1"})).await;
    assert_eq!(next(&mut host_socket, "Ack").await.unwrap()["ackId"], "chat-1");
    assert!(next(&mut guest_socket, "Chat").await.is_none());

    send(&mut host_socket, json!({"type": "Ping", "ts": 42})).await;
    assert_eq!(next(&mut host_socket, "Pong").await.unwrap()["ts"], 42);

    guest_socket.close(None).await.unwrap();
    assert_eq!(next(&mut host_socket, "PlayerLeft").await.unwrap()["client_id"], guest_id.as_str());
    app.cleanup().await;
}

#[tokio::test]
async fn 티켓은_한_번만_쓰고_출처와_공개_범위를_지킨다() {
    let app = TestApp::new(None).await;
    let host = app.register("host_s", "호스트").await;
    let guest = app.register("guest_s", "손님").await;
    let base = serve(&app).await;

    let used = ticket(&app, &guest).await;
    assert!(connect(&base, "host_s", &used, "https://evil.example").await.is_err());
    assert!(connect(&base, "host_s", &used, ORIGIN).await.is_ok());
    assert!(connect(&base, "host_s", &used, ORIGIN).await.is_err());
    assert!(connect(&base, "host_s", "not-a-ticket", ORIGIN).await.is_err());

    app.call("PATCH", "/api/homes/me", Some(json!({"visibility": "private"})), Some(&host)).await;
    assert!(connect(&base, "host_s", &ticket(&app, &guest).await, ORIGIN).await.is_err());
    assert!(connect(&base, "host_s", &ticket(&app, &host).await, ORIGIN).await.is_ok());

    let mut noisy = connect(&base, "guest_s", &ticket(&app, &guest).await, ORIGIN).await.unwrap();
    for _ in 0..12 {
        noisy.send(Message::text(r#"{"type":"Nope"}"#)).await.unwrap();
    }
    let closed = tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(message) = noisy.next().await {
            if let Ok(Message::Close(frame)) = message {
                return frame.map(|frame| u16::from(frame.code));
            }
        }
        None
    })
    .await
    .unwrap();
    assert_eq!(closed, Some(4400));
    app.cleanup().await;
}

/// The code of the close frame the server sends next; None when the stream ends without one or nothing comes in time.
async fn closed(stream: &mut Stream) -> Option<u16> {
    tokio::time::timeout(Duration::from_secs(2), async {
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
async fn 다른_곳의_모델_주소와_스타일로_번질_색은_받지_않는다() {
    let app = TestApp::new(None).await;
    let host = app.register("host_x", "호스트").await;
    let guest = app.register("guest_x", "손님").await;
    let base = serve(&app).await;
    let mut host_socket = connect(&base, "host_x", &ticket(&app, &host).await, ORIGIN).await.unwrap();
    send(&mut host_socket, json!({"type": "Join", "room_id": "host_x", "color": "#ff7a59"})).await;
    next(&mut host_socket, "Welcome").await.unwrap();

    // Joins the room must never hear of: another host, credentials that only look like the site's, a lookalike host,
    // another scheme or port, and colours a stylesheet would read as something else.
    let mut guest_socket = connect(&base, "host_x", &ticket(&app, &guest).await, ORIGIN).await.unwrap();
    for (color, model) in [
        ("#8b6cf0", Some("https://evil.example/gltf/x.glb")),
        ("#8b6cf0", Some("http://test.local@evil.example/gltf/x.glb")),
        ("#8b6cf0", Some("http://test.local.evil.example/gltf/x.glb")),
        ("#8b6cf0", Some("https://test.local/gltf/x.glb")),
        ("#8b6cf0", Some("http://test.local:8080/gltf/x.glb")),
        ("#8b6cf0", Some("http://test.local/gltf/x.glb?//evil.example")),
        ("url(//evil.io/p)", None),
        ("red", None),
        ("#8b6cf0; background: url(//evil.io/p)", None),
    ] {
        let mut join = json!({"type": "Join", "room_id": "host_x", "color": color});
        if let Some(model) = model {
            join["modelUrl"] = json!(model);
        }
        send(&mut guest_socket, join).await;
    }
    assert!(next(&mut host_socket, "PlayerJoined").await.is_none());

    let model = "http://test.local/gltf/man.glb";
    send(&mut guest_socket, json!({"type": "Join", "room_id": "host_x", "color": "#8b6cf0", "modelUrl": model})).await;
    next(&mut guest_socket, "Welcome").await.unwrap();
    assert_eq!(next(&mut host_socket, "PlayerJoined").await.unwrap()["state"]["modelUrl"], model);

    // Updates change what the others see only with a hex colour and a model of the site's own.
    for state in [
        json!({"color": "url(//evil.io/p)"}),
        json!({"color": "#fff,url(//evil.io/p)"}),
        json!({"modelUrl": "https://evil.example/gltf/x.glb"}),
        json!({"modelUrl": "http://test.local@evil.example/gltf/x.glb"}),
    ] {
        send(&mut guest_socket, json!({"type": "Update", "state": state})).await;
    }
    send(
        &mut guest_socket,
        json!({"type": "Update", "state": {"color": "#2bb3a3", "modelUrl": model, "animation": "walk"}}),
    )
    .await;
    let update = next(&mut host_socket, "PlayerUpdate").await.unwrap();
    assert_eq!(update["state"]["color"], "#2bb3a3");
    assert_eq!(update["state"]["modelUrl"], model);

    // Whoever comes later is told the state the room really holds.
    let late = app.register("late_x", "늦은 손님").await;
    let mut late_socket = connect(&base, "host_x", &ticket(&app, &late).await, ORIGIN).await.unwrap();
    send(&mut late_socket, json!({"type": "Join", "room_id": "host_x", "color": "#000000"})).await;
    let welcome = next(&mut late_socket, "Welcome").await.unwrap();
    let states: Vec<Value> = welcome["room_state"].as_object().unwrap().values().cloned().collect();
    let guest_state = states.iter().find(|state| state["name"] == "손님").unwrap();
    assert_eq!((guest_state["color"].as_str(), guest_state["modelUrl"].as_str()), (Some("#2bb3a3"), Some(model)));
    app.cleanup().await;
}

#[tokio::test]
async fn 한_계정은_실시간_연결을_네_개까지만_열고_닫으면_다시_연다() {
    let app = TestApp::new(None).await;
    let host = app.register("host_k", "호스트").await;
    let guest = app.register("guest_k", "손님").await;
    let base = serve(&app).await;
    let mut sockets = Vec::new();
    for _ in 0..4 {
        sockets.push(connect(&base, "host_k", &ticket(&app, &guest).await, ORIGIN).await.unwrap());
    }
    // The fifth is turned away whichever island it asks for; another account is not held back.
    assert!(connect(&base, "host_k", &ticket(&app, &guest).await, ORIGIN).await.is_err());
    assert!(connect(&base, "guest_k", &ticket(&app, &guest).await, ORIGIN).await.is_err());
    assert!(connect(&base, "host_k", &ticket(&app, &host).await, ORIGIN).await.is_ok());

    sockets.pop().unwrap().close(None).await.unwrap();
    let mut reopened = false;
    for _ in 0..40 {
        if connect(&base, "host_k", &ticket(&app, &guest).await, ORIGIN).await.is_ok() {
            reopened = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(reopened, "a closed socket gives its place back");
    app.cleanup().await;
}

#[tokio::test]
async fn 섬이_더_좁게_공개되거나_일촌이_끊기면_들어와_있던_사람도_내보낸다() {
    let app = TestApp::new(None).await;
    let host = app.register("host_e", "호스트").await;
    let guest = app.register("guest_e", "손님").await;
    let friend = app.register("friend_e", "일촌").await;
    let base = serve(&app).await;
    let join = |name: &'static str| json!({"type": "Join", "room_id": "host_e", "color": "#123456", "name": name});

    let mut host_socket = connect(&base, "host_e", &ticket(&app, &host).await, ORIGIN).await.unwrap();
    send(&mut host_socket, join("host")).await;
    next(&mut host_socket, "Welcome").await.unwrap();
    let mut guest_socket = connect(&base, "host_e", &ticket(&app, &guest).await, ORIGIN).await.unwrap();
    send(&mut guest_socket, join("guest")).await;
    next(&mut guest_socket, "Welcome").await.unwrap();
    let guest_id = next(&mut host_socket, "PlayerJoined").await.unwrap()["client_id"].as_str().unwrap().to_owned();

    // Staying open to everyone lets nobody out; closing the island to its 일촌 lets the guest out and only the guest.
    let widened = app.call("PATCH", "/api/homes/me", Some(json!({"visibility": "public"})), Some(&host)).await;
    assert_eq!(widened.status, StatusCode::OK);
    send(&mut guest_socket, json!({"type": "Ping", "ts": 1})).await;
    assert_eq!(next(&mut guest_socket, "Pong").await.unwrap()["ts"], 1);
    let narrowed = app.call("PATCH", "/api/homes/me", Some(json!({"visibility": "ilchon"})), Some(&host)).await;
    assert_eq!(narrowed.status, StatusCode::OK);
    assert_eq!(closed(&mut guest_socket).await, Some(4403));
    assert_eq!(next(&mut host_socket, "PlayerLeft").await.unwrap()["client_id"], guest_id.as_str());
    send(&mut host_socket, json!({"type": "Ping", "ts": 2})).await;
    assert_eq!(next(&mut host_socket, "Pong").await.unwrap()["ts"], 2, "the owner stays");
    assert_eq!(app.state.rooms.count(), 1);

    // A 일촌 is let in, and let out again when the tie is cut.
    let asked = app
        .call(
            "POST",
            "/api/ilchon/host_e/request",
            Some(json!({"name": "섬주인", "theirName": "꽃밭지기"})),
            Some(&friend),
        )
        .await;
    assert_eq!(asked.status, StatusCode::CREATED);
    let received = app.call("GET", "/api/ilchon-requests", None, Some(&host)).await;
    let id = received.body["received"][0]["id"].as_str().unwrap().to_owned();
    let accepted = app
        .call("POST", &format!("/api/ilchon-requests/{id}/accept"), Some(json!({"name": "베프"})), Some(&host))
        .await;
    assert_eq!(accepted.status, StatusCode::OK, "{:?}", accepted.body);
    let mut friend_socket = connect(&base, "host_e", &ticket(&app, &friend).await, ORIGIN).await.unwrap();
    send(&mut friend_socket, join("friend")).await;
    next(&mut friend_socket, "Welcome").await.unwrap();
    let unlinked = app.call("DELETE", "/api/ilchon/friend_e", None, Some(&host)).await;
    assert_eq!(unlinked.status, StatusCode::NO_CONTENT);
    assert_eq!(closed(&mut friend_socket).await, Some(4403));
    assert!(connect(&base, "host_e", &ticket(&app, &friend).await, ORIGIN).await.is_err());
    app.cleanup().await;
}
