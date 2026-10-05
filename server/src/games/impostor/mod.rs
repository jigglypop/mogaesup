//! 임포스터, a social deduction game on the host's island, by Among Us's rules. One to three impostors (1 for 4–6
//! players, 2 for 7–10, 3 for 11–15) hide among the crew. The crew do tasks at stations; the impostors pretend to, kill
//! crew one at a time, crawl through vents and sabotage. Whoever finds a body reports it, and anyone alive may call one
//! emergency meeting a game at the table: everyone alive sits around it, talks, then votes, and a unique top target
//! with more votes than skips is ejected. The crew win when every crew task is done or every impostor is out; the
//! impostors win once they are as many as the living crew, or when the reactor melts down.
//!
//! Bots (see `bots.rs`) fill the table, so one person can play: the host adds up to nine, and someone playing alone
//! may pick their own role.
//!
//! - Tasks: each crew member gets four different stations (fewer when the island has fewer), each station one kind of
//!   task. `task` within 1.8 m of an unfinished one starts it; the page plays it and `finish` ends it, no sooner than
//!   the kind takes and while still there; stepping away or `stop` drops it. Ghosts (dead crew) still do theirs.
//!   Impostors get a list of the same shape they cannot do.
//! - Kills: a living impostor out of the vents kills a living crew member within 2.2 m, not during a meeting, 15 s
//!   after the start and 25 s after their own last kill and each meeting's end. The body stays until a meeting ends.
//! - Vents: a living impostor within 1.5 m of one gets in (`vent`), moves to any other (`vent` with `to`) and gets out
//!   (`vent` again). Inside they are hidden, and they climb out once they stand 3 m from every vent.
//! - Sabotage: an impostor, alive or dead, 20 s after the start and 30 s after the last one was fixed, breaks the
//!   lights (the crew see less), the comms (the crew lose their task bar) or the reactor (40 s to fix or the
//!   impostors win). The lights and the comms are fixed at their panel (`fix`); the reactor needs both its panels held
//!   at once (`fix` at each, holding while in reach). Emergency meetings wait until it is fixed; a meeting fixes it.
//! - Meetings: `report` within 3 m of an unreported body, or `meeting` within 3 m of the table, once a player and not
//!   in the 15 s after the start or a meeting. At a meeting every death so far turns public. The living talk for 30 s
//!   (8 s when one person is left among bots), then vote for 30 s (`target`: a living player, or null to skip), once
//!   each; the vote ends when every living player has voted. When it ends the bodies go and the waits start again.
//! - Talk: up to 120 characters a line, one line a second. The living talk to everyone during meetings; the dead talk
//!   any time, to the dead only.
//!
//! Layout (from the host's page): `{"stations": [[x, y, z]; 6..=12], "table": [x, y, z], "vents": [[x, y, z]; 0..=8],
//! "walk": [[x, y, z]; 0..=400], "bots": 0..=9, "role": "crew" | "impostor" | null}`: open spots of the island (the
//! walk is where bots may go), the bots to add, and the role of someone playing alone. Stations nearer than 3.6 m to
//! the table or an earlier station count as that place; six must remain. People and bots together are 4 to 15.
//!
//! Actions: `{"do": "task"}`, `{"do": "finish"}`, `{"do": "stop"}`, `{"do": "kill", "target": id}`, `{"do": "report",
//! "body": n}`, `{"do": "meeting"}`, `{"do": "vote", "target": id | null}`, `{"do": "say", "text": "…"}`,
//! `{"do": "vent", "to": n?}`, `{"do": "sabotage", "kind": "lights" | "comms" | "reactor"}`, `{"do": "fix"}`.
//!
//! View (per viewer; secrets only to their owner): `phase` (`play` | `discuss` | `vote` | `ended`), `role` (`crew` |
//! `impostor`, null to someone watching), `impostors` (to impostors only), `alive`, `spawn` (where the viewer starts),
//! `tasks` (`[{station, done}]`, an impostor's being fake), `working` (`{station, kind, readyAt}` | null), `progress`
//! (`{done, total}` over the crew's tasks; null to the crew while the comms are down), `players` (`[{id, name, alive,
//! bot}]` as everyone knows it; to the dead, as it is), `hidden` (people whose avatars the viewer does not see: the
//! dead, even once they have left, and those in vents), `bots` (`[{id, name, color, route: {points, departAt, speed},
//! ghost}]`, the ones the viewer sees), `bodies` (`[{id, victim, color, name, position, reported}]`, a bot's in its
//! colour), `table`, `stations`, `stationKinds`, `vents`, `panels` (`{lights, comms, reactor: [a, b]}`, stations),
//! `sabotage` (null or `{kind, endsAt, held}`), `sabotageFrom` (to impostors), `venting` (the viewer's vent),
//! `meeting`, `talk`, `lastMeeting` (`{number, ejected, name, impostor, remaining, votes}`), `kill` (to living
//! impostors: `{readyAt, targets}`), `near` (`{station, body, table, vent, panel}`: what the viewer's buttons reach, as
//! of the last tick), `emergencyLeft` and `emergencyFrom`.
//!
//! Events: `{"type": "killed"}` to the victim; `{"type": "meeting", number, reason, caller, victim}`, `{"type":
//! "verdict", number, ejected, name, impostor}`, `{"type": "sabotage", kind}` and `{"type": "fixed", kind}` to
//! everyone.
//!
//! Result: `{"winner": "crew" | "impostor", "reason": "tasks" | "impostorsOut" | "parity" | "meltdown", "players":
//! [{id, name, role, alive, left, bot}]}`.

mod bots;
#[cfg(test)]
mod tests;
mod walk;

use rand::{Rng, rngs::StdRng};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    f64::consts::TAU,
};
use uuid::Uuid;

use super::{
    BAD_ACTION, BAD_LAYOUT, Ctx, Game, GameError, Kind, Millis, distance_xz, distinct, layout_points, pick_many, point,
    within,
};
use bots::Bot;
use walk::{Route, Walk};

pub(crate) const KIND: Kind = Kind::new("impostor", 1, MAX_PLAYERS, create).ticking(10);

/// People and bots together.
const MIN_PLAYERS: usize = 4;
const MAX_PLAYERS: usize = 15;
const MAX_BOTS: usize = 9;
const MIN_STATIONS: usize = 6;
const MAX_STATIONS: usize = 12;
const MAX_VENTS: usize = 8;
const MAX_WALK: usize = 400;
/// Places nearer than this are one: each station's reach stays its own and clear of the table.
const SAME_PLACE: f64 = 2.0 * TASK_REACH;
/// Vents nearer than this are one.
const SAME_VENT: f64 = 2.0;
/// Tasks per player, when the island has that many stations.
const TASKS_EACH: usize = 4;
/// How near (on the ground) a station must be to work at it or fix its panel, in meters.
const TASK_REACH: f64 = 1.8;
const VENT_REACH: f64 = 1.5;
/// Someone in the vents standing this far from every vent has climbed out.
const VENT_LEASH: f64 = 3.0;
const KILL_REACH: f64 = 2.2;
const FIRST_KILL: Millis = 15_000;
const KILL_COOLDOWN: Millis = 25_000;
const REPORT_REACH: f64 = 3.0;
const TABLE_REACH: f64 = 3.0;
/// No emergency meeting this soon after the start or a meeting's end.
const CALM: Millis = 15_000;
const DISCUSS: Millis = 30_000;
/// The talk before the vote when at most one person alive is not a bot.
const DISCUSS_ALONE: Millis = 8_000;
const VOTE: Millis = 30_000;
const FIRST_SABOTAGE: Millis = 20_000;
const SABOTAGE_COOLDOWN: Millis = 30_000;
const REACTOR_TIME: Millis = 40_000;
const MAX_TEXT: usize = 120;
/// The least time between two lines of one player.
const TALK_GAP: Millis = 1_000;
/// Lines kept in each log.
const TALK_KEPT: usize = 30;
/// Room for each seat along the circle around the table, and the circle's least and greatest radius.
const SEAT_ROOM: f64 = 0.8;
const SEAT_NEAR: f64 = 1.6;
const SEAT_FAR: f64 = 2.4;

const FEW_STATIONS: GameError = GameError::new("few_stations", "작업 자리가 부족해요.");
const FEW_PLAYERS: GameError = GameError::new("few_players", "사람과 봇을 합쳐 4명 이상이어야 해요.");
const MANY_PLAYERS: GameError = GameError::new("many_players", "사람과 봇을 합쳐 15명까지예요.");
const NOT_NOW: GameError = GameError::new("not_now", "지금은 할 수 없어요.");
const OUT: GameError = GameError::new("out", "탈락해서 할 수 없어요.");
const TOO_FAR: GameError = GameError::new("too_far", "너무 멀어요.");
const NO_TASK: GameError = GameError::new("no_task", "가까이에 할 작업이 없어요.");
const BUSY: GameError = GameError::new("busy", "이미 작업 중이에요.");
const NOT_YET: GameError = GameError::new("not_yet", "아직 끝나지 않았어요.");
const COOLDOWN: GameError = GameError::new("cooldown", "아직 할 수 없어요.");
const NO_TARGET: GameError = GameError::new("no_target", "고를 수 없는 사람이에요.");
const NO_BODY: GameError = GameError::new("no_body", "신고할 수 없어요.");
const CALLED: GameError = GameError::new("called", "긴급 회의를 이미 열었어요.");
const TOO_SOON: GameError = GameError::new("too_soon", "아직 긴급 회의를 열 수 없어요.");
const BROKEN: GameError = GameError::new("broken", "고장을 먼저 고쳐야 해요.");
const VOTED: GameError = GameError::new("voted", "이미 투표했어요.");
const BAD_TEXT: GameError = GameError::new("bad_text", "보낼 수 없는 말이에요.");
const TOO_FAST: GameError = GameError::new("too_fast", "조금 천천히 말해 주세요.");
const IN_VENT: GameError = GameError::new("in_vent", "환풍구 안에서는 할 수 없어요.");
const NO_VENT: GameError = GameError::new("no_vent", "가까이에 환풍구가 없어요.");
const NOTHING_BROKEN: GameError = GameError::new("nothing_broken", "고칠 것이 없어요.");
const NO_PANEL: GameError = GameError::new("no_panel", "고장 난 곳으로 가야 해요.");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    Crew,
    Impostor,
}

impl Role {
    fn name(self) -> &'static str {
        match self {
            Self::Crew => "crew",
            Self::Impostor => "impostor",
        }
    }
}

/// Why a side won.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reason {
    /// Every crew task is done.
    Tasks,
    /// No impostor is left alive in the game.
    ImpostorsOut,
    /// The impostors alive are as many as the crew alive.
    Parity,
    /// Nobody fixed the reactor in time.
    Meltdown,
}

impl Reason {
    fn name(self) -> &'static str {
        match self {
            Self::Tasks => "tasks",
            Self::ImpostorsOut => "impostorsOut",
            Self::Parity => "parity",
            Self::Meltdown => "meltdown",
        }
    }
}

/// What a station's task is: the page plays it, and it takes at least this long.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Chore {
    Wires,
    Swipe,
    Download,
    Numbers,
    Calibrate,
    Fuel,
}

impl Chore {
    const ALL: [Self; 6] = [Self::Wires, Self::Swipe, Self::Download, Self::Numbers, Self::Calibrate, Self::Fuel];

    fn name(self) -> &'static str {
        match self {
            Self::Wires => "wires",
            Self::Swipe => "swipe",
            Self::Download => "download",
            Self::Numbers => "numbers",
            Self::Calibrate => "calibrate",
            Self::Fuel => "fuel",
        }
    }

    /// The least a person takes to do it on their page.
    fn least(self) -> Millis {
        match self {
            Self::Swipe => 1_000,
            Self::Wires => 1_500,
            Self::Numbers | Self::Calibrate => 2_000,
            Self::Fuel => 3_000,
            Self::Download => 6_000,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Trouble {
    Lights,
    Comms,
    Reactor,
}

impl Trouble {
    fn name(self) -> &'static str {
        match self {
            Self::Lights => "lights",
            Self::Comms => "comms",
            Self::Reactor => "reactor",
        }
    }

    fn parse(name: &str) -> Option<Self> {
        [Self::Lights, Self::Comms, Self::Reactor].into_iter().find(|trouble| trouble.name() == name)
    }
}

/// A sabotage underway.
struct Sabotage {
    kind: Trouble,
    /// When the reactor melts down.
    deadline: Option<Millis>,
    /// Who holds each reactor panel.
    held: [Option<Uuid>; 2],
}

/// The stations whose panels fix each sabotage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Panels {
    lights: usize,
    comms: usize,
    reactor: [usize; 2],
}

struct Task {
    station: usize,
    done: bool,
}

/// A task underway: its index in the player's list, and when it may be finished.
#[derive(Clone, Copy)]
struct Work {
    task: usize,
    ready: Millis,
}

struct Player {
    id: Uuid,
    name: String,
    role: Role,
    alive: bool,
    /// Whether everyone has been told this player is out: a death turns public when a meeting starts.
    known_dead: bool,
    /// Gone from the game: out of every count, but listed in the result.
    left: bool,
    /// Some for a bot, which the game plays itself.
    bot: Option<Bot>,
    tasks: Vec<Task>,
    working: Option<Work>,
    /// When this player may kill next (impostors).
    kill_at: Millis,
    /// Whether they have called their emergency meeting.
    called: bool,
    said_at: Option<Millis>,
    /// The vent they are in.
    venting: Option<usize>,
}

impl Player {
    fn living(&self) -> bool {
        self.alive && !self.left
    }
}

struct Body {
    id: u32,
    victim: Uuid,
    /// A bot's colour, which its body keeps.
    color: Option<usize>,
    name: String,
    position: [f64; 3],
    reported: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Discuss,
    Vote,
}

struct Meeting {
    number: u32,
    caller: Uuid,
    caller_name: String,
    /// Whose body was reported; None for an emergency meeting.
    body: Option<(Uuid, String)>,
    stage: Stage,
    discuss_until: Millis,
    vote_until: Millis,
    /// Where each player alive at the start sits, around the table.
    seats: Vec<(Uuid, [f64; 3])>,
    /// Who voted for whom (None: skipped), in the order cast.
    votes: Vec<(Uuid, Option<Uuid>)>,
}

/// How the last meeting ended.
struct Verdict {
    number: u32,
    ejected: Option<(Uuid, String, Role)>,
    /// Impostors left alive after it.
    remaining: usize,
    votes: Vec<(Uuid, Option<Uuid>)>,
}

struct Line {
    id: u32,
    from: Uuid,
    name: String,
    text: String,
    ghost: bool,
}

pub(crate) struct Impostor {
    stations: Vec<[f64; 3]>,
    chores: Vec<Chore>,
    table: [f64; 3],
    vents: Vec<[f64; 3]>,
    panels: Panels,
    walk: Walk,
    /// Everyone who started, people in the order they joined, then the bots.
    players: Vec<Player>,
    /// Where each starts, around the table.
    spawns: HashMap<Uuid, [f64; 3]>,
    bodies: Vec<Body>,
    meeting: Option<Meeting>,
    last: Option<Verdict>,
    meetings: u32,
    next_body: u32,
    next_line: u32,
    /// This meeting's lines, to everyone.
    talk: VecDeque<Line>,
    /// The dead's lines, to the dead.
    ghost_talk: VecDeque<Line>,
    /// When emergency meetings may be called again.
    calm_until: Millis,
    sabotage: Option<Sabotage>,
    /// When impostors may sabotage again.
    sabotage_at: Millis,
    /// Where everyone stood at the last tick: what the views' in-reach flags are measured from.
    seen: HashMap<Uuid, [f64; 3]>,
    winner: Option<(Role, Reason)>,
}

/// How many impostors play among `players`.
fn impostors_for(players: usize) -> usize {
    match players {
        0..=6 => 1,
        7..=10 => 2,
        _ => 3,
    }
}

fn create(layout: &Value, ctx: &mut Ctx) -> Result<Box<dyn Game>, GameError> {
    Ok(Box::new(Impostor::new(layout, ctx)?))
}

/// Centimeters, as the host's spots are written.
fn round(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// A uuid in an action, or None.
fn id(value: &Value) -> Option<Uuid> {
    value.as_str().and_then(|text| Uuid::parse_str(text).ok())
}

/// Text a player may say: something, at most [`MAX_TEXT`] characters once trimmed, with no control characters (nor
/// the invisible ones that turn the text around).
fn clean(text: &str) -> Option<&str> {
    let text = text.trim();
    let turns = |c: char| matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}');
    let fine =
        !text.is_empty() && text.chars().count() <= MAX_TEXT && !text.chars().any(|c| c.is_control() || turns(c));
    fine.then_some(text)
}

/// `layout[field]` when it is there: a list of `0..=max` points; none when it is missing or null.
fn optional_points(layout: &Value, field: &str, max: usize) -> Result<Vec<[f64; 3]>, GameError> {
    match layout.get(field) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(_) => layout_points(layout, field, 0, max),
    }
}

/// `count` places around `center`, a seat each, spread on a circle that gives each enough room.
fn circle(center: [f64; 3], count: usize) -> Vec<[f64; 3]> {
    let share = count.max(1) as f64;
    let radius = (share * SEAT_ROOM / TAU).clamp(SEAT_NEAR, SEAT_FAR);
    let [x, y, z] = center;
    (0..count)
        .map(|index| {
            let angle = TAU * index as f64 / share;
            [round(x + radius * angle.cos()), y, round(z + radius * angle.sin())]
        })
        .collect()
}

/// The two stations farthest apart for the reactor, and two more for the lights and the comms.
fn panels(stations: &[[f64; 3]], rng: &mut StdRng) -> Panels {
    let mut reactor = [0, 1];
    let mut far = -1.0;
    for a in 0..stations.len() {
        for b in a + 1..stations.len() {
            let apart = distance_xz(stations[a], stations[b]);
            if apart > far {
                (far, reactor) = (apart, [a, b]);
            }
        }
    }
    let others: Vec<usize> = (0..stations.len()).filter(|station| !reactor.contains(station)).collect();
    let picked = pick_many(rng, &others, 2);
    Panels { lights: picked[0], comms: picked[1], reactor }
}

impl Impostor {
    fn new(layout: &Value, ctx: &mut Ctx) -> Result<Self, GameError> {
        // The host's page computed this: check the shape, the counts and the coordinates before using it.
        let table = point(&layout["table"])?;
        let mut places = vec![table];
        places.extend(layout_points(layout, "stations", MIN_STATIONS, MAX_STATIONS)?);
        let stations: Vec<[f64; 3]> = distinct(places, SAME_PLACE).into_iter().skip(1).collect();
        if stations.len() < MIN_STATIONS {
            return Err(FEW_STATIONS);
        }
        let vents = distinct(optional_points(layout, "vents", MAX_VENTS)?, SAME_VENT);
        let walk = optional_points(layout, "walk", MAX_WALK)?;
        let bots = match layout.get("bots") {
            None | Some(Value::Null) => 0,
            Some(count) => count.as_u64().filter(|count| *count <= MAX_BOTS as u64).ok_or(BAD_LAYOUT)? as usize,
        };
        let wanted = match layout.get("role").map(|role| (role, role.as_str())) {
            None | Some((Value::Null, _)) => None,
            Some((_, Some("crew"))) => Some(Role::Crew),
            Some((_, Some("impostor"))) => Some(Role::Impostor),
            Some(_) => return Err(BAD_LAYOUT),
        };
        let people = ctx.players();
        let total = people.len() + bots;
        if total < MIN_PLAYERS {
            return Err(FEW_PLAYERS);
        }
        if total > MAX_PLAYERS {
            return Err(MANY_PLAYERS);
        }

        let now = ctx.now();
        let mut players: Vec<Player> = people
            .iter()
            .map(|member| Player {
                id: member.id,
                name: member.name.clone(),
                role: Role::Crew,
                alive: true,
                known_dead: false,
                left: false,
                bot: None,
                tasks: Vec::new(),
                working: None,
                kill_at: now + FIRST_KILL,
                called: false,
                said_at: None,
                venting: None,
            })
            .collect();
        let taken: Vec<&str> = people.iter().map(|member| member.name.as_str()).collect();
        for (color, name) in bots::names(ctx.rng(), bots, &taken).into_iter().enumerate() {
            let id = uuid::Builder::from_random_bytes(ctx.rng().r#gen()).into_uuid();
            players.push(Player {
                id,
                name,
                role: Role::Crew,
                alive: true,
                known_dead: false,
                left: false,
                bot: Some(Bot::new(color, Route::still(table, now), now)),
                tasks: Vec::new(),
                working: None,
                kill_at: now + FIRST_KILL,
                called: false,
                said_at: None,
                venting: None,
            });
        }

        // Someone playing alone may choose their side; the impostors come from the others.
        let count = impostors_for(total);
        let alone = (people.len() == 1).then_some(wanted).flatten();
        let mut pool: Vec<usize> = (0..players.len()).collect();
        let mut impostors = Vec::new();
        if let Some(role) = alone {
            pool.retain(|index| *index != 0);
            if role == Role::Impostor {
                impostors.push(0);
            }
        }
        let more = count - impostors.len();
        impostors.extend(pick_many(ctx.rng(), &pool, more));
        for index in impostors {
            players[index].role = Role::Impostor;
        }

        let order: Vec<usize> = (0..stations.len()).collect();
        for player in &mut players {
            player.tasks = pick_many(ctx.rng(), &order, TASKS_EACH)
                .into_iter()
                .map(|station| Task { station, done: false })
                .collect();
        }
        let mut kinds = Chore::ALL.to_vec();
        let shuffled = pick_many(ctx.rng(), &kinds, kinds.len());
        kinds = shuffled;
        let chores = (0..stations.len()).map(|station| kinds[station % kinds.len()]).collect();
        let panels = panels(&stations, ctx.rng());

        // Everyone starts around the table; the bots stand there, the people's pages move them there.
        let seats = circle(table, players.len());
        let spawns: HashMap<Uuid, [f64; 3]> =
            players.iter().zip(&seats).map(|(player, seat)| (player.id, *seat)).collect();
        for (player, seat) in players.iter_mut().zip(&seats) {
            if let Some(bot) = player.bot.as_mut() {
                bot.route = Route::still(*seat, now);
            }
        }

        // Bots walk between open spots, the places of the game included.
        let mut nodes = walk;
        nodes.extend(&stations);
        nodes.extend(&vents);
        nodes.push(table);
        Ok(Self {
            stations,
            chores,
            table,
            vents,
            panels,
            walk: Walk::new(nodes),
            players,
            spawns,
            bodies: Vec::new(),
            meeting: None,
            last: None,
            meetings: 0,
            next_body: 1,
            next_line: 1,
            talk: VecDeque::new(),
            ghost_talk: VecDeque::new(),
            calm_until: now + CALM,
            sabotage: None,
            sabotage_at: now + FIRST_SABOTAGE,
            seen: HashMap::new(),
            winner: None,
        })
    }

    /// `id` while they are in the game.
    fn present(&self, id: Uuid) -> Option<&Player> {
        self.players.iter().find(|player| player.id == id && !player.left)
    }

    fn living(&self, role: Role) -> usize {
        self.players.iter().filter(|player| player.living() && player.role == role).count()
    }

    /// The crew's tasks done, and all of them (of those still in the game).
    fn progress(&self) -> (usize, usize) {
        let crew = self.players.iter().filter(|player| !player.left && player.role == Role::Crew);
        crew.flat_map(|player| &player.tasks).fold((0, 0), |(done, all), task| (done + usize::from(task.done), all + 1))
    }

    /// Whether the game is between meetings and not over: when kills, tasks, reports and calls happen.
    fn roaming(&self) -> bool {
        self.meeting.is_none() && self.winner.is_none()
    }

    fn broken(&self, kind: Trouble) -> bool {
        self.sabotage.as_ref().is_some_and(|sabotage| sabotage.kind == kind)
    }

    /// Where player `index` stands now: a bot where its route has it, a person where the live room has them.
    fn position(&self, index: usize, ctx: &Ctx) -> Option<[f64; 3]> {
        let player = &self.players[index];
        match &player.bot {
            Some(bot) => Some(bot.route.at(ctx.now())),
            None => ctx.position(player.id),
        }
    }

    /// The nearest of `player`'s unfinished tasks with its station within reach of `at`: its index in their list.
    fn task_near(&self, player: &Player, at: [f64; 3]) -> Option<usize> {
        player
            .tasks
            .iter()
            .enumerate()
            .filter(|(_, task)| !task.done)
            .map(|(index, task)| (index, distance_xz(self.stations[task.station], at)))
            .filter(|(_, distance)| *distance <= TASK_REACH)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(index, _)| index)
    }

    /// The nearest unreported body within reach of `at`.
    fn body_near(&self, at: [f64; 3]) -> Option<&Body> {
        self.bodies
            .iter()
            .filter(|body| !body.reported)
            .map(|body| (body, distance_xz(body.position, at)))
            .filter(|(_, distance)| *distance <= REPORT_REACH)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(body, _)| body)
    }

    /// The nearest vent within reach of `at`.
    fn vent_near(&self, at: [f64; 3], reach: f64) -> Option<usize> {
        (0..self.vents.len())
            .map(|vent| (vent, distance_xz(self.vents[vent], at)))
            .filter(|(_, distance)| *distance <= reach)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(vent, _)| vent)
    }

    /// The stations whose panels fix the sabotage underway.
    fn trouble_spots(&self) -> Vec<usize> {
        match self.sabotage.as_ref().map(|sabotage| sabotage.kind) {
            Some(Trouble::Lights) => vec![self.panels.lights],
            Some(Trouble::Comms) => vec![self.panels.comms],
            Some(Trouble::Reactor) => self.panels.reactor.to_vec(),
            None => Vec::new(),
        }
    }

    /// Which of the sabotage's panels (by its place in [`Impostor::trouble_spots`]) is within reach of `at`.
    fn panel_near(&self, at: [f64; 3]) -> Option<usize> {
        self.trouble_spots().iter().position(|station| within(self.stations[*station], at, TASK_REACH))
    }

    /// The living crew within an impostor's reach of `at`, nearest first.
    fn targets_near(&self, at: [f64; 3]) -> Vec<Uuid> {
        let mut near: Vec<(Uuid, f64)> = self
            .players
            .iter()
            .filter(|player| player.living() && player.role == Role::Crew)
            .filter_map(|player| Some((player.id, distance_xz(*self.seen.get(&player.id)?, at))))
            .filter(|(_, distance)| *distance <= KILL_REACH)
            .collect();
        near.sort_by(|a, b| a.1.total_cmp(&b.1));
        near.into_iter().map(|(id, _)| id).collect()
    }

    /// Whether every living player has voted.
    fn all_voted(&self) -> bool {
        let Some(meeting) = &self.meeting else { return false };
        self.players
            .iter()
            .filter(|player| player.living())
            .all(|player| meeting.votes.iter().any(|(voter, _)| *voter == player.id))
    }

    /// Ends the game once a side has won: crew when no impostor is left alive or every crew task is done, impostors
    /// once they are as many as the living crew.
    fn judge(&mut self) {
        if self.winner.is_some() {
            return;
        }
        let (impostors, crew) = (self.living(Role::Impostor), self.living(Role::Crew));
        let (done, all) = self.progress();
        let winner = if impostors == 0 {
            Some((Role::Crew, Reason::ImpostorsOut))
        } else if impostors >= crew {
            Some((Role::Impostor, Reason::Parity))
        } else if all > 0 && done == all {
            Some((Role::Crew, Reason::Tasks))
        } else {
            None
        };
        if let Some(winner) = winner {
            self.end(winner);
        }
    }

    fn end(&mut self, winner: (Role, Reason)) {
        self.winner = Some(winner);
        self.meeting = None;
        self.sabotage = None;
        for player in &mut self.players {
            player.working = None;
            player.venting = None;
        }
    }

    /// Calls everyone alive to the table: tasks underway stop, everyone leaves the vents, the sabotage is over, every
    /// death turns public, and each gets a seat around the table.
    fn open_meeting(&mut self, caller: usize, body: Option<(Uuid, String)>, ctx: &mut Ctx) {
        let now = ctx.now();
        self.meetings += 1;
        self.sabotage = None;
        for player in &mut self.players {
            player.working = None;
            player.venting = None;
            player.known_dead |= !player.alive;
        }
        let seated: Vec<Uuid> = self.players.iter().filter(|player| player.living()).map(|player| player.id).collect();
        let seats: Vec<(Uuid, [f64; 3])> = seated.iter().copied().zip(circle(self.table, seated.len())).collect();
        let people = self.players.iter().filter(|player| player.living() && player.bot.is_none()).count();
        let discuss = if people > 1 { DISCUSS } else { DISCUSS_ALONE };
        let caller = &self.players[caller];
        ctx.emit(json!({
            "type": "meeting",
            "number": self.meetings,
            "reason": if body.is_some() { "report" } else { "emergency" },
            "caller": caller.id,
            "victim": body.as_ref().map(|(victim, _)| victim),
        }));
        self.meeting = Some(Meeting {
            number: self.meetings,
            caller: caller.id,
            caller_name: caller.name.clone(),
            body,
            stage: Stage::Discuss,
            discuss_until: now + discuss,
            vote_until: now + discuss + VOTE,
            seats,
            votes: Vec::new(),
        });
        self.seat_bots(ctx);
    }

    /// Counts the votes: a unique top target with more votes than skips is ejected. Then the bodies go and the waits
    /// start again.
    fn close_meeting(&mut self, ctx: &mut Ctx) {
        let Some(meeting) = self.meeting.take() else { return };
        let now = ctx.now();
        // Only votes of players still in the game, for players still in it, count.
        let votes: Vec<(Uuid, Option<Uuid>)> = meeting
            .votes
            .into_iter()
            .filter(|(voter, target)| {
                self.present(*voter).is_some() && target.is_none_or(|target| self.present(target).is_some())
            })
            .collect();
        let skips = votes.iter().filter(|(_, target)| target.is_none()).count();
        let tally: Vec<(Uuid, usize)> = self
            .players
            .iter()
            .map(|player| (player.id, votes.iter().filter(|(_, target)| *target == Some(player.id)).count()))
            .filter(|(_, count)| *count > 0)
            .collect();
        let top = tally.iter().map(|(_, count)| *count).max().unwrap_or(0);
        let leaders: Vec<Uuid> = tally.iter().filter(|(_, count)| *count == top).map(|(id, _)| *id).collect();
        let ejected = match leaders.as_slice() {
            [one] if top > skips => self.players.iter_mut().find(|player| player.id == *one),
            _ => None,
        }
        .map(|player| {
            player.alive = false;
            player.known_dead = true;
            player.working = None;
            (player.id, player.name.clone(), player.role)
        });
        self.bodies.clear();
        self.talk.clear();
        for player in &mut self.players {
            if player.role == Role::Impostor {
                player.kill_at = now + KILL_COOLDOWN;
            }
        }
        self.calm_until = now + CALM;
        self.sabotage_at = self.sabotage_at.max(now + SABOTAGE_COOLDOWN);
        ctx.emit(json!({
            "type": "verdict",
            "number": meeting.number,
            "ejected": ejected.as_ref().map(|(id, _, _)| id),
            "name": ejected.as_ref().map(|(_, name, _)| name),
            "impostor": ejected.as_ref().map(|(_, _, role)| *role == Role::Impostor),
        }));
        let remaining = self.living(Role::Impostor);
        self.last = Some(Verdict { number: meeting.number, ejected, remaining, votes });
        self.release_bots(ctx);
        self.judge();
    }

    /// Kills `victim` where they stand, `at`: their body stays there, and the bots who saw it remember who did it.
    fn kill_now(&mut self, killer: usize, victim: usize, at: [f64; 3], ctx: &mut Ctx) {
        let now = ctx.now();
        self.players[killer].kill_at = now + KILL_COOLDOWN;
        let killer = self.players[killer].id;
        let dead = &mut self.players[victim];
        dead.alive = false;
        dead.working = None;
        if let Some(bot) = dead.bot.as_mut() {
            bot.died(at, now);
        }
        let (target, color) = (dead.id, dead.bot.as_ref().map(|bot| bot.color));
        let body =
            Body { id: self.next_body, victim: target, color, name: dead.name.clone(), position: at, reported: false };
        self.bodies.push(body);
        self.next_body += 1;
        ctx.emit_one(target, json!({"type": "killed"}));
        self.witness(killer, target, at, ctx);
        self.judge();
    }

    /// Tasks underway: dropped once their player steps away.
    fn work(&mut self, ctx: &Ctx) {
        let stations = &self.stations;
        for player in &mut self.players {
            let Some(work) = player.working else { continue };
            let station = stations[player.tasks[work.task].station];
            if !ctx.position(player.id).is_some_and(|at| within(station, at, TASK_REACH)) {
                player.working = None;
            }
        }
    }

    /// Who has climbed out of the vents by walking away from them.
    fn vents_left(&mut self, ctx: &Ctx) {
        let vents = &self.vents;
        for player in &mut self.players {
            if player.venting.is_some()
                && !ctx.position(player.id).is_some_and(|at| vents.iter().any(|vent| within(*vent, at, VENT_LEASH)))
            {
                player.venting = None;
            }
        }
    }

    /// The reactor: a holder who stepped away lets go; both panels held fixes it; its time running out ends the game.
    fn reactor(&mut self, ctx: &mut Ctx) {
        let Some(sabotage) = self.sabotage.as_ref().filter(|sabotage| sabotage.kind == Trouble::Reactor) else {
            return;
        };
        if sabotage.deadline.is_some_and(|deadline| ctx.now() >= deadline) {
            self.end((Role::Impostor, Reason::Meltdown));
            return;
        }
        let mut held = sabotage.held;
        for (panel, holder) in held.iter_mut().enumerate() {
            let station = self.stations[self.panels.reactor[panel]];
            let stays =
                holder.and_then(|id| self.players.iter().position(|player| player.id == id)).is_some_and(|index| {
                    self.players[index].living()
                        && self.position(index, ctx).is_some_and(|at| within(station, at, TASK_REACH))
                });
            if !stays {
                *holder = None;
            }
        }
        if let Some(sabotage) = self.sabotage.as_mut() {
            sabotage.held = held;
        }
        if held.iter().all(Option::is_some) {
            self.fixed(ctx);
        }
    }

    fn fixed(&mut self, ctx: &mut Ctx) {
        let Some(sabotage) = self.sabotage.take() else { return };
        self.sabotage_at = ctx.now() + SABOTAGE_COOLDOWN;
        ctx.emit(json!({"type": "fixed", "kind": sabotage.kind.name()}));
    }

    fn start_task(&mut self, me: usize, ctx: &Ctx) -> Result<(), GameError> {
        let player = &self.players[me];
        if !self.roaming() {
            return Err(NOT_NOW);
        }
        if player.role == Role::Impostor {
            return Err(NO_TASK);
        }
        if player.working.is_some() {
            return Err(BUSY);
        }
        let task = ctx.position(player.id).and_then(|at| self.task_near(player, at)).ok_or(NO_TASK)?;
        let ready = ctx.now() + self.chores[player.tasks[task].station].least();
        self.players[me].working = Some(Work { task, ready });
        Ok(())
    }

    fn finish(&mut self, me: usize, ctx: &Ctx) -> Result<(), GameError> {
        let player = &self.players[me];
        if !self.roaming() {
            return Err(NOT_NOW);
        }
        let work = player.working.ok_or(NO_TASK)?;
        if ctx.now() < work.ready {
            return Err(NOT_YET);
        }
        let station = self.stations[player.tasks[work.task].station];
        if !ctx.position(player.id).is_some_and(|at| within(station, at, TASK_REACH)) {
            return Err(TOO_FAR);
        }
        let player = &mut self.players[me];
        player.tasks[work.task].done = true;
        player.working = None;
        self.judge();
        Ok(())
    }

    fn kill(&mut self, me: usize, target: Uuid, ctx: &mut Ctx) -> Result<(), GameError> {
        let killer = &self.players[me];
        if killer.role != Role::Impostor {
            return Err(BAD_ACTION);
        }
        if !killer.alive {
            return Err(OUT);
        }
        if !self.roaming() {
            return Err(NOT_NOW);
        }
        if killer.venting.is_some() {
            return Err(IN_VENT);
        }
        if ctx.now() < killer.kill_at {
            return Err(COOLDOWN);
        }
        let victim = self
            .players
            .iter()
            .position(|player| player.id == target && player.living() && player.role == Role::Crew)
            .ok_or(NO_TARGET)?;
        let (Some(from), Some(at)) = (ctx.position(killer.id), self.position(victim, ctx)) else { return Err(TOO_FAR) };
        if !within(from, at, KILL_REACH) {
            return Err(TOO_FAR);
        }
        self.kill_now(me, victim, at, ctx);
        Ok(())
    }

    fn report(&mut self, me: usize, body: u64, ctx: &mut Ctx) -> Result<(), GameError> {
        let player = &self.players[me];
        if !player.alive {
            return Err(OUT);
        }
        if !self.roaming() {
            return Err(NOT_NOW);
        }
        if player.venting.is_some() {
            return Err(IN_VENT);
        }
        let found =
            self.bodies.iter().position(|found| u64::from(found.id) == body && !found.reported).ok_or(NO_BODY)?;
        if !self.position(me, ctx).is_some_and(|at| within(self.bodies[found].position, at, REPORT_REACH)) {
            return Err(TOO_FAR);
        }
        self.report_body(me, found, ctx);
        Ok(())
    }

    /// Player `me` reports body `found` (its place in the list): a meeting.
    fn report_body(&mut self, me: usize, found: usize, ctx: &mut Ctx) {
        let body = &mut self.bodies[found];
        body.reported = true;
        let victim = (body.victim, body.name.clone());
        self.open_meeting(me, Some(victim), ctx);
    }

    fn emergency(&mut self, me: usize, ctx: &mut Ctx) -> Result<(), GameError> {
        let player = &self.players[me];
        if !player.alive {
            return Err(OUT);
        }
        if !self.roaming() {
            return Err(NOT_NOW);
        }
        if player.venting.is_some() {
            return Err(IN_VENT);
        }
        if player.called {
            return Err(CALLED);
        }
        if self.sabotage.is_some() {
            return Err(BROKEN);
        }
        if ctx.now() < self.calm_until {
            return Err(TOO_SOON);
        }
        if !ctx.position(player.id).is_some_and(|at| within(self.table, at, TABLE_REACH)) {
            return Err(TOO_FAR);
        }
        self.players[me].called = true;
        self.open_meeting(me, None, ctx);
        Ok(())
    }

    fn vote(&mut self, me: usize, target: Option<Uuid>, ctx: &mut Ctx) -> Result<(), GameError> {
        let voter = &self.players[me];
        if !voter.alive {
            return Err(OUT);
        }
        let Some(meeting) = self.meeting.as_ref().filter(|meeting| meeting.stage == Stage::Vote) else {
            return Err(NOT_NOW);
        };
        if meeting.votes.iter().any(|(id, _)| *id == voter.id) {
            return Err(VOTED);
        }
        if target.is_some_and(|target| !self.present(target).is_some_and(Player::living)) {
            return Err(NO_TARGET);
        }
        let voter = voter.id;
        if let Some(meeting) = self.meeting.as_mut() {
            meeting.votes.push((voter, target));
        }
        if self.all_voted() {
            self.close_meeting(ctx);
        }
        Ok(())
    }

    fn say(&mut self, me: usize, text: &str, ctx: &Ctx) -> Result<(), GameError> {
        let text = clean(text).ok_or(BAD_TEXT)?;
        let now = ctx.now();
        let player = &self.players[me];
        let ghost = !player.alive;
        if !ghost && self.meeting.is_none() {
            return Err(NOT_NOW);
        }
        if player.said_at.is_some_and(|at| now < at + TALK_GAP) {
            return Err(TOO_FAST);
        }
        self.add_line(me, text.to_owned());
        self.players[me].said_at = Some(now);
        Ok(())
    }

    /// Player `me`'s line, in the log they talk to.
    fn add_line(&mut self, me: usize, text: String) {
        let player = &self.players[me];
        let ghost = !player.alive;
        let line = Line { id: self.next_line, from: player.id, name: player.name.clone(), text, ghost };
        let log = if ghost { &mut self.ghost_talk } else { &mut self.talk };
        log.push_back(line);
        if log.len() > TALK_KEPT {
            log.pop_front();
        }
        self.next_line += 1;
    }

    fn vent(&mut self, me: usize, to: Option<&Value>, ctx: &Ctx) -> Result<(), GameError> {
        let player = &self.players[me];
        if player.role != Role::Impostor {
            return Err(BAD_ACTION);
        }
        if !player.alive {
            return Err(OUT);
        }
        if !self.roaming() {
            return Err(NOT_NOW);
        }
        let to = match to {
            None | Some(Value::Null) => None,
            Some(to) => Some(to.as_u64().and_then(|to| usize::try_from(to).ok()).ok_or(BAD_ACTION)?),
        };
        let venting = match (player.venting, to) {
            (None, None) => {
                let at = ctx.position(player.id).ok_or(NO_VENT)?;
                Some(self.vent_near(at, VENT_REACH).ok_or(NO_VENT)?)
            }
            (Some(_), None) => None,
            (Some(from), Some(to)) if to < self.vents.len() && to != from => Some(to),
            (Some(_), Some(_)) => return Err(BAD_ACTION),
            (None, Some(_)) => return Err(NO_VENT),
        };
        self.players[me].venting = venting;
        Ok(())
    }

    fn sabotage(&mut self, me: usize, kind: &str, ctx: &mut Ctx) -> Result<(), GameError> {
        let kind = Trouble::parse(kind).ok_or(BAD_ACTION)?;
        if self.players[me].role != Role::Impostor {
            return Err(BAD_ACTION);
        }
        if !self.roaming() || self.sabotage.is_some() {
            return Err(NOT_NOW);
        }
        if ctx.now() < self.sabotage_at {
            return Err(COOLDOWN);
        }
        self.break_down(kind, ctx);
        Ok(())
    }

    fn break_down(&mut self, kind: Trouble, ctx: &mut Ctx) {
        let deadline = (kind == Trouble::Reactor).then(|| ctx.now() + REACTOR_TIME);
        self.sabotage = Some(Sabotage { kind, deadline, held: [None, None] });
        ctx.emit(json!({"type": "sabotage", "kind": kind.name()}));
    }

    fn fix(&mut self, me: usize, ctx: &mut Ctx) -> Result<(), GameError> {
        let player = &self.players[me];
        if !player.alive {
            return Err(OUT);
        }
        if !self.roaming() {
            return Err(NOT_NOW);
        }
        if player.venting.is_some() {
            return Err(IN_VENT);
        }
        let kind = self.sabotage.as_ref().map(|sabotage| sabotage.kind).ok_or(NOTHING_BROKEN)?;
        let panel = self.position(me, ctx).and_then(|at| self.panel_near(at)).ok_or(NO_PANEL)?;
        self.fix_at(me, kind, panel, ctx);
        Ok(())
    }

    /// Player `me` fixes the sabotage at its `panel`: at once, or (the reactor) holding that panel.
    fn fix_at(&mut self, me: usize, kind: Trouble, panel: usize, ctx: &mut Ctx) {
        if kind != Trouble::Reactor {
            self.fixed(ctx);
            return;
        }
        let id = self.players[me].id;
        if let Some(sabotage) = self.sabotage.as_mut() {
            sabotage.held[panel] = Some(id);
            if sabotage.held[1 - panel] == Some(id) {
                sabotage.held[1 - panel] = None;
            }
            if sabotage.held.iter().all(Option::is_some) {
                self.fixed(ctx);
            }
        }
    }

    fn meeting_view(&self, meeting: &Meeting, me: Option<&Player>) -> Value {
        let voters = self.players.iter().filter(|player| player.living()).count();
        let mine = me.and_then(|me| meeting.votes.iter().find(|(voter, _)| *voter == me.id));
        json!({
            "number": meeting.number,
            "stage": match meeting.stage {
                Stage::Discuss => "discuss",
                Stage::Vote => "vote",
            },
            "caller": meeting.caller,
            "callerName": meeting.caller_name,
            "reason": if meeting.body.is_some() { "report" } else { "emergency" },
            "body": meeting.body.as_ref().map(|(victim, name)| json!({"victim": victim, "name": name})),
            "endsAt": match meeting.stage {
                Stage::Discuss => meeting.discuss_until,
                Stage::Vote => meeting.vote_until,
            },
            "seat": me.and_then(|me| meeting.seats.iter().find(|(id, _)| *id == me.id)).map(|(_, seat)| seat),
            // How many have voted, never for whom, until the meeting ends.
            "voted": meeting.votes.len(),
            "voters": voters,
            "myVote": mine.map(|(_, target)| json!({"target": target})),
        })
    }

    fn sabotage_view(&self) -> Value {
        let Some(sabotage) = &self.sabotage else { return Value::Null };
        json!({
            "kind": sabotage.kind.name(),
            "endsAt": sabotage.deadline,
            "held": sabotage.held.map(|holder| holder.is_some()),
        })
    }
}

fn line_view(line: &Line) -> Value {
    json!({"id": line.id, "from": line.from, "name": line.name, "text": line.text, "ghost": line.ghost})
}

impl Game for Impostor {
    fn view(&self, viewer: Option<Uuid>, _now: Millis) -> Value {
        let me = viewer.and_then(|id| self.present(id)).filter(|me| me.bot.is_none());
        let ghost = me.is_some_and(|me| !me.alive);
        let impostor = me.is_some_and(|me| me.role == Role::Impostor);
        let venting = me.and_then(|me| me.venting);
        // What the viewer's own buttons reach between meetings, from where the last tick saw them.
        let at = me.and_then(|me| self.seen.get(&me.id).copied()).filter(|_| self.roaming());
        let living_at = at.filter(|_| !ghost);
        // Out of the vents: only the vent buttons work in there.
        let free_at = living_at.filter(|_| venting.is_none());
        // Ghosts of the crew still do their tasks.
        let station =
            me.filter(|me| me.role == Role::Crew).and_then(|me| Some(me.tasks[self.task_near(me, at?)?].station));
        let body = free_at.and_then(|at| self.body_near(at)).map(|body| body.id);
        let table = free_at.is_some_and(|at| within(self.table, at, TABLE_REACH));
        let vent = venting.or_else(|| living_at.filter(|_| impostor).and_then(|at| self.vent_near(at, VENT_REACH)));
        let panel = free_at.is_some_and(|at| self.panel_near(at).is_some());
        let kill = me.filter(|me| impostor && me.alive).map(|me| {
            let targets = free_at.map(|at| self.targets_near(at)).unwrap_or_default();
            json!({"readyAt": me.kill_at, "targets": targets})
        });
        let (done, all) = self.progress();
        let comms_down = self.broken(Trouble::Comms) && !impostor;
        let mut talk: Vec<&Line> = self.talk.iter().collect();
        if ghost {
            talk.extend(&self.ghost_talk);
            talk.sort_by_key(|line| line.id);
        }
        let phase = match (&self.winner, &self.meeting) {
            (Some(_), _) => "ended",
            (None, Some(meeting)) if meeting.stage == Stage::Vote => "vote",
            (None, Some(_)) => "discuss",
            (None, None) => "play",
        };
        // The dead see everyone; the living do not see the dead walk, nor anyone in the vents.
        let hidden: Vec<Uuid> = self
            .players
            .iter()
            .filter(|player| player.bot.is_none() && self.winner.is_none())
            .filter(|player| (!player.left && player.venting.is_some()) || (!ghost && !player.alive))
            .map(|player| player.id)
            .collect();
        let bots: Vec<Value> = self
            .players
            .iter()
            .filter_map(|player| Some((player, player.bot.as_ref()?)))
            .filter(|(player, _)| ghost || player.alive || self.winner.is_some())
            .map(|(player, bot)| {
                json!({
                    "id": player.id,
                    "name": player.name,
                    "color": bot.color,
                    "route": bot.route.view(),
                    "ghost": !player.alive,
                })
            })
            .collect();
        json!({
            "phase": phase,
            "role": me.map(|me| me.role.name()),
            // Impostors know one another; nobody else learns a role before the result.
            "impostors": impostor.then(|| self.players.iter()
                .filter(|player| player.role == Role::Impostor)
                .map(|player| player.id)
                .collect::<Vec<_>>()),
            "alive": me.map(|me| me.alive),
            "spawn": me.and_then(|me| self.spawns.get(&me.id)),
            "tasks": me.map_or_else(Vec::new, |me| me.tasks.iter()
                .map(|task| json!({"station": task.station, "done": task.done}))
                .collect()),
            "working": me.and_then(|me| {
                let work = me.working?;
                let station = me.tasks[work.task].station;
                Some(json!({"station": station, "kind": self.chores[station].name(), "readyAt": work.ready}))
            }),
            "progress": (!comms_down).then(|| json!({"done": done, "total": all})),
            "players": self.players.iter().filter(|player| !player.left).map(|player| json!({
                "id": player.id,
                "name": player.name,
                // As everyone knows it; the dead see who else is dead.
                "alive": if ghost { player.alive } else { !player.known_dead },
                "bot": player.bot.is_some(),
            })).collect::<Vec<_>>(),
            "hidden": hidden,
            "bots": bots,
            "bodies": self.bodies.iter().map(|body| json!({
                "id": body.id,
                "victim": body.victim,
                "color": body.color,
                "name": body.name,
                "position": body.position,
                "reported": body.reported,
            })).collect::<Vec<_>>(),
            "table": self.table,
            "stations": self.stations,
            "stationKinds": self.chores.iter().map(|chore| chore.name()).collect::<Vec<_>>(),
            "vents": self.vents,
            "panels": {"lights": self.panels.lights, "comms": self.panels.comms, "reactor": self.panels.reactor},
            "sabotage": self.sabotage_view(),
            "sabotageFrom": impostor.then_some(self.sabotage_at),
            "venting": venting,
            "meeting": self.meeting.as_ref().map(|meeting| self.meeting_view(meeting, me)),
            "talk": talk.into_iter().map(line_view).collect::<Vec<_>>(),
            "lastMeeting": self.last.as_ref().map(|last| json!({
                "number": last.number,
                "ejected": last.ejected.as_ref().map(|(id, _, _)| id),
                "name": last.ejected.as_ref().map(|(_, name, _)| name),
                "impostor": last.ejected.as_ref().map(|(_, _, role)| *role == Role::Impostor),
                "remaining": last.remaining,
                "votes": last.votes.iter().map(|(voter, target)| json!({"voter": voter, "target": target}))
                    .collect::<Vec<_>>(),
            })),
            "kill": kill,
            "near": {"station": station, "body": body, "table": table, "vent": vent, "panel": panel},
            "emergencyLeft": me.map_or(0, |me| u8::from(me.alive && !me.called)),
            "emergencyFrom": self.calm_until,
        })
    }

    fn act(&mut self, player: Uuid, action: &Value, ctx: &mut Ctx) -> Result<(), GameError> {
        let me = self
            .players
            .iter()
            .position(|found| found.id == player && !found.left && found.bot.is_none())
            .ok_or(BAD_ACTION)?;
        if self.winner.is_some() {
            return Err(NOT_NOW);
        }
        match action.get("do").and_then(Value::as_str) {
            Some("task") => self.start_task(me, ctx),
            Some("finish") => self.finish(me, ctx),
            Some("stop") => {
                self.players[me].working = None;
                Ok(())
            }
            Some("kill") => self.kill(me, action.get("target").and_then(id).ok_or(BAD_ACTION)?, ctx),
            Some("report") => self.report(me, action.get("body").and_then(Value::as_u64).ok_or(BAD_ACTION)?, ctx),
            Some("meeting") => self.emergency(me, ctx),
            Some("vote") => {
                let target = match action.get("target") {
                    Some(Value::Null) => None,
                    Some(target) => Some(id(target).ok_or(BAD_ACTION)?),
                    None => return Err(BAD_ACTION),
                };
                self.vote(me, target, ctx)
            }
            Some("say") => self.say(me, action.get("text").and_then(Value::as_str).ok_or(BAD_ACTION)?, ctx),
            Some("vent") => self.vent(me, action.get("to"), ctx),
            Some("sabotage") => self.sabotage(me, action.get("kind").and_then(Value::as_str).ok_or(BAD_ACTION)?, ctx),
            Some("fix") => self.fix(me, ctx),
            _ => Err(BAD_ACTION),
        }
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        self.seen.clone_from(ctx.positions());
        for player in &self.players {
            if let Some(bot) = &player.bot {
                self.seen.insert(player.id, bot.route.at(ctx.now()));
            }
        }
        if self.winner.is_some() {
            return;
        }
        let now = ctx.now();
        match &mut self.meeting {
            None => {
                self.work(ctx);
                self.vents_left(ctx);
                self.reactor(ctx);
                if self.roaming() {
                    self.roam_bots(ctx);
                }
            }
            Some(meeting) if meeting.stage == Stage::Discuss => {
                if now >= meeting.discuss_until {
                    meeting.stage = Stage::Vote;
                    self.ballot_bots(ctx);
                }
                self.talk_bots(ctx);
            }
            Some(meeting) => {
                if now >= meeting.vote_until || self.all_voted() {
                    self.close_meeting(ctx);
                } else {
                    self.talk_bots(ctx);
                }
            }
        }
    }

    fn leave(&mut self, player: Uuid, _ctx: &mut Ctx) {
        let Some(gone) = self.players.iter_mut().find(|found| found.id == player && !found.left) else { return };
        gone.left = true;
        gone.working = None;
        gone.venting = None;
        if let Some(meeting) = self.meeting.as_mut() {
            meeting.votes.retain(|(voter, _)| *voter != player);
        }
        if let Some(sabotage) = self.sabotage.as_mut() {
            for holder in &mut sabotage.held {
                if *holder == Some(player) {
                    *holder = None;
                }
            }
        }
        self.judge();
    }

    fn result(&self) -> Option<Value> {
        let (side, reason) = self.winner?;
        Some(json!({
            "winner": side.name(),
            "reason": reason.name(),
            "players": self.players.iter().map(|player| json!({
                "id": player.id,
                "name": player.name,
                "role": player.role.name(),
                "alive": player.alive,
                "left": player.left,
                "bot": player.bot.is_some(),
            })).collect::<Vec<_>>(),
        }))
    }
}
