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
/// Sockets one account may hold on one island, its owner's own included: two tabs of it, or a tab whose dropped socket
/// the server has not noticed yet when it connects again.
pub(crate) const ACCOUNT_ISLAND_CAPACITY: usize = 3;
/// Sockets from one address (an IPv6 /64) on one island, its owner aside: a school or a carrier shares one address.
const ADDRESS_ISLAND_CAPACITY: usize = 10;
/// Sockets from one address on the whole server, owners' included: accounts signed up from one place cannot fill it.
pub(crate) const ADDRESS_CAPACITY: usize = 32;
/// How long a socket may stay open before it joins its room.
const JOIN_DEADLINE: Duration = Duration::from_secs(10);
/// How long after its first Join a socket may stay open before it stands somewhere in its room: a page sends where its
/// character stands as soon as it has one, and a slow phone takes a while to bring the character up; only a socket
/// that means to sit unseen takes longer.
const PLACE_DEADLINE: Duration = Duration::from_secs(60);
/// The least time between two Joins on one socket: each is answered with everyone in the room.
const JOIN_GAP: Duration = Duration::from_secs(5);
/// How fast a peer may move, in m/s, unless its island's game says otherwise: an island character runs at 20 and jumps
/// at 15.
pub const ROOM_SPEED: f64 = 30.0;
/// How far, in meters, a peer may get ahead of its speed at once: a phone whose link stalled delivers its steps
/// together. A longer way is taken as far as this, and the rest at its speed.
pub const BURST: f64 = 15.0;
/// The same for a game's players unless the game says otherwise ([`Movement::burst`]): two seconds of a run whose
/// steps a stalled link delivered together, so the game does not judge them where they stood seconds ago.
pub const GAME_BURST: f64 = 40.0;
/// Places a peer said it went that the room has not taken it to yet, kept at most: six seconds of 20 Hz steps. Older
/// ones are cut across.
const WAY_POINTS: usize = 128;
/// How near the place a peer said before its next one must be to count as the same, in meters: standing still.
const STILL: f64 = 0.05;
/// The fastest velocity relayed, in m/s: the others' pages draw a peer ahead along it for a moment.
const MAX_VELOCITY: f64 = 60.0;
/// Where a peer the viewer may not see is said to stand: far under the island, out of sight and still counted among
/// those here; the same place for everyone hidden, so nothing of where they really are goes out.
pub const HIDDEN_AT: [f64; 3] = [0.0, -500.0, 0.0];
/// The close code of a socket the room (or the island's game) had no seat for: the island is full, or this account or
/// this place has too many sockets open, or the server has. Its reason is a sentence for the page. A refused upgrade
/// cannot tell the page why, so the socket is opened and closed with this at once.
pub(crate) const NO_SEAT: u16 = 4409;
/// The close code of a socket whose account has come into the same room from another window.
pub(crate) const ELSEWHERE: u16 = 4410;
/// The longest reason a close frame carries, in bytes.
const MAX_CLOSE_REASON: usize = 123;
/// How long a room keeps where a governed account stood once its last socket there closed: one that comes back starts
/// from there.
const MEMORY: Duration = Duration::from_secs(60);
/// How long a peer holds its seat while it stands nowhere: one that has sent no position by then gives its seat up to
/// whoever comes to a full room or server. A Join carries no position and a page sends one within a second of its body
/// loading, so a socket that only joins is seen by nobody.
const UNPLACED_LIMIT: Duration = Duration::from_secs(15);
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
/// account, address and whether it is the owner's), `capacity` seats besides the owner's. The owner always gets a seat,
/// past the others' caps; a 일촌 takes any free seat; anyone else leaves [`ILCHON_SEATS`] free. One account holds at
/// most [`ACCOUNT_ISLAND_CAPACITY`] of them (the owner's on their own island too) and one address
/// [`ADDRESS_ISLAND_CAPACITY`], so a few free accounts cannot fill a public island.
pub(crate) fn seat<'a>(
    standing: Standing,
    account: Uuid,
    address: &str,
    seated: impl Iterator<Item = (Uuid, &'a str, bool)>,
    capacity: usize,
    code: &'static str,
) -> ApiResult<()> {
    let too_many = || {
        ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            code,
            "이 섬에 이 계정으로 열어 둔 연결이 너무 많습니다. 다른 탭을 닫고 다시 시도해 주세요.",
        )
    };
    let (mut others, mut mine, mut near, mut own) = (0, 0, 0, 0);
    for (holder, from, owner) in seated {
        if owner {
            own += usize::from(holder == account);
            continue;
        }
        others += 1;
        mine += usize::from(holder == account);
        near += usize::from(from == address);
    }
    if standing.owner() {
        return if own >= ACCOUNT_ISLAND_CAPACITY { Err(too_many()) } else { Ok(()) };
    }
    if mine >= ACCOUNT_ISLAND_CAPACITY {
        return Err(too_many());
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
    /// The room as a peer that has just joined sees it (its `client_id` and everyone else), queued in its place among
    /// the frames around it and written out only when its turn comes.
    Welcome {
        client_id: String,
        others: Vec<(String, PlayerState)>,
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

    /// Queues the room as the peer that has just joined sees it; false when [`OUTBOUND_CAPACITY`] frames already wait.
    fn welcome(&self, client_id: &str, others: Vec<(String, PlayerState)>) -> bool {
        let mut queue = self.queue();
        if queue.len() >= OUTBOUND_CAPACITY {
            return false;
        }
        queue.push_back(Out::Welcome { client_id: client_id.to_owned(), others });
        drop(queue);
        self.ready.notify_one();
        true
    }

    /// Queues `from`'s update (`frame`, which carries `state`), or merges it into one of theirs still waiting since the
    /// last Welcome: what it sets replaces what that one set. False when the update cannot wait.
    fn update(&self, from: &Arc<str>, state: &Arc<Map<String, Value>>, frame: &Message) -> bool {
        let mut queue = self.queue();
        // An update merged into one before a Welcome would reach the page before the Welcome's older state of them.
        let waiting =
            queue.iter_mut().rev().take_while(|out| !matches!(out, Out::Welcome { .. })).find_map(|out| match out {
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
                Out::Welcome { client_id, others } => {
                    let others: Map<String, Value> =
                        others.into_iter().map(|(other, state)| (other, json!(state))).collect();
                    text(&json!({"type": "Welcome", "client_id": client_id, "room_state": others}))
                }
            })
            .collect()
    }

    fn waiting(&self) -> bool {
        !self.queue().is_empty()
    }
}

/// How an island's game lets one of its players move in the island's live room (see [`Rooms::govern`]). The room keeps
/// every peer to a speed, whoever it is; a game sets each player's, and the longer jumps it sends them on itself.
#[derive(Clone, Debug, PartialEq)]
pub struct Movement {
    /// The fastest they may go, in m/s.
    pub speed: f64,
    /// How far, in meters, they may get ahead of their speed at once ([`GAME_BURST`] unless the game says otherwise):
    /// a stalled link delivers its steps together, and the room takes them along those steps as far as this, then at
    /// their speed.
    pub burst: f64,
    /// Whether, once their page says the same place again (standing still after a stall), the room takes them there
    /// as far as their speed could have taken them since it last took their word. Off for a game that counts the way
    /// they go (a race's gates): then they catch up along the way at their speed.
    pub settle: bool,
    /// Kept near one place (a countdown, a trap): wherever their page says they are, the room has them there.
    pub hold: Option<Hold>,
    /// Jumps the room takes from them whatever their speed, each once per socket.
    pub teleports: Vec<Teleport>,
    /// What they say in the room reaches nobody.
    pub mute: bool,
}

impl Default for Movement {
    fn default() -> Self {
        Self { speed: ROOM_SPEED, burst: GAME_BURST, settle: true, hold: None, teleports: Vec::new(), mute: false }
    }
}

/// Within `radius` (in meters, in any direction) of `at`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hold {
    pub at: [f64; 3],
    pub radius: f64,
}

/// A jump a game sends its player on, from wherever they are: to within `radius` of `to`. Its maps lie where the
/// island does (they take its place while it plays), so nothing about where the jump starts tells it apart; each is
/// taken once a socket, and a page that loses its place on the map (its canvas set up anew) walks back at its speed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Teleport {
    /// Tells this jump from an earlier one to the same place (a meeting's number, say).
    pub tag: u64,
    pub to: [f64; 3],
    pub radius: f64,
}

impl Teleport {
    fn fits(&self, to: [f64; 3]) -> bool {
        distance(self.to, to) <= self.radius
    }
}

/// What an island's game asks of its live room: how each of its players may move, and who the others do not see.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Governance {
    pub players: HashMap<Uuid, Movement>,
    /// Accounts the room hides, each with the accounts that still see it (each account sees itself). The others are
    /// told it stands far under the island and hear nothing it says until it shows again.
    pub hidden: HashMap<Uuid, Vec<Uuid>>,
}

/// A governed account in a room.
struct Rule {
    movement: Movement,
    /// The sockets that have taken each of `movement.teleports`, in its order.
    used: Vec<Vec<String>>,
    /// Where it stood when its last socket in the room closed, and when.
    left: Option<([f64; 3], Instant)>,
}

#[derive(Default)]
struct Governed {
    players: HashMap<Uuid, Rule>,
    hidden: HashMap<Uuid, Vec<Uuid>>,
}

impl Governed {
    fn matches(&self, governance: &Governance) -> bool {
        self.hidden == governance.hidden
            && self.players.len() == governance.players.len()
            && governance
                .players
                .iter()
                .all(|(user, movement)| self.players.get(user).is_some_and(|rule| rule.movement == *movement))
    }
}

/// Whether `viewer` sees `seen` under a room's `hidden` accounts.
fn sees_under(hidden: Option<&HashMap<Uuid, Vec<Uuid>>>, viewer: Uuid, seen: Uuid) -> bool {
    viewer == seen || hidden.and_then(|hidden| hidden.get(&seen)).is_none_or(|allowed| allowed.contains(&viewer))
}

fn sees(governed: Option<&Governed>, viewer: Uuid, seen: Uuid) -> bool {
    sees_under(governed.map(|governed| &governed.hidden), viewer, seen)
}

fn distance(a: [f64; 3], b: [f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

/// The point `share` of the way from `from` to `to`.
fn toward(from: [f64; 3], to: [f64; 3], share: f64) -> [f64; 3] {
    [0, 1, 2].map(|axis| from[axis] + (to[axis] - from[axis]) * share)
}

/// `state` as a viewer who may not see it is told: at [`HIDDEN_AT`], still, facing nowhere in particular.
fn parked(state: &PlayerState) -> PlayerState {
    PlayerState {
        position: HIDDEN_AT,
        rotation: REST_ROTATION,
        velocity: Some([0.0; 3]),
        animation: None,
        ..state.clone()
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
    /// When it last joined, and when it first did.
    joined_at: Option<Instant>,
    joined_first: Option<Instant>,
    /// How far it may still move at once (up to its burst), as of `moved_at`: it fills at the peer's speed.
    reach: f64,
    moved_at: Instant,
    /// The places it said it went that the room has not taken it to yet, in order: it is taken along them as its reach
    /// allows, so the steps a stalled link delivers at once are followed instead of cut across.
    way: VecDeque<[f64; 3]>,
    /// The last place the room took as it was said, and when.
    anchor: Option<([f64; 3], Instant)>,
    /// The place it said last.
    claimed: Option<[f64; 3]>,
    /// When its socket came in (see [`UNPLACED_LIMIT`]).
    since: Instant,
    acked: VecDeque<String>,
    messages: RateWindow,
    updates: RateWindow,
    chats: RateWindow,
    invalid: RateWindow,
}

/// Where a peer the room has not placed yet starts from: where another socket of its account stands, or where its last
/// one left off; and how far from there it may be at once.
#[derive(Clone, Copy, Debug)]
struct Start {
    at: [f64; 3],
    reach: f64,
}

/// How a peer may move: its speed, its burst, and whether it settles (see [`Movement`]).
#[derive(Clone, Copy)]
struct Pace {
    speed: f64,
    burst: f64,
    settle: bool,
}

impl Peer {
    /// Where the peer stands once it says it stands at `claim` (see [`Peer::reach_for`]).
    fn admit(&mut self, id: &str, claim: [f64; 3], start: Option<Start>, rule: Option<&mut Rule>, now: Instant) {
        let pace = rule.as_ref().map_or(Pace { speed: ROOM_SPEED, burst: BURST, settle: true }, |rule| Pace {
            speed: rule.movement.speed,
            burst: rule.movement.burst,
            settle: rule.movement.settle,
        });
        let elapsed = now.saturating_duration_since(self.moved_at).as_secs_f64();
        self.reach = (self.reach + pace.speed * elapsed).min(pace.burst);
        self.moved_at = now;
        let before = self.claimed.replace(claim);
        let at = self.reach_for(id, claim, before, start, rule, pace, now);
        if let Some(state) = self.state.as_mut() {
            state.position = at;
        }
    }

    /// Where the peer stands once it says `claim` (having said `before` last): held near its hold, if its game holds
    /// it; there the first time it says (from nowhere the room knows), when its game sent it there, or when it says
    /// the same place again (standing still) and its speed could have taken it there since the room last took its
    /// word. Else the room takes it along the places it said, in order, as far as its reach goes; a place too far from
    /// the one before (its page put it somewhere) drops the way to it, which is then cut across. A peer the room has
    /// not placed starts from `start`, as far from there as that says.
    #[allow(clippy::too_many_arguments)]
    fn reach_for(
        &mut self,
        id: &str,
        claim: [f64; 3],
        before: Option<[f64; 3]>,
        start: Option<Start>,
        rule: Option<&mut Rule>,
        pace: Pace,
        now: Instant,
    ) -> [f64; 3] {
        if let Some(hold) = rule.as_ref().and_then(|rule| rule.movement.hold) {
            self.way.clear();
            let off = distance(hold.at, claim);
            if off <= hold.radius {
                self.anchor = Some((claim, now));
                return claim;
            }
            return toward(hold.at, claim, hold.radius / off);
        }
        let placed = self.state.as_ref().filter(|_| self.placed).map(|state| state.position);
        let from = match (placed, start) {
            (Some(at), _) => at,
            (None, Some(start)) => {
                self.way.clear();
                self.reach = start.reach;
                start.at
            }
            (None, None) => {
                self.reach = pace.burst;
                return self.take(claim, now);
            }
        };
        if let Some(rule) = rule {
            let granted = rule.movement.teleports.iter().enumerate().find_map(|(index, teleport)| {
                (teleport.fits(claim) && !rule.used[index].iter().any(|taken| taken == id)).then_some(index)
            });
            if let Some(index) = granted {
                rule.used[index].push(id.to_owned());
                return self.take(claim, now);
            }
        }
        let said = |place: [f64; 3]| before.is_some_and(|before| distance(before, place) <= STILL);
        let caught_up = |(place, since): ([f64; 3], Instant)| {
            distance(place, claim) <= pace.speed * now.saturating_duration_since(since).as_secs_f64() + pace.burst
        };
        if placed.is_some() && pace.settle && said(claim) && self.anchor.is_some_and(caught_up) {
            return self.take(claim, now);
        }
        if before.is_some_and(|before| distance(before, claim) > pace.burst) {
            self.way.clear();
        }
        if self.way.back().is_none_or(|last| distance(*last, claim) > STILL) {
            self.way.push_back(claim);
            if self.way.len() > WAY_POINTS {
                self.way.pop_front();
            }
        }
        let mut at = from;
        while let Some(&next) = self.way.front() {
            let gone = distance(at, next);
            if gone > self.reach {
                let short = toward(at, next, self.reach / gone);
                self.reach = 0.0;
                return short;
            }
            self.reach -= gone;
            at = next;
            self.way.pop_front();
        }
        self.anchor = Some((at, now));
        at
    }

    /// `claim` taken as said: nothing left to follow, and the peer's word as of `now`.
    fn take(&mut self, claim: [f64; 3], now: Instant) -> [f64; 3] {
        self.way.clear();
        self.anchor = Some((claim, now));
        claim
    }

    /// When it must stand somewhere by: `deadline` ([`PLACE_DEADLINE`]) after its first Join; None once it does.
    fn place_by(&self, opened: Instant, deadline: Duration) -> Option<Instant> {
        (!self.placed).then(|| self.joined_first.unwrap_or(opened) + deadline)
    }
}

#[derive(Default)]
struct Hub {
    rooms: HashMap<String, HashMap<String, Peer>>,
    connections: usize,
    /// Open sockets per account.
    accounts: HashMap<Uuid, usize>,
    /// Open sockets per address.
    addresses: HashMap<String, usize>,
    /// What each room's island game asks of it, by room; dropped with the room.
    governed: HashMap<String, Governed>,
}

impl Hub {
    /// Takes peer `id` out of `room_key`, telling the others when they knew it; the peer, if it was there.
    fn remove(&mut self, room_key: &str, id: &str) -> Option<Peer> {
        let Self { rooms, governed, connections, accounts, addresses } = self;
        let room = rooms.get_mut(room_key)?;
        let peer = room.remove(id)?;
        if peer.placed {
            broadcast(room, id, &json!({"type": "PlayerLeft", "client_id": id}));
            // A governed account that comes back starts from here.
            let rule = governed.get_mut(room_key).and_then(|governed| governed.players.get_mut(&peer.user.id));
            if let (Some(rule), Some(state)) = (rule, peer.state.as_ref()) {
                rule.left = Some((state.position, Instant::now()));
            }
        }
        if room.is_empty() {
            rooms.remove(room_key);
            governed.remove(room_key);
        }
        *connections -= 1;
        if let Some(open) = accounts.get_mut(&peer.user.id) {
            *open -= 1;
            if *open == 0 {
                accounts.remove(&peer.user.id);
            }
        }
        if let Some(open) = addresses.get_mut(&peer.address) {
            *open -= 1;
            if *open == 0 {
                addresses.remove(&peer.address);
            }
        }
        Some(peer)
    }

    /// The peer that has stood nowhere the longest, once for [`UNPLACED_LIMIT`]: of `room`, where an owner's peer takes
    /// no one's seat, or of any room without one. Its room key and id.
    fn unplaced(&self, room: Option<&str>, now: Instant) -> Option<(String, String)> {
        self.rooms
            .iter()
            .filter(|(key, _)| room.is_none_or(|room| room == key.as_str()))
            .flat_map(|(key, peers)| peers.iter().map(move |(id, peer)| (key, id, peer)))
            .filter(|(_, _, peer)| !(room.is_some() && peer.owner))
            .filter(|(_, _, peer)| !peer.placed && now.duration_since(peer.since) >= UNPLACED_LIMIT)
            .min_by_key(|(_, _, peer)| peer.since)
            .map(|(key, id, _)| (key.clone(), id.clone()))
    }
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

struct Inner {
    hub: Mutex<Hub>,
    used_tickets: Mutex<HashMap<String, u64>>,
    /// By login session and island.
    watches: Mutex<HashMap<(String, String), Watch>>,
    watch_ids: AtomicU64,
    /// See [`PLACE_DEADLINE`].
    place_deadline: Duration,
}

#[derive(Clone)]
pub struct Rooms {
    inner: Arc<Inner>,
}

impl Default for Rooms {
    fn default() -> Self {
        Self::placing_within(PLACE_DEADLINE)
    }
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

/// The seats of `peers` as [`seat`] counts them, peer `without` aside.
fn seated<'a>(
    peers: &'a HashMap<String, Peer>,
    without: Option<&'a str>,
) -> impl Iterator<Item = (Uuid, &'a str, bool)> + 'a {
    peers
        .iter()
        .filter(move |(id, _)| without != Some(id.as_str()))
        .map(|(_, peer)| (peer.user.id, peer.address.as_str(), peer.owner))
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

/// Announces `from` (of account `user`), standing for the first time: as it is to whoever sees it, parked (see
/// [`parked`]) to whoever does not.
fn announce(
    room: &HashMap<String, Peer>,
    governed: Option<&Governed>,
    from: &str,
    user: Uuid,
    state: &PlayerState,
    t: Option<f64>,
) {
    let frame = |state: &PlayerState| {
        let mut joined = json!(state);
        if let Some(t) = t {
            joined["t"] = json!(t);
        }
        text(&json!({"type": "PlayerJoined", "client_id": from, "state": joined}))
    };
    let (shown, hidden) = (frame(state), frame(&parked(state)));
    for (id, peer) in room {
        if id == from || peer.state.is_none() {
            continue;
        }
        let frame = if sees(governed, peer.user.id, user) { shown.clone() } else { hidden.clone() };
        if !peer.outbox.push(frame) {
            peer.close.send_replace(Some((4408, "too slow")));
        }
    }
}

/// Sends `state` (what changed) as `from`'s to `peer`, merged into an update of theirs it has not been sent yet (see
/// [`Outbox`]); a peer that cannot take it is closed.
fn relay(peer: &Peer, from: &Arc<str>, state: &Arc<Map<String, Value>>, frame: &Message) {
    if !peer.outbox.update(from, state, frame) {
        peer.close.send_replace(Some((4408, "too slow")));
    }
}

/// Sends `from`'s (of account `user`) new state (what changed) to everyone else in the room who has joined and sees it.
fn broadcast_update(room: &HashMap<String, Peer>, governed: Option<&Governed>, from: &str, user: Uuid, state: Value) {
    let Value::Object(state) = state else { return };
    if state.is_empty() {
        return;
    }
    let state = Arc::new(state);
    let sender: Arc<str> = Arc::from(from);
    let frame = text(&json!({"type": "PlayerUpdate", "client_id": from, "state": &*state}));
    for (id, peer) in room {
        if id != from && peer.state.is_some() && sees(governed, peer.user.id, user) {
            relay(peer, &sender, &state, &frame);
        }
    }
}

impl Rooms {
    /// Live rooms as [`Default`] has them, but for a socket's time to stand somewhere after its first Join: `deadline`
    /// in place of [`PLACE_DEADLINE`].
    pub fn placing_within(deadline: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                hub: Default::default(),
                used_tickets: Default::default(),
                watches: Default::default(),
                watch_ids: AtomicU64::new(0),
                place_deadline: deadline,
            }),
        }
    }

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
        let now = Instant::now();
        let mut hub = self.hub();
        // A full server or room takes a newcomer in place of the peer that has stood nowhere the longest (see
        // UNPLACED_LIMIT): sockets nobody can see hold no seats for good. It goes only once the newcomer is let in.
        let mut spare = None;
        if hub.connections >= SERVER_CAPACITY {
            let full = ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "room", "실시간 서버가 가득 찼습니다.");
            spare = Some(hub.unplaced(None, now).ok_or(full)?);
        }
        if hub.accounts.get(&user.id).is_some_and(|open| *open >= ACCOUNT_CAPACITY) {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "room",
                "이 계정으로 열어 둔 실시간 연결이 너무 많습니다. 다른 탭을 닫고 다시 시도해 주세요.",
            ));
        }
        if hub.addresses.get(&address).is_some_and(|open| *open >= ADDRESS_CAPACITY) {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "room",
                "같은 곳에서 열린 실시간 연결이 너무 많습니다.",
            ));
        }
        let none = HashMap::new();
        let peers = hub.rooms.get(room).unwrap_or(&none);
        let reason = match seat(standing, user.id, &address, seated(peers, None), ROOM_CAPACITY, "room") {
            Ok(()) => "server full",
            // Only a full room gives a seat up: the newcomer's own account and address caps stay.
            Err(refused) if refused.status == StatusCode::CONFLICT => {
                let (key, id) = hub.unplaced(Some(room), now).ok_or(refused)?;
                seat(standing, user.id, &address, seated(peers, Some(&id)), ROOM_CAPACITY, "room")?;
                // One of this room's frees a place on the server too.
                spare = Some((key, id));
                "room full"
            }
            Err(refused) => return Err(refused),
        };
        if let Some(peer) = spare.and_then(|(key, id)| hub.remove(&key, &id)) {
            peer.close.send_replace(Some((4408, reason)));
        }
        let peers = hub.rooms.entry(room.to_owned()).or_default();
        let id = Uuid::new_v4().to_string();
        let viewer = user.clone();
        let (close, cancelled) = watch::channel(None);
        let outbox = Outbox::new();
        let from = address.clone();
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
                joined_at: None,
                joined_first: None,
                reach: BURST,
                moved_at: Instant::now(),
                way: VecDeque::new(),
                anchor: None,
                claimed: None,
                since: now,
                acked: VecDeque::new(),
                messages: RateWindow::over(MESSAGE_WINDOW),
                updates: RateWindow::new(),
                chats: RateWindow::new(),
                invalid: RateWindow::new(),
            },
        );
        hub.connections += 1;
        *hub.accounts.entry(viewer.id).or_default() += 1;
        *hub.addresses.entry(from).or_default() += 1;
        Ok(Registration { rooms: self.clone(), room: room.to_owned(), id, viewer, session, outbox, cancelled })
    }

    fn remove(&self, room_key: &str, id: &str) {
        self.hub().remove(room_key, id);
    }

    /// Takes `account`'s sockets out of `room_key`, each told it was taken from another window ([`ELSEWHERE`]): a page
    /// that stands in a room once (the 사주 village's) asks for this as it comes in. How many there were.
    pub(crate) fn evict_account(&self, room_key: &str, account: Uuid) -> usize {
        let mut hub = self.hub();
        let earlier: Vec<String> = hub
            .rooms
            .get(room_key)
            .map(|peers| peers.iter().filter(|(_, peer)| peer.user.id == account).map(|(id, _)| id.clone()).collect())
            .unwrap_or_default();
        let mut taken = 0;
        for id in earlier {
            if let Some(peer) = hub.remove(room_key, &id) {
                peer.close.send_replace(Some((ELSEWHERE, "다른 창에서 들어왔습니다.")));
                taken += 1;
            }
        }
        taken
    }

    /// Takes what `room`'s island game asks of it now (see [`Governance`]) in place of what it asked before: players
    /// hidden from someone now are parked for them (see [`parked`]), and players shown again come back as they are.
    pub fn govern(&self, room_key: &str, governance: Governance) {
        let mut hub = self.hub();
        let Hub { rooms, governed, .. } = &mut *hub;
        // A room nobody is in keeps nothing: the game asks again on its next beat.
        let Some(peers) = rooms.get(room_key) else {
            governed.remove(room_key);
            return;
        };
        let before = governed.get(room_key);
        if before.map_or(governance == Governance::default(), |before| before.matches(&governance)) {
            return;
        }
        for (seen_id, seen) in peers.iter().filter(|(_, peer)| peer.placed) {
            let Some(state) = seen.state.as_ref() else { continue };
            let sender: Arc<str> = Arc::from(seen_id.as_str());
            let away = parked(state);
            let hidden = json!({"position": away.position, "rotation": away.rotation, "velocity": away.velocity});
            for (_, viewer) in peers.iter().filter(|(id, peer)| *id != seen_id && peer.state.is_some()) {
                let was = sees(before, viewer.user.id, seen.user.id);
                if was == sees_under(Some(&governance.hidden), viewer.user.id, seen.user.id) {
                    continue;
                }
                let Value::Object(shown) = (if was { hidden.clone() } else { json!(state) }) else { continue };
                let frame = text(&json!({"type": "PlayerUpdate", "client_id": seen_id, "state": &shown}));
                relay(viewer, &sender, &Arc::new(shown), &frame);
            }
        }
        let mut old = governed.remove(room_key).unwrap_or_default();
        let players: HashMap<Uuid, Rule> = governance
            .players
            .into_iter()
            .map(|(user, movement)| {
                let prior = old.players.remove(&user);
                let used = movement
                    .teleports
                    .iter()
                    .map(|teleport| {
                        prior
                            .as_ref()
                            .and_then(|prior| {
                                let at = prior.movement.teleports.iter().position(|given| given == teleport)?;
                                prior.used.get(at).cloned()
                            })
                            .unwrap_or_default()
                    })
                    .collect();
                (user, Rule { movement, used, left: prior.and_then(|prior| prior.left) })
            })
            .collect();
        if !players.is_empty() || !governance.hidden.is_empty() {
            governed.insert(room_key.to_owned(), Governed { players, hidden: governance.hidden });
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

    /// Whether peer `id` of `room` stands somewhere in it (the others know it).
    #[cfg(test)]
    fn placed(&self, room: &str, id: &str) -> bool {
        self.hub().rooms.get(room).and_then(|room| room.get(id)).is_some_and(|peer| peer.placed)
    }

    /// When peer `id` of `room`, whose socket opened at `opened`, must stand somewhere by (see [`PLACE_DEADLINE`]);
    /// None once it does, or once it is gone.
    fn place_by(&self, room: &str, id: &str, opened: Instant) -> Option<Instant> {
        let deadline = self.inner.place_deadline;
        self.hub().rooms.get(room).and_then(|room| room.get(id)).and_then(|peer| peer.place_by(opened, deadline))
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
        self.receive_at(room_key, id, raw, origins, Instant::now())
    }

    /// [`Rooms::receive`] of a frame that arrived at `now`.
    fn receive_at(&self, room_key: &str, id: &str, raw: &str, origins: &[String], now: Instant) -> Flow {
        // Read and checked before the hub is locked: every room's frames wait on that lock.
        let message = serde_json::from_str::<ClientMessage>(raw).ok().map(|message| {
            let valid = message.valid(origins);
            (message, valid)
        });
        self.handle(room_key, id, message, now)
    }

    fn handle(&self, room_key: &str, id: &str, message: Option<(ClientMessage, bool)>, now: Instant) -> Flow {
        let mut hub = self.hub();
        let Hub { rooms, governed, .. } = &mut *hub;
        let Some(room) = rooms.get_mut(room_key) else { return Flow::Close(1011, "room closed") };
        let Some(peer) = room.get_mut(id) else { return Flow::Close(1011, "peer closed") };
        if !peer.messages.allow(now, MESSAGES_PER_WINDOW) {
            return Flow::Close(4429, "too many messages");
        }
        let Some((message, valid)) = message else { return malformed(&mut peer.invalid, now) };
        let user = peer.user.id;
        match message {
            ClientMessage::Ping { ts } => {
                peer.outbox.push(text(&json!({"type": "Pong", "ts": ts})));
            }
            ClientMessage::Leave => return Flow::Close(1000, "left"),
            ClientMessage::Join { color, model_url: model, .. } => {
                if !valid {
                    return malformed(&mut peer.invalid, now);
                }
                // Each Join is answered with the whole room: one every few seconds is all a page needs.
                if peer.joined_at.is_some_and(|at| now.saturating_duration_since(at) < JOIN_GAP) {
                    return Flow::Continue;
                }
                peer.joined_at = Some(now);
                peer.joined_first.get_or_insert(now);
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
                let outbox = peer.outbox.clone();
                let governed = governed.get(room_key);
                let others: Vec<(String, PlayerState)> = room
                    .iter()
                    .filter(|(other, peer)| *other != id && peer.placed)
                    .filter_map(|(other, peer)| {
                        let state = peer.state.as_ref()?;
                        let shown = if sees(governed, user, peer.user.id) { state.clone() } else { parked(state) };
                        Some((other.clone(), shown))
                    })
                    .collect();
                // Queued while the hub is held, so whatever happens in the room after it (someone leaving, someone
                // hidden) reaches the page after it; it is written out once its turn comes.
                if !outbox.welcome(id, others) {
                    return Flow::Close(4408, "too slow");
                }
                // A rejoin keeps its place; a new peer is announced with its first position (see `placed`).
                if rejoin {
                    broadcast_update(room, governed, id, user, json!(state));
                }
            }
            ClientMessage::Update { state: mut changes } => {
                if peer.state.is_none() {
                    return Flow::Continue;
                }
                if !valid {
                    return malformed(&mut peer.invalid, now);
                }
                if !peer.updates.allow(now, UPDATES_PER_SECOND) {
                    return Flow::Continue;
                }
                let placed = peer.placed;
                changes.rotation = changes.rotation.map(normalize_rotation);
                changes.velocity = changes.velocity.map(|velocity| {
                    let speed = distance(velocity, [0.0; 3]);
                    if speed > MAX_VELOCITY { velocity.map(|axis| axis * MAX_VELOCITY / speed) } else { velocity }
                });
                if let Some(claim) = changes.position {
                    let rule = governed.get_mut(room_key).and_then(|governed| governed.players.get_mut(&user));
                    // A governed account's new socket starts where another of its sockets stands, within its burst;
                    // or where its last one left off, as far as it could have gone since.
                    let start = match (&rule, placed) {
                        (Some(rule), false) => {
                            let Movement { speed, burst, .. } = rule.movement;
                            room.iter()
                                .filter(|(other, peer)| *other != id && peer.user.id == user && peer.placed)
                                .find_map(|(_, peer)| {
                                    peer.state.as_ref().map(|state| Start { at: state.position, reach: burst })
                                })
                                .or_else(|| {
                                    let (at, left) =
                                        rule.left.filter(|(_, at)| now.saturating_duration_since(*at) < MEMORY)?;
                                    let away = now.saturating_duration_since(left).as_secs_f64();
                                    Some(Start { at, reach: burst + speed * away })
                                })
                        }
                        _ => None,
                    };
                    let Some(peer) = room.get_mut(id) else { return Flow::Continue };
                    peer.admit(id, claim, start, rule, now);
                    changes.position = peer.state.as_ref().map(|state| state.position);
                }
                let Some(peer) = room.get_mut(id) else { return Flow::Continue };
                let Some(state) = peer.state.as_mut() else { return Flow::Continue };
                // What it says again unchanged (a colour, a model, an animation) is not relayed again.
                if changes.color.as_ref() == Some(&state.color) {
                    changes.color = None;
                }
                if changes.model_url.is_some() && changes.model_url == state.model_url {
                    changes.model_url = None;
                }
                if changes.animation.is_some() && changes.animation == state.animation {
                    changes.animation = None;
                }
                if let Some(value) = changes.color.clone() {
                    state.color = value;
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
                let first = (!placed && changes.position.is_some()).then(|| state.clone());
                if first.is_some() {
                    peer.placed = true;
                }
                let governed = governed.get(room_key);
                match first {
                    Some(state) => announce(room, governed, id, user, &state, changes.t),
                    None if placed => broadcast_update(room, governed, id, user, json!(changes)),
                    None => {}
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
                let governed = governed.get(room_key);
                // Its island's game keeps it quiet now: taken, and heard by nobody.
                if governed.and_then(|governed| governed.players.get(&user)).is_some_and(|rule| rule.movement.mute) {
                    return Flow::Continue;
                }
                let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                let frame = text(&json!({"type": "Chat", "client_id": id, "text": said, "timestamp": timestamp}));
                for (other, listener) in room.iter() {
                    let near = listener
                        .state
                        .as_ref()
                        .filter(|_| listener.placed)
                        .is_some_and(|heard| distance(heard.position, origin) <= reach);
                    if other != id && near && sees(governed, listener.user.id, user) {
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
    /// The page stands in the room once for its account: the account's sockets already there are let go.
    #[serde(default)]
    once: bool,
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
    let address = client_address(&headers);
    if query.once {
        state.rooms.evict_account(&home.username, visitor.id);
    }
    let registration = match state.rooms.register(&home.username, visitor, display, claims.session, standing, address) {
        Ok(registration) => registration,
        Err(refused) => return Ok(ws.on_upgrade(move |socket| refuse(socket, refused))),
    };
    Ok(ws
        .max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| connection(socket, registration, state)))
}

/// `message` cut to what a close frame carries ([`MAX_CLOSE_REASON`] bytes), at a character's end.
fn close_reason(message: &'static str) -> &'static str {
    let mut end = message.len().min(MAX_CLOSE_REASON);
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    &message[..end]
}

/// A socket there was no seat for (see [`NO_SEAT`]): closed at once, with why in the reason its page shows. A refused
/// upgrade would reach the page only as a failed connection, and it would keep trying without ever saying why.
pub(crate) async fn refuse(mut socket: WebSocket, refused: ApiError) {
    let frame = CloseFrame { code: NO_SEAT, reason: close_reason(refused.message).into() };
    if send(&mut socket, Message::Close(Some(frame))).await {
        let _ = tokio::time::timeout(CLOSE_GRACE, async { while let Some(Ok(_)) = socket.recv().await {} }).await;
    }
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
    let opened = Instant::now();
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let join_by = tokio::time::sleep(JOIN_DEADLINE);
    tokio::pin!(join_by);
    let mut join_checked = false;
    // Looked at again once the deadline counted from the socket's opening has passed: it counts from the first Join.
    let place_by = tokio::time::sleep(registration.rooms.inner.place_deadline);
    tokio::pin!(place_by);
    let mut place_checked = false;
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
            _ = &mut place_by, if !place_checked => {
                // Nor does one that joins and never stands anywhere: it hears everyone and nobody sees it.
                match registration.rooms.place_by(&registration.room, &registration.id, opened) {
                    None => place_checked = true,
                    Some(by) if by > Instant::now() => place_by.as_mut().reset(tokio::time::Instant::from_std(by)),
                    Some(_) => break Some((4408, "no place")),
                }
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
    fn a_page_that_stands_once_lets_its_accounts_other_window_go() {
        let rooms = Rooms::default();
        let (me, other) = (user(), user());
        let mut first = peer(&me, "sol", &rooms).unwrap();
        let _elsewhere = peer(&me, "bori", &rooms).unwrap();
        let _theirs = peer(&other, "sol", &rooms).unwrap();
        assert_eq!(rooms.evict_account("sol", me.id), 1);
        // The first window is told why, the other room and the other account stay.
        assert_eq!(*first.cancelled.borrow_and_update(), Some((ELSEWHERE, "다른 창에서 들어왔습니다.")));
        assert_eq!(rooms.count(), 2);
        assert!(peer(&me, "sol", &rooms).is_ok());
        assert_eq!(rooms.evict_account("nobody", me.id), 0);
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

    /// Lets `by` pass for `registration`'s peer: its rate limits start over and it may move that much further.
    fn later(rooms: &Rooms, registration: &Registration, by: Duration) {
        let mut hub = rooms.hub();
        let Some(peer) = hub.rooms.get_mut(&registration.room).and_then(|room| room.get_mut(&registration.id)) else {
            return;
        };
        peer.updates = RateWindow::new();
        peer.messages = RateWindow::over(MESSAGE_WINDOW);
        peer.chats = RateWindow::new();
        peer.joined_at = None;
        peer.moved_at -= by;
    }

    fn tell(rooms: &Rooms, registration: &Registration, message: Value) -> Flow {
        rooms.receive(&registration.room, &registration.id, &message.to_string(), &origins())
    }

    fn update(rooms: &Rooms, registration: &Registration, state: Value) {
        assert!(matches!(tell(rooms, registration, json!({"type": "Update", "state": state})), Flow::Continue));
    }

    /// Where the room has `registration`'s peer now.
    fn stands_at(rooms: &Rooms, registration: &Registration) -> [f64; 3] {
        let peers = rooms.peers(&registration.room);
        peers.iter().find(|peer| peer.id == registration.id).and_then(|peer| peer.position).unwrap()
    }

    fn near(a: [f64; 3], b: [f64; 3]) -> bool {
        distance(a, b) < 1e-9
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
            // The updates arrive over a long stretch, within the per-second limits and at a walk.
            later(&rooms, &mover, Duration::from_millis(100));
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
        let update = json!({"type": "Update", "state": {"position": [1998.0, 0.0, 0.0]}}).to_string();
        later(&rooms, &mover, Duration::from_millis(100));
        rooms.receive("r", &mover.id, &update, &origins());
        assert_eq!(frames(&slow)[0]["state"], json!({"position": [1998.0, 0.0, 0.0]}));

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

    #[test]
    fn a_peer_goes_only_as_fast_as_it_may_and_a_longer_jump_is_taken_as_far_as_it_could_have_gone() {
        let rooms = Rooms::default();
        let (me, other) = (user(), user());
        let (me, other) = (peer(&me, "r", &rooms).unwrap(), peer(&other, "r", &rooms).unwrap());
        join(&rooms, &other, [50.0, 0.0, 0.0]);
        // The first place is taken as it is said: nothing says where the peer stood before.
        join(&rooms, &me, [0.0, 0.0, 0.0]);
        frames(&other);
        // At once a hundred meters off: taken as far as a burst goes.
        update(&rooms, &me, json!({"position": [100.0, 0.0, 0.0]}));
        assert!(near(stands_at(&rooms, &me), [BURST, 0.0, 0.0]), "{:?}", stands_at(&rooms, &me));
        assert_eq!(frames(&other)[0]["state"]["position"], json!([BURST, 0.0, 0.0]));
        // A second later it has gone as far again as its speed takes it, never more than a burst at once.
        later(&rooms, &me, Duration::from_secs(1));
        update(&rooms, &me, json!({"position": [100.0, 0.0, 0.0]}));
        assert!(near(stands_at(&rooms, &me), [2.0 * BURST, 0.0, 0.0]));
        // Walking is taken as it is.
        later(&rooms, &me, Duration::from_millis(100));
        update(&rooms, &me, json!({"position": [2.0 * BURST + 2.0, 1.0, 0.0]}));
        assert!(near(stands_at(&rooms, &me), [2.0 * BURST + 2.0, 1.0, 0.0]));
        // A velocity that would throw the avatar across the island is cut to the fastest the room relays.
        update(&rooms, &me, json!({"velocity": [0.0, 0.0, 5e4]}));
        let speed = frames(&other).last().unwrap()["state"]["velocity"][2].as_f64().unwrap();
        assert!((speed - MAX_VELOCITY).abs() < 1e-9);
    }

    #[test]
    fn a_game_holds_its_players_where_it_says_and_sends_them_on_their_jumps_once_a_socket() {
        let rooms = Rooms::default();
        let (me, other) = (user(), user());
        let (mine, theirs) = (peer(&me, "r", &rooms).unwrap(), peer(&other, "r", &rooms).unwrap());
        join(&rooms, &theirs, [0.0, 0.0, 0.0]);
        join(&rooms, &mine, [0.0, 0.0, 0.0]);
        let hold = Hold { at: [10.0, 80.0, 0.0], radius: 3.0 };
        let rule =
            |movement: Movement| Governance { players: HashMap::from([(me.id, movement)]), ..Governance::default() };
        rooms.govern("r", rule(Movement { hold: Some(hold), ..Movement::default() }));
        // Held: wherever it says, it stands near the hold, and anywhere within reach of it is taken.
        update(&rooms, &mine, json!({"position": [0.0, 0.0, 0.0]}));
        assert!(distance(stands_at(&rooms, &mine), hold.at) <= 3.0 + 1e-9);
        update(&rooms, &mine, json!({"position": [11.0, 80.5, 1.0]}));
        assert!(near(stands_at(&rooms, &mine), [11.0, 80.5, 1.0]));

        // Let go, it keeps to its speed again; a jump the game sends it on is taken whatever the distance, once.
        let jump = Teleport { tag: 1, to: [-60.0, 80.0, 0.0], radius: 2.5 };
        rooms.govern("r", rule(Movement { teleports: vec![jump], ..Movement::default() }));
        update(&rooms, &mine, json!({"position": [-60.0, 81.0, 0.0]}));
        assert!(near(stands_at(&rooms, &mine), [-60.0, 81.0, 0.0]));
        later(&rooms, &mine, Duration::from_millis(50));
        update(&rooms, &mine, json!({"position": [11.0, 80.0, 0.0]}));
        assert!(distance(stands_at(&rooms, &mine), [-60.0, 81.0, 0.0]) <= BURST + 2.0, "taken once");
        // The same jump asked again keeps what it was; a new one (another tag) is taken again.
        rooms.govern("r", rule(Movement { teleports: vec![jump], ..Movement::default() }));
        update(&rooms, &mine, json!({"position": [-60.0, 80.0, 0.0]}));
        let again = Teleport { tag: 2, ..jump };
        rooms.govern("r", rule(Movement { teleports: vec![again], ..Movement::default() }));
        update(&rooms, &mine, json!({"position": [11.0, 80.0, 0.0]}));
        update(&rooms, &mine, json!({"position": [-60.0, 80.0, 0.0]}));
        assert!(near(stands_at(&rooms, &mine), [-60.0, 80.0, 0.0]));

        // A game's map lies where the island does: a jump is taken from the same height as where it lands, and only
        // to where it goes.
        let across = Teleport { tag: 3, to: [0.0, 0.0, 30.0], radius: 2.5 };
        let (other_socket, island) = (peer(&other, "s", &rooms).unwrap(), user());
        let watcher = peer(&island, "s", &rooms).unwrap();
        join(&rooms, &watcher, [0.0, 0.0, 0.0]);
        join(&rooms, &other_socket, [-80.0, 1.0, 0.0]);
        let players = HashMap::from([(other.id, Movement { teleports: vec![across], ..Movement::default() })]);
        rooms.govern("s", Governance { players, ..Governance::default() });
        update(&rooms, &other_socket, json!({"position": [60.0, 1.0, 30.0]}));
        assert!(distance(stands_at(&rooms, &other_socket), [-80.0, 1.0, 0.0]) <= GAME_BURST + 1e-9, "not the jump");
        update(&rooms, &other_socket, json!({"position": [0.0, 1.0, 30.0]}));
        assert!(near(stands_at(&rooms, &other_socket), [0.0, 1.0, 30.0]));
    }

    #[test]
    fn a_governed_account_that_comes_back_starts_where_its_sockets_stood() {
        let rooms = Rooms::default();
        let (me, watcher) = (user(), user());
        let first = peer(&me, "r", &rooms).unwrap();
        let other = peer(&watcher, "r", &rooms).unwrap();
        join(&rooms, &other, [0.0; 3]);
        join(&rooms, &first, [5.0, 0.0, 0.0]);
        rooms.govern(
            "r",
            Governance { players: HashMap::from([(me.id, Movement::default())]), ..Governance::default() },
        );
        // A second tab's first place counts from where the first stands, a game's burst away at most.
        let second = peer(&me, "r", &rooms).unwrap();
        join(&rooms, &second, [90.0, 0.0, 0.0]);
        assert!(near(stands_at(&rooms, &second), [5.0 + GAME_BURST, 0.0, 0.0]));
        // Both gone and one back at once: from where the last one left off.
        drop((first, second));
        let back = peer(&me, "r", &rooms).unwrap();
        join(&rooms, &back, [-90.0, 0.0, 0.0]);
        let from = 5.0 + GAME_BURST;
        assert!(about(stands_at(&rooms, &back), [from - GAME_BURST, 0.0, 0.0]), "{:?}", stands_at(&rooms, &back));
        // Someone the game does not govern is placed where they say.
        let free = peer(&user(), "r", &rooms).unwrap();
        join(&rooms, &free, [-90.0, 0.0, 0.0]);
        assert!(near(stands_at(&rooms, &free), [-90.0, 0.0, 0.0]));
        // Once the room is empty it keeps nothing.
        drop((back, free, other));
        assert!(rooms.hub().governed.is_empty());
    }

    #[test]
    fn a_governed_account_back_after_a_while_away_may_be_as_far_as_it_could_have_gone_since() {
        let rooms = Rooms::default();
        let (me, watcher) = (user(), user());
        let other = peer(&watcher, "r", &rooms).unwrap();
        join(&rooms, &other, [0.0; 3]);
        let first = peer(&me, "r", &rooms).unwrap();
        join(&rooms, &first, [0.0; 3]);
        let movement = Movement { speed: 10.0, ..Movement::default() };
        rooms.govern("r", Governance { players: HashMap::from([(me.id, movement)]), ..Governance::default() });
        drop(first);
        // Away three seconds at 10 m/s: a burst and thirty meters more.
        {
            let mut hub = rooms.hub();
            let rule = hub.governed.get_mut("r").and_then(|governed| governed.players.get_mut(&me.id)).unwrap();
            let (at, left) = rule.left.unwrap();
            rule.left = Some((at, left - Duration::from_secs(3)));
        }
        let back = peer(&me, "r", &rooms).unwrap();
        join(&rooms, &back, [GAME_BURST + 29.0, 0.0, 0.0]);
        assert!(near(stands_at(&rooms, &back), [GAME_BURST + 29.0, 0.0, 0.0]), "{:?}", stands_at(&rooms, &back));
        drop(back);
        let again = peer(&me, "r", &rooms).unwrap();
        join(&rooms, &again, [200.0, 0.0, 0.0]);
        let at = stands_at(&rooms, &again);
        assert!(at[0] < GAME_BURST + 29.0 + GAME_BURST + 5.0, "only as far as the time away allows: {at:?}");
    }

    #[test]
    fn players_hidden_by_a_game_are_parked_for_whoever_may_not_see_them_and_come_back_as_they_are() {
        let rooms = Rooms::default();
        let (ghost, living, friend) = (user(), user(), user());
        let (sg, sl, sf) = (
            peer(&ghost, "r", &rooms).unwrap(),
            peer(&living, "r", &rooms).unwrap(),
            peer(&friend, "r", &rooms).unwrap(),
        );
        for (socket, x) in [(&sg, 0.0), (&sl, 3.0), (&sf, 6.0)] {
            join(&rooms, socket, [x, 0.0, 0.0]);
        }
        for socket in [&sg, &sl, &sf] {
            frames(socket);
        }
        let hidden = HashMap::from([(ghost.id, vec![friend.id])]);
        rooms.govern("r", Governance { hidden: hidden.clone(), ..Governance::default() });
        // Who may not see the ghost is told it is far under the island, at the place every hidden peer is said to be,
        // nothing of where it stands; who may is told nothing new.
        let parked = frames(&sl);
        assert_eq!(parked.len(), 1);
        assert_eq!(parked[0]["client_id"], sg.id.as_str());
        assert_eq!(
            parked[0]["state"],
            json!({"position": HIDDEN_AT, "rotation": REST_ROTATION, "velocity": [0.0, 0.0, 0.0]})
        );
        assert!(frames(&sf).is_empty());
        rooms.govern("r", Governance { hidden: hidden.clone(), ..Governance::default() });
        assert!(frames(&sl).is_empty(), "the same again changes nothing");
        // Its moves and its words reach only who sees it.
        later(&rooms, &sg, Duration::from_millis(100));
        update(&rooms, &sg, json!({"position": [1.0, 0.0, 0.0]}));
        tell(&rooms, &sg, json!({"type": "Chat", "text": "여기"}));
        assert!(frames(&sl).is_empty());
        let heard = frames(&sf);
        assert_eq!(
            heard.iter().map(|frame| frame["type"].as_str().unwrap()).collect::<Vec<_>>(),
            ["PlayerUpdate", "Chat"]
        );
        // Someone who comes in later sees it parked too, and it is still counted among those here.
        let late = peer(&user(), "r", &rooms).unwrap();
        tell(&rooms, &late, json!({"type": "Join", "room_id": "r", "color": "#ffffff"}));
        let welcome = frames(&late);
        assert_eq!(welcome[0]["room_state"][sg.id.as_str()]["position"], json!(HIDDEN_AT));
        assert_eq!(welcome[0]["room_state"][sl.id.as_str()]["position"], json!([3.0, 0.0, 0.0]));
        // Its moves go on reaching nobody who may not see it, not even where it is; who may sees them.
        later(&rooms, &sg, Duration::from_millis(100));
        update(&rooms, &sg, json!({"position": [2.0, 0.0, 1.0]}));
        assert!(frames(&late).is_empty() && frames(&sl).is_empty());
        assert_eq!(frames(&sf)[0]["state"]["position"], json!([2.0, 0.0, 1.0]));
        // Shown again, it comes back as it is, to everyone it was hidden from.
        rooms.govern("r", Governance::default());
        let back = frames(&sl);
        assert_eq!(back[0]["state"]["position"], json!([2.0, 0.0, 1.0]));
        assert_eq!(back[0]["state"]["name"], ghost.display_name);
        assert!(frames(&sf).is_empty());
    }

    #[test]
    fn a_muted_player_is_answered_and_heard_by_nobody() {
        let rooms = Rooms::default();
        let (quiet, near_by) = (user(), user());
        let (sq, sn) = (peer(&quiet, "r", &rooms).unwrap(), peer(&near_by, "r", &rooms).unwrap());
        join(&rooms, &sq, [0.0; 3]);
        join(&rooms, &sn, [1.0, 0.0, 0.0]);
        frames(&sn);
        let players = HashMap::from([(quiet.id, Movement { mute: true, ..Movement::default() })]);
        rooms.govern("r", Governance { players, ..Governance::default() });
        tell(&rooms, &sq, json!({"type": "Chat", "text": "안녕", "ackId": "a1"}));
        assert_eq!(frames(&sq).last().unwrap(), &json!({"type": "Ack", "ackId": "a1"}));
        assert!(frames(&sn).is_empty());
    }

    #[test]
    fn a_socket_joins_once_every_few_seconds_and_what_it_repeats_is_not_relayed_again() {
        let rooms = Rooms::default();
        let (me, other) = (user(), user());
        let (mine, theirs) = (peer(&me, "r", &rooms).unwrap(), peer(&other, "r", &rooms).unwrap());
        join(&rooms, &theirs, [0.0; 3]);
        let model = "https://mogaesup.com/gltf/man.glb";
        let joining = json!({"type": "Join", "room_id": "r", "color": "#ffffff", "modelUrl": model});
        for _ in 0..5 {
            tell(&rooms, &mine, joining.clone());
        }
        let welcomes = frames(&mine).into_iter().filter(|frame| frame["type"] == "Welcome").count();
        assert_eq!(welcomes, 1, "a Join flood is answered once");
        later(&rooms, &mine, Duration::ZERO);
        tell(&rooms, &mine, joining);
        assert_eq!(frames(&mine)[0]["type"], "Welcome", "and again after the gap");
        update(&rooms, &mine, json!({"position": [1.0, 0.0, 0.0]}));
        frames(&theirs);
        // The same colour, model and animation sent with every move go out once.
        update(
            &rooms,
            &mine,
            json!({"position": [1.5, 0.0, 0.0], "color": "#ffffff", "modelUrl": model, "animation": "run"}),
        );
        update(
            &rooms,
            &mine,
            json!({"position": [2.0, 0.0, 0.0], "color": "#ffffff", "modelUrl": model, "animation": "run"}),
        );
        let relayed: Vec<Value> = frames(&theirs).into_iter().map(|frame| frame["state"].clone()).collect();
        assert_eq!(relayed, [json!({"position": [2.0, 0.0, 0.0], "animation": "run"})]);
        update(&rooms, &mine, json!({"color": "#000000"}));
        assert_eq!(frames(&theirs)[0]["state"], json!({"color": "#000000"}));
        update(&rooms, &mine, json!({"color": "#000000"}));
        assert!(frames(&theirs).is_empty(), "nothing new, nothing sent");
    }

    #[test]
    fn one_address_holds_a_few_dozen_sockets_on_the_whole_server_and_an_owner_three_on_their_island() {
        let rooms = Rooms::default();
        let held: Vec<Registration> = (0..ADDRESS_CAPACITY)
            .map(|at| enter(&user(), &format!("island{}", at % 4), &rooms, Standing::Owner, "school").unwrap())
            .collect();
        let refused = enter(&user(), "island9", &rooms, Standing::Owner, "school").err().unwrap();
        assert_eq!(refused.status, StatusCode::TOO_MANY_REQUESTS);
        assert!(enter(&user(), "island9", &rooms, Standing::Visitor, "elsewhere").is_ok());
        drop(held);
        assert!(enter(&user(), "island9", &rooms, Standing::Visitor, "school").is_ok(), "closed sockets give it back");
        let owner = user();
        let _tabs: Vec<Registration> = (0..ACCOUNT_ISLAND_CAPACITY)
            .map(|at| enter(&owner, "mine", &rooms, Standing::Owner, &format!("o{at}")).unwrap())
            .collect();
        let more = enter(&owner, "mine", &rooms, Standing::Owner, "o9").err().unwrap();
        assert_eq!(more.status, StatusCode::TOO_MANY_REQUESTS);
    }

    #[test]
    fn a_socket_that_joins_but_never_stands_anywhere_is_not_placed_and_has_a_minute_from_its_first_join() {
        let rooms = Rooms::default();
        let me = user();
        let socket = peer(&me, "r", &rooms).unwrap();
        let opened = Instant::now() - Duration::from_secs(8);
        assert_eq!(rooms.place_by("r", &socket.id, opened), Some(opened + PLACE_DEADLINE), "not joined yet");
        tell(&rooms, &socket, json!({"type": "Join", "room_id": "r", "color": "#ffffff"}));
        assert!(rooms.joined("r", &socket.id) && !rooms.placed("r", &socket.id));
        // A slow phone brings its character up long after it joins: the minute counts from that first Join.
        let by = rooms.place_by("r", &socket.id, opened).unwrap();
        assert!(by > opened + PLACE_DEADLINE && by <= Instant::now() + PLACE_DEADLINE);
        later(&rooms, &socket, Duration::ZERO);
        tell(&rooms, &socket, json!({"type": "Join", "room_id": "r", "color": "#ffffff"}));
        assert_eq!(rooms.place_by("r", &socket.id, opened), Some(by), "a later Join does not put it off");
        update(&rooms, &socket, json!({"position": [1.0, 0.0, 1.0]}));
        assert!(rooms.placed("r", &socket.id));
        assert_eq!(rooms.place_by("r", &socket.id, opened), None);
    }

    #[test]
    fn a_welcome_goes_out_in_its_place_among_the_rooms_frames() {
        let rooms = Rooms::default();
        let (me, mover, leaver) = (user(), user(), user());
        let (mine, moving, leaving) =
            (peer(&me, "r", &rooms).unwrap(), peer(&mover, "r", &rooms).unwrap(), peer(&leaver, "r", &rooms).unwrap());
        join(&rooms, &moving, [0.0; 3]);
        join(&rooms, &leaving, [5.0, 0.0, 0.0]);
        join(&rooms, &mine, [1.0, 0.0, 0.0]);
        frames(&mine);
        // A move, a Join again, another move and a leave: the Welcome stays between the moves, and the later move is
        // not merged into the earlier one ahead of it (which would draw it under the Welcome's older place).
        later(&rooms, &moving, Duration::from_millis(100));
        update(&rooms, &moving, json!({"position": [1.0, 0.0, 0.0]}));
        later(&rooms, &mine, Duration::ZERO);
        tell(&rooms, &mine, json!({"type": "Join", "room_id": "r", "color": "#ffffff"}));
        later(&rooms, &moving, Duration::from_millis(100));
        update(&rooms, &moving, json!({"position": [2.0, 0.0, 0.0]}));
        drop(leaving);
        let seen: Vec<(String, Value)> =
            frames(&mine).into_iter().map(|frame| (frame["type"].as_str().unwrap().to_owned(), frame)).collect();
        let kinds: Vec<&str> = seen.iter().map(|(kind, _)| kind.as_str()).collect();
        assert_eq!(kinds, ["PlayerUpdate", "Welcome", "PlayerUpdate", "PlayerLeft"]);
        assert_eq!(seen[1].1["room_state"][moving.id.as_str()]["position"], json!([1.0, 0.0, 0.0]));
        assert_eq!(seen[2].1["state"]["position"], json!([2.0, 0.0, 0.0]));
    }

    /// `registration`'s peer says it stands at `at`, in a frame that arrives at `now`.
    fn update_at(rooms: &Rooms, registration: &Registration, at: [f64; 3], now: Instant) {
        {
            let mut hub = rooms.hub();
            let Some(peer) = hub.rooms.get_mut(&registration.room).and_then(|room| room.get_mut(&registration.id))
            else {
                return;
            };
            peer.updates = RateWindow::new();
            peer.messages = RateWindow::over(MESSAGE_WINDOW);
        }
        let update = json!({"type": "Update", "state": {"position": at}}).to_string();
        let flow = rooms.receive_at(&registration.room, &registration.id, &update, &origins(), now);
        assert!(matches!(flow, Flow::Continue));
    }

    /// `registration`'s peer says it went through `steps`, all of them arriving at `now` (a stalled link).
    fn stalled(rooms: &Rooms, registration: &Registration, steps: &[[f64; 3]], now: Instant) {
        for step in steps {
            update_at(rooms, registration, *step, now);
        }
    }

    /// One meter steps from `from` along x to `x`, then along z to `z`.
    fn corner(from: [f64; 3], x: f64, z: f64) -> Vec<[f64; 3]> {
        let along_x = (1..=(x - from[0]) as i32).map(|step| [from[0] + f64::from(step), from[1], from[2]]);
        let along_z = (1..=(z - from[2]) as i32).map(|step| [x, from[1], from[2] + f64::from(step)]);
        along_x.chain(along_z).collect()
    }

    /// Within a few centimeters: a peer that may move on while a test's steps take real time goes a little further.
    fn about(a: [f64; 3], b: [f64; 3]) -> bool {
        distance(a, b) < 0.05
    }

    #[test]
    fn a_stalled_links_steps_are_followed_along_the_way_and_a_peer_standing_still_is_taken_where_it_stands() {
        let rooms = Rooms::default();
        let (me, other) = (user(), user());
        let (mine, theirs) = (peer(&me, "r", &rooms).unwrap(), peer(&other, "r", &rooms).unwrap());
        join(&rooms, &theirs, [0.0; 3]);
        join(&rooms, &mine, [0.0; 3]);
        let rule = |settle: bool| {
            let movement = Movement { speed: 20.0, settle, ..Movement::default() };
            Governance { players: HashMap::from([(me.id, movement)]), ..Governance::default() }
        };
        rooms.govern("r", rule(true));
        let start = Instant::now();
        let after = |ms: u64| start + Duration::from_millis(ms);
        // Two seconds standing, then 60 m of steps round a corner arrive at once: taken along them as far as the burst,
        // never across the corner.
        stalled(&rooms, &mine, &corner([0.0; 3], 30.0, 30.0), after(2_000));
        assert!(near(stands_at(&rooms, &mine), [30.0, 0.0, GAME_BURST - 30.0]), "{:?}", stands_at(&rooms, &mine));
        // Half a second later, a step further on: it goes on along them at its speed.
        update_at(&rooms, &mine, [30.0, 0.0, 31.0], after(2_500));
        assert!(
            about(stands_at(&rooms, &mine), [30.0, 0.0, GAME_BURST - 30.0 + 10.0]),
            "{:?}",
            stands_at(&rooms, &mine)
        );
        // Then it says the same place again, standing still: taken there, as its speed could have taken it since the
        // room last took its word.
        update_at(&rooms, &mine, [30.0, 0.0, 31.0], after(2_600));
        assert!(near(stands_at(&rooms, &mine), [30.0, 0.0, 31.0]));
        // But not where its speed could not have taken it, however often it says so.
        stalled(&rooms, &mine, &[[300.0, 0.0, 31.0]; 3], after(2_600));
        assert!(stands_at(&rooms, &mine)[0] < 30.0 + GAME_BURST, "{:?}", stands_at(&rooms, &mine));

        // A game that counts the way its players go (a race) has them catch up along it at their speed instead.
        rooms.govern("r", rule(false));
        stand(&rooms, &mine, [30.0, 0.0, 30.0], after(3_000));
        stalled(&rooms, &mine, &corner([30.0, 0.0, 30.0], 60.0, 60.0), after(6_000));
        assert!(about(stands_at(&rooms, &mine), [60.0, 0.0, GAME_BURST]), "{:?}", stands_at(&rooms, &mine));
        update_at(&rooms, &mine, [60.0, 0.0, 60.0], after(6_100));
        assert!(about(stands_at(&rooms, &mine), [60.0, 0.0, GAME_BURST + 2.0]), "{:?}", stands_at(&rooms, &mine));
        // A page that put its player somewhere else drops the way it said before: cut across from where it is now.
        update_at(&rooms, &mine, [60.0, 0.0, -20.0], after(6_600));
        assert!(
            about(stands_at(&rooms, &mine), [60.0, 0.0, GAME_BURST + 2.0 - 10.0]),
            "{:?}",
            stands_at(&rooms, &mine)
        );
    }

    #[test]
    fn a_jump_is_taken_once_a_socket_from_anywhere_and_a_page_that_lost_its_place_walks_back() {
        let rooms = Rooms::default();
        let (me, other) = (user(), user());
        let (mine, theirs) = (peer(&me, "r", &rooms).unwrap(), peer(&other, "r", &rooms).unwrap());
        join(&rooms, &theirs, [0.0; 3]);
        join(&rooms, &mine, [0.0, 1.0, 0.0]);
        let start = Teleport { tag: 0, to: [90.0, 0.0, 0.0], radius: 2.5 };
        let seat = Teleport { tag: 1, to: [10.0, 0.0, 0.0], radius: 2.5 };
        let movement = Movement { teleports: vec![start, seat], ..Movement::default() };
        rooms.govern("r", Governance { players: HashMap::from([(me.id, movement)]), ..Governance::default() });
        update(&rooms, &mine, json!({"position": [90.0, 1.0, 0.0]}));
        assert!(near(stands_at(&rooms, &mine), [90.0, 1.0, 0.0]));
        // Its page's canvas came up anew at the island's start: the start is not taken again, it walks back at its speed.
        stand(&rooms, &mine, [0.0, 1.0, 0.0], Instant::now());
        later(&rooms, &mine, Duration::from_millis(50));
        update(&rooms, &mine, json!({"position": [90.0, 1.0, 0.0]}));
        assert!(
            distance(stands_at(&rooms, &mine), [0.0, 1.0, 0.0]) <= GAME_BURST + 1e-9,
            "{:?}",
            stands_at(&rooms, &mine)
        );
        // Each jump once: the seat too.
        update(&rooms, &mine, json!({"position": [10.0, 1.0, 0.0]}));
        assert!(near(stands_at(&rooms, &mine), [10.0, 1.0, 0.0]));
        stand(&rooms, &mine, [-40.0, 1.0, 0.0], Instant::now());
        later(&rooms, &mine, Duration::from_millis(50));
        update(&rooms, &mine, json!({"position": [10.0, 1.0, 0.0]}));
        assert!(!near(stands_at(&rooms, &mine), [10.0, 1.0, 0.0]));
        // Another socket of theirs (a page loaded again) is sent to its start once more.
        let again = peer(&me, "r", &rooms).unwrap();
        join(&rooms, &again, [-40.0, 1.0, 0.0]);
        update(&rooms, &again, json!({"position": [90.0, 1.0, 0.0]}));
        assert!(near(stands_at(&rooms, &again), [90.0, 1.0, 0.0]));
    }

    /// Puts `registration`'s peer at `at` as the room has it, as if it had walked there and said so at `now`.
    fn stand(rooms: &Rooms, registration: &Registration, at: [f64; 3], now: Instant) {
        let mut hub = rooms.hub();
        let Some(peer) = hub.rooms.get_mut(&registration.room).and_then(|room| room.get_mut(&registration.id)) else {
            return;
        };
        if let Some(state) = peer.state.as_mut() {
            state.position = at;
        }
        peer.way.clear();
        peer.claimed = Some(at);
        peer.anchor = Some((at, now));
    }

    #[test]
    fn why_a_socket_had_no_seat_fits_in_its_close_frame() {
        let rooms = Rooms::default();
        let me = user();
        let mut refusals = Vec::new();
        // This account has too many sockets on the server, on one island; this place has too many; the island is full.
        let mine: Vec<Registration> =
            (0..ACCOUNT_CAPACITY).map(|at| peer(&me, &format!("r{at}"), &rooms).unwrap()).collect();
        refusals.push(peer(&me, "r9", &rooms).err().unwrap());
        drop(mine);
        let seated = |count: usize, account: Uuid, address: &'static str, owner: bool| {
            (0..count).map(move |_| (account, address, owner)).collect::<Vec<_>>()
        };
        let island = |seated: Vec<(Uuid, &'static str, bool)>, standing: Standing| {
            seat(standing, me.id, "here", seated.into_iter(), ROOM_CAPACITY, "room").err().unwrap()
        };
        refusals.push(island(seated(ACCOUNT_ISLAND_CAPACITY, me.id, "a", false), Standing::Visitor));
        refusals.push(island(seated(ACCOUNT_ISLAND_CAPACITY, me.id, "a", true), Standing::Owner));
        refusals.push(island(seated(ADDRESS_ISLAND_CAPACITY, Uuid::new_v4(), "here", false), Standing::Visitor));
        refusals.push(island(seated(ROOM_CAPACITY, Uuid::new_v4(), "b", false), Standing::Ilchon));
        let crowd: Vec<Registration> = (0..ADDRESS_CAPACITY)
            .map(|at| enter(&user(), &format!("s{at}"), &rooms, Standing::Owner, "school").unwrap())
            .collect();
        refusals.push(enter(&user(), "s", &rooms, Standing::Owner, "school").err().unwrap());
        drop(crowd);
        let full: Vec<Registration> = (0..SERVER_CAPACITY)
            .map(|at| enter(&user(), &format!("f{at}"), &rooms, Standing::Owner, &format!("a{at}")).unwrap())
            .collect();
        refusals.push(enter(&user(), "f", &rooms, Standing::Owner, "elsewhere").err().unwrap());
        drop(full);
        for refusal in refusals {
            assert_eq!(close_reason(refusal.message), refusal.message, "{} bytes", refusal.message.len());
        }
        // A longer one is cut at a character's end.
        let long: &'static str = Box::leak("가".repeat(60).into_boxed_str());
        let cut = close_reason(long);
        assert!(cut.len() <= MAX_CLOSE_REASON && !cut.is_empty() && cut.chars().all(|c| c == '가'));
    }

    /// Makes peer `id` of `room` one that came in `ago` and stands somewhere or not.
    fn waited(rooms: &Rooms, room: &str, id: &str, ago: Duration, placed: bool) {
        let mut hub = rooms.hub();
        let peer = hub.rooms.get_mut(room).and_then(|peers| peers.get_mut(id)).unwrap();
        peer.since = Instant::now().checked_sub(ago).unwrap();
        peer.placed = placed;
    }

    #[test]
    fn a_full_room_takes_a_newcomer_for_the_peer_that_stood_nowhere_longest() {
        let rooms = Rooms::default();
        let island = "isle";
        // Every seat a visitor may take, ten of them from one address.
        let held: Vec<Registration> = (0..ROOM_CAPACITY - ILCHON_SEATS)
            .map(|at| {
                let address = if at < ADDRESS_ISLAND_CAPACITY { "crowd".to_owned() } else { format!("10.0.0.{at}") };
                enter(&user(), island, &rooms, Standing::Visitor, &address).unwrap()
            })
            .collect();
        // One that only joins: what the join deadline lets stay.
        let join = json!({"type": "Join", "room_id": island, "color": "#ffffff"}).to_string();
        assert!(matches!(rooms.receive(island, &held[0].id, &join, &origins()), Flow::Continue));
        // Sockets that have only just come in keep their seats, standing anywhere or not.
        let refused = enter(&user(), island, &rooms, Standing::Visitor, "10.0.1.1").err().unwrap();
        assert_eq!((refused.status, refused.code), (StatusCode::CONFLICT, "room"));
        // All came in a while ago and all but two stand somewhere; of those two, the first came in earlier.
        for (index, registration) in held.iter().enumerate() {
            let ago = UNPLACED_LIMIT + Duration::from_secs(if index == 0 { 10 } else { 5 });
            waited(&rooms, island, &registration.id, ago, index >= 2);
        }
        // A newcomer turned away by its own address's cap takes no one's seat.
        let crowded = enter(&user(), island, &rooms, Standing::Visitor, "crowd").err().unwrap();
        assert_eq!(crowded.status, StatusCode::TOO_MANY_REQUESTS);
        assert!(held.iter().all(|registration| registration.cancelled.borrow().is_none()));
        let _first = enter(&user(), island, &rooms, Standing::Visitor, "10.0.1.1").unwrap();
        assert_eq!(*held[0].cancelled.borrow(), Some((4408, "room full")));
        assert_eq!(*held[1].cancelled.borrow(), None);
        let _second = enter(&user(), island, &rooms, Standing::Visitor, "10.0.1.2").unwrap();
        assert_eq!(*held[1].cancelled.borrow(), Some((4408, "room full")));
        assert_eq!(rooms.count(), ROOM_CAPACITY - ILCHON_SEATS);
        // Everyone left stands somewhere or has just come: full again.
        let full = enter(&user(), island, &rooms, Standing::Visitor, "10.0.1.3").err().map(|error| error.status);
        assert_eq!(full, Some(StatusCode::CONFLICT));
        // The seats given up are gone already: those sockets' own ends take nothing more.
        drop(held);
        assert_eq!(rooms.count(), 2);
    }

    #[test]
    fn an_owners_peer_that_stands_nowhere_frees_no_visitor_seat() {
        let rooms = Rooms::default();
        let owner = user();
        let host = enter(&owner, "isle", &rooms, Standing::Owner, "a").unwrap();
        let visitors: Vec<Registration> =
            (0..ROOM_CAPACITY - ILCHON_SEATS).map(|_| peer(&user(), "isle", &rooms).unwrap()).collect();
        waited(&rooms, "isle", &host.id, UNPLACED_LIMIT * 2, false);
        assert_eq!(peer(&user(), "isle", &rooms).err().map(|error| error.status), Some(StatusCode::CONFLICT));
        assert_eq!(*host.cancelled.borrow(), None);
        // A visitor's that has stood nowhere a shorter while gives its seat up instead.
        waited(&rooms, "isle", &visitors[3].id, UNPLACED_LIMIT, false);
        let _newcomer = peer(&user(), "isle", &rooms).unwrap();
        assert_eq!(*visitors[3].cancelled.borrow(), Some((4408, "room full")));
        assert_eq!(*host.cancelled.borrow(), None);
    }

    #[test]
    fn a_full_server_takes_a_newcomer_for_the_peer_that_stood_nowhere_longest() {
        let rooms = Rooms::default();
        let room = |at: usize| format!("isle{}", at / (ROOM_CAPACITY - ILCHON_SEATS));
        let held: Vec<Registration> =
            (0..SERVER_CAPACITY).map(|at| peer(&user(), &room(at), &rooms).unwrap()).collect();
        let refused = peer(&user(), "elsewhere", &rooms).err().unwrap();
        assert_eq!(refused.status, StatusCode::SERVICE_UNAVAILABLE);
        waited(&rooms, &room(100), &held[100].id, UNPLACED_LIMIT, false);
        let _newcomer = peer(&user(), "elsewhere", &rooms).unwrap();
        assert_eq!(*held[100].cancelled.borrow(), Some((4408, "server full")));
        assert_eq!(rooms.count(), SERVER_CAPACITY);
        let again = peer(&user(), "elsewhere", &rooms).err().map(|error| error.status);
        assert_eq!(again, Some(StatusCode::SERVICE_UNAVAILABLE));
    }
}
