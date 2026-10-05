//! 카트, a kart race in the sky over the host's island, after KartRider's item mode. People and bots, eight karts at
//! most, race laps of a fixed track the pages build there; the server keeps the laps, the order and the items.
//!
//! - Gates: the track's middle line as points in driving order, the first being the start/finish line. A kart passes
//!   its next gate on coming within `radius` of it on the ground (and near its height, so the island under the track
//!   does not count), measured along the way it went since the last tick. Gates count only in order: passing the first
//!   after the last finishes a lap, and the last lap finishes the race. Nothing counts before the start.
//! - Start: a three-second countdown (`startsAt`), everyone on a slot of the grid behind the line (`spawn`).
//! - End: 3 s after every person has finished, 30 s after the first kart finishes, or six minutes after the start. Karts
//!   still racing are ranked by laps, then gates, then how near their next gate they are.
//! - Items: driving over a ready item box (within 2 m) with an empty slot takes a booster (60 %) or a water bubble
//!   (40 %), and the box comes back 4 s later. `item` uses it: a booster speeds up the kart for 2 s (its page drives
//!   it faster), a bubble traps the kart just ahead in the order for 1.5 s (its page stops it); with nobody racing just
//!   ahead it is wasted.
//! - Bots (see `bots.rs`) drive lanes of their own at a pace of their own; they take the boxes they pass and use items
//!   a moment later (a bubble once someone is ahead).
//!
//! Layout (from the host's page): `{"checkpoints": [[x, y, z]; 8..=64], "radius": 2..=15, "grid": [[x, y, z]; 8],
//! "boxes": [[x, y, z]; 0..=24], "boosts": [[x, y, z]; 0..=24], "laps": 1..=5 (3), "bots": 0..=7 (0)}`. Boost pads
//! work on the pages alone; the view lists them for drawing. People and bots together are eight at most.
//!
//! Action: `{"do": "item"}`.
//!
//! View: `phase` (`countdown` | `race` | `ended`), `startsAt`, `endsAt` (when the race closes: see End), `laps`, `gates` (how many), `racers` (in the live order: `[{id, name, bot,
//! color, lap, next, finishedAt, rank, boostUntil, trappedUntil}]`, `lap` being the laps done and `finishedAt` ms after
//! the start), `me` (`{lap, next, item}` to a racer), `spawn` (the viewer's grid slot), `boxes` (`[{id, position,
//! ready}]`), `boosts`, `bots` (`[{id, color, route: {points, departAt, speed}}]`).
//!
//! Events: `{"type": "boost", "until"}` to whoever used a booster, `{"type": "trapped", "until"}` to whom a bubble
//! caught.
//!
//! Result: `{"ranking": [{id, name, bot, rank, finishedAt, laps}]}`.

mod bots;
#[cfg(test)]
mod tests;

use rand::{Rng, rngs::StdRng};
use serde_json::{Value, json};
use std::{cmp::Ordering, collections::HashMap};
use uuid::Uuid;

use super::{BAD_ACTION, BAD_LAYOUT, Ctx, Game, GameError, Kind, Millis, distance_xz, layout_points, pick_many};
use bots::{Bot, Lane};

pub(crate) const KIND: Kind = Kind::new("kart", 1, MAX_RACERS, create).ticking(20);

/// People and bots together.
const MAX_RACERS: usize = 8;
const MAX_BOTS: u64 = 7;
const MIN_GATES: usize = 8;
const MAX_GATES: usize = 64;
const GRID: usize = 8;
const MAX_BOXES: usize = 24;
const MAX_BOOSTS: usize = 24;
const RADIUS: std::ops::RangeInclusive<f64> = 2.0..=15.0;
const MAX_LAPS: u64 = 5;
const LAPS: u64 = 3;
/// Gates nearer than this to the one before them are not a loop.
const SAME_GATE: f64 = 1.0;
const COUNTDOWN: Millis = 3_000;
/// How long the others have once the first kart finishes.
const FINISH_WINDOW: Millis = 30_000;
/// The longest a race runs from its start.
const CAP: Millis = 6 * 60_000;
/// How long the race stays on once every person has finished: their finish and the order, on their pages.
const SETTLE: Millis = 3_000;
/// How near (on the ground) a kart takes an item box.
const PICKUP: f64 = 2.0;
const RESPAWN: Millis = 4_000;
const BOOST: Millis = 2_000;
const TRAP: Millis = 1_500;
const BOOSTER_CHANCE: f64 = 0.6;
/// How far above or below a gate or a box a kart may be and still pass it: the island under the track does not count.
const HEIGHT: f64 = 6.0;
/// A move longer than this between two ticks is a teleport, not driving: only where it lands counts.
const JUMP: f64 = 40.0;
/// How much nearer its next gate a kart must be to pass another on the same gate, in meters.
const NECK: f64 = 2.0;
/// How long a bot holding a bubble with nobody ahead waits before it looks again.
const HOLD: Millis = 2_000;

const MANY_RACERS: GameError = GameError::new("many_racers", "사람과 봇을 합쳐 8명까지예요.");
const NOT_NOW: GameError = GameError::new("not_now", "지금은 할 수 없어요.");
const NO_ITEM: GameError = GameError::new("no_item", "가진 아이템이 없어요.");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Item {
    Booster,
    Bubble,
}

impl Item {
    fn name(self) -> &'static str {
        match self {
            Self::Booster => "booster",
            Self::Bubble => "bubble",
        }
    }

    fn roll(rng: &mut StdRng) -> Self {
        if rng.gen_bool(BOOSTER_CHANCE) { Self::Booster } else { Self::Bubble }
    }
}

struct ItemBox {
    position: [f64; 3],
    /// When it is there to take again; it is now once this has passed.
    ready_at: Millis,
}

struct Racer {
    id: Uuid,
    name: String,
    /// Which colour the pages draw its kart in.
    color: usize,
    /// Where it starts, on the grid.
    slot: [f64; 3],
    /// Some for a bot, which the game drives itself.
    bot: Option<Bot>,
    /// Laps done.
    lap: u32,
    /// The gate it passes next.
    next: usize,
    /// When it finished, in ms after the start.
    finished: Option<Millis>,
    item: Option<Item>,
    boost_until: Millis,
    trapped_until: Millis,
    /// Gone from the race: out of the order, the views and the result.
    left: bool,
}

impl Racer {
    fn racing(&self) -> bool {
        !self.left && self.finished.is_none()
    }
}

pub(crate) struct Kart {
    gates: Vec<[f64; 3]>,
    radius: f64,
    boxes: Vec<ItemBox>,
    boosts: Vec<[f64; 3]>,
    laps: u32,
    starts_at: Millis,
    /// When the first kart finished.
    first_finish: Option<Millis>,
    /// When the last person still in finished: the race closes [`SETTLE`] later.
    settled: Option<Millis>,
    /// People in the order they joined, then the bots.
    racers: Vec<Racer>,
    /// Where each racer stood at the last tick, the countdown included: what the order measures.
    seen: HashMap<Uuid, [f64; 3]>,
    /// Where each stood at the last tick of the race: where the way it went since then starts.
    last: HashMap<Uuid, [f64; 3]>,
    /// The racers still in, best first, as of the last tick (or the start).
    order: Vec<Uuid>,
    over: bool,
}

fn create(layout: &Value, ctx: &mut Ctx) -> Result<Box<dyn Game>, GameError> {
    Ok(Box::new(Kart::new(layout, ctx)?))
}

/// `layout[field]` when it is there: a list of `0..=max` points; none when it is missing or null.
fn optional_points(layout: &Value, field: &str, max: usize) -> Result<Vec<[f64; 3]>, GameError> {
    match layout.get(field) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(_) => layout_points(layout, field, 0, max),
    }
}

/// `layout[field]`: a whole number from `min` to `max`, or `default` when it is missing or null.
fn count(layout: &Value, field: &str, min: u64, max: u64, default: u64) -> Result<u64, GameError> {
    match layout.get(field) {
        None | Some(Value::Null) => Ok(default),
        Some(value) => value.as_u64().filter(|value| (min..=max).contains(value)).ok_or(BAD_LAYOUT),
    }
}

/// How near `point` comes to the segment from `from` to `to`, on the ground.
fn reach(point: [f64; 3], from: [f64; 3], to: [f64; 3]) -> f64 {
    let (dx, dz) = (to[0] - from[0], to[2] - from[2]);
    let step = dx * dx + dz * dz;
    let share =
        if step > 0.0 { (((point[0] - from[0]) * dx + (point[2] - from[2]) * dz) / step).clamp(0.0, 1.0) } else { 0.0 };
    (point[0] - (from[0] + dx * share)).hypot(point[2] - (from[2] + dz * share))
}

/// Whether a kart that went from `from` (where it was at the last tick of the race, if it was) to `to` came within
/// `radius` of `mark` on the ground, near its height.
fn passes(mark: [f64; 3], from: Option<[f64; 3]>, to: [f64; 3], radius: f64) -> bool {
    let level = |at: [f64; 3]| (at[1] - mark[1]).abs() <= HEIGHT;
    if !level(to) {
        return false;
    }
    let driven = from.filter(|from| level(*from) && distance_xz(*from, to).hypot(from[1] - to[1]) <= JUMP);
    reach(mark, driven.unwrap_or(to), to) <= radius
}

/// A bot's id: random bytes, from the session's random numbers.
fn bot_id(rng: &mut StdRng) -> Uuid {
    uuid::Builder::from_random_bytes(rng.r#gen()).into_uuid()
}

impl Kart {
    fn new(layout: &Value, ctx: &mut Ctx) -> Result<Self, GameError> {
        // The host's page computed this: check the shape, the counts and the coordinates before using it.
        let gates = layout_points(layout, "checkpoints", MIN_GATES, MAX_GATES)?;
        let count_gates = gates.len();
        if (0..count_gates).any(|index| distance_xz(gates[index], gates[(index + 1) % count_gates]) < SAME_GATE) {
            return Err(BAD_LAYOUT);
        }
        let radius = layout.get("radius").and_then(Value::as_f64).filter(|radius| RADIUS.contains(radius));
        let radius = radius.ok_or(BAD_LAYOUT)?;
        let grid = layout_points(layout, "grid", GRID, GRID)?;
        let boxes = optional_points(layout, "boxes", MAX_BOXES)?;
        let boosts = optional_points(layout, "boosts", MAX_BOOSTS)?;
        let laps = count(layout, "laps", 1, MAX_LAPS, LAPS)? as u32;
        let bots = count(layout, "bots", 0, MAX_BOTS, 0)? as usize;
        let people = ctx.players();
        if people.len() + bots > MAX_RACERS {
            return Err(MANY_RACERS);
        }

        let now = ctx.now();
        let starts_at = now + COUNTDOWN;
        let total = people.len() + bots;
        // The grid's slots, dealt at random.
        let slots: Vec<usize> = pick_many(ctx.rng(), &(0..GRID).collect::<Vec<_>>(), total);
        let taken: Vec<&str> = people.iter().map(|member| member.name.as_str()).collect();
        let names = bots::names(ctx.rng(), bots, &taken);
        let mut racers: Vec<Racer> = Vec::with_capacity(total);
        let entrants = people.iter().map(|member| (member.id, member.name.clone(), false));
        let robots: Vec<(Uuid, String, bool)> = names.into_iter().map(|name| (bot_id(ctx.rng()), name, true)).collect();
        for (index, (id, name, bot)) in entrants.chain(robots).enumerate() {
            let slot = grid[slots[index]];
            let bot = bot.then(|| {
                let lane = Lane::new(&gates, bots::lane_offset(&gates, radius, slot));
                Bot::new(slot, lane, ctx.rng().gen_range(bots::PACE), starts_at)
            });
            racers.push(Racer {
                id,
                name,
                color: index,
                slot,
                bot,
                lap: 0,
                next: 1,
                finished: None,
                item: None,
                boost_until: 0,
                trapped_until: 0,
                left: false,
            });
        }
        let mut kart = Self {
            gates,
            radius,
            boxes: boxes.into_iter().map(|position| ItemBox { position, ready_at: 0 }).collect(),
            boosts,
            laps,
            starts_at,
            first_finish: None,
            settled: None,
            racers,
            seen: HashMap::new(),
            last: HashMap::new(),
            order: Vec::new(),
            over: false,
        };
        // Before anyone has moved, the grid is the order.
        for racer in &kart.racers {
            kart.seen.insert(racer.id, racer.slot);
        }
        kart.rank();
        Ok(kart)
    }

    fn index(&self, id: Uuid) -> Option<usize> {
        self.racers.iter().position(|racer| racer.id == id && !racer.left)
    }

    /// When the race closes: six minutes after the start, or sooner once a kart has finished, and a moment after every
    /// person has.
    fn ends_at(&self) -> Millis {
        let cap = self.starts_at + CAP;
        let window = self.first_finish.map_or(cap, |first| cap.min(first + FINISH_WINDOW));
        self.settled.map_or(window, |settled| window.min(settled + SETTLE))
    }

    /// How far round the lap a racer's next gate is: the first gate (which ends the lap) is the farthest.
    fn stage(&self, racer: &Racer) -> usize {
        if racer.next == 0 { self.gates.len() } else { racer.next }
    }

    /// Orders the racers still in: those finished by when, then the others by laps, gates, and how near their next
    /// gate they stood at the last tick.
    fn rank(&mut self) {
        // How near the next gate, in steps of [`NECK`]: karts side by side keep the order they had, so the views do not
        // flip between them every tick.
        let gap = |racer: &Racer| {
            let far = self.seen.get(&racer.id).map_or(f64::INFINITY, |at| distance_xz(*at, self.gates[racer.next]));
            (far / NECK).floor() as i64
        };
        let before: HashMap<Uuid, usize> = self.order.iter().enumerate().map(|(place, id)| (*id, place)).collect();
        let place = |racer: &Racer| before.get(&racer.id).copied().unwrap_or(usize::MAX);
        let mut order: Vec<&Racer> = self.racers.iter().filter(|racer| !racer.left).collect();
        order.sort_by(|a, b| match (a.finished, b.finished) {
            (Some(a), Some(b)) => a.cmp(&b),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => b
                .lap
                .cmp(&a.lap)
                .then_with(|| self.stage(b).cmp(&self.stage(a)))
                .then_with(|| gap(a).cmp(&gap(b)))
                .then_with(|| place(a).cmp(&place(b))),
        });
        self.order = order.into_iter().map(|racer| racer.id).collect();
    }

    /// Racer `index` went from `from` to `to`: the gates it passed in order, its laps, and its finish.
    fn advance(&mut self, index: usize, from: Option<[f64; 3]>, to: [f64; 3], now: Millis) {
        let count = self.gates.len();
        for _ in 0..count {
            let racer = &self.racers[index];
            if racer.finished.is_some() || !passes(self.gates[racer.next], from, to, self.radius) {
                return;
            }
            let racer = &mut self.racers[index];
            if racer.next == 0 {
                racer.lap += 1;
                if racer.lap >= self.laps {
                    racer.finished = Some(now - self.starts_at);
                    self.first_finish.get_or_insert(now);
                }
            }
            racer.next = (racer.next + 1) % count;
        }
    }

    /// Racer `index` went from `from` to `to`: with its slot empty, the first ready box it drove over gives it an item.
    fn pick_up(&mut self, index: usize, from: Option<[f64; 3]>, to: [f64; 3], ctx: &mut Ctx) {
        let now = ctx.now();
        if self.racers[index].item.is_some() || !self.racers[index].racing() {
            return;
        }
        let Some(found) =
            self.boxes.iter().position(|item| now >= item.ready_at && passes(item.position, from, to, PICKUP))
        else {
            return;
        };
        self.boxes[found].ready_at = now + RESPAWN;
        let item = Item::roll(ctx.rng());
        let wait = ctx.rng().gen_range(bots::USE_AFTER);
        let racer = &mut self.racers[index];
        racer.item = Some(item);
        if let Some(bot) = racer.bot.as_mut() {
            bot.use_at = Some(now + wait);
        }
    }

    /// The racer just ahead of racer `index` in the order, while it is still racing.
    fn ahead(&self, index: usize) -> Option<usize> {
        let id = self.racers[index].id;
        let place = self.order.iter().position(|other| *other == id)?;
        let before = self.order.get(place.checked_sub(1)?)?;
        self.index(*before).filter(|other| self.racers[*other].racing())
    }

    /// Racer `index` uses `item`: a booster on itself, a bubble on whoever is just ahead. False when a bubble had
    /// nobody to catch.
    fn fire(&mut self, index: usize, item: Item, ctx: &mut Ctx) -> bool {
        let now = ctx.now();
        match item {
            Item::Booster => {
                let racer = &mut self.racers[index];
                racer.boost_until = now + BOOST;
                match racer.bot.as_mut() {
                    Some(bot) => bot.boost(now, BOOST),
                    None => ctx.emit_one(racer.id, json!({"type": "boost", "until": now + BOOST})),
                }
                true
            }
            Item::Bubble => {
                let Some(target) = self.ahead(index) else { return false };
                let racer = &mut self.racers[target];
                racer.trapped_until = now + TRAP;
                match racer.bot.as_mut() {
                    Some(bot) => bot.trap(now, now + TRAP),
                    None => ctx.emit_one(racer.id, json!({"type": "trapped", "until": now + TRAP})),
                }
                true
            }
        }
    }

    /// The bots set off on their next legs and use the items whose time has come: a bubble only once someone is ahead.
    fn drive_bots(&mut self, ctx: &mut Ctx) {
        let now = ctx.now();
        for index in 0..self.racers.len() {
            if self.racers[index].left {
                continue;
            }
            let Some(bot) = self.racers[index].bot.as_mut() else { continue };
            bot.drive(now, ctx.rng());
            let due = bot.use_at.is_some_and(|at| now >= at);
            if !due || !self.racers[index].racing() {
                continue;
            }
            let Some(item) = self.racers[index].item else { continue };
            let used = self.fire(index, item, ctx);
            let racer = &mut self.racers[index];
            if used {
                racer.item = None;
            }
            if let Some(bot) = racer.bot.as_mut() {
                bot.use_at = (!used).then_some(now + HOLD);
            }
        }
    }

    /// The race is over a moment after every person still in has finished, at once when no person is left, or when
    /// its time is up.
    fn judge(&mut self, now: Millis) {
        let mut people = self.racers.iter().filter(|racer| !racer.left && racer.bot.is_none()).peekable();
        if people.peek().is_none() {
            self.over = true;
            return;
        }
        if self.settled.is_none() && people.all(|racer| racer.finished.is_some()) {
            self.settled = Some(now);
        }
        if now >= self.ends_at() {
            self.over = true;
        }
    }

    fn racer_view(&self, place: usize, racer: &Racer) -> Value {
        json!({
            "id": racer.id,
            "name": racer.name,
            "bot": racer.bot.is_some(),
            "color": racer.color,
            "lap": racer.lap,
            "next": racer.next,
            "finishedAt": racer.finished,
            "rank": place + 1,
            "boostUntil": racer.boost_until,
            "trappedUntil": racer.trapped_until,
        })
    }

    fn ranked(&self) -> impl Iterator<Item = (usize, &Racer)> {
        self.order.iter().filter_map(|id| self.index(*id)).map(|index| &self.racers[index]).enumerate()
    }
}

impl Game for Kart {
    fn view(&self, viewer: Option<Uuid>, now: Millis) -> Value {
        let me = viewer.and_then(|id| self.index(id)).map(|index| &self.racers[index]).filter(|me| me.bot.is_none());
        let phase = if self.over {
            "ended"
        } else if now < self.starts_at {
            "countdown"
        } else {
            "race"
        };
        json!({
            "phase": phase,
            "startsAt": self.starts_at,
            "endsAt": self.ends_at(),
            "laps": self.laps,
            "gates": self.gates.len(),
            "racers": self.ranked().map(|(place, racer)| self.racer_view(place, racer)).collect::<Vec<_>>(),
            "me": me.map(|me| json!({"lap": me.lap, "next": me.next, "item": me.item.map(Item::name)})),
            "spawn": me.map(|me| me.slot),
            "boxes": self.boxes.iter().enumerate().map(|(id, item)| json!({
                "id": id,
                "position": item.position,
                "ready": now >= item.ready_at,
            })).collect::<Vec<_>>(),
            "boosts": self.boosts,
            "bots": self.racers.iter()
                .filter(|racer| !racer.left)
                .filter_map(|racer| Some((racer, racer.bot.as_ref()?)))
                .map(|(racer, bot)| json!({"id": racer.id, "color": racer.color, "route": bot.route.view()}))
                .collect::<Vec<_>>(),
        })
    }

    fn act(&mut self, player: Uuid, action: &Value, ctx: &mut Ctx) -> Result<(), GameError> {
        let index = self.index(player).filter(|index| self.racers[*index].bot.is_none()).ok_or(BAD_ACTION)?;
        if action.get("do").and_then(Value::as_str) != Some("item") {
            return Err(BAD_ACTION);
        }
        if self.over || ctx.now() < self.starts_at || !self.racers[index].racing() {
            return Err(NOT_NOW);
        }
        let item = self.racers[index].item.take().ok_or(NO_ITEM)?;
        // A bubble with nobody just ahead is spent all the same.
        self.fire(index, item, ctx);
        Ok(())
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        if self.over {
            return;
        }
        let now = ctx.now();
        let mut standing = HashMap::new();
        for racer in self.racers.iter().filter(|racer| !racer.left) {
            let at = match &racer.bot {
                Some(bot) => Some(bot.route.at(now)),
                None => ctx.position(racer.id),
            };
            if let Some(at) = at {
                standing.insert(racer.id, at);
            }
        }
        if now >= self.starts_at {
            for index in 0..self.racers.len() {
                let id = self.racers[index].id;
                let (false, Some(to)) = (self.racers[index].left, standing.get(&id).copied()) else { continue };
                let from = self.last.get(&id).copied();
                self.advance(index, from, to, now);
                self.pick_up(index, from, to, ctx);
            }
            self.drive_bots(ctx);
            self.last.clone_from(&standing);
        }
        self.seen = standing;
        self.rank();
        self.judge(now);
    }

    fn leave(&mut self, player: Uuid, ctx: &mut Ctx) {
        let Some(index) = self.index(player) else { return };
        self.racers[index].left = true;
        if !self.over {
            self.rank();
            self.judge(ctx.now());
        }
    }

    fn result(&self) -> Option<Value> {
        self.over.then(|| {
            json!({
                "ranking": self.ranked().map(|(place, racer)| json!({
                    "id": racer.id,
                    "name": racer.name,
                    "bot": racer.bot.is_some(),
                    "rank": place + 1,
                    "finishedAt": racer.finished,
                    "laps": racer.lap,
                })).collect::<Vec<_>>(),
            })
        })
    }
}
