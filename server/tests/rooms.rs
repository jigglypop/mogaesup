mod common;

use axum::http::StatusCode;
use common::{ORIGIN, TestApp};
use futures_util::{SinkExt, StreamExt};
use mogaesup_server::auth::SESSIONS_PER_USER;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::header},
};

type Stream = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[tokio::test]
async fn 명시적_섬권한과_그룹권한을_회수하면_기존_소켓도_닫힌다() {
    let app = TestApp::new(None).await;
    let host = app.register("rev_host", "host").await;
    let guest = app.register("rev_guest", "guest").await;
    app.make_admin("rev_host").await;
    app.call("PATCH", "/api/homes/me", Some(json!({"visibility": "private"})), Some(&host)).await;
    let object = format!("home:{}", app.user_id("rev_host").await);
    let base = serve(&app).await;
    let direct = json!({"object": object, "relation": "viewer", "subject": "user:rev_guest", "reason": "access"});
    assert_eq!(
        app.call("POST", "/api/admin/permissions/grant", Some(direct.clone()), Some(&host)).await.status,
        StatusCode::CREATED
    );
    let mut socket = connect(&base, "rev_host", &ticket(&app, &guest).await, ORIGIN).await.unwrap();
    send(&mut socket, json!({"type": "Join", "room_id": "rev_host", "color": "#fff"})).await;
    next(&mut socket, "Welcome").await.unwrap();
    app.call("POST", "/api/admin/permissions/revoke", Some(direct), Some(&host)).await;
    assert_eq!(closed(&mut socket).await, Some(4403));
    app.grant("rev_guest", "group:visitors", "member").await;
    let group = json!({"object": object, "relation": "viewer", "subject": "group:visitors#member", "reason": "group"});
    assert_eq!(
        app.call("POST", "/api/admin/permissions/grant", Some(group), Some(&host)).await.status,
        StatusCode::CREATED
    );
    let mut socket = connect(&base, "rev_host", &ticket(&app, &guest).await, ORIGIN).await.unwrap();
    send(&mut socket, json!({"type": "Join", "room_id": "rev_host", "color": "#fff"})).await;
    next(&mut socket, "Welcome").await.unwrap();
    let membership =
        json!({"object": "group:visitors", "relation": "member", "subject": "user:rev_guest", "reason": "removed"});
    app.call("POST", "/api/admin/permissions/revoke", Some(membership), Some(&host)).await;
    assert_eq!(closed(&mut socket).await, Some(4403));
    app.cleanup().await;
}

#[tokio::test]
async fn 로그아웃은_기존_소켓과_미사용_티켓을_끝낸다() {
    let app = TestApp::new(None).await;
    let host = app.register("session_host", "host").await;
    let base = serve(&app).await;
    let unused = ticket(&app, &host).await;
    let mut socket = connect(&base, "session_host", &ticket(&app, &host).await, ORIGIN).await.unwrap();
    send(&mut socket, json!({"type": "Join", "room_id": "session_host", "color": "#fff"})).await;
    next(&mut socket, "Welcome").await.unwrap();
    assert_eq!(app.call("POST", "/api/auth/logout", None, Some(&host)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(closed(&mut socket).await, Some(4401));
    assert!(connect(&base, "session_host", &unused, ORIGIN).await.is_err());
    app.cleanup().await;
}

#[tokio::test]
async fn 세션_상한으로_제거된_연결만_닫고_동시_로그인도_상한을_지킨다() {
    let app = TestApp::new(None).await;
    let first = app.register("session_cap", "host").await;
    let base = serve(&app).await;
    let mut oldest = connect(&base, "session_cap", &ticket(&app, &first).await, ORIGIN).await.unwrap();
    send(&mut oldest, json!({"type": "Join", "room_id": "session_cap", "color": "#fff"})).await;
    next(&mut oldest, "Welcome").await.unwrap();
    let login = || {
        app.call(
            "POST",
            "/api/auth/login",
            Some(json!({"username": "session_cap", "password": "correct horse battery"})),
            None,
        )
    };
    let second = login().await.cookie.unwrap();
    let mut retained = connect(&base, "session_cap", &ticket(&app, &second).await, ORIGIN).await.unwrap();
    send(&mut retained, json!({"type": "Join", "room_id": "session_cap", "color": "#fff"})).await;
    next(&mut retained, "Welcome").await.unwrap();
    // The first session is the one used least recently: the cap's next sign-in ends it.
    for _ in 0..SESSIONS_PER_USER - 1 {
        assert_eq!(login().await.status, StatusCode::OK);
    }
    assert_eq!(closed(&mut oldest).await, Some(4401));
    send(&mut retained, json!({"type": "Ping", "ts": 17})).await;
    assert_eq!(next(&mut retained, "Pong").await.unwrap()["ts"], 17);
    let replies = futures_util::future::join_all((0..10).map(|_| login())).await;
    assert!(replies.iter().all(|reply| reply.status == StatusCode::OK));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sessions").fetch_one(&app.state.db).await.unwrap(),
        SESSIONS_PER_USER
    );
    assert_eq!(closed(&mut retained).await, Some(4401));
    app.cleanup().await;
}

#[tokio::test]
async fn 데이터베이스에서_만료된_세션은_연결_중에도_끝난다() {
    let app = TestApp::new(None).await;
    let host = app.register("expired_socket", "host").await;
    let base = serve(&app).await;
    let mut socket = connect(&base, "expired_socket", &ticket(&app, &host).await, ORIGIN).await.unwrap();
    send(&mut socket, json!({"type": "Join", "room_id": "expired_socket", "color": "#fff"})).await;
    next(&mut socket, "Welcome").await.unwrap();
    sqlx::query("UPDATE sessions SET expires_at = now() - interval '1 second'").execute(&app.state.db).await.unwrap();
    // The access check runs every 15 s: when its first look came before the session expired, the next one ends it, and
    // a busy runner can take a while past that.
    let code = tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(Ok(message)) = socket.next().await {
            if let Message::Close(frame) = message {
                return frame.map(|frame| u16::from(frame.code));
            }
        }
        None
    })
    .await
    .unwrap();
    assert_eq!(code, Some(4401));
    app.cleanup().await;
}

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
    send(&mut host_socket, json!({"type": "Update", "state": {"position": [0.0, 0.0, 0.0]}})).await;

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
    assert_eq!(states[0]["position"], json!([0.0, 0.0, 0.0]));
    // The others hear of the guest only with its first position, not at the island's origin.
    assert!(next(&mut host_socket, "PlayerJoined").await.is_none());
    send(&mut guest_socket, json!({"type": "Update", "state": {"position": [3.0, 0.0, 4.0], "rotation": [1.0, 0.0, 0.0, 0.0], "animation": "walk", "name": "바꾼 이름", "t": 1234.0}})).await;
    let joined = next(&mut host_socket, "PlayerJoined").await.unwrap();
    assert_eq!(joined["state"]["name"], "손님");
    assert_eq!(joined["state"]["modelUrl"], model);
    assert_eq!(joined["state"]["position"], json!([3.0, 0.0, 4.0]));
    assert_eq!(joined["state"]["animation"], "walk");
    assert_eq!(joined["state"]["t"], 1234.0);
    let guest_id = joined["client_id"].as_str().unwrap().to_owned();

    send(&mut guest_socket, json!({"type": "Update", "state": {"position": [3.5, 0.0, 4.0], "animation": "run", "name": "바꾼 이름", "t": 1284.0}})).await;
    let update = next(&mut host_socket, "PlayerUpdate").await.unwrap();
    assert_eq!(update["client_id"], guest_id.as_str());
    assert_eq!(update["state"]["animation"], "run");
    // The sender's sample time is relayed so receivers can draw the peer on its own timeline.
    assert_eq!(update["state"]["t"], 1284.0);
    assert!(update["state"].get("name").is_none());

    // A peer's finite but non-unit quaternion must never reach the others' renderer or physics unchanged.
    for magnitude in [100_000.0, 1e-300] {
        send(&mut guest_socket, json!({"type": "Update", "state": {"rotation": [0.0, magnitude, magnitude, 0.0]}}))
            .await;
        let update = next(&mut host_socket, "PlayerUpdate").await.unwrap();
        let rotation = update["state"]["rotation"].as_array().unwrap();
        let length_squared = rotation.iter().map(|value| value.as_f64().unwrap().powi(2)).sum::<f64>();
        assert!((length_squared - 1.0).abs() < 1e-12);
        assert!((rotation[1].as_f64().unwrap() - std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-12);
    }

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
    // Confirm all rejected joins were processed before starting the no-broadcast window. Otherwise parallel DB
    // checks can delay their processing, and the following invalid updates accidentally exceed the spam budget.
    send(&mut guest_socket, json!({"type": "Ping", "ts": 19})).await;
    assert_eq!(next(&mut guest_socket, "Pong").await.unwrap()["ts"], 19);
    assert!(next(&mut host_socket, "PlayerJoined").await.is_none());

    let model = "http://test.local/gltf/man.glb";
    send(&mut guest_socket, json!({"type": "Join", "room_id": "host_x", "color": "#8b6cf0", "modelUrl": model})).await;
    next(&mut guest_socket, "Welcome").await.unwrap();
    send(&mut guest_socket, json!({"type": "Update", "state": {"position": [1.0, 0.0, 1.0]}})).await;
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
    // Two on someone else's island (an account holds no more there) and two on its own.
    for island in ["host_k", "host_k", "guest_k", "guest_k"] {
        sockets.push(connect(&base, island, &ticket(&app, &guest).await, ORIGIN).await.unwrap());
    }
    // The fifth is turned away whichever island it asks for; another account is not held back.
    assert!(connect(&base, "host_k", &ticket(&app, &guest).await, ORIGIN).await.is_err());
    assert!(connect(&base, "guest_k", &ticket(&app, &guest).await, ORIGIN).await.is_err());
    assert!(connect(&base, "host_k", &ticket(&app, &host).await, ORIGIN).await.is_ok());

    sockets.pop().unwrap().close(None).await.unwrap();
    let mut reopened = false;
    for _ in 0..40 {
        if connect(&base, "guest_k", &ticket(&app, &guest).await, ORIGIN).await.is_ok() {
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
    send(&mut guest_socket, json!({"type": "Update", "state": {"position": [2.0, 0.0, 2.0]}})).await;
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

#[tokio::test]
async fn 끊겼던_링크가_한꺼번에_보낸_움직임은_연결을_끊지_않고_범람만_막는다() {
    let app = TestApp::new(None).await;
    let host = app.register("host_b", "호스트").await;
    let guest = app.register("guest_b", "손님").await;
    let base = serve(&app).await;
    let mut host_socket = connect(&base, "host_b", &ticket(&app, &host).await, ORIGIN).await.unwrap();
    send(&mut host_socket, json!({"type": "Join", "room_id": "host_b", "color": "#ff7a59"})).await;
    next(&mut host_socket, "Welcome").await.unwrap();
    let mut guest_socket = connect(&base, "host_b", &ticket(&app, &guest).await, ORIGIN).await.unwrap();
    send(&mut guest_socket, json!({"type": "Join", "room_id": "host_b", "color": "#8b6cf0"})).await;
    next(&mut guest_socket, "Welcome").await.unwrap();
    // Three seconds of 20 Hz movement a stalled phone delivers at once.
    for index in 0..60 {
        let x = f64::from(index) * 0.5;
        send(
            &mut guest_socket,
            json!({"type": "Update", "state": {"position": [x, 0.0, 0.0], "t": 1000.0 + f64::from(index) * 50.0}}),
        )
        .await;
    }
    send(&mut guest_socket, json!({"type": "Ping", "ts": 7})).await;
    assert_eq!(next(&mut guest_socket, "Pong").await.unwrap()["ts"], 7, "the burst keeps the socket open");
    assert!(next(&mut host_socket, "PlayerJoined").await.is_some());
    // A real flood still closes it.
    for _ in 0..400 {
        send(&mut guest_socket, json!({"type": "Ping", "ts": 1})).await;
    }
    assert_eq!(closed(&mut guest_socket).await, Some(4429));
    app.cleanup().await;
}

#[tokio::test]
async fn 들어오기만_하고_참가하지_않는_소켓은_자리를_오래_잡지_못한다() {
    let app = TestApp::new(None).await;
    let host = app.register("host_j", "호스트").await;
    let guest = app.register("guest_j", "손님").await;
    let base = serve(&app).await;
    let mut idle = connect(&base, "host_j", &ticket(&app, &guest).await, ORIGIN).await.unwrap();
    let mut joined = connect(&base, "host_j", &ticket(&app, &host).await, ORIGIN).await.unwrap();
    send(&mut joined, json!({"type": "Join", "room_id": "host_j", "color": "#ff7a59"})).await;
    next(&mut joined, "Welcome").await.unwrap();
    let code = tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(Ok(message)) = idle.next().await {
            if let Message::Close(frame) = message {
                return frame.map(|frame| u16::from(frame.code));
            }
        }
        None
    })
    .await
    .unwrap();
    assert_eq!(code, Some(4408));
    send(&mut joined, json!({"type": "Ping", "ts": 3})).await;
    assert_eq!(next(&mut joined, "Pong").await.unwrap()["ts"], 3, "a joined socket stays");
    app.cleanup().await;
}

#[tokio::test]
async fn 붐비는_공개_섬에도_주인은_들어오고_한_주소는_자리를_다_잡지_못한다() {
    let app = TestApp::new(None).await;
    let host = app.register("host_f", "호스트").await;
    let base = serve(&app).await;
    let from = |address: &str| {
        let address = address.to_owned();
        move |base: &str, ticket: &str| {
            let mut request = format!("{base}/api/rooms/host_f?ticket={ticket}").into_client_request().unwrap();
            request.headers_mut().insert(header::ORIGIN, ORIGIN.parse().unwrap());
            request.headers_mut().insert("x-forwarded-for", address.parse().unwrap());
            request
        }
    };
    // One address (a /64) fills only part of the room, whatever accounts it signs up.
    let mut crowd = Vec::new();
    let mut refused = 0;
    for at in 0..12 {
        let cookie = app.register(&format!("crowd_{at}"), "방문객").await;
        let request = from("2001:db8:1:2::9")(&base, &ticket(&app, &cookie).await);
        match connect_async(request).await {
            Ok((stream, _)) => crowd.push(stream),
            Err(_) => refused += 1,
        }
    }
    assert_eq!((crowd.len(), refused), (10, 2));
    // The owner gets in from that very address.
    let request = from("2001:db8:1:2::77")(&base, &ticket(&app, &host).await);
    assert!(connect_async(request).await.is_ok());
    app.cleanup().await;
}
