//! 임포스터's bots: players the game plays itself, so a table fills up with fewer people (one, even). A bot walks the
//! island's open spots (see `walk.rs`). Between meetings the crew report a body they see, go to fix a sabotage and do
//! their tasks, the dead crew too; an impostor hunts someone alone, sabotages now and then, and pretends to work. In a
//! meeting a bot says what it saw, and votes for whom it saw kill, or along with what was said, or skips.

use rand::{Rng, rngs::StdRng};
use std::collections::VecDeque;
use uuid::Uuid;

use super::{
    Ctx, Impostor, KILL_REACH, MAX_TEXT, Millis, Player, REPORT_REACH, Role, Stage, TASK_REACH, Trouble, pick_many,
    walk::Route, within,
};
use crate::games::distance_xz;

/// How far bots see a body or a kill, in meters; less with the lights out.
const SIGHT: f64 = 7.0;
const SIGHT_DARK: f64 = 3.0;
/// How far a bot impostor goes after someone alone.
const HUNT: f64 = 10.0;
/// How often a hunting bot looks again where its prey went.
const CHASE: Millis = 700;
/// How long a bot works at a task, and at fixing the lights or the comms.
const WORK: std::ops::Range<Millis> = 2_500..5_000;
const MEND: Millis = 2_000;
/// The chance, each tick, that a bot impostor sabotages once it may: about once in twenty seconds at ten ticks.
const SABOTAGE_CHANCE: f64 = 0.005;
/// The chance a crew bot that saw nothing votes along with the name said most.
const FOLLOW: f64 = 0.6;

const NAMES: [&str; 16] = [
    "도토리",
    "솔방울",
    "감자",
    "고구마",
    "모과",
    "단풍",
    "버섯",
    "조약돌",
    "다람쥐",
    "고슴도치",
    "무화과",
    "호두",
    "밤톨",
    "보리",
    "쑥떡",
    "콩떡",
];
const IDLE_TALK: [&str; 4] =
    ["저는 작업하고 있었어요.", "아무것도 못 봤어요.", "증거가 없으면 건너뛰어요.", "누가 수상한지 모르겠어요."];

/// What a bot is about now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Plan {
    /// Stands until then.
    Rest(Millis),
    /// Walks to do task `n` of its list.
    Task(usize),
    /// Works at task `n` of its list until then.
    Work(usize, Millis),
    /// Walks to body `n` to report it.
    Body(u32),
    /// Walks to the sabotage's panel `n`, or holds it (the reactor).
    Fix(usize),
    /// Works at the sabotage's panel `n` until then.
    Mend(usize, Millis),
    /// Goes after someone to kill them.
    Hunt(Uuid),
    /// Walks somewhere for nothing.
    Roam,
}

pub(super) struct Bot {
    /// Which colour the pages draw it in.
    pub(super) color: usize,
    pub(super) route: Route,
    pub(super) plan: Plan,
    /// The kill it saw since the last meeting: who killed whom.
    pub(super) saw: Option<(Uuid, Uuid)>,
    /// What it says in this meeting, and when.
    lines: VecDeque<(Millis, String)>,
    /// When it votes in this meeting.
    ballot_at: Option<Millis>,
    /// Whom it blamed in this meeting (an impostor's pick), to vote for.
    accused: Option<Uuid>,
    /// When a hunting bot looks again where its prey went.
    chase_at: Millis,
}

impl Bot {
    pub(super) fn new(color: usize, route: Route, now: Millis) -> Self {
        // A beat apart, so the bots do not all set off at once.
        let rest = Plan::Rest(now + 800 + color as Millis * 250);
        Self {
            color,
            route,
            plan: rest,
            saw: None,
            lines: VecDeque::new(),
            ballot_at: None,
            accused: None,
            chase_at: 0,
        }
    }

    /// Killed at `at`: the ghost rises there.
    pub(super) fn died(&mut self, at: [f64; 3], now: Millis) {
        self.route = Route::still(at, now);
        self.plan = Plan::Rest(now + 2_000);
        self.saw = None;
    }
}

/// `count` bot names, none of them one a person in the game goes by.
pub(super) fn names(rng: &mut StdRng, count: usize, taken: &[&str]) -> Vec<String> {
    let free: Vec<&str> = NAMES.into_iter().filter(|name| !taken.contains(name)).collect();
    let mut names: Vec<String> = pick_many(rng, &free, count).into_iter().map(str::to_owned).collect();
    let mut extra = 1;
    while names.len() < count {
        let name = format!("봇 {extra}");
        if !taken.contains(&name.as_str()) {
            names.push(name);
        }
        extra += 1;
    }
    names
}

/// At most [`MAX_TEXT`] characters, as a person's line.
fn line(text: String) -> String {
    if text.chars().count() <= MAX_TEXT { text } else { text.chars().take(MAX_TEXT).collect() }
}

impl Impostor {
    fn bot(&self, index: usize) -> &Bot {
        self.players[index].bot.as_ref().expect("a bot")
    }

    fn bot_mut(&mut self, index: usize) -> &mut Bot {
        self.players[index].bot.as_mut().expect("a bot")
    }

    fn plan(&self, index: usize) -> Plan {
        self.bot(index).plan
    }

    fn set_plan(&mut self, index: usize, plan: Plan) {
        self.bot_mut(index).plan = plan;
    }

    /// Sets bot `index` walking from where it is to `to` for `plan`: along the open spots, or (a ghost) straight.
    fn go(&mut self, index: usize, to: [f64; 3], plan: Plan, now: Millis) {
        let from = self.bot(index).route.at(now);
        let points = if self.players[index].alive { self.walk.way(from, to) } else { vec![from, to] };
        let bot = self.bot_mut(index);
        bot.route = Route::along(points, now);
        bot.plan = plan;
    }

    /// Stops bot `index` where it is.
    fn halt(&mut self, index: usize, now: Millis) {
        let bot = self.bot_mut(index);
        bot.route = Route::still(bot.route.at(now), now);
    }

    fn arrived(&self, index: usize, now: Millis) -> bool {
        now >= self.bot(index).route.arrive()
    }

    /// How far a bot sees now.
    fn sight(&self) -> f64 {
        if self.broken(Trouble::Lights) { SIGHT_DARK } else { SIGHT }
    }

    fn living_crew_bot(&self, index: usize) -> bool {
        let player = &self.players[index];
        player.bot.is_some() && player.living() && player.role == Role::Crew
    }

    /// Moves every bot on between meetings. Stops once one of them has opened a meeting or ended the game.
    pub(super) fn roam_bots(&mut self, ctx: &mut Ctx) {
        for index in 0..self.players.len() {
            if !self.roaming() {
                return;
            }
            let player = &self.players[index];
            if player.bot.is_none() || player.left {
                continue;
            }
            match (player.role, player.alive) {
                (Role::Crew, true) => self.crew_bot(index, ctx),
                (Role::Crew, false) => self.chores(index, ctx, true),
                (Role::Impostor, true) => self.impostor_bot(index, ctx),
                (Role::Impostor, false) => self.maybe_sabotage(ctx),
            }
        }
    }

    /// A living crew bot: a body in sight first, then a sabotage, then its tasks.
    fn crew_bot(&mut self, index: usize, ctx: &mut Ctx) {
        let now = ctx.now();
        let at = self.bot(index).route.at(now);
        let sight = self.sight();
        let seen = self
            .bodies
            .iter()
            .enumerate()
            .filter(|(_, body)| !body.reported)
            .map(|(found, body)| (found, body.id, body.position, distance_xz(body.position, at)))
            .filter(|(.., distance)| *distance <= sight)
            .min_by(|a, b| a.3.total_cmp(&b.3));
        if let Some((found, id, position, _)) = seen {
            if within(position, at, REPORT_REACH) {
                self.halt(index, now);
                self.report_body(index, found, ctx);
            } else if self.plan(index) != Plan::Body(id) {
                self.go(index, position, Plan::Body(id), now);
            }
            return;
        }
        if self.mend(index, at, ctx) {
            return;
        }
        self.chores(index, ctx, true);
    }

    /// A crew bot going to fix the sabotage: the reactor's panels, one bot each (the nearer of two going to one); the
    /// lights and the comms, the living crew bot nearest their panel. False when this bot has no part in it.
    fn mend(&mut self, index: usize, at: [f64; 3], ctx: &mut Ctx) -> bool {
        let now = ctx.now();
        let Some((kind, held)) = self.sabotage.as_ref().map(|sabotage| (sabotage.kind, sabotage.held)) else {
            return false;
        };
        let spots = self.trouble_spots();
        let place = |panel: usize| self.stations[spots[panel]];
        let id = self.players[index].id;
        if kind == Trouble::Reactor {
            if held.contains(&Some(id)) {
                return true;
            }
            // A panel is taken when someone holds it, or another crew bot nearer to it is on its way.
            let taken = |panel: usize| {
                held[panel].is_some()
                    || (0..self.players.len()).any(|other| {
                        other != index
                            && self.living_crew_bot(other)
                            && self.plan(other) == Plan::Fix(panel)
                            && distance_xz(self.bot(other).route.at(now), place(panel)) < distance_xz(at, place(panel))
                    })
            };
            let Some(panel) = (0..2)
                .filter(|panel| !taken(*panel))
                .min_by(|a, b| distance_xz(place(*a), at).total_cmp(&distance_xz(place(*b), at)))
            else {
                return false;
            };
            if within(place(panel), at, TASK_REACH) {
                self.halt(index, now);
                self.set_plan(index, Plan::Fix(panel));
                self.fix_at(index, kind, panel, ctx);
            } else if self.plan(index) != Plan::Fix(panel) {
                self.go(index, place(panel), Plan::Fix(panel), now);
            }
            return true;
        }
        let nearest = (0..self.players.len()).filter(|other| self.living_crew_bot(*other)).min_by(|a, b| {
            let far = |bot: &usize| distance_xz(self.bot(*bot).route.at(now), place(0));
            far(a).total_cmp(&far(b))
        });
        if nearest != Some(index) {
            return false;
        }
        match self.plan(index) {
            Plan::Mend(_, until) if now >= until => {
                self.fix_at(index, kind, 0, ctx);
                self.set_plan(index, Plan::Rest(now + 500));
            }
            Plan::Mend(..) => {}
            _ if within(place(0), at, TASK_REACH) => {
                self.halt(index, now);
                self.set_plan(index, Plan::Mend(0, now + MEND));
            }
            Plan::Fix(0) if !self.arrived(index, now) => {}
            _ => self.go(index, place(0), Plan::Fix(0), now),
        }
        true
    }

    /// A bot's routine: walk to a task, work at it (done for real for the crew, only seemingly for an impostor), rest
    /// a little, and when every task is done wander between the places of the game.
    fn chores(&mut self, index: usize, ctx: &mut Ctx, real: bool) {
        let now = ctx.now();
        match self.plan(index) {
            Plan::Work(task, until) => {
                if now >= until {
                    if real && let Some(task) = self.players[index].tasks.get_mut(task) {
                        task.done = true;
                    }
                    let rest = now + ctx.rng().gen_range(400..1_500);
                    self.set_plan(index, Plan::Rest(rest));
                    if real {
                        self.judge();
                    }
                }
                return;
            }
            Plan::Task(task) => {
                if self.arrived(index, now) {
                    let until = now + ctx.rng().gen_range(WORK);
                    self.set_plan(index, Plan::Work(task, until));
                }
                return;
            }
            Plan::Roam => {
                if self.arrived(index, now) {
                    let rest = now + ctx.rng().gen_range(1_000..4_000);
                    self.set_plan(index, Plan::Rest(rest));
                }
                return;
            }
            Plan::Rest(until) if now < until => return,
            // Rested, or what it was about is over (the body reported, the sabotage fixed, the prey gone).
            _ => {}
        }
        let open: Vec<usize> =
            self.players[index].tasks.iter().enumerate().filter(|(_, task)| !task.done).map(|(task, _)| task).collect();
        if let Some(&task) = pick_many(ctx.rng(), &open, 1).first() {
            let place = self.stations[self.players[index].tasks[task].station];
            self.go(index, place, Plan::Task(task), now);
        } else {
            let mut places = self.stations.clone();
            places.push(self.table);
            let place = pick_many(ctx.rng(), &places, 1)[0];
            self.go(index, place, Plan::Roam, now);
        }
    }

    /// The crew member alone (no other crew within sight of them) nearest a bot impostor at `at`, within its hunt,
    /// and where they stand.
    fn prey(&self, at: [f64; 3], ctx: &Ctx) -> Option<(usize, [f64; 3])> {
        let sight = self.sight();
        let crew: Vec<(usize, [f64; 3])> = (0..self.players.len())
            .filter(|index| self.players[*index].living() && self.players[*index].role == Role::Crew)
            .filter_map(|index| Some((index, self.position(index, ctx)?)))
            .collect();
        crew.iter()
            .filter(|(_, place)| within(*place, at, HUNT))
            .filter(|(index, place)| !crew.iter().any(|(other, near)| other != index && within(*near, *place, sight)))
            .min_by(|a, b| distance_xz(a.1, at).total_cmp(&distance_xz(b.1, at)))
            .copied()
    }

    /// A living bot impostor: kills someone alone once it may, or sabotages now and then, or pretends to work.
    fn impostor_bot(&mut self, index: usize, ctx: &mut Ctx) {
        let now = ctx.now();
        let at = self.bot(index).route.at(now);
        if now >= self.players[index].kill_at {
            if let Some((victim, place)) = self.prey(at, ctx) {
                if within(place, at, KILL_REACH) {
                    self.halt(index, now);
                    self.kill_now(index, victim, place, ctx);
                    // Off to the far side of the island.
                    let away = self
                        .stations
                        .iter()
                        .copied()
                        .max_by(|a, b| distance_xz(*a, at).total_cmp(&distance_xz(*b, at)));
                    if let Some(away) = away.filter(|_| self.roaming()) {
                        self.go(index, away, Plan::Roam, now);
                    }
                    return;
                }
                let prey = self.players[victim].id;
                if self.plan(index) != Plan::Hunt(prey) || now >= self.bot(index).chase_at {
                    self.go(index, place, Plan::Hunt(prey), now);
                    self.bot_mut(index).chase_at = now + CHASE;
                }
                return;
            }
            if matches!(self.plan(index), Plan::Hunt(_)) {
                self.halt(index, now);
                self.set_plan(index, Plan::Rest(now));
            }
        }
        self.maybe_sabotage(ctx);
        if self.roaming() {
            self.chores(index, ctx, false);
        }
    }

    /// Now and then, once impostors may, a bot impostor breaks something: the lights most often, the reactor least.
    fn maybe_sabotage(&mut self, ctx: &mut Ctx) {
        if self.sabotage.is_some() || ctx.now() < self.sabotage_at || !ctx.rng().gen_bool(SABOTAGE_CHANCE) {
            return;
        }
        let kind = match ctx.rng().gen_range(0..10) {
            0..=3 => Trouble::Lights,
            4..=6 => Trouble::Comms,
            _ => Trouble::Reactor,
        };
        self.break_down(kind, ctx);
    }

    /// Who saw `killer` kill `victim` at `at`: the living crew bots within sight of it.
    pub(super) fn witness(&mut self, killer: Uuid, victim: Uuid, at: [f64; 3], ctx: &Ctx) {
        let sight = self.sight();
        for index in 0..self.players.len() {
            if self.living_crew_bot(index) && within(self.bot(index).route.at(ctx.now()), at, sight) {
                self.bot_mut(index).saw = Some((killer, victim));
            }
        }
    }

    /// A meeting has opened: the living bots sit in their seats and settle what they will say in the talk.
    pub(super) fn seat_bots(&mut self, ctx: &mut Ctx) {
        let now = ctx.now();
        let Some(meeting) = &self.meeting else { return };
        let seats = meeting.seats.clone();
        let (until, caller, body) = (meeting.discuss_until, meeting.caller, meeting.body.clone());
        let name = |players: &[Player], id: Uuid| {
            players.iter().find(|player| player.id == id).map(|player| player.name.clone())
        };
        for index in 0..self.players.len() {
            let player = &self.players[index];
            if player.bot.is_none() || !player.living() {
                continue;
            }
            let id = player.id;
            let mut said = Vec::new();
            let mut accused = None;
            if id == caller
                && let Some((_, victim)) = &body
            {
                said.push(format!("{victim}님이 쓰러져 있었어요."));
            }
            let saw = self.bot(index).saw;
            if let Some((killer, victim)) = saw
                && self.present(killer).is_some_and(Player::living)
                && let (Some(killer), Some(victim)) = (name(&self.players, killer), name(&self.players, victim))
            {
                said.push(format!("{killer}님이 {victim}님을 처치하는 걸 봤어요!"));
            } else if self.players[index].role == Role::Impostor && ctx.rng().gen_bool(0.4) {
                let crew: Vec<usize> = (0..self.players.len())
                    .filter(|other| self.players[*other].living() && self.players[*other].role == Role::Crew)
                    .collect();
                if let Some(&blamed) = pick_many(ctx.rng(), &crew, 1).first() {
                    said.push(format!("{}님이 수상해요.", self.players[blamed].name));
                    accused = Some(self.players[blamed].id);
                }
            } else if said.is_empty() && ctx.rng().gen_bool(0.35) {
                let filler = IDLE_TALK[ctx.rng().gen_range(0..IDLE_TALK.len())];
                said.push(filler.to_owned());
            }
            let window = until.saturating_sub(now).saturating_sub(500).max(1_500);
            let mut lines: Vec<(Millis, String)> =
                said.into_iter().map(|text| (now + ctx.rng().gen_range(1_000..=window), line(text))).collect();
            lines.sort_by_key(|(at, _)| *at);
            let bot = self.bot_mut(index);
            bot.route = Route::still(
                seats.iter().find(|(seated, _)| *seated == id).map_or(bot.route.at(now), |(_, seat)| *seat),
                now,
            );
            bot.plan = Plan::Rest(Millis::MAX);
            bot.lines = lines.into();
            bot.ballot_at = None;
            bot.accused = accused;
        }
    }

    /// The vote has opened: each living bot votes a few seconds in.
    pub(super) fn ballot_bots(&mut self, ctx: &mut Ctx) {
        let now = ctx.now();
        for index in 0..self.players.len() {
            if self.players[index].bot.is_some() && self.players[index].living() {
                let at = now + ctx.rng().gen_range(1_500..6_000);
                self.bot_mut(index).ballot_at = Some(at);
            }
        }
    }

    /// The bots' lines and votes that are due. Stops once the last vote has ended the meeting.
    pub(super) fn talk_bots(&mut self, ctx: &mut Ctx) {
        let now = ctx.now();
        for index in 0..self.players.len() {
            let player = &self.players[index];
            if player.bot.is_none() || !player.living() {
                continue;
            }
            let id = player.id;
            let Some(meeting) = &self.meeting else { return };
            let voting = meeting.stage == Stage::Vote && !meeting.votes.iter().any(|(voter, _)| *voter == id);
            while self.bot(index).lines.front().is_some_and(|(at, _)| *at <= now) {
                if let Some((_, text)) = self.bot_mut(index).lines.pop_front() {
                    self.add_line(index, text);
                }
            }
            let due = self.bot(index).ballot_at.is_some_and(|at| at <= now);
            if voting && due {
                let target = self.ballot(index, ctx.rng());
                self.bot_mut(index).ballot_at = None;
                if let Some(meeting) = self.meeting.as_mut() {
                    meeting.votes.push((id, target));
                }
                if self.all_voted() {
                    self.close_meeting(ctx);
                    return;
                }
            }
        }
    }

    /// Whom bot `index` votes for: a crew bot for whom it saw kill, or (most times) the name said most in this
    /// meeting, else it skips; an impostor for whom it blamed, or along with the name said most if that is crew.
    fn ballot(&self, index: usize, rng: &mut StdRng) -> Option<Uuid> {
        let me = &self.players[index];
        let living = |id: Uuid| id != me.id && self.present(id).is_some_and(Player::living);
        let bot = self.bot(index);
        let named = self.most_named(me.id);
        match me.role {
            Role::Crew => match bot.saw {
                Some((killer, _)) if living(killer) => Some(killer),
                _ => named.filter(|_| rng.gen_bool(FOLLOW)),
            },
            Role::Impostor => bot
                .accused
                .filter(|id| living(*id))
                .or_else(|| named.filter(|id| self.present(*id).is_some_and(|player| player.role == Role::Crew))),
        }
    }

    /// The living player (other than `except`) whose name this meeting's lines carry most, when one stands out.
    fn most_named(&self, except: Uuid) -> Option<Uuid> {
        let counts: Vec<(Uuid, usize)> = self
            .players
            .iter()
            .filter(|player| player.living() && player.id != except)
            .map(|player| (player.id, self.talk.iter().filter(|line| line.text.contains(&player.name)).count()))
            .filter(|(_, count)| *count > 0)
            .collect();
        let top = counts.iter().map(|(_, count)| *count).max()?;
        match counts.iter().filter(|(_, count)| *count == top).collect::<Vec<_>>().as_slice() {
            [(id, _)] => Some(*id),
            _ => None,
        }
    }

    /// A meeting has ended: the bots stand up and, after a moment, carry on.
    pub(super) fn release_bots(&mut self, ctx: &mut Ctx) {
        let now = ctx.now();
        for index in 0..self.players.len() {
            if self.players[index].bot.is_none() {
                continue;
            }
            let rest = now + ctx.rng().gen_range(500..2_000);
            self.halt(index, now);
            let bot = self.bot_mut(index);
            bot.plan = Plan::Rest(rest);
            bot.saw = None;
            bot.lines.clear();
            bot.ballot_at = None;
            bot.accused = None;
        }
    }
}
