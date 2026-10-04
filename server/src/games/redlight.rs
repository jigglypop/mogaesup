//! 무궁화 꽃이 피었습니다 (red light, green light): everyone lines up on the start line and runs for the finish while
//! the light is green. When it turns red they have a moment to stop, and then whoever moves is out. Players finish in
//! the order they reach the finish line; the race lasts a minute and a half, or until nobody is running.
//!
//! Layout (from the host's page): `{"start": [x, y, z], "finish": [x, y, z]}`, two open spots of the island 16 to 60 m
//! apart on the ground.
//! Phases: 준비 (`ready`, eight seconds: each player's view has their place on the start line and their page puts them
//! there), then 초록불 (`green`, two to five seconds) and 빨간불 (`red`, two to four seconds) by turns.
//! View: `{"phase", "phaseEndsAt", "endsAt", "track": {start, finish}, "slot", "state", "finished": [{id, name, time}],
//! "out": [{id, name}], "counts": {running, finished, out}}`; `slot` (during 준비) and `state` (`running`, `finished` or
//! `out`) are the viewer's own.
//! Events, to everyone: `{"type": "light", "phase", "endsAt"}` as the light changes, `{"type": "out", "player",
//! "reason": "early"|"moved"}`, `{"type": "finished", "player", "time", "rank"}`. Times are ms since the race began.
//! Result: `{"finished": [{id, name, time, rank}], "out": [{id, name}], "unfinished": [{id, name}]}`.

use rand::Rng;
use serde_json::{Value, json};
use std::ops::RangeInclusive;
use uuid::Uuid;

use super::{BAD_ACTION, Ctx, Game, GameError, Kind, Millis, distance_xz, point};

pub(crate) const KIND: Kind = Kind::new("redlight", 2, 30, create).ticking(20);

/// 준비: the time to come to the start line before the race begins.
const READY: Millis = 8_000;
/// How long the race runs once it has begun.
const RACE: Millis = 90_000;
/// How long a green light lasts, picked at random each time.
const GREEN: RangeInclusive<Millis> = 2_000..=5_000;
const RED: RangeInclusive<Millis> = 2_000..=4_000;
/// The moment a red light gives to come to a stop.
const GRACE: Millis = 600;
/// How far (on the ground) someone may sway from where the grace left them while the light is red, in meters.
const STILL: f64 = 0.3;
/// Reaching this near the finish line, along the track, is reaching it.
const FINISH: f64 = 1.0;
/// How far past the start line someone may stand as the race begins.
const EARLY: f64 = 1.0;
const SHORTEST: f64 = 16.0;
const LONGEST: f64 = 60.0;
/// The start line: places a meter apart across the track, closer when there are too many for this many meters.
const SLOT_GAP: f64 = 1.0;
const LINE: f64 = 8.0;

const BAD_TRACK: GameError = GameError::new("bad_track", "달릴 길이 너무 짧거나 길어요.");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Ready,
    Green,
    Red,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Green => "green",
            Self::Red => "red",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Running,
    Finished,
    Out,
}

impl State {
    fn name(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Finished => "finished",
            Self::Out => "out",
        }
    }
}

struct Racer {
    id: Uuid,
    name: String,
    /// Their place on the start line.
    slot: [f64; 3],
    state: State,
    /// Seen since the race began: whoever is first seen past the start line started early.
    seen: bool,
    /// Where they stood as this red light's grace ran out.
    stopped_at: Option<[f64; 3]>,
}

pub(crate) struct RedLight {
    start: [f64; 3],
    finish: [f64; 3],
    /// From the start toward the finish on the ground (x, z), one meter long.
    heading: [f64; 2],
    length: f64,
    /// In the order they joined.
    racers: Vec<Racer>,
    phase: Phase,
    phase_ends: Millis,
    /// When this red light's grace runs out.
    still_from: Millis,
    /// When the race began (the first green light).
    began: Millis,
    ends_at: Millis,
    /// Who reached the finish line, in order, and when (ms since the race began).
    finished: Vec<(Uuid, String, Millis)>,
    /// Who is out, in order.
    out: Vec<(Uuid, String)>,
    over: bool,
}

fn create(layout: &Value, ctx: &mut Ctx) -> Result<Box<dyn Game>, GameError> {
    Ok(Box::new(RedLight::new(layout, ctx)?))
}

/// How far along the track `at` is: 0 on the start line, the track's length on the finish line.
fn along(start: [f64; 3], heading: [f64; 2], at: [f64; 3]) -> f64 {
    (at[0] - start[0]) * heading[0] + (at[2] - start[2]) * heading[1]
}

/// The place of a finish at `time` among `finished`: 1 for the fastest, and the same time, the same place.
fn rank(finished: &[(Uuid, String, Millis)], time: Millis) -> usize {
    1 + finished.iter().filter(|(_, _, other)| *other < time).count()
}

impl RedLight {
    fn new(layout: &Value, ctx: &mut Ctx) -> Result<Self, GameError> {
        let start = point(&layout["start"])?;
        let finish = point(&layout["finish"])?;
        let length = distance_xz(start, finish);
        if !(SHORTEST..=LONGEST).contains(&length) {
            return Err(BAD_TRACK);
        }
        let heading = [(finish[0] - start[0]) / length, (finish[2] - start[2]) / length];
        let players = ctx.players();
        // Across the track and centred on the start, in the order they joined.
        let gap = if players.len() > 1 { SLOT_GAP.min(LINE / (players.len() - 1) as f64) } else { 0.0 };
        let middle = (players.len() as f64 - 1.0) / 2.0;
        let racers = players
            .iter()
            .enumerate()
            .map(|(index, player)| {
                let aside = (index as f64 - middle) * gap;
                Racer {
                    id: player.id,
                    name: player.name.clone(),
                    slot: [start[0] - heading[1] * aside, start[1], start[2] + heading[0] * aside],
                    state: State::Running,
                    seen: false,
                    stopped_at: None,
                }
            })
            .collect();
        let began = ctx.now() + READY;
        Ok(Self {
            start,
            finish,
            heading,
            length,
            racers,
            phase: Phase::Ready,
            phase_ends: began,
            still_from: began,
            began,
            ends_at: began + RACE,
            finished: Vec::new(),
            out: Vec::new(),
            over: false,
        })
    }

    /// The light changes as its time comes: green after 준비 and after red, red after green.
    fn change(&mut self, ctx: &mut Ctx) {
        let at = self.phase_ends;
        if self.phase == Phase::Green {
            self.phase = Phase::Red;
            self.still_from = at + GRACE;
            self.phase_ends = at + ctx.rng().gen_range(RED);
            for racer in &mut self.racers {
                racer.stopped_at = None;
            }
        } else {
            self.phase = Phase::Green;
            self.phase_ends = at + ctx.rng().gen_range(GREEN);
        }
        ctx.emit(json!({"type": "light", "phase": self.phase.name(), "endsAt": self.phase_ends.min(self.ends_at)}));
    }

    fn running(&self) -> usize {
        self.racers.iter().filter(|racer| racer.state == State::Running).count()
    }
}

impl Game for RedLight {
    fn view(&self, viewer: Option<Uuid>, _now: Millis) -> Value {
        let me = viewer.and_then(|id| self.racers.iter().find(|racer| racer.id == id));
        json!({
            "phase": self.phase.name(),
            "phaseEndsAt": self.phase_ends.min(self.ends_at),
            "endsAt": self.ends_at,
            "track": {"start": self.start, "finish": self.finish},
            "slot": me.filter(|_| self.phase == Phase::Ready).map(|racer| racer.slot),
            "state": me.map(|racer| racer.state.name()),
            "finished": self.finished.iter().map(|(id, name, time)| json!({
                "id": id,
                "name": name,
                "time": time,
            })).collect::<Vec<_>>(),
            "out": self.out.iter().map(|(id, name)| json!({"id": id, "name": name})).collect::<Vec<_>>(),
            "counts": {"running": self.running(), "finished": self.finished.len(), "out": self.out.len()},
        })
    }

    fn act(&mut self, _player: Uuid, _action: &Value, _ctx: &mut Ctx) -> Result<(), GameError> {
        // Running and standing still are the whole game; nothing is sent.
        Err(BAD_ACTION)
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        if self.over {
            return;
        }
        let now = ctx.now();
        // The lights keep their times however late a tick comes: a late one makes every change it missed.
        while self.phase_ends <= now && self.phase_ends < self.ends_at {
            self.change(ctx);
        }
        if now >= self.ends_at {
            self.over = true;
            return;
        }
        if self.phase == Phase::Ready {
            return;
        }
        let judging = self.phase == Phase::Red && now >= self.still_from;
        let time = now.saturating_sub(self.began);
        let (start, heading, length) = (self.start, self.heading, self.length);
        for racer in self.racers.iter_mut().filter(|racer| racer.state == State::Running) {
            let Some(at) = ctx.position(racer.id) else { continue };
            let reason = if !racer.seen && along(start, heading, at) > EARLY {
                Some("early")
            } else if judging && distance_xz(*racer.stopped_at.get_or_insert(at), at) > STILL {
                Some("moved")
            } else {
                None
            };
            racer.seen = true;
            if let Some(reason) = reason {
                racer.state = State::Out;
                self.out.push((racer.id, racer.name.clone()));
                ctx.emit(json!({"type": "out", "player": racer.id, "reason": reason}));
            } else if along(start, heading, at) >= length - FINISH {
                racer.state = State::Finished;
                let place = rank(&self.finished, time);
                self.finished.push((racer.id, racer.name.clone(), time));
                ctx.emit(json!({"type": "finished", "player": racer.id, "time": time, "rank": place}));
            }
        }
        if self.running() == 0 {
            self.over = true;
        }
    }

    fn leave(&mut self, player: Uuid, _ctx: &mut Ctx) {
        // Whoever finished or went out stays in those lists; a runner is just gone.
        self.racers.retain(|racer| racer.id != player);
        if self.running() == 0 {
            self.over = true;
        }
    }

    fn result(&self) -> Option<Value> {
        self.over.then(|| {
            json!({
                "finished": self.finished.iter().map(|(id, name, time)| json!({
                    "id": id,
                    "name": name,
                    "time": time,
                    "rank": rank(&self.finished, *time),
                })).collect::<Vec<_>>(),
                "out": self.out.iter().map(|(id, name)| json!({"id": id, "name": name})).collect::<Vec<_>>(),
                "unfinished": self.racers.iter()
                    .filter(|racer| racer.state == State::Running)
                    .map(|racer| json!({"id": racer.id, "name": racer.name}))
                    .collect::<Vec<_>>(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::{Audience, BAD_LAYOUT, Member};
    use rand::{SeedableRng, rngs::StdRng};
    use std::collections::HashMap;

    const T0: Millis = 1_000_000;
    /// When the race begins.
    const GO: Millis = T0 + READY;

    fn members(count: usize) -> Vec<Member> {
        (0..count).map(|index| Member { id: Uuid::new_v4(), name: format!("player{index}") }).collect()
    }

    fn ids(players: &[Member]) -> Vec<Uuid> {
        players.iter().map(|player| player.id).collect()
    }

    /// A 30 m track east along x from the origin.
    fn east() -> Value {
        json!({"start": [0.0, 0.0, 0.0], "finish": [30.0, 0.0, 0.0]})
    }

    /// `x` meters along the eastward track, `aside` across it.
    fn on(x: f64, aside: f64) -> [f64; 3] {
        [x, 0.0, aside]
    }

    fn race(players: &[Member], layout: &Value, rng: &mut StdRng) -> RedLight {
        let positions = HashMap::new();
        let mut ctx = Ctx::new(T0, players, &positions, rng);
        RedLight::new(layout, &mut ctx).unwrap()
    }

    /// Ticks `game` at `now` with the players standing at `standing`; returns the events, which all go to everyone.
    fn tick(
        game: &mut RedLight,
        players: &[Member],
        standing: &[(Uuid, [f64; 3])],
        now: Millis,
        rng: &mut StdRng,
    ) -> Vec<Value> {
        let positions: HashMap<Uuid, [f64; 3]> = standing.iter().copied().collect();
        let mut ctx = Ctx::new(now, players, &positions, rng);
        game.tick(&mut ctx);
        ctx.events()
            .iter()
            .map(|(audience, event)| {
                assert_eq!(*audience, Audience::Everyone);
                event.clone()
            })
            .collect()
    }

    /// The events of these kinds.
    fn only<'a>(events: &'a [Value], kind: &str) -> Vec<&'a Value> {
        events.iter().filter(|event| event["type"] == kind).collect()
    }

    /// Ticks as each light is due, everyone standing at `standing`, until the light turns `phase`; returns when it did.
    fn until(
        game: &mut RedLight,
        players: &[Member],
        standing: &[(Uuid, [f64; 3])],
        phase: Phase,
        rng: &mut StdRng,
    ) -> Millis {
        loop {
            let due = game.phase_ends;
            assert!(due < game.ends_at, "{phase:?} never came");
            tick(game, players, standing, due, rng);
            if game.phase == phase {
                return due;
            }
        }
    }

    #[test]
    fn a_track_runs_16_to_60_meters_over_the_ground_between_two_points() {
        let players = members(2);
        let mut rng = StdRng::seed_from_u64(1);
        let positions = HashMap::new();
        let mut ctx = Ctx::new(T0, &players, &positions, &mut rng);
        let refused = |layout: Value, ctx: &mut Ctx| RedLight::new(&layout, ctx).err();
        for bad in [
            json!(null),
            json!([[0, 0, 0], [20, 0, 0]]),
            json!({"start": [0, 0, 0]}),
            json!({"start": [0, 0], "finish": [20, 0, 0]}),
            json!({"start": [0, 0, 0], "finish": ["20", 0, 0]}),
            json!({"start": [0, 0, 0], "finish": [20, 0, 200.5]}),
        ] {
            assert_eq!(refused(bad.clone(), &mut ctx), Some(BAD_LAYOUT), "{bad}");
        }
        assert_eq!(refused(json!({"start": [0, 0, 0], "finish": [15.9, 0, 0]}), &mut ctx), Some(BAD_TRACK));
        assert_eq!(refused(json!({"start": [-30, 0, 0], "finish": [30.1, 0, 0]}), &mut ctx), Some(BAD_TRACK));
        // Height does not count: 12 m over the ground is short however high the finish is.
        assert_eq!(refused(json!({"start": [0, 0, 0], "finish": [12, 30, 0]}), &mut ctx), Some(BAD_TRACK));
        assert!(RedLight::new(&json!({"start": [0, 0, 0], "finish": [0, 0, -16]}), &mut ctx).is_ok());
        // 36 by 48 is 60 exactly.
        assert!(RedLight::new(&json!({"start": [-18, 0, -24], "finish": [18, 0, 24]}), &mut ctx).is_ok());
    }

    #[test]
    fn each_player_gets_a_place_across_the_start_line_and_sees_only_their_own_until_the_race_begins() {
        let players = members(3);
        let mut rng = StdRng::seed_from_u64(2);
        // Heading north (toward -z): the line runs east and west through the start, a meter apart.
        let mut game = race(&players, &json!({"start": [10, 0.5, 4], "finish": [10, 0.5, -20]}), &mut rng);
        let slot = |game: &RedLight, viewer: Option<Uuid>| game.view(viewer, T0)["slot"].clone();
        let slots: Vec<Value> = players.iter().map(|player| slot(&game, Some(player.id))).collect();
        assert_eq!(slots, [json!([9.0, 0.5, 4.0]), json!([10.0, 0.5, 4.0]), json!([11.0, 0.5, 4.0])]);
        assert_eq!(slot(&game, None), Value::Null, "someone watching has no place");
        let view = game.view(Some(players[0].id), T0);
        assert_eq!(view["phase"], "ready");
        assert_eq!((view["phaseEndsAt"].as_u64(), view["endsAt"].as_u64()), (Some(GO), Some(GO + RACE)));
        assert_eq!(view["track"], json!({"start": [10.0, 0.5, 4.0], "finish": [10.0, 0.5, -20.0]}));
        assert_eq!(view["state"], "running");
        assert_eq!(game.view(None, T0)["state"], Value::Null);
        assert_eq!(view["counts"], json!({"running": 3, "finished": 0, "out": 0}));
        // Once it begins, the places are gone from the views.
        tick(&mut game, &players, &[], GO, &mut rng);
        assert_eq!(slot(&game, Some(players[0].id)), Value::Null);

        // Thirty stand closer, on a line eight meters long.
        let crowd = members(30);
        let game = race(&crowd, &east(), &mut rng);
        let across: Vec<f64> =
            crowd.iter().map(|player| game.view(Some(player.id), T0)["slot"][2].as_f64().unwrap()).collect();
        assert!(across.windows(2).all(|pair| pair[1] > pair[0]));
        assert!((across[29] - across[0] - LINE).abs() < 1e-9);
        assert!((across[0] + across[29]).abs() < 1e-9, "centred on the start");
        // One alone stands on the start.
        let solo = members(1);
        assert_eq!(race(&solo, &east(), &mut rng).view(Some(solo[0].id), T0)["slot"], json!([0.0, 0.0, 0.0]));
    }

    #[test]
    fn after_the_ready_phase_green_and_red_take_turns_for_their_random_lengths() {
        let players = members(2);
        let (mut greens, mut reds) = (Vec::new(), Vec::new());
        for seed in 0..12 {
            let mut rng = StdRng::seed_from_u64(seed);
            let mut game = race(&players, &east(), &mut rng);
            assert!(tick(&mut game, &players, &[], GO - 1, &mut rng).is_empty(), "nothing before the race begins");
            assert_eq!(game.view(None, GO - 1)["phase"], "ready");
            // Nobody stands anywhere, so nobody finishes or goes out: the lights run the whole race.
            let mut lights: Vec<(String, Millis)> = Vec::new();
            let mut now = GO;
            while game.result().is_none() {
                for event in tick(&mut game, &players, &[], now, &mut rng) {
                    assert_eq!(event["type"], "light");
                    lights.push((event["phase"].as_str().unwrap().to_owned(), event["endsAt"].as_u64().unwrap()));
                    assert_eq!(game.view(None, now)["phaseEndsAt"], event["endsAt"]);
                }
                now += 50;
            }
            assert_eq!(now - 50, GO + RACE, "over after a minute and a half");
            assert_eq!(lights[0].0, "green", "the race begins on green");
            let mut from = GO;
            for (index, (phase, ends)) in lights.iter().enumerate() {
                assert_eq!(phase, if index % 2 == 0 { "green" } else { "red" });
                if *ends == GO + RACE {
                    // The last light is cut short by the end of the race.
                    assert_eq!(index, lights.len() - 1);
                    break;
                }
                (if phase == "green" { &mut greens } else { &mut reds }).push(ends - from);
                from = *ends;
            }
        }
        assert!(greens.iter().all(|length| GREEN.contains(length)), "{greens:?}");
        assert!(reds.iter().all(|length| RED.contains(length)), "{reds:?}");
        // They do vary over their whole range.
        assert!(greens.iter().min() < Some(&2_300) && greens.iter().max() > Some(&4_700), "{greens:?}");
        assert!(reds.iter().min() < Some(&2_300) && reds.iter().max() > Some(&3_700), "{reds:?}");
        // The same seed, the same lights.
        let lights = |seed| {
            let mut rng = StdRng::seed_from_u64(seed);
            let mut game = race(&players, &east(), &mut rng);
            (0..400).flat_map(|step| tick(&mut game, &players, &[], GO + step * 100, &mut rng)).collect::<Vec<_>>()
        };
        assert_eq!(lights(5), lights(5));
        assert_ne!(lights(5), lights(6));
    }

    #[test]
    fn on_red_whoever_moves_more_than_a_little_once_the_grace_is_over_is_out() {
        let players = members(4);
        let [a, b, c, d] = ids(&players)[..] else { unreachable!() };
        let mut rng = StdRng::seed_from_u64(4);
        let mut game = race(&players, &east(), &mut rng);
        let at_start = [(a, on(0.0, 0.0)), (b, on(0.0, 1.0)), (c, on(0.0, 2.0)), (d, on(0.0, 3.0))];
        // Running on green is the point.
        let red = until(&mut game, &players, &at_start, Phase::Red, &mut rng);
        assert_eq!(red, game.still_from - GRACE, "the red light came on time");
        // Still slowing down within the grace: nobody is out.
        let slowing = [(a, on(6.0, 0.0)), (b, on(6.5, 1.0)), (c, on(5.0, 2.0)), (d, on(4.0, 3.0))];
        assert!(tick(&mut game, &players, &slowing, red + GRACE - 1, &mut rng).is_empty());
        // Where the grace leaves them, they must stay.
        let stopped = [(a, on(6.2, 0.0)), (b, on(6.8, 1.0)), (c, on(5.1, 2.0)), (d, on(4.0, 3.0))];
        assert!(tick(&mut game, &players, &stopped, red + GRACE, &mut rng).is_empty());
        // a sways 0.3 m, which is allowed; b steps 0.31 m and is out; c goes back 0.5 m and is out too.
        let swaying = [(a, on(6.2, 0.3)), (b, on(7.11, 1.0)), (c, on(4.6, 2.0)), (d, on(4.0, 3.0))];
        let events = tick(&mut game, &players, &swaying, red + GRACE + 100, &mut rng);
        assert_eq!(
            events,
            [
                json!({"type": "out", "player": b, "reason": "moved"}),
                json!({"type": "out", "player": c, "reason": "moved"}),
            ]
        );
        // Out is out: b and c may wander now. The others hold still to the end of the red light.
        let after = [(a, on(6.2, 0.0)), (b, on(20.0, 1.0)), (c, on(0.0, 2.0)), (d, on(4.0, 3.0))];
        let green = game.phase_ends;
        assert!(tick(&mut game, &players, &after, green - 1, &mut rng).is_empty());
        let view = game.view(Some(b), red + 1_000);
        assert_eq!(view["state"], "out");
        assert_eq!(view["out"], json!([{"id": b, "name": "player1"}, {"id": c, "name": "player2"}]));
        assert_eq!(view["counts"], json!({"running": 2, "finished": 0, "out": 2}));
        // Green again: a and d run on, and the next red light takes where its own grace leaves them.
        let running = [(a, on(10.0, 0.0)), (d, on(9.0, 3.0))];
        assert_eq!(only(&tick(&mut game, &players, &running, green, &mut rng), "light")[0]["phase"], "green");
        let red = until(&mut game, &players, &running, Phase::Red, &mut rng);
        tick(&mut game, &players, &[(a, on(12.0, 0.0)), (d, on(9.0, 3.0))], red + GRACE + 50, &mut rng);
        let events = tick(&mut game, &players, &[(a, on(12.2, 0.0)), (d, on(9.0, 3.35))], red + GRACE + 100, &mut rng);
        assert_eq!(events, [json!({"type": "out", "player": d, "reason": "moved"})]);
        assert_eq!(game.view(Some(a), red + GRACE + 100)["state"], "running");
    }

    #[test]
    fn whoever_stands_past_the_start_line_as_the_race_begins_is_out() {
        let players = members(5);
        let [a, b, c, d, e] = ids(&players)[..] else { unreachable!() };
        let mut rng = StdRng::seed_from_u64(6);
        let mut game = race(&players, &east(), &mut rng);
        // During 준비 anyone may stand anywhere.
        let ready = [(a, on(0.0, 0.0)), (b, on(1.0, 1.0)), (c, on(1.1, 2.0)), (d, on(-4.0, 3.0)), (e, on(29.5, 4.0))];
        assert!(tick(&mut game, &players, &ready, GO - 50, &mut rng).is_empty());
        // As it begins, a meter past the line is allowed and more is not. e has not been seen yet.
        let lined = [(a, on(0.0, 0.0)), (b, on(1.0, 1.0)), (c, on(1.1, 2.0)), (d, on(-4.0, 3.0))];
        let events = tick(&mut game, &players, &lined, GO, &mut rng);
        assert_eq!(only(&events, "light").len(), 1);
        assert_eq!(only(&events, "out"), [&json!({"type": "out", "player": c, "reason": "early"})]);
        // Whoever turns up later is judged where they are first seen: e, near the finish, has not run there.
        let events = tick(&mut game, &players, &[(e, on(29.5, 4.0))], GO + 50, &mut rng);
        assert_eq!(events, [json!({"type": "out", "player": e, "reason": "early"})]);
        // Once seen at the start, running past it is what the race is for.
        assert!(tick(&mut game, &players, &[(a, on(5.0, 0.0)), (b, on(5.0, 1.0))], GO + 100, &mut rng).is_empty());
        assert_eq!(game.view(None, GO + 100)["counts"], json!({"running": 3, "finished": 0, "out": 2}));
    }

    #[test]
    fn reaching_the_finish_line_finishes_in_order_of_time_with_ties_sharing_a_place() {
        let players = members(4);
        let [a, b, c, d] = ids(&players)[..] else { unreachable!() };
        let mut rng = StdRng::seed_from_u64(8);
        let mut game = race(&players, &east(), &mut rng);
        let lined = [(a, on(0.0, 0.0)), (b, on(0.0, 1.0)), (c, on(0.0, 2.0)), (d, on(0.0, 3.0))];
        tick(&mut game, &players, &lined, GO, &mut rng);
        assert!(game.phase_ends >= GO + 2_000, "green for two seconds at least");
        // A meter short of the line is on it; a little shorter is not. Across the track does not matter.
        let first = [(a, on(29.0, 0.0)), (b, on(28.9, 1.0)), (c, on(33.0, -6.0)), (d, on(10.0, 3.0))];
        let events = tick(&mut game, &players, &first, GO + 1_200, &mut rng);
        assert_eq!(
            events,
            [
                json!({"type": "finished", "player": a, "time": 1_200, "rank": 1}),
                json!({"type": "finished", "player": c, "time": 1_200, "rank": 1}),
            ]
        );
        // Finished, they may walk anywhere; b gets there next.
        let next = [(a, on(0.0, 0.0)), (b, on(29.5, 1.0)), (c, on(5.0, 0.0)), (d, on(10.0, 3.0))];
        assert_eq!(only(&tick(&mut game, &players, &next, GO + 1_700, &mut rng), "finished")[0]["rank"], 3);
        let view = game.view(Some(c), GO + 1_700);
        assert_eq!(view["state"], "finished");
        assert_eq!(
            view["finished"],
            json!([
                {"id": a, "name": "player0", "time": 1_200},
                {"id": c, "name": "player2", "time": 1_200},
                {"id": b, "name": "player1", "time": 1_700},
            ])
        );
        assert!(game.result().is_none(), "d still runs");
        // d runs out of time.
        tick(&mut game, &players, &[(d, on(10.0, 3.0))], GO + RACE - 1, &mut rng);
        assert!(game.result().is_none());
        tick(&mut game, &players, &[(d, on(10.0, 3.0))], GO + RACE, &mut rng);
        assert_eq!(
            game.result().unwrap(),
            json!({
                "finished": [
                    {"id": a, "name": "player0", "time": 1_200, "rank": 1},
                    {"id": c, "name": "player2", "time": 1_200, "rank": 1},
                    {"id": b, "name": "player1", "time": 1_700, "rank": 3},
                ],
                "out": [],
                "unfinished": [{"id": d, "name": "player3"}],
            })
        );
        // Over is over.
        assert!(tick(&mut game, &players, &[(d, on(30.0, 3.0))], GO + RACE + 50, &mut rng).is_empty());
    }

    #[test]
    fn the_race_ends_once_nobody_is_running_and_those_who_leave_drop_out_of_it() {
        let players = members(3);
        let [a, b, c] = ids(&players)[..] else { unreachable!() };
        let mut rng = StdRng::seed_from_u64(9);
        let mut game = race(&players, &east(), &mut rng);
        let positions = HashMap::new();
        let mut ctx = Ctx::new(T0, &players, &positions, &mut rng);
        assert_eq!(game.act(a, &json!({"run": true}), &mut ctx), Err(BAD_ACTION));
        // c leaves during 준비: two race on.
        game.leave(c, &mut ctx);
        assert_eq!(game.view(None, T0)["counts"], json!({"running": 2, "finished": 0, "out": 0}));
        tick(&mut game, &players, &[(a, on(0.0, 0.0)), (b, on(0.0, 1.0))], GO, &mut rng);
        tick(&mut game, &players, &[(a, on(29.0, 0.0)), (b, on(3.0, 1.0))], GO + 1_000, &mut rng);
        assert!(game.result().is_none());
        // b, the last one running, leaves: it is over, and a's finish stands.
        let mut ctx = Ctx::new(GO + 1_500, &players, &positions, &mut rng);
        game.leave(b, &mut ctx);
        assert_eq!(
            game.result().unwrap(),
            json!({
                "finished": [{"id": a, "name": "player0", "time": 1_000, "rank": 1}],
                "out": [],
                "unfinished": [],
            })
        );

        // Everyone out, or out and finished: over at once.
        let mut game = race(&players, &east(), &mut rng);
        let lined = [(a, on(0.0, 0.0)), (b, on(0.0, 1.0)), (c, on(5.0, 2.0))];
        tick(&mut game, &players, &lined, GO, &mut rng);
        tick(&mut game, &players, &[(a, on(30.0, 0.0))], GO + 500, &mut rng);
        assert!(game.result().is_none(), "b still runs");
        let red = until(&mut game, &players, &[(b, on(4.0, 1.0))], Phase::Red, &mut rng);
        tick(&mut game, &players, &[(b, on(4.0, 1.0))], red + GRACE, &mut rng);
        tick(&mut game, &players, &[(b, on(5.0, 1.0))], red + GRACE + 50, &mut rng);
        let result = game.result().unwrap();
        assert_eq!(result["out"], json!([{"id": c, "name": "player2"}, {"id": b, "name": "player1"}]));
        assert_eq!(result["finished"][0]["id"], json!(a));
        assert_eq!(result["unfinished"], json!([]));
    }
}
