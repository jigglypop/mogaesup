//! 축구: two teams on a field the host's page fits onto the island's open ground, and one ball the server rolls.
//!
//! - Teams A and B take the players in turn as they joined (A the first, third…). A defends the end line at
//!   −halfLength along the field's axis and attacks the one at +halfLength; B the other way round.
//! - The ball rolls on the field's plane: it keeps 40% of its speed each second, never goes faster than 18 m/s, stops
//!   below 0.1 m/s, and bounces off the side and end lines keeping 60% of its speed across them, but for the goal mouths
//!   (min(6, halfWidth) m wide, centred on each end line). Each tick rolls it on in fixed 5 ms steps.
//! - A player on the field (within 0.5 m of its lines) within 0.9 m of the ball dribbles it: it goes along the
//!   player→ball direction at max(its speed, the player's speed × 1.1 + 1) m/s, the player's speed measured from where
//!   the live room showed them over the last ticks (at least 150 ms of them). `{"kick": true}` within 1.4 m sends it at
//!   12 m/s along player→ball, once every 0.4 s per player. Players off the field touch nothing.
//! - The ball's centre crossing an end line inside the mouth is a goal for the team attacking that end, credited to
//!   whoever touched it last if they are on that team. Then 3 s of 킥오프: the ball waits on the centre spot, every
//!   player's view carries a spot in their own half for their page to move them to, and nobody touches the ball.
//! - Four minutes of play, the clock stopped during kickoffs (a goal moves `endsAt` 3 s later). The game starts with a
//!   kickoff, and also ends when either team has nobody left.
//!
//! Layout (from the host's page): `{"center": [x, y, z], "axis": "x"|"z", "halfLength": 10–24, "halfWidth": 6–14}`,
//! the long side along `axis` (`halfWidth ≤ halfLength`), the whole field within 200 m of the island's centre.
//! View: `{"field": {center, axis, halfLength, halfWidth, mouth}, "ball": {position, velocity, at}, "score": {a, b},
//! "teams": {a: [id], b: [id]}, "team": "a"|"b"|null, "phase": "kickoff"|"play", "endsAt": ms,
//! "kickoff": null|{n, until, spot}}`; `spot` (where this player stands for the kickoff) is in that player's view only.
//! The ball is where it was at `at` (server ms), moving at `velocity` (m/s), both rounded to the centimeter.
//! Events: `{"type": "goal", "team", "scorer"}` and `{"type": "kickoff", "n", "until"}`, to everyone.
//! Result: `{"score": {a, b}, "winner": "a"|"b"|null, "scorers": [{id, name, team, goals}]}`, most goals first.

use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    ops::RangeInclusive,
};
use uuid::Uuid;

use super::{BAD_ACTION, BAD_LAYOUT, Ctx, Game, GameError, Kind, MAX_COORDINATE, Millis, point};

pub(crate) const KIND: Kind = Kind::new("soccer", 2, 20, create).ticking(20);

/// Four minutes of play; the clock stops during kickoffs.
const PLAY: Millis = 240_000;
/// The pause before each kickoff.
const KICKOFF: Millis = 3_000;
/// Each tick rolls the ball on in steps of this many milliseconds.
const STEP: Millis = 5;
/// The share of its speed the rolling ball keeps after a second.
const KEEP_PER_SECOND: f64 = 0.4;
/// Below this speed (m/s) the ball stops.
const REST: f64 = 0.1;
const MAX_SPEED: f64 = 18.0;
/// The share of its speed across a line the ball keeps as it bounces off it.
const RESTITUTION: f64 = 0.6;
/// The goal mouth's width (m), at most the field's half width.
const MOUTH: f64 = 6.0;
const HALF_LENGTH: RangeInclusive<f64> = 10.0..=24.0;
const HALF_WIDTH: RangeInclusive<f64> = 6.0..=14.0;
/// How far outside its lines a player still counts as on the field (m): someone standing on a line is in.
const LINE: f64 = 0.5;
const DRIBBLE_REACH: f64 = 0.9;
const KICK_REACH: f64 = 1.4;
const KICK_SPEED: f64 = 12.0;
const KICK_COOLDOWN: Millis = 400;
/// A player's speed is measured over at least this long, as the live room's updates and the ticks do not keep step.
const PACE_WINDOW: Millis = 150;
/// Players side by side in a kickoff row.
const ROW: usize = 5;
/// Closer than this (m), two points are one and give no direction.
const SAME: f64 = 1e-6;

const KICKING_OFF: GameError = GameError::new("kickoff", "킥오프 중이에요.");
const COOLING: GameError = GameError::new("cooldown", "조금 있다 찰 수 있어요.");
const OFF_FIELD: GameError = GameError::new("off_field", "경기장 안에서 찰 수 있어요.");
const TOO_FAR: GameError = GameError::new("too_far", "공이 너무 멀어요.");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Team {
    A,
    B,
}

impl Team {
    fn index(self) -> usize {
        self as usize
    }

    fn name(self) -> &'static str {
        ["a", "b"][self.index()]
    }

    /// Which way along the field the team attacks: A toward +halfLength, where B's goal is.
    fn ahead(self) -> f64 {
        if self == Team::A { 1.0 } else { -1.0 }
    }
}

/// The field on the island. Inside, points are in field coordinates `[u, v]`: `u` along the long side (toward B's goal),
/// `v` across it, both from the centre spot.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Field {
    center: [f64; 3],
    /// Whether the long side runs along x (else along z).
    along_x: bool,
    half_length: f64,
    half_width: f64,
}

impl Field {
    /// The host's field, checked: its shape, sizes and place.
    fn parse(layout: &Value) -> Result<Self, GameError> {
        let center = point(layout.get("center").ok_or(BAD_LAYOUT)?)?;
        let along_x = match layout.get("axis").and_then(Value::as_str) {
            Some("x") => true,
            Some("z") => false,
            _ => return Err(BAD_LAYOUT),
        };
        let half = |name: &str, range: &RangeInclusive<f64>| {
            layout.get(name).and_then(Value::as_f64).filter(|value| range.contains(value)).ok_or(BAD_LAYOUT)
        };
        let half_length = half("halfLength", &HALF_LENGTH)?;
        let half_width = half("halfWidth", &HALF_WIDTH)?;
        let (reach_x, reach_z) = if along_x { (half_length, half_width) } else { (half_width, half_length) };
        if half_width > half_length
            || center[0].abs() + reach_x > MAX_COORDINATE
            || center[2].abs() + reach_z > MAX_COORDINATE
        {
            return Err(BAD_LAYOUT);
        }
        Ok(Self { center, along_x, half_length, half_width })
    }

    /// Half the goal mouth.
    fn half_mouth(&self) -> f64 {
        MOUTH.min(self.half_width) / 2.0
    }

    /// A ground point in field coordinates.
    fn local(&self, [x, _, z]: [f64; 3]) -> [f64; 2] {
        let (dx, dz) = (x - self.center[0], z - self.center[2]);
        if self.along_x { [dx, dz] } else { [dz, dx] }
    }

    /// Field coordinates as a point on the field's plane.
    fn world(&self, [u, v]: [f64; 2]) -> [f64; 3] {
        let [x, y, z] = self.center;
        if self.along_x { [x + u, y, z + v] } else { [x + v, y, z + u] }
    }

    /// A velocity in field coordinates as one on the ground.
    fn world_velocity(&self, [u, v]: [f64; 2]) -> [f64; 3] {
        if self.along_x { [u, 0.0, v] } else { [v, 0.0, u] }
    }

    /// Whether a player at `at` stands on the field.
    fn holds(&self, [u, v]: [f64; 2]) -> bool {
        u.abs() <= self.half_length + LINE && v.abs() <= self.half_width + LINE
    }

    fn view(&self) -> Value {
        json!({
            "center": self.center,
            "axis": if self.along_x { "x" } else { "z" },
            "halfLength": self.half_length,
            "halfWidth": self.half_width,
            "mouth": self.half_mouth() * 2.0,
        })
    }
}

/// The ball, in field coordinates.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Ball {
    at: [f64; 2],
    velocity: [f64; 2],
}

impl Ball {
    fn speed(&self) -> f64 {
        self.velocity[0].hypot(self.velocity[1])
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    /// The ball waits on the centre spot until then.
    Kickoff {
        until: Millis,
    },
    Play,
}

/// When the live room showed a player where (field coordinates).
type Sighting = (Millis, [f64; 2]);

/// A player on the field this tick: where, how fast (m/s), and which way they go.
struct Runner {
    id: Uuid,
    at: [f64; 2],
    pace: f64,
    heading: [f64; 2],
}

fn distance([au, av]: [f64; 2], [bu, bv]: [f64; 2]) -> f64 {
    (au - bu).hypot(av - bv)
}

/// The unit direction from `from` to `to`, or None when they are one point.
fn toward(from: [f64; 2], to: [f64; 2]) -> Option<[f64; 2]> {
    let length = distance(from, to);
    (length > SAME).then(|| [(to[0] - from[0]) / length, (to[1] - from[1]) / length])
}

/// To centimeters, which is all a view needs.
fn cm(point: [f64; 3]) -> [f64; 3] {
    point.map(|value| (value * 100.0).round() / 100.0)
}

pub(crate) struct Soccer {
    field: Field,
    /// Team A's and team B's players, in the order they joined.
    teams: [Vec<Uuid>; 2],
    names: HashMap<Uuid, String>,
    score: [u32; 2],
    /// Who scored for their team and how often, in the order of their first goal.
    scorers: Vec<(Uuid, Team, u32)>,
    ball: Ball,
    /// How far on the server's clock the ball has been rolled.
    rolled: Millis,
    /// When the ball was as `ball` says, as views show it: moves on only when the ball changes.
    ball_at: Millis,
    phase: Phase,
    /// Kickoffs so far, the first at the start.
    kickoffs: u32,
    /// Where each player stands for the kickoff under way.
    spots: HashMap<Uuid, [f64; 3]>,
    /// When the match ends if nobody scores again (each kickoff moves it later).
    ends_at: Millis,
    /// Where the live room showed each player at the last ticks, oldest first, in field coordinates.
    trails: HashMap<Uuid, VecDeque<Sighting>>,
    /// When each player last kicked.
    kicked: HashMap<Uuid, Millis>,
    last_touch: Option<Uuid>,
    over: bool,
}

fn create(layout: &Value, ctx: &mut Ctx) -> Result<Box<dyn Game>, GameError> {
    Ok(Box::new(Soccer::new(Field::parse(layout)?, ctx)))
}

impl Soccer {
    /// The lobby's players in two teams, taking turns as they joined, waiting for the first kickoff.
    fn new(field: Field, ctx: &mut Ctx) -> Self {
        let mut teams = [Vec::new(), Vec::new()];
        for (index, player) in ctx.players().iter().enumerate() {
            teams[index % 2].push(player.id);
        }
        let mut game = Self {
            field,
            teams,
            names: ctx.players().iter().map(|player| (player.id, player.name.clone())).collect(),
            score: [0; 2],
            scorers: Vec::new(),
            ball: Ball::default(),
            rolled: ctx.now(),
            ball_at: ctx.now(),
            phase: Phase::Play,
            kickoffs: 0,
            spots: HashMap::new(),
            ends_at: ctx.now() + PLAY,
            trails: HashMap::new(),
            kicked: HashMap::new(),
            last_touch: None,
            over: false,
        };
        game.kickoff(ctx);
        game
    }

    fn team_of(&self, player: Uuid) -> Option<Team> {
        [Team::A, Team::B].into_iter().find(|team| self.teams[team.index()].contains(&player))
    }

    /// The ball back on the centre spot and everyone sent to their own half, for [`KICKOFF`]; the clock waits.
    fn kickoff(&mut self, ctx: &mut Ctx) {
        let now = ctx.now();
        let until = now + KICKOFF;
        self.ends_at = until + self.ends_at.saturating_sub(now);
        self.phase = Phase::Kickoff { until };
        self.ball = Ball::default();
        self.rolled = until;
        self.ball_at = now;
        self.last_touch = None;
        self.kickoffs += 1;
        self.spots = self.formation();
        ctx.emit(json!({"type": "kickoff", "n": self.kickoffs, "until": until}));
    }

    /// Where everyone stands for a kickoff: in their own half, in rows of five across the field (the first row
    /// nearest the ball), in the order they joined.
    fn formation(&self) -> HashMap<Uuid, [f64; 3]> {
        let mut spots = HashMap::new();
        for team in [Team::A, Team::B] {
            let members = &self.teams[team.index()];
            for (index, id) in members.iter().enumerate() {
                let row = index / ROW;
                let in_row = (members.len() - row * ROW).min(ROW);
                let across = ((index % ROW) as f64 + 0.5) / in_row as f64 * 2.0 - 1.0;
                let depth = (0.3 + 0.35 * row as f64).min(0.9);
                let at = [-team.ahead() * self.field.half_length * depth, across * self.field.half_width * 0.8];
                spots.insert(*id, cm(self.field.world(at)));
            }
        }
        spots
    }

    /// Notes where the live room shows each player now, keeping the newest sample at least [`PACE_WINDOW`] old.
    fn watch(&mut self, ctx: &Ctx) {
        let now = ctx.now();
        for player in ctx.players() {
            let Some(at) = ctx.position(player.id) else { continue };
            let trail = self.trails.entry(player.id).or_default();
            trail.push_back((now, self.field.local(at)));
            while trail.len() > 2 && trail.get(1).is_some_and(|(seen, _)| now.saturating_sub(*seen) >= PACE_WINDOW) {
                trail.pop_front();
            }
        }
    }

    /// The oldest and newest of where `player` was seen lately.
    fn ends_of_trail(&self, player: Uuid) -> Option<(Sighting, Sighting)> {
        let trail = self.trails.get(&player)?;
        Some((*trail.front()?, *trail.back()?))
    }

    /// How fast `player` has been going lately (m/s).
    fn pace(&self, player: Uuid) -> f64 {
        let Some(((from_at, from), (to_at, to))) = self.ends_of_trail(player) else { return 0.0 };
        if to_at <= from_at {
            return 0.0;
        }
        distance(from, to) / ((to_at - from_at) as f64 / 1000.0)
    }

    /// Which way `player` has been going lately; standing still, toward the goal they attack.
    fn heading(&self, player: Uuid, team: Team) -> [f64; 2] {
        self.ends_of_trail(player)
            .and_then(|((_, from), (_, to))| if distance(from, to) > 0.01 { toward(from, to) } else { None })
            .unwrap_or([team.ahead(), 0.0])
    }

    /// The players on the field now.
    fn runners(&self, ctx: &Ctx) -> Vec<Runner> {
        ctx.players()
            .iter()
            .filter_map(|player| {
                let team = self.team_of(player.id)?;
                let at = self.field.local(ctx.position(player.id)?);
                self.field.holds(at).then(|| Runner {
                    id: player.id,
                    at,
                    pace: self.pace(player.id),
                    heading: self.heading(player.id, team),
                })
            })
            .collect()
    }

    /// The nearest player within [`DRIBBLE_REACH`] (the earliest to join at the same distance) pushes the ball on.
    fn touch(&mut self, runners: &[Runner]) {
        let nearest = runners
            .iter()
            .map(|runner| (runner, distance(runner.at, self.ball.at)))
            .filter(|(_, apart)| *apart <= DRIBBLE_REACH)
            .min_by(|a, b| a.1.total_cmp(&b.1));
        let Some((runner, _)) = nearest else { return };
        let direction = toward(runner.at, self.ball.at).unwrap_or(runner.heading);
        let speed = self.ball.speed().max(runner.pace * 1.1 + 1.0).min(MAX_SPEED);
        self.ball.velocity = direction.map(|part| part * speed);
        self.last_touch = Some(runner.id);
    }

    /// Rolls the ball `dt` seconds on, bouncing off the lines; the team that scored when it went into a goal.
    fn roll(&mut self, dt: f64) -> Option<Team> {
        let [vu, vv] = self.ball.velocity;
        if vu == 0.0 && vv == 0.0 {
            return None;
        }
        // Exact for a speed that falls to KEEP_PER_SECOND of itself every second.
        let keep = KEEP_PER_SECOND.powf(dt);
        let travel = (1.0 - keep) / -KEEP_PER_SECOND.ln();
        let [u0, v0] = self.ball.at;
        let (mut u, mut v) = (u0 + vu * travel, v0 + vv * travel);
        let (mut vu, mut vv) = (vu * keep, vv * keep);
        let (length, width) = (self.field.half_length, self.field.half_width);
        if u.abs() > length {
            let end = length.copysign(u);
            // Where across the field its centre crossed the end line.
            let crossed = v0 + (v - v0) * (end - u0) / (u - u0);
            if crossed.abs() <= self.field.half_mouth() {
                return Some(if end > 0.0 { Team::A } else { Team::B });
            }
            u = end - (u - end) * RESTITUTION;
            vu = -vu * RESTITUTION;
        }
        if v.abs() > width {
            let side = width.copysign(v);
            v = side - (v - side) * RESTITUTION;
            vv = -vv * RESTITUTION;
        }
        self.ball.at = [u.clamp(-length, length), v.clamp(-width, width)];
        self.ball.velocity = if vu.hypot(vv) < REST { [0.0; 2] } else { [vu, vv] };
        None
    }

    /// `team` scored: the score, the scorer, and the next kickoff, or the end when no time is left.
    fn goal(&mut self, team: Team, ctx: &mut Ctx) {
        self.score[team.index()] += 1;
        let scorer = self.last_touch.filter(|id| self.team_of(*id) == Some(team));
        if let Some(id) = scorer {
            match self.scorers.iter_mut().find(|(who, ..)| *who == id) {
                Some((.., goals)) => *goals += 1,
                None => self.scorers.push((id, team, 1)),
            }
        }
        ctx.emit(json!({"type": "goal", "team": team.name(), "scorer": scorer}));
        if ctx.now() >= self.ends_at {
            self.over = true;
        } else {
            self.kickoff(ctx);
        }
    }
}

impl Game for Soccer {
    fn view(&self, viewer: Option<Uuid>, _now: Millis) -> Value {
        let kickoff = match self.phase {
            Phase::Kickoff { until } => json!({
                "n": self.kickoffs,
                "until": until,
                "spot": viewer.and_then(|id| self.spots.get(&id)),
            }),
            Phase::Play => Value::Null,
        };
        json!({
            "field": self.field.view(),
            "ball": {
                "position": cm(self.field.world(self.ball.at)),
                "velocity": cm(self.field.world_velocity(self.ball.velocity)),
                "at": self.ball_at,
            },
            "score": {"a": self.score[0], "b": self.score[1]},
            "teams": {"a": self.teams[0], "b": self.teams[1]},
            "team": viewer.and_then(|id| self.team_of(id)).map(Team::name),
            "phase": if kickoff.is_null() { "play" } else { "kickoff" },
            "endsAt": self.ends_at,
            "kickoff": kickoff,
        })
    }

    fn act(&mut self, player: Uuid, action: &Value, ctx: &mut Ctx) -> Result<(), GameError> {
        if action.get("kick") != Some(&Value::Bool(true)) {
            return Err(BAD_ACTION);
        }
        let team = self.team_of(player).ok_or(BAD_ACTION)?;
        if matches!(self.phase, Phase::Kickoff { .. }) {
            return Err(KICKING_OFF);
        }
        let now = ctx.now();
        if self.kicked.get(&player).is_some_and(|at| now < at + KICK_COOLDOWN) {
            return Err(COOLING);
        }
        let at =
            ctx.position(player).map(|at| self.field.local(at)).filter(|at| self.field.holds(*at)).ok_or(OFF_FIELD)?;
        if distance(at, self.ball.at) > KICK_REACH {
            return Err(TOO_FAR);
        }
        let direction = toward(at, self.ball.at).unwrap_or_else(|| self.heading(player, team));
        self.ball.velocity = direction.map(|part| part * KICK_SPEED);
        // The ball is as the last tick rolled it.
        self.ball_at = self.rolled;
        self.kicked.insert(player, now);
        self.last_touch = Some(player);
        Ok(())
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        if self.over {
            return;
        }
        let now = ctx.now();
        self.watch(ctx);
        if let Phase::Kickoff { until } = self.phase {
            if now < until {
                return;
            }
            self.phase = Phase::Play;
        }
        let runners = self.runners(ctx);
        let before = self.ball;
        let end = now.min(self.ends_at);
        while self.rolled + STEP <= end {
            self.touch(&runners);
            let scored = self.roll(STEP as f64 / 1000.0);
            self.rolled += STEP;
            if let Some(team) = scored {
                self.goal(team, ctx);
                return;
            }
        }
        if self.ball != before {
            self.ball_at = self.rolled;
        }
        if now >= self.ends_at {
            self.over = true;
        }
    }

    fn leave(&mut self, player: Uuid, _ctx: &mut Ctx) {
        for team in &mut self.teams {
            team.retain(|id| *id != player);
        }
        self.spots.remove(&player);
        self.trails.remove(&player);
        self.kicked.remove(&player);
        if self.last_touch == Some(player) {
            self.last_touch = None;
        }
        // A match against nobody is over.
        if self.teams.iter().any(Vec::is_empty) {
            self.over = true;
        }
    }

    fn result(&self) -> Option<Value> {
        if !self.over {
            return None;
        }
        let winner = match self.score[0].cmp(&self.score[1]) {
            std::cmp::Ordering::Greater => Some(Team::A.name()),
            std::cmp::Ordering::Less => Some(Team::B.name()),
            std::cmp::Ordering::Equal => None,
        };
        // Most goals first; equal tallies in the order of their first goal.
        let mut scorers = self.scorers.clone();
        scorers.sort_by_key(|(.., goals)| std::cmp::Reverse(*goals));
        let scorers: Vec<Value> = scorers
            .iter()
            .map(|(id, team, goals)| json!({"id": id, "name": self.names.get(id), "team": team.name(), "goals": goals}))
            .collect();
        Some(json!({"score": {"a": self.score[0], "b": self.score[1]}, "winner": winner, "scorers": scorers}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::{Audience, Member};
    use rand::{SeedableRng, rngs::StdRng};

    const START: Millis = 1_000_000;
    /// When the first kickoff is over.
    const KICKED_OFF: Millis = START + KICKOFF;
    const TICK: Millis = 50;
    const KICK: fn() -> Value = || json!({"kick": true});

    fn members(count: usize) -> Vec<Member> {
        (0..count).map(|index| Member { id: Uuid::new_v4(), name: format!("player{index}") }).collect()
    }

    /// A 40 × 24 m field along x around (10, 0, −5): A's goal on x = −10, B's on x = 30.
    fn layout() -> Value {
        json!({"center": [10.0, 0.0, -5.0], "axis": "x", "halfLength": 20, "halfWidth": 12})
    }

    /// A match driven by hand: the clock and where everyone stands are what each call says.
    struct Match {
        game: Soccer,
        players: Vec<Member>,
        standing: HashMap<Uuid, [f64; 3]>,
        rng: StdRng,
        now: Millis,
    }

    impl Match {
        /// `count` players at the first kickoff, nobody placed in the live room yet.
        fn new(count: usize, layout: &Value) -> Self {
            let players = members(count);
            let standing = HashMap::new();
            let mut rng = StdRng::seed_from_u64(7);
            let mut ctx = Ctx::new(START, &players, &standing, &mut rng);
            let game = Soccer::new(Field::parse(layout).unwrap(), &mut ctx);
            Self { game, players, standing, rng, now: START }
        }

        /// The same once the first kickoff is over.
        fn playing(count: usize, layout: &Value) -> Self {
            let mut game = Self::new(count, layout);
            game.tick_at(KICKED_OFF);
            assert_eq!(game.game.phase, Phase::Play);
            game
        }

        fn id(&self, index: usize) -> Uuid {
            self.players[index].id
        }

        /// Where field coordinates `[u, v]` are on the island.
        fn at(&self, u: f64, v: f64) -> [f64; 3] {
            self.game.field.world([u, v])
        }

        /// Player `index` stands at field coordinates `[u, v]` in the live room.
        fn stand(&mut self, index: usize, u: f64, v: f64) {
            let at = self.at(u, v);
            self.standing.insert(self.id(index), at);
        }

        /// The ball at `at` (field coordinates), rolling at `velocity`.
        fn place(&mut self, at: [f64; 2], velocity: [f64; 2]) {
            self.game.ball = Ball { at, velocity };
        }

        /// One tick at `now`: the events it sent.
        fn tick_at(&mut self, now: Millis) -> Vec<(Audience, Value)> {
            self.now = now;
            let mut ctx = Ctx::new(now, &self.players, &self.standing, &mut self.rng);
            self.game.tick(&mut ctx);
            ctx.events().to_vec()
        }

        /// Ticks every 50 ms for `ms`: every event sent meanwhile.
        fn run(&mut self, ms: Millis) -> Vec<Value> {
            let end = self.now + ms;
            let mut events = Vec::new();
            while self.now < end {
                let next = (self.now + TICK).min(end);
                events.extend(self.tick_at(next).into_iter().map(|(audience, event)| {
                    assert_eq!(audience, Audience::Everyone);
                    event
                }));
            }
            events
        }

        /// Player `index` acts now; on success, what it sent.
        fn act(&mut self, index: usize, action: Value) -> Result<Vec<(Audience, Value)>, GameError> {
            let id = self.id(index);
            let mut ctx = Ctx::new(self.now, &self.players, &self.standing, &mut self.rng);
            self.game.act(id, &action, &mut ctx)?;
            Ok(ctx.events().to_vec())
        }

        fn leave(&mut self, index: usize) {
            let id = self.id(index);
            let mut ctx = Ctx::new(self.now, &self.players, &self.standing, &mut self.rng);
            self.game.leave(id, &mut ctx);
        }

        fn view(&self, viewer: Option<usize>) -> Value {
            self.game.view(viewer.map(|index| self.id(index)), self.now)
        }

        fn ball(&self) -> Ball {
            self.game.ball
        }

        fn score(&self) -> Value {
            self.view(None)["score"].clone()
        }
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn layouts_take_a_field_of_the_allowed_size_wholly_on_the_island() {
        let players = members(2);
        let mut rng = StdRng::seed_from_u64(1);
        let positions = HashMap::new();
        let mut ctx = Ctx::new(START, &players, &positions, &mut rng);
        let with = |changes: Value| {
            let mut field = layout();
            for (key, value) in changes.as_object().unwrap() {
                field[key] = value.clone();
            }
            field
        };
        assert_eq!(create(&json!(null), &mut ctx).err(), Some(BAD_LAYOUT));
        assert_eq!(create(&json!({"field": layout()}), &mut ctx).err(), Some(BAD_LAYOUT));
        for bad in [
            json!({"center": [1, 2]}),
            json!({"center": null}),
            json!({"center": [0, 0, 200.5]}),
            json!({"axis": "y"}),
            json!({"axis": "X"}),
            json!({"axis": null}),
            json!({"halfLength": 9.99}),
            json!({"halfLength": 24.01}),
            json!({"halfLength": "20"}),
            json!({"halfWidth": 5.9}),
            json!({"halfWidth": 14.5}),
            json!({"halfWidth": null}),
            // Wider than it is long.
            json!({"halfLength": 12, "halfWidth": 13}),
            // Past the island's bounds at an end or a side.
            json!({"center": [181, 0, 0]}),
            json!({"center": [0, 0, -188.5]}),
            json!({"axis": "z", "center": [0, 0, 181]}),
        ] {
            assert_eq!(create(&with(bad.clone()), &mut ctx).err(), Some(BAD_LAYOUT), "{bad}");
        }
        for good in [
            json!({"halfLength": 10, "halfWidth": 6}),
            json!({"halfLength": 24, "halfWidth": 14}),
            json!({"halfLength": 14, "halfWidth": 14}),
            json!({"axis": "z"}),
            json!({"center": [180, -3.5, 188]}),
        ] {
            assert!(create(&with(good.clone()), &mut ctx).is_ok(), "{good}");
        }
    }

    #[test]
    fn teams_take_the_players_in_turn_as_they_joined() {
        let game = Match::new(5, &layout());
        let ids: Vec<Uuid> = (0..5).map(|index| game.id(index)).collect();
        assert_eq!(game.view(None)["teams"], json!({"a": [ids[0], ids[2], ids[4]], "b": [ids[1], ids[3]]}));
        for index in 0..5 {
            assert_eq!(game.view(Some(index))["team"], if index % 2 == 0 { "a" } else { "b" });
        }
        assert_eq!(game.view(None)["team"], Value::Null, "someone watching is on no team");
        let full = Match::new(20, &layout());
        let teams = full.view(None)["teams"].clone();
        assert_eq!((teams["a"].as_array().unwrap().len(), teams["b"].as_array().unwrap().len()), (10, 10));
    }

    #[test]
    fn the_game_opens_with_a_kickoff_that_sends_each_player_to_a_spot_in_their_own_half() {
        let players = members(12);
        let mut rng = StdRng::seed_from_u64(2);
        let positions = HashMap::new();
        let mut ctx = Ctx::new(START, &players, &positions, &mut rng);
        let game = create(&layout(), &mut ctx).unwrap();
        assert_eq!(ctx.events(), [(Audience::Everyone, json!({"type": "kickoff", "n": 1, "until": START + KICKOFF}))]);
        let view = game.view(Some(players[0].id), START);
        assert_eq!(
            view["field"],
            json!({"center": [10.0, 0.0, -5.0], "axis": "x", "halfLength": 20.0, "halfWidth": 12.0, "mouth": 6.0})
        );
        assert_eq!(view["ball"], json!({"position": [10.0, 0.0, -5.0], "velocity": [0.0, 0.0, 0.0], "at": START}));
        assert_eq!(view["score"], json!({"a": 0, "b": 0}));
        assert_eq!(view["phase"], "kickoff");
        assert_eq!(view["endsAt"], START + KICKOFF + PLAY, "four minutes of play after the kickoff");
        let field = Field::parse(&layout()).unwrap();
        let mut seen: Vec<[f64; 3]> = Vec::new();
        for (index, player) in players.iter().enumerate() {
            let kickoff = game.view(Some(player.id), START)["kickoff"].clone();
            assert_eq!((kickoff["n"].clone(), kickoff["until"].clone()), (json!(1), json!(START + KICKOFF)));
            let spot: [f64; 3] = serde_json::from_value(kickoff["spot"].clone()).unwrap();
            let [u, v] = field.local(spot);
            // A (even) defends the −x end and B the +x one; nobody stands within reach of the ball or off the field.
            let own = if index % 2 == 0 { u < -DRIBBLE_REACH } else { u > DRIBBLE_REACH };
            assert!(own && u.abs() < 20.0 && v.abs() < 12.0 && spot[1] == 0.0, "{index}: {spot:?}");
            assert!(seen.iter().all(|other| field.local(*other) != [u, v]), "one player to a spot");
            seen.push(spot);
        }
        assert_eq!(game.view(None, START)["kickoff"]["spot"], Value::Null, "someone watching goes nowhere");
    }

    #[test]
    fn the_ball_keeps_forty_percent_of_its_speed_each_second_and_comes_to_rest() {
        let mut game = Match::playing(2, &layout());
        game.place([0.0, 0.0], [10.0, 0.0]);
        game.run(1_000);
        let ball = game.ball();
        assert!(close(ball.speed(), 4.0), "{}", ball.speed());
        // It rolled as far as a speed falling to 40% every second carries it.
        let k = -KEEP_PER_SECOND.ln();
        assert!(close(ball.at[0], 10.0 * (1.0 - 0.4) / k) && ball.at[1] == 0.0, "{:?}", ball.at);
        game.run(1_000);
        assert!(close(game.ball().speed(), 1.6));
        // Below 0.1 m/s it stops (about five seconds in), short of where the decay alone would have taken it.
        game.run(3_200);
        assert_eq!(game.ball().velocity, [0.0, 0.0]);
        let rest = game.ball().at[0];
        assert!(rest > 10.0 && rest < 10.0 / k, "{rest}");
        let still = game.view(Some(0));
        game.run(2_000);
        assert_eq!(game.view(Some(0)), still, "a ball at rest sends nothing new");
    }

    #[test]
    fn the_ball_bounces_off_the_lines_keeping_sixty_percent_of_its_speed_across_them() {
        let mut game = Match::playing(2, &layout());
        let step = STEP as f64 / 1000.0;
        let keep = KEEP_PER_SECOND.powf(step);
        // Off a side line: back across it at 60%, along it only slowed by rolling.
        game.place([3.0, 11.99], [4.0, 10.0]);
        assert_eq!(game.game.roll(step), None);
        let Ball { at, velocity } = game.ball();
        assert!(at[1] < 12.0 && at[1] > 11.9, "{at:?}");
        assert!(close(velocity[1], -10.0 * keep * RESTITUTION) && close(velocity[0], 4.0 * keep), "{velocity:?}");
        // Off an end line beside the goal mouth, and off the other side and end at once in a corner.
        game.place([19.99, 3.5], [10.0, 0.0]);
        assert_eq!(game.game.roll(step), None);
        assert!(close(game.ball().velocity[0], -10.0 * keep * RESTITUTION) && game.ball().at[0] < 20.0);
        game.place([-19.99, -11.99], [-10.0, -10.0]);
        assert_eq!(game.game.roll(step), None);
        let Ball { at, velocity } = game.ball();
        assert!(at[0] > -20.0 && at[1] > -12.0, "{at:?}");
        assert!(close(velocity[0], 6.0 * keep) && close(velocity[1], 6.0 * keep), "{velocity:?}");
        // Over whole ticks, a ball sent at a side line comes back off it and stays on the field.
        game.place([0.0, 8.0], [0.0, 12.0]);
        game.run(500);
        let Ball { at, velocity } = game.ball();
        assert!(velocity[1] < 0.0 && at[1].abs() <= 12.0, "{at:?} {velocity:?}");
        assert_eq!(game.score(), json!({"a": 0, "b": 0}));
    }

    #[test]
    fn a_ball_crossing_an_end_line_inside_the_mouth_is_a_goal_and_outside_it_bounces() {
        let mut game = Match::playing(2, &layout());
        let step = STEP as f64 / 1000.0;
        // Into B's goal (the +x end) is A's goal, and into A's B's; just past a post it bounces back.
        game.place([19.99, 2.99], [10.0, 0.0]);
        assert_eq!(game.game.roll(step), Some(Team::A));
        game.place([-19.99, -2.99], [-10.0, 0.0]);
        assert_eq!(game.game.roll(step), Some(Team::B));
        game.place([19.99, -3.01], [10.0, 0.0]);
        assert_eq!(game.game.roll(step), None);
        assert!(game.ball().velocity[0] < 0.0);
        // Where the centre crosses the line counts: in from beside the post, and out past it.
        game.place([19.96, 3.02], [10.0, -10.0]);
        assert_eq!(game.game.roll(step), Some(Team::A));
        game.place([19.98, 2.99], [10.0, 10.0]);
        assert_eq!(game.game.roll(step), None);
        // Whole ticks: a goal scores once, then the ball waits on the centre spot.
        game.place([18.0, 0.0], [10.0, 0.0]);
        let events = game.run(500);
        assert_eq!(game.score(), json!({"a": 1, "b": 0}));
        assert_eq!(events[0], json!({"type": "goal", "team": "a", "scorer": null}));
        assert_eq!(events[1]["type"], "kickoff");
        assert_eq!(events.len(), 2);
        assert_eq!(game.ball(), Ball::default());
    }

    #[test]
    fn a_goal_brings_three_seconds_of_kickoff_and_the_match_clock_waits_for_it() {
        let mut game = Match::playing(4, &layout());
        let ends = START + KICKOFF + PLAY;
        assert_eq!(game.view(None)["endsAt"], ends);
        game.run(10_000);
        // Player 2 (A) kicks the ball from a metre behind it into B's goal.
        game.place([17.0, 0.0], [0.0, 0.0]);
        game.stand(2, 16.0, 0.0);
        game.act(2, KICK()).unwrap();
        let events = game.run(1_000);
        let scored = game.now - game.now % TICK;
        let until = game.view(None)["kickoff"]["until"].as_u64().unwrap();
        assert!(until > KICKED_OFF + 10_000 && until <= scored + KICKOFF, "{until}");
        assert_eq!(
            events,
            [
                json!({"type": "goal", "team": "a", "scorer": game.id(2)}),
                json!({"type": "kickoff", "n": 2, "until": until}),
            ]
        );
        let view = game.view(Some(1));
        assert_eq!(view["phase"], "kickoff");
        assert_eq!(view["ball"]["position"], json!([10.0, 0.0, -5.0]), "back on the centre spot");
        assert_eq!(view["ball"]["velocity"], json!([0.0, 0.0, 0.0]));
        assert_eq!(view["endsAt"], ends + KICKOFF, "the clock stopped for the kickoff");
        let spot: [f64; 3] = serde_json::from_value(view["kickoff"]["spot"].clone()).unwrap();
        assert!(spot[0] > 10.0, "B goes to its own half: {spot:?}");
        // Meanwhile nobody touches the ball: standing on it moves nothing, and a kick is refused.
        game.stand(1, 0.3, 0.0);
        let resting = game.view(Some(1));
        game.run(until - 1 - game.now);
        assert_eq!(game.view(Some(1)), resting);
        assert_eq!(game.act(1, KICK()), Err(KICKING_OFF));
        // Then play goes on, and the player beside the ball pushes it.
        game.run(TICK);
        assert_eq!(game.view(None)["phase"], "play");
        assert_eq!(game.view(None)["kickoff"], Value::Null);
        assert!(game.ball().speed() > 0.0 && game.game.last_touch == Some(game.id(1)));
    }

    #[test]
    fn a_player_within_reach_dribbles_the_ball_at_their_own_pace() {
        // A tick ends at most ten steps after a touch, each of which slows the ball a little.
        let slowest = |pushed: f64| pushed * KEEP_PER_SECOND.powf(STEP as f64 / 1000.0).powi(10) - 1e-9;
        // Standing beside it: the ball rolls off at 1 m/s, away from them.
        let mut game = Match::playing(2, &layout());
        game.stand(0, -0.5, 0.0);
        game.run(TICK);
        let Ball { at, velocity } = game.ball();
        assert!(at[0] > 0.0 && velocity[1] == 0.0, "{at:?}");
        assert!(velocity[0] > 0.99 && velocity[0] <= 1.0, "{velocity:?}");
        assert_eq!(game.game.last_touch, Some(game.id(0)));
        // Running at 5 m/s: pushed at 5 × 1.1 + 1 = 6.5 m/s the way they run into it.
        let mut game = Match::playing(2, &layout());
        let mut fastest: f64 = 0.0;
        for tick in 0..12 {
            game.stand(0, -3.0 + 0.25 * f64::from(tick), 0.0);
            game.run(TICK);
            fastest = fastest.max(game.ball().speed());
        }
        assert!(close(game.game.pace(game.id(0)), 5.0), "{}", game.game.pace(game.id(0)));
        assert!(fastest > slowest(6.5) && fastest <= 6.5, "{fastest}");
        assert!(game.ball().velocity[0] > 0.0 && game.ball().velocity[1] == 0.0);
        // A faster ball keeps its speed but turns away from whoever it runs into.
        let mut game = Match::playing(2, &layout());
        game.stand(1, 0.5, 0.6);
        game.place([0.0, 0.0], [8.0, 0.0]);
        game.run(TICK);
        let Ball { velocity, .. } = game.ball();
        let speed = velocity[0].hypot(velocity[1]);
        assert!(speed > slowest(8.0) && speed <= 8.0, "{speed}");
        assert!(velocity[0] < 0.0 && velocity[1] < 0.0, "{velocity:?}");
        // Sprinting at 20 m/s: the ball goes no faster than 18 m/s.
        let mut game = Match::playing(2, &layout());
        for tick in 0..4 {
            game.stand(0, -4.0 + f64::from(tick), 0.0);
            game.run(TICK);
        }
        game.stand(0, -0.5, 0.0);
        game.run(TICK);
        assert!(game.game.pace(game.id(0)) * 1.1 + 1.0 > MAX_SPEED);
        let speed = game.ball().speed();
        assert!(speed > slowest(MAX_SPEED) && speed <= MAX_SPEED, "{speed}");
    }

    #[test]
    fn the_nearest_player_on_the_field_touches_the_ball_and_those_off_it_do_not() {
        let mut game = Match::playing(3, &layout());
        // Two within reach: the nearer one pushes it, away from themselves.
        game.stand(0, -0.8, 0.0);
        game.stand(1, 0.0, 0.5);
        game.run(TICK);
        assert_eq!(game.game.last_touch, Some(game.id(1)));
        assert!(game.ball().velocity[1] < 0.0 && game.ball().velocity[0] == 0.0);
        // Just past the side line (more than half a metre out) a player is off the field: a ball on the line stays put.
        let mut game = Match::playing(3, &layout());
        game.place([5.0, 12.0], [0.0, 0.0]);
        game.stand(2, 5.0, 12.6);
        game.run(500);
        assert_eq!(game.ball(), Ball { at: [5.0, 12.0], velocity: [0.0, 0.0] });
        assert_eq!(game.act(2, KICK()), Err(OFF_FIELD));
        // On the line (within half a metre) they are on it.
        game.stand(2, 5.0, 12.45);
        game.run(TICK);
        assert!(game.ball().velocity[1] < 0.0);
    }

    #[test]
    fn a_kick_within_reach_sends_the_ball_at_twelve_and_then_waits_out_its_cooldown() {
        let mut game = Match::playing(3, &layout());
        game.run(200);
        let rolled = game.game.rolled;
        // Out of reach (1.41 m): refused, and nothing changes.
        game.stand(0, -1.0, -1.0);
        let before = game.view(Some(0));
        assert_eq!(game.act(0, KICK()), Err(TOO_FAR));
        assert_eq!(game.view(Some(0)), before);
        // A metre off: 12 m/s along player→ball, as the ball was at the last tick.
        game.stand(0, -0.6, -0.8);
        assert_eq!(game.act(0, KICK()), Ok(Vec::new()));
        assert_eq!(game.view(None)["ball"]["velocity"], json!([7.2, 0.0, 9.6]));
        assert_eq!(game.view(None)["ball"]["at"], rolled);
        assert_eq!(game.game.last_touch, Some(game.id(0)));
        // The same player again within 0.4 s is refused; someone else is not held up.
        game.now += KICK_COOLDOWN - 1;
        assert_eq!(game.act(0, KICK()), Err(COOLING));
        game.stand(2, 0.0, -1.2);
        assert_eq!(game.act(2, KICK()), Ok(Vec::new()));
        assert_eq!(game.view(None)["ball"]["velocity"], json!([0.0, 0.0, 12.0]));
        game.now += 1;
        game.stand(0, 0.0, 1.0);
        assert_eq!(game.act(0, KICK()), Ok(Vec::new()));
        assert_eq!(game.view(None)["ball"]["velocity"], json!([0.0, 0.0, -12.0]));
        // Not a kick, or nowhere to kick from.
        game.now += KICK_COOLDOWN;
        for action in [json!({"kick": false}), json!({"kick": "yes"}), json!({}), json!(null), json!("kick")] {
            assert_eq!(game.act(0, action.clone()), Err(BAD_ACTION), "{action}");
        }
        game.standing.remove(&game.id(0));
        assert_eq!(game.act(0, KICK()), Err(OFF_FIELD), "not in the live room");
        // Kicked off the ball's own spot, it goes the way the player attacks.
        let mut game = Match::playing(2, &layout());
        game.stand(1, 0.0, 0.0);
        game.act(1, KICK()).unwrap();
        assert_eq!(game.ball().velocity, [-KICK_SPEED, 0.0]);
    }

    #[test]
    fn the_match_ends_after_four_minutes_of_play_with_the_score_the_winner_and_the_scorers() {
        let mut game = Match::playing(4, &layout());
        // Goals by A (player 2, twice), B (player 1) and B's own goal (player 3, credited to nobody).
        for (toucher, end) in [(2, 1.0), (1, -1.0), (2, 1.0), (3, 1.0)] {
            game.place([18.0 * end, 0.0], [10.0 * end, 0.0]);
            game.game.last_touch = Some(game.id(toucher));
            assert_eq!(game.run(500)[0]["type"], "goal");
            game.run(KICKOFF);
        }
        assert_eq!(game.score(), json!({"a": 3, "b": 1}));
        let ends = game.view(None)["endsAt"].as_u64().unwrap();
        assert_eq!(ends, START + KICKOFF + PLAY + 4 * KICKOFF, "four kickoffs stopped the clock");
        game.run(ends - 1 - game.now);
        assert!(game.game.result().is_none());
        game.run(1);
        assert_eq!(
            game.game.result(),
            Some(json!({
                "score": {"a": 3, "b": 1},
                "winner": "a",
                "scorers": [
                    {"id": game.id(2), "name": "player2", "team": "a", "goals": 2},
                    {"id": game.id(1), "name": "player1", "team": "b", "goals": 1},
                ],
            }))
        );
        // Nothing moves once it is over.
        game.place([0.0, 0.0], [5.0, 0.0]);
        game.run(500);
        assert_eq!(game.ball().at, [0.0, 0.0]);
        // A match without goals is a draw.
        let mut draw = Match::playing(2, &layout());
        draw.run(PLAY);
        assert_eq!(draw.game.result(), Some(json!({"score": {"a": 0, "b": 0}, "winner": null, "scorers": []})));
    }

    #[test]
    fn a_goal_with_no_time_left_ends_the_match_without_a_kickoff() {
        let mut game = Match::playing(2, &layout());
        game.run(PLAY - 100);
        game.place([19.9, 0.0], [10.0, 0.0]);
        let events = game.tick_at(game.game.ends_at + 30);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1["type"], "goal");
        assert_eq!(game.game.result().unwrap()["winner"], "a");
    }

    #[test]
    fn a_team_left_without_players_ends_the_match() {
        let mut game = Match::playing(3, &layout());
        game.leave(2);
        assert!(game.game.result().is_none());
        assert_eq!(game.view(None)["teams"], json!({"a": [game.id(0)], "b": [game.id(1)]}));
        game.leave(1);
        assert_eq!(game.game.result(), Some(json!({"score": {"a": 0, "b": 0}, "winner": null, "scorers": []})));
    }

    #[test]
    fn views_change_only_while_the_ball_moves_or_the_match_does() {
        let mut game = Match::playing(2, &layout());
        let resting = game.view(Some(0));
        game.run(1_000);
        assert_eq!(game.view(Some(0)), resting);
        game.stand(0, -1.2, 0.0);
        game.act(0, KICK()).unwrap();
        let mut last = game.view(Some(0));
        for _ in 0..10 {
            game.run(TICK);
            let now = game.view(Some(0));
            assert_ne!(now, last, "a rolling ball is news every tick");
            assert_eq!(now["ball"]["at"], game.now);
            last = now;
        }
    }

    #[test]
    fn a_field_along_z_plays_the_same_way() {
        let along_z = json!({"center": [0.0, 1.5, 0.0], "axis": "z", "halfLength": 12, "halfWidth": 8});
        let mut game = Match::playing(2, &along_z);
        // B stands toward +z of the ball and kicks it toward A's goal at z = −12.
        game.place([-9.0, 0.0], [0.0, 0.0]);
        game.stand(1, -8.0, 0.0);
        assert_eq!(game.standing[&game.id(1)], [0.0, 1.5, -8.0]);
        game.act(1, KICK()).unwrap();
        assert_eq!(game.view(None)["ball"]["velocity"], json!([0.0, 0.0, -12.0]));
        assert_eq!(game.view(None)["ball"]["position"], json!([0.0, 1.5, -9.0]));
        let events = game.run(1_000);
        assert_eq!(events[0], json!({"type": "goal", "team": "b", "scorer": game.id(1)}));
        assert_eq!(game.score(), json!({"a": 0, "b": 1}));
        let spot: [f64; 3] = serde_json::from_value(game.view(Some(0))["kickoff"]["spot"].clone()).unwrap();
        assert!(spot[2] < 0.0 && spot[1] == 1.5, "A's half is toward −z: {spot:?}");
    }
}
