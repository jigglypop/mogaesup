//! 임포스터 over real sockets: four people in an island's live room play one round from the start to an ejection. The
//! game's waits are real (the kill cooldown, the meeting's talk), so this takes about a minute.

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

const ISLAND: &str = "sus_a";

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

/// One person on the island: who they are, their live-room socket (where they stand) and their game socket.
struct Member {
    id: String,
    name: &'static str,
    at: [f64; 3],
    room: Stream,
    game: Stream,
}

impl Member {
    /// Stands somewhere else in the live room.
    async fn walk(&mut self, to: [f64; 3]) {
        self.at = to;
        send(&mut self.room, json!({"type": "Update", "state": {"position": to}})).await;
    }

    async fn act(&mut self, action: Value) {
        send(&mut self.game, json!({"type": "Act", "action": action})).await;
    }

    /// The next session this member is shown that `wanted` accepts, within two seconds.
    async fn session(&mut self, wanted: impl Fn(&Value) -> bool) -> Value {
        let frame = next_where(&mut self.game, "Session", Duration::from_secs(2), |frame| wanted(&frame["session"]));
        frame.await.expect("a session view")["session"].clone()
    }

    async fn refused(&mut self) -> String {
        let frame = next_where(&mut self.game, "Error", Duration::from_secs(2), |_| true).await.expect("a refusal");
        frame["code"].as_str().unwrap().to_owned()
    }

    async fn event(&mut self, kind: &str) -> Value {
        let frame = next_where(&mut self.game, "Event", Duration::from_secs(2), |frame| frame["event"]["type"] == kind);
        frame.await.expect("an event")["event"].clone()
    }
}

/// Pings every socket, as each page's own heartbeat would, so a long wait drops nobody for silence.
async fn keep_alive(everyone: &mut [Member]) {
    for member in everyone {
        send(&mut member.room, json!({"type": "Ping", "ts": 1})).await;
        send(&mut member.game, json!({"type": "Ping", "ts": 1})).await;
    }
}

/// Waits until `until`, keeping every socket alive.
async fn idle(everyone: &mut [Member], until: Instant) {
    while Instant::now() < until {
        keep_alive(everyone).await;
        tokio::time::sleep(until.saturating_duration_since(Instant::now()).min(Duration::from_secs(5))).await;
    }
}

/// Waits up to `limit` for a session view of `everyone[index]` that `wanted` accepts, keeping every socket alive.
async fn await_session(
    everyone: &mut [Member],
    index: usize,
    limit: Duration,
    wanted: impl Fn(&Value) -> bool,
) -> Value {
    let deadline = Instant::now() + limit;
    loop {
        keep_alive(everyone).await;
        let window = deadline.saturating_duration_since(Instant::now()).min(Duration::from_secs(5));
        let game = &mut everyone[index].game;
        if let Some(frame) = next_where(game, "Session", window, |frame| wanted(&frame["session"])).await {
            return frame["session"].clone();
        }
        assert!(Instant::now() < deadline, "no such view in time");
    }
}

/// Signs `username` up and puts them in the island's live room at `at`, with a game socket of their own.
async fn arrive(app: &TestApp, base: &str, username: &str, name: &'static str, at: [f64; 3]) -> Member {
    let cookie = app.register(username, name).await;
    let id = app.user_id(username).await.to_string();
    let mut room = open(format!("{base}/api/rooms/{ISLAND}?ticket={}", ticket(app, &cookie).await)).await;
    send(&mut room, json!({"type": "Join", "room_id": ISLAND, "color": "#ff7a59"})).await;
    let welcome = next_where(&mut room, "Welcome", Duration::from_secs(2), |_| true).await.unwrap();
    let peer = welcome["client_id"].as_str().unwrap().to_owned();
    send(&mut room, json!({"type": "Update", "state": {"position": at}})).await;
    let mut game = open(format!("{base}/api/games/{ISLAND}?ticket={}&peer={peer}", ticket(app, &cookie).await)).await;
    let first = next_where(&mut game, "Session", Duration::from_secs(2), |_| true).await.unwrap();
    assert!(first["session"].is_null() || first["session"]["kind"] == "impostor");
    Member { id, name, at, room, game }
}

fn players(session: &Value) -> usize {
    session["players"].as_array().map_or(0, Vec::len)
}

#[tokio::test]
async fn 네_사람이_임포스터를_하며_처치하고_신고해_회의의_투표로_임포스터를_쫓아낸다() {
    let app = TestApp::new(None).await;
    let base = serve(&app).await;
    let people = [(ISLAND, "에이"), ("sus_b", "비"), ("sus_c", "씨"), ("sus_d", "디")];
    let mut everyone = Vec::new();
    for (index, (username, name)) in people.into_iter().enumerate() {
        everyone.push(arrive(&app, &base, username, name, [index as f64 * 10.0, 0.0, 0.0]).await);
    }

    // The host opens 임포스터; the others join; the host starts with a table and six stations away from everyone.
    send(&mut everyone[0].game, json!({"type": "Open", "kind": "impostor"})).await;
    for member in &mut everyone[1..] {
        member.session(|session| session["phase"] == "lobby").await;
        send(&mut member.game, json!({"type": "Join"})).await;
    }
    everyone[0].session(|session| players(session) == 4).await;
    let stations: Vec<[f64; 3]> = (0..6).map(|index| [index as f64 * 10.0 - 40.0, 0.0, 30.0]).collect();
    let layout = json!({"table": [0.0, 0.0, -20.0], "stations": stations});
    send(&mut everyone[0].game, json!({"type": "Start", "layout": layout})).await;

    // Each sees their own role only: one impostor, who alone sees who the impostors are.
    let mut views = Vec::new();
    for member in &mut everyone {
        views.push(member.session(|session| session["phase"] == "playing").await);
    }
    let started = Instant::now();
    let roles: Vec<&str> = views.iter().map(|view| view["game"]["role"].as_str().unwrap()).collect();
    let impostor = roles.iter().position(|role| *role == "impostor").unwrap();
    assert_eq!(roles.iter().filter(|role| **role == "impostor").count(), 1);
    let crew: Vec<usize> = (0..4).filter(|index| *index != impostor).collect();
    let (victim, finder, other) = (crew[0], crew[1], crew[2]);
    let mine = &views[impostor]["game"];
    assert_eq!(mine["impostors"], json!([everyone[impostor].id]));
    assert_eq!(mine["tasks"].as_array().unwrap().len(), 4);
    for index in &crew {
        let game = &views[*index]["game"];
        assert_eq!((&game["impostors"], &game["kill"]), (&Value::Null, &Value::Null));
        assert_eq!((game["phase"].as_str(), game["progress"].clone()), (Some("play"), json!({"done": 0, "total": 12})));
    }

    // The impostor walks up to the victim: in reach, but too early to kill.
    let target = everyone[victim].id.clone();
    let near = [everyone[victim].at[0] + 1.0, 0.0, 0.0];
    everyone[impostor].walk(near).await;
    let seen = everyone[impostor].session(|session| session["game"]["kill"]["targets"] == json!([target])).await;
    everyone[impostor].act(json!({"do": "kill", "target": target})).await;
    assert_eq!(everyone[impostor].refused().await, "cooldown");

    // Once the cooldown has run (the server's clock, read off the view), the kill goes through. A change's session
    // view comes before its events.
    let wait =
        seen["game"]["kill"]["readyAt"].as_u64().unwrap().saturating_sub(views[impostor]["now"].as_u64().unwrap());
    idle(&mut everyone, started + Duration::from_millis(wait + 300)).await;
    everyone[impostor].act(json!({"do": "kill", "target": target})).await;
    let dead = everyone[victim].session(|session| session["game"]["alive"] == false).await;
    assert_eq!(dead["game"]["bodies"][0]["victim"], json!(target));
    assert_eq!(everyone[victim].event("killed").await, json!({"type": "killed"}));
    let seen = everyone[other].session(|session| session["game"]["hidden"] == json!([target])).await;
    assert_eq!(seen["game"]["bodies"][0]["name"], everyone[victim].name);

    // Another walks up to the body and reports it: everyone alive gets a seat at the table.
    let body = [everyone[victim].at[0], 0.0, 1.5];
    everyone[finder].walk(body).await;
    everyone[finder].session(|session| session["game"]["near"]["body"] == 1).await;
    everyone[finder].act(json!({"do": "report", "body": 1})).await;
    let caller = everyone[finder].id.clone();
    for (index, member) in everyone.iter_mut().enumerate() {
        let view = member.session(|session| session["game"]["phase"] == "discuss").await;
        let seat = &view["game"]["meeting"]["seat"];
        assert_eq!(seat.is_array(), index != victim, "a seat for the living only");
        assert_eq!(view["game"]["meeting"]["body"]["victim"], json!(target));
    }
    let meeting = everyone[other].event("meeting").await;
    assert_eq!(
        meeting,
        json!({"type": "meeting", "number": 1, "reason": "report", "caller": caller, "victim": target})
    );

    // Talk first: the living to everyone, the dead to the dead; no votes yet.
    everyone[other].act(json!({"do": "vote", "target": null})).await;
    assert_eq!(everyone[other].refused().await, "not_now");
    everyone[finder].act(json!({"do": "say", "text": "여기서 봤어요"})).await;
    let said =
        everyone[impostor].session(|session| session["game"]["talk"].as_array().is_some_and(|talk| !talk.is_empty()));
    assert_eq!(said.await["game"]["talk"][0]["text"], "여기서 봤어요");
    everyone[victim].act(json!({"do": "say", "text": "나예요"})).await;
    let line = json!({"id": 2, "from": target, "name": everyone[victim].name, "text": "나예요", "ghost": true});
    let ghosts =
        everyone[victim].session(|session| session["game"]["talk"].as_array().is_some_and(|talk| talk.len() == 2));
    assert_eq!(ghosts.await["game"]["talk"][1], line);

    // The vote opens after thirty seconds of talk.
    let vote = |target: &str| json!({"do": "vote", "target": target});
    await_session(&mut everyone, finder, Duration::from_secs(40), |session| session["game"]["phase"] == "vote").await;
    for index in [impostor, other] {
        everyone[index].session(|session| session["game"]["phase"] == "vote").await;
    }
    let suspect = everyone[impostor].id.clone();
    everyone[victim].act(vote(&suspect)).await;
    assert_eq!(everyone[victim].refused().await, "out");
    everyone[finder].act(vote(&suspect)).await;
    everyone[other].act(vote(&suspect)).await;
    // Counted, not shown: nobody sees who voted for whom until the meeting ends.
    let counted = everyone[impostor].session(|session| session["game"]["meeting"]["voted"] == 2).await;
    assert_eq!(counted["game"]["meeting"]["myVote"], Value::Null);
    assert!(!counted.to_string().contains(&format!("\"target\":\"{suspect}\"")));

    // The last living vote ends the meeting: the impostor is ejected and the crew win.
    everyone[impostor].act(vote(&caller)).await;
    let ended = everyone[other].session(|session| session["phase"] == "ended").await;
    let verdict = everyone[other].event("verdict").await;
    assert_eq!(
        verdict,
        json!({"type": "verdict", "number": 1, "ejected": suspect, "name": everyone[impostor].name, "impostor": true})
    );
    assert_eq!(ended["result"]["winner"], "crew");
    assert_eq!(ended["result"]["reason"], "impostorsOut");
    // In the order they joined, which the sockets' own tasks decide: compared as sets.
    let mut revealed: Vec<(String, String)> = ended["result"]["players"]
        .as_array()
        .unwrap()
        .iter()
        .map(|player| (player["id"].as_str().unwrap().to_owned(), player["role"].as_str().unwrap().to_owned()))
        .collect();
    let mut dealt: Vec<(String, String)> =
        everyone.iter().zip(&roles).map(|(member, role)| (member.id.clone(), (*role).to_owned())).collect();
    revealed.sort();
    dealt.sort();
    assert_eq!(revealed, dealt);
    let votes = &ended["game"]["lastMeeting"]["votes"];
    assert_eq!(votes.as_array().unwrap().len(), 3);
    app.cleanup().await;
}
