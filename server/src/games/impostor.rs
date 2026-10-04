//! 임포스터, a social deduction game on the host's island. One to three impostors (1 for 4–6 players, 2 for 7–10, 3 for
//! 11–15) hide among the crew. The crew walk to stations and do tasks; the impostors pretend to and kill crew one at a
//! time. Whoever finds a body reports it, and anyone alive may call one emergency meeting a game at the table: everyone
//! alive sits around the table, talks for 30 s and votes for 30 s, and a unique top target with more votes than skips
//! is ejected. The crew win when every crew task is done or every impostor is out; the impostors win once they are as
//! many as the living crew.
//!
//! - Tasks: each crew member gets four different stations (fewer when the island has fewer). `task` within 1.8 m of
//!   an unfinished one starts it and three more seconds there finish it; stepping away cancels it. Ghosts (dead crew)
//!   may still finish theirs. Impostors get a list of the same shape they cannot do.
//! - Kills: an impostor alive kills a living crew member within 2.2 m, not during a meeting, 25 s after the start,
//!   their own last kill and each meeting's end. The body stays where the victim stood until a meeting ends.
//! - Meetings: `report` within 3 m of an unreported body, or `meeting` within 3 m of the table, once a player and not
//!   in the 15 s after the start or a meeting. Votes (`target`: a living player, or null to skip) are taken in the
//!   second half, once each, and the vote ends when every living player has voted. When a meeting ends the bodies go,
//!   the deaths so far become public and everyone's waits (kill, emergency) start again.
//! - Talk: up to 120 characters a line, one line a second. The living talk to everyone during meetings; the dead talk
//!   any time, to the dead only.
//!
//! Layout (from the host's page): `{"stations": [[x, y, z]; 6..=12], "table": [x, y, z]}`, open spots of the island.
//! Stations nearer than 3.6 m to the table or an earlier station count as that place; six must remain.
//!
//! Actions: `{"do": "task"}`, `{"do": "kill", "target": id}`, `{"do": "report", "body": n}`, `{"do": "meeting"}`,
//! `{"do": "vote", "target": id | null}`, `{"do": "say", "text": "…"}`.
//!
//! View (per viewer; secrets only to their owner): `phase` (`play` | `discuss` | `vote` | `ended`), `role`
//! (`crew` | `impostor`, null to someone watching), `impostors` (every impostor's id, to impostors only), `alive` (the
//! viewer's own), `tasks` (`[{station, done}]`, an impostor's being fake), `working` (`{station, endsAt}` | null),
//! `progress` (`{done, total}` over the crew's tasks), `players` (`[{id, name, alive}]` as everyone knows it; to the
//! dead, as it is), `dead` (who is dead now, for hiding their avatars), `bodies` (`[{id, victim, name, position,
//! reported}]`), `table`, `stations`, `meeting` (null, or `{number, stage, caller, callerName, reason, body: {victim,
//! name} | null, endsAt, seat, voted, voters, myVote: {target} | null}`), `talk` (`[{id, from, name, text, ghost}]`:
//! this meeting's lines, and to the dead the ghosts' too), `lastMeeting` (null, or `{number, ejected, name, impostor,
//! votes: [{voter, target}]}`), `kill` (to living impostors: `{readyAt, targets}`, the living crew in reach, nearest
//! first), `near` (`{station, body, table}`: what the viewer's buttons reach now, as of the last tick), `emergencyLeft`
//! and `emergencyFrom`.
//!
//! Events: `{"type": "killed"}` to the victim; `{"type": "meeting", number, reason, caller, victim}` and
//! `{"type": "verdict", number, ejected, name, impostor}` to everyone.
//!
//! Result: `{"winner": "crew" | "impostor", "reason": "tasks" | "impostorsOut" | "parity", "players": [{id, name, role,
//! alive, left}]}`.

use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    f64::consts::TAU,
};
use uuid::Uuid;

use super::{
    BAD_ACTION, Ctx, Game, GameError, Kind, Millis, distance_xz, distinct, layout_points, pick_many, point, within,
};

pub(crate) const KIND: Kind = Kind::new("impostor", 4, 15, create).ticking(10);

const MIN_STATIONS: usize = 6;
const MAX_STATIONS: usize = 12;
/// Places nearer than this are one: each station's reach stays its own and clear of the table.
const SAME_PLACE: f64 = 2.0 * TASK_REACH;
/// Tasks per player, when the island has that many stations.
const TASKS_EACH: usize = 4;
/// How near (on the ground) a station must be to work at it, in meters.
const TASK_REACH: f64 = 1.8;
const TASK_TIME: Millis = 3_000;
const KILL_REACH: f64 = 2.2;
const KILL_COOLDOWN: Millis = 25_000;
const REPORT_REACH: f64 = 3.0;
const TABLE_REACH: f64 = 3.0;
/// No emergency meeting this soon after the start or a meeting's end.
const CALM: Millis = 15_000;
const DISCUSS: Millis = 30_000;
const VOTE: Millis = 30_000;
const MAX_TEXT: usize = 120;
/// The least time between two lines of one player.
const TALK_GAP: Millis = 1_000;
/// Lines kept in each log.
const TALK_KEPT: usize = 30;
/// Room for each seat along the circle around the table, and the circle's least and greatest radius.
const SEAT_ROOM: f64 = 0.8;
const SEAT_NEAR: f64 = 1.6;
const SEAT_FAR: f64 = 2.0;

const FEW_STATIONS: GameError = GameError::new("few_stations", "작업 자리가 부족해요.");
const NOT_NOW: GameError = GameError::new("not_now", "지금은 할 수 없어요.");
const OUT: GameError = GameError::new("out", "탈락해서 할 수 없어요.");
const TOO_FAR: GameError = GameError::new("too_far", "너무 멀어요.");
const NO_TASK: GameError = GameError::new("no_task", "가까이에 할 작업이 없어요.");
const BUSY: GameError = GameError::new("busy", "이미 작업 중이에요.");
const COOLDOWN: GameError = GameError::new("cooldown", "아직 처치할 수 없어요.");
const NO_TARGET: GameError = GameError::new("no_target", "고를 수 없는 사람이에요.");
const NO_BODY: GameError = GameError::new("no_body", "신고할 수 없어요.");
const CALLED: GameError = GameError::new("called", "긴급 회의를 이미 열었어요.");
const TOO_SOON: GameError = GameError::new("too_soon", "아직 긴급 회의를 열 수 없어요.");
const VOTED: GameError = GameError::new("voted", "이미 투표했어요.");
const BAD_TEXT: GameError = GameError::new("bad_text", "보낼 수 없는 말이에요.");
const TOO_FAST: GameError = GameError::new("too_fast", "조금 천천히 말해 주세요.");

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
}

impl Reason {
    fn name(self) -> &'static str {
        match self {
            Self::Tasks => "tasks",
            Self::ImpostorsOut => "impostorsOut",
            Self::Parity => "parity",
        }
    }
}

struct Task {
    station: usize,
    done: bool,
}

struct Player {
    id: Uuid,
    name: String,
    role: Role,
    alive: bool,
    /// Whether everyone has been told this player is out: a death becomes public when a meeting ends.
    known_dead: bool,
    /// Gone from the game: out of every count, but listed in the result.
    left: bool,
    tasks: Vec<Task>,
    /// The task underway (its index in `tasks`) and when it is done.
    working: Option<(usize, Millis)>,
    /// When this player may kill next (impostors).
    kill_at: Millis,
    /// Whether they have called their emergency meeting.
    called: bool,
    said_at: Option<Millis>,
}

impl Player {
    fn living(&self) -> bool {
        self.alive && !self.left
    }
}

struct Body {
    id: u32,
    victim: Uuid,
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
    table: [f64; 3],
    /// Everyone who started, in the order they joined.
    players: Vec<Player>,
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
        let now = ctx.now();
        let members = ctx.players();
        let ids: Vec<Uuid> = members.iter().map(|member| member.id).collect();
        let impostors = pick_many(ctx.rng(), &ids, impostors_for(ids.len()));
        let order: Vec<usize> = (0..stations.len()).collect();
        let players = members
            .iter()
            .map(|member| Player {
                id: member.id,
                name: member.name.clone(),
                role: if impostors.contains(&member.id) { Role::Impostor } else { Role::Crew },
                alive: true,
                known_dead: false,
                left: false,
                tasks: pick_many(ctx.rng(), &order, TASKS_EACH)
                    .into_iter()
                    .map(|station| Task { station, done: false })
                    .collect(),
                working: None,
                kill_at: now + KILL_COOLDOWN,
                called: false,
                said_at: None,
            })
            .collect();
        Ok(Self {
            stations,
            table,
            players,
            bodies: Vec::new(),
            meeting: None,
            last: None,
            meetings: 0,
            next_body: 1,
            next_line: 1,
            talk: VecDeque::new(),
            ghost_talk: VecDeque::new(),
            calm_until: now + CALM,
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
        self.winner = if impostors == 0 {
            Some((Role::Crew, Reason::ImpostorsOut))
        } else if impostors >= crew {
            Some((Role::Impostor, Reason::Parity))
        } else if all > 0 && done == all {
            Some((Role::Crew, Reason::Tasks))
        } else {
            None
        };
        if self.winner.is_some() {
            self.meeting = None;
            for player in &mut self.players {
                player.working = None;
            }
        }
    }

    /// Calls everyone alive to the table: tasks underway stop, and each gets a seat around it.
    fn open_meeting(&mut self, caller: usize, body: Option<(Uuid, String)>, ctx: &mut Ctx) {
        let now = ctx.now();
        self.meetings += 1;
        for player in &mut self.players {
            player.working = None;
        }
        let seated: Vec<Uuid> = self.players.iter().filter(|player| player.living()).map(|player| player.id).collect();
        let count = seated.len().max(1) as f64;
        let radius = (count * SEAT_ROOM / TAU).clamp(SEAT_NEAR, SEAT_FAR);
        let [x, y, z] = self.table;
        let seats = seated
            .iter()
            .enumerate()
            .map(|(index, id)| {
                let angle = TAU * index as f64 / count;
                (*id, [round(x + radius * angle.cos()), y, round(z + radius * angle.sin())])
            })
            .collect();
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
            discuss_until: now + DISCUSS,
            vote_until: now + DISCUSS + VOTE,
            seats,
            votes: Vec::new(),
        });
    }

    /// Counts the votes: a unique top target with more votes than skips is ejected. Then the bodies go, the deaths
    /// become public, and the waits start again.
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
            player.working = None;
            (player.id, player.name.clone(), player.role)
        });
        self.bodies.clear();
        self.talk.clear();
        for player in &mut self.players {
            player.known_dead |= !player.alive;
            if player.role == Role::Impostor {
                player.kill_at = now + KILL_COOLDOWN;
            }
        }
        self.calm_until = now + CALM;
        ctx.emit(json!({
            "type": "verdict",
            "number": meeting.number,
            "ejected": ejected.as_ref().map(|(id, _, _)| id),
            "name": ejected.as_ref().map(|(_, name, _)| name),
            "impostor": ejected.as_ref().map(|(_, _, role)| *role == Role::Impostor),
        }));
        self.last = Some(Verdict { number: meeting.number, ejected, votes });
        self.judge();
    }

    /// Tasks underway: finished after their time while their player stays in reach, dropped once they step away.
    fn work(&mut self, ctx: &Ctx) {
        let now = ctx.now();
        let mut finished = false;
        let stations = &self.stations;
        for player in &mut self.players {
            let Some((task, until)) = player.working else { continue };
            let station = stations[player.tasks[task].station];
            if !ctx.position(player.id).is_some_and(|at| within(station, at, TASK_REACH)) {
                player.working = None;
            } else if now >= until {
                player.tasks[task].done = true;
                player.working = None;
                finished = true;
            }
        }
        if finished {
            self.judge();
        }
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
        self.players[me].working = Some((task, ctx.now() + TASK_TIME));
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
        if ctx.now() < killer.kill_at {
            return Err(COOLDOWN);
        }
        let victim = self
            .players
            .iter()
            .position(|player| player.id == target && player.living() && player.role == Role::Crew)
            .ok_or(NO_TARGET)?;
        let (Some(from), Some(at)) = (ctx.position(killer.id), ctx.position(target)) else { return Err(TOO_FAR) };
        if !within(from, at, KILL_REACH) {
            return Err(TOO_FAR);
        }
        self.players[me].kill_at = ctx.now() + KILL_COOLDOWN;
        let victim = &mut self.players[victim];
        victim.alive = false;
        victim.working = None;
        self.bodies.push(Body {
            id: self.next_body,
            victim: target,
            name: victim.name.clone(),
            position: at,
            reported: false,
        });
        self.next_body += 1;
        ctx.emit_one(target, json!({"type": "killed"}));
        self.judge();
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
        let found =
            self.bodies.iter().position(|found| u64::from(found.id) == body && !found.reported).ok_or(NO_BODY)?;
        if !ctx.position(player.id).is_some_and(|at| within(self.bodies[found].position, at, REPORT_REACH)) {
            return Err(TOO_FAR);
        }
        let body = &mut self.bodies[found];
        body.reported = true;
        let victim = (body.victim, body.name.clone());
        self.open_meeting(me, Some(victim), ctx);
        Ok(())
    }

    fn emergency(&mut self, me: usize, ctx: &mut Ctx) -> Result<(), GameError> {
        let player = &self.players[me];
        if !player.alive {
            return Err(OUT);
        }
        if !self.roaming() {
            return Err(NOT_NOW);
        }
        if player.called {
            return Err(CALLED);
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
        let line =
            Line { id: self.next_line, from: player.id, name: player.name.clone(), text: text.to_owned(), ghost };
        let log = if ghost { &mut self.ghost_talk } else { &mut self.talk };
        log.push_back(line);
        if log.len() > TALK_KEPT {
            log.pop_front();
        }
        self.next_line += 1;
        self.players[me].said_at = Some(now);
        Ok(())
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
}

fn line_view(line: &Line) -> Value {
    json!({"id": line.id, "from": line.from, "name": line.name, "text": line.text, "ghost": line.ghost})
}

impl Game for Impostor {
    fn view(&self, viewer: Option<Uuid>, _now: Millis) -> Value {
        let me = viewer.and_then(|id| self.present(id));
        let ghost = me.is_some_and(|me| !me.alive);
        let impostor = me.is_some_and(|me| me.role == Role::Impostor);
        // What the viewer's own buttons reach between meetings, from where the last tick saw them.
        let at = me.and_then(|me| self.seen.get(&me.id).copied()).filter(|_| self.roaming());
        let living_at = at.filter(|_| !ghost);
        // Ghosts of the crew still do their tasks.
        let station =
            me.filter(|me| me.role == Role::Crew).and_then(|me| Some(me.tasks[self.task_near(me, at?)?].station));
        let body = living_at.and_then(|at| self.body_near(at)).map(|body| body.id);
        let table = living_at.is_some_and(|at| within(self.table, at, TABLE_REACH));
        let kill = me.filter(|me| impostor && me.alive).map(|me| {
            let targets = at.map(|at| self.targets_near(at)).unwrap_or_default();
            json!({"readyAt": me.kill_at, "targets": targets})
        });
        let (done, all) = self.progress();
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
        json!({
            "phase": phase,
            "role": me.map(|me| me.role.name()),
            // Impostors know one another; nobody else learns a role before the result.
            "impostors": impostor.then(|| self.players.iter()
                .filter(|player| player.role == Role::Impostor)
                .map(|player| player.id)
                .collect::<Vec<_>>()),
            "alive": me.map(|me| me.alive),
            "tasks": me.map_or_else(Vec::new, |me| me.tasks.iter()
                .map(|task| json!({"station": task.station, "done": task.done}))
                .collect()),
            "working": me.and_then(|me| {
                let (task, until) = me.working?;
                Some(json!({"station": me.tasks[task].station, "endsAt": until}))
            }),
            "progress": {"done": done, "total": all},
            "players": self.players.iter().filter(|player| !player.left).map(|player| json!({
                "id": player.id,
                "name": player.name,
                // As everyone knows it; the dead see who else is dead.
                "alive": if ghost { player.alive } else { !player.known_dead },
            })).collect::<Vec<_>>(),
            "dead": self.players.iter().filter(|player| !player.alive).map(|player| player.id).collect::<Vec<_>>(),
            "bodies": self.bodies.iter().map(|body| json!({
                "id": body.id,
                "victim": body.victim,
                "name": body.name,
                "position": body.position,
                "reported": body.reported,
            })).collect::<Vec<_>>(),
            "table": self.table,
            "stations": self.stations,
            "meeting": self.meeting.as_ref().map(|meeting| self.meeting_view(meeting, me)),
            "talk": talk.into_iter().map(line_view).collect::<Vec<_>>(),
            "lastMeeting": self.last.as_ref().map(|last| json!({
                "number": last.number,
                "ejected": last.ejected.as_ref().map(|(id, _, _)| id),
                "name": last.ejected.as_ref().map(|(_, name, _)| name),
                "impostor": last.ejected.as_ref().map(|(_, _, role)| *role == Role::Impostor),
                "votes": last.votes.iter().map(|(voter, target)| json!({"voter": voter, "target": target}))
                    .collect::<Vec<_>>(),
            })),
            "kill": kill,
            "near": {"station": station, "body": body, "table": table},
            "emergencyLeft": me.map_or(0, |me| u8::from(me.alive && !me.called)),
            "emergencyFrom": self.calm_until,
        })
    }

    fn act(&mut self, player: Uuid, action: &Value, ctx: &mut Ctx) -> Result<(), GameError> {
        let me = self.players.iter().position(|found| found.id == player && !found.left).ok_or(BAD_ACTION)?;
        if self.winner.is_some() {
            return Err(NOT_NOW);
        }
        match action.get("do").and_then(Value::as_str) {
            Some("task") => self.start_task(me, ctx),
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
            _ => Err(BAD_ACTION),
        }
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        self.seen.clone_from(ctx.positions());
        if self.winner.is_some() {
            return;
        }
        let now = ctx.now();
        match &mut self.meeting {
            None => self.work(ctx),
            Some(meeting) if meeting.stage == Stage::Discuss => {
                if now >= meeting.discuss_until {
                    meeting.stage = Stage::Vote;
                }
            }
            Some(meeting) => {
                if now >= meeting.vote_until || self.all_voted() {
                    self.close_meeting(ctx);
                }
            }
        }
    }

    fn leave(&mut self, player: Uuid, _ctx: &mut Ctx) {
        let Some(gone) = self.players.iter_mut().find(|found| found.id == player && !found.left) else { return };
        gone.left = true;
        gone.working = None;
        if let Some(meeting) = self.meeting.as_mut() {
            meeting.votes.retain(|(voter, _)| *voter != player);
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
            })).collect::<Vec<_>>(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::{Audience, BAD_LAYOUT, Member};
    use rand::{SeedableRng, rngs::StdRng};
    use std::collections::HashSet;

    const START: Millis = 1_000_000;
    const TABLE: [f64; 3] = [0.0, 0.0, 0.0];

    fn members(count: usize) -> Vec<Member> {
        (0..count).map(|index| Member { id: Uuid::new_v4(), name: format!("player{index}") }).collect()
    }

    /// The table at the origin and `count` stations 8 m apart in a row, 30 m north of it.
    fn layout(count: usize) -> Value {
        let stations: Vec<[f64; 3]> = (0..count).map(|index| [index as f64 * 8.0 - 40.0, 0.0, -30.0]).collect();
        json!({"table": TABLE, "stations": stations})
    }

    fn refused(layout: Value, ctx: &mut Ctx) -> Option<GameError> {
        Impostor::new(&layout, ctx).err()
    }

    fn task() -> Value {
        json!({"do": "task"})
    }

    fn kill(target: Uuid) -> Value {
        json!({"do": "kill", "target": target})
    }

    fn report(body: u32) -> Value {
        json!({"do": "report", "body": body})
    }

    fn call() -> Value {
        json!({"do": "meeting"})
    }

    fn vote(target: Option<Uuid>) -> Value {
        json!({"do": "vote", "target": target})
    }

    fn say(text: &str) -> Value {
        json!({"do": "say", "text": text})
    }

    /// Whether `text` is one of the strings anywhere in `value`.
    fn mentions(value: &Value, text: &str) -> bool {
        match value {
            Value::String(found) => found == text,
            Value::Array(items) => items.iter().any(|item| mentions(item, text)),
            Value::Object(fields) => fields.values().any(|item| mentions(item, text)),
            _ => false,
        }
    }

    /// A game in hand: its players, where they stand in the room, its random numbers and the clock.
    struct Play {
        game: Impostor,
        players: Vec<Member>,
        standing: HashMap<Uuid, [f64; 3]>,
        rng: StdRng,
        now: Millis,
    }

    impl Play {
        fn new(count: usize, seed: u64) -> Self {
            let players = members(count);
            let mut rng = StdRng::seed_from_u64(seed);
            let standing = HashMap::new();
            let mut ctx = Ctx::new(START, &players, &standing, &mut rng);
            let game = Impostor::new(&layout(8), &mut ctx).unwrap();
            Self { game, players, standing, rng, now: START }
        }

        fn role(&self, role: Role) -> Vec<Uuid> {
            self.game.players.iter().filter(|player| player.role == role).map(|player| player.id).collect()
        }

        fn impostor(&self) -> Uuid {
            self.role(Role::Impostor)[0]
        }

        fn crew(&self) -> Vec<Uuid> {
            self.role(Role::Crew)
        }

        fn ids(&self) -> Vec<Uuid> {
            self.players.iter().map(|player| player.id).collect()
        }

        fn player(&self, id: Uuid) -> &Player {
            self.game.players.iter().find(|player| player.id == id).unwrap()
        }

        fn name(&self, id: Uuid) -> String {
            self.player(id).name.clone()
        }

        /// Where `who`'s `index`th task is done.
        fn station(&self, who: Uuid, index: usize) -> [f64; 3] {
            self.game.stations[self.player(who).tasks[index].station]
        }

        fn stand(&mut self, who: Uuid, at: [f64; 3]) {
            self.standing.insert(who, at);
        }

        /// Sets the clock to `after` ms past the start.
        fn at(&mut self, after: Millis) {
            self.now = START + after;
        }

        /// `who` does `action` now. A refused action must change no one's view and announce nothing.
        fn act(&mut self, who: Uuid, action: Value) -> Result<Vec<(Audience, Value)>, GameError> {
            let before = self.views();
            let mut ctx = Ctx::new(self.now, &self.players, &self.standing, &mut self.rng);
            let done = self.game.act(who, &action, &mut ctx);
            let events = ctx.events().to_vec();
            if done.is_err() {
                assert!(events.is_empty(), "{action}");
                assert_eq!(self.views(), before, "refused {action} changed a view");
            }
            done.map(|()| events)
        }

        /// Ticks at `after` ms past the start.
        fn tick(&mut self, after: Millis) -> Vec<(Audience, Value)> {
            self.at(after);
            let mut ctx = Ctx::new(self.now, &self.players, &self.standing, &mut self.rng);
            self.game.tick(&mut ctx);
            ctx.events().to_vec()
        }

        /// `who` leaves, as the framework has them: out of the players and the room first.
        fn leave(&mut self, who: Uuid) -> Vec<(Audience, Value)> {
            self.players.retain(|player| player.id != who);
            self.standing.remove(&who);
            let mut ctx = Ctx::new(self.now, &self.players, &self.standing, &mut self.rng);
            self.game.leave(who, &mut ctx);
            ctx.events().to_vec()
        }

        fn view(&self, who: Uuid) -> Value {
            self.game.view(Some(who), self.now)
        }

        fn onlooker(&self) -> Value {
            self.game.view(None, self.now)
        }

        fn views(&self) -> Vec<Value> {
            self.players.iter().map(|player| self.view(player.id)).chain([self.onlooker()]).collect()
        }

        /// `impostor` kills `victim` standing at `at` from a meter away.
        fn kill_at(&mut self, impostor: Uuid, victim: Uuid, at: [f64; 3]) -> Vec<(Audience, Value)> {
            self.stand(victim, at);
            self.stand(impostor, [at[0] + 1.0, at[1], at[2]]);
            self.act(impostor, kill(victim)).unwrap()
        }

        /// `caller` calls an emergency meeting from beside the table.
        fn call(&mut self, caller: Uuid) -> Vec<(Audience, Value)> {
            self.stand(caller, [1.0, 0.0, 1.0]);
            self.act(caller, call()).unwrap()
        }

        fn meeting(&self) -> &Meeting {
            self.game.meeting.as_ref().unwrap()
        }

        /// Ticks the meeting on to its vote, then returns how long past the start the vote ends.
        fn open_vote(&mut self) -> Millis {
            self.tick(self.meeting().discuss_until - START);
            self.meeting().vote_until - START
        }
    }

    #[test]
    fn layouts_need_six_to_twelve_stations_apart_from_each_other_and_the_table() {
        let players = members(4);
        let mut rng = StdRng::seed_from_u64(1);
        let positions = HashMap::new();
        let mut ctx = Ctx::new(START, &players, &positions, &mut rng);
        assert_eq!(refused(json!(null), &mut ctx), Some(BAD_LAYOUT));
        assert_eq!(refused(json!({"stations": layout(6)["stations"]}), &mut ctx), Some(BAD_LAYOUT));
        assert_eq!(refused(json!({"table": TABLE}), &mut ctx), Some(BAD_LAYOUT));
        assert_eq!(refused(layout(5), &mut ctx), Some(BAD_LAYOUT));
        assert_eq!(refused(layout(13), &mut ctx), Some(BAD_LAYOUT));
        for bad in [json!([1.0, 0.0]), json!([1.0, 0.0, 200.5]), json!(["1", 0, 0]), json!(null), json!({"x": 1})] {
            let mut station = layout(6);
            station["stations"][2] = bad.clone();
            assert_eq!(refused(station, &mut ctx), Some(BAD_LAYOUT), "station {bad}");
            let mut table = layout(6);
            table["table"] = bad.clone();
            assert_eq!(refused(table, &mut ctx), Some(BAD_LAYOUT), "table {bad}");
        }
        // Two stations at one place (3 m apart), or one by the table, leave five places.
        let mut doubled = layout(6);
        doubled["stations"][5] = json!([-37.0, 0.0, -30.0]);
        assert_eq!(refused(doubled, &mut ctx), Some(FEW_STATIONS));
        let mut tabled = layout(6);
        tabled["stations"][0] = json!([2.0, 0.0, -2.0]);
        assert_eq!(refused(tabled, &mut ctx), Some(FEW_STATIONS));
        // With a station to spare, the one too near another is dropped.
        let mut spare = layout(7);
        spare["stations"][6] = json!([-40.0, 0.0, -26.5]);
        let game = Impostor::new(&spare, &mut ctx).unwrap();
        assert_eq!(game.stations, serde_json::from_value::<Vec<[f64; 3]>>(layout(6)["stations"].clone()).unwrap());
        let mut edge = layout(12);
        edge["table"] = json!([-200.0, -3.5, 200]);
        let game = Impostor::new(&edge, &mut ctx).unwrap();
        assert_eq!((game.stations.len(), game.table), (12, [-200.0, -3.5, 200.0]));
    }

    #[test]
    fn one_two_or_three_impostors_by_head_count_and_anyone_may_be_one() {
        for count in 4..=15 {
            let play = Play::new(count, count as u64);
            let impostors = match count {
                4..=6 => 1,
                7..=10 => 2,
                _ => 3,
            };
            assert_eq!(play.role(Role::Impostor).len(), impostors, "{count} players");
            assert_eq!(play.crew().len(), count - impostors);
        }
        let seats: HashSet<usize> = (0..60)
            .map(|seed| Play::new(5, seed).game.players.iter().position(|player| player.role == Role::Impostor))
            .map(Option::unwrap)
            .collect();
        assert_eq!(seats.len(), 5);
        // The same seed deals the same game.
        let (first, again) = (Play::new(6, 9), Play::new(6, 9));
        let deal = |play: &Play| -> Vec<(Role, Vec<usize>)> {
            play.game.players.iter().map(|p| (p.role, p.tasks.iter().map(|t| t.station).collect())).collect()
        };
        assert_eq!(deal(&first), deal(&again));
    }

    #[test]
    fn everyone_gets_four_different_stations_and_the_impostors_are_fake() {
        let mut play = Play::new(6, 3);
        for player in &play.game.players {
            let stations: HashSet<usize> = player.tasks.iter().map(|task| task.station).collect();
            assert_eq!(stations.len(), TASKS_EACH);
            assert!(stations.iter().all(|station| *station < 8));
        }
        let (impostor, crew) = (play.impostor(), play.crew());
        let view = play.view(crew[0]);
        assert_eq!(view["progress"], json!({"done": 0, "total": 20}), "five crew, four tasks each");
        assert_eq!(view["role"], "crew");
        assert_eq!(view["tasks"].as_array().unwrap().len(), 4);
        assert_eq!(view["stations"].as_array().unwrap().len(), 8);
        assert_eq!(view["table"], json!(TABLE));
        let fake = play.view(impostor);
        assert_eq!(fake["role"], "impostor");
        assert_eq!(fake["tasks"].as_array().unwrap().len(), 4);
        // An impostor at a station of their list does nothing there.
        play.at(1_000);
        let place = play.station(impostor, 0);
        play.stand(impostor, place);
        assert_eq!(play.act(impostor, task()), Err(NO_TASK));
        // Fewer stations than four a head: everyone gets them all.
        let players = members(4);
        let mut rng = StdRng::seed_from_u64(2);
        let positions = HashMap::new();
        let mut ctx = Ctx::new(START, &players, &positions, &mut rng);
        let few = Impostor::new(&layout(6), &mut ctx).unwrap();
        assert!(few.players.iter().all(|player| player.tasks.len() == 4));
    }

    #[test]
    fn a_task_takes_three_seconds_in_reach_and_stepping_away_drops_it() {
        let mut play = Play::new(4, 5);
        let me = play.crew()[0];
        let (first, second) = (play.station(me, 0), play.station(me, 1));
        // Not placed yet, then just out of reach: nothing to do.
        assert_eq!(play.act(me, task()), Err(NO_TASK));
        play.stand(me, [first[0] + 1.81, 0.0, first[2]]);
        assert_eq!(play.act(me, task()), Err(NO_TASK));
        assert_eq!(play.act(me, json!({"do": "dance"})), Err(BAD_ACTION));
        assert_eq!(play.act(me, json!({"task": true})), Err(BAD_ACTION));
        // Within reach on the ground, however high.
        play.at(1_000);
        play.stand(me, [first[0] + 1.0, 4.0, first[2] - 1.0]);
        play.act(me, task()).unwrap();
        let station = play.player(me).tasks[0].station;
        assert_eq!(play.view(me)["working"], json!({"station": station, "endsAt": START + 4_000}));
        assert_eq!(play.act(me, task()), Err(BUSY));
        play.tick(3_999);
        assert_eq!(play.view(me)["tasks"][0], json!({"station": station, "done": false}));
        play.tick(4_000);
        let view = play.view(me);
        assert_eq!(view["tasks"][0], json!({"station": station, "done": true}));
        assert_eq!(view["working"], Value::Null);
        assert_eq!(view["progress"], json!({"done": 1, "total": 12}));
        assert_eq!(play.view(play.impostor())["progress"], json!({"done": 1, "total": 12}));
        assert_eq!(play.onlooker()["progress"], json!({"done": 1, "total": 12}));
        // A finished task is not done again.
        assert_eq!(play.act(me, task()), Err(NO_TASK));
        // Stepping away drops the next one, which then starts over.
        play.stand(me, second);
        play.act(me, task()).unwrap();
        play.stand(me, [second[0], 0.0, second[2] + 1.9]);
        play.tick(5_000);
        assert_eq!(play.view(me)["working"], Value::Null);
        play.stand(me, second);
        play.tick(7_000);
        assert_eq!(play.view(me)["tasks"][1]["done"], false);
        // So does leaving the room.
        play.act(me, task()).unwrap();
        play.standing.remove(&me);
        play.tick(8_000);
        assert_eq!(play.view(me)["working"], Value::Null);
        assert_eq!(play.view(me)["progress"]["done"], 1);
    }

    #[test]
    fn ghosts_of_the_crew_still_finish_their_tasks() {
        let mut play = Play::new(5, 6);
        let (impostor, crew) = (play.impostor(), play.crew());
        let ghost = crew[0];
        play.at(KILL_COOLDOWN);
        let place = play.station(ghost, 2);
        play.stand(ghost, place);
        play.act(ghost, task()).unwrap();
        play.kill_at(impostor, ghost, place);
        assert_eq!(play.view(ghost)["alive"], false);
        assert_eq!(play.view(ghost)["working"], Value::Null, "dying stops the task underway");
        play.act(ghost, task()).unwrap();
        play.tick(KILL_COOLDOWN + TASK_TIME);
        assert_eq!(play.view(ghost)["tasks"][2]["done"], true);
        assert_eq!(play.view(crew[1])["progress"], json!({"done": 1, "total": 16}));
    }

    #[test]
    fn impostors_kill_living_crew_in_reach_once_their_wait_is_over() {
        let mut play = Play::new(7, 8);
        let impostors = play.role(Role::Impostor);
        let (a, b) = (impostors[0], impostors[1]);
        let crew = play.crew();
        let (c, d, e) = (crew[0], crew[1], crew[2]);
        play.stand(a, [10.0, 0.0, 10.0]);
        play.stand(b, [10.0, 0.0, 12.0]);
        play.stand(c, [12.2, 0.0, 10.0]);
        // Not in the first 25 s.
        play.at(KILL_COOLDOWN - 1);
        assert_eq!(play.act(a, kill(c)), Err(COOLDOWN));
        play.at(KILL_COOLDOWN);
        // Only impostors kill, only living crew, named by id.
        assert_eq!(play.act(c, kill(a)), Err(BAD_ACTION));
        assert_eq!(play.act(a, kill(b)), Err(NO_TARGET));
        assert_eq!(play.act(a, kill(Uuid::new_v4())), Err(NO_TARGET));
        assert_eq!(play.act(a, json!({"do": "kill", "target": "c"})), Err(BAD_ACTION));
        assert_eq!(play.act(a, json!({"do": "kill"})), Err(BAD_ACTION));
        // Within 2.2 m on the ground, not farther, and not someone out of the room.
        play.stand(c, [12.21, 0.0, 10.0]);
        assert_eq!(play.act(a, kill(c)), Err(TOO_FAR));
        play.standing.remove(&c);
        assert_eq!(play.act(a, kill(c)), Err(TOO_FAR));
        play.stand(c, [12.2, 5.0, 10.0]);
        let events = play.act(a, kill(c)).unwrap();
        assert_eq!(events, vec![(Audience::Only(vec![c]), json!({"type": "killed"}))], "only the victim is told");
        let seen = play.view(d);
        assert_eq!(
            seen["bodies"],
            json!([{"id": 1, "victim": c, "name": play.name(c), "position": [12.2, 5.0, 10.0], "reported": false}])
        );
        assert_eq!(seen["dead"], json!([c]));
        assert!(seen["players"].as_array().unwrap().iter().all(|player| player["alive"] == true), "not public yet");
        assert_eq!(play.view(c)["alive"], false);
        // The dead are no targets; the killer waits again, the other impostor need not.
        assert_eq!(play.act(b, kill(c)), Err(NO_TARGET));
        play.stand(d, [10.0, 0.0, 11.0]);
        assert_eq!(play.act(a, kill(d)), Err(COOLDOWN));
        assert_eq!(play.view(a)["kill"]["readyAt"], START + 2 * KILL_COOLDOWN);
        play.act(b, kill(d)).unwrap();
        // Not during a meeting, and not in the 25 s after one.
        play.at(2 * KILL_COOLDOWN);
        play.call(e);
        play.stand(e, [11.0, 0.0, 10.0]);
        assert_eq!(play.act(a, kill(e)), Err(NOT_NOW));
        let ended = play.open_vote();
        play.tick(ended);
        assert!(play.game.meeting.is_none());
        play.stand(e, [11.0, 0.0, 10.0]);
        play.at(ended + KILL_COOLDOWN - 1);
        assert_eq!(play.act(a, kill(e)), Err(COOLDOWN));
        assert_eq!(play.act(b, kill(e)), Err(COOLDOWN));
        play.at(ended + KILL_COOLDOWN);
        play.act(a, kill(e)).unwrap();
    }

    #[test]
    fn a_living_player_near_an_unreported_body_reports_it() {
        let mut play = Play::new(5, 9);
        let (impostor, crew) = (play.impostor(), play.crew());
        let (victim, finder) = (crew[0], crew[1]);
        play.at(KILL_COOLDOWN);
        play.kill_at(impostor, victim, [20.0, 0.0, 20.0]);
        // Not the dead, not from farther than 3 m, not a body that is not there.
        assert_eq!(play.act(victim, report(1)), Err(OUT));
        play.stand(finder, [23.01, 0.0, 20.0]);
        assert_eq!(play.act(finder, report(1)), Err(TOO_FAR));
        play.stand(finder, [22.0, 0.0, 22.0]);
        assert_eq!(play.act(finder, report(2)), Err(NO_BODY));
        assert_eq!(play.act(finder, json!({"do": "report"})), Err(BAD_ACTION));
        let events = play.act(finder, report(1)).unwrap();
        assert_eq!(
            events,
            vec![(
                Audience::Everyone,
                json!({"type": "meeting", "number": 1, "reason": "report", "caller": finder, "victim": victim})
            )]
        );
        let meeting = play.view(crew[2])["meeting"].clone();
        assert_eq!(meeting["reason"], "report");
        assert_eq!((&meeting["caller"], &meeting["callerName"]), (&json!(finder), &json!(play.name(finder))));
        assert_eq!(meeting["body"], json!({"victim": victim, "name": play.name(victim)}));
        assert_eq!(play.view(finder)["bodies"][0]["reported"], true);
        assert_eq!(play.act(finder, report(1)), Err(NOT_NOW));
    }

    #[test]
    fn emergency_meetings_are_called_at_the_table_once_each_and_not_too_soon() {
        let mut play = Play::new(5, 10);
        let (impostor, crew) = (play.impostor(), play.crew());
        let (first, second) = (crew[0], crew[1]);
        play.stand(first, [2.0, 0.0, 2.0]);
        assert_eq!(play.view(first)["emergencyLeft"], 1);
        assert_eq!(play.view(first)["emergencyFrom"], START + CALM);
        play.at(CALM - 1);
        assert_eq!(play.act(first, call()), Err(TOO_SOON));
        play.at(CALM);
        play.stand(first, [3.01, 0.0, 0.0]);
        assert_eq!(play.act(first, call()), Err(TOO_FAR));
        play.stand(first, [2.0, 0.0, 2.0]);
        let events = play.act(first, call()).unwrap();
        assert_eq!(
            events,
            vec![(
                Audience::Everyone,
                json!({"type": "meeting", "number": 1, "reason": "emergency", "caller": first, "victim": null})
            )]
        );
        let view = play.view(second);
        assert_eq!((view["phase"].as_str(), &view["meeting"]["body"]), (Some("discuss"), &Value::Null));
        assert_eq!((play.view(first)["emergencyLeft"].as_u64(), view["emergencyLeft"].as_u64()), (Some(0), Some(1)));
        // Nobody votes; the meeting ends with the vote's time.
        let ended = play.open_vote();
        play.tick(ended);
        assert_eq!(play.view(second)["phase"], "play");
        assert_eq!(play.view(second)["emergencyFrom"], START + ended + CALM);
        // One call each; the others wait 15 s after a meeting too.
        play.at(ended + CALM);
        assert_eq!(play.act(first, call()), Err(CALLED));
        play.stand(second, [0.5, 0.0, 0.0]);
        play.at(ended + CALM - 1);
        assert_eq!(play.act(second, call()), Err(TOO_SOON));
        // The dead call nothing.
        play.at(ended + KILL_COOLDOWN);
        play.kill_at(impostor, second, [0.5, 0.0, 0.0]);
        assert_eq!(play.act(second, call()), Err(OUT));
        assert_eq!(play.view(second)["emergencyLeft"], 0);
        play.stand(impostor, [0.0, 0.0, 1.0]);
        play.act(impostor, call()).unwrap();
        assert_eq!(play.meeting().number, 2);
    }

    #[test]
    fn a_meeting_seats_the_living_around_the_table_and_talks_before_it_votes() {
        let mut play = Play::new(8, 11);
        let (impostor, crew) = (play.impostor(), play.crew());
        let (victim, worker, caller) = (crew[0], crew[1], crew[2]);
        play.at(KILL_COOLDOWN);
        play.kill_at(impostor, victim, [30.0, 0.0, 30.0]);
        let place = play.station(worker, 0);
        play.stand(worker, place);
        play.act(worker, task()).unwrap();
        play.call(caller);
        let view = play.view(worker);
        assert_eq!(view["phase"], "discuss");
        assert_eq!(view["working"], Value::Null, "a meeting stops the tasks underway");
        assert_eq!(view["meeting"]["stage"], "discuss");
        assert_eq!(view["meeting"]["endsAt"], START + KILL_COOLDOWN + DISCUSS);
        assert_eq!((view["meeting"]["voted"].as_u64(), view["meeting"]["voters"].as_u64()), (Some(0), Some(7)));
        assert_eq!(view["meeting"]["myVote"], Value::Null);
        // Every living player has a seat of their own around the table; the dead and onlookers have none.
        let seats: Vec<[f64; 3]> = play
            .ids()
            .into_iter()
            .filter(|id| *id != victim)
            .map(|id| serde_json::from_value(play.view(id)["meeting"]["seat"].clone()).unwrap())
            .collect();
        for (index, seat) in seats.iter().enumerate() {
            let away = distance_xz(TABLE, *seat);
            assert!((SEAT_NEAR - 0.01..=SEAT_FAR + 0.01).contains(&away), "{away}");
            assert_eq!(seat[1], TABLE[1]);
            assert!(seats[..index].iter().all(|other| distance_xz(*other, *seat) > 1.0), "{seats:?}");
        }
        assert_eq!(play.view(victim)["meeting"]["seat"], Value::Null);
        assert_eq!(play.onlooker()["meeting"]["seat"], Value::Null);
        // Nothing else happens in a meeting, and the votes wait for the talk to end.
        assert_eq!(play.act(worker, task()), Err(NOT_NOW));
        assert_eq!(play.act(impostor, kill(worker)), Err(NOT_NOW));
        assert_eq!(play.act(worker, report(1)), Err(NOT_NOW));
        assert_eq!(play.act(worker, call()), Err(NOT_NOW));
        assert_eq!(play.act(worker, vote(None)), Err(NOT_NOW));
        play.tick(KILL_COOLDOWN + DISCUSS - 1);
        assert_eq!(play.view(worker)["phase"], "discuss");
        play.tick(KILL_COOLDOWN + DISCUSS);
        let view = play.view(worker);
        assert_eq!((view["phase"].as_str(), view["meeting"]["stage"].as_str()), (Some("vote"), Some("vote")));
        assert_eq!(view["meeting"]["endsAt"], START + KILL_COOLDOWN + DISCUSS + VOTE);
        // Fifteen around the table still have room.
        let mut crowd = Play::new(15, 12);
        let host = crowd.crew()[0];
        crowd.at(CALM);
        crowd.call(host);
        let seats: Vec<[f64; 3]> = crowd.meeting().seats.iter().map(|(_, seat)| *seat).collect();
        assert_eq!(seats.len(), 15);
        for (index, seat) in seats.iter().enumerate() {
            assert!(distance_xz(TABLE, *seat) <= SEAT_FAR + 0.01);
            assert!(seats[..index].iter().all(|other| distance_xz(*other, *seat) > 0.75), "{seats:?}");
        }
    }

    /// Votes by player index: a target's index, or None to skip.
    type Votes = &'static [(usize, Option<usize>)];

    /// A meeting of seven, called by the last of them, where `votes` are cast before time runs out.
    fn meeting_of_seven(votes: Votes) -> (Play, Vec<Uuid>, Vec<(Audience, Value)>) {
        let mut play = Play::new(7, 12);
        let ids = play.ids();
        play.at(CALM);
        play.call(ids[6]);
        let ended = play.open_vote();
        for (voter, target) in votes {
            play.act(ids[*voter], vote(target.map(|target| ids[target]))).unwrap();
        }
        let events = play.tick(ended);
        (play, ids, events)
    }

    #[test]
    fn the_unique_top_target_with_more_votes_than_skips_is_ejected() {
        let cases: [(Votes, Option<usize>); 6] = [
            (&[(0, Some(1)), (2, Some(1)), (3, Some(4)), (5, None)], Some(1)),
            (&[(0, Some(1)), (2, Some(1)), (3, Some(4)), (5, Some(4))], None),
            (&[(0, Some(1)), (2, Some(1)), (3, None), (5, None)], None),
            (&[(0, Some(1)), (2, Some(1)), (4, Some(1)), (3, None), (5, None)], Some(1)),
            (&[(0, None), (1, None)], None),
            (&[], None),
        ];
        for (votes, ejected) in cases {
            let (play, ids, events) = meeting_of_seven(votes);
            let out = ejected.map(|index| ids[index]);
            let impostor = out.map(|id| play.player(id).role == Role::Impostor);
            let name = out.map(|id| play.name(id));
            assert_eq!(
                events,
                vec![(
                    Audience::Everyone,
                    json!({"type": "verdict", "number": 1, "ejected": out, "name": name, "impostor": impostor})
                )],
                "{votes:?}"
            );
            assert!(play.game.meeting.is_none());
            let view = play.view(ids[0]);
            assert_eq!(view["phase"], "play");
            let cast: Vec<Value> = votes
                .iter()
                .map(|(voter, target)| json!({"voter": ids[*voter], "target": target.map(|target| ids[target])}))
                .collect();
            assert_eq!(
                view["lastMeeting"],
                json!({"number": 1, "ejected": out, "name": name, "impostor": impostor, "votes": cast})
            );
            for id in &ids {
                let gone = Some(*id) == out;
                assert_eq!(play.player(*id).alive, !gone);
                let shown =
                    view["players"].as_array().unwrap().iter().find(|player| player["id"] == json!(id)).cloned();
                assert_eq!(shown.unwrap()["alive"], !gone, "an ejection is public at once");
            }
        }
    }

    #[test]
    fn the_vote_ends_once_every_living_player_has_voted() {
        let mut play = Play::new(5, 13);
        let (impostor, crew) = (play.impostor(), play.crew());
        play.at(KILL_COOLDOWN);
        play.kill_at(impostor, crew[0], [30.0, 0.0, 30.0]);
        play.stand(crew[1], [30.0, 0.0, 31.0]);
        play.act(crew[1], report(1)).unwrap();
        play.open_vote();
        // The dead have no vote; nobody votes twice, for the dead or for a stranger.
        assert_eq!(play.act(crew[0], vote(None)), Err(OUT));
        assert_eq!(play.act(crew[1], vote(Some(crew[0]))), Err(NO_TARGET));
        assert_eq!(play.act(crew[1], vote(Some(Uuid::new_v4()))), Err(NO_TARGET));
        assert_eq!(play.act(crew[1], json!({"do": "vote"})), Err(BAD_ACTION));
        assert_eq!(play.act(crew[1], json!({"do": "vote", "target": 3})), Err(BAD_ACTION));
        play.act(crew[1], vote(Some(impostor))).unwrap();
        assert_eq!(play.act(crew[1], vote(None)), Err(VOTED));
        play.act(crew[2], vote(Some(impostor))).unwrap();
        play.act(impostor, vote(Some(crew[2]))).unwrap();
        assert_eq!(play.view(crew[3])["meeting"]["voted"], 3);
        assert!(play.game.meeting.is_some());
        let events = play.act(crew[3], vote(None)).unwrap();
        let name = play.name(impostor);
        let verdict = json!({"type": "verdict", "number": 1, "ejected": impostor, "name": name, "impostor": true});
        assert_eq!(events, vec![(Audience::Everyone, verdict)]);
        assert!(play.game.meeting.is_none());
        let result = play.game.result().unwrap();
        assert_eq!((result["winner"].as_str(), result["reason"].as_str()), (Some("crew"), Some("impostorsOut")));
        assert_eq!(play.view(crew[1])["phase"], "ended");
    }

    #[test]
    fn when_a_meeting_ends_the_bodies_go_the_deaths_are_public_and_the_waits_start_again() {
        let mut play = Play::new(7, 14);
        let impostors = play.role(Role::Impostor);
        let crew = play.crew();
        play.at(KILL_COOLDOWN);
        play.kill_at(impostors[0], crew[0], [30.0, 0.0, 30.0]);
        play.kill_at(impostors[1], crew[1], [-30.0, 0.0, 30.0]);
        play.stand(crew[2], [30.0, 0.0, 32.0]);
        play.act(crew[2], report(1)).unwrap();
        let living = play.view(crew[3]);
        assert_eq!(living["bodies"].as_array().unwrap().len(), 2, "the bodies stay through the meeting");
        assert!(living["players"].as_array().unwrap().iter().all(|player| player["alive"] == true));
        // The dead know who else is dead.
        let ghost = play.view(crew[0]);
        let dead: Vec<&Value> =
            ghost["players"].as_array().unwrap().iter().filter(|player| player["alive"] == false).collect();
        assert_eq!(dead.len(), 2);
        let ended = play.open_vote();
        // Two votes out of five for an impostor, then time runs out: the impostor is ejected.
        play.act(crew[2], vote(Some(impostors[0]))).unwrap();
        play.act(crew[3], vote(Some(impostors[0]))).unwrap();
        play.tick(ended);
        let view = play.view(crew[3]);
        assert_eq!(view["bodies"], json!([]));
        let out: HashSet<String> = view["players"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|player| player["alive"] == false)
            .map(|player| player["id"].as_str().unwrap().to_owned())
            .collect();
        let expected: HashSet<String> = [crew[0], crew[1], impostors[0]].iter().map(Uuid::to_string).collect();
        assert_eq!(out, expected);
        assert_eq!(view["lastMeeting"]["impostor"], true);
        assert_eq!(view["emergencyFrom"], START + ended + CALM);
        assert_eq!(play.view(impostors[1])["kill"]["readyAt"], START + ended + KILL_COOLDOWN);
        // An ejected impostor kills no more.
        assert_eq!(play.view(impostors[0])["kill"], Value::Null);
        play.at(ended + KILL_COOLDOWN);
        play.stand(impostors[0], [0.0, 0.0, 0.0]);
        play.stand(crew[3], [1.0, 0.0, 0.0]);
        assert_eq!(play.act(impostors[0], kill(crew[3])), Err(OUT));
        assert!(play.game.result().is_none());
    }

    #[test]
    fn the_crew_win_once_every_crew_task_is_done() {
        let mut play = Play::new(4, 15);
        let crew = play.crew();
        let last = crew[2];
        for player in &mut play.game.players {
            if crew.contains(&player.id) {
                for task in &mut player.tasks {
                    task.done = player.id != last;
                }
            }
        }
        for index in 0..4 {
            let place = play.station(last, index);
            play.stand(last, place);
            play.act(last, task()).unwrap();
            assert!(play.game.result().is_none());
            play.tick(TASK_TIME * (index as Millis + 1));
        }
        let result = play.game.result().unwrap();
        assert_eq!((result["winner"].as_str(), result["reason"].as_str()), (Some("crew"), Some("tasks")));
        let roles: Vec<(Value, Value)> = result["players"]
            .as_array()
            .unwrap()
            .iter()
            .map(|player| (player["id"].clone(), player["role"].clone()))
            .collect();
        let expected: Vec<(Value, Value)> =
            play.game.players.iter().map(|player| (json!(player.id), json!(player.role.name()))).collect();
        assert_eq!(roles, expected);
        assert_eq!(play.view(last)["phase"], "ended");
        assert_eq!(play.act(last, task()), Err(NOT_NOW));
    }

    #[test]
    fn the_impostors_win_once_they_are_as_many_as_the_living_crew() {
        // By kills: one impostor and three crew, two kills.
        let mut play = Play::new(4, 16);
        let (impostor, crew) = (play.impostor(), play.crew());
        play.at(KILL_COOLDOWN);
        play.kill_at(impostor, crew[0], [10.0, 0.0, 10.0]);
        assert!(play.game.result().is_none());
        play.at(2 * KILL_COOLDOWN);
        play.kill_at(impostor, crew[1], [20.0, 0.0, 10.0]);
        let result = play.game.result().unwrap();
        assert_eq!((result["winner"].as_str(), result["reason"].as_str()), (Some("impostor"), Some("parity")));
        let alive: Vec<bool> = result["players"].as_array().unwrap().iter().map(|p| p["alive"] == true).collect();
        assert_eq!(alive.iter().filter(|alive| !**alive).count(), 2);
        assert!(play.game.bodies.len() == 2 && play.view(crew[2])["phase"] == "ended");
        // By an ejection: one kill, then the crew vote one of their own out.
        let mut play = Play::new(4, 17);
        let (impostor, crew) = (play.impostor(), play.crew());
        play.at(KILL_COOLDOWN);
        play.kill_at(impostor, crew[0], [10.0, 0.0, 10.0]);
        play.stand(crew[1], [10.0, 0.0, 11.0]);
        play.act(crew[1], report(1)).unwrap();
        play.open_vote();
        play.act(impostor, vote(Some(crew[1]))).unwrap();
        play.act(crew[2], vote(Some(crew[1]))).unwrap();
        play.act(crew[1], vote(Some(impostor))).unwrap();
        let result = play.game.result().unwrap();
        assert_eq!((result["winner"].as_str(), result["reason"].as_str()), (Some("impostor"), Some("parity")));
    }

    #[test]
    fn players_who_leave_drop_out_of_the_tasks_the_votes_and_the_counts() {
        let mut play = Play::new(6, 18);
        let (impostor, crew) = (play.impostor(), play.crew());
        // A crew member who leaves takes their tasks with them.
        assert!(play.leave(crew[0]).is_empty());
        let view = play.view(crew[1]);
        assert_eq!(view["progress"], json!({"done": 0, "total": 16}));
        assert_eq!(view["players"].as_array().unwrap().len(), 5);
        // A vote of someone who left, and one for them, no longer count; nor is the leaver waited for.
        play.at(CALM);
        play.call(crew[1]);
        let ended = play.open_vote();
        play.act(crew[1], vote(Some(crew[4]))).unwrap();
        play.act(crew[2], vote(Some(crew[1]))).unwrap();
        play.act(crew[3], vote(Some(crew[2]))).unwrap();
        play.act(crew[4], vote(Some(crew[2]))).unwrap();
        play.leave(crew[1]);
        assert_eq!(play.view(crew[2])["meeting"]["voters"], 4);
        assert!(play.game.meeting.is_some());
        // Counted, the leaver's vote would tie crew[4] with crew[2].
        play.act(impostor, vote(Some(crew[4]))).unwrap();
        assert!(play.game.meeting.is_none(), "everyone still in has voted");
        let last = play.view(crew[3])["lastMeeting"].clone();
        assert_eq!(last["ejected"], json!(crew[2]));
        let counted = json!([
            {"voter": crew[3], "target": crew[2]},
            {"voter": crew[4], "target": crew[2]},
            {"voter": impostor, "target": crew[4]},
        ]);
        assert_eq!(last["votes"], counted);
        // The impostor gone, the crew win, and the result lists those who left.
        play.at(ended + 1_000);
        assert!(play.game.result().is_none());
        play.leave(impostor);
        let result = play.game.result().unwrap();
        assert_eq!((result["winner"].as_str(), result["reason"].as_str()), (Some("crew"), Some("impostorsOut")));
        let left: Vec<&Value> = result["players"].as_array().unwrap().iter().filter(|p| p["left"] == true).collect();
        assert_eq!(left.len(), 3);
        assert_eq!(result["players"].as_array().unwrap().len(), 6);
    }

    #[test]
    fn the_living_talk_in_meetings_and_the_dead_among_themselves() {
        let mut play = Play::new(5, 19);
        let (impostor, crew) = (play.impostor(), play.crew());
        let (ghost, living) = (crew[0], crew[1]);
        // The living keep quiet between meetings.
        play.at(1_000);
        assert_eq!(play.act(living, say("안녕")), Err(NOT_NOW));
        play.at(KILL_COOLDOWN);
        play.kill_at(impostor, ghost, [30.0, 0.0, 30.0]);
        // The dead talk any time, to the dead only.
        play.act(ghost, say("  누가 그랬어요 ")).unwrap();
        let line = json!({"id": 1, "from": ghost, "name": play.name(ghost), "text": "누가 그랬어요", "ghost": true});
        assert_eq!(play.view(ghost)["talk"], json!([line]));
        assert_eq!(play.view(living)["talk"], json!([]));
        assert_eq!(play.view(impostor)["talk"], json!([]));
        assert_eq!(play.onlooker()["talk"], json!([]));
        // Something, at most 120 characters, nothing that is not text, one line a second.
        let long = "가".repeat(121);
        for bad in ["", "   ", long.as_str(), "a\u{7}b", "a\nb", "\u{202e}abc"] {
            assert_eq!(play.act(ghost, say(bad)), Err(BAD_TEXT), "{bad:?}");
        }
        assert_eq!(play.act(ghost, json!({"do": "say"})), Err(BAD_ACTION));
        play.at(KILL_COOLDOWN + 999);
        assert_eq!(play.act(ghost, say("또")), Err(TOO_FAST));
        play.at(KILL_COOLDOWN + 1_000);
        play.act(ghost, say(&"가".repeat(120))).unwrap();
        // In a meeting the living talk to everyone; the dead still to the dead.
        play.stand(living, [30.0, 0.0, 31.0]);
        play.act(living, report(1)).unwrap();
        play.act(living, say("시체를 찾았어요")).unwrap();
        play.at(KILL_COOLDOWN + 2_000);
        play.act(ghost, say("나예요")).unwrap();
        let public =
            json!([{"id": 3, "from": living, "name": play.name(living), "text": "시체를 찾았어요", "ghost": false}]);
        assert_eq!(play.view(living)["talk"], public);
        assert_eq!(play.view(impostor)["talk"], public);
        assert_eq!(play.onlooker()["talk"], public);
        let ids: Vec<u64> =
            play.view(ghost)["talk"].as_array().unwrap().iter().map(|line| line["id"].as_u64().unwrap()).collect();
        assert_eq!(ids, [1, 2, 3, 4]);
        // The meeting's lines go with it; the dead's stay, the last thirty of them.
        let ended = play.open_vote();
        play.tick(ended);
        assert_eq!(play.view(living)["talk"], json!([]));
        assert_eq!(play.view(ghost)["talk"].as_array().unwrap().len(), 3);
        for index in 0..40 {
            play.at(ended + 1_000 * (index + 1));
            play.act(ghost, say(&format!("{index}"))).unwrap();
        }
        let talk = play.view(ghost)["talk"].clone();
        assert_eq!(talk.as_array().unwrap().len(), TALK_KEPT);
        assert_eq!(talk[TALK_KEPT - 1]["text"], "39");
    }

    #[test]
    fn roles_and_votes_stay_with_their_owners_until_the_end() {
        let mut play = Play::new(11, 20);
        let impostors = play.role(Role::Impostor);
        let crew = play.crew();
        assert_eq!(impostors.len(), 3);
        // Impostors see one another; the crew and onlookers see no role but their own.
        for id in &impostors {
            let view = play.view(*id);
            assert_eq!(view["impostors"], json!(impostors));
            assert_eq!(view["kill"], json!({"readyAt": START + KILL_COOLDOWN, "targets": []}));
        }
        for view in crew.iter().map(|id| play.view(*id)).chain([play.onlooker()]) {
            assert_eq!((&view["impostors"], &view["kill"]), (&Value::Null, &Value::Null));
            assert!(!mentions(&view, "impostor"), "{view}");
        }
        assert_eq!(play.onlooker()["role"], Value::Null);
        assert_eq!(play.onlooker()["tasks"], json!([]));
        // Nobody sees who voted for whom while the meeting is on; everyone does once it ends.
        play.at(CALM);
        play.call(crew[0]);
        let ended = play.open_vote();
        play.act(crew[0], vote(Some(impostors[0]))).unwrap();
        play.act(impostors[0], vote(Some(crew[0]))).unwrap();
        for id in play.ids() {
            let meeting = play.view(id)["meeting"].clone();
            assert_eq!(meeting["voted"], 2);
            let mine = if id == crew[0] {
                json!({"target": impostors[0]})
            } else if id == impostors[0] {
                json!({"target": crew[0]})
            } else {
                Value::Null
            };
            assert_eq!(meeting["myVote"], mine);
            let keys: HashSet<&str> = meeting.as_object().unwrap().keys().map(String::as_str).collect();
            let expected: HashSet<&str> = [
                "number",
                "stage",
                "caller",
                "callerName",
                "reason",
                "body",
                "endsAt",
                "seat",
                "voted",
                "voters",
                "myVote",
            ]
            .into();
            assert_eq!(keys, expected);
        }
        play.tick(ended);
        let votes = json!([{"voter": crew[0], "target": impostors[0]}, {"voter": impostors[0], "target": crew[0]}]);
        assert_eq!(play.onlooker()["lastMeeting"]["votes"], votes);
        assert_eq!(play.view(crew[5])["lastMeeting"]["votes"], votes);
    }

    #[test]
    fn views_light_up_what_each_viewers_buttons_reach_as_of_the_last_tick() {
        let mut play = Play::new(5, 21);
        let (impostor, crew) = (play.impostor(), play.crew());
        let (me, other) = (crew[0], crew[1]);
        let station = play.player(me).tasks[0].station;
        play.stand(me, play.station(me, 0));
        assert_eq!(play.view(me)["near"]["station"], Value::Null, "not before a tick has seen it");
        play.tick(100);
        assert_eq!(play.view(me)["near"], json!({"station": station, "body": null, "table": false}));
        // Someone else's station is not mine.
        let theirs = (0..8).find(|station| play.player(me).tasks.iter().all(|task| task.station != *station)).unwrap();
        play.stand(me, play.game.stations[theirs]);
        play.tick(200);
        assert_eq!(play.view(me)["near"]["station"], Value::Null);
        // The table from within 3 m.
        play.stand(me, [2.9, 0.0, 0.0]);
        play.tick(300);
        assert_eq!(play.view(me)["near"]["table"], true);
        // The impostor's reach: living crew within 2.2 m, nearest first; the crew have none.
        play.stand(impostor, [50.0, 0.0, 50.0]);
        play.stand(me, [51.5, 0.0, 50.0]);
        play.stand(other, [50.0, 0.0, 51.0]);
        play.stand(crew[2], [52.3, 0.0, 50.0]);
        play.tick(400);
        assert_eq!(play.view(impostor)["kill"], json!({"readyAt": START + KILL_COOLDOWN, "targets": [other, me]}));
        assert_eq!(play.view(me)["kill"], Value::Null);
        // A body within 3 m, for the living only.
        play.at(KILL_COOLDOWN);
        play.act(impostor, kill(me)).unwrap();
        play.tick(KILL_COOLDOWN + 100);
        assert_eq!(play.view(other)["near"]["body"], 1);
        assert_eq!(play.view(me)["near"]["body"], Value::Null);
        assert_eq!(play.view(impostor)["kill"]["targets"], json!([other]));
        // In a meeting nothing is in reach.
        play.act(other, report(1)).unwrap();
        play.tick(KILL_COOLDOWN + 200);
        assert_eq!(play.view(other)["near"], json!({"station": null, "body": null, "table": false}));
        assert_eq!(play.view(impostor)["kill"]["targets"], json!([]));
    }
}
