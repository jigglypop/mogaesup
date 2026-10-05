//! The session framework, driven without sockets: frames land in each test socket's queue, and the clock and the live
//! room are whatever each call says.

use super::*;

/// A game for these tests: players add to their own count, each sees a number only they know, and the first count to
/// reach the layout's `goal` ends it. Its view also shows where the last tick saw everyone stand.
struct Tally {
    goal: u64,
    counts: HashMap<Uuid, u64>,
    secrets: HashMap<Uuid, u64>,
    seen: HashMap<Uuid, [f64; 3]>,
}

fn tally(layout: &Value, ctx: &mut Ctx) -> Result<Box<dyn Game>, GameError> {
    let goal = layout.get("goal").and_then(Value::as_u64).filter(|goal| (1..=100).contains(goal)).ok_or(BAD_LAYOUT)?;
    let players: Vec<Uuid> = ctx.players().iter().map(|player| player.id).collect();
    let secrets = players.into_iter().map(|id| (id, ctx.rng().gen_range(1..1000))).collect();
    ctx.emit(json!({"type": "started"}));
    Ok(Box::new(Tally { goal, counts: HashMap::new(), secrets, seen: HashMap::new() }))
}

impl Game for Tally {
    fn view(&self, viewer: Option<Uuid>, _now: Millis) -> Value {
        let counts: HashMap<String, u64> = self.counts.iter().map(|(id, count)| (id.to_string(), *count)).collect();
        let seen: HashMap<String, [f64; 3]> = self.seen.iter().map(|(id, at)| (id.to_string(), *at)).collect();
        json!({"counts": counts, "seen": seen, "secret": viewer.and_then(|id| self.secrets.get(&id))})
    }

    fn act(&mut self, player: Uuid, action: &Value, ctx: &mut Ctx) -> Result<(), GameError> {
        let add = action.get("add").and_then(Value::as_u64).filter(|add| *add > 0).ok_or(BAD_ACTION)?;
        *self.counts.entry(player).or_default() += add;
        ctx.emit_one(player, json!({"type": "added", "add": add}));
        Ok(())
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        self.seen = ctx.positions().clone();
    }

    fn leave(&mut self, player: Uuid, ctx: &mut Ctx) {
        self.counts.remove(&player);
        ctx.emit(json!({"type": "left", "player": player}));
    }

    fn result(&self) -> Option<Value> {
        let (winner, _) = self.counts.iter().find(|(_, count)| **count >= self.goal)?;
        Some(json!({"winner": winner}))
    }
}

/// A game whose code fails where its player says: `"act"` in the act itself, `"tick"` at its next tick, `"view"` in
/// the views that act brings about.
struct Fragile {
    fail_tick: bool,
    fail_view: bool,
}

fn fragile(_layout: &Value, _ctx: &mut Ctx) -> Result<Box<dyn Game>, GameError> {
    Ok(Box::new(Fragile { fail_tick: false, fail_view: false }))
}

impl Game for Fragile {
    fn view(&self, _viewer: Option<Uuid>, _now: Millis) -> Value {
        assert!(!self.fail_view, "a view that fails");
        json!({})
    }

    fn act(&mut self, _player: Uuid, action: &Value, _ctx: &mut Ctx) -> Result<(), GameError> {
        match action.as_str() {
            Some("act") => panic!("an act that fails"),
            Some("tick") => self.fail_tick = true,
            Some("view") => self.fail_view = true,
            _ => return Err(BAD_ACTION),
        }
        Ok(())
    }

    fn tick(&mut self, _ctx: &mut Ctx) {
        assert!(!self.fail_tick, "a tick that fails");
    }

    fn leave(&mut self, _player: Uuid, _ctx: &mut Ctx) {}

    fn result(&self) -> Option<Value> {
        None
    }
}

const TALLY: &[Kind] = &[
    Kind::new("tally", 2, 3, tally),
    Kind::new("quick", 1, 2, tally).ticking(25),
    Kind::new("fragile", 1, 2, fragile),
];
const ISLAND: &str = "mogae";
const T0: Millis = 5_000_000;

fn person(name: &str) -> User {
    User { id: Uuid::new_v4(), username: name.into(), display_name: format!("{name}님"), role: "user".into() }
}

struct Socket {
    registration: Registration,
    rx: mpsc::Receiver<Message>,
}

/// `user` arriving on `island` as `standing` would, from an address of their own.
fn arrival(user: &User, session: &str, peer: &str, standing: Standing) -> Arrival {
    Arrival { user: user.clone(), session: session.into(), peer: peer.into(), standing, address: user.id.to_string() }
}

fn connect_as(games: &Games, user: &User, peer: &str, standing: Standing) -> Socket {
    let (tx, rx) = mpsc::channel(64);
    let registration = games.register(ISLAND, arrival(user, "login", peer, standing), tx, T0).unwrap();
    Socket { registration, rx }
}

fn connect(games: &Games, user: &User, peer: &str) -> Socket {
    connect_as(games, user, peer, Standing::Visitor)
}

impl Socket {
    /// Every frame queued for this socket since the last look.
    fn frames(&mut self) -> Vec<Value> {
        let mut frames = Vec::new();
        while let Ok(message) = self.rx.try_recv() {
            if let Message::Text(raw) = message {
                frames.push(serde_json::from_str(raw.as_str()).unwrap());
            }
        }
        frames
    }

    /// The latest session this socket was sent, if any was sent since the last look.
    fn session(&mut self) -> Option<Value> {
        self.frames()
            .into_iter()
            .filter(|frame| frame["type"] == "Session")
            .map(|frame| frame["session"].clone())
            .next_back()
    }

    fn send(&self, games: &Games, message: Value, room: &[RoomPeer], now: Millis) -> Flow {
        games.receive(ISLAND, &self.registration.id, &message.to_string(), room, now)
    }
}

fn peer(id: &str, user: &User, position: Option<[f64; 3]>) -> RoomPeer {
    RoomPeer { id: id.into(), user: user.id, position }
}

fn errors(frames: &[Value]) -> Vec<String> {
    frames.iter().filter(|frame| frame["type"] == "Error").map(|frame| frame["code"].as_str().unwrap().into()).collect()
}

fn opened(flow: Flow) -> u64 {
    match flow {
        Flow::Opened(id) => id,
        _ => panic!("no session opened"),
    }
}

/// Two people in the island's room, both watching: A has opened a tally lobby and B has joined it.
struct Lobby {
    games: Games,
    a: User,
    b: User,
    sa: Socket,
    sb: Socket,
    room: Vec<RoomPeer>,
    id: u64,
}

fn lobby() -> Lobby {
    let games = Games::new(TALLY, Some(42));
    let (a, b) = (person("a"), person("b"));
    let room = vec![peer("pa", &a, Some([1.0, 0.0, 2.0])), peer("pb", &b, Some([-3.0, 0.5, 4.0]))];
    let (mut sa, mut sb) = (connect(&games, &a, "pa"), connect(&games, &b, "pb"));
    assert_eq!(sa.session(), Some(Value::Null));
    assert_eq!(sb.session(), Some(Value::Null));
    let id = opened(sa.send(&games, json!({"type": "Open", "kind": "tally"}), &room, T0));
    assert!(matches!(sb.send(&games, json!({"type": "Join"}), &room, T0), Flow::Continue));
    Lobby { games, a, b, sa, sb, room, id }
}

#[test]
fn an_opened_lobby_shows_its_host_and_players_to_everyone_watching() {
    let games = Games::new(TALLY, Some(1));
    let (a, b, c) = (person("a"), person("b"), person("c"));
    let room = vec![peer("pa", &a, None), peer("pb", &b, None), peer("pc", &c, None)];
    let (mut sa, mut sb, mut sc) = (connect(&games, &a, "pa"), connect(&games, &b, "pb"), connect(&games, &c, "pc"));
    sa.frames();
    sb.frames();
    sc.frames();
    assert!(matches!(sa.send(&games, json!({"type": "Open", "kind": "nope"}), &room, T0), Flow::Continue));
    assert_eq!(errors(&sa.frames()), ["unknown_game"]);
    opened(sa.send(&games, json!({"type": "Open", "kind": "tally"}), &room, T0));
    let seen = sc.session().unwrap();
    assert_eq!(seen["kind"], "tally");
    assert_eq!(seen["phase"], "lobby");
    assert_eq!(seen["host"], json!(a.id));
    assert_eq!(seen["you"], json!(c.id));
    assert_eq!(seen["players"], json!([{"id": a.id, "name": "a님", "peer": "pa"}]));
    assert_eq!((seen["game"].clone(), seen["result"].clone()), (Value::Null, Value::Null));
    assert_eq!(seen["now"], T0);
    // A second lobby is refused; joining the first adds to it, once.
    sb.send(&games, json!({"type": "Open", "kind": "tally"}), &room, T0);
    assert_eq!(errors(&sb.frames()), ["game_exists"]);
    sb.send(&games, json!({"type": "Join"}), &room, T0);
    sb.send(&games, json!({"type": "Join"}), &room, T0);
    let players = sa.session().unwrap()["players"].clone();
    assert_eq!(players.as_array().unwrap().len(), 2);
    assert_eq!(players[1]["peer"], "pb");
    sc.send(&games, json!({"type": "Join"}), &room, T0);
    // The tally holds three; a fourth is turned away.
    let d = person("d");
    let mut room_d = room.clone();
    room_d.push(peer("pd", &d, None));
    let mut sd = connect(&games, &d, "pd");
    sd.send(&games, json!({"type": "Join"}), &room_d, T0);
    assert_eq!(errors(&sd.frames()), ["full"]);
}

#[test]
fn only_someone_in_the_live_room_opens_or_joins() {
    let games = Games::new(TALLY, Some(1));
    let (a, b) = (person("a"), person("b"));
    let mut sa = connect(&games, &a, "pa");
    sa.send(&games, json!({"type": "Open", "kind": "tally"}), &[], T0);
    assert_eq!(errors(&sa.frames()), ["not_in_room"]);
    // Another peer of the same account will do (the page's room reconnected); someone else's will not.
    let room = vec![peer("pa2", &a, None), peer("pb", &b, None)];
    opened(sa.send(&games, json!({"type": "Open", "kind": "tally"}), &room, T0));
    assert_eq!(sa.session().unwrap()["players"][0]["peer"], "pa2");
    let mut sb = connect(&games, &b, "pb");
    sb.send(&games, json!({"type": "Join"}), &[peer("pa2", &a, None)], T0);
    assert_eq!(errors(&sb.frames()), ["not_in_room"]);
}

#[test]
fn the_host_starts_with_enough_players_and_a_layout_the_game_takes() {
    let games = Games::new(TALLY, Some(1));
    let (a, b) = (person("a"), person("b"));
    let room = vec![peer("pa", &a, None), peer("pb", &b, None)];
    let (mut sa, mut sb) = (connect(&games, &a, "pa"), connect(&games, &b, "pb"));
    opened(sa.send(&games, json!({"type": "Open", "kind": "tally"}), &room, T0));
    sa.send(&games, json!({"type": "Start", "layout": {"goal": 3}}), &room, T0);
    assert_eq!(errors(&sa.frames()), ["too_few"]);
    sb.send(&games, json!({"type": "Join"}), &room, T0);
    sb.frames();
    sb.send(&games, json!({"type": "Start", "layout": {"goal": 3}}), &room, T0);
    assert_eq!(errors(&sb.frames()), ["not_host"]);
    sa.frames();
    sa.send(&games, json!({"type": "Start", "layout": {"goal": "many"}}), &room, T0);
    assert_eq!(errors(&sa.frames()), ["bad_layout"]);
    assert!(sb.frames().is_empty(), "a refusal goes to its sender only");
    sa.send(&games, json!({"type": "Start", "layout": {"goal": 3}}), &room, T0 + 10);
    let frames = sb.frames();
    let session = frames.iter().find(|frame| frame["type"] == "Session").unwrap()["session"].clone();
    assert_eq!(session["phase"], "playing");
    // The session goes first, then what the game announced.
    assert_eq!(frames.last().unwrap(), &json!({"type": "Event", "kind": "tally", "event": {"type": "started"}}));
    sa.send(&games, json!({"type": "Start", "layout": {"goal": 3}}), &room, T0 + 20);
    assert_eq!(errors(&sa.frames()), ["not_lobby"]);
    sa.send(&games, json!({"type": "Open", "kind": "tally"}), &room, T0 + 20);
    assert_eq!(errors(&sa.frames()), ["in_progress"]);
}

#[test]
fn secrets_reach_only_their_owner_and_unchanged_views_are_not_sent_again() {
    let Lobby { games, a, mut sa, mut sb, room, .. } = lobby();
    let watcher = person("w");
    let mut sw = connect(&games, &watcher, "pw");
    sa.send(&games, json!({"type": "Start", "layout": {"goal": 5}}), &room, T0);
    let (va, vb, vw) = (sa.session().unwrap(), sb.session().unwrap(), sw.session().unwrap());
    assert!(va["game"]["secret"].is_u64() && vb["game"]["secret"].is_u64());
    assert_ne!(va["game"]["secret"], vb["game"]["secret"]);
    assert_eq!(vw["game"]["secret"], Value::Null, "someone watching sees no one's secret");
    assert_eq!(vw["you"], json!(watcher.id));
    // A's act changes the counts everyone sees; its event goes to A alone.
    sa.send(&games, json!({"type": "Act", "action": {"add": 2}}), &room, T0 + 1);
    let frames = sa.frames();
    assert_eq!(frames.last().unwrap()["event"], json!({"type": "added", "add": 2}));
    assert!(sb.frames().iter().all(|frame| frame["type"] == "Session"));
    assert_eq!(sw.session().unwrap()["game"]["counts"][a.id.to_string()], 2);
    // A refused act changes nothing and sends nothing to the others.
    sb.send(&games, json!({"type": "Act", "action": {"add": 0}}), &room, T0 + 2);
    assert_eq!(errors(&sb.frames()), ["bad_action"]);
    assert!(sa.frames().is_empty() && sw.frames().is_empty());
    // A ping is answered and changes no one's view.
    sb.send(&games, json!({"type": "Ping", "ts": 1717}), &room, T0 + 3);
    assert_eq!(sb.frames(), [json!({"type": "Pong", "ts": 1717})]);
    assert!(sa.frames().is_empty());
}

#[test]
fn an_event_may_skip_some_players_and_someone_watching_acts_only_where_the_game_lets_them() {
    let Lobby { games, a, b, mut sa, mut sb, room, .. } = lobby();
    let watcher = person("w");
    let mut sw = connect(&games, &watcher, "pw");
    sa.send(&games, json!({"type": "Start", "layout": {"goal": 5}}), &room, T0);
    for socket in [&mut sa, &mut sb, &mut sw] {
        socket.frames();
    }
    lock(&games.island(ISLAND).unwrap())
        .announce("tally", vec![(Audience::Except(vec![a.id]), json!({"type": "aside"}))]);
    assert!(sa.frames().is_empty());
    let aside = json!({"type": "Event", "kind": "tally", "event": {"type": "aside"}});
    assert_eq!((sb.frames(), sw.frames()), (vec![aside.clone()], vec![aside]));
    assert!(Audience::Except(vec![a.id]).includes(b.id) && !Audience::Except(vec![b.id]).includes(b.id));
    // The tally takes nothing from people watching: refused as before, and nothing changes.
    sw.send(&games, json!({"type": "Act", "action": {"add": 1}}), &room, T0 + 1);
    assert_eq!(errors(&sw.frames()), ["not_player"]);
    assert!(sa.frames().is_empty());
}

#[test]
fn ticks_see_where_each_player_stands_by_their_own_peer() {
    let Lobby { games, a, b, mut sa, room, id, .. } = lobby();
    sa.send(&games, json!({"type": "Start", "layout": {"goal": 5}}), &room, T0);
    assert_eq!(games.step(ISLAND, id, &room, T0 + 100), Some(Duration::from_millis(100)));
    let seen = sa.session().unwrap()["game"]["seen"].clone();
    assert_eq!(seen, json!({a.id.to_string(): [1.0, 0.0, 2.0], b.id.to_string(): [-3.0, 0.5, 4.0]}));
    // B's room reconnected under a new id: B is found there, and the session says which avatar is B's now.
    let moved = vec![room[0].clone(), peer("pb-again", &b, Some([7.0, 0.0, 7.0]))];
    games.step(ISLAND, id, &moved, T0 + 200);
    let session = sa.session().unwrap();
    assert_eq!(session["game"]["seen"][b.id.to_string()], json!([7.0, 0.0, 7.0]));
    assert_eq!(session["players"][1]["peer"], "pb-again");
    // A stale session id does nothing.
    assert_eq!(games.step(ISLAND, id + 1, &moved, T0 + 300), None);
}

#[test]
fn a_player_out_of_the_room_for_ten_seconds_leaves_and_the_last_to_leave_closes_it() {
    let Lobby { games, b, mut sa, mut sb, room, id, .. } = lobby();
    sa.send(&games, json!({"type": "Start", "layout": {"goal": 5}}), &room, T0);
    sa.frames();
    let only_a = vec![room[0].clone()];
    games.step(ISLAND, id, &only_a, T0 + 1_000);
    let session = sa.session().unwrap();
    assert_eq!(session["players"][1]["peer"], Value::Null, "away: no avatar to match");
    games.step(ISLAND, id, &only_a, T0 + 10_999);
    assert!(sa.frames().is_empty());
    games.step(ISLAND, id, &only_a, T0 + 11_000);
    let frames = sa.frames();
    let session = frames.iter().find(|frame| frame["type"] == "Session").unwrap()["session"].clone();
    assert_eq!(session["players"].as_array().unwrap().len(), 1);
    assert_eq!(frames.last().unwrap()["event"], json!({"type": "left", "player": b.id}));
    assert!(sb.session().unwrap()["players"].as_array().unwrap().iter().all(|player| player["id"] != json!(b.id)));
    // Coming back in time keeps a player.
    games.step(ISLAND, id, &[], T0 + 12_000);
    games.step(ISLAND, id, &only_a, T0 + 21_000);
    assert_eq!(games.step(ISLAND, id, &only_a, T0 + 23_000), Some(Duration::from_millis(100)));
    // Gone for good, the last player takes the session with them.
    games.step(ISLAND, id, &[], T0 + 24_000);
    assert_eq!(games.step(ISLAND, id, &[], T0 + 34_000), None);
    assert_eq!(sa.session(), Some(Value::Null));
}

#[test]
fn a_host_who_leaves_hands_the_lobby_to_the_earliest_player_left() {
    let games = Games::new(TALLY, Some(1));
    let (a, b, c) = (person("a"), person("b"), person("c"));
    let room = vec![peer("pa", &a, None), peer("pb", &b, None), peer("pc", &c, None)];
    let (mut sa, mut sb, mut sc) = (connect(&games, &a, "pa"), connect(&games, &b, "pb"), connect(&games, &c, "pc"));
    opened(sa.send(&games, json!({"type": "Open", "kind": "tally"}), &room, T0));
    sb.send(&games, json!({"type": "Join"}), &room, T0);
    sc.send(&games, json!({"type": "Join"}), &room, T0);
    sa.send(&games, json!({"type": "Leave"}), &room, T0);
    assert_eq!(sc.session().unwrap()["host"], json!(b.id));
    sa.send(&games, json!({"type": "Leave"}), &room, T0);
    assert_eq!(errors(&sa.frames()), ["not_player"]);
    sc.send(&games, json!({"type": "Close"}), &room, T0);
    assert_eq!(errors(&sc.frames()), ["not_host"]);
    sb.send(&games, json!({"type": "Leave"}), &room, T0);
    assert_eq!(sc.session().unwrap()["host"], json!(c.id));
    sc.send(&games, json!({"type": "Leave"}), &room, T0);
    assert_eq!(sb.session(), Some(Value::Null));
    sb.send(&games, json!({"type": "Join"}), &room, T0);
    assert_eq!(errors(&sb.frames()), ["no_game"]);
}

#[test]
fn a_result_ends_the_game_and_the_host_opens_again_or_closes() {
    let Lobby { games, b, mut sa, mut sb, room, id, .. } = lobby();
    sa.send(&games, json!({"type": "Start", "layout": {"goal": 3}}), &room, T0);
    sb.send(&games, json!({"type": "Act", "action": {"add": 3}}), &room, T0 + 50);
    let ended = sa.session().unwrap();
    assert_eq!(ended["phase"], "ended");
    assert_eq!(ended["result"], json!({"winner": b.id}));
    assert_eq!(games.step(ISLAND, id, &room, T0 + 100), Some(IDLE_TICK));
    sb.send(&games, json!({"type": "Act", "action": {"add": 1}}), &room, T0 + 150);
    assert_eq!(errors(&sb.frames()), ["not_playing"]);
    sb.send(&games, json!({"type": "Open", "kind": "tally"}), &room, T0 + 150);
    assert_eq!(errors(&sb.frames()), ["game_exists"]);
    // 다시 하기: the same players in a fresh lobby, on the same session.
    assert!(matches!(sa.send(&games, json!({"type": "Open", "kind": "tally"}), &room, T0 + 200), Flow::Continue));
    let again = sb.session().unwrap();
    assert_eq!((again["phase"].as_str(), again["result"].clone()), (Some("lobby"), Value::Null));
    assert_eq!(again["players"].as_array().unwrap().len(), 2);
    assert_eq!(games.step(ISLAND, id, &room, T0 + 300), Some(IDLE_TICK));
    sa.send(&games, json!({"type": "Close"}), &room, T0 + 400);
    assert_eq!(sb.session(), Some(Value::Null));
    assert_eq!(games.step(ISLAND, id, &room, T0 + 500), None);
}

#[test]
fn a_session_nobody_touches_for_ten_minutes_closes() {
    let Lobby { games, mut sa, room, id, .. } = lobby();
    sa.frames();
    assert_eq!(games.step(ISLAND, id, &room, T0 + IDLE_LIMIT - 1), Some(IDLE_TICK));
    assert!(sa.frames().is_empty());
    assert_eq!(games.step(ISLAND, id, &room, T0 + IDLE_LIMIT), None);
    assert_eq!(sa.session(), Some(Value::Null));
}

#[test]
fn islands_are_apart_and_sockets_give_their_places_back() {
    let games = Games::new(TALLY, Some(1));
    let a = person("a");
    // The owner's own sockets take no one's seat, so all four of the account's open on one island.
    let held: Vec<Socket> = (0..ACCOUNT_CAPACITY).map(|_| connect_as(&games, &a, "pa", Standing::Owner)).collect();
    let (tx, _rx) = mpsc::channel(4);
    let refused = games.register("other", arrival(&a, "login", "pa", Standing::Visitor), tx, T0).err().unwrap();
    assert_eq!(refused.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(games.count(), ACCOUNT_CAPACITY);
    drop(held);
    assert_eq!(games.count(), 0);
    assert!(games.islands().is_empty());
}

#[test]
fn a_socket_that_stops_reading_is_closed_and_floods_or_garbage_close_it() {
    let Lobby { games, a, sa, room, .. } = lobby();
    // A queue of one: the first view fills it and the next one finds it full.
    let (tx, _rx) = mpsc::channel(1);
    let slow = games.register(ISLAND, arrival(&a, "login", "pa", Standing::Visitor), tx, T0).unwrap();
    assert_eq!(*slow.cancelled.borrow(), None);
    sa.send(&games, json!({"type": "Start", "layout": {"goal": 5}}), &room, T0);
    assert_eq!(*slow.cancelled.borrow(), Some((4408, "too slow")));
    let garbage: Vec<Flow> =
        (0..=INVALID_PER_SECOND).map(|_| games.receive(ISLAND, &sa.registration.id, "{", &room, T0)).collect();
    assert!(matches!(garbage.last(), Some(Flow::Close(4400, _))));
    assert!(garbage[..INVALID_PER_SECOND].iter().all(|flow| matches!(flow, Flow::Continue)));
    let b = person("b2");
    let sb = connect(&games, &b, "pb2");
    // A burst (a stalled link catching up) is taken; a flood over the window is not.
    let burst: Vec<Flow> =
        (0..MESSAGES_PER_WINDOW / 2).map(|_| sb.send(&games, json!({"type": "Ping", "ts": 1}), &room, T0)).collect();
    assert!(burst.iter().all(|flow| matches!(flow, Flow::Continue)));
    let flood: Vec<Flow> = (MESSAGES_PER_WINDOW / 2..=MESSAGES_PER_WINDOW)
        .map(|_| sb.send(&games, json!({"type": "Ping", "ts": 1}), &room, T0))
        .collect();
    assert!(matches!(flood.last(), Some(Flow::Close(4429, _))));
}

#[test]
fn ending_a_login_session_closes_its_sockets_only() {
    let Lobby { games, a, sa, sb, .. } = lobby();
    let (tx, _rx) = mpsc::channel(8);
    let other = games.register(ISLAND, arrival(&a, "another-login", "pa", Standing::Visitor), tx, T0).unwrap();
    games.end_session("login");
    assert_eq!(*sa.registration.cancelled.borrow(), Some((4401, "session ended")));
    assert_eq!(*sb.registration.cancelled.borrow(), Some((4401, "session ended")));
    assert_eq!(*other.cancelled.borrow(), None);
    assert_eq!(games.count(), 1);
}

#[test]
fn helpers_measure_on_the_ground_and_pick_without_repeats() {
    assert_eq!(distance_xz([0.0, 5.0, 0.0], [3.0, -2.0, 4.0]), 5.0);
    assert!(within([1.0, 0.0, 1.0], [1.0, 9.0, 2.4], 1.4));
    assert!(!within([1.0, 0.0, 1.0], [1.0, 0.0, 2.41], 1.4));
    let mut rng = StdRng::seed_from_u64(3);
    let items: Vec<u32> = (0..10).collect();
    let mut chosen = pick_many(&mut rng, &items, 4);
    assert_eq!(chosen.len(), 4);
    chosen.sort();
    chosen.dedup();
    assert_eq!(chosen.len(), 4);
    assert_eq!(pick_many(&mut rng, &items, 20).len(), 10);
    assert!(pick::<u32>(&mut rng, &[]).is_none());
    assert!(items.contains(pick(&mut rng, &items).unwrap()));
    assert_eq!(distinct(vec![[0.0; 3], [0.3, 1.0, 0.0], [2.0, 0.0, 0.0]], 0.5), vec![[0.0; 3], [2.0, 0.0, 0.0]]);
    assert_eq!(point(&json!([1, -2.5, 3])), Ok([1.0, -2.5, 3.0]));
    assert_eq!(point(&json!([1, 2])), Err(BAD_LAYOUT));
    assert_eq!(layout_points(&json!({"p": [[0, 0, 0]]}), "p", 2, 3), Err(BAD_LAYOUT));
}

#[test]
fn a_playing_game_ticks_at_its_kinds_rate_and_a_lobby_once_a_second() {
    let games = Games::new(TALLY, Some(1));
    let a = person("a");
    let room = vec![peer("pa", &a, None)];
    let sa = connect(&games, &a, "pa");
    let id = opened(sa.send(&games, json!({"type": "Open", "kind": "quick"}), &room, T0));
    assert_eq!(games.step(ISLAND, id, &room, T0 + 1), Some(IDLE_TICK));
    sa.send(&games, json!({"type": "Start", "layout": {"goal": 9}}), &room, T0 + 2);
    assert_eq!(games.step(ISLAND, id, &room, T0 + 3), Some(Duration::from_millis(40)));
    // Opened again as a ten-a-second game, it waits the lobby's second and then ticks at its own rate.
    sa.send(&games, json!({"type": "Act", "action": {"add": 9}}), &room, T0 + 4);
    sa.send(&games, json!({"type": "Open", "kind": "tally"}), &room, T0 + 5);
    assert_eq!(games.step(ISLAND, id, &room, T0 + 6), Some(IDLE_TICK));
    assert_eq!(Kind::new("x", 1, 1, tally).tick_hz, DEFAULT_TICK_HZ);
    assert_eq!(Kind::new("x", 1, 1, tally).ticking(MAX_TICK_HZ).tick(), Duration::from_micros(33_333));
    // A rate set by hand past the limit is held to it.
    assert_eq!(Kind { tick_hz: 90, ..Kind::new("x", 1, 1, tally) }.tick(), Duration::from_micros(33_333));
}

#[test]
fn every_registered_game_has_its_own_kind_and_limits_the_server_keeps() {
    let mut seen = std::collections::HashSet::new();
    for kind in KINDS {
        assert!(seen.insert(kind.kind), "{} is registered twice", kind.kind);
        assert!(!kind.kind.is_empty() && kind.kind.len() <= MAX_KIND, "{}", kind.kind);
        assert!(1 <= kind.min_players && kind.min_players <= kind.max_players, "{}", kind.kind);
        assert!(kind.max_players <= ISLAND_CAPACITY, "{}", kind.kind);
        assert!((1..=MAX_TICK_HZ).contains(&kind.tick_hz), "{}", kind.kind);
    }
    assert!(KINDS.iter().any(|kind| kind.kind == "impostor"));
}

#[test]
fn a_game_whose_code_panics_ends_its_own_session_and_nothing_else() {
    let games = Games::new(TALLY, Some(1));
    let a = person("a");
    let room = vec![peer("pa", &a, None)];
    let mut sa = connect(&games, &a, "pa");
    // Another island's game, playing all along.
    let (tx, _other_rx) = mpsc::channel(256);
    let elsewhere = games.register("other", arrival(&a, "login", "pa", Standing::Visitor), tx, T0).unwrap();
    let send_elsewhere = |message: Value| games.receive("other", &elsewhere.id, &message.to_string(), &room, T0);
    let other = opened(send_elsewhere(json!({"type": "Open", "kind": "quick"})));
    send_elsewhere(json!({"type": "Start", "layout": {"goal": 9}}));
    for failing in ["act", "tick", "view"] {
        let id = opened(sa.send(&games, json!({"type": "Open", "kind": "fragile"}), &room, T0));
        sa.send(&games, json!({"type": "Start", "layout": {}}), &room, T0);
        assert_eq!(games.step(ISLAND, id, &room, T0 + 1), Some(Duration::from_millis(100)));
        sa.frames();
        sa.send(&games, json!({"type": "Act", "action": failing}), &room, T0 + 2);
        if failing == "tick" {
            assert_eq!(games.step(ISLAND, id, &room, T0 + 3), None, "{failing}");
        }
        let frames = sa.frames();
        assert!(errors(&frames).contains(&"game_failed".to_owned()), "{failing}: {frames:?}");
        let last = frames.iter().rfind(|frame| frame["type"] == "Session").unwrap();
        assert_eq!(last["session"], Value::Null, "{failing}");
        assert_eq!(games.step(ISLAND, id, &room, T0 + 4), None, "{failing}: nothing ticks it any more");
        assert!(!games.island(ISLAND).unwrap().is_poisoned());
        assert_eq!(games.step("other", other, &room, T0 + 5), Some(Duration::from_millis(40)), "{failing}");
    }
    // A ticker that stops before its session does ends it the same way.
    let id = opened(sa.send(&games, json!({"type": "Open", "kind": "fragile"}), &room, T0));
    sa.send(&games, json!({"type": "Start", "layout": {}}), &room, T0);
    sa.frames();
    games.end(ISLAND, id, T0 + 1);
    let frames = sa.frames();
    assert_eq!(errors(&frames), ["game_failed"]);
    assert_eq!(games.step(ISLAND, id, &room, T0 + 2), None);
    games.end(ISLAND, id, T0 + 3);
    assert!(sa.frames().is_empty(), "a session already gone is left alone");
}

#[test]
fn the_islands_owner_closes_a_session_someone_else_hosts() {
    let games = Games::new(TALLY, Some(1));
    let (owner, host, guest) = (person("o"), person("h"), person("g"));
    let room = vec![peer("po", &owner, None), peer("ph", &host, None), peer("pg", &guest, None)];
    let mut so = connect_as(&games, &owner, "po", Standing::Owner);
    let sh = connect(&games, &host, "ph");
    let mut sg = connect(&games, &guest, "pg");
    for playing in [false, true] {
        opened(sh.send(&games, json!({"type": "Open", "kind": "tally"}), &room, T0));
        sg.send(&games, json!({"type": "Join"}), &room, T0);
        if playing {
            sh.send(&games, json!({"type": "Start", "layout": {"goal": 5}}), &room, T0);
        }
        sg.frames();
        sg.send(&games, json!({"type": "Close"}), &room, T0);
        assert_eq!(errors(&sg.frames()), ["not_host"], "only the host, or the owner");
        so.frames();
        so.send(&games, json!({"type": "Close"}), &room, T0);
        assert_eq!(so.session(), Some(Value::Null), "playing: {playing}");
    }
}

#[test]
fn a_game_its_players_are_in_the_room_for_is_not_closed_for_want_of_actions() {
    let Lobby { games, mut sa, room, id, .. } = lobby();
    sa.send(&games, json!({"type": "Start", "layout": {"goal": 5}}), &room, T0);
    // Nobody acts for far longer than the idle limit, but both stay in the live room: it plays on.
    for minute in 1..=15 {
        assert_eq!(games.step(ISLAND, id, &room, T0 + minute * 60_000), Some(Duration::from_millis(100)), "{minute}");
    }
    assert_ne!(sa.session(), Some(Value::Null));
    // A lobby is still closed when nobody does anything with it.
    let Lobby { games, room, id, .. } = lobby();
    assert_eq!(games.step(ISLAND, id, &room, T0 + IDLE_LIMIT), None);
}

#[test]
fn one_account_holds_a_few_game_sockets_on_an_island_and_its_owner_more() {
    let games = Games::new(TALLY, Some(1));
    let (a, owner) = (person("a"), person("o"));
    let _few: Vec<Socket> = (0..crate::rooms::ACCOUNT_ISLAND_CAPACITY).map(|_| connect(&games, &a, "pa")).collect();
    let (tx, _rx) = mpsc::channel(4);
    let more = games.register(ISLAND, arrival(&a, "login", "pa", Standing::Visitor), tx, T0).err().unwrap();
    assert_eq!((more.status, more.code), (StatusCode::TOO_MANY_REQUESTS, "game"));
    let _owner: Vec<Socket> =
        (0..ACCOUNT_CAPACITY).map(|_| connect_as(&games, &owner, "po", Standing::Owner)).collect();
    assert_eq!(games.count(), crate::rooms::ACCOUNT_ISLAND_CAPACITY + ACCOUNT_CAPACITY);
}
