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
