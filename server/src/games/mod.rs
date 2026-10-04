//! Minigames on an island, run by the server. Each island has at most one game session, keyed like its live room by the
//! owner's username ([`crate::rooms`]). Whoever is in the island's live room may open a socket to it, watch the session
//! and play: `GET /api/games/{username}?ticket=&peer=`, with a realtime ticket as for the room and, as `peer`, the
//! `client_id` the room gave this page (its positions are the player's).
//!
//! The live room's socket speaks gaesup-world's own protocol, whose client drops messages it does not know, so games
//! never add anything to it: they read where everyone stands from the room ([`Ctx::position`]) and talk over this one.
//!
//! # Protocol (JSON text frames, 16 KiB at most)
//!
//! Client → server:
//! - `{"type":"Open","kind":"treasure"}`: opens a lobby when the island has no session; the sender hosts it and is its
//!   first player. The host of a lobby or of a finished game may open again: a lobby of `kind` with the same players.
//! - `{"type":"Join"}`, `{"type":"Leave"}`: joins the lobby; leaves the session (in any phase).
//! - `{"type":"Start","layout":{…}}`: the host starts the lobby's game once it has enough players. `layout` is data the
//!   host's page computed from the island it has loaded (open spots, say), in the game's own shape; the game checks it.
//! - `{"type":"Act","action":{…}}`: a player's move, in the game's own shape.
//! - `{"type":"Close"}`: the host ends the session for everyone.
//! - `{"type":"Ping","ts":n}`: answered with `{"type":"Pong","ts":n}`.
//!
//! Server → client:
//! - `{"type":"Session","session":null|{…}}` on connecting and whenever what this viewer may see changes:
//!   `kind`, `phase` (`lobby`|`playing`|`ended`), `host` (user id; the first of `players`), `players`
//!   (`[{id, name, peer}]` in the order they joined; `peer` is the player's live-room `client_id`, null while they are
//!   not in the room), `you` (the viewer's user id), `game` (the game's view for this viewer, null in the lobby),
//!   `result` (once ended), `seq` (rises with every update the session sends) and `now` (the server's clock in ms, for
//!   countdowns).
//! - `{"type":"Event","kind":"treasure","event":{…}}`: something a game announced ([`Ctx::emit`]).
//! - `{"type":"Error","code":"not_host","message":"…"}`: why a message was refused, to its sender only.
//! - `{"type":"Pong","ts":n}`.
//!
//! # Lifetime
//!
//! `Lobby` → `Playing` (a [`Game`] runs, ticked at its kind's rate) → `Ended` (the result stays until the host opens
//! again or closes). A host who leaves hands the session to the earliest player left; the last player leaving closes
//! it, and so does nobody touching it for ten minutes. A player out of the live room for ten seconds leaves.
//!
//! # Adding a game
//!
//! A game is a plugin: one file `games/<name>.rs` with a type implementing [`Game`] and a
//! `pub(crate) const KIND: Kind = Kind::new(…)` (its name, player limits, tick rate and `create`), and its name on one
//! line of the `registry!` below. The client side is a folder `frontend/src/games/<name>/` and one line in its
//! registry. `docs/game-plugins.md` walks through both; `treasure` is the reference.

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
use rand::{Rng, RngCore, SeedableRng, rngs::StdRng};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Notify, mpsc, watch};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{self, User},
    error::{ApiError, ApiResult, conflict},
    homes::visible_home,
    rooms::{AbortOnDrop, BAD_TICKET, RateWindow, RoomPeer, send, send_queued},
    security::{FOREIGN_ORIGIN, same_origin},
};

/// Declares each listed game's module (`games/<name>.rs`) and lists its `KIND` in `KINDS`, in that order.
macro_rules! registry {
    ($($game:ident),* $(,)?) => {
        $(mod $game;)*
        /// Every game the server runs, by the `kind` clients open.
        pub(crate) const KINDS: &[Kind] = &[$($game::KIND),*];
    };
}

// The plugin point: one line per game.
registry! {
    treasure,
}

/// Milliseconds on the server's clock: what games measure time in, and what views carry (`endsAt`). Monotonic, and
/// close to Unix time, so a page can count down against `Session.now`.
pub type Millis = u64;

/// How far from the island's centre a layout point may be, on each axis.
pub const MAX_COORDINATE: f64 = 200.0;

const MAX_MESSAGE_BYTES: usize = 16 * 1024;
const OUTBOUND_CAPACITY: usize = 256;
/// Game sockets on one island, as many as its live room holds.
const ISLAND_CAPACITY: usize = 30;
const SERVER_CAPACITY: usize = 512;
/// Game sockets one account may have open at once, as in the live room.
const ACCOUNT_CAPACITY: usize = 4;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(45);
/// How long a socket we closed is kept for the peer's answer.
const CLOSE_GRACE: Duration = Duration::from_secs(2);
const MESSAGES_PER_SECOND: usize = 40;
/// Malformed frames tolerated per second before the socket is dropped.
const INVALID_PER_SECOND: usize = 10;
/// How often a playing game is ticked unless its [`Kind`] says otherwise.
pub const DEFAULT_TICK_HZ: u32 = 10;
/// The most ticks a second a game may ask for.
pub const MAX_TICK_HZ: u32 = 30;
/// How often a lobby or a finished game checks who is still around.
const IDLE_TICK: Duration = Duration::from_secs(1);
/// How long a player may be out of the island's live room before they leave the game.
const AWAY_LIMIT: Millis = 10_000;
/// A session nobody has touched for this long closes.
const IDLE_LIMIT: Millis = 10 * 60_000;
const MAX_KIND: usize = 32;
const MAX_PEER: usize = 64;

/// A refusal, sent to whoever asked as `{"type":"Error","code","message"}`: a stable code and a message for the page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GameError {
    pub code: &'static str,
    pub message: &'static str,
}

impl GameError {
    pub const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

const NO_GAME: GameError = GameError::new("no_game", "열린 게임이 없어요.");
const GAME_EXISTS: GameError = GameError::new("game_exists", "이미 열린 게임이 있어요.");
const UNKNOWN_GAME: GameError = GameError::new("unknown_game", "없는 게임이에요.");
const NOT_HOST: GameError = GameError::new("not_host", "방장만 할 수 있어요.");
const NOT_PLAYER: GameError = GameError::new("not_player", "참가한 사람만 할 수 있어요.");
const NOT_LOBBY: GameError = GameError::new("not_lobby", "지금은 할 수 없어요.");
const NOT_PLAYING: GameError = GameError::new("not_playing", "게임이 진행 중이 아니에요.");
const IN_PROGRESS: GameError = GameError::new("in_progress", "게임이 진행 중이에요.");
const FULL: GameError = GameError::new("full", "자리가 다 찼어요.");
const TOO_FEW: GameError = GameError::new("too_few", "사람이 더 있어야 시작할 수 있어요.");
const NOT_IN_ROOM_GAME: GameError = GameError::new("not_in_room", "섬에 들어와 있어야 해요.");
/// For games: a layout that is not what the game asked for.
pub const BAD_LAYOUT: GameError = GameError::new("bad_layout", "게임을 준비하지 못했어요. 다시 시작해 주세요.");
/// For games: an action that is not one the game knows.
pub const BAD_ACTION: GameError = GameError::new("bad_action", "할 수 없는 행동이에요.");

const NOT_IN_ROOM: ApiError = conflict("not_in_room", "섬에 먼저 들어와 주세요.");

/// Someone playing, as games see them.
#[derive(Clone, Debug, PartialEq)]
pub struct Member {
    pub id: Uuid,
    pub name: String,
}

/// Who receives an event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Audience {
    /// Everyone with a game socket on the island, players or not.
    Everyone,
    /// These players' sockets only.
    Only(Vec<Uuid>),
}

impl Audience {
    fn includes(&self, user: Uuid) -> bool {
        match self {
            Self::Everyone => true,
            Self::Only(players) => players.contains(&user),
        }
    }
}

/// What a game may use and do during a call: the time, the players and where they stand, the session's random
/// numbers, and events to send. Events from a refused [`Game::act`] or [`Kind::create`] are dropped.
pub struct Ctx<'a> {
    now: Millis,
    players: &'a [Member],
    positions: &'a HashMap<Uuid, [f64; 3]>,
    rng: &'a mut StdRng,
    events: Vec<(Audience, Value)>,
}

impl<'a> Ctx<'a> {
    /// A context over `players` (in the order they joined) standing at `positions`. Tests make their own.
    pub fn new(
        now: Millis,
        players: &'a [Member],
        positions: &'a HashMap<Uuid, [f64; 3]>,
        rng: &'a mut StdRng,
    ) -> Self {
        Self { now, players, positions, rng, events: Vec::new() }
    }

    /// The server's clock now.
    pub fn now(&self) -> Millis {
        self.now
    }

    /// The players, in the order they joined. Borrowed apart from the context, so a loop over them may still emit.
    pub fn players(&self) -> &'a [Member] {
        self.players
    }

    pub fn is_player(&self, id: Uuid) -> bool {
        self.players.iter().any(|player| player.id == id)
    }

    pub fn name(&self, id: Uuid) -> Option<&'a str> {
        self.players.iter().find(|player| player.id == id).map(|player| player.name.as_str())
    }

    /// Where `player` stands in the live room, as of this call: None until their page has said, or while they are out.
    pub fn position(&self, player: Uuid) -> Option<[f64; 3]> {
        self.positions.get(&player).copied()
    }

    /// Every placed player's position, as of this call.
    pub fn positions(&self) -> &'a HashMap<Uuid, [f64; 3]> {
        self.positions
    }

    /// The session's random numbers: seeded per session, so a seeded server replays the same games.
    pub fn rng(&mut self) -> &mut StdRng {
        self.rng
    }

    /// Sends `event` to everyone watching the island's game.
    pub fn emit(&mut self, event: Value) {
        self.events.push((Audience::Everyone, event));
    }

    /// Sends `event` to these players only.
    pub fn emit_to(&mut self, players: &[Uuid], event: Value) {
        self.events.push((Audience::Only(players.to_vec()), event));
    }

    /// Sends `event` to one player only (a secret of theirs, say).
    pub fn emit_one(&mut self, player: Uuid, event: Value) {
        self.events.push((Audience::Only(vec![player]), event));
    }

    /// The events emitted so far, in order.
    pub fn events(&self) -> &[(Audience, Value)] {
        &self.events
    }

    fn into_events(self) -> Vec<(Audience, Value)> {
        self.events
    }
}

/// A game in play. The framework holds it behind the session's lock, so no method may block or wait.
///
/// Views are compared per viewer before they are sent, so a view that has not changed is not sent again: put absolute
/// times in them (`endsAt`, on the server's clock) rather than what is left.
pub trait Game: Send {
    /// What `viewer` may see now: Some(player) for a player, None for someone watching. Secrets go only to whom they
    /// belong to.
    fn view(&self, viewer: Option<Uuid>, now: Millis) -> Value;

    /// A player's action. Err refuses it, telling that player why; a refused action must change nothing.
    fn act(&mut self, player: Uuid, action: &Value, ctx: &mut Ctx) -> Result<(), GameError>;

    /// Moves the game on; called [`Kind::tick_hz`] times a second while it plays (measure time by `ctx.now()`).
    fn tick(&mut self, ctx: &mut Ctx);

    /// `player` has left (by choice, or out of the live room for too long): carry on without them, or end.
    fn leave(&mut self, player: Uuid, ctx: &mut Ctx);

    /// Some once the game is over: the result everyone sees, and the session ends with it.
    fn result(&self) -> Option<Value>;
}

/// A game the server offers: its registry entry. Make one with [`Kind::new`] (and [`Kind::ticking`]), whose checks run
/// when the crate compiles.
#[derive(Clone, Copy)]
pub struct Kind {
    /// What clients open it by.
    pub kind: &'static str,
    pub min_players: usize,
    pub max_players: usize,
    /// How many times a second [`Game::tick`] runs while the game plays: 1 to [`MAX_TICK_HZ`].
    pub tick_hz: u32,
    /// Starts a game with the lobby's players (`ctx.players()`) and the host's `layout`, or says why it cannot.
    pub create: Create,
}

impl Kind {
    /// A game opened as `kind` for `min_players` to `max_players` (at most an island's 30), ticked
    /// [`DEFAULT_TICK_HZ`] times a second while it plays.
    pub const fn new(kind: &'static str, min_players: usize, max_players: usize, create: Create) -> Self {
        assert!(!kind.is_empty() && kind.len() <= MAX_KIND, "a game's kind is 1 to 32 bytes");
        assert!(1 <= min_players && min_players <= max_players, "a game needs at least one player, and min <= max");
        assert!(max_players <= ISLAND_CAPACITY, "an island holds at most 30 players");
        Self { kind, min_players, max_players, tick_hz: DEFAULT_TICK_HZ, create }
    }

    /// The same game ticked `hz` times a second while it plays (physics, say): 1 to [`MAX_TICK_HZ`].
    pub const fn ticking(self, hz: u32) -> Self {
        assert!(1 <= hz && hz <= MAX_TICK_HZ, "a game ticks 1 to 30 times a second");
        Self { tick_hz: hz, ..self }
    }

    /// The wait between two ticks.
    fn tick(&self) -> Duration {
        Duration::from_micros(1_000_000 / u64::from(self.tick_hz.clamp(1, MAX_TICK_HZ)))
    }
}

/// How a [`Kind`] starts its game: from the host's `layout` and the lobby (`ctx.players()`), or why it cannot.
pub type Create = fn(layout: &Value, ctx: &mut Ctx) -> Result<Box<dyn Game>, GameError>;

// ---- Helpers for games

/// Distance on the ground (x and z), ignoring height.
pub fn distance_xz(a: [f64; 3], b: [f64; 3]) -> f64 {
    (a[0] - b[0]).hypot(a[2] - b[2])
}

/// Whether `point` lies within `radius` of `center` on the ground.
pub fn within(center: [f64; 3], point: [f64; 3], radius: f64) -> bool {
    distance_xz(center, point) <= radius
}

/// One of `items` at random; None when there are none.
pub fn pick<'a, T>(rng: &mut StdRng, items: &'a [T]) -> Option<&'a T> {
    if items.is_empty() { None } else { items.get(rng.gen_range(0..items.len())) }
}

/// `count` different items at random (all of them, shuffled, when there are fewer).
pub fn pick_many<T: Clone>(rng: &mut StdRng, items: &[T], count: usize) -> Vec<T> {
    let mut chosen: Vec<T> = items.to_vec();
    // A partial Fisher–Yates shuffle: the first `count` places are a uniform sample.
    let count = count.min(chosen.len());
    for index in 0..count {
        let other = rng.gen_range(index..chosen.len());
        chosen.swap(index, other);
    }
    chosen.truncate(count);
    chosen
}

/// A point of a layout: `[x, y, z]`, finite, no farther than [`MAX_COORDINATE`] on any axis.
pub fn point(value: &Value) -> Result<[f64; 3], GameError> {
    let Some([x, y, z]) = value.as_array().map(Vec::as_slice) else { return Err(BAD_LAYOUT) };
    let mut point = [0.0; 3];
    for (slot, value) in point.iter_mut().zip([x, y, z]) {
        *slot = value.as_f64().filter(|v| v.is_finite() && v.abs() <= MAX_COORDINATE).ok_or(BAD_LAYOUT)?;
    }
    Ok(point)
}

/// `layout[field]`: a list of `min` to `max` points (see [`point`]).
pub fn layout_points(layout: &Value, field: &str, min: usize, max: usize) -> Result<Vec<[f64; 3]>, GameError> {
    let list = layout.get(field).and_then(Value::as_array).ok_or(BAD_LAYOUT)?;
    if !(min..=max).contains(&list.len()) {
        return Err(BAD_LAYOUT);
    }
    list.iter().map(point).collect()
}

/// `points` without the ones within `gap` (on the ground) of an earlier one.
pub fn distinct(points: Vec<[f64; 3]>, gap: f64) -> Vec<[f64; 3]> {
    let mut kept: Vec<[f64; 3]> = Vec::with_capacity(points.len());
    for point in points {
        if !kept.iter().any(|other| within(*other, point, gap)) {
            kept.push(point);
        }
    }
    kept
}

// ---- Sessions

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Lobby,
    Playing,
    Ended,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Lobby => "lobby",
            Self::Playing => "playing",
            Self::Ended => "ended",
        }
    }
}

struct Player {
    id: Uuid,
    name: String,
    /// The live-room peer whose position is this player's: the one their game socket was bound to, or another of
    /// theirs once that one has gone (a reconnected room).
    peer: Option<String>,
    /// Since when they have had no peer in the live room.
    away_since: Option<Millis>,
}

struct Session {
    /// Tells this session from a later one on the same island (whose ticker this is).
    id: u64,
    kind: &'static Kind,
    phase: Phase,
    /// In the order they joined; the first is the host.
    players: Vec<Player>,
    game: Option<Box<dyn Game>>,
    result: Option<Value>,
    rng: StdRng,
    seq: u64,
    /// When someone last did something with the session, or its game started or ended.
    active_at: Millis,
    /// Wakes the ticker when the game starts, so it ticks at once instead of after its idle wait.
    wake: Arc<Notify>,
}

impl Session {
    fn host(&self) -> Option<Uuid> {
        self.players.first().map(|player| player.id)
    }

    fn has(&self, user: Uuid) -> bool {
        self.players.iter().any(|player| player.id == user)
    }

    fn members(&self) -> Vec<Member> {
        self.players.iter().map(|player| Member { id: player.id, name: player.name.clone() }).collect()
    }

    /// Ends the game once it has a result.
    fn settle(&mut self, now: Millis) {
        if self.phase != Phase::Playing {
            return;
        }
        if let Some(result) = self.game.as_ref().and_then(|game| game.result()) {
            self.phase = Phase::Ended;
            self.result = Some(result);
            self.active_at = now;
        }
    }

    /// Takes `user` out of the session, and out of its game when one is playing.
    fn remove(&mut self, user: Uuid, room: &[RoomPeer], now: Millis) -> Vec<(Audience, Value)> {
        self.players.retain(|player| player.id != user);
        let mut events = Vec::new();
        if self.phase == Phase::Playing {
            let members = self.members();
            let positions = positions(&self.players, room);
            if let Some(game) = self.game.as_mut() {
                let mut ctx = Ctx::new(now, &members, &positions, &mut self.rng);
                game.leave(user, &mut ctx);
                events = ctx.into_events();
            }
            self.settle(now);
        }
        events
    }

    /// The session as `viewer` may see it, without `seq` and `now` (which change on every send).
    fn view(&self, viewer: Uuid, now: Millis) -> Value {
        let playing = self.has(viewer).then_some(viewer);
        json!({
            "kind": self.kind.kind,
            "phase": self.phase.name(),
            "host": self.host(),
            "players": self.players.iter().map(|player| json!({
                "id": player.id,
                "name": player.name,
                "peer": player.peer,
            })).collect::<Vec<_>>(),
            "you": viewer,
            "game": self.game.as_ref().map(|game| game.view(playing, now)),
            "result": self.result,
        })
    }
}

/// The peer that stands for `player` in the room: theirs as bound if it is still there, else another of theirs (one
/// that has a position first).
fn locate<'a>(player: &Player, room: &'a [RoomPeer]) -> Option<&'a RoomPeer> {
    let bound = player.peer.as_deref();
    room.iter()
        .find(|peer| Some(peer.id.as_str()) == bound && peer.user == player.id)
        .or_else(|| room.iter().filter(|peer| peer.user == player.id).max_by_key(|peer| peer.position.is_some()))
}

/// Where the players stand, by user id; those without a placed peer are left out.
fn positions(players: &[Player], room: &[RoomPeer]) -> HashMap<Uuid, [f64; 3]> {
    players.iter().filter_map(|player| Some((player.id, locate(player, room)?.position?))).collect()
}

// ---- Sockets and islands

struct Watcher {
    tx: mpsc::Sender<Message>,
    close: watch::Sender<Option<(u16, &'static str)>>,
    user: User,
    name: String,
    /// The login session the socket belongs to.
    session: String,
    /// The live-room peer this socket's page holds.
    peer: String,
    /// The session view last sent, without `seq` and `now`.
    shown: Option<String>,
    messages: RateWindow,
    invalid: RateWindow,
}

fn text(message: &Value) -> Message {
    Message::Text(message.to_string().into())
}

/// Queues `frame` for `watcher`. A socket whose queue is full has stopped reading; skipping frames would leave it
/// with a stale view, so it is closed and reconnects to a fresh one.
fn deliver(watcher: &Watcher, frame: Message) {
    if let Err(mpsc::error::TrySendError::Full(_)) = watcher.tx.try_send(frame) {
        watcher.close.send_replace(Some((4408, "too slow")));
    }
}

fn refusal(error: GameError) -> Message {
    text(&json!({"type": "Error", "code": error.code, "message": error.message}))
}

#[derive(Default)]
struct Island {
    watchers: HashMap<String, Watcher>,
    session: Option<Session>,
}

impl Island {
    /// Sends each watcher whose view changed the new one.
    fn publish(&mut self, now: Millis) {
        let mut views: HashMap<Uuid, (String, Value)> = HashMap::new();
        let mut changed: Vec<String> = Vec::new();
        for (id, watcher) in &self.watchers {
            let (shown, _) = views.entry(watcher.user.id).or_insert_with(|| {
                let view = self.session.as_ref().map_or(Value::Null, |session| session.view(watcher.user.id, now));
                (view.to_string(), view)
            });
            if watcher.shown.as_deref() != Some(shown.as_str()) {
                changed.push(id.clone());
            }
        }
        if changed.is_empty() {
            return;
        }
        let seq = self.session.as_mut().map(|session| {
            session.seq += 1;
            session.seq
        });
        for id in changed {
            let Some(watcher) = self.watchers.get_mut(&id) else { continue };
            let Some((shown, view)) = views.get(&watcher.user.id) else { continue };
            let mut session = view.clone();
            if let (Value::Object(fields), Some(seq)) = (&mut session, seq) {
                fields.insert("seq".into(), json!(seq));
                fields.insert("now".into(), json!(now));
            }
            watcher.shown = Some(shown.clone());
            deliver(watcher, text(&json!({"type": "Session", "session": session})));
        }
    }

    /// Sends what a game emitted, after the views it goes with.
    fn announce(&self, kind: &str, events: Vec<(Audience, Value)>) {
        for (audience, event) in events {
            let frame = text(&json!({"type": "Event", "kind": kind, "event": event}));
            for watcher in self.watchers.values().filter(|watcher| audience.includes(watcher.user.id)) {
                deliver(watcher, frame.clone());
            }
        }
    }
}

struct Hub {
    islands: HashMap<String, Island>,
    connections: usize,
    /// Open game sockets per account.
    accounts: HashMap<Uuid, usize>,
    /// Session ids handed out.
    sessions: u64,
    /// Where each session's own random numbers come from.
    seeds: StdRng,
}

/// How a received frame leaves its socket.
pub(crate) enum Flow {
    Continue,
    Close(u16, &'static str),
    /// A new session opened: the socket's task starts its ticker.
    Opened(u64),
}

#[derive(Default)]
struct Outcome {
    opened: Option<u64>,
    events: Vec<(Audience, Value)>,
}

/// Who sent a message: the watcher's account, name and bound peer.
struct Caller {
    user: Uuid,
    name: String,
    peer: String,
}

impl Caller {
    /// The caller's peer in the room now: the one their socket holds, else another of theirs.
    fn peer_in(&self, room: &[RoomPeer]) -> Option<String> {
        room.iter()
            .find(|peer| peer.id == self.peer && peer.user == self.user)
            .or_else(|| room.iter().find(|peer| peer.user == self.user))
            .map(|peer| peer.id.clone())
    }

    fn player(&self, peer: String) -> Player {
        Player { id: self.user, name: self.name.clone(), peer: Some(peer), away_since: None }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ClientMessage {
    Open {
        kind: String,
    },
    Join,
    Leave,
    Start {
        #[serde(default)]
        layout: Value,
    },
    Act {
        #[serde(default)]
        action: Value,
    },
    Close,
    Ping {
        // Echoed untouched, so the sender's `Date.now()` comes back as the integer it sent.
        ts: Option<serde_json::Number>,
    },
}

impl ClientMessage {
    fn valid(&self) -> bool {
        match self {
            Self::Open { kind } => !kind.is_empty() && kind.len() <= MAX_KIND,
            _ => true,
        }
    }
}

/// The server's clock (see [`Millis`]).
struct Clock {
    origin: Instant,
    origin_ms: Millis,
}

impl Clock {
    fn new() -> Self {
        let wall = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
        Self { origin: Instant::now(), origin_ms: Millis::try_from(wall.as_millis()).unwrap_or(0) }
    }

    fn now(&self) -> Millis {
        self.origin_ms + Millis::try_from(self.origin.elapsed().as_millis()).unwrap_or(Millis::MAX / 2)
    }
}

struct Inner {
    hub: Mutex<Hub>,
    kinds: &'static [Kind],
    clock: Clock,
}

/// Every island's game sockets and sessions.
#[derive(Clone)]
pub struct Games {
    inner: Arc<Inner>,
}

impl Default for Games {
    fn default() -> Self {
        Self::new(KINDS, None)
    }
}

impl Games {
    /// The server's games over `kinds`; with a `seed`, every session's random numbers are reproducible.
    pub(crate) fn new(kinds: &'static [Kind], seed: Option<u64>) -> Self {
        let seeds = seed.map_or_else(StdRng::from_entropy, StdRng::seed_from_u64);
        let hub = Hub { islands: HashMap::new(), connections: 0, accounts: HashMap::new(), sessions: 0, seeds };
        Self { inner: Arc::new(Inner { hub: Mutex::new(hub), kinds, clock: Clock::new() }) }
    }

    fn hub(&self) -> MutexGuard<'_, Hub> {
        self.inner.hub.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// The server's clock now.
    pub fn now(&self) -> Millis {
        self.inner.clock.now()
    }

    /// Open game sockets.
    pub fn count(&self) -> usize {
        self.hub().connections
    }

    /// Islands with game sockets or a session.
    pub fn islands(&self) -> Vec<String> {
        self.hub().islands.keys().cloned().collect()
    }

    fn register(
        &self,
        island: &str,
        user: User,
        session: String,
        peer: String,
        tx: mpsc::Sender<Message>,
        now: Millis,
    ) -> ApiResult<Registration> {
        let mut hub = self.hub();
        if hub.connections >= SERVER_CAPACITY {
            return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "game", "게임 서버가 가득 찼어요."));
        }
        if hub.accounts.get(&user.id).is_some_and(|open| *open >= ACCOUNT_CAPACITY) {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "game",
                "이 계정으로 열어 둔 게임 연결이 너무 많아요. 다른 탭을 닫고 다시 시도해 주세요.",
            ));
        }
        let place = hub.islands.entry(island.to_owned()).or_default();
        if place.watchers.len() >= ISLAND_CAPACITY {
            return Err(conflict("game", "이 섬의 게임에 사람이 가득 찼어요."));
        }
        let id = Uuid::new_v4().to_string();
        let account = user.id;
        let name = if user.display_name.is_empty() { user.username.clone() } else { user.display_name.clone() };
        let (close, cancelled) = watch::channel(None);
        place.watchers.insert(
            id.clone(),
            Watcher {
                tx,
                close,
                user,
                name,
                session: session.clone(),
                peer,
                shown: None,
                messages: RateWindow::new(),
                invalid: RateWindow::new(),
            },
        );
        // The new socket learns the session at once.
        place.publish(now);
        hub.connections += 1;
        *hub.accounts.entry(account).or_default() += 1;
        Ok(Registration { games: self.clone(), island: island.to_owned(), id, user: account, session, cancelled })
    }

    fn remove(&self, island: &str, id: &str) {
        let mut hub = self.hub();
        let Some(place) = hub.islands.get_mut(island) else { return };
        let Some(watcher) = place.watchers.remove(id) else { return };
        if place.watchers.is_empty() && place.session.is_none() {
            hub.islands.remove(island);
        }
        hub.connections -= 1;
        if let Some(open) = hub.accounts.get_mut(&watcher.user.id) {
            *open -= 1;
            if *open == 0 {
                hub.accounts.remove(&watcher.user.id);
            }
        }
    }

    /// Closes one socket (which takes it off the island); its player stays in the game.
    fn close_watcher(&self, island: &str, id: &str, code: u16, reason: &'static str) {
        if let Some(watcher) = self.hub().islands.get(island).and_then(|place| place.watchers.get(id)) {
            // Independent of the bounded outbound queue, so a full queue cannot delay it.
            watcher.close.send_replace(Some((code, reason)));
        }
        self.remove(island, id);
    }

    /// Closes the sockets of a login session that ended.
    pub fn end_session(&self, session: &str) {
        let sockets: Vec<(String, String)> = self
            .hub()
            .islands
            .iter()
            .flat_map(|(island, place)| {
                place
                    .watchers
                    .iter()
                    .filter(|(_, watcher)| watcher.session == session)
                    .map(|(id, _)| (island.clone(), id.clone()))
            })
            .collect();
        for (island, id) in sockets {
            self.close_watcher(&island, &id, 4401, "session ended");
        }
    }

    /// Everyone with a game socket on `island`: each socket's id and who holds it.
    fn occupants(&self, island: &str) -> Vec<(String, User)> {
        let hub = self.hub();
        hub.islands
            .get(island)
            .into_iter()
            .flat_map(|place| place.watchers.iter().map(|(id, watcher)| (id.clone(), watcher.user.clone())))
            .collect()
    }

    /// The session's wake-up, when `id` is still the island's session.
    fn wake(&self, island: &str, id: u64) -> Option<Arc<Notify>> {
        let hub = self.hub();
        let session = hub.islands.get(island)?.session.as_ref().filter(|session| session.id == id)?;
        Some(session.wake.clone())
    }

    /// Handles one frame from socket `id` on `island`, with the island's live room as `room` shows it now.
    pub(crate) fn receive(&self, island: &str, id: &str, raw: &str, room: &[RoomPeer], now: Millis) -> Flow {
        // Read before the hub is locked: every island's frames wait on that lock.
        let message = serde_json::from_str::<ClientMessage>(raw).ok().filter(ClientMessage::valid);
        let instant = Instant::now();
        let mut guard = self.hub();
        let Hub { islands, sessions, seeds, .. } = &mut *guard;
        let Some(place) = islands.get_mut(island) else { return Flow::Close(1011, "island closed") };
        let Some(watcher) = place.watchers.get_mut(id) else { return Flow::Close(1011, "socket closed") };
        if !watcher.messages.allow(instant, MESSAGES_PER_SECOND) {
            return Flow::Close(4429, "too many messages");
        }
        let Some(message) = message else {
            return if watcher.invalid.allow(instant, INVALID_PER_SECOND) {
                Flow::Continue
            } else {
                Flow::Close(4400, "malformed messages")
            };
        };
        let caller = Caller { user: watcher.user.id, name: watcher.name.clone(), peer: watcher.peer.clone() };
        let before = place.session.as_ref().map(|session| session.kind.kind);
        let done = match message {
            ClientMessage::Ping { ts } => {
                deliver(watcher, text(&json!({"type": "Pong", "ts": ts})));
                return Flow::Continue;
            }
            ClientMessage::Open { kind } => {
                let kind = self.inner.kinds.iter().find(|known| known.kind == kind);
                open(place, &caller, kind, room, now, || {
                    *sessions += 1;
                    (*sessions, StdRng::seed_from_u64(seeds.next_u64()))
                })
            }
            ClientMessage::Join => join(place, &caller, room, now),
            ClientMessage::Leave => leave(place, &caller, room, now),
            ClientMessage::Start { layout } => start(place, &caller, &layout, room, now),
            ClientMessage::Act { action } => act(place, &caller, &action, room, now),
            ClientMessage::Close => close(place, &caller),
        };
        match done {
            Ok(outcome) => {
                let kind = place.session.as_ref().map(|session| session.kind.kind).or(before).unwrap_or_default();
                place.publish(now);
                place.announce(kind, outcome.events);
                outcome.opened.map_or(Flow::Continue, Flow::Opened)
            }
            Err(error) => {
                if let Some(watcher) = place.watchers.get(id) {
                    deliver(watcher, refusal(error));
                }
                Flow::Continue
            }
        }
    }

    /// One beat of session `id` on `island`: players out of the room for too long leave, an idle session closes, a
    /// playing game ticks, and changed views and events go out. Returns how long to wait before the next beat, or None
    /// once the session is gone.
    pub(crate) fn step(&self, island: &str, id: u64, room: &[RoomPeer], now: Millis) -> Option<Duration> {
        let mut hub = self.hub();
        let place = hub.islands.get_mut(island)?;
        let session = place.session.as_mut().filter(|session| session.id == id)?;
        let kind = session.kind.kind;
        let mut events = Vec::new();
        let mut gone = Vec::new();
        for player in &mut session.players {
            match locate(player, room) {
                Some(peer) => {
                    player.peer = Some(peer.id.clone());
                    player.away_since = None;
                }
                None => {
                    player.peer = None;
                    let since = *player.away_since.get_or_insert(now);
                    if now.saturating_sub(since) >= AWAY_LIMIT {
                        gone.push(player.id);
                    }
                }
            }
        }
        for user in gone {
            events.extend(session.remove(user, room, now));
        }
        let over = session.players.is_empty() || now.saturating_sub(session.active_at) >= IDLE_LIMIT;
        let wait = if over {
            None
        } else {
            if session.phase == Phase::Playing {
                let members = session.members();
                let positions = positions(&session.players, room);
                if let Some(game) = session.game.as_mut() {
                    let mut ctx = Ctx::new(now, &members, &positions, &mut session.rng);
                    game.tick(&mut ctx);
                    events.extend(ctx.into_events());
                }
                session.settle(now);
            }
            Some(if session.phase == Phase::Playing { session.kind.tick() } else { IDLE_TICK })
        };
        if wait.is_none() {
            place.session = None;
        }
        place.publish(now);
        place.announce(kind, events);
        if place.session.is_none() && place.watchers.is_empty() {
            hub.islands.remove(island);
        }
        wait
    }
}

/// `Open`: a new lobby, or the host's lobby again (of `kind`) after a game or in place of another.
fn open(
    place: &mut Island,
    caller: &Caller,
    kind: Option<&'static Kind>,
    room: &[RoomPeer],
    now: Millis,
    next: impl FnOnce() -> (u64, StdRng),
) -> Result<Outcome, GameError> {
    let kind = kind.ok_or(UNKNOWN_GAME)?;
    let peer = caller.peer_in(room).ok_or(NOT_IN_ROOM_GAME)?;
    match place.session.as_mut() {
        None => {
            let (id, rng) = next();
            place.session = Some(Session {
                id,
                kind,
                phase: Phase::Lobby,
                players: vec![caller.player(peer)],
                game: None,
                result: None,
                rng,
                seq: 0,
                active_at: now,
                wake: Arc::new(Notify::new()),
            });
            Ok(Outcome { opened: Some(id), events: Vec::new() })
        }
        Some(session) if session.host() == Some(caller.user) && session.phase != Phase::Playing => {
            session.kind = kind;
            session.phase = Phase::Lobby;
            session.game = None;
            session.result = None;
            session.players.truncate(kind.max_players);
            session.active_at = now;
            Ok(Outcome::default())
        }
        Some(session) if session.phase == Phase::Playing => Err(IN_PROGRESS),
        Some(_) => Err(GAME_EXISTS),
    }
}

fn join(place: &mut Island, caller: &Caller, room: &[RoomPeer], now: Millis) -> Result<Outcome, GameError> {
    let session = place.session.as_mut().ok_or(NO_GAME)?;
    if session.has(caller.user) {
        return Ok(Outcome::default());
    }
    if session.phase != Phase::Lobby {
        return Err(NOT_LOBBY);
    }
    if session.players.len() >= session.kind.max_players {
        return Err(FULL);
    }
    let peer = caller.peer_in(room).ok_or(NOT_IN_ROOM_GAME)?;
    session.players.push(caller.player(peer));
    session.active_at = now;
    Ok(Outcome::default())
}

fn leave(place: &mut Island, caller: &Caller, room: &[RoomPeer], now: Millis) -> Result<Outcome, GameError> {
    let session = place.session.as_mut().ok_or(NO_GAME)?;
    if !session.has(caller.user) {
        return Err(NOT_PLAYER);
    }
    let events = session.remove(caller.user, room, now);
    session.active_at = now;
    if session.players.is_empty() {
        place.session = None;
    }
    Ok(Outcome { opened: None, events })
}

fn start(
    place: &mut Island,
    caller: &Caller,
    layout: &Value,
    room: &[RoomPeer],
    now: Millis,
) -> Result<Outcome, GameError> {
    let session = place.session.as_mut().ok_or(NO_GAME)?;
    if session.host() != Some(caller.user) {
        return Err(NOT_HOST);
    }
    if session.phase != Phase::Lobby {
        return Err(NOT_LOBBY);
    }
    if session.players.len() < session.kind.min_players {
        return Err(TOO_FEW);
    }
    if session.players.len() > session.kind.max_players {
        return Err(FULL);
    }
    let members = session.members();
    let positions = positions(&session.players, room);
    let mut ctx = Ctx::new(now, &members, &positions, &mut session.rng);
    let game = (session.kind.create)(layout, &mut ctx)?;
    let events = ctx.into_events();
    session.game = Some(game);
    session.phase = Phase::Playing;
    session.active_at = now;
    session.settle(now);
    session.wake.notify_one();
    Ok(Outcome { opened: None, events })
}

fn act(
    place: &mut Island,
    caller: &Caller,
    action: &Value,
    room: &[RoomPeer],
    now: Millis,
) -> Result<Outcome, GameError> {
    let session = place.session.as_mut().ok_or(NO_GAME)?;
    if session.phase != Phase::Playing {
        return Err(NOT_PLAYING);
    }
    if !session.has(caller.user) {
        return Err(NOT_PLAYER);
    }
    let members = session.members();
    let positions = positions(&session.players, room);
    let game = session.game.as_mut().ok_or(NOT_PLAYING)?;
    let mut ctx = Ctx::new(now, &members, &positions, &mut session.rng);
    game.act(caller.user, action, &mut ctx)?;
    let events = ctx.into_events();
    session.active_at = now;
    session.settle(now);
    Ok(Outcome { opened: None, events })
}

fn close(place: &mut Island, caller: &Caller) -> Result<Outcome, GameError> {
    let session = place.session.as_ref().ok_or(NO_GAME)?;
    if session.host() != Some(caller.user) {
        return Err(NOT_HOST);
    }
    place.session = None;
    Ok(Outcome::default())
}

/// Holds a socket's place on its island; the socket task owns it, so the place never outlives the socket.
struct Registration {
    games: Games,
    island: String,
    id: String,
    user: Uuid,
    session: String,
    cancelled: watch::Receiver<Option<(u16, &'static str)>>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.games.remove(&self.island, &self.id);
    }
}

pub fn router(state: AppState) -> Router {
    Router::new().route("/api/games/{username}", get(upgrade)).with_state(state)
}

#[derive(Deserialize)]
struct GameQuery {
    ticket: String,
    /// The `client_id` the island's live room gave this page.
    peer: Option<String>,
}

async fn upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<GameQuery>,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    if !same_origin(&state, &headers) {
        return Err(FOREIGN_ORIGIN);
    }
    let claims = state.rooms.verify(&state.config.ticket_secret, &query.ticket).ok_or(BAD_TICKET)?;
    if !auth::active_session(&state, &claims.session, claims.sub).await? {
        return Err(BAD_TICKET);
    }
    let viewer = User { id: claims.sub, username: claims.username, display_name: claims.name, role: "user".into() };
    let (home, _) = visible_home(&state, &name, Some(&viewer)).await?;
    // Only someone in the island's live room plays: their position there is where they stand in the game.
    let room = state.rooms.peers(&home.username);
    let wanted = query.peer.as_deref().filter(|peer| peer.len() <= MAX_PEER);
    let peer = room
        .iter()
        .filter(|peer| peer.user == viewer.id)
        .find(|peer| wanted.is_none_or(|wanted| peer.id == wanted))
        .map(|peer| peer.id.clone())
        .ok_or(NOT_IN_ROOM)?;
    let (tx, rx) = mpsc::channel(OUTBOUND_CAPACITY);
    let registration = state.games.register(&home.username, viewer, claims.session, peer, tx, state.games.now())?;
    Ok(ws
        .max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| connection(socket, registration, rx, state)))
}

/// Closes the game sockets of whoever may no longer view `owner`'s island (see [`crate::rooms::revalidate`]); they
/// leave its game once they have been out of its live room long enough.
pub async fn revalidate(state: &AppState, owner: &str) {
    let mut checked: HashMap<Uuid, bool> = HashMap::new();
    for (id, user) in state.games.occupants(owner) {
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
            state.games.close_watcher(owner, &id, 4403, "no access");
        }
    }
}

/// The session and the island's visibility, checked again every [`HEARTBEAT_INTERVAL`] on a task of their own, as the
/// live room does.
async fn watch_access(state: AppState, island: String, id: String, session: String, user: Uuid) {
    let mut every = tokio::time::interval(HEARTBEAT_INTERVAL);
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        every.tick().await;
        if let Ok(false) = auth::active_session(&state, &session, user).await {
            state.games.close_watcher(&island, &id, 4401, "session ended");
            return;
        }
        let Some(viewer) =
            state.games.occupants(&island).into_iter().find(|(socket, _)| socket == &id).map(|(_, user)| user)
        else {
            return;
        };
        if let Err(error) = visible_home(&state, &island, Some(&viewer)).await
            && matches!(error.status, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND)
        {
            state.games.close_watcher(&island, &id, 4403, "no access");
            return;
        }
    }
}

/// Beats session `id` until it is gone: at its kind's tick rate while it plays, once a second otherwise.
async fn run(state: AppState, island: String, id: u64) {
    let Some(wake) = state.games.wake(&island, id) else { return };
    loop {
        let room = state.rooms.peers(&island);
        let Some(wait) = state.games.step(&island, id, &room, state.games.now()) else { return };
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = wake.notified() => {}
        }
    }
}

async fn connection(
    mut socket: WebSocket,
    mut registration: Registration,
    mut outbound: mpsc::Receiver<Message>,
    state: AppState,
) {
    let access = tokio::spawn(watch_access(
        state.clone(),
        registration.island.clone(),
        registration.id.clone(),
        registration.session.clone(),
        registration.user,
    ));
    let _access = AbortOnDrop(access);
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
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
                    let room = state.rooms.peers(&registration.island);
                    let flow = state.games.receive(
                        &registration.island,
                        &registration.id,
                        raw.as_str(),
                        &room,
                        state.games.now(),
                    );
                    match flow {
                        Flow::Continue => {}
                        Flow::Close(code, reason) => break Some((code, reason)),
                        // The session's ticker runs on its own and ends with the session, whoever's socket opened it.
                        Flow::Opened(id) => {
                            tokio::spawn(run(state.clone(), registration.island.clone(), id));
                        }
                    }
                }
                Some(Ok(Message::Binary(_))) => break Some((1003, "text frames only")),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => last_seen = Instant::now(),
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break None,
            },
            outgoing = outbound.recv() => match outgoing {
                Some(message) => {
                    if !send_queued(&mut socket, message, &mut outbound).await { break None; }
                }
                None => break *registration.cancelled.borrow(),
            },
            _ = heartbeat.tick() => {
                if last_seen.elapsed() >= HEARTBEAT_TIMEOUT { break Some((4000, "heartbeat timeout")); }
                if !send(&mut socket, Message::Ping(Vec::new().into())).await { break None; }
            }
        }
    };
    let closing = (*registration.cancelled.borrow()).or(closing);
    let mut closed = false;
    if let Some((code, reason)) = closing {
        closed = send(&mut socket, Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await;
    }
    drop(registration);
    if closed {
        let _ = tokio::time::timeout(CLOSE_GRACE, async { while let Some(Ok(_)) = socket.recv().await {} }).await;
    }
}

#[cfg(test)]
mod tests;
