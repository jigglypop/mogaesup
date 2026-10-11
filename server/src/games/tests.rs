//! The session framework, driven without sockets: frames land in each test socket's queue, and the clock and the live
//! room are whatever each call says.

use super::*;

/// A game for these tests: players add to their own count, each sees a number only they know, and the first count to
/// reach the layout's `goal` ends it. Its view also shows where the last tick saw everyone stand, `{"where": true}` tells
/// a player where the game sees them now, and the layout's `send` is a place it sends everyone to.
struct Tally {
    goal: u64,
    counts: HashMap<Uuid, u64>,
    secrets: HashMap<Uuid, u64>,
    seen: HashMap<Uuid, [f64; 3]>,
    send: Option<[f64; 3]>,
}

fn tally(layout: &Value, ctx: &mut Ctx) -> Result<Box<dyn Game>, GameError> {
    let goal = layout.get("goal").and_then(Value::as_u64).filter(|goal| (1..=100).contains(goal)).ok_or(BAD_LAYOUT)?;
    let send = layout.get("send").map(point).transpose()?;
    let players: Vec<Uuid> = ctx.players().iter().map(|player| player.id).collect();
    let secrets = players.into_iter().map(|id| (id, ctx.rng().gen_range(1..1000))).collect();
    ctx.emit(json!({"type": "started"}));
    Ok(Box::new(Tally { goal, counts: HashMap::new(), secrets, seen: HashMap::new(), send }))
}

impl Game for Tally {
    fn view(&self, viewer: Option<Uuid>, _now: Millis) -> Value {
        let counts: HashMap<String, u64> = self.counts.iter().map(|(id, count)| (id.to_string(), *count)).collect();
        let seen: HashMap<String, [f64; 3]> = self.seen.iter().map(|(id, at)| (id.to_string(), *at)).collect();
        json!({"counts": counts, "seen": seen, "secret": viewer.and_then(|id| self.secrets.get(&id))})
    }

    fn destinations(&self, _now: Millis) -> Vec<(Uuid, [f64; 3])> {
        self.send.map_or_else(Vec::new, |place| self.secrets.keys().map(|id| (*id, place)).collect())
    }

    fn act(&mut self, player: Uuid, action: &Value, ctx: &mut Ctx) -> Result<(), GameError> {
        if action.get("where") == Some(&Value::Bool(true)) {
            ctx.emit_one(player, json!({"type": "at", "at": ctx.position(player)}));
            return Ok(());
        }
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
    let room = vec![
        peer("pa", &a, Some([0.0; 3])),
        peer("pb", &b, Some([2.0, 0.0, 0.0])),
        peer("pc", &c, Some([4.0, 0.0, 0.0])),
    ];
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
    room_d.push(peer("pd", &d, Some([6.0, 0.0, 0.0])));
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
    // Nor someone whose peer stands nowhere yet, shown to nobody in the room.
    sa.send(&games, json!({"type": "Open", "kind": "tally"}), &[peer("pa", &a, None)], T0);
    assert_eq!(errors(&sa.frames()), ["not_in_room"]);
    // Another peer of the same account will do (the page's room reconnected); someone else's will not.
    let room = vec![peer("pa", &a, None), peer("pa2", &a, Some([1.0, 0.0, 1.0])), peer("pb", &b, Some([0.0; 3]))];
    opened(sa.send(&games, json!({"type": "Open", "kind": "tally"}), &room, T0));
    assert_eq!(sa.session().unwrap()["players"][0]["peer"], "pa2");
    let mut sb = connect(&games, &b, "pb");
    sb.send(&games, json!({"type": "Join"}), &[room[1].clone()], T0);
    assert_eq!(errors(&sb.frames()), ["not_in_room"]);
    sb.send(&games, json!({"type": "Join"}), &[room[1].clone(), peer("pb", &b, None)], T0);
    assert_eq!(errors(&sb.frames()), ["not_in_room"]);
}

#[test]
fn the_host_starts_with_enough_players_and_a_layout_the_game_takes() {
    let games = Games::new(TALLY, Some(1));
    let (a, b) = (person("a"), person("b"));
    let room = vec![peer("pa", &a, Some([0.0; 3])), peer("pb", &b, Some([2.0, 0.0, 0.0]))];
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
    let moved = vec![room[0].clone(), peer("pb-again", &b, Some([-1.0, 0.0, 4.0]))];
    games.step(ISLAND, id, &moved, T0 + 200);
    let session = sa.session().unwrap();
    assert_eq!(session["game"]["seen"][b.id.to_string()], json!([-1.0, 0.0, 4.0]));
    assert_eq!(session["players"][1]["peer"], "pb-again");
    // A stale session id does nothing.
    assert_eq!(games.step(ISLAND, id + 1, &moved, T0 + 300), None);
}

#[test]
fn a_page_that_jumps_is_followed_at_the_games_top_speed_but_a_place_the_game_sends_to_is_reached_at_once() {
    let Lobby { games, a, b, mut sa, room, id, .. } = lobby();
    sa.send(&games, json!({"type": "Start", "layout": {"goal": 5, "send": [-33.0, 0.0, 4.0]}}), &room, T0);
    let seen = |socket: &mut Socket, who: &User| socket.session().unwrap()["game"]["seen"][who.id.to_string()].clone();
    // A's page puts A 48 m east at once: a tenth of a second later, the game sees A 3 m on (30 m/s).
    let at = |x: f64| vec![peer("pa", &a, Some([x, 0.0, 2.0])), room[1].clone()];
    games.step(ISLAND, id, &at(49.0), T0 + 100);
    assert_eq!(seen(&mut sa, &a), json!([4.0, 0.0, 2.0]));
    // An act between ticks sees A as far on as the time since allows.
    sa.send(&games, json!({"type": "Act", "action": {"where": true}}), &at(49.0), T0 + 150);
    assert_eq!(sa.frames().last().unwrap()["event"], json!({"type": "at", "at": [5.5, 0.0, 2.0]}));
    // However far ahead the page keeps saying A is, never faster: a second after the jump, 30 m on.
    for step in 2..=10 {
        games.step(ISLAND, id, &at(49.0 + 6.0 * step as f64), T0 + step * 100);
    }
    assert_eq!(seen(&mut sa, &a), json!([31.0, 0.0, 2.0]));
    // B's page puts B where the game sends everyone, 30 m away: the game sees B there at once.
    let sent = vec![peer("pa", &a, Some([49.0, 0.0, 2.0])), peer("pb", &b, Some([-33.0, 0.0, 4.0]))];
    games.step(ISLAND, id, &sent, T0 + 1_100);
    assert_eq!(seen(&mut sa, &b), json!([-33.0, 0.0, 4.0]));
    // A second out of the room saves no move up: back on a new peer 90 m north, A is seen 3 m that way.
    let without_a = vec![sent[1].clone()];
    games.step(ISLAND, id, &without_a, T0 + 2_000);
    games.step(ISLAND, id, &without_a, T0 + 3_100);
    let back = vec![peer("pa-again", &a, Some([34.0, 0.0, 92.0])), sent[1].clone()];
    games.step(ISLAND, id, &back, T0 + 3_200);
    assert_eq!(seen(&mut sa, &a), json!([34.0, 0.0, 5.0]));
}

#[test]
fn someone_whose_page_says_nowhere_as_the_game_starts_is_followed_from_where_they_joined() {
    let Lobby { games, b, mut sa, room, id, .. } = lobby();
    // A minute on, B's room has just reconnected as the game starts, and B's page has not said where B stands.
    let unplaced = vec![room[0].clone(), peer("pb-again", &b, None)];
    sa.send(&games, json!({"type": "Start", "layout": {"goal": 5}}), &unplaced, T0 + 60_000);
    // Then it puts B 60 m from where B joined: a tenth of a second later, the game sees B 3 m on, not there.
    let far = vec![room[0].clone(), peer("pb-again", &b, Some([57.0, 0.5, 4.0]))];
    games.step(ISLAND, id, &far, T0 + 60_100);
    assert_eq!(sa.session().unwrap()["game"]["seen"][b.id.to_string()], json!([0.0, 0.5, 4.0]));
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
    let room = vec![
        peer("pa", &a, Some([0.0; 3])),
        peer("pb", &b, Some([2.0, 0.0, 0.0])),
        peer("pc", &c, Some([4.0, 0.0, 0.0])),
    ];
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
    let room = vec![peer("pa", &a, Some([0.0; 3]))];
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
        assert!(0.0 < kind.top_speed && kind.top_speed <= MAX_TOP_SPEED, "{}", kind.kind);
    }
    assert!(KINDS.iter().any(|kind| kind.kind == "impostor"));
}

#[test]
fn a_game_whose_code_panics_ends_its_own_session_and_nothing_else() {
    let games = Games::new(TALLY, Some(1));
    let a = person("a");
    let room = vec![peer("pa", &a, Some([0.0; 3]))];
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
    let room = vec![
        peer("po", &owner, Some([0.0; 3])),
        peer("ph", &host, Some([2.0, 0.0, 0.0])),
        peer("pg", &guest, Some([4.0, 0.0, 0.0])),
    ];
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

#[test]
fn a_lobby_that_never_starts_closes_ten_minutes_after_it_opened() {
    let Lobby { games, mut sa, room, id, .. } = lobby();
    // Its host opening it again, as the same game or another, and people coming to it, do not keep it any longer.
    let c = person("c");
    let mut crowd = room.clone();
    crowd.push(peer("pc", &c, Some([0.0, 0.0, 9.0])));
    let sc = connect(&games, &c, "pc");
    for minute in 1..=9 {
        sa.send(&games, json!({"type": "Open", "kind": "tally"}), &crowd, T0 + minute * 60_000);
    }
    sa.send(&games, json!({"type": "Open", "kind": "quick"}), &crowd, T0 + 9 * 60_000 + 1);
    sa.send(&games, json!({"type": "Open", "kind": "tally"}), &crowd, T0 + 9 * 60_000 + 2);
    sc.send(&games, json!({"type": "Join"}), &crowd, T0 + 9 * 60_000 + 30_000);
    assert_eq!(sa.session().unwrap()["players"].as_array().map(Vec::len), Some(3));
    assert_eq!(games.step(ISLAND, id, &crowd, T0 + LOBBY_LIMIT - 1), Some(IDLE_TICK));
    assert_eq!(games.step(ISLAND, id, &crowd, T0 + LOBBY_LIMIT), None);
    assert_eq!(sa.session(), Some(Value::Null));

    // A lobby opened again after a game has its own ten minutes.
    let Lobby { games, mut sa, sb, room, id, .. } = lobby();
    sa.send(&games, json!({"type": "Start", "layout": {"goal": 1}}), &room, T0 + 60_000);
    sb.send(&games, json!({"type": "Act", "action": {"add": 1}}), &room, T0 + 120_000);
    sa.send(&games, json!({"type": "Open", "kind": "tally"}), &room, T0 + 180_000);
    assert_eq!(sa.session().unwrap()["phase"], "lobby");
    assert_eq!(games.step(ISLAND, id, &room, T0 + 180_000 + LOBBY_LIMIT - 1), Some(IDLE_TICK));
    assert_eq!(games.step(ISLAND, id, &room, T0 + 180_000 + LOBBY_LIMIT), None);
}

#[test]
fn a_visitor_reopening_every_nine_minutes_from_a_peer_nobody_sees_holds_the_island_no_longer() {
    let games = Games::new(TALLY, Some(1));
    let (owner, visitor, other) = (person("o"), person("v"), person("w"));
    let unseen = vec![peer("po", &owner, Some([0.0; 3])), peer("pv", &visitor, None)];
    let mut so = connect_as(&games, &owner, "po", Standing::Owner);
    let mut sv = connect(&games, &visitor, "pv");
    let sw = connect(&games, &other, "pw");
    // A socket that joined the room but never stood anywhere opens nothing.
    sv.frames();
    sv.send(&games, json!({"type": "Open", "kind": "quick"}), &unseen, T0);
    assert_eq!(errors(&sv.frames()), ["not_in_room"]);
    // Shown in the room, the visitor opens a lobby; opening it again every nine minutes holds it ten minutes at most.
    let room = vec![
        peer("po", &owner, Some([0.0; 3])),
        peer("pv", &visitor, Some([1.0, 0.0, 0.0])),
        peer("pw", &other, Some([2.0, 0.0, 0.0])),
    ];
    let id = opened(sv.send(&games, json!({"type": "Open", "kind": "quick"}), &room, T0));
    sv.send(&games, json!({"type": "Open", "kind": "quick"}), &room, T0 + 9 * 60_000);
    assert_eq!(games.step(ISLAND, id, &room, T0 + 9 * 60_000 + 1), Some(IDLE_TICK));
    assert_eq!(games.step(ISLAND, id, &room, T0 + LOBBY_LIMIT), None);
    // Then someone else may open; and the island's owner closes whatever a visitor hosts.
    opened(sw.send(&games, json!({"type": "Open", "kind": "quick"}), &room, T0 + LOBBY_LIMIT + 1));
    so.frames();
    so.send(&games, json!({"type": "Close"}), &room, T0 + LOBBY_LIMIT + 2);
    assert_eq!(so.session(), Some(Value::Null));
}

// ---- Where games see players: a page's jump is followed at the game's top speed

/// Every error code and the latest session among the frames queued for `socket` since the last look.
fn heard(socket: &mut Socket) -> (Vec<String>, Option<Value>) {
    let frames = socket.frames();
    let session =
        frames.iter().filter(|frame| frame["type"] == "Session").map(|frame| frame["session"].clone()).next_back();
    (errors(&frames), session)
}

fn home(index: usize) -> [f64; 3] {
    [index as f64 * 60.0 - 90.0, 80.0, 0.0]
}

/// The room with everyone at home but those `moved`.
fn ship(people: &[User], moved: &[(usize, [f64; 3])]) -> Vec<RoomPeer> {
    people
        .iter()
        .enumerate()
        .map(|(index, user)| {
            let at = moved.iter().find(|(who, _)| *who == index).map_or(home(index), |(_, at)| *at);
            peer(&format!("peer{index}"), user, Some(at))
        })
        .collect()
}

#[test]
fn an_impostor_kills_and_a_crewmate_reports_only_once_the_game_has_them_there() {
    let games = Games::new(KINDS, Some(11));
    let people: Vec<User> = (0..4).map(|index| person(&format!("p{index}"))).collect();
    let mut sockets: Vec<Socket> =
        people.iter().enumerate().map(|(index, user)| connect(&games, user, &format!("peer{index}"))).collect();
    let room = ship(&people, &[]);
    let id = opened(sockets[0].send(&games, json!({"type": "Open", "kind": "impostor"}), &room, T0));
    for socket in &sockets[1..] {
        assert!(matches!(socket.send(&games, json!({"type": "Join"}), &room, T0), Flow::Continue));
    }
    let stations: Vec<[f64; 3]> = (0..6).map(|index| [index as f64 * 20.0 - 50.0, 80.0, 60.0]).collect();
    let layout = json!({"table": [0.0, 80.0, -60.0], "stations": stations});
    sockets[0].send(&games, json!({"type": "Start", "layout": layout}), &room, T0);
    let views: Vec<Value> = sockets.iter_mut().map(|socket| socket.session().unwrap()).collect();
    let impostor = views.iter().position(|view| view["game"]["role"] == "impostor").unwrap();
    // The victim is the crewmate nearest the impostor's home, 60 m off; the finder another.
    let mut crew: Vec<usize> = (0..4).filter(|index| *index != impostor).collect();
    crew.sort_by_key(|index| index.abs_diff(impostor));
    let (victim, finder) = (crew[0], crew[1]);
    // Everyone stays at home, 60 m or more apart, until the first kill may happen.
    let mut now = T0;
    while now < T0 + 16_000 {
        now += 100;
        games.step(ISLAND, id, &room, now);
    }
    // An unchanged view is not sent again: the last one sent is the one the impostor's page shows.
    let (_, seen) = heard(&mut sockets[impostor]);
    let seen = seen.unwrap_or_else(|| views[impostor].clone());
    assert_eq!(seen["game"]["kill"]["targets"], json!([]), "nobody is within the impostor's reach");
    let apart = distance_xz(home(impostor), home(victim));
    assert_eq!(apart, 60.0);
    // 50 ms after the last tick the impostor's page says it stands 1 m from the victim and kills at once.
    let fallen = home(victim);
    let jumped = ship(&people, &[(impostor, [fallen[0] + 1.0, fallen[1], fallen[2]])]);
    let kill = json!({"type": "Act", "action": {"do": "kill", "target": people[victim].id}});
    sockets[impostor].send(&games, kill.clone(), &jumped, now + 50);
    let (refused, _) = heard(&mut sockets[impostor]);
    assert_eq!(refused, ["too_far"], "a jump of {apart} m is followed at running speed");
    // Staying there, the impostor is where the page says some two seconds later (30 m/s), and then the kill goes through.
    for step in 1..=25 {
        games.step(ISLAND, id, &jumped, now + step * 100);
    }
    sockets[impostor].send(&games, kill, &jumped, now + 2_550);
    let (refused, _) = heard(&mut sockets[impostor]);
    assert!(refused.is_empty(), "{refused:?}");
    let (_, dead) = heard(&mut sockets[victim]);
    assert_eq!(dead.unwrap()["game"]["alive"], false);
    // The finder, 60 m or more from the body, says it stands beside it for one update: too far to report.
    let reporting = ship(
        &people,
        &[(impostor, [fallen[0] + 1.0, fallen[1], fallen[2]]), (finder, [fallen[0], fallen[1], fallen[2] + 1.0])],
    );
    sockets[finder].send(
        &games,
        json!({"type": "Act", "action": {"do": "report", "body": 1}}),
        &reporting,
        now + 2_600,
    );
    let (refused, _) = heard(&mut sockets[finder]);
    assert_eq!(refused, ["too_far"]);
}

#[test]
fn a_kart_that_stands_on_each_gate_in_turn_passes_none_faster_than_it_drives() {
    let games = Games::new(KINDS, Some(5));
    let racer = person("racer");
    let up = |x: f64, z: f64| [x, 80.0, z];
    // A 200 by 200 m loop, its eight gates 100 m apart: more than a tick's drive (`JUMP`) between any two.
    let gates: Vec<[f64; 3]> = [
        (0.0, -100.0),
        (100.0, -100.0),
        (100.0, 0.0),
        (100.0, 100.0),
        (0.0, 100.0),
        (-100.0, 100.0),
        (-100.0, 0.0),
        (-100.0, -100.0),
    ]
    .map(|(x, z)| up(x, z))
    .to_vec();
    let grid: Vec<[f64; 3]> =
        (0..8).map(|index| up(-6.0 - 6.0 * (index / 2) as f64, if index % 2 == 0 { -102.5 } else { -97.5 })).collect();
    let layout = json!({"checkpoints": gates, "radius": 8.0, "grid": grid, "laps": 3, "bots": 0});
    let mut socket = connect(&games, &racer, "peer");
    let at = |position: [f64; 3]| vec![peer("peer", &racer, Some(position))];
    let id = opened(socket.send(&games, json!({"type": "Open", "kind": "kart"}), &at([4.0, 1.0, -8.0]), T0));
    socket.send(&games, json!({"type": "Start", "layout": layout}), &at([4.0, 1.0, -8.0]), T0);
    let started = socket.session().unwrap();
    let spawn: [f64; 3] = serde_json::from_value(started["game"]["spawn"].clone()).unwrap();
    // On the grid through the three-second countdown, a tick every 50 ms.
    let mut now = T0;
    while now < T0 + 3_000 {
        now += 50;
        games.step(ISLAND, id, &at(spawn), now);
    }
    // Then each tick the page says the kart stands on its next gate: 2.4 km of track.
    for hop in 1..=24 {
        now += 50;
        games.step(ISLAND, id, &at(gates[hop % 8]), now);
    }
    // Followed at a kart's top speed (45 m/s), the kart has not even reached the first gate, 100 m off.
    let session = socket.session().unwrap();
    let me = &session["game"]["racers"][0];
    assert_eq!((me["lap"].clone(), me["next"].clone()), (json!(0), json!(1)), "{me}");
}
