//! 술래잡기 (infection tag): one player in five, picked at random, starts as 술래 (it) and everyone else runs. After a
//! six-second head start, a runner an it comes within 1.5 m of (on the ground) becomes an it too. The runners still
//! free after two and a half minutes win; once none are left, the its have won.
//!
//! Layout (from the host's page): `{"spots": [[x, y, z], …]}`, 12 to 200 open walkable spots of the island. The players
//! start spread over them: during the head start each one's view has their own start spot, and their page puts them there.
//! View: `{"role": "it"|"runner", "spot", "its": [ids], "runners": [ids], "counts": {its, runners}, "safeUntil",
//! "endsAt"}`; `role` and `spot` are the viewer's own, and until `safeUntil` nobody is caught.
//! Event: `{"type": "caught", "player", "by"}` to everyone.
//! Result: `{"winner": "runners"|"its", "runners": [{id, name}], "its": [{id, name}], "caught": [{id, name, by, byName,
//! time}]}`: the runners left, who started as it, and who was caught by whom in order, `time` in ms since the start.

use rand::{Rng, rngs::StdRng};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{BAD_ACTION, Ctx, Game, GameError, Kind, Millis, distance_xz, distinct, layout_points, pick_many};

pub(crate) const KIND: Kind = Kind::new("tag", 3, 30, create);

const DURATION: Millis = 150_000;
/// How long nobody can be caught, from the start.
const HEAD_START: Millis = 6_000;
/// How near (on the ground) an it must come to catch a runner, in meters.
const REACH: f64 = 1.5;
/// One it for every this many players, and one at least.
const PER_IT: usize = 5;
const MIN_SPOTS: usize = 12;
const MAX_SPOTS: usize = 200;
/// Spots closer together than this are one spot.
const SAME_SPOT: f64 = 0.5;

const FEW_SPOTS: GameError = GameError::new("few_spots", "흩어져 설 빈 자리가 부족해요.");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    It,
    Runner,
}

impl Role {
    fn name(self) -> &'static str {
        match self {
            Self::It => "it",
            Self::Runner => "runner",
        }
    }
}

struct Player {
    id: Uuid,
    name: String,
    role: Role,
    /// Where they start.
    spot: [f64; 3],
}

struct Catch {
    player: Uuid,
    name: String,
    by: Uuid,
    by_name: String,
    /// Since the start.
    time: Millis,
}

pub(crate) struct Tag {
    /// In the order they joined.
    players: Vec<Player>,
    /// Who started as it.
    first: Vec<(Uuid, String)>,
    caught: Vec<Catch>,
    began: Millis,
    safe_until: Millis,
    ends_at: Millis,
    over: bool,
}

fn create(layout: &Value, ctx: &mut Ctx) -> Result<Box<dyn Game>, GameError> {
    Ok(Box::new(Tag::new(layout, ctx)?))
}

/// `count` places among `spots`, each as far as it can be from those before it (the first at random); once every spot is
/// taken, the same order again.
fn spread(rng: &mut StdRng, spots: &[[f64; 3]], count: usize) -> Vec<[f64; 3]> {
    let mut order = vec![rng.gen_range(0..spots.len())];
    // How far each spot is from the nearest one taken; a taken one never comes up again.
    let mut nearest: Vec<f64> = spots.iter().map(|spot| distance_xz(*spot, spots[order[0]])).collect();
    nearest[order[0]] = f64::NEG_INFINITY;
    while order.len() < count.min(spots.len()) {
        let Some((next, _)) = nearest.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)) else { break };
        order.push(next);
        for (spot, distance) in spots.iter().zip(nearest.iter_mut()) {
            *distance = distance.min(distance_xz(*spot, spots[next]));
        }
        nearest[next] = f64::NEG_INFINITY;
    }
    (0..count).map(|index| spots[order[index % order.len()]]).collect()
}

impl Tag {
    fn new(layout: &Value, ctx: &mut Ctx) -> Result<Self, GameError> {
        let spots = distinct(layout_points(layout, "spots", MIN_SPOTS, MAX_SPOTS)?, SAME_SPOT);
        if spots.len() < MIN_SPOTS {
            return Err(FEW_SPOTS);
        }
        let players = ctx.players();
        let everyone: Vec<Uuid> = players.iter().map(|player| player.id).collect();
        let its = pick_many(ctx.rng(), &everyone, (players.len() / PER_IT).max(1));
        // The its take the first places, as far apart as they can be; the runners the next, away from them.
        let places = spread(ctx.rng(), &spots, players.len());
        let (mut it_places, mut runner_places) = (places[..its.len()].iter(), places[its.len()..].iter());
        let players: Vec<Player> = players
            .iter()
            .map(|player| {
                let role = if its.contains(&player.id) { Role::It } else { Role::Runner };
                let place = if role == Role::It { it_places.next() } else { runner_places.next() };
                Player { id: player.id, name: player.name.clone(), role, spot: *place.unwrap_or(&spots[0]) }
            })
            .collect();
        let first = players
            .iter()
            .filter(|player| player.role == Role::It)
            .map(|player| (player.id, player.name.clone()))
            .collect();
        let began = ctx.now();
        Ok(Self {
            players,
            first,
            caught: Vec::new(),
            began,
            safe_until: began + HEAD_START,
            ends_at: began + DURATION,
            over: false,
        })
    }

    fn with(&self, role: Role) -> impl Iterator<Item = &Player> {
        self.players.iter().filter(move |player| player.role == role)
    }
}

impl Game for Tag {
    fn view(&self, viewer: Option<Uuid>, now: Millis) -> Value {
        let me = viewer.and_then(|id| self.players.iter().find(|player| player.id == id));
        let ids = |role| self.with(role).map(|player| player.id).collect::<Vec<_>>();
        let (its, runners) = (ids(Role::It), ids(Role::Runner));
        json!({
            "role": me.map(|player| player.role.name()),
            "spot": me.filter(|_| now < self.safe_until).map(|player| player.spot),
            "counts": {"its": its.len(), "runners": runners.len()},
            "its": its,
            "runners": runners,
            "safeUntil": self.safe_until,
            "endsAt": self.ends_at,
        })
    }

    fn act(&mut self, _player: Uuid, _action: &Value, _ctx: &mut Ctx) -> Result<(), GameError> {
        // Running and catching are all by where everyone stands; nothing is sent.
        Err(BAD_ACTION)
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        if self.over {
            return;
        }
        let now = ctx.now();
        if now >= self.ends_at {
            self.over = true;
            return;
        }
        if now < self.safe_until {
            return;
        }
        // The its as this tick began: whoever is caught now catches others from the next tick on.
        let hunters: Vec<(usize, [f64; 3])> = self
            .players
            .iter()
            .enumerate()
            .filter(|(_, player)| player.role == Role::It)
            .filter_map(|(index, player)| Some((index, ctx.position(player.id)?)))
            .collect();
        // Each runner within reach goes to the nearest it; at the same distance, to whoever joined first.
        let mut caught: Vec<(usize, usize)> = Vec::new();
        for (index, runner) in self.players.iter().enumerate().filter(|(_, player)| player.role == Role::Runner) {
            let Some(at) = ctx.position(runner.id) else { continue };
            let nearest = hunters
                .iter()
                .map(|(hunter, place)| (*hunter, distance_xz(*place, at)))
                .filter(|(_, distance)| *distance <= REACH)
                .min_by(|a, b| a.1.total_cmp(&b.1));
            if let Some((hunter, _)) = nearest {
                caught.push((index, hunter));
            }
        }
        let time = now - self.began;
        for (runner, hunter) in caught {
            self.players[runner].role = Role::It;
            let (player, by) = (&self.players[runner], &self.players[hunter]);
            self.caught.push(Catch {
                player: player.id,
                name: player.name.clone(),
                by: by.id,
                by_name: by.name.clone(),
                time,
            });
            ctx.emit(json!({"type": "caught", "player": player.id, "by": by.id}));
        }
        if self.with(Role::Runner).next().is_none() {
            self.over = true;
        }
    }

    fn leave(&mut self, player: Uuid, _ctx: &mut Ctx) {
        self.players.retain(|other| other.id != player);
        // No it left to catch anyone, or nobody left to catch: either way it is over.
        if self.with(Role::It).next().is_none() || self.with(Role::Runner).next().is_none() {
            self.over = true;
        }
    }

    fn result(&self) -> Option<Value> {
        if !self.over {
            return None;
        }
        let runners: Vec<Value> =
            self.with(Role::Runner).map(|player| json!({"id": player.id, "name": player.name})).collect();
        Some(json!({
            "winner": if runners.is_empty() { "its" } else { "runners" },
            "runners": runners,
            "its": self.first.iter().map(|(id, name)| json!({"id": id, "name": name})).collect::<Vec<_>>(),
            "caught": self.caught.iter().map(|catch| json!({
                "id": catch.player,
                "name": catch.name,
                "by": catch.by,
                "byName": catch.by_name,
                "time": catch.time,
            })).collect::<Vec<_>>(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::{Audience, BAD_LAYOUT, Member};
    use rand::SeedableRng;
    use std::collections::HashMap;

    const T0: Millis = 2_000_000;
    /// When catching begins.
    const SAFE: Millis = T0 + HEAD_START;

    fn members(count: usize) -> Vec<Member> {
        (0..count).map(|index| Member { id: Uuid::new_v4(), name: format!("player{index}") }).collect()
    }

    /// `count` spots 4 m apart, ten to a row.
    fn spots(count: usize) -> Value {
        let at = |index: usize| [(index % 10) as f64 * 4.0 - 20.0, 0.0, (index / 10) as f64 * 4.0 - 20.0];
        json!({"spots": (0..count).map(at).collect::<Vec<_>>()})
    }

    fn started(players: &[Member], rng: &mut StdRng) -> Tag {
        let positions = HashMap::new();
        let mut ctx = Ctx::new(T0, players, &positions, rng);
        Tag::new(&spots(40), &mut ctx).unwrap()
    }

    /// A game of `players` whose its are exactly `its`.
    fn chasing(players: &[Member], its: &[Uuid], rng: &mut StdRng) -> Tag {
        let mut game = started(players, rng);
        for player in &mut game.players {
            player.role = if its.contains(&player.id) { Role::It } else { Role::Runner };
        }
        game.first = game.with(Role::It).map(|player| (player.id, player.name.clone())).collect();
        game
    }

    /// Ticks `game` at `now` with the players standing at `standing`; returns the events, which all go to everyone.
    fn tick(
        game: &mut Tag,
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

    fn its(game: &Tag) -> Vec<Uuid> {
        game.with(Role::It).map(|player| player.id).collect()
    }

    #[test]
    fn layouts_need_twelve_to_two_hundred_spots_on_the_island() {
        let players = members(3);
        let mut rng = StdRng::seed_from_u64(1);
        let positions = HashMap::new();
        let mut ctx = Ctx::new(T0, &players, &positions, &mut rng);
        let refused = |layout: Value, ctx: &mut Ctx| Tag::new(&layout, ctx).err();
        assert_eq!(refused(json!(null), &mut ctx), Some(BAD_LAYOUT));
        assert_eq!(refused(json!({"spots": "here"}), &mut ctx), Some(BAD_LAYOUT));
        assert_eq!(refused(spots(11), &mut ctx), Some(BAD_LAYOUT));
        assert_eq!(refused(spots(201), &mut ctx), Some(BAD_LAYOUT));
        let mut layout = spots(12);
        for bad in [json!([1.0, 0.0]), json!([1.0, 0.0, -200.5]), json!(["1", 0, 0]), json!(null)] {
            layout["spots"][5] = bad.clone();
            assert_eq!(refused(layout.clone(), &mut ctx), Some(BAD_LAYOUT), "{bad}");
        }
        // Twelve points, two of them the same spot.
        let mut doubled = spots(12);
        doubled["spots"][11] = json!([-20.2, 0.0, -20.1]);
        assert_eq!(refused(doubled, &mut ctx), Some(FEW_SPOTS));
        assert!(Tag::new(&spots(12), &mut ctx).is_ok());
        assert!(Tag::new(&spots(200), &mut ctx).is_ok());
    }

    #[test]
    fn one_player_in_five_starts_as_it_picked_at_random() {
        for (count, expected) in [(3, 1), (4, 1), (5, 1), (9, 1), (10, 2), (14, 2), (15, 3), (29, 5), (30, 6)] {
            let players = members(count);
            let game = started(&players, &mut StdRng::seed_from_u64(count as u64));
            assert_eq!(its(&game).len(), expected, "{count} players");
            let view = game.view(None, T0);
            assert_eq!(view["counts"], json!({"its": expected, "runners": count - expected}));
            assert_eq!(view["its"].as_array().unwrap().len() + view["runners"].as_array().unwrap().len(), count);
        }
        // Each player is it now and then; the same seed picks the same.
        let players = members(4);
        let mut picked = std::collections::HashSet::new();
        for seed in 0..40 {
            picked.extend(its(&started(&players, &mut StdRng::seed_from_u64(seed))));
        }
        assert_eq!(picked.len(), 4);
        let pick = |seed| its(&started(&players, &mut StdRng::seed_from_u64(seed)));
        assert_eq!(pick(7), pick(7));
    }

    #[test]
    fn everyone_starts_spread_out_and_sees_their_own_start_spot_and_role_until_the_head_start_ends() {
        let players = members(6);
        let mut rng = StdRng::seed_from_u64(3);
        let game = started(&players, &mut rng);
        let starts: Vec<[f64; 3]> = players
            .iter()
            .map(|player| serde_json::from_value(game.view(Some(player.id), T0)["spot"].clone()).unwrap())
            .collect();
        // As far apart as can be: no spot of the forty is farther from every start than two starts are from each other.
        let gap = starts
            .iter()
            .enumerate()
            .flat_map(|(index, spot)| starts[index + 1..].iter().map(|other| distance_xz(*spot, *other)))
            .fold(f64::INFINITY, f64::min);
        assert!(gap >= 8.0, "{gap}");
        for spot in serde_json::from_value::<Vec<[f64; 3]>>(spots(40)["spots"].clone()).unwrap() {
            let nearest = starts.iter().map(|start| distance_xz(*start, spot)).fold(f64::INFINITY, f64::min);
            assert!(nearest <= gap, "{spot:?} is {nearest} m from the nearest start");
        }
        let it = its(&game)[0];
        let view = game.view(Some(it), T0);
        assert_eq!((view["role"].as_str(), view["its"].clone()), (Some("it"), json!([it])));
        let runner = players.iter().find(|player| player.id != it).unwrap().id;
        assert_eq!(game.view(Some(runner), T0)["role"], "runner");
        assert_eq!((game.view(None, T0)["role"].clone(), game.view(None, T0)["spot"].clone()), (Value::Null, Value::Null));
        assert_eq!(view["safeUntil"], SAFE);
        assert_eq!(view["endsAt"], T0 + DURATION);
        // Once the head start is over, nobody is sent to their start again.
        assert!(game.view(Some(runner), SAFE - 1)["spot"].is_array());
        assert_eq!(game.view(Some(runner), SAFE)["spot"], Value::Null);
        // Thirty on twelve spots: every spot is used before any is used twice.
        let crowd = members(30);
        let positions = HashMap::new();
        let mut ctx = Ctx::new(T0, &crowd, &positions, &mut rng);
        let game = Tag::new(&spots(12), &mut ctx).unwrap();
        let mut uses: HashMap<String, usize> = HashMap::new();
        for player in &game.players {
            *uses.entry(format!("{:?}", player.spot)).or_default() += 1;
        }
        assert_eq!(uses.len(), 12);
        assert!(uses.values().all(|count| (2..=3).contains(count)), "{uses:?}");
    }

    #[test]
    fn nobody_is_caught_during_the_head_start() {
        let players = members(3);
        let [it, a, b] = [players[0].id, players[1].id, players[2].id];
        let mut rng = StdRng::seed_from_u64(4);
        let mut game = chasing(&players, &[it], &mut rng);
        let touching = [(it, [0.0; 3]), (a, [0.5, 0.0, 0.0]), (b, [0.0, 0.0, 0.5])];
        for now in [T0, T0 + 100, SAFE - 1] {
            assert!(tick(&mut game, &players, &touching, now, &mut rng).is_empty());
        }
        assert_eq!(its(&game), [it]);
        let events = tick(&mut game, &players, &touching, SAFE, &mut rng);
        assert_eq!(
            events,
            [json!({"type": "caught", "player": a, "by": it}), json!({"type": "caught", "player": b, "by": it})]
        );
    }

    #[test]
    fn an_it_catches_a_runner_within_one_and_a_half_meters_on_the_ground() {
        let players = members(4);
        let [it, a, b, c] = [players[0].id, players[1].id, players[2].id, players[3].id];
        let mut rng = StdRng::seed_from_u64(5);
        let mut game = chasing(&players, &[it], &mut rng);
        // a just out of reach; b too, however near overhead; c nowhere yet.
        let standing = [(it, [0.0; 3]), (a, [1.51, 0.0, 0.0]), (b, [0.0, 0.2, 1.6])];
        assert!(tick(&mut game, &players, &standing, SAFE + 100, &mut rng).is_empty());
        // Exactly 1.5 m away on the ground (0.9 by 1.2), whatever the height.
        let standing = [(it, [0.0; 3]), (a, [0.9, 2.0, 1.2]), (b, [0.0, 0.2, 1.6]), (c, [90.0, 0.0, 0.0])];
        assert_eq!(
            tick(&mut game, &players, &standing, SAFE + 200, &mut rng),
            [json!({"type": "caught", "player": a, "by": it})]
        );
        let view = game.view(Some(a), SAFE + 200);
        assert_eq!(view["role"], "it");
        assert_eq!((view["its"].clone(), view["runners"].clone()), (json!([it, a]), json!([b, c])));
        assert_eq!(view["counts"], json!({"its": 2, "runners": 2}));
    }

    #[test]
    fn whoever_is_caught_catches_others_from_the_next_tick_on() {
        let players = members(4);
        let [it, a, b, c] = [players[0].id, players[1].id, players[2].id, players[3].id];
        let mut rng = StdRng::seed_from_u64(6);
        let mut game = chasing(&players, &[it], &mut rng);
        // A chain: a by the it, b by a but out of the it's reach, c by b.
        let chain = [(it, [0.0; 3]), (a, [1.4, 0.0, 0.0]), (b, [2.8, 0.0, 0.0]), (c, [4.2, 0.0, 0.0])];
        assert_eq!(tick(&mut game, &players, &chain, SAFE, &mut rng), [json!({"type": "caught", "player": a, "by": it})]);
        assert_eq!(tick(&mut game, &players, &chain, SAFE + 100, &mut rng), [json!({"type": "caught", "player": b, "by": a})]);
        assert!(game.result().is_none());
        assert_eq!(tick(&mut game, &players, &chain, SAFE + 200, &mut rng), [json!({"type": "caught", "player": c, "by": b})]);
        // With nobody left to catch, the its have won.
        let result = game.result().unwrap();
        assert_eq!(result["winner"], "its");
        assert_eq!(result["runners"], json!([]));
        assert_eq!(result["its"], json!([{"id": it, "name": "player0"}]));
        assert_eq!(
            result["caught"],
            json!([
                {"id": a, "name": "player1", "by": it, "byName": "player0", "time": HEAD_START},
                {"id": b, "name": "player2", "by": a, "byName": "player1", "time": HEAD_START + 100},
                {"id": c, "name": "player3", "by": b, "byName": "player2", "time": HEAD_START + 200},
            ])
        );
        assert!(tick(&mut game, &players, &chain, SAFE + 300, &mut rng).is_empty(), "over is over");
    }

    #[test]
    fn a_runner_between_two_its_goes_to_the_nearer_and_at_the_same_distance_to_whoever_joined_first() {
        let players = members(4);
        let [first, second, a, b] = [players[0].id, players[1].id, players[2].id, players[3].id];
        let mut rng = StdRng::seed_from_u64(7);
        let mut game = chasing(&players, &[first, second], &mut rng);
        let standing = [(first, [0.0; 3]), (second, [2.0, 0.0, 0.0]), (a, [1.2, 0.0, 0.0]), (b, [1.0, 0.0, 20.0])];
        assert_eq!(tick(&mut game, &players, &standing, SAFE, &mut rng)[0]["by"], json!(second));
        let standing = [(first, [0.0, 0.0, 19.0]), (second, [2.0, 0.0, 19.0]), (b, [1.0, 0.0, 19.0])];
        assert_eq!(tick(&mut game, &players, &standing, SAFE + 100, &mut rng)[0]["by"], json!(first));
    }

    #[test]
    fn after_two_and_a_half_minutes_the_runners_left_win() {
        let players = members(5);
        let [it, a, b, c, d] = [players[0].id, players[1].id, players[2].id, players[3].id, players[4].id];
        let mut rng = StdRng::seed_from_u64(8);
        let mut game = chasing(&players, &[it], &mut rng);
        tick(&mut game, &players, &[(it, [0.0; 3]), (a, [1.0, 0.0, 0.0])], SAFE + 42_000, &mut rng);
        let far = [(it, [0.0; 3]), (b, [9.0, 0.0, 0.0]), (c, [-9.0, 0.0, 0.0]), (d, [0.0, 0.0, 9.0])];
        tick(&mut game, &players, &far, T0 + DURATION - 1, &mut rng);
        assert!(game.result().is_none());
        tick(&mut game, &players, &far, T0 + DURATION, &mut rng);
        assert_eq!(
            game.result().unwrap(),
            json!({
                "winner": "runners",
                "runners": [{"id": b, "name": "player2"}, {"id": c, "name": "player3"}, {"id": d, "name": "player4"}],
                "its": [{"id": it, "name": "player0"}],
                "caught": [{"id": a, "name": "player1", "by": it, "byName": "player0", "time": HEAD_START + 42_000}],
            })
        );
    }

    #[test]
    fn the_game_ends_when_the_last_it_or_the_last_runner_leaves_and_actions_are_refused() {
        let players = members(4);
        let [it, a, b, c] = [players[0].id, players[1].id, players[2].id, players[3].id];
        let mut rng = StdRng::seed_from_u64(9);
        let positions = HashMap::new();
        let mut game = chasing(&players, &[it], &mut rng);
        let mut ctx = Ctx::new(T0, &players, &positions, &mut rng);
        assert_eq!(game.act(a, &json!({"tag": b}), &mut ctx), Err(BAD_ACTION));
        // A runner leaving changes only the counts.
        game.leave(c, &mut ctx);
        assert!(game.result().is_none());
        assert_eq!(game.view(None, T0)["counts"], json!({"its": 1, "runners": 2}));
        // The only it leaving: nobody can be caught any more, and the runners have won.
        game.leave(it, &mut ctx);
        let result = game.result().unwrap();
        assert_eq!(result["winner"], "runners");
        assert_eq!(result["runners"], json!([{"id": a, "name": "player1"}, {"id": b, "name": "player2"}]));

        // The last runner leaving: the its have won.
        let mut game = chasing(&players, &[it, a], &mut rng);
        let mut ctx = Ctx::new(T0, &players, &positions, &mut rng);
        game.leave(b, &mut ctx);
        assert!(game.result().is_none());
        game.leave(c, &mut ctx);
        assert_eq!(game.result().unwrap()["winner"], "its");
    }
}
