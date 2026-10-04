//! OX 퀴즈: a statement is shown and everyone walks into the O zone (true) or the X zone (false). Whoever is not
//! inside the right zone when time is up goes out, unless that would be everyone still in; then nobody does. Up to ten
//! statements from the bank ([`questions`]), none twice; the last ones standing win.
//!
//! A round is 문제 (12 s to walk) and then 정답 (4 s: the answer and who went out). The game ends after the last round,
//! after a round that leaves one player in (or none), or as soon as leaving does.
//!
//! Layout (from the host's page): `{"o": [x, y, z], "x": [x, y, z]}`, two spots 12 to 30 m apart on the ground; a zone
//! is the ground within 4.5 m of its spot.
//! View: `{"round", "rounds", "statement", "phase": "question"|"answer", "endsAt", "answer": "o"|"x"|null,
//! "fallen": [{id, name}], "survivors": [{id, name}], "out": [{id, name, round}], "me": {"state": "in"|"out",
//! "zone": "o"|"x"|null}|null, "zones": {"o", "x", "radius"}}`. The answer and `fallen` (who went out at this lock)
//! are there only during 정답; `me` is for players, with the zone they stood in at the last tick.
//! Events, to everyone: `{"type": "round", "round", "rounds", "statement", "endsAt"}` as a statement is shown, and
//! `{"type": "answer", "round", "answer", "out": [ids], "spared"}` at its lock (`spared`: all still in were wrong).
//! Result: `{"winners": [{id, name}], "out": [{id, name, round}]}`, who went out latest first.

use serde_json::{Value, json};
use uuid::Uuid;

use super::{BAD_ACTION, BAD_LAYOUT, Ctx, Game, GameError, Kind, Millis, distance_xz, pick_many, point, within};

#[path = "ox_questions.rs"]
mod questions;

use questions::{BANK, Question};

pub(crate) const KIND: Kind = Kind::new("ox", 2, 30, create).ticking(10);

/// Statements one game asks at most.
const ROUNDS: usize = 10;
/// 문제: how long everyone has to walk into a zone.
const ASKING: Millis = 12_000;
/// 정답: how long the answer shows before the next statement.
const SHOWING: Millis = 4_000;
/// How far a zone reaches from its spot on the ground, in meters.
const RADIUS: f64 = 4.5;
/// How far apart the two spots are on the ground: the zones keep well apart, and one is a short run from the other.
const MIN_APART: f64 = 12.0;
const MAX_APART: f64 = 30.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Zone {
    O,
    X,
}

impl Zone {
    /// The zone that stands for `answer`.
    fn of(answer: bool) -> Self {
        if answer { Self::O } else { Self::X }
    }

    fn name(self) -> &'static str {
        match self {
            Self::O => "o",
            Self::X => "x",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    /// 문제: walking into a zone.
    Question,
    /// 정답: the answer shows.
    Answer,
}

struct Player {
    id: Uuid,
    name: String,
    /// The round (from 1) at whose lock they went out.
    out: Option<usize>,
    /// The zone they stood in at the last tick.
    zone: Option<Zone>,
}

struct Ox {
    o: [f64; 3],
    x: [f64; 3],
    /// The statements this game asks, in order.
    questions: Vec<&'static Question>,
    /// The one being asked now, from 0.
    round: usize,
    phase: Phase,
    /// When this phase ends.
    ends_at: Millis,
    /// In the order they joined.
    players: Vec<Player>,
    /// Who went out at this round's lock, while its answer shows.
    fallen: Vec<Uuid>,
    over: bool,
}

fn create(layout: &Value, ctx: &mut Ctx) -> Result<Box<dyn Game>, GameError> {
    Ok(Box::new(Ox::new(layout, ctx)?))
}

impl Ox {
    fn new(layout: &Value, ctx: &mut Ctx) -> Result<Self, GameError> {
        // The host's page picked these: check them before anyone walks to them.
        let o = point(layout.get("o").ok_or(BAD_LAYOUT)?)?;
        let x = point(layout.get("x").ok_or(BAD_LAYOUT)?)?;
        if !(MIN_APART..=MAX_APART).contains(&distance_xz(o, x)) {
            return Err(BAD_LAYOUT);
        }
        let bank: Vec<&'static Question> = BANK.iter().collect();
        let game = Self {
            o,
            x,
            questions: pick_many(ctx.rng(), &bank, ROUNDS),
            round: 0,
            phase: Phase::Question,
            ends_at: ctx.now() + ASKING,
            players: ctx
                .players()
                .iter()
                .map(|player| Player { id: player.id, name: player.name.clone(), out: None, zone: None })
                .collect(),
            fallen: Vec::new(),
            over: false,
        };
        game.announce(ctx);
        Ok(game)
    }

    fn question(&self) -> &'static Question {
        self.questions[self.round]
    }

    /// The zone whose ground `at` stands on, if any (they are too far apart to overlap).
    fn zone_at(o: [f64; 3], x: [f64; 3], at: [f64; 3]) -> Option<Zone> {
        if within(o, at, RADIUS) {
            Some(Zone::O)
        } else if within(x, at, RADIUS) {
            Some(Zone::X)
        } else {
            None
        }
    }

    fn still_in(&self) -> usize {
        self.players.iter().filter(|player| player.out.is_none()).count()
    }

    fn announce(&self, ctx: &mut Ctx) {
        ctx.emit(json!({
            "type": "round",
            "round": self.round + 1,
            "rounds": self.questions.len(),
            "statement": self.question().statement,
            "endsAt": self.ends_at,
        }));
    }

    /// Time is up: everyone still in who is not standing in the right zone goes out, unless that is all of them.
    fn lock(&mut self, ctx: &mut Ctx) {
        let right = Zone::of(self.question().answer);
        let wrong: Vec<Uuid> = self
            .players
            .iter()
            .filter(|player| player.out.is_none() && player.zone != Some(right))
            .map(|player| player.id)
            .collect();
        let spared = !wrong.is_empty() && wrong.len() == self.still_in();
        self.fallen = if spared { Vec::new() } else { wrong };
        let round = self.round + 1;
        for player in &mut self.players {
            if self.fallen.contains(&player.id) {
                player.out = Some(round);
            }
        }
        self.phase = Phase::Answer;
        self.ends_at = ctx.now() + SHOWING;
        ctx.emit(json!({
            "type": "answer",
            "round": round,
            "answer": right.name(),
            "out": self.fallen,
            "spared": spared,
        }));
    }

    /// The next statement, after an answer has shown.
    fn next(&mut self, ctx: &mut Ctx) {
        self.round += 1;
        self.phase = Phase::Question;
        self.fallen.clear();
        self.ends_at = ctx.now() + ASKING;
        self.announce(ctx);
    }

    fn person(player: &Player) -> Value {
        json!({"id": player.id, "name": player.name})
    }

    fn survivors(&self) -> Vec<Value> {
        self.players.iter().filter(|player| player.out.is_none()).map(Self::person).collect()
    }

    /// Who went out and at which round: the latest first, those of one round in the order they joined.
    fn gone(&self) -> Vec<Value> {
        let mut gone: Vec<(&Player, usize)> =
            self.players.iter().filter_map(|player| Some((player, player.out?))).collect();
        gone.sort_by_key(|(_, round)| std::cmp::Reverse(*round));
        gone.into_iter().map(|(player, round)| json!({"id": player.id, "name": player.name, "round": round})).collect()
    }
}

impl Game for Ox {
    fn view(&self, viewer: Option<Uuid>, _now: Millis) -> Value {
        let answering = self.phase == Phase::Answer;
        let me = viewer.and_then(|id| self.players.iter().find(|player| player.id == id)).map(|player| {
            json!({
                "state": if player.out.is_some() { "out" } else { "in" },
                "zone": player.zone.map(Zone::name),
            })
        });
        json!({
            "round": self.round + 1,
            "rounds": self.questions.len(),
            "statement": self.question().statement,
            "phase": if answering { "answer" } else { "question" },
            "endsAt": self.ends_at,
            // Only once time is up: it is what everyone is guessing.
            "answer": answering.then(|| Zone::of(self.question().answer).name()),
            "fallen": self
                .players
                .iter()
                .filter(|player| self.fallen.contains(&player.id))
                .map(Self::person)
                .collect::<Vec<_>>(),
            "survivors": self.survivors(),
            "out": self.gone(),
            "me": me,
            "zones": {"o": self.o, "x": self.x, "radius": RADIUS},
        })
    }

    fn act(&mut self, _player: Uuid, _action: &Value, _ctx: &mut Ctx) -> Result<(), GameError> {
        // Where you stand is your answer; nothing is sent.
        Err(BAD_ACTION)
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        if self.over {
            return;
        }
        let (o, x) = (self.o, self.x);
        for player in &mut self.players {
            player.zone = ctx.position(player.id).and_then(|at| Self::zone_at(o, x, at));
        }
        if ctx.now() < self.ends_at {
            return;
        }
        match self.phase {
            Phase::Question => self.lock(ctx),
            Phase::Answer if self.round + 1 >= self.questions.len() || self.still_in() <= 1 => self.over = true,
            Phase::Answer => self.next(ctx),
        }
    }

    fn leave(&mut self, player: Uuid, _ctx: &mut Ctx) {
        self.players.retain(|other| other.id != player);
        self.fallen.retain(|other| *other != player);
        // While a statement is asked, one player in (or none) has won already: no answer could put them out. While
        // an answer shows, the round ends as it would have.
        if self.phase == Phase::Question && self.still_in() <= 1 {
            self.over = true;
        }
    }

    fn result(&self) -> Option<Value> {
        self.over.then(|| json!({"winners": self.survivors(), "out": self.gone()}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::{Audience, Member};
    use rand::{SeedableRng, rngs::StdRng};
    use std::collections::{HashMap, HashSet};

    const START: Millis = 1_000_000;
    const O: [f64; 3] = [-8.0, 0.0, 2.0];
    const X: [f64; 3] = [8.0, 0.0, 2.0];
    /// Between the zones, in neither.
    const MIDDLE: [f64; 3] = [0.0, 0.0, 2.0];
    /// How long a round takes when every tick comes on time.
    const ROUND: Millis = ASKING + SHOWING;

    fn members(count: usize) -> Vec<Member> {
        (0..count).map(|index| Member { id: Uuid::new_v4(), name: format!("player{index}") }).collect()
    }

    fn layout() -> Value {
        json!({"o": O, "x": X})
    }

    /// A game of `players` started at `START`, and what it announced.
    fn started(players: &[Member], rng: &mut StdRng) -> (Ox, Vec<(Audience, Value)>) {
        let positions = HashMap::new();
        let mut ctx = Ctx::new(START, players, &positions, rng);
        let game = Ox::new(&layout(), &mut ctx).unwrap();
        (game, ctx.events().to_vec())
    }

    /// Ticks `game` at `now` with `players` standing at `standing` (the others unplaced); returns the events.
    fn tick(
        game: &mut Ox,
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

    /// The spot of the zone that is right (or wrong) for the statement asked now.
    fn spot(game: &Ox, right: bool) -> [f64; 3] {
        if game.question().answer == right { O } else { X }
    }

    fn view(game: &Ox, viewer: Option<Uuid>) -> Value {
        game.view(viewer, START)
    }

    fn ids(players: &[&Member]) -> Value {
        json!(players.iter().map(|player| player.id).collect::<Vec<_>>())
    }

    fn people(players: &[&Member]) -> Value {
        json!(players.iter().map(|player| json!({"id": player.id, "name": player.name})).collect::<Vec<_>>())
    }

    fn out(players: &[(&Member, usize)]) -> Value {
        json!(
            players
                .iter()
                .map(|(player, round)| json!({"id": player.id, "name": player.name, "round": round}))
                .collect::<Vec<_>>()
        )
    }

    #[test]
    fn layouts_need_two_points_twelve_to_thirty_meters_apart_on_the_ground() {
        let players = members(2);
        let mut rng = StdRng::seed_from_u64(1);
        let positions = HashMap::new();
        let mut ctx = Ctx::new(START, &players, &positions, &mut rng);
        let refused = |layout: Value, ctx: &mut Ctx| Ox::new(&layout, ctx).err();
        for bad in [
            json!(null),
            json!([O, X]),
            json!({"o": O}),
            json!({"x": X}),
            json!({"o": [0, 0], "x": X}),
            json!({"o": ["0", 0, 0], "x": X}),
            json!({"o": O, "x": [8.0, 0.0, 200.5]}),
            json!({"o": O, "x": {"x": 8, "y": 0, "z": 2}}),
            // Too near: the zones would almost touch; too far to cross in time.
            json!({"o": [0, 0, 0], "x": [11.99, 0, 0]}),
            json!({"o": [0, 0, 0], "x": [30.01, 0, 0]}),
            json!({"o": [0, 0, 0], "x": [0, 40, 0]}),
        ] {
            assert_eq!(refused(bad.clone(), &mut ctx), Some(BAD_LAYOUT), "{bad}");
        }
        // Height does not count, only the ground between them; both ends of the range are in.
        assert!(Ox::new(&json!({"o": [0, 0, 0], "x": [12, 30, 0]}), &mut ctx).is_ok());
        assert!(Ox::new(&json!({"o": [-18, 0, 0], "x": [0, -2, 24]}), &mut ctx).is_ok());
        assert!(Ox::new(&json!({"o": [-200, 0, 200], "x": [-190, 0, 190]}), &mut ctx).is_ok());
        assert_eq!(create(&json!({"o": O}), &mut ctx).err(), Some(BAD_LAYOUT));
        assert!(create(&layout(), &mut ctx).is_ok());
    }

    #[test]
    fn a_round_asks_for_twelve_seconds_then_shows_the_answer_for_four() {
        let players = members(3);
        let mut rng = StdRng::seed_from_u64(1);
        let (mut game, events) = started(&players, &mut rng);
        let first = game.question().statement;
        assert_eq!(
            events,
            [(
                Audience::Everyone,
                json!({"type": "round", "round": 1, "rounds": 10, "statement": first, "endsAt": START + 12_000})
            )]
        );
        let seen = view(&game, Some(players[0].id));
        assert_eq!((seen["round"].clone(), seen["rounds"].clone()), (json!(1), json!(10)));
        assert_eq!((seen["statement"].as_str(), seen["phase"].as_str()), (Some(first), Some("question")));
        assert_eq!(seen["endsAt"], START + 12_000);
        assert_eq!((seen["answer"].clone(), seen["fallen"].clone()), (Value::Null, json!([])));
        assert_eq!(seen["zones"], json!({"o": O, "x": X, "radius": 4.5}));
        assert_eq!(seen["survivors"], people(&players.iter().collect::<Vec<_>>()));
        assert_eq!(seen["out"], json!([]));

        // Everyone stands in the right zone, so nobody goes out.
        let right = spot(&game, true);
        let all_right: Vec<(Uuid, [f64; 3])> = players.iter().map(|player| (player.id, right)).collect();
        assert!(tick(&mut game, &players, &all_right, START + 11_999, &mut rng).is_empty());
        assert_eq!(view(&game, None)["phase"], "question");
        let events = tick(&mut game, &players, &all_right, START + 12_000, &mut rng);
        let answer = Zone::of(game.question().answer).name();
        assert_eq!(
            events,
            [(Audience::Everyone, json!({"type": "answer", "round": 1, "answer": answer, "out": [], "spared": false}))]
        );
        let shown = view(&game, None);
        assert_eq!((shown["phase"].as_str(), shown["answer"].as_str()), (Some("answer"), Some(answer)));
        assert_eq!((shown["endsAt"].clone(), shown["statement"].as_str()), (json!(START + 16_000), Some(first)));
        assert_eq!(shown["survivors"].as_array().unwrap().len(), 3);

        assert!(tick(&mut game, &players, &all_right, START + 15_999, &mut rng).is_empty());
        assert_eq!(view(&game, None)["phase"], "answer");
        let events = tick(&mut game, &players, &all_right, START + 16_000, &mut rng);
        let second = game.question().statement;
        assert_ne!(second, first);
        assert_eq!(
            events,
            [(
                Audience::Everyone,
                json!({"type": "round", "round": 2, "rounds": 10, "statement": second, "endsAt": START + 28_000})
            )]
        );
        let asked = view(&game, None);
        assert_eq!((asked["round"].clone(), asked["phase"].as_str()), (json!(2), Some("question")));
        assert_eq!((asked["answer"].clone(), asked["endsAt"].clone()), (Value::Null, json!(START + 28_000)));
        assert!(game.result().is_none());
    }

    #[test]
    fn at_the_lock_whoever_is_not_on_the_right_zones_ground_goes_out() {
        let players = members(6);
        let [a, b, c, d, e, f] = [0, 1, 2, 3, 4, 5].map(|index| &players[index]);
        let mut rng = StdRng::seed_from_u64(2);
        let (mut game, _) = started(&players, &mut rng);
        let (right, wrong) = (spot(&game, true), spot(&game, false));
        let (right_zone, wrong_zone) = (Zone::of(game.question().answer).name(), Zone::of(!game.question().answer).name());
        let shifted = |dx: f64, dy: f64| [right[0] + dx, right[1] + dy, right[2]];
        // a on the zone's very edge, b high over its spot (height does not count), c just past the edge, d in the
        // other zone, e nowhere the room knows, f in the right zone until the last moment.
        let before = [
            (a.id, shifted(4.5, 0.0)),
            (b.id, shifted(0.0, 9.0)),
            (c.id, shifted(4.51, 0.0)),
            (d.id, wrong),
            (f.id, right),
        ];
        tick(&mut game, &players, &before, START + 11_900, &mut rng);
        let zone = |player: &Member| view(&game, Some(player.id))["me"].clone();
        assert_eq!(zone(a), json!({"state": "in", "zone": right_zone}));
        assert_eq!(zone(b), json!({"state": "in", "zone": right_zone}));
        assert_eq!(zone(c), json!({"state": "in", "zone": null}));
        assert_eq!(zone(d), json!({"state": "in", "zone": wrong_zone}));
        assert_eq!(zone(e), json!({"state": "in", "zone": null}));
        assert_eq!(zone(f), json!({"state": "in", "zone": right_zone}));
        assert_eq!(view(&game, None)["me"], Value::Null, "someone watching stands nowhere");

        let mut at_lock = before;
        at_lock[4] = (f.id, MIDDLE);
        let events = tick(&mut game, &players, &at_lock, START + 12_000, &mut rng);
        assert_eq!(events[0].1["out"], ids(&[c, d, e, f]));
        assert_eq!(events[0].1["spared"], false);
        let shown = view(&game, Some(c.id));
        assert_eq!(shown["fallen"], people(&[c, d, e, f]));
        assert_eq!(shown["survivors"], people(&[a, b]));
        assert_eq!(shown["out"], out(&[(c, 1), (d, 1), (e, 1), (f, 1)]));
        assert_eq!(shown["me"], json!({"state": "out", "zone": null}));
        assert_eq!(view(&game, Some(a.id))["me"]["state"], "in");

        // Walking in after the lock saves no one.
        let late: Vec<(Uuid, [f64; 3])> = players.iter().map(|player| (player.id, right)).collect();
        tick(&mut game, &players, &late, START + 13_000, &mut rng);
        assert_eq!(view(&game, Some(c.id))["me"], json!({"state": "out", "zone": right_zone}));
        assert_eq!(view(&game, None)["survivors"], people(&[a, b]));
    }

    #[test]
    fn when_everyone_still_in_is_wrong_nobody_goes_out() {
        let players = members(4);
        let [a, b, c, d] = [0, 1, 2, 3].map(|index| &players[index]);
        let mut rng = StdRng::seed_from_u64(3);
        let (mut game, _) = started(&players, &mut rng);
        // Round 1: d alone is wrong and goes out.
        let right = spot(&game, true);
        let standing = [(a.id, right), (b.id, right), (c.id, right), (d.id, spot(&game, false))];
        tick(&mut game, &players, &standing, START + ASKING, &mut rng);
        tick(&mut game, &players, &standing, START + ROUND, &mut rng);
        // Round 2: a and b wrong, c in neither zone; d, already out, in the right one does not count.
        let lock = START + ROUND + ASKING;
        let standing =
            [(a.id, spot(&game, false)), (b.id, spot(&game, false)), (c.id, MIDDLE), (d.id, spot(&game, true))];
        let events = tick(&mut game, &players, &standing, lock, &mut rng);
        let answer = Zone::of(game.question().answer).name();
        assert_eq!(
            events,
            [(Audience::Everyone, json!({"type": "answer", "round": 2, "answer": answer, "out": [], "spared": true}))]
        );
        let shown = view(&game, Some(a.id));
        assert_eq!((shown["fallen"].clone(), shown["survivors"].clone()), (json!([]), people(&[a, b, c])));
        assert_eq!(shown["out"], out(&[(d, 1)]));
        assert_eq!(shown["me"]["state"], "in");
        // Round 3: nobody placed at all counts the same.
        tick(&mut game, &players, &[], lock + SHOWING, &mut rng);
        assert_eq!(view(&game, None)["round"], 3);
        let events = tick(&mut game, &players, &[], lock + SHOWING + ASKING, &mut rng);
        assert_eq!((events[0].1["out"].clone(), events[0].1["spared"].clone()), (json!([]), json!(true)));
        assert_eq!(view(&game, None)["survivors"], people(&[a, b, c]));
    }

    #[test]
    fn a_round_that_leaves_one_player_in_ends_the_game_once_its_answer_has_shown() {
        let players = members(3);
        let [a, b, c] = [0, 1, 2].map(|index| &players[index]);
        let mut rng = StdRng::seed_from_u64(4);
        let (mut game, _) = started(&players, &mut rng);
        let standing = [(a.id, spot(&game, true)), (b.id, spot(&game, false)), (c.id, MIDDLE)];
        tick(&mut game, &players, &standing, START + ASKING, &mut rng);
        assert!(game.result().is_none(), "the answer shows first");
        assert!(tick(&mut game, &players, &standing, START + ROUND - 1, &mut rng).is_empty());
        assert!(game.result().is_none());
        assert!(tick(&mut game, &players, &standing, START + ROUND, &mut rng).is_empty(), "no next statement");
        assert_eq!(game.result(), Some(json!({"winners": people(&[a]), "out": out(&[(b, 1), (c, 1)])})));
        // Over is over: nothing moves on.
        assert!(tick(&mut game, &players, &standing, START + 10 * ROUND, &mut rng).is_empty());
        assert_eq!(view(&game, None)["round"], 1);
    }

    #[test]
    fn ten_different_statements_are_asked_and_whoever_is_left_after_the_last_wins() {
        let players = members(2);
        for seed in 0..25 {
            let mut rng = StdRng::seed_from_u64(seed);
            let (mut game, _) = started(&players, &mut rng);
            let mut asked = vec![game.question().statement];
            for round in 0..10 {
                let at = START + round * ROUND;
                let right: Vec<(Uuid, [f64; 3])> = players.iter().map(|player| (player.id, spot(&game, true))).collect();
                tick(&mut game, &players, &right, at + ASKING, &mut rng);
                assert!(game.result().is_none(), "seed {seed}, round {round}");
                let events = tick(&mut game, &players, &right, at + ROUND, &mut rng);
                if round < 9 {
                    assert_eq!(events[0].1["statement"], game.question().statement);
                    asked.push(game.question().statement);
                } else {
                    assert!(events.is_empty());
                }
            }
            assert_eq!(asked.iter().collect::<HashSet<_>>().len(), 10, "seed {seed}: {asked:?}");
            assert!(asked.iter().all(|statement| BANK.iter().any(|question| question.statement == *statement)));
            let all: Vec<&Member> = players.iter().collect();
            assert_eq!(game.result(), Some(json!({"winners": people(&all), "out": []})), "seed {seed}");
        }
        // The same seed asks the same statements.
        let first = started(&players, &mut StdRng::seed_from_u64(9)).0;
        let again = started(&players, &mut StdRng::seed_from_u64(9)).0;
        let statements = |game: &Ox| game.questions.iter().map(|question| question.statement).collect::<Vec<_>>();
        assert_eq!(statements(&first), statements(&again));
    }

    /// `players` standing for the statement asked now: those in `wrong` in the wrong zone, the rest in the right one.
    fn answering(game: &Ox, players: &[Member], wrong: &[&Member]) -> Vec<(Uuid, [f64; 3])> {
        players.iter().map(|player| (player.id, spot(game, !wrong.iter().any(|w| w.id == player.id)))).collect()
    }

    #[test]
    fn who_went_out_is_listed_latest_first_and_leaving_during_an_answer_lets_it_show() {
        let players = members(5);
        let [a, b, c, d, e] = [0, 1, 2, 3, 4].map(|index| &players[index]);
        let mut rng = StdRng::seed_from_u64(5);
        let (mut game, _) = started(&players, &mut rng);
        // e goes out in round 1, c and d in round 2.
        let round1 = answering(&game, &players, &[e]);
        tick(&mut game, &players, &round1, START + ASKING, &mut rng);
        tick(&mut game, &players, &round1, START + ROUND, &mut rng);
        let round2 = answering(&game, &players, &[c, d]);
        tick(&mut game, &players, &round2, START + ROUND + ASKING, &mut rng);
        assert_eq!(view(&game, None)["out"], out(&[(c, 2), (d, 2), (e, 1)]));
        assert_eq!(view(&game, None)["fallen"], people(&[c, d]));

        // d, just out, leaves: the lists drop d. Then b leaves, so a alone is in; the answer still shows.
        let positions = HashMap::new();
        let mut ctx = Ctx::new(START + ROUND + ASKING + 1_000, &players, &positions, &mut rng);
        game.leave(d.id, &mut ctx);
        game.leave(b.id, &mut ctx);
        assert!(ctx.events().is_empty());
        assert!(game.result().is_none());
        let shown = view(&game, None);
        assert_eq!((shown["phase"].as_str(), shown["fallen"].clone()), (Some("answer"), people(&[c])));
        assert_eq!((shown["survivors"].clone(), shown["out"].clone()), (people(&[a]), out(&[(c, 2), (e, 1)])));
        let left = [a.clone(), c.clone(), e.clone()];
        assert!(tick(&mut game, &left, &[], START + 2 * ROUND, &mut rng).is_empty());
        assert_eq!(game.result(), Some(json!({"winners": people(&[a]), "out": out(&[(c, 2), (e, 1)])})));
    }

    #[test]
    fn leaving_while_a_statement_is_asked_ends_the_game_once_one_player_is_in() {
        let players = members(3);
        let [a, b, c] = [0, 1, 2].map(|index| &players[index]);
        let mut rng = StdRng::seed_from_u64(6);
        let (mut game, _) = started(&players, &mut rng);
        let positions = HashMap::new();
        let mut ctx = Ctx::new(START + 500, &players[..2], &positions, &mut rng);
        game.leave(c.id, &mut ctx);
        assert!(game.result().is_none(), "two are still in");
        assert_eq!(view(&game, None)["survivors"], people(&[a, b]));
        let mut ctx = Ctx::new(START + 700, &players[1..2], &positions, &mut rng);
        game.leave(a.id, &mut ctx);
        assert_eq!(game.result(), Some(json!({"winners": people(&[b]), "out": []})));
    }

    #[test]
    fn players_send_nothing() {
        let players = members(2);
        let mut rng = StdRng::seed_from_u64(7);
        let (mut game, _) = started(&players, &mut rng);
        let before = view(&game, Some(players[0].id));
        let positions = HashMap::new();
        let mut ctx = Ctx::new(START + 1, &players, &positions, &mut rng);
        for action in [json!({"zone": "o"}), json!(null), json!({"type": "answer", "answer": true})] {
            assert_eq!(game.act(players[0].id, &action, &mut ctx), Err(BAD_ACTION));
        }
        assert!(ctx.events().is_empty());
        assert_eq!(view(&game, Some(players[0].id)), before);
    }
}
