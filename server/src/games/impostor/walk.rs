//! Where 임포스터's bots walk: the island's open spots joined into a graph (its cells are 4 m, so neighbours are up to
//! a diagonal apart), and a bot's route along it at a steady pace. A route is a line of points and a departure time,
//! which the views carry as they are, so pages move each bot themselves and a view changes only when a bot sets off.

use serde_json::{Value, json};
use std::{cmp::Ordering, collections::BinaryHeap};

use super::super::{Millis, distance_xz};

/// Spots this near on the ground are neighbours: one cell across, or one diagonally (5.7 m).
const LINK: f64 = 6.0;
/// Points of a way closer than this are one.
const SAME_POINT: f64 = 0.05;
/// How fast bots walk, in meters a second.
pub(super) const SPEED: f64 = 3.0;

/// The island's open spots and which of them join.
pub(super) struct Walk {
    points: Vec<[f64; 3]>,
    links: Vec<Vec<(usize, f64)>>,
}

/// A spot on the search frontier, nearest first.
struct Step(f64, usize);

impl PartialEq for Step {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Step {}

impl PartialOrd for Step {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Step {
    fn cmp(&self, other: &Self) -> Ordering {
        other.0.total_cmp(&self.0).then_with(|| other.1.cmp(&self.1))
    }
}

impl Walk {
    pub(super) fn new(points: Vec<[f64; 3]>) -> Self {
        let links = points
            .iter()
            .enumerate()
            .map(|(from, a)| {
                points
                    .iter()
                    .enumerate()
                    .filter(|(to, _)| *to != from)
                    .map(|(to, b)| (to, distance_xz(*a, *b)))
                    .filter(|(_, distance)| *distance <= LINK)
                    .collect()
            })
            .collect();
        Self { points, links }
    }

    fn nearest(&self, at: [f64; 3]) -> Option<usize> {
        (0..self.points.len())
            .min_by(|a, b| distance_xz(self.points[*a], at).total_cmp(&distance_xz(self.points[*b], at)))
    }

    /// The spots from `start` to `goal`, both included, the shortest way; None when they do not join.
    fn path(&self, start: usize, goal: usize) -> Option<Vec<usize>> {
        let mut best = vec![f64::INFINITY; self.points.len()];
        let mut came = vec![usize::MAX; self.points.len()];
        let mut frontier = BinaryHeap::from([Step(0.0, start)]);
        best[start] = 0.0;
        while let Some(Step(far, spot)) = frontier.pop() {
            if spot == goal {
                let mut path = vec![goal];
                while let Some(&last) = path.last()
                    && last != start
                {
                    path.push(came[last]);
                }
                path.reverse();
                return Some(path);
            }
            if far > best[spot] {
                continue;
            }
            for &(next, step) in &self.links[spot] {
                if far + step < best[next] {
                    best[next] = far + step;
                    came[next] = spot;
                    frontier.push(Step(far + step, next));
                }
            }
        }
        None
    }

    /// The points from `from` to `to`: through the spots when the ones nearest each end join, else straight.
    pub(super) fn way(&self, from: [f64; 3], to: [f64; 3]) -> Vec<[f64; 3]> {
        let mut way = vec![from];
        if distance_xz(from, to) > LINK
            && let (Some(start), Some(goal)) = (self.nearest(from), self.nearest(to))
            && let Some(path) = self.path(start, goal)
        {
            way.extend(path.into_iter().map(|spot| self.points[spot]));
        }
        way.push(to);
        way.dedup_by(|b, a| distance_xz(*a, *b) < SAME_POINT);
        way
    }
}

/// Centimeters, as the views carry points.
fn round(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// Where a bot goes: along `points`, leaving the first at `depart` and walking at `speed`, then standing at the last.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Route {
    points: Vec<[f64; 3]>,
    depart: Millis,
    speed: f64,
}

impl Route {
    /// Standing at `at` from `now`.
    pub(super) fn still(at: [f64; 3], now: Millis) -> Self {
        Self { points: vec![at.map(round)], depart: now, speed: SPEED }
    }

    /// Along `points` from `now` (rounded to centimeters, as the views carry them).
    pub(super) fn along(points: Vec<[f64; 3]>, now: Millis) -> Self {
        Self { points: points.into_iter().map(|point| point.map(round)).collect(), depart: now, speed: SPEED }
    }

    fn length(&self) -> f64 {
        self.points.windows(2).map(|pair| distance_xz(pair[0], pair[1])).sum()
    }

    /// When the bot stands at the end.
    pub(super) fn arrive(&self) -> Millis {
        self.depart + (self.length() / self.speed * 1000.0).ceil() as Millis
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A 4 m grid of `width` by `depth` cells from the origin, with the cells in `holes` left out.
    fn grid(width: usize, depth: usize, holes: &[(usize, usize)]) -> Vec<[f64; 3]> {
        let mut points = Vec::new();
        for x in 0..width {
            for z in 0..depth {
                if !holes.contains(&(x, z)) {
                    points.push([x as f64 * 4.0, 0.0, z as f64 * 4.0]);
                }
            }
        }
        points
    }

    #[test]
    fn a_way_goes_round_what_is_not_open_and_straight_when_near_or_cut_off() {
        // A wall of holes at x = 2 from z = 0 to 3: the way from one side to the other goes round it at z = 4.
        let walk = Walk::new(grid(5, 5, &[(2, 0), (2, 1), (2, 2), (2, 3)]));
        let way = walk.way([0.0, 0.0, 0.0], [16.0, 0.0, 0.0]);
        assert_eq!(way.first(), Some(&[0.0, 0.0, 0.0]));
        assert_eq!(way.last(), Some(&[16.0, 0.0, 0.0]));
        assert!(way.contains(&[8.0, 0.0, 16.0]), "{way:?}");
        assert!(way.windows(2).all(|pair| distance_xz(pair[0], pair[1]) <= LINK + 1e-9), "{way:?}");
        // Near: straight. Cut off (an island of its own): straight too.
        assert_eq!(walk.way([0.0, 0.0, 0.0], [4.0, 0.0, 4.0]), vec![[0.0, 0.0, 0.0], [4.0, 0.0, 4.0]]);
        let apart = Walk::new(vec![[0.0, 0.0, 0.0], [40.0, 0.0, 0.0]]);
        assert_eq!(apart.way([0.0, 0.0, 0.0], [40.0, 0.0, 0.0]), vec![[0.0, 0.0, 0.0], [40.0, 0.0, 0.0]]);
        assert_eq!(Walk::new(Vec::new()).way([0.0, 0.0, 0.0], [40.0, 0.0, 0.0]).len(), 2);
    }

    #[test]
    fn a_route_walks_its_points_at_its_pace_then_stands() {
        let route = Route::along(vec![[0.0, 0.0, 0.0], [3.0, 0.0, 0.0], [3.0, 0.0, 6.0]], 1_000);
        assert_eq!(route.arrive(), 4_000);
        assert_eq!(route.at(0), [0.0, 0.0, 0.0]);
        assert_eq!(route.at(1_500), [1.5, 0.0, 0.0]);
        assert_eq!(route.at(3_000), [3.0, 0.0, 3.0]);
        assert_eq!(route.at(9_000), [3.0, 0.0, 6.0]);
        assert_eq!(
            route.view(),
            json!({"points": [[0.0, 0.0, 0.0], [3.0, 0.0, 0.0], [3.0, 0.0, 6.0]], "departAt": 1_000, "speed": SPEED})
        );
        let still = Route::still([1.234, 0.0, -2.0], 5);
        assert_eq!((still.at(99), still.arrive()), ([1.23, 0.0, -2.0], 5));
    }
}
