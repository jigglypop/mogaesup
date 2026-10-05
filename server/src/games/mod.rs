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
//! - `{"type":"Open","kind":"impostor"}`: opens a lobby when the island has no session; the sender hosts it and is its
//!   first player. The host of a lobby or of a finished game may open again: a lobby of `kind` with the same players.
//! - `{"type":"Join"}`, `{"type":"Leave"}`: joins the lobby; leaves the session (in any phase).
//! - `{"type":"Start","layout":{…}}`: the host starts the lobby's game once it has enough players. `layout` is data the
//!   host's page computed from the island it has loaded (open spots, say), in the game's own shape; the game checks it.
//! - `{"type":"Act","action":{…}}`: a player's move, in the game's own shape (from someone watching, see
//!   [`Game::watch`]).
//! - `{"type":"Close"}`: the host, or the island's owner, ends the session for everyone.
//! - `{"type":"Ping","ts":n}`: answered with `{"type":"Pong","ts":n}`.
//!
//! Server → client:
//! - `{"type":"Session","session":null|{…}}` on connecting and whenever what this viewer may see changes:
//!   `kind`, `phase` (`lobby`|`playing`|`ended`), `host` (user id; the first of `players`), `players`
//!   (`[{id, name, peer}]` in the order they joined; `peer` is the player's live-room `client_id`, null while they are
//!   not in the room), `you` (the viewer's user id), `game` (the game's view for this viewer, null in the lobby),
//!   `result` (once ended), `seq` (rises with every update the session sends) and `now` (the server's clock in ms, for
//!   countdowns).
//! - `{"type":"Event","kind":"impostor","event":{…}}`: something a game announced ([`Ctx::emit`]).
//! - `{"type":"Error","code":"not_host","message":"…"}`: why a message was refused, to its sender only; and
//!   `game_failed`, to everyone, when a game's code failed and its session ended.
//! - `{"type":"Pong","ts":n}`.
//!
//! # Lifetime
//!
//! `Lobby` → `Playing` (a [`Game`] runs, ticked at its kind's rate) → `Ended` (the result stays until the host opens
//! again or closes). A host who leaves hands the session to the earliest player left; the last player leaving closes
//! it, and so does nobody touching it for ten minutes (a game that plays on while its players are in the live room is
//! being played). A player out of the live room for ten seconds leaves. A game whose code panics ends its session:
//! everyone watching is told `game_failed`, and every other island plays on.
//!
//! # Adding a game
//!
//! A game is a plugin: one file `games/<name>.rs` with a type implementing [`Game`] and a
//! `pub(crate) const KIND: Kind = Kind::new(…)` (its name, player limits, tick rate and `create`), and its name on one
//! line of the `registry!` below (a game with more than one file is a folder `games/<name>/` with its `mod.rs`). The
//! client side is a folder `frontend/src/games/<name>/` and one line in its registry. `docs/game-plugins.md` walks
//! through both; `impostor` is the one the island runs.

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
    panic::AssertUnwindSafe,
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
    rooms::{BAD_TICKET, MESSAGE_WINDOW, RateWindow, RoomPeer, Standing, seat, send, send_queued, standing},
    security::{FOREIGN_ORIGIN, client_address, same_origin},
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
    impostor,
    kart,
}

/// Milliseconds on the server's clock: what games measure time in, and what views carry (`endsAt`). Monotonic, and
/// close to Unix time, so a page can count down against `Session.now`.
pub type Millis = u64;

/// How far from the island's centre a layout point may be, on each axis.
pub const MAX_COORDINATE: f64 = 200.0;

const MAX_MESSAGE_BYTES: usize = 16 * 1024;
const OUTBOUND_CAPACITY: usize = 256;
/// Game sockets on one island besides its owner's, as many as its live room holds (see [`seat`]).
const ISLAND_CAPACITY: usize = 30;
const SERVER_CAPACITY: usize = 512;
/// Game sockets one account may have open at once, as in the live room.
const ACCOUNT_CAPACITY: usize = 4;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(45);
/// How long a socket we closed is kept for the peer's answer.
const CLOSE_GRACE: Duration = Duration::from_secs(2);
/// Frames a socket may send over [`MESSAGE_WINDOW`] (three seconds), as the live room counts them: a phone whose link
/// stalled delivers its moves at once, and that burst must not close it. A sustained flood still does.
const MESSAGES_PER_WINDOW: usize = 120;
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
/// A session nobody has touched for this long closes; a game playing while its players are in the live room is
/// touched by every tick.
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
/// Sent to everyone watching when a game's code failed and its session ended.
const GAME_FAILED: GameError = GameError::new("game_failed", "게임에 문제가 생겨 끝났어요.");
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
    /// Everyone but these players' sockets.
    Except(Vec<Uuid>),
}

impl Audience {
    fn includes(&self, user: Uuid) -> bool {
        match self {
            Self::Everyone => true,
            Self::Only(players) => players.contains(&user),
            Self::Except(players) => !players.contains(&user),
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

    /// Sends `event` to everyone watching but these players (whoever it came from, say).
    pub fn emit_except(&mut self, players: &[Uuid], event: Value) {
        self.events.push((Audience::Except(players.to_vec()), event));
    }

    /// The events emitted so far, in order.
    pub fn events(&self) -> &[(Audience, Value)] {
        &self.events
    }

    fn into_events(self) -> Vec<(Audience, Value)> {
        self.events
    }
}

/// A game in play. The framework holds it behind its island's lock, so no method may block or wait. A method that
/// panics ends the session (see the module's Lifetime).
///
/// Views are compared per viewer before they are sent, so a view that has not changed is not sent again: put absolute
/// times in them (`endsAt`, on the server's clock) rather than what is left.
pub trait Game: Send {
    /// What `viewer` may see now: Some(player) for a player, None for someone watching. Secrets go only to whom they
    /// belong to.
    fn view(&self, viewer: Option<Uuid>, now: Millis) -> Value;

    /// A player's action. Err refuses it, telling that player why; a refused action must change nothing.
    fn act(&mut self, player: Uuid, action: &Value, ctx: &mut Ctx) -> Result<(), GameError>;

    /// An action from someone watching, not playing (asking for what they missed, say), as [`Game::act`] takes a
    /// player's. Refused unless a game takes some.
    fn watch(&mut self, _viewer: Uuid, _action: &Value, _ctx: &mut Ctx) -> Result<(), GameError> {
        Err(NOT_PLAYER)
    }

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

/// Why a message did nothing: a refusal for its sender, or game code that panicked (its session ends).
#[derive(Debug, PartialEq)]
enum Refused {
    Game(GameError),
    Crashed,
}

impl From<GameError> for Refused {
    fn from(error: GameError) -> Self {
        Self::Game(error)
    }
}

/// Runs game code: a panic in it comes back as [`Refused::Crashed`] instead of unwinding through the framework (and
/// poisoning the island's lock, or ending the ticker's task).
fn guarded<T>(call: impl FnOnce() -> T) -> Result<T, Refused> {
    std::panic::catch_unwind(AssertUnwindSafe(call)).map_err(|_| Refused::Crashed)
}

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
    /// When someone last did something with the session, its game started or ended, or it ticked with players in the
    /// live room.
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
    fn settle(&mut self, now: Millis) -> Result<(), Refused> {
        if self.phase != Phase::Playing {
            return Ok(());
        }
        let Some(game) = self.game.as_ref() else { return Ok(()) };
        if let Some(result) = guarded(|| game.result())? {
            self.phase = Phase::Ended;
            self.result = Some(result);
            self.active_at = now;
        }
        Ok(())
    }

    /// Takes `user` out of the session, and out of its game when one is playing.
    fn remove(&mut self, user: Uuid, room: &[RoomPeer], now: Millis) -> Result<Vec<(Audience, Value)>, Refused> {
        self.players.retain(|player| player.id != user);
        let mut events = Vec::new();
        if self.phase == Phase::Playing {
            let members = self.members();
            let positions = positions(&self.players, room);
            if let Some(game) = self.game.as_mut() {
                let mut ctx = Ctx::new(now, &members, &positions, &mut self.rng);
                guarded(|| game.leave(user, &mut ctx))?;
                events = ctx.into_events();
            }
            self.settle(now)?;
        }
        Ok(events)
    }

    /// The session as `viewer` may see it, without `seq` and `now` (which change on every send). It calls the game, so
    /// only ever through [`guarded`].
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
    /// The island's owner, who may close any session on it and is never counted against anyone else's seats.
    owner: bool,
    /// Where the socket came from ([`client_address`]).
    address: String,
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
    /// Each watcher's view of the session now, one per account, as text and value. It calls the game.
    fn views(&self, now: Millis) -> HashMap<Uuid, (String, Value)> {
        let mut views: HashMap<Uuid, (String, Value)> = HashMap::new();
        for watcher in self.watchers.values() {
            views.entry(watcher.user.id).or_insert_with(|| {
                let view = self.session.as_ref().map_or(Value::Null, |session| session.view(watcher.user.id, now));
                (view.to_string(), view)
            });
        }
        views
    }

    /// Sends each watcher whose view changed the new one. A game whose view panics ends its session first.
    fn publish(&mut self, now: Millis) {
        let views = match guarded(|| self.views(now)) {
            Ok(views) => views,
            Err(_) => {
                self.crash();
                self.views(now)
            }
        };
        let changed: Vec<String> = self
            .watchers
            .iter()
            .filter(|(_, watcher)| {
                views.get(&watcher.user.id).is_some_and(|(shown, _)| watcher.shown.as_deref() != Some(shown.as_str()))
            })
            .map(|(id, _)| id.clone())
            .collect();
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

    /// Ends the session whose game's code panicked (or stopped being ticked), telling everyone watching.
    fn crash(&mut self) {
        let kind = self.session.take().map(|session| session.kind.kind);
        tracing::error!(kind, "A game failed; its session ended");
        let frame = refusal(GAME_FAILED);
        for watcher in self.watchers.values() {
            deliver(watcher, frame.clone());
        }
    }
}

fn lock(island: &Mutex<Island>) -> MutexGuard<'_, Island> {
    island.lock().unwrap_or_else(|error| error.into_inner())
}

/// Every island with game sockets or a session, each behind a lock of its own: one island's game never waits on
/// another's. The hub's lock is taken before an island's, never the other way round.
struct Hub {
    islands: HashMap<String, Arc<Mutex<Island>>>,
    connections: usize,
    /// Open game sockets per account.
    accounts: HashMap<Uuid, usize>,
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
    /// Nothing changed (a Join from a player): no view is built again.
    unchanged: bool,
}

/// Who sent a message: the watcher's account, name and bound peer, and whether they own the island.
struct Caller {
    user: Uuid,
    name: String,
    peer: String,
    owner: bool,
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
    /// Session ids handed out.
    sessions: AtomicU64,
    /// Where each session's own random numbers come from.
    seeds: Mutex<StdRng>,
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

/// Who opens a game socket: their account and login session, the live-room peer their page holds, how they stand with
/// the island and where they come from (for its seats, see [`seat`]).
pub(crate) struct Arrival {
    pub(crate) user: User,
    pub(crate) session: String,
    pub(crate) peer: String,
    pub(crate) standing: Standing,
    pub(crate) address: String,
}

impl Games {
    /// The server's games over `kinds`; with a `seed`, every session's random numbers are reproducible.
    pub(crate) fn new(kinds: &'static [Kind], seed: Option<u64>) -> Self {
        let seeds = seed.map_or_else(StdRng::from_entropy, StdRng::seed_from_u64);
        let hub = Hub { islands: HashMap::new(), connections: 0, accounts: HashMap::new() };
        Self {
            inner: Arc::new(Inner {
                hub: Mutex::new(hub),
                sessions: AtomicU64::new(0),
                seeds: Mutex::new(seeds),
                kinds,
                clock: Clock::new(),
            }),
        }
    }

    fn hub(&self) -> MutexGuard<'_, Hub> {
        self.inner.hub.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// `name`'s island, while it has game sockets or a session.
    fn island(&self, name: &str) -> Option<Arc<Mutex<Island>>> {
        self.hub().islands.get(name).cloned()
    }

    /// A new session's id and random numbers.
    fn next_session(&self) -> (u64, StdRng) {
        let id = self.inner.sessions.fetch_add(1, Ordering::Relaxed) + 1;
        let seed = self.inner.seeds.lock().unwrap_or_else(|error| error.into_inner()).next_u64();
        (id, StdRng::seed_from_u64(seed))
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
        arrival: Arrival,
        tx: mpsc::Sender<Message>,
        now: Millis,
    ) -> ApiResult<Registration> {
        let Arrival { user, session, peer, standing, address } = arrival;
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
        let shared = hub.islands.entry(island.to_owned()).or_default().clone();
        let mut place = lock(&shared);
        let seated = place.watchers.values().map(|watcher| (watcher.user.id, watcher.address.as_str(), watcher.owner));
        if let Err(refused) = seat(standing, user.id, &address, seated, ISLAND_CAPACITY, "game") {
            if place.watchers.is_empty() && place.session.is_none() {
                hub.islands.remove(island);
            }
            return Err(refused);
        }
        let id = Uuid::new_v4().to_string();
        let viewer = user.clone();
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
                owner: standing.owner(),
                address,
                shown: None,
                messages: RateWindow::over(MESSAGE_WINDOW),
                invalid: RateWindow::new(),
            },
        );
        hub.connections += 1;
        *hub.accounts.entry(viewer.id).or_default() += 1;
        // Other islands need not wait while this one's views are built.
        drop(hub);
        // The new socket learns the session at once.
        place.publish(now);
        Ok(Registration { games: self.clone(), island: island.to_owned(), id, viewer, session, cancelled })
    }

    fn remove(&self, island: &str, id: &str) {
        let mut hub = self.hub();
        let Some(shared) = hub.islands.get(island).cloned() else { return };
        let mut place = lock(&shared);
        let Some(watcher) = place.watchers.remove(id) else { return };
        if place.watchers.is_empty() && place.session.is_none() {
            hub.islands.remove(island);
        }
        drop(place);
        hub.connections -= 1;
        if let Some(open) = hub.accounts.get_mut(&watcher.user.id) {
            *open -= 1;
            if *open == 0 {
                hub.accounts.remove(&watcher.user.id);
            }
        }
    }

    /// Drops `island` from the hub once it has neither sockets nor a session.
    fn forget_if_empty(&self, island: &str) {
        let mut hub = self.hub();
        let empty = hub.islands.get(island).is_some_and(|shared| {
            let place = lock(shared);
            place.watchers.is_empty() && place.session.is_none()
        });
        if empty {
            hub.islands.remove(island);
        }
    }

    /// Closes one socket (which takes it off the island); its player stays in the game.
    fn close_watcher(&self, island: &str, id: &str, code: u16, reason: &'static str) {
        if let Some(shared) = self.island(island)
            && let Some(watcher) = lock(&shared).watchers.get(id)
        {
            // Independent of the bounded outbound queue, so a full queue cannot delay it.
            watcher.close.send_replace(Some((code, reason)));
        }
        self.remove(island, id);
    }

    /// Closes the sockets of login session `session` on `island` (on every island when None).
    pub(crate) fn close_session(&self, island: Option<&str>, session: &str, code: u16, reason: &'static str) {
        let islands: Vec<(String, Arc<Mutex<Island>>)> = self
            .hub()
            .islands
            .iter()
            .filter(|(name, _)| island.is_none_or(|island| island == name.as_str()))
            .map(|(name, shared)| (name.clone(), shared.clone()))
            .collect();
        for (name, shared) in islands {
            let sockets: Vec<String> = lock(&shared)
                .watchers
                .iter()
                .filter(|(_, watcher)| watcher.session == session)
                .map(|(id, _)| id.clone())
                .collect();
            for id in sockets {
                self.close_watcher(&name, &id, code, reason);
            }
        }
    }

    /// Closes the sockets of a login session that ended.
    pub fn end_session(&self, session: &str) {
        self.close_session(None, session, 4401, "session ended");
    }

    /// Everyone with a game socket on `island`: each socket's id and who holds it.
    fn occupants(&self, island: &str) -> Vec<(String, User)> {
        let Some(shared) = self.island(island) else { return Vec::new() };
        let place = lock(&shared);
        place.watchers.iter().map(|(id, watcher)| (id.clone(), watcher.user.clone())).collect()
    }

    /// The session's wake-up, when `id` is still the island's session.
    fn wake(&self, island: &str, id: u64) -> Option<Arc<Notify>> {
        let shared = self.island(island)?;
        let place = lock(&shared);
        let session = place.session.as_ref().filter(|session| session.id == id)?;
        Some(session.wake.clone())
    }

    /// Ends session `id` on `island` if it is still there, as a failed game: nothing ticks it any more.
    fn end(&self, island: &str, id: u64, now: Millis) {
        let Some(shared) = self.island(island) else { return };
        let mut place = lock(&shared);
        if place.session.as_ref().is_none_or(|session| session.id != id) {
            return;
        }
        place.crash();
        place.publish(now);
        let empty = place.watchers.is_empty();
        drop(place);
        if empty {
            self.forget_if_empty(island);
        }
    }

    /// Handles one frame from socket `id` on `island`, with the island's live room as `room` shows it now.
    pub(crate) fn receive(&self, island: &str, id: &str, raw: &str, room: &[RoomPeer], now: Millis) -> Flow {
        // Read before the island is locked: its frames and ticks wait on that lock.
        let message = serde_json::from_str::<ClientMessage>(raw).ok().filter(ClientMessage::valid);
        let instant = Instant::now();
        let Some(shared) = self.island(island) else { return Flow::Close(1011, "island closed") };
        let mut guard = lock(&shared);
        let place = &mut *guard;
        let Some(watcher) = place.watchers.get_mut(id) else { return Flow::Close(1011, "socket closed") };
        if !watcher.messages.allow(instant, MESSAGES_PER_WINDOW) {
            return Flow::Close(4429, "too many messages");
        }
        let Some(message) = message else {
            return if watcher.invalid.allow(instant, INVALID_PER_SECOND) {
                Flow::Continue
            } else {
                Flow::Close(4400, "malformed messages")
            };
        };
        let caller = Caller {
            user: watcher.user.id,
            name: watcher.name.clone(),
            peer: watcher.peer.clone(),
            owner: watcher.owner,
        };
        let before = place.session.as_ref().map(|session| session.kind.kind);
        let done = match message {
            ClientMessage::Ping { ts } => {
                deliver(watcher, text(&json!({"type": "Pong", "ts": ts})));
                return Flow::Continue;
            }
            ClientMessage::Open { kind } => {
                let kind = self.inner.kinds.iter().find(|known| known.kind == kind);
                open(place, &caller, kind, room, now, || self.next_session())
            }
            ClientMessage::Join => join(place, &caller, room, now),
            ClientMessage::Leave => leave(place, &caller, room, now),
            ClientMessage::Start { layout } => start(place, &caller, &layout, room, now),
            ClientMessage::Act { action } => act(place, &caller, &action, room, now),
            ClientMessage::Close => close(place, &caller),
        };
        match done {
            Ok(outcome) if outcome.unchanged => Flow::Continue,
            Ok(outcome) => {
                let kind = place.session.as_ref().map(|session| session.kind.kind).or(before).unwrap_or_default();
                place.publish(now);
                place.announce(kind, outcome.events);
                outcome.opened.map_or(Flow::Continue, Flow::Opened)
            }
            Err(Refused::Game(error)) => {
                if let Some(watcher) = place.watchers.get(id) {
                    deliver(watcher, refusal(error));
                }
                Flow::Continue
            }
            Err(Refused::Crashed) => {
                place.crash();
                place.publish(now);
                Flow::Continue
            }
        }
    }

    /// One beat of session `id` on `island`: players out of the room for too long leave, an idle session closes, a
    /// playing game ticks, and changed views and events go out. Returns how long to wait before the next beat, or None
    /// once the session is gone.
    pub(crate) fn step(&self, island: &str, id: u64, room: &[RoomPeer], now: Millis) -> Option<Duration> {
        let shared = self.island(island)?;
        let mut place = lock(&shared);
        let session = place.session.as_mut().filter(|session| session.id == id)?;
        let kind = session.kind.kind;
        let wait = match beat(session, room, now) {
            Ok((wait, events)) => {
                if wait.is_none() {
                    place.session = None;
                }
                place.publish(now);
                place.announce(kind, events);
                wait
            }
            Err(_) => {
                place.crash();
                place.publish(now);
                None
            }
        };
        // A session that ended while its views went out (its game's view panicked) has no next beat.
        let wait = wait.filter(|_| place.session.as_ref().is_some_and(|session| session.id == id));
        let empty = place.session.is_none() && place.watchers.is_empty();
        drop(place);
        if empty {
            self.forget_if_empty(island);
        }
        wait
    }
}

/// What a game announced, for whom.
type Events = Vec<(Audience, Value)>;

/// [`Games::step`]'s work on the session itself: how long until the next beat (None once it is over), and what the game
/// announced.
fn beat(session: &mut Session, room: &[RoomPeer], now: Millis) -> Result<(Option<Duration>, Events), Refused> {
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
        events.extend(session.remove(user, room, now)?);
    }
    // A game that plays on while its players are in the live room is being played, whether or not anyone acts (a bot
    // round, a vote they sit out).
    if session.phase == Phase::Playing && session.players.iter().any(|player| player.peer.is_some()) {
        session.active_at = now;
    }
    if session.players.is_empty() || now.saturating_sub(session.active_at) >= IDLE_LIMIT {
        return Ok((None, events));
    }
    if session.phase == Phase::Playing {
        let members = session.members();
        let positions = positions(&session.players, room);
        if let Some(game) = session.game.as_mut() {
            let mut ctx = Ctx::new(now, &members, &positions, &mut session.rng);
            guarded(|| game.tick(&mut ctx))?;
            events.extend(ctx.into_events());
        }
        session.settle(now)?;
    }
    Ok((Some(if session.phase == Phase::Playing { session.kind.tick() } else { IDLE_TICK }), events))
}

/// `Open`: a new lobby, or the host's lobby again (of `kind`) after a game or in place of another.
fn open(
    place: &mut Island,
    caller: &Caller,
    kind: Option<&'static Kind>,
    room: &[RoomPeer],
    now: Millis,
    next: impl FnOnce() -> (u64, StdRng),
) -> Result<Outcome, Refused> {
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
            Ok(Outcome { opened: Some(id), ..Outcome::default() })
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
        Some(session) if session.phase == Phase::Playing => Err(IN_PROGRESS.into()),
        Some(_) => Err(GAME_EXISTS.into()),
    }
}

fn join(place: &mut Island, caller: &Caller, room: &[RoomPeer], now: Millis) -> Result<Outcome, Refused> {
    let session = place.session.as_mut().ok_or(NO_GAME)?;
    if session.has(caller.user) {
        return Ok(Outcome { unchanged: true, ..Outcome::default() });
    }
    if session.phase != Phase::Lobby {
        return Err(NOT_LOBBY.into());
    }
    if session.players.len() >= session.kind.max_players {
        return Err(FULL.into());
    }
    let peer = caller.peer_in(room).ok_or(NOT_IN_ROOM_GAME)?;
    session.players.push(caller.player(peer));
    session.active_at = now;
    Ok(Outcome::default())
}

fn leave(place: &mut Island, caller: &Caller, room: &[RoomPeer], now: Millis) -> Result<Outcome, Refused> {
    let session = place.session.as_mut().ok_or(NO_GAME)?;
    if !session.has(caller.user) {
        return Err(NOT_PLAYER.into());
    }
    let events = session.remove(caller.user, room, now)?;
    session.active_at = now;
    if session.players.is_empty() {
        place.session = None;
    }
    Ok(Outcome { events, ..Outcome::default() })
}

fn start(
    place: &mut Island,
    caller: &Caller,
    layout: &Value,
    room: &[RoomPeer],
    now: Millis,
) -> Result<Outcome, Refused> {
    let session = place.session.as_mut().ok_or(NO_GAME)?;
    if session.host() != Some(caller.user) {
        return Err(NOT_HOST.into());
    }
    if session.phase != Phase::Lobby {
        return Err(NOT_LOBBY.into());
    }
    if session.players.len() < session.kind.min_players {
        return Err(TOO_FEW.into());
    }
    if session.players.len() > session.kind.max_players {
        return Err(FULL.into());
    }
    let members = session.members();
    let positions = positions(&session.players, room);
    let mut ctx = Ctx::new(now, &members, &positions, &mut session.rng);
    let create = session.kind.create;
    let game = guarded(|| create(layout, &mut ctx))??;
    let events = ctx.into_events();
    session.game = Some(game);
    session.phase = Phase::Playing;
    session.active_at = now;
    session.settle(now)?;
    session.wake.notify_one();
    Ok(Outcome { events, ..Outcome::default() })
}

fn act(
    place: &mut Island,
    caller: &Caller,
    action: &Value,
    room: &[RoomPeer],
    now: Millis,
) -> Result<Outcome, Refused> {
    let session = place.session.as_mut().ok_or(NO_GAME)?;
    if session.phase != Phase::Playing {
        return Err(NOT_PLAYING.into());
    }
    let playing = session.has(caller.user);
    let members = session.members();
    let positions = positions(&session.players, room);
    let game = session.game.as_mut().ok_or(NOT_PLAYING)?;
    let mut ctx = Ctx::new(now, &members, &positions, &mut session.rng);
    if playing {
        guarded(|| game.act(caller.user, action, &mut ctx))??;
    } else {
        guarded(|| game.watch(caller.user, action, &mut ctx))??;
    }
    let events = ctx.into_events();
    if playing {
        session.active_at = now;
    }
    session.settle(now)?;
    Ok(Outcome { events, ..Outcome::default() })
}

/// `Close`: the host ends the session; so may the island's owner, whoever hosts it.
fn close(place: &mut Island, caller: &Caller) -> Result<Outcome, Refused> {
    let session = place.session.as_ref().ok_or(NO_GAME)?;
    if session.host() != Some(caller.user) && !caller.owner {
        return Err(NOT_HOST.into());
    }
    place.session = None;
    Ok(Outcome::default())
}

/// Holds a socket's place on its island; the socket task owns it, so the place never outlives the socket.
struct Registration {
    games: Games,
    island: String,
    id: String,
    viewer: User,
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
    let standing = standing(&state, home.owner_id, viewer.id).await?;
    let (tx, rx) = mpsc::channel(OUTBOUND_CAPACITY);
    let arrival = Arrival { user: viewer, session: claims.session, peer, standing, address: client_address(&headers) };
    let registration = state.games.register(&home.username, arrival, tx, state.games.now())?;
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

/// Ends its session when the ticker's task stops before the session does (it panicked, or was dropped): a session
/// nothing ticks would sit on its island, `playing`, until everyone left.
struct Ticker {
    games: Games,
    island: String,
    id: u64,
}

impl Drop for Ticker {
    fn drop(&mut self) {
        self.games.end(&self.island, self.id, self.games.now());
    }
}

/// Beats session `id` until it is gone: at its kind's tick rate while it plays, once a second otherwise.
async fn run(state: AppState, island: String, id: u64) {
    let Some(wake) = state.games.wake(&island, id) else { return };
    let _ticker = Ticker { games: state.games.clone(), island: island.clone(), id };
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
    // Shared with the page's live-room socket: one check of its login session on the island.
    let _access = state.rooms.watch(&state, &registration.island, &registration.session, &registration.viewer);
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
