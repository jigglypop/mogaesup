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
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Notify, mpsc, watch};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{self, User},
    error::{ApiError, ApiResult, conflict},
    homes::visible_home,
    security::{FOREIGN_ORIGIN, client_address, constant_time_eq, epoch_seconds, hmac_sha256, same_origin},
};

const TICKET_TTL_SECONDS: u64 = 60;
const MAX_MESSAGE_BYTES: usize = 16 * 1024;
/// Frames waiting for one peer. Movement does not pile up (see [`Outbox`]), so only a socket that has stopped reading
/// fills this.
const OUTBOUND_CAPACITY: usize = 256;
const ROOM_CAPACITY: usize = 30;
/// Seats of a room kept for the owner's 일촌: anyone else takes one of the rest. The owner always gets in.
const ILCHON_SEATS: usize = 6;
const SERVER_CAPACITY: usize = 512;
/// Sockets one account may have open at once: a tab keeps one, and a ticket opens exactly one.
const ACCOUNT_CAPACITY: usize = 4;
/// Sockets one account may hold on one island, its owner aside: two tabs of it, or a tab whose dropped socket the
/// server has not noticed yet when it connects again.
pub(crate) const ACCOUNT_ISLAND_CAPACITY: usize = 3;
/// Sockets from one address (an IPv6 /64) on one island, its owner aside: a school or a carrier shares one address.
const ADDRESS_ISLAND_CAPACITY: usize = 10;
/// How long a socket may stay open before it joins its room.
const JOIN_DEADLINE: Duration = Duration::from_secs(10);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(45);
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
/// Queued frames written to a peer before one flush.
const SEND_BATCH: usize = 64;
/// How long a socket we closed is kept for the peer's answer.
const CLOSE_GRACE: Duration = Duration::from_secs(2);
const WINDOW: Duration = Duration::from_secs(1);
/// All frames, counted over three seconds: a phone whose link stalls delivers seconds of 20 Hz updates at once, and
/// that burst must not close its socket. Sustained floods still do.
pub(crate) const MESSAGE_WINDOW: Duration = Duration::from_secs(3);
const MESSAGES_PER_WINDOW: usize = 180;
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
pub(crate) struct TicketClaims {
    pub(crate) sub: Uuid,
    /// The login session (its token's hash) the ticket was issued in.
    pub(crate) session: String,
    pub(crate) username: String,
    pub(crate) name: String,
    exp: u64,
    nonce: String,
}

/// A single-use, one-minute ticket: a browser cannot put a cookie or header on a WebSocket, so it carries this instead.
pub fn issue_ticket(secret: &[u8], user: &User, session: &str) -> (String, u64) {
    let exp = epoch_seconds() + TICKET_TTL_SECONDS;
    let mut nonce = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let claims = TicketClaims {
        sub: user.id,
        session: session.to_owned(),
        username: user.username.clone(),
        name: user.display_name.clone(),
        exp,
        nonce: hex::encode(nonce),
    };
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap_or_default());
    let signature = URL_SAFE_NO_PAD.encode(hmac_sha256(secret, body.as_bytes()));
    (format!("{body}.{signature}"), exp)
}

/// Events allowed per sliding window (one second unless made `over` another).
pub(crate) struct RateWindow(VecDeque<Instant>, Duration);

impl RateWindow {
    pub(crate) fn new() -> Self {
        Self(VecDeque::new(), WINDOW)
    }
    pub(crate) fn over(window: Duration) -> Self {
        Self(VecDeque::new(), window)
    }
    pub(crate) fn allow(&mut self, now: Instant, maximum: usize) -> bool {
        while self.0.front().is_some_and(|time| now.duration_since(*time) >= self.1) {
            self.0.pop_front();
        }
        if self.0.len() >= maximum {
            return false;
        }
        self.0.push_back(now);
        true
    }
}

/// Who asks for a seat on an island, as its seats see them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Standing {
    Owner,
    Ilchon,
    Visitor,
}

impl Standing {
    pub(crate) fn owner(self) -> bool {
        self == Self::Owner
    }
}

/// How `viewer` stands with the island of `owner`: theirs, a 일촌's, or anyone's.
pub(crate) async fn standing(state: &AppState, owner: Uuid, viewer: Uuid) -> ApiResult<Standing> {
    if owner == viewer {
        return Ok(Standing::Owner);
    }
    let ilchon: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM ilchons WHERE user_id = $1 AND friend_id = $2)")
            .bind(owner)
            .bind(viewer)
            .fetch_one(&state.db)
            .await?;
    Ok(if ilchon { Standing::Ilchon } else { Standing::Visitor })
}

/// Whether one more socket of `account` from `address` may sit on an island whose sockets are `seated` (each one's
/// account, address and whether it is the owner's), `capacity` seats besides the owner's. The owner always may (their
/// account's cap aside); a 일촌 takes any free seat; anyone else leaves [`ILCHON_SEATS`] free. One account holds at
/// most [`ACCOUNT_ISLAND_CAPACITY`] and one address [`ADDRESS_ISLAND_CAPACITY`] of them, so a few free accounts cannot
/// fill a public island.
pub(crate) fn seat<'a>(
    standing: Standing,
    account: Uuid,
    address: &str,
    seated: impl Iterator<Item = (Uuid, &'a str, bool)>,
    capacity: usize,
    code: &'static str,
) -> ApiResult<()> {
    if standing.owner() {
        return Ok(());
    }
    let (mut others, mut mine, mut near) = (0, 0, 0);
    for (holder, from, _) in seated.filter(|(_, _, owner)| !owner) {
        others += 1;
        mine += usize::from(holder == account);
        near += usize::from(from == address);
    }
    if mine >= ACCOUNT_ISLAND_CAPACITY {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            code,
            "이 섬에 이 계정으로 열어 둔 연결이 너무 많습니다. 다른 탭을 닫고 다시 시도해 주세요.",
        ));
    }
    if near >= ADDRESS_ISLAND_CAPACITY {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            code,
            "같은 곳에서 이 섬에 들어온 연결이 너무 많습니다.",
        ));
    }
    let seats = if standing == Standing::Ilchon { capacity } else { capacity.saturating_sub(ILCHON_SEATS) };
    if others >= seats {
        return Err(conflict(code, "이 섬에 사람이 가득 찼습니다."));
    }
    Ok(())
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
    /// When the sender sampled this update, in milliseconds on its own clock. Relayed untouched, so receivers draw
    /// a peer on the sender's timeline instead of on arrival times that network jitter bunches up.
    #[serde(skip_serializing_if = "Option::is_none")]
    t: Option<f64>,
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

/// Wire quaternions are w/x/y/z. Scale first so even a tiny valid quaternion does not underflow.
fn normalize_rotation(rotation: [f64; 4]) -> [f64; 4] {
    let maximum = rotation.iter().map(|value| value.abs()).fold(0.0, f64::max);
    let scaled = rotation.map(|value| value / maximum);
    let length = scaled.iter().map(|value| value * value).sum::<f64>().sqrt();
    scaled.map(|value| value / length)
}

fn label(value: &str) -> bool {
    value.chars().count() <= MAX_LABEL
}

/// A model the site serves, on one of its own origins (`APP_ORIGIN`): a peer's avatar never makes the others fetch a
/// stranger's host. The URL must be written exactly as its origin and path (no credentials, query or fragment).
fn model_url(value: &str, origins: &[String]) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else { return false };
    let origin = url.origin();
    value.len() <= MAX_MODEL_URL
        && value.strip_prefix(&origin.ascii_serialization()) == Some(url.path())
        && origins.iter().any(|own| reqwest::Url::parse(own).is_ok_and(|own| own.origin() == origin))
        && url.path().ends_with(".glb")
        && crate::homes::safe_asset_url(url.path())
}

/// The colour the engine sends (`#rrggbb`): other visitors' pages write it into CSS, so nothing but hex digits passes.
fn hex_color(value: &str) -> bool {
    value.strip_prefix('#').is_some_and(|digits| {
        matches!(digits.len(), 3 | 4 | 6 | 8) && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

impl PartialState {
    fn valid(&self, origins: &[String]) -> bool {
        self.position.is_none_or(|p| p.iter().all(|v| coordinate(*v)))
            && self.velocity.is_none_or(|v| v.iter().all(|x| coordinate(*x)))
            && self.rotation.is_none_or(|r| r.iter().all(|v| coordinate(*v)) && r.iter().any(|v| *v != 0.0))
            && self.color.as_deref().is_none_or(hex_color)
            && self.animation.as_deref().is_none_or(label)
            && self.model_url.as_deref().is_none_or(|url| model_url(url, origins))
            && self.t.is_none_or(|t| t.is_finite() && (0.0..1e13).contains(&t))
    }
}

impl ClientMessage {
    /// Whether what the message carries may be taken, checked before the hub is locked (a model URL is parsed against
    /// each of the site's origins). Whether a message that may not counts as malformed is for [`Rooms::receive`] to say:
    /// an Update before a Join is ignored.
    fn valid(&self, origins: &[String]) -> bool {
        match self {
            Self::Join { color, model_url: model, .. } => {
                hex_color(color) && model.as_deref().is_none_or(|url| model_url(url, origins))
            }
            Self::Update { state } => state.valid(origins),
            Self::Chat { text, ack_id, .. } => {
                let said = text.trim();
                !said.is_empty() && said.chars().count() <= MAX_CHAT_CHARS && ack_id.as_deref().is_none_or(label)
            }
            Self::Ping { .. } | Self::Leave => true,
        }
    }
}

/// A frame waiting in an [`Outbox`].
enum Out {
    Frame(Message),
    /// A PlayerUpdate from `from`: the frame as it was broadcast, or None once a later one was merged into `state`
    /// (it is then written out from `state`).
    Update {
        from: Arc<str>,
        state: Arc<Map<String, Value>>,
        frame: Option<Message>,
    },
}

/// What waits to go out to one peer, in order. Movement is merged: a peer that falls behind gets each other peer's
/// latest state once instead of every update it missed, so a phone whose link stalls for a moment catches up instead
/// of being dropped. Only frames that cannot be merged (joins, leaves, chat) fill it.
pub(crate) struct Outbox {
    queue: Mutex<VecDeque<Out>>,
    ready: Notify,
}

impl Outbox {
    fn new() -> Arc<Self> {
        Arc::new(Self { queue: Mutex::new(VecDeque::new()), ready: Notify::new() })
    }

    fn queue(&self) -> MutexGuard<'_, VecDeque<Out>> {
        self.queue.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Queues `frame`; false when [`OUTBOUND_CAPACITY`] frames already wait.
    fn push(&self, frame: Message) -> bool {
        let mut queue = self.queue();
        if queue.len() >= OUTBOUND_CAPACITY {
            return false;
        }
        queue.push_back(Out::Frame(frame));
        drop(queue);
        self.ready.notify_one();
        true
    }

    /// Queues `from`'s update (`frame`, which carries `state`), or merges it into one of theirs still waiting: what it
    /// sets replaces what that one set. False when the update cannot wait.
    fn update(&self, from: &Arc<str>, state: &Arc<Map<String, Value>>, frame: &Message) -> bool {
        let mut queue = self.queue();
        let waiting = queue.iter_mut().rev().find_map(|out| match out {
            Out::Update { from: sender, state, frame } if sender == from => Some((state, frame)),
            _ => None,
        });
        if let Some((waiting, written)) = waiting {
            let merged = Arc::make_mut(waiting);
            for (key, value) in state.iter() {
                merged.insert(key.clone(), value.clone());
            }
            *written = None;
            // Already queued, so its wake-up is already on its way.
            return true;
        }
        if queue.len() >= OUTBOUND_CAPACITY {
            return false;
        }
        queue.push_back(Out::Update { from: from.clone(), state: state.clone(), frame: Some(frame.clone()) });
        drop(queue);
        self.ready.notify_one();
        true
    }

    /// The next `max` frames at most, in order.
    fn take(&self, max: usize) -> Vec<Message> {
        let taken: Vec<Out> = {
            let mut queue = self.queue();
            let count = queue.len().min(max);
            queue.drain(..count).collect()
        };
        taken
            .into_iter()
            .map(|out| match out {
                Out::Frame(frame) | Out::Update { frame: Some(frame), .. } => frame,
                Out::Update { from, state, frame: None } => {
                    text(&json!({"type": "PlayerUpdate", "client_id": &*from, "state": &*state}))
                }
            })
            .collect()
    }

    fn waiting(&self) -> bool {
        !self.queue().is_empty()
    }
}

struct Peer {
    outbox: Arc<Outbox>,
    close: watch::Sender<Option<(u16, &'static str)>>,
    session: String,
    user: User,
    name: String,
    /// The island's owner: always let in, and never counted against anyone else's seats.
    owner: bool,
    /// Where the socket came from ([`client_address`]).
    address: String,
    state: Option<PlayerState>,
    /// Whether the others know this peer: a Join carries no position, so the peer is announced with its first
    /// positioned Update instead of at the island's origin, where it would appear and then slide to the spawn.
    placed: bool,
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
    /// Open sockets per account.
    accounts: HashMap<Uuid, usize>,
}

/// One access check shared by every socket of a login session on one island (its room's and its game's).
struct Watch {
    /// Tells this watch from a later one under the same key.
    id: u64,
    sockets: usize,
    /// Asks for a check now: a socket that joins the watch is checked at once, as its own first check used to be.
    again: Arc<Notify>,
    _task: AbortOnDrop,
}

#[derive(Default)]
struct Inner {
    hub: Mutex<Hub>,
    used_tickets: Mutex<HashMap<String, u64>>,
    /// By login session and island.
    watches: Mutex<HashMap<(String, String), Watch>>,
    watch_ids: AtomicU64,
}

#[derive(Clone, Default)]
pub struct Rooms {
    inner: Arc<Inner>,
}

/// Someone with a socket in a room, as other parts of the server see them (see [`Rooms::peers`]).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RoomPeer {
    /// The peer's `client_id` in the room's messages.
    pub(crate) id: String,
    pub(crate) user: Uuid,
    /// Where it stands, once it has said so: None before its first positioned Update.
    pub(crate) position: Option<[f64; 3]>,
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

/// Sends to everyone else in the room who has joined. A peer whose queue is full has stopped reading; dropping its
/// messages would leave it with stale players (a missed PlayerLeft is a ghost), so it is closed and reconnects with a
/// fresh Welcome instead.
fn broadcast(room: &HashMap<String, Peer>, from: &str, message: &Value) {
    let frame = text(message);
    for (id, peer) in room {
        if id != from && peer.state.is_some() && !peer.outbox.push(frame.clone()) {
            peer.close.send_replace(Some((4408, "too slow")));
        }
    }
}

/// Sends `from`'s new state (what changed) to everyone else in the room who has joined, merged into an update of
/// theirs that a peer has not been sent yet (see [`Outbox`]).
fn broadcast_update(room: &HashMap<String, Peer>, from: &str, state: Value) {
    let Value::Object(state) = state else { return };
    let state = Arc::new(state);
    let sender: Arc<str> = Arc::from(from);
    let frame = text(&json!({"type": "PlayerUpdate", "client_id": from, "state": &*state}));
    for (id, peer) in room {
        if id != from && peer.state.is_some() && !peer.outbox.update(&sender, &state, &frame) {
            peer.close.send_replace(Some((4408, "too slow")));
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

    /// The claims of a realtime ticket signed with `secret`, the first time it is shown and only within its minute.
    pub(crate) fn verify(&self, secret: &[u8], ticket: &str) -> Option<TicketClaims> {
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

    fn register(
        &self,
        room: &str,
        user: User,
        name: String,
        session: String,
        standing: Standing,
        address: String,
    ) -> ApiResult<Registration> {
        let mut hub = self.hub();
        if hub.connections >= SERVER_CAPACITY {
            return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "room", "실시간 서버가 가득 찼습니다."));
        }
        if hub.accounts.get(&user.id).is_some_and(|open| *open >= ACCOUNT_CAPACITY) {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "room",
                "이 계정으로 열어 둔 실시간 연결이 너무 많습니다. 다른 탭을 닫고 다시 시도해 주세요.",
            ));
        }
        let peers = hub.rooms.entry(room.to_owned()).or_default();
        let seated = peers.values().map(|peer| (peer.user.id, peer.address.as_str(), peer.owner));
        if let Err(refused) = seat(standing, user.id, &address, seated, ROOM_CAPACITY, "room") {
            if peers.is_empty() {
                hub.rooms.remove(room);
            }
            return Err(refused);
        }
        let id = Uuid::new_v4().to_string();
        let viewer = user.clone();
        let (close, cancelled) = watch::channel(None);
        let outbox = Outbox::new();
        peers.insert(
            id.clone(),
            Peer {
                outbox: outbox.clone(),
                close,
                session: session.clone(),
                user,
                name,
                owner: standing.owner(),
                address,
                state: None,
                placed: false,
                acked: VecDeque::new(),
                messages: RateWindow::over(MESSAGE_WINDOW),
                updates: RateWindow::new(),
                chats: RateWindow::new(),
                invalid: RateWindow::new(),
            },
        );
        hub.connections += 1;
        *hub.accounts.entry(viewer.id).or_default() += 1;
        Ok(Registration { rooms: self.clone(), room: room.to_owned(), id, viewer, session, outbox, cancelled })
    }

    fn remove(&self, room_key: &str, id: &str) {
        let mut hub = self.hub();
        let Some(room) = hub.rooms.get_mut(room_key) else { return };
        let Some(peer) = room.remove(id) else { return };
        if peer.placed {
            broadcast(room, id, &json!({"type": "PlayerLeft", "client_id": id}));
        }
        if room.is_empty() {
            hub.rooms.remove(room_key);
        }
        hub.connections -= 1;
        if let Some(open) = hub.accounts.get_mut(&peer.user.id) {
            *open -= 1;
            if *open == 0 {
                hub.accounts.remove(&peer.user.id);
            }
        }
    }

    /// Everyone with a socket in `room` now: client id, account and position. One account may hold several peers (tabs).
    pub(crate) fn peers(&self, room: &str) -> Vec<RoomPeer> {
        let hub = self.hub();
        hub.rooms
            .get(room)
            .into_iter()
            .flatten()
            .map(|(id, peer)| RoomPeer {
                id: id.clone(),
                user: peer.user.id,
                position: peer.state.as_ref().filter(|_| peer.placed).map(|state| state.position),
            })
            .collect()
    }

    /// Everyone with a socket in `room`: each peer's id and who it is.
    fn occupants(&self, room: &str) -> Vec<(String, User)> {
        let hub = self.hub();
        hub.rooms.get(room).into_iter().flatten().map(|(id, peer)| (id.clone(), peer.user.clone())).collect()
    }

    /// Whether peer `id` of `room` has joined it.
    fn joined(&self, room: &str, id: &str) -> bool {
        self.hub().rooms.get(room).and_then(|room| room.get(id)).is_some_and(|peer| peer.state.is_some())
    }

    /// Closes one peer's socket, which takes it out of its room.
    fn evict(&self, room: &str, id: &str) {
        self.close_peer(room, id, 4403, "no access");
    }

    fn close_peer(&self, room: &str, id: &str, code: u16, reason: &'static str) {
        if let Some(peer) = self.hub().rooms.get(room).and_then(|room| room.get(id)) {
            // This signal is independent of the bounded outbound queue, so a full queue cannot delay revocation.
            peer.close.send_replace(Some((code, reason)));
        }
        self.remove(room, id);
    }

    /// Closes the peers of login session `session` in `room` (all rooms when None).
    fn close_session(&self, room: Option<&str>, session: &str, code: u16, reason: &'static str) {
        let peers: Vec<(String, String)> = self
            .hub()
            .rooms
            .iter()
            .filter(|(key, _)| room.is_none_or(|room| room == key.as_str()))
            .flat_map(|(key, peers)| {
                peers.iter().filter(|(_, peer)| peer.session == session).map(|(id, _)| (key.clone(), id.clone()))
            })
            .collect();
        for (room, id) in peers {
            self.close_peer(&room, &id, code, reason);
        }
    }

    pub fn end_session(&self, session: &str) {
        self.close_session(None, session, 4401, "session ended");
    }

    /// Holds a place in the access check of `viewer`'s login session `session` on `island`, starting it for the first
    /// socket and checking at once for each later one (see [`watch_access`]). The check stops with the last place.
    pub(crate) fn watch(&self, state: &AppState, island: &str, session: &str, viewer: &User) -> WatchPlace {
        let key = (session.to_owned(), island.to_owned());
        let mut watches = self.inner.watches.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(watch) = watches.get_mut(&key) {
            watch.sockets += 1;
            watch.again.notify_one();
            return WatchPlace { rooms: self.clone(), key, id: watch.id };
        }
        let id = self.inner.watch_ids.fetch_add(1, Ordering::Relaxed);
        let again = Arc::new(Notify::new());
        let task = tokio::spawn(watch_access(
            state.clone(),
            island.to_owned(),
            session.to_owned(),
            viewer.clone(),
            again.clone(),
            id,
        ));
        watches.insert(key.clone(), Watch { id, sockets: 1, again, _task: AbortOnDrop(task) });
        WatchPlace { rooms: self.clone(), key, id }
    }

    /// Forgets watch `id` of `key` once it has ended: a socket that comes later starts a check of its own.
    fn forget_watch(&self, key: &(String, String), id: u64) {
        let ended = {
            let mut watches = self.inner.watches.lock().unwrap_or_else(|error| error.into_inner());
            if watches.get(key).is_some_and(|watch| watch.id == id) { watches.remove(key) } else { None }
        };
        // Its task is the caller, which awaits nothing more: stopping it changes nothing.
        drop(ended);
    }

    /// Access checks running now: one per login session and island with sockets (see [`Rooms::watch`]).
    pub fn access_checks(&self) -> usize {
        self.inner.watches.lock().unwrap_or_else(|error| error.into_inner()).len()
    }

    fn receive(&self, room_key: &str, id: &str, raw: &str, origins: &[String]) -> Flow {
        // Read and checked before the hub is locked: every room's frames wait on that lock.
        let message = serde_json::from_str::<ClientMessage>(raw).ok().map(|message| {
            let valid = message.valid(origins);
            (message, valid)
        });
        let now = Instant::now();
        let mut hub = self.hub();
        let Some(room) = hub.rooms.get_mut(room_key) else { return Flow::Close(1011, "room closed") };
        let Some(peer) = room.get_mut(id) else { return Flow::Close(1011, "peer closed") };
        if !peer.messages.allow(now, MESSAGES_PER_WINDOW) {
            return Flow::Close(4429, "too many messages");
        }
        let Some((message, valid)) = message else { return malformed(&mut peer.invalid, now) };
        match message {
            ClientMessage::Ping { ts } => {
                peer.outbox.push(text(&json!({"type": "Pong", "ts": ts})));
            }
            ClientMessage::Leave => return Flow::Close(1000, "left"),
            ClientMessage::Join { color, model_url: model, .. } => {
                if !valid {
                    return malformed(&mut peer.invalid, now);
                }
                let rejoin = peer.placed;
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
                    .filter(|(other, peer)| *other != id && peer.placed)
                    .map(|(other, peer)| (other.clone(), json!(peer.state)))
                    .collect();
                if let Some(peer) = room.get(id) {
                    peer.outbox.push(text(&json!({"type": "Welcome", "client_id": id, "room_state": others})));
                }
                // A rejoin keeps its place; a new peer is announced with its first position (see `placed`).
                if rejoin {
                    broadcast_update(room, id, json!(state));
                }
            }
            ClientMessage::Update { state: mut changes } => {
                let Some(state) = peer.state.as_mut() else { return Flow::Continue };
                if !valid {
                    return malformed(&mut peer.invalid, now);
                }
                if !peer.updates.allow(now, UPDATES_PER_SECOND) {
                    return Flow::Continue;
                }
                changes.rotation = changes.rotation.map(normalize_rotation);
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
                if peer.placed {
                    broadcast_update(room, id, json!(changes));
                } else if changes.position.is_some() {
                    peer.placed = true;
                    let mut joined = json!(state);
                    if let Some(t) = changes.t {
                        joined["t"] = json!(t);
                    }
                    broadcast(room, id, &json!({"type": "PlayerJoined", "client_id": id, "state": joined}));
                }
            }
            ClientMessage::Chat { text: said, range, ack_id } => {
                let Some(state) = peer.state.as_ref().filter(|_| peer.placed) else { return Flow::Continue };
                // A resend of a chat already delivered only needs its Ack again.
                if let Some(ack) = ack_id.as_deref().filter(|ack| peer.acked.iter().any(|seen| seen == ack)) {
                    peer.outbox.push(text(&json!({"type": "Ack", "ackId": ack})));
                    return Flow::Continue;
                }
                if !valid {
                    return malformed(&mut peer.invalid, now);
                }
                let said = said.trim();
                if !peer.chats.allow(now, CHATS_PER_SECOND) {
                    return Flow::Continue;
                }
                let origin = state.position;
                let reach =
                    range.filter(|r| r.is_finite() && *r > 0.0).unwrap_or(DEFAULT_CHAT_RANGE).min(MAX_CHAT_RANGE);
                if let Some(ack) = ack_id {
                    peer.outbox.push(text(&json!({"type": "Ack", "ackId": ack})));
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
                        listener.outbox.push(frame.clone());
                    }
                }
            }
        }
        Flow::Continue
    }
}

/// Stops a spawned task when its owner goes, however the owner ends.
pub(crate) struct AbortOnDrop(pub(crate) tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// A socket's place in the shared access check of its login session on its island ([`Rooms::watch`]).
pub(crate) struct WatchPlace {
    rooms: Rooms,
    key: (String, String),
    id: u64,
}

impl Drop for WatchPlace {
    fn drop(&mut self) {
        let mut watches = self.rooms.inner.watches.lock().unwrap_or_else(|error| error.into_inner());
        let Some(watch) = watches.get_mut(&self.key).filter(|watch| watch.id == self.id) else { return };
        watch.sockets -= 1;
        if watch.sockets == 0 {
            let ended = watches.remove(&self.key);
            drop(watches);
            // Stops the check, outside the lock.
            drop(ended);
        }
    }
}

/// Holds a peer's place in its room; the socket task owns it, so the place never outlives the socket.
struct Registration {
    rooms: Rooms,
    room: String,
    id: String,
    viewer: User,
    session: String,
    outbox: Arc<Outbox>,
    cancelled: watch::Receiver<Option<(u16, &'static str)>>,
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

pub(crate) const BAD_TICKET: ApiError =
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
    if !auth::active_session(&state, &claims.session, claims.sub).await? {
        return Err(BAD_TICKET);
    }
    let visitor = User { id: claims.sub, username: claims.username, display_name: claims.name, role: "user".into() };
    let (home, _) = visible_home(&state, &name, Some(&visitor)).await?;
    let standing = standing(&state, home.owner_id, visitor.id).await?;
    let display = if visitor.display_name.is_empty() { visitor.username.clone() } else { visitor.display_name.clone() };
    let registration =
        state.rooms.register(&home.username, visitor, display, claims.session, standing, client_address(&headers))?;
    Ok(ws
        .max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| connection(socket, registration, state)))
}

/// Group membership can grant access to many homes. Re-check every occupied room after any explicit revocation.
pub async fn revalidate_all(state: &AppState) {
    let mut owners: Vec<String> = state.rooms.hub().rooms.keys().cloned().collect();
    // An island's game sockets can outlast its room peers.
    for owner in state.games.islands() {
        if !owners.contains(&owner) {
            owners.push(owner);
        }
    }
    futures_util::stream::iter(owners)
        .for_each_concurrent(8, |owner| async move {
            revalidate(state, &owner).await;
        })
        .await;
}

/// Closes the sockets of whoever may no longer view `owner`'s island, after something narrowed who may: its visibility,
/// or a 일촌 taken away. Only a refusal drops a peer; a failed check leaves everyone in.
pub async fn revalidate(state: &AppState, owner: &str) {
    let mut checked: HashMap<Uuid, bool> = HashMap::new();
    for (id, user) in state.rooms.occupants(owner) {
        let stays = match checked.get(&user.id) {
            Some(stays) => *stays,
            None => {
                let seen = visible_home(state, owner, Some(&user)).await;
                let stays = !matches!(&seen, Err(error) if error.status == StatusCode::FORBIDDEN);
                checked.insert(user.id, stays);
                stays
            }
        };
        if !stays {
            state.rooms.evict(owner, &id);
        }
    }
    crate::games::revalidate(state, owner).await;
}

pub(crate) async fn send(socket: &mut WebSocket, message: Message) -> bool {
    matches!(tokio::time::timeout(SEND_TIMEOUT, socket.send(message)).await, Ok(Ok(())))
}

/// Writes `first` and the frames already queued behind it, [`SEND_BATCH`] at most in all, then flushes them at once,
/// within one [`SEND_TIMEOUT`]: a busy room's movement goes out in one write per wake instead of one per frame.
pub(crate) async fn send_queued(
    socket: &mut WebSocket,
    first: Message,
    outbound: &mut mpsc::Receiver<Message>,
) -> bool {
    let batch = async {
        socket.feed(first).await?;
        for _ in 1..SEND_BATCH {
            let Ok(message) = outbound.try_recv() else { break };
            socket.feed(message).await?;
        }
        socket.flush().await
    };
    matches!(tokio::time::timeout(SEND_TIMEOUT, batch).await, Ok(Ok(())))
}

/// Writes `frames` and flushes them at once, within one [`SEND_TIMEOUT`]: a socket that takes no more for that long is
/// stuck, and is dropped.
async fn send_all(socket: &mut WebSocket, frames: Vec<Message>) -> bool {
    let batch = async {
        for frame in frames {
            socket.feed(frame).await?;
        }
        socket.flush().await
    };
    matches!(tokio::time::timeout(SEND_TIMEOUT, batch).await, Ok(Ok(())))
}

/// The access check of `viewer`'s login session `session` on `island`, shared by its sockets there (room and game):
/// the session and the island's visibility, every [`HEARTBEAT_INTERVAL`] and whenever a socket joins. It runs on its
/// own task, so a slow database never stops a socket's relay (a stalled loop delivers its peers' movement in bursts).
/// Only a definite refusal closes the sockets; a failed check keeps them, as `revalidate` does.
async fn watch_access(state: AppState, island: String, session: String, viewer: User, again: Arc<Notify>, id: u64) {
    let mut every = tokio::time::interval(HEARTBEAT_INTERVAL);
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let refused = loop {
        // The first tick (and a joining socket's) also closes the handshake/logout race.
        tokio::select! {
            _ = every.tick() => {}
            _ = again.notified() => {}
        }
        if let Ok(false) = auth::active_session(&state, &session, viewer.id).await {
            break (4401, "session ended");
        }
        if let Err(error) = visible_home(&state, &island, Some(&viewer)).await
            && matches!(error.status, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND)
        {
            break (4403, "no access");
        }
    };
    // Forgotten first, so a socket that comes in while these close starts a check of its own.
    state.rooms.forget_watch(&(session.clone(), island.clone()), id);
    state.rooms.close_session(Some(&island), &session, refused.0, refused.1);
    state.games.close_session(Some(&island), &session, refused.0, refused.1);
}

async fn connection(mut socket: WebSocket, mut registration: Registration, state: AppState) {
    let _access = state.rooms.watch(&state, &registration.room, &registration.session, &registration.viewer);
    let outbox = registration.outbox.clone();
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let join_by = tokio::time::sleep(JOIN_DEADLINE);
    tokio::pin!(join_by);
    let mut join_checked = false;
    let mut last_seen = Instant::now();
    let closing = loop {
        if let Some(closing) = *registration.cancelled.borrow() {
            break Some(closing);
        }
        tokio::select! {
            _ = registration.cancelled.changed() => {
                let reason = *registration.cancelled.borrow();
                break reason.or(Some((4403, "no access")));
            }
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(raw))) => {
                    last_seen = Instant::now();
                    if let Flow::Close(code, reason) =
                        registration.rooms.receive(&registration.room, &registration.id, raw.as_str(), &state.config.origins)
                    {
                        break Some((code, reason));
                    }
                }
                Some(Ok(Message::Binary(_))) => break Some((1003, "text frames only")),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => last_seen = Instant::now(),
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break None,
            },
            _ = outbox.ready.notified() => {
                let frames = outbox.take(SEND_BATCH);
                if !frames.is_empty() && !send_all(&mut socket, frames).await {
                    break None;
                }
                if outbox.waiting() {
                    outbox.ready.notify_one();
                }
            }
            _ = &mut join_by, if !join_checked => {
                // A socket that never joins holds a seat nobody can see.
                if !registration.rooms.joined(&registration.room, &registration.id) {
                    break Some((4408, "no join"));
                }
                join_checked = true;
            }
            _ = heartbeat.tick() => {
                if last_seen.elapsed() >= HEARTBEAT_TIMEOUT { break Some((4000, "heartbeat timeout")); }
                if !send(&mut socket, Message::Ping(Vec::new().into())).await { break None; }
            }
        }
    };
    // Revocation can race an incoming frame after the peer was removed. Preserve its reason whichever select branch
    // completed first.
    let closing = (*registration.cancelled.borrow()).or(closing);
    // Whether a close frame has gone to the peer.
    let mut closed = false;
    if let Some((code, reason)) = closing {
        closed = send(&mut socket, Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await;
    }
    drop(registration);
    if closed {
        // Dropped at once, the socket would reset the connection when the peer answers (a pong, its own close), and the
        // peer could lose the close frame unread; so its answer is read first.
        let _ = tokio::time::timeout(CLOSE_GRACE, async { while let Some(Ok(_)) = socket.recv().await {} }).await;
    }
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
        let (ticket, _) = issue_ticket(secret, &user(), "test-session");
        assert!(rooms.verify(b"another-secret-of-at-least-32-bytes!!", &ticket).is_none());
        assert_eq!(rooms.verify(secret, &ticket).map(|claims| claims.name), Some("모개".into()));
        assert!(rooms.verify(secret, &ticket).is_none());
    }

    fn origins() -> Vec<String> {
        vec!["https://mogaesup.com".into(), "http://127.0.0.1:5180".into()]
    }

    #[test]
    fn peer_model_urls_stay_on_the_sites_own_origins_and_platform_paths() {
        let own = origins();
        assert!(model_url("https://mogaesup.com/gltf/man.glb", &own));
        assert!(model_url(&format!("http://127.0.0.1:5180/models/{}.glb", "b".repeat(64)), &own));
        assert!(!model_url("https://evil.example/x.glb?gltf/", &own));
        assert!(!model_url("/gltf/man.glb", &own));
        assert!(!model_url("https://mogaesup.com/api/homes/x.glb", &own));
        // Another host, whatever the path: the case a path check alone let through.
        assert!(!model_url("https://evil.example/gltf/x.glb", &own));
        assert!(!model_url("https://mogaesup.com.evil.example/gltf/x.glb", &own));
        assert!(!model_url("https://evil-mogaesup.com/gltf/x.glb", &own));
        assert!(!model_url("https://cdn.mogaesup.com/gltf/x.glb", &own));
        // The host is what comes after the credentials, whatever it starts with.
        assert!(!model_url("https://mogaesup.com@evil.example/gltf/x.glb", &own));
        assert!(!model_url("https://evil.example@mogaesup.com/gltf/x.glb", &own));
        assert!(!model_url("https://mogaesup.com:pass@mogaesup.com/gltf/x.glb", &own));
        // Scheme and port are part of the origin.
        assert!(!model_url("http://mogaesup.com/gltf/man.glb", &own));
        assert!(!model_url("https://mogaesup.com:8443/gltf/man.glb", &own));
        assert!(!model_url("https://127.0.0.1:5180/gltf/man.glb", &own));
        assert!(!model_url("http://127.0.0.1:5181/gltf/man.glb", &own));
        assert!(!model_url("ftp://mogaesup.com/gltf/man.glb", &own));
        // Only the written form of an origin and a path: no query, fragment, dot segments or other spellings.
        assert!(!model_url("https://mogaesup.com/gltf/man.glb#x", &own));
        assert!(!model_url("https://mogaesup.com/gltf/../api/x.glb", &own));
        assert!(!model_url("https://mogaesup.com/gltf/%2e%2e/api/x.glb", &own));
        assert!(!model_url("https://MOGAESUP.com/gltf/man.glb", &own));
        assert!(!model_url("https://mogaesup.com:443/gltf/man.glb", &own));
        assert!(!model_url(&format!("https://mogaesup.com/gltf/{}.glb", "a".repeat(MAX_MODEL_URL)), &own));
        assert!(!model_url("https://mogaesup.com/gltf/man.glb", &[]));
    }

    #[test]
    fn peer_colours_are_hex_and_nothing_a_stylesheet_could_fetch() {
        for color in ["#ff7a59", "#FF7A59", "#fff", "#0f08", "#8b6cf0cc", "#000000"] {
            assert!(hex_color(color), "{color}");
        }
        for color in [
            "",
            "#",
            "red",
            "ff7a59",
            "#ff7a5",
            "#ff7a59f",
            "#ff7a59fff",
            "#ggg",
            "#ff7a59 ",
            "#fff;x",
            "url(//evil.io/p)",
            "#fff,url(//evil.io/p)",
            "rgb(1,2,3)",
            "var(--x)",
            "expression(alert(1))",
            "\\#fff",
        ] {
            assert!(!hex_color(color), "{color:?}");
        }
        let changes = |color: &str| PartialState { color: Some(color.into()), ..Default::default() };
        assert!(changes("#2bb3a3").valid(&origins()));
        assert!(!changes("url(//evil.io/p)").valid(&origins()));
        let model = |url: &str| PartialState { model_url: Some(url.into()), ..Default::default() };
        assert!(model("https://mogaesup.com/gltf/man.glb").valid(&origins()));
        assert!(!model("https://evil.example/gltf/man.glb").valid(&origins()));
    }

    fn enter(user: &User, room: &str, rooms: &Rooms, standing: Standing, address: &str) -> ApiResult<Registration> {
        rooms.register(room, user.clone(), user.display_name.clone(), "test-session".into(), standing, address.into())
    }

    fn peer(user: &User, room: &str, rooms: &Rooms) -> ApiResult<Registration> {
        enter(user, room, rooms, Standing::Visitor, &user.id.to_string())
    }

    #[test]
    fn an_account_holds_a_few_sockets_and_frees_them_as_they_close() {
        let rooms = Rooms::default();
        let (me, other) = (user(), user());
        let mut held: Vec<Registration> =
            (0..ACCOUNT_CAPACITY).map(|at| peer(&me, &format!("room{}", at / 2), &rooms).unwrap()).collect();
        let refused = peer(&me, "room9", &rooms).err().unwrap();
        assert_eq!((refused.status, refused.code), (StatusCode::TOO_MANY_REQUESTS, "room"));
        // Another account is not held back, and a closed socket gives its place up.
        let _others = peer(&other, "room0", &rooms).unwrap();
        assert_eq!(rooms.count(), ACCOUNT_CAPACITY + 1);
        held.pop();
        assert!(peer(&me, "room9", &rooms).is_ok());
        drop(held);
        assert_eq!(rooms.count(), 1);
        assert_eq!(rooms.hub().accounts.len(), 1);
    }

    #[test]
    fn visitors_leave_seats_for_the_owner_and_their_ilchon_and_one_account_or_address_takes_only_a_few() {
        let rooms = Rooms::default();
        let island = "mogae";
        let visitors: Vec<Registration> = (0..ROOM_CAPACITY - ILCHON_SEATS)
            .map(|at| enter(&user(), island, &rooms, Standing::Visitor, &format!("10.0.0.{at}")).unwrap())
            .collect();
        let full = enter(&user(), island, &rooms, Standing::Visitor, "10.0.1.1").err().unwrap();
        assert_eq!((full.status, full.code), (StatusCode::CONFLICT, "room"));
        // The seats kept free take 일촌, and the owner always gets in, past them too.
        let friends: Vec<Registration> = (0..ILCHON_SEATS)
            .map(|at| enter(&user(), island, &rooms, Standing::Ilchon, &format!("10.0.2.{at}")).unwrap())
            .collect();
        assert!(enter(&user(), island, &rooms, Standing::Ilchon, "10.0.3.1").is_err());
        let owner = user();
        let _owner_tabs: Vec<Registration> =
            (0..2).map(|_| enter(&owner, island, &rooms, Standing::Owner, "10.0.0.1").unwrap()).collect();
        drop((visitors, friends));

        // One account holds two sockets on an island, and one address ten (the owner's own aside).
        let me = user();
        let _mine: Vec<Registration> =
            (0..ACCOUNT_ISLAND_CAPACITY).map(|_| enter(&me, island, &rooms, Standing::Visitor, "a").unwrap()).collect();
        let more = enter(&me, island, &rooms, Standing::Visitor, "b").err().unwrap();
        assert_eq!(more.status, StatusCode::TOO_MANY_REQUESTS);
        assert!(enter(&me, "elsewhere", &rooms, Standing::Visitor, "b").is_ok(), "another island is another count");
        let _school: Vec<Registration> = (ACCOUNT_ISLAND_CAPACITY..ADDRESS_ISLAND_CAPACITY)
            .map(|_| enter(&user(), island, &rooms, Standing::Visitor, "a").unwrap())
            .collect();
        let crowded = enter(&user(), island, &rooms, Standing::Ilchon, "a").err().unwrap();
        assert_eq!(crowded.status, StatusCode::TOO_MANY_REQUESTS);
        assert!(enter(&user(), island, &rooms, Standing::Visitor, "c").is_ok());
    }

    fn join(rooms: &Rooms, registration: &Registration, position: [f64; 3]) {
        let join = json!({"type": "Join", "room_id": "r", "color": "#ffffff"}).to_string();
        assert!(matches!(rooms.receive(&registration.room, &registration.id, &join, &origins()), Flow::Continue));
        let update = json!({"type": "Update", "state": {"position": position}}).to_string();
        assert!(matches!(rooms.receive(&registration.room, &registration.id, &update, &origins()), Flow::Continue));
    }

    fn frames(registration: &Registration) -> Vec<Value> {
        let taken = registration.outbox.take(usize::MAX);
        taken
            .into_iter()
            .map(|frame| match frame {
                Message::Text(raw) => serde_json::from_str(raw.as_str()).unwrap(),
                _ => Value::Null,
            })
            .collect()
    }

    #[test]
    fn a_peer_that_falls_behind_gets_the_latest_movement_once_and_only_a_stuck_one_is_closed() {
        let rooms = Rooms::default();
        let (slow, mover) = (user(), user());
        let slow = peer(&slow, "r", &rooms).unwrap();
        let mover = peer(&mover, "r", &rooms).unwrap();
        join(&rooms, &slow, [0.0; 3]);
        join(&rooms, &mover, [1.0, 0.0, 0.0]);
        frames(&slow);
        // Far more movement than the queue holds, all while the slow peer reads nothing: it is merged, not queued.
        for at in 0..2_000 {
            if let Some(peer) = rooms.hub().rooms.get_mut("r").and_then(|room| room.get_mut(&mover.id)) {
                // The updates arrive over a long stretch, within the per-second limits.
                peer.updates = RateWindow::new();
                peer.messages = RateWindow::over(MESSAGE_WINDOW);
            }
            let x = f64::from(at);
            let update = json!({"type": "Update", "state": {"position": [x, 0.0, 0.0], "t": x}}).to_string();
            assert!(matches!(rooms.receive("r", &mover.id, &update, &origins()), Flow::Continue));
        }
        let animated = json!({"type": "Update", "state": {"animation": "run"}}).to_string();
        rooms.receive("r", &mover.id, &animated, &origins());
        assert_eq!(*slow.cancelled.borrow(), None, "a peer behind on movement stays");
        let caught_up = frames(&slow);
        assert_eq!(caught_up.len(), 1, "{caught_up:?}");
        assert_eq!(caught_up[0]["type"], "PlayerUpdate");
        assert_eq!(caught_up[0]["client_id"], mover.id.as_str());
        assert_eq!(caught_up[0]["state"], json!({"position": [1999.0, 0.0, 0.0], "t": 1999.0, "animation": "run"}));
        // A peer that reads now gets each update as it was sent.
        let update = json!({"type": "Update", "state": {"position": [5.0, 0.0, 0.0]}}).to_string();
        if let Some(peer) = rooms.hub().rooms.get_mut("r").and_then(|room| room.get_mut(&mover.id)) {
            peer.updates = RateWindow::new();
        }
        rooms.receive("r", &mover.id, &update, &origins());
        assert_eq!(frames(&slow)[0]["state"], json!({"position": [5.0, 0.0, 0.0]}));

        // What cannot be merged still fills a socket that has stopped reading, and then it is closed.
        let mut joined = Vec::new();
        for _ in 0..OUTBOUND_CAPACITY + 1 {
            let other = user();
            let registration = enter(&other, "r", &rooms, Standing::Ilchon, &other.id.to_string());
            if let Ok(registration) = registration {
                join(&rooms, &registration, [2.0, 0.0, 0.0]);
                joined.push(registration);
            }
            if slow.cancelled.borrow().is_some() {
                break;
            }
            // Each one leaves again, so the room keeps seats: a join and a leave are two frames for the slow peer.
            joined.pop();
        }
        assert_eq!(*slow.cancelled.borrow(), Some((4408, "too slow")));
    }
}
