//! Live visits: one WebSocket room per minihome, speaking gaesup-world's multiplayer wire format
//! (`useMultiplayer`: Join/Update/Chat/Ping/Leave in, Welcome/PlayerJoined/PlayerUpdate/PlayerLeft/Chat/Pong/Ack out).
//! The client drops server messages it does not know, so nothing else is ever sent.

use axum::{
    Router,
    extract::{
        Path, Query, State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::get,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::{
    AppState,
    auth::User,
    error::{ApiError, ApiResult, conflict},
    homes::visible_home,
    security::{FOREIGN_ORIGIN, constant_time_eq, epoch_seconds, hmac_sha256, same_origin},
};

const TICKET_TTL_SECONDS: u64 = 60;
const MAX_MESSAGE_BYTES: usize = 16 * 1024;
const OUTBOUND_CAPACITY: usize = 256;
const ROOM_CAPACITY: usize = 30;
const SERVER_CAPACITY: usize = 512;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(45);
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const WINDOW: Duration = Duration::from_secs(1);
const MESSAGES_PER_SECOND: usize = 60;
const UPDATES_PER_SECOND: usize = 30;
const CHATS_PER_SECOND: usize = 4;
/// Malformed frames tolerated per second before the peer is dropped.
const INVALID_PER_SECOND: usize = 10;
const DEFAULT_CHAT_RANGE: f64 = 10.0;
const MAX_CHAT_RANGE: f64 = 40.0;
const MAX_CHAT_CHARS: usize = 200;
const MAX_COORDINATE: f64 = 100_000.0;
const MAX_LABEL: usize = 64;
const MAX_MODEL_URL: usize = 2048;
const ACK_MEMORY: usize = 64;
const REST_ROTATION: [f64; 4] = [1.0, 0.0, 0.0, 0.0];

#[derive(Debug, Deserialize, Serialize)]
struct TicketClaims {
    sub: Uuid,
    username: String,
    name: String,
    exp: u64,
    nonce: String,
}

/// A single-use, one-minute ticket: a browser cannot put a cookie or header on a WebSocket, so it carries this instead.
pub fn issue_ticket(secret: &[u8], user: &User) -> (String, u64) {
    let exp = epoch_seconds() + TICKET_TTL_SECONDS;
    let mut nonce = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let claims = TicketClaims {
        sub: user.id,
        username: user.username.clone(),
        name: user.display_name.clone(),
        exp,
        nonce: hex::encode(nonce),
    };
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap_or_default());
    let signature = URL_SAFE_NO_PAD.encode(hmac_sha256(secret, body.as_bytes()));
    (format!("{body}.{signature}"), exp)
}

struct RateWindow(VecDeque<Instant>);

impl RateWindow {
    fn new() -> Self {
        Self(VecDeque::new())
    }
    fn allow(&mut self, now: Instant, maximum: usize) -> bool {
        while self.0.front().is_some_and(|time| now.duration_since(*time) >= WINDOW) {
            self.0.pop_front();
        }
        if self.0.len() >= maximum {
            return false;
        }
        self.0.push_back(now);
        true
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerState {
    name: String,
    color: String,
    position: [f64; 3],
    rotation: [f64; 4],
    #[serde(skip_serializing_if = "Option::is_none")]
    animation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    velocity: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_url: Option<String>,
}

/// What an Update may change. A peer's name comes from its ticket, so a `name` it sends is ignored.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PartialState {
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rotation: Option<[f64; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    animation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    velocity: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ClientMessage {
    Join {
        #[allow(dead_code)]
        room_id: String,
        color: String,
        #[serde(rename = "modelUrl")]
        model_url: Option<String>,
    },
    Update {
        state: PartialState,
    },
    Chat {
        text: String,
        range: Option<f64>,
        #[serde(rename = "ackId")]
        ack_id: Option<String>,
    },
    Ping {
        // Echoed untouched, so the sender's `Date.now()` comes back as the integer it sent.
        ts: Option<serde_json::Number>,
    },
    Leave,
}

fn coordinate(value: f64) -> bool {
    value.is_finite() && value.abs() <= MAX_COORDINATE
}

fn label(value: &str) -> bool {
    value.chars().count() <= MAX_LABEL
}

/// Models the platform serves; a peer's avatar never makes the others fetch a stranger's host.
fn model_url(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("https://").or_else(|| value.strip_prefix("http://")) else { return false };
    let path = rest.find('/').map(|at| &rest[at..]).unwrap_or("");
    value.len() <= MAX_MODEL_URL && !path.contains('?') && crate::homes::safe_asset_url(path) && path.ends_with(".glb")
}

impl PartialState {
    fn valid(&self) -> bool {
        self.position.is_none_or(|p| p.iter().all(|v| coordinate(*v)))
            && self.velocity.is_none_or(|v| v.iter().all(|x| coordinate(*x)))
            && self.rotation.is_none_or(|r| r.iter().all(|v| coordinate(*v)) && r.iter().any(|v| *v != 0.0))
            && self.color.as_deref().is_none_or(label)
            && self.animation.as_deref().is_none_or(label)
            && self.model_url.as_deref().is_none_or(model_url)
    }
}

struct Peer {
    tx: mpsc::Sender<Message>,
    name: String,
    state: Option<PlayerState>,
    acked: VecDeque<String>,
    messages: RateWindow,
    updates: RateWindow,
    chats: RateWindow,
    invalid: RateWindow,
}

#[derive(Default)]
struct Hub {
    rooms: HashMap<String, HashMap<String, Peer>>,
    connections: usize,
}

#[derive(Default)]
struct Inner {
    hub: Mutex<Hub>,
    used_tickets: Mutex<HashMap<String, u64>>,
}

#[derive(Clone, Default)]
pub struct Rooms {
    inner: Arc<Inner>,
}

enum Flow {
    Continue,
    Close(u16, &'static str),
}

/// A frame that is not a valid message: tolerated a few times a second, then the peer is dropped.
fn malformed(invalid: &mut RateWindow, now: Instant) -> Flow {
    if invalid.allow(now, INVALID_PER_SECOND) { Flow::Continue } else { Flow::Close(4400, "malformed messages") }
}

fn text(message: &Value) -> Message {
    Message::Text(message.to_string().into())
}

fn broadcast(room: &HashMap<String, Peer>, from: &str, message: &Value) {
    let frame = text(message);
    for (id, peer) in room {
        if id != from && peer.state.is_some() {
            let _ = peer.tx.try_send(frame.clone());
        }
    }
}

impl Rooms {
    fn hub(&self) -> MutexGuard<'_, Hub> {
        self.inner.hub.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn count(&self) -> usize {
        self.hub().connections
    }

    fn verify(&self, secret: &[u8], ticket: &str) -> Option<TicketClaims> {
        if ticket.len() > 2048 {
            return None;
        }
        let (body, signature) = ticket.split_once('.')?;
        let supplied = URL_SAFE_NO_PAD.decode(signature).ok()?;
        if !constant_time_eq(&supplied, &hmac_sha256(secret, body.as_bytes())) {
            return None;
        }
        let claims: TicketClaims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).ok()?).ok()?;
        let now = epoch_seconds();
        if claims.exp < now || claims.exp > now + TICKET_TTL_SECONDS + 5 {
            return None;
        }
        let receipt = hex::encode(Sha256::digest(ticket.as_bytes()));
        let mut used = self.inner.used_tickets.lock().unwrap_or_else(|error| error.into_inner());
        used.retain(|_, exp| *exp >= now);
        used.insert(receipt, claims.exp).is_none().then_some(claims)
    }

    fn register(&self, room: &str, name: String, tx: mpsc::Sender<Message>) -> ApiResult<Registration> {
        let mut hub = self.hub();
        if hub.connections >= SERVER_CAPACITY {
            return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "room", "실시간 서버가 가득 찼습니다."));
        }
        let peers = hub.rooms.entry(room.to_owned()).or_default();
        if peers.len() >= ROOM_CAPACITY {
            return Err(conflict("room", "이 섬에 사람이 가득 찼습니다."));
        }
        let id = Uuid::new_v4().to_string();
        peers.insert(
            id.clone(),
            Peer {
                tx,
                name,
                state: None,
                acked: VecDeque::new(),
                messages: RateWindow::new(),
                updates: RateWindow::new(),
                chats: RateWindow::new(),
                invalid: RateWindow::new(),
            },
        );
        hub.connections += 1;
        Ok(Registration { rooms: self.clone(), room: room.to_owned(), id })
    }

    fn remove(&self, room_key: &str, id: &str) {
        let mut hub = self.hub();
        let Some(room) = hub.rooms.get_mut(room_key) else { return };
        let Some(peer) = room.remove(id) else { return };
        if peer.state.is_some() {
            broadcast(room, id, &json!({"type": "PlayerLeft", "client_id": id}));
        }
        if room.is_empty() {
            hub.rooms.remove(room_key);
        }
        hub.connections -= 1;
    }

    fn receive(&self, room_key: &str, id: &str, raw: &str) -> Flow {
        let now = Instant::now();
        let mut hub = self.hub();
        let Some(room) = hub.rooms.get_mut(room_key) else { return Flow::Close(1011, "room closed") };
        let Some(peer) = room.get_mut(id) else { return Flow::Close(1011, "peer closed") };
        if !peer.messages.allow(now, MESSAGES_PER_SECOND) {
            return Flow::Close(4429, "too many messages");
        }
        let Ok(message) = serde_json::from_str::<ClientMessage>(raw) else { return malformed(&mut peer.invalid, now) };
        match message {
            ClientMessage::Ping { ts } => {
                let _ = peer.tx.try_send(text(&json!({"type": "Pong", "ts": ts})));
            }
            ClientMessage::Leave => return Flow::Close(1000, "left"),
            ClientMessage::Join { color, model_url: model, .. } => {
                if !label(&color) || model.as_deref().is_some_and(|url| !model_url(url)) {
                    return malformed(&mut peer.invalid, now);
                }
                let rejoin = peer.state.is_some();
                let previous = peer.state.take();
                let state = PlayerState {
                    name: peer.name.clone(),
                    color,
                    position: previous.as_ref().map_or([0.0; 3], |p| p.position),
                    rotation: previous.as_ref().map_or(REST_ROTATION, |p| p.rotation),
                    animation: None,
                    velocity: None,
                    model_url: model,
                };
                peer.state = Some(state.clone());
                let others: serde_json::Map<String, Value> = room
                    .iter()
                    .filter(|(other, peer)| *other != id && peer.state.is_some())
                    .map(|(other, peer)| (other.clone(), json!(peer.state)))
                    .collect();
                if let Some(peer) = room.get(id) {
                    let _ = peer.tx.try_send(text(&json!({"type": "Welcome", "client_id": id, "room_state": others})));
                }
                if !rejoin {
                    broadcast(room, id, &json!({"type": "PlayerJoined", "client_id": id, "state": state}));
                }
            }
            ClientMessage::Update { state: changes } => {
                let Some(state) = peer.state.as_mut() else { return Flow::Continue };
                if !changes.valid() {
                    return malformed(&mut peer.invalid, now);
                }
                if !peer.updates.allow(now, UPDATES_PER_SECOND) {
                    return Flow::Continue;
                }
                if let Some(value) = changes.color.clone() {
                    state.color = value;
                }
                if let Some(value) = changes.position {
                    state.position = value;
                }
                if let Some(value) = changes.rotation {
                    state.rotation = value;
                }
                if let Some(value) = changes.animation.clone() {
                    state.animation = Some(value);
                }
                if let Some(value) = changes.velocity {
                    state.velocity = Some(value);
                }
                if let Some(value) = changes.model_url.clone() {
                    state.model_url = Some(value);
                }
                broadcast(room, id, &json!({"type": "PlayerUpdate", "client_id": id, "state": changes}));
            }
            ClientMessage::Chat { text: said, range, ack_id } => {
                let Some(state) = peer.state.as_ref() else { return Flow::Continue };
                // A resend of a chat already delivered only needs its Ack again.
                if let Some(ack) = ack_id.as_deref().filter(|ack| peer.acked.iter().any(|seen| seen == ack)) {
                    let _ = peer.tx.try_send(text(&json!({"type": "Ack", "ackId": ack})));
                    return Flow::Continue;
                }
                let said = said.trim();
                if said.is_empty()
                    || said.chars().count() > MAX_CHAT_CHARS
                    || ack_id.as_deref().is_some_and(|a| !label(a))
                {
                    return malformed(&mut peer.invalid, now);
                }
                if !peer.chats.allow(now, CHATS_PER_SECOND) {
                    return Flow::Continue;
                }
                let origin = state.position;
                let reach =
                    range.filter(|r| r.is_finite() && *r > 0.0).unwrap_or(DEFAULT_CHAT_RANGE).min(MAX_CHAT_RANGE);
                if let Some(ack) = ack_id {
                    let _ = peer.tx.try_send(text(&json!({"type": "Ack", "ackId": ack})));
                    peer.acked.push_back(ack);
                    if peer.acked.len() > ACK_MEMORY {
                        peer.acked.pop_front();
                    }
                }
                let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                let frame = text(&json!({"type": "Chat", "client_id": id, "text": said, "timestamp": timestamp}));
                for (other, listener) in room.iter() {
                    let near = listener.state.as_ref().is_some_and(|s| {
                        let [x, y, z] = s.position;
                        ((x - origin[0]).powi(2) + (y - origin[1]).powi(2) + (z - origin[2]).powi(2)).sqrt() <= reach
                    });
                    if other != id && near {
                        let _ = listener.tx.try_send(frame.clone());
                    }
                }
            }
        }
        Flow::Continue
    }
}

/// Holds a peer's place in its room; the socket task owns it, so the place never outlives the socket.
struct Registration {
    rooms: Rooms,
    room: String,
    id: String,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.rooms.remove(&self.room, &self.id);
    }
}

pub fn router(state: AppState) -> Router {
    Router::new().route("/api/rooms/{username}", get(upgrade)).with_state(state)
}

#[derive(Deserialize)]
struct TicketQuery {
    ticket: String,
}

const BAD_TICKET: ApiError =
    ApiError::new(StatusCode::UNAUTHORIZED, "ticket", "실시간 인증 티켓이 올바르지 않거나 만료되었습니다.");

async fn upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<TicketQuery>,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    if !same_origin(&state, &headers) {
        return Err(FOREIGN_ORIGIN);
    }
    let claims = state.rooms.verify(&state.config.ticket_secret, &query.ticket).ok_or(BAD_TICKET)?;
    let visitor = User { id: claims.sub, username: claims.username, display_name: claims.name, role: "user".into() };
    let (home, _) = visible_home(&state, &name, Some(&visitor)).await?;
    let (tx, rx) = mpsc::channel(OUTBOUND_CAPACITY);
    let display = if visitor.display_name.is_empty() { visitor.username } else { visitor.display_name };
    let registration = state.rooms.register(&home.username, display, tx)?;
    Ok(ws
        .max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| connection(socket, registration, rx)))
}

async fn send(socket: &mut WebSocket, message: Message) -> bool {
    matches!(tokio::time::timeout(SEND_TIMEOUT, socket.send(message)).await, Ok(Ok(())))
}

async fn connection(mut socket: WebSocket, registration: Registration, mut outbound: mpsc::Receiver<Message>) {
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_seen = Instant::now();
    let closing = loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(raw))) => {
                    last_seen = Instant::now();
                    if let Flow::Close(code, reason) = registration.rooms.receive(&registration.room, &registration.id, raw.as_str()) {
                        break Some((code, reason));
                    }
                }
                Some(Ok(Message::Binary(_))) => break Some((1003, "text frames only")),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => last_seen = Instant::now(),
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break None,
            },
            outgoing = outbound.recv() => match outgoing {
                Some(message) => if !send(&mut socket, message).await { break None; },
                None => break None,
            },
            _ = heartbeat.tick() => {
                if last_seen.elapsed() >= HEARTBEAT_TIMEOUT { break Some((4000, "heartbeat timeout")); }
                if !send(&mut socket, Message::Ping(Vec::new().into())).await { break None; }
            }
        }
    };
    if let Some((code, reason)) = closing {
        let _ = send(&mut socket, Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await;
    }
    drop(registration);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user() -> User {
        User { id: Uuid::new_v4(), username: "mogae".into(), display_name: "모개".into(), role: "user".into() }
    }

    #[test]
    fn tickets_verify_once_and_only_with_their_secret() {
        let rooms = Rooms::default();
        let secret = b"a-realtime-ticket-secret-of-32-bytes!";
        let (ticket, _) = issue_ticket(secret, &user());
        assert!(rooms.verify(b"another-secret-of-at-least-32-bytes!!", &ticket).is_none());
        assert_eq!(rooms.verify(secret, &ticket).map(|claims| claims.name), Some("모개".into()));
        assert!(rooms.verify(secret, &ticket).is_none());
    }

    #[test]
    fn peer_model_urls_stay_on_platform_paths() {
        assert!(model_url("https://mogaesup.com/gltf/man.glb"));
        assert!(model_url(&format!("http://127.0.0.1:5180/models/{}.glb", "b".repeat(64))));
        assert!(!model_url("https://evil.example/x.glb?gltf/"));
        assert!(!model_url("/gltf/man.glb"));
        assert!(!model_url("https://mogaesup.com/api/homes/x.glb"));
    }
}
