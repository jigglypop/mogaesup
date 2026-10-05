//! 카트's bots: karts the game drives itself, so someone alone can race. A bot keeps to a lane of its own (its grid
//! slot's side of the road) through every gate of the loop, at a pace of its own that changes a little from lap to lap.
//! It drives as routes the views carry (points, a departure time and a speed): one a lap, and one for a boost or a stop,
//! so a view changes only when a bot sets off on one, and pages move each bot themselves as the server reckons it.

use rand::{Rng, rngs::StdRng};
use serde_json::{Value, json};
use std::ops::Range;

use super::super::{Millis, distance_xz, pick_many};

/// A bot's own pace, in meters a second.
pub(super) const PACE: Range<f64> = 16.0..20.0;
/// How far a lap's pace may be off the bot's own, either way.
const WOBBLE: f64 = 0.8;
/// How much faster a booster makes a bot.
pub(super) const BOOSTED: f64 = 1.4;
/// The farthest a bot's lane is from the middle of the road: a share of the gate radius, and at most this many meters.
const LANE_SHARE: f64 = 0.5;
const LANE_MOST: f64 = 3.0;
/// A bot uses an item this long after taking it.
pub(super) const USE_AFTER: Range<Millis> = 1_000..4_000;
/// This near the end of the lap is at the line.
const AT_LINE: f64 = 0.05;
/// How far a corner's lane point may be pushed out, as a multiple of the offset.
const MITER: f64 = 2.0;

const NAMES: [&str; 12] =
    ["도토리", "솔방울", "감자", "고구마", "모과", "단풍", "버섯", "조약돌", "다람쥐", "호두", "밤톨", "보리"];

/// Centimeters, as the views carry points.
fn round(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// `count` bot names, none of them one a person in the race goes by.
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

/// The unit vector across `direction` on the ground (a quarter turn of it); zero when it has no length there.
pub(super) fn side(direction: [f64; 3]) -> [f64; 3] {
    let length = direction[0].hypot(direction[2]);
    if length <= f64::EPSILON { [0.0; 3] } else { [-direction[2] / length, 0.0, direction[0] / length] }
}

fn minus(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[2] * b[2]
}

/// The side of the road a bot starting at `slot` keeps to: how far it is across the road from the start line, within
/// the lane limits for gates of `radius`.
pub(super) fn lane_offset(gates: &[[f64; 3]], radius: f64, slot: [f64; 3]) -> f64 {
    let count = gates.len();
    let direction = minus(gates[1 % count], gates[(count - 1) % count]);
    let most = (radius * LANE_SHARE).min(LANE_MOST);
    dot(minus(slot, gates[0]), side(direction)).clamp(-most, most)
}

/// Where a bot goes: along `points`, leaving the first at `depart` at `speed`, then standing at the last.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Route {
    points: Vec<[f64; 3]>,
    depart: Millis,
    speed: f64,
}

impl Route {
    /// Standing at `at` from `now`.
    pub(super) fn still(at: [f64; 3], now: Millis) -> Self {
        Self { points: vec![at.map(round)], depart: now, speed: 0.0 }
    }

    /// Along `points` from `now` at `speed` (rounded to centimeters, as the views carry them).
    pub(super) fn along(points: Vec<[f64; 3]>, now: Millis, speed: f64) -> Self {
        let mut points: Vec<[f64; 3]> = points.into_iter().map(|point| point.map(round)).collect();
        points.dedup();
        Self { points, depart: now, speed: round(speed) }
    }

    fn length(&self) -> f64 {
        self.points.windows(2).map(|pair| distance_xz(pair[0], pair[1])).sum()
    }

    /// When the bot stands at the end.
    pub(super) fn arrive(&self) -> Millis {
        let length = self.length();
        if self.speed <= 0.0 || length <= 0.0 {
            return self.depart;
        }
        self.depart + (length / self.speed * 1000.0).ceil() as Millis
    }

    pub(super) fn end(&self) -> [f64; 3] {
        self.points.last().copied().unwrap_or_default()
    }

    /// Where the bot is at `now`.
    pub(super) fn at(&self, now: Millis) -> [f64; 3] {
        let mut left = now.saturating_sub(self.depart) as f64 / 1000.0 * self.speed;
        for pair in self.points.windows(2) {
            let step = distance_xz(pair[0], pair[1]);
            if left < step {
                let share = if step > 0.0 { left / step } else { 0.0 };
                return [0, 1, 2].map(|axis| pair[0][axis] + (pair[1][axis] - pair[0][axis]) * share);
            }
            left -= step;
        }
        self.end()
    }

    pub(super) fn view(&self) -> Value {
        json!({"points": self.points, "departAt": self.depart, "speed": self.speed})
    }
}

/// A bot's way round the loop: through every gate, `offset` meters across from it (pushed out at corners so the lane
/// keeps its distance from the middle), from the start line back to it.
pub(super) struct Lane {
    /// Closed: the last point is the first again.
    points: Vec<[f64; 3]>,
    /// How far along the lane each point is.
    along: Vec<f64>,
}

impl Lane {
    pub(super) fn new(gates: &[[f64; 3]], offset: f64) -> Self {
        let count = gates.len();
        let mut points: Vec<[f64; 3]> = (0..count)
            .map(|index| {
                let (before, here, after) =
                    (gates[(index + count - 1) % count], gates[index], gates[(index + 1) % count]);
                let (into, out) = (side(minus(here, before)), side(minus(after, here)));
                let sum = [into[0] + out[0], 0.0, into[2] + out[2]];
                let length = sum[0].hypot(sum[2]);
                let (across, push) = if length <= 1e-9 {
                    (into, 1.0)
                } else {
                    let across = [sum[0] / length, 0.0, sum[2] / length];
                    (across, 1.0 / dot(across, into).max(1.0 / MITER))
                };
                [here[0] + across[0] * offset * push, here[1], here[2] + across[2] * offset * push]
            })
            .collect();
        points.push(points[0]);
        let mut along = Vec::with_capacity(points.len());
        let mut total = 0.0;
        for (index, point) in points.iter().enumerate() {
            if index > 0 {
                total += distance_xz(points[index - 1], *point);
            }
            along.push(total);
        }
        Self { points, along }
    }

    pub(super) fn length(&self) -> f64 {
        self.along.last().copied().unwrap_or(0.0)
    }

    /// The point `distance` meters along the lane from the start line.
    pub(super) fn point(&self, distance: f64) -> [f64; 3] {
        for index in 1..self.points.len() {
            if distance <= self.along[index] {
                let (from, to) = (self.points[index - 1], self.points[index]);
                let step = self.along[index] - self.along[index - 1];
                let share = if step > 0.0 { ((distance - self.along[index - 1]) / step).clamp(0.0, 1.0) } else { 0.0 };
                return [0, 1, 2].map(|axis| from[axis] + (to[axis] - from[axis]) * share);
            }
        }
        self.points.last().copied().unwrap_or_default()
    }

    /// How far along the lane the point of it nearest `at` is.
    pub(super) fn locate(&self, at: [f64; 3]) -> f64 {
        let mut best = (f64::INFINITY, 0.0);
        for index in 1..self.points.len() {
            let (from, to) = (self.points[index - 1], self.points[index]);
            let way = minus(to, from);
            let step = dot(way, way);
            let share = if step > 0.0 { (dot(minus(at, from), way) / step).clamp(0.0, 1.0) } else { 0.0 };
            let near = [from[0] + way[0] * share, from[1], from[2] + way[2] * share];
            let apart = distance_xz(near, at);
            if apart < best.0 {
                best = (apart, self.along[index - 1] + (self.along[index] - self.along[index - 1]) * share);
            }
        }
        best.1
    }

    /// The lane's points after `from` and before `to` (meters along it), then the point at `to`.
    fn between(&self, from: f64, to: f64) -> Vec<[f64; 3]> {
        let mut points: Vec<[f64; 3]> = self
            .points
            .iter()
            .zip(&self.along)
            .filter(|(_, along)| **along > from + AT_LINE && **along < to - AT_LINE)
            .map(|(point, _)| *point)
            .collect();
        points.push(self.point(to));
        points
    }
}

/// What a bot is driving now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Leg {
    /// From its grid slot to the line.
    Grid,
    /// The rest of a lap, to the line.
    Lap,
    /// A stretch on a booster.
    Boost,
    /// Trapped in a bubble until then.
    Stop(Millis),
}

pub(super) struct Bot {
    pub(super) route: Route,
    lane: Lane,
    leg: Leg,
    /// Its own pace, and this lap's.
    base: f64,
    pace: f64,
    /// When it uses the item it holds.
    pub(super) use_at: Option<Millis>,
}

impl Bot {
    /// Waiting at `slot` until `start`, then driving to the line and round its `lane` at `base` meters a second.
    pub(super) fn new(slot: [f64; 3], lane: Lane, base: f64, start: Millis) -> Self {
        let route = Route::along(vec![slot, lane.point(0.0)], start, base);
        Self { route, lane, leg: Leg::Grid, base, pace: base, use_at: None }
    }

    /// Sets off on its next leg once this one is over: a new lap at the line, the rest of the lap after a boost or a
    /// stop.
    pub(super) fn drive(&mut self, now: Millis, rng: &mut StdRng) {
        let over = match self.leg {
            Leg::Stop(until) => now >= until,
            _ => now >= self.route.arrive(),
        };
        if !over {
            return;
        }
        let at = self.route.at(now);
        let along = match self.leg {
            Leg::Grid | Leg::Lap => 0.0,
            Leg::Boost | Leg::Stop(_) => self.lane.locate(at),
        };
        self.lap(at, along, now, rng);
    }

    /// From `at`, `along` meters into the lap, to the line; from the line, a new lap at a pace a little off its own.
    fn lap(&mut self, at: [f64; 3], along: f64, now: Millis, rng: &mut StdRng) {
        let along = if along >= self.lane.length() - AT_LINE { 0.0 } else { along };
        if along <= 0.0 {
            self.pace = (self.base + rng.gen_range(-WOBBLE..WOBBLE)).max(1.0);
        }
        let mut points = vec![at];
        points.extend(self.lane.between(along, self.lane.length()));
        self.route = Route::along(points, now, self.pace);
        self.leg = Leg::Lap;
    }

    /// Goes [`BOOSTED`] times its pace for `lasting` ms, then on as before.
    pub(super) fn boost(&mut self, now: Millis, lasting: Millis) {
        let at = self.route.at(now);
        let length = self.lane.length();
        let along = self.lane.locate(at);
        let along = if along >= length - AT_LINE { 0.0 } else { along };
        let speed = self.pace * BOOSTED;
        let to = (along + speed * lasting as f64 / 1000.0).min(length);
        let mut points = vec![at];
        points.extend(self.lane.between(along, to));
        self.route = Route::along(points, now, speed);
        self.leg = Leg::Boost;
    }

    /// Stops where it is until `until`.
    pub(super) fn trap(&mut self, now: Millis, until: Millis) {
        self.route = Route::still(self.route.at(now), now);
        self.leg = Leg::Stop(until);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    /// A 40 m square loop at 80 m up, gates every 20 m, the line in the middle of a side, running along +x first.
    fn square() -> Vec<[f64; 3]> {
        vec![
            [0.0, 80.0, 0.0],
            [20.0, 80.0, 0.0],
            [20.0, 80.0, 20.0],
            [20.0, 80.0, 40.0],
            [0.0, 80.0, 40.0],
            [-20.0, 80.0, 40.0],
            [-20.0, 80.0, 20.0],
            [-20.0, 80.0, 0.0],
        ]
    }

    #[test]
    fn a_route_drives_its_points_at_its_speed_then_stands() {
        let route = Route::along(vec![[0.0, 80.0, 0.0], [30.0, 80.0, 0.0], [30.0, 80.0, 40.0]], 1_000, 10.0);
        assert_eq!(route.arrive(), 8_000);
        assert_eq!(route.at(0), [0.0, 80.0, 0.0]);
        assert_eq!(route.at(2_500), [15.0, 80.0, 0.0]);
        assert_eq!(route.at(5_000), [30.0, 80.0, 10.0]);
        assert_eq!(route.at(60_000), [30.0, 80.0, 40.0]);
        assert_eq!(
            route.view(),
            json!({"points": [[0.0, 80.0, 0.0], [30.0, 80.0, 0.0], [30.0, 80.0, 40.0]], "departAt": 1_000, "speed": 10.0})
        );
        let still = Route::still([1.234, 80.0, -2.0], 5);
        assert_eq!((still.at(99), still.arrive()), ([1.23, 80.0, -2.0], 5));
    }

    #[test]
    fn a_lane_runs_beside_every_gate_and_closes_on_itself() {
        let gates = square();
        let middle = Lane::new(&gates, 0.0);
        assert_eq!(middle.length(), 160.0);
        assert_eq!(middle.point(30.0), [20.0, 80.0, 10.0]);
        assert_eq!(middle.point(160.0), [0.0, 80.0, 0.0]);
        assert_eq!(middle.locate([12.0, 80.0, 3.0]), 12.0);
        // Two meters to one side: across the straights by two meters, out at the corners along their diagonal.
        let lane = Lane::new(&gates, 2.0);
        for (gate, point) in gates.iter().zip(&lane.points) {
            let apart = distance_xz(*gate, *point);
            assert!((2.0..=2.0 * MITER + 1e-9).contains(&apart), "{gate:?} {point:?}");
        }
        assert_eq!(lane.points[0], [0.0, 80.0, 2.0]);
        assert_eq!(lane.points.first(), lane.points.last());
        // The side a slot is on, within the limits for the radius.
        assert_eq!(lane_offset(&gates, 8.0, [-6.0, 80.0, 2.5]), 2.5);
        assert_eq!(lane_offset(&gates, 8.0, [-6.0, 80.0, -9.0]), -3.0);
        assert_eq!(lane_offset(&gates, 2.0, [-6.0, 80.0, 2.5]), 1.0);
    }

    #[test]
    fn a_bot_drives_to_the_line_then_laps_and_boosts_and_stops_on_its_lane() {
        let mut rng = StdRng::seed_from_u64(3);
        let gates = square();
        let mut bot = Bot::new([-10.0, 80.0, 0.0], Lane::new(&gates, 0.0), 10.0, 1_000);
        // Waits on the grid until the start, then reaches the line a second later.
        assert_eq!(bot.route.at(500), [-10.0, 80.0, 0.0]);
        assert_eq!(bot.route.arrive(), 2_000);
        bot.drive(2_000, &mut rng);
        assert_eq!(bot.leg, Leg::Lap);
        assert_eq!(bot.route.end(), [0.0, 80.0, 0.0]);
        assert!((10.0 - WOBBLE..=10.0 + WOBBLE).contains(&bot.pace), "{}", bot.pace);
        let lap = bot.route.arrive();
        assert_eq!(lap, 2_000 + (160.0 / bot.route.speed * 1000.0).ceil() as Millis);
        // A boost from 20 m in covers 2 s at 1.4 times the pace, then the lap goes on from there.
        let at = 2_000 + (20.0 / bot.pace * 1000.0) as Millis;
        bot.boost(at, 2_000);
        assert_eq!(bot.leg, Leg::Boost);
        let reach = bot.route.end();
        assert!((distance_xz(bot.route.at(at), [20.0, 80.0, 0.0])) < 0.1);
        assert!((bot.lane.locate(reach) - (20.0 + bot.pace * BOOSTED * 2.0)).abs() < 0.2, "{reach:?}");
        bot.drive(bot.route.arrive(), &mut rng);
        assert_eq!((bot.leg, bot.route.end()), (Leg::Lap, [0.0, 80.0, 0.0]));
        // Trapped: stands still until the bubble pops, then drives on from there.
        let now = bot.route.depart + 1_000;
        let here = bot.route.at(now);
        bot.trap(now, now + 1_500);
        assert_eq!((bot.route.at(now + 1_400), bot.route.at(now)), (here.map(round), here.map(round)));
        bot.drive(now + 1_000, &mut rng);
        assert_eq!(bot.leg, Leg::Stop(now + 1_500));
        bot.drive(now + 1_500, &mut rng);
        assert_eq!(bot.leg, Leg::Lap);
        assert!(distance_xz(bot.route.at(now + 2_500), here) > 5.0);
    }

    #[test]
    fn bot_names_skip_the_peoples_and_run_out_into_numbers() {
        let mut rng = StdRng::seed_from_u64(9);
        let names = names(&mut rng, 14, &["감자", "봇 2"]);
        assert_eq!(names.len(), 14);
        assert!(!names.contains(&"감자".to_owned()) && !names.contains(&"봇 2".to_owned()));
        assert!(names.contains(&"봇 1".to_owned()) && names.contains(&"봇 3".to_owned()));
    }
}
