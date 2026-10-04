//! 보물찾기, the reference game: gems lie on open spots of the island and walking up to one picks it up. Ten gems are
//! out at once, one in five of them gold (worth three); a picked gem comes back three seconds later somewhere else.
//! After two minutes the most points win, ties sharing a place.
//!
//! Layout (from the host's page): `{"spots": [[x, y, z], …]}`, 12 to 200 open walkable spots of the island.
//! View: `{"gems": [{id, position, value}], "scores": [{id, name, score}], "endsAt": ms}`; no secrets.
//! Event: `{"type": "collected", "player", "gem", "value"}` to everyone.
//! Result: `{"ranking": [{id, name, score, rank}]}`, best first.

use rand::Rng;
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;

use super::{BAD_ACTION, Ctx, Game, GameError, Kind, Millis, distance_xz, distinct, layout_points, pick, within};

pub(crate) const KIND: Kind = Kind::new("treasure", 1, 30, create);

const DURATION: Millis = 120_000;
/// Gems out at once.
const LIVE: usize = 10;
/// How near (on the ground) a player must come to pick a gem up, in meters.
const REACH: f64 = 1.4;
const RESPAWN: Millis = 3_000;
const MIN_SPOTS: usize = 12;
const MAX_SPOTS: usize = 200;
/// Spots closer together than this are one spot.
const SAME_SPOT: f64 = 0.5;
const GEM: u32 = 1;
const GOLD: u32 = 3;

const FEW_SPOTS: GameError = GameError::new("few_spots", "보물을 둘 빈 자리가 부족해요.");

struct Gem {
    id: u32,
    spot: usize,
    value: u32,
}

/// A picked gem waiting to come back.
struct Waiting {
    from: usize,
    at: Millis,
}

pub(crate) struct Treasure {
    spots: Vec<[f64; 3]>,
    gems: Vec<Gem>,
    waiting: Vec<Waiting>,
    /// Who plays, in the order they joined.
    players: Vec<(Uuid, String)>,
    scores: HashMap<Uuid, u32>,
    ends_at: Millis,
    over: bool,
    next_id: u32,
}

fn create(layout: &Value, ctx: &mut Ctx) -> Result<Box<dyn Game>, GameError> {
    let spots = distinct(layout_points(layout, "spots", MIN_SPOTS, MAX_SPOTS)?, SAME_SPOT);
    if spots.len() < MIN_SPOTS {
        return Err(FEW_SPOTS);
    }
    let mut game = Treasure {
        spots,
        gems: Vec::with_capacity(LIVE),
        waiting: Vec::new(),
        players: ctx.players().iter().map(|player| (player.id, player.name.clone())).collect(),
        scores: HashMap::new(),
        ends_at: ctx.now() + DURATION,
        over: false,
        next_id: 1,
    };
    for _ in 0..LIVE {
        game.spawn(ctx, None);
    }
    Ok(Box::new(game))
}

impl Treasure {
    /// A gem on a free spot (not `from`, where one was just picked up), gold one time in five. Not within anyone's
    /// reach, where it would be picked up the moment it appears, unless every free spot is.
    fn spawn(&mut self, ctx: &mut Ctx, from: Option<usize>) {
        let free: Vec<usize> = (0..self.spots.len())
            .filter(|spot| Some(*spot) != from && !self.gems.iter().any(|gem| gem.spot == *spot))
            .collect();
        let standing = ctx.positions();
        let clear: Vec<usize> = free
            .iter()
            .copied()
            .filter(|spot| !standing.values().any(|at| within(self.spots[*spot], *at, REACH)))
            .collect();
        let Some(&spot) = pick(ctx.rng(), if clear.is_empty() { &free } else { &clear }) else { return };
        let value = if ctx.rng().gen_ratio(1, 5) { GOLD } else { GEM };
        self.gems.push(Gem { id: self.next_id, spot, value });
        self.next_id += 1;
    }

    fn score(&self, player: Uuid) -> u32 {
        self.scores.get(&player).copied().unwrap_or(0)
    }
}

impl Game for Treasure {
    fn view(&self, _viewer: Option<Uuid>, _now: Millis) -> Value {
        json!({
            "gems": self.gems.iter().map(|gem| json!({
                "id": gem.id,
                "position": self.spots[gem.spot],
                "value": gem.value,
            })).collect::<Vec<_>>(),
            "scores": self.players.iter().map(|(id, name)| json!({
                "id": id,
                "name": name,
                "score": self.score(*id),
            })).collect::<Vec<_>>(),
            "endsAt": self.ends_at,
        })
    }

    fn act(&mut self, _player: Uuid, _action: &Value, _ctx: &mut Ctx) -> Result<(), GameError> {
        // Walking is the whole game; nothing is sent.
        Err(BAD_ACTION)
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        if self.over {
            return;
        }
        let now = ctx.now();
        if now >= self.ends_at {
            self.over = true;
            self.gems.clear();
            self.waiting.clear();
            return;
        }
        let (due, waiting): (Vec<Waiting>, Vec<Waiting>) =
            std::mem::take(&mut self.waiting).into_iter().partition(|waiting| waiting.at <= now);
        self.waiting = waiting;
        for gem in due {
            self.spawn(ctx, Some(gem.from));
        }
        // Each gem goes to the nearest player within reach; at the same distance, to whoever joined first.
        let mut picked: Vec<(u32, Uuid)> = Vec::new();
        for gem in &self.gems {
            let spot = self.spots[gem.spot];
            let nearest = self
                .players
                .iter()
                .filter_map(|(id, _)| Some((*id, distance_xz(ctx.position(*id)?, spot))))
                .filter(|(_, distance)| *distance <= REACH)
                .min_by(|a, b| a.1.total_cmp(&b.1));
            if let Some((player, _)) = nearest {
                picked.push((gem.id, player));
            }
        }
        for (id, player) in picked {
            let Some(at) = self.gems.iter().position(|gem| gem.id == id) else { continue };
            let gem = self.gems.remove(at);
            *self.scores.entry(player).or_default() += gem.value;
            self.waiting.push(Waiting { from: gem.spot, at: now + RESPAWN });
            ctx.emit(json!({"type": "collected", "player": player, "gem": gem.id, "value": gem.value}));
        }
    }

    fn leave(&mut self, player: Uuid, _ctx: &mut Ctx) {
        self.players.retain(|(id, _)| *id != player);
        self.scores.remove(&player);
    }

    fn result(&self) -> Option<Value> {
        if !self.over {
            return None;
        }
        // Best first; equal scores keep the order the players joined in and share a place.
        let mut ranking: Vec<(Uuid, &str, u32)> =
            self.players.iter().map(|(id, name)| (*id, name.as_str(), self.score(*id))).collect();
        ranking.sort_by_key(|entry| std::cmp::Reverse(entry.2));
        let ranking: Vec<Value> = ranking
            .iter()
            .map(|(id, name, score)| {
                let rank = 1 + ranking.iter().filter(|other| other.2 > *score).count();
                json!({"id": id, "name": name, "score": score, "rank": rank})
            })
            .collect();
        Some(json!({"ranking": ranking}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::{Audience, Member};
    use rand::{SeedableRng, rngs::StdRng};

    const START: Millis = 1_000_000;

    fn members(count: usize) -> Vec<Member> {
        (0..count).map(|index| Member { id: Uuid::new_v4(), name: format!("player{index}") }).collect()
    }

    /// `count` spots 3 m apart, twenty to a row.
    fn spots(count: usize) -> Value {
        let at = |index: usize| [(index % 20) as f64 * 3.0 - 30.0, 0.0, (index / 20) as f64 * 3.0 - 15.0];
        json!({"spots": (0..count).map(at).collect::<Vec<_>>()})
    }

    fn started(players: &[Member], layout: &Value, rng: &mut StdRng) -> Box<dyn Game> {
        let positions = HashMap::new();
        let mut ctx = Ctx::new(START, players, &positions, rng);
        create(layout, &mut ctx).unwrap()
    }

    fn view(game: &dyn Game) -> Value {
        game.view(None, START)
    }

    fn gems(game: &dyn Game) -> Vec<Value> {
        view(game)["gems"].as_array().unwrap().clone()
    }

    fn at(gem: &Value) -> [f64; 3] {
        serde_json::from_value(gem["position"].clone()).unwrap()
    }

    /// Ticks `game` at `now` with the players standing at `standing`; returns the events.
    fn tick(
        game: &mut dyn Game,
        players: &[Member],
        standing: &[(Uuid, [f64; 3])],
        now: Millis,
        rng: &mut StdRng,
    ) -> Vec<(Audience, Value)> {
        let positions: HashMap<Uuid, [f64; 3]> = standing.iter().copied().collect();
        let mut ctx = Ctx::new(now, players, &positions, rng);
        game.tick(&mut ctx);
        ctx.events().to_vec()
    }

    #[test]
    fn layouts_need_twelve_to_two_hundred_points_on_the_island() {
        let players = members(1);
        let mut rng = StdRng::seed_from_u64(1);
        let positions = HashMap::new();
        let mut ctx = Ctx::new(START, &players, &positions, &mut rng);
        let refused = |layout: Value, ctx: &mut Ctx| create(&layout, ctx).err();
        assert_eq!(refused(json!(null), &mut ctx), Some(crate::games::BAD_LAYOUT));
        assert_eq!(refused(json!({"spots": "here"}), &mut ctx), Some(crate::games::BAD_LAYOUT));
        assert_eq!(refused(spots(11), &mut ctx), Some(crate::games::BAD_LAYOUT));
        assert_eq!(refused(spots(201), &mut ctx), Some(crate::games::BAD_LAYOUT));
        let mut layout = spots(12);
        for bad in
            [json!([1.0, 0.0]), json!([1.0, 0.0, 200.5]), json!(["1", 0, 0]), json!([0, 0, 0, 0]), json!({"x": 1})]
        {
            layout["spots"][3] = bad.clone();
            assert_eq!(refused(layout.clone(), &mut ctx), Some(crate::games::BAD_LAYOUT), "{bad}");
        }
        // Twelve points, but two of them the same spot.
        let mut doubled = spots(12);
        doubled["spots"][11] = doubled["spots"][0].clone();
        assert_eq!(refused(doubled, &mut ctx), Some(FEW_SPOTS));
        let mut edge = spots(12);
        edge["spots"][0] = json!([-200.0, -3.5, 200]);
        assert!(create(&edge, &mut ctx).is_ok());
        assert!(create(&spots(200), &mut ctx).is_ok());
    }

    #[test]
    fn ten_gems_lie_on_different_spots_and_some_are_gold() {
        let players = members(2);
        let mut rng = StdRng::seed_from_u64(7);
        let game = started(&players, &spots(40), &mut rng);
        let laid = gems(game.as_ref());
        assert_eq!(laid.len(), LIVE);
        let mut places: Vec<String> = laid.iter().map(|gem| gem["position"].to_string()).collect();
        places.sort();
        places.dedup();
        assert_eq!(places.len(), LIVE);
        assert!(laid.iter().all(|gem| matches!(gem["value"].as_u64(), Some(1 | 3))));
        assert_eq!(view(game.as_ref())["endsAt"], START + DURATION);
        assert_eq!(view(game.as_ref())["scores"][1]["score"], 0);
        // Over many gems about one in five is gold.
        let mut rng = StdRng::seed_from_u64(11);
        let gold: usize = (0..200)
            .map(|_| gems(started(&players, &spots(40), &mut rng).as_ref()).iter().filter(|g| g["value"] == 3).count())
            .sum();
        assert!((300..500).contains(&gold), "{gold} of 2000");
    }

    #[test]
    fn the_same_seed_lays_the_same_gems() {
        let players = members(1);
        let first = started(&players, &spots(60), &mut StdRng::seed_from_u64(3));
        let again = started(&players, &spots(60), &mut StdRng::seed_from_u64(3));
        assert_eq!(view(first.as_ref()), view(again.as_ref()));
    }

    #[test]
    fn walking_within_reach_picks_a_gem_up_and_it_comes_back_elsewhere_three_seconds_later() {
        let players = members(2);
        let (me, other) = (players[0].id, players[1].id);
        let mut rng = StdRng::seed_from_u64(5);
        let mut game = started(&players, &spots(12), &mut rng);
        let target = gems(game.as_ref())[0].clone();
        let spot = at(&target);
        let value = target["value"].as_u64().unwrap();
        // Just out of reach, then just within it (on the ground; height does not count).
        let out = [spot[0] + 1.41, spot[1], spot[2]];
        assert!(tick(game.as_mut(), &players, &[(me, out)], START + 100, &mut rng).is_empty());
        let near = [spot[0] + 0.8, spot[1] + 5.0, spot[2] + 1.1];
        let events = tick(game.as_mut(), &players, &[(me, near), (other, [90.0, 0.0, 90.0])], START + 200, &mut rng);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, Audience::Everyone);
        assert_eq!(events[0].1, json!({"type": "collected", "player": me, "gem": target["id"], "value": value}));
        assert_eq!(gems(game.as_ref()).len(), LIVE - 1);
        assert!(gems(game.as_ref()).iter().all(|gem| gem["id"] != target["id"]));
        let scores = view(game.as_ref())["scores"].clone();
        assert_eq!(
            scores,
            json!([{"id": me, "name": "player0", "score": value}, {"id": other, "name": "player1", "score": 0}])
        );
        // Standing still on the empty spot picks nothing more up; the gem waits three seconds.
        tick(game.as_mut(), &players, &[(me, near)], START + 3_199, &mut rng);
        assert_eq!(gems(game.as_ref()).len(), LIVE - 1);
        tick(game.as_mut(), &players, &[(me, [90.0, 0.0, 90.0])], START + 3_200, &mut rng);
        let back = gems(game.as_ref());
        assert_eq!(back.len(), LIVE);
        let reborn = back.iter().max_by_key(|gem| gem["id"].as_u64()).unwrap();
        assert_ne!(at(reborn), spot, "comes back somewhere else");
        let mut places: Vec<String> = back.iter().map(|gem| gem["position"].to_string()).collect();
        places.sort();
        places.dedup();
        assert_eq!(places.len(), LIVE, "on a free spot");
    }

    #[test]
    fn gems_are_not_laid_under_anyones_feet_while_another_spot_is_free() {
        let players = members(2);
        let layout = spots(12);
        let under = |index: usize| -> [f64; 3] { serde_json::from_value(layout["spots"][index].clone()).unwrap() };
        // Two players on two of the twelve spots: the ten gems take the other ten, game after game.
        let standing = HashMap::from([(players[0].id, under(0)), (players[1].id, [under(5)[0] + 0.5, 0.0, under(5)[2]])]);
        for seed in 0..40 {
            let mut rng = StdRng::seed_from_u64(seed);
            let mut ctx = Ctx::new(START, &players, &standing, &mut rng);
            let game = create(&layout, &mut ctx).unwrap();
            let laid: Vec<[f64; 3]> = gems(game.as_ref()).iter().map(at).collect();
            assert!(!laid.contains(&under(0)) && !laid.contains(&under(5)), "seed {seed}");
        }
        // With every spot within someone's reach, gems still come out.
        let crowd = members(12);
        let everywhere: HashMap<Uuid, [f64; 3]> = crowd.iter().enumerate().map(|(index, player)| (player.id, under(index))).collect();
        let mut rng = StdRng::seed_from_u64(1);
        let mut ctx = Ctx::new(START, &crowd, &everywhere, &mut rng);
        assert_eq!(gems(create(&layout, &mut ctx).unwrap().as_ref()).len(), LIVE);
    }

    #[test]
    fn a_gem_between_two_players_goes_to_the_nearer() {
        let players = members(2);
        let (first, second) = (players[0].id, players[1].id);
        let mut rng = StdRng::seed_from_u64(9);
        let mut game = started(&players, &spots(30), &mut rng);
        let spot = at(&gems(game.as_ref())[0]);
        let events = tick(
            game.as_mut(),
            &players,
            &[(first, [spot[0] + 1.0, 0.0, spot[2]]), (second, [spot[0], 0.0, spot[2] + 0.5])],
            START + 100,
            &mut rng,
        );
        assert_eq!(events[0].1["player"], json!(second));
    }

    #[test]
    fn the_game_ends_after_two_minutes_and_ties_share_a_place() {
        let players = members(3);
        let (a, b, c) = (players[0].id, players[1].id, players[2].id);
        let mut rng = StdRng::seed_from_u64(21);
        let mut game = started(&players, &spots(24), &mut rng);
        // b and c each pick up the gem they stand on; a picks up nothing.
        let laid = gems(game.as_ref());
        let (gem_b, gem_c) = (&laid[0], &laid[1]);
        tick(game.as_mut(), &players, &[(b, at(gem_b)), (c, at(gem_c))], START + 500, &mut rng);
        let (score_b, score_c) = (gem_b["value"].as_u64().unwrap(), gem_c["value"].as_u64().unwrap());
        assert!(game.result().is_none());
        tick(game.as_mut(), &players, &[], START + DURATION - 1, &mut rng);
        assert!(game.result().is_none());
        tick(game.as_mut(), &players, &[], START + DURATION, &mut rng);
        let result = game.result().unwrap();
        let ranking = result["ranking"].as_array().unwrap();
        assert_eq!(ranking.len(), 3);
        assert_eq!(ranking[2], json!({"id": a, "name": "player0", "score": 0, "rank": 3}));
        if score_b == score_c {
            assert_eq!((ranking[0]["rank"].as_u64(), ranking[1]["rank"].as_u64()), (Some(1), Some(1)));
            assert_eq!((&ranking[0]["id"], &ranking[1]["id"]), (&json!(b), &json!(c)), "joined first, listed first");
        } else {
            assert_eq!((ranking[0]["rank"].as_u64(), ranking[1]["rank"].as_u64()), (Some(1), Some(2)));
        }
        // Nothing is picked up once it is over, and the gems are gone.
        assert!(gems(game.as_ref()).is_empty());
        assert!(tick(game.as_mut(), &players, &[(a, [0.0; 3])], START + DURATION + 100, &mut rng).is_empty());
    }

    #[test]
    fn ties_share_the_place_above_the_next_score() {
        let players = members(4);
        let mut rng = StdRng::seed_from_u64(2);
        let mut game = Treasure {
            spots: Vec::new(),
            gems: Vec::new(),
            waiting: Vec::new(),
            players: players.iter().map(|player| (player.id, player.name.clone())).collect(),
            scores: HashMap::from([(players[0].id, 2), (players[1].id, 5), (players[2].id, 5), (players[3].id, 1)]),
            ends_at: START,
            over: false,
            next_id: 1,
        };
        tick(&mut game, &players, &[], START, &mut rng);
        let ranks: Vec<(Value, u64)> = game.result().unwrap()["ranking"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| (entry["id"].clone(), entry["rank"].as_u64().unwrap()))
            .collect();
        assert_eq!(
            ranks,
            vec![
                (json!(players[1].id), 1),
                (json!(players[2].id), 1),
                (json!(players[0].id), 3),
                (json!(players[3].id), 4)
            ]
        );
    }

    #[test]
    fn a_player_who_leaves_drops_out_of_the_scores_and_actions_are_refused() {
        let players = members(2);
        let mut rng = StdRng::seed_from_u64(4);
        let mut game = started(&players, &spots(12), &mut rng);
        let positions = HashMap::new();
        let mut ctx = Ctx::new(START, &players, &positions, &mut rng);
        assert_eq!(game.act(players[0].id, &json!({"dig": true}), &mut ctx), Err(BAD_ACTION));
        game.leave(players[0].id, &mut ctx);
        assert_eq!(view(game.as_ref())["scores"], json!([{"id": players[1].id, "name": "player1", "score": 0}]));
    }
}
