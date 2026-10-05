use super::*;
use crate::games::{Audience, Member};
use rand::SeedableRng;

const START: Millis = 1_000_000;
const Y: f64 = 80.0;

fn spot(x: f64, z: f64) -> [f64; 3] {
    [x, Y, z]
}

/// An 80 by 80 m loop 80 m up, a gate every 40 m, the line in the middle of its first side, running along +x first.
fn gates() -> Vec<[f64; 3]> {
    [(0.0, 0.0), (40.0, 0.0), (40.0, 40.0), (40.0, 80.0), (0.0, 80.0), (-40.0, 80.0), (-40.0, 40.0), (-40.0, 0.0)]
        .map(|(x, z)| spot(x, z))
        .to_vec()
}

/// Two columns of four slots behind the line, 2.5 m either side of the middle.
fn grid() -> Vec<[f64; 3]> {
    (0..8).map(|index| spot(-6.0 - 6.0 * (index / 2) as f64, if index % 2 == 0 { -2.5 } else { 2.5 })).collect()
}

/// One lap, a box in the middle of the first side and one in each bot lane, a boost pad on the far side.
fn layout() -> Value {
    json!({
        "checkpoints": gates(),
        "radius": 6.0,
        "grid": grid(),
        "boxes": [spot(20.0, 0.0), spot(-20.0, 80.0 - 2.5), spot(-20.0, 80.0 + 2.5)],
        "boosts": [spot(0.0, 80.0)],
        "laps": 1,
    })
}

/// The layout with `changes` over it (a null takes a field out).
fn with(changes: Value) -> Value {
    let mut layout = layout();
    for (field, value) in changes.as_object().unwrap() {
        if value.is_null() {
            layout.as_object_mut().unwrap().remove(field);
        } else {
            layout[field] = value.clone();
        }
    }
    layout
}

/// The gates from the first after the line round to the line: one lap driven down the middle.
fn lap() -> Vec<[f64; 3]> {
    let gates = gates();
    gates[1..].iter().chain(&gates[..1]).copied().collect()
}

fn members(count: usize) -> Vec<Member> {
    (0..count).map(|index| Member { id: Uuid::new_v4(), name: format!("player{index}") }).collect()
}

fn refused(layout: Value, people: usize) -> Option<GameError> {
    let players = members(people);
    let mut rng = StdRng::seed_from_u64(1);
    let positions = HashMap::new();
    let mut ctx = Ctx::new(START, &players, &positions, &mut rng);
    Kart::new(&layout, &mut ctx).err()
}

/// A race in hand: its people, where they stand in the room, its random numbers and the clock.
struct Play {
    game: Kart,
    players: Vec<Member>,
    standing: HashMap<Uuid, [f64; 3]>,
    rng: StdRng,
    now: Millis,
}

impl Play {
    fn new(people: usize, layout: Value) -> Self {
        let players = members(people);
        let mut rng = StdRng::seed_from_u64(7);
        let standing = HashMap::new();
        let mut ctx = Ctx::new(START, &players, &standing, &mut rng);
        let game = Kart::new(&layout, &mut ctx).unwrap();
        Self { game, players, standing, rng, now: START }
    }

    fn ids(&self) -> Vec<Uuid> {
        self.players.iter().map(|player| player.id).collect()
    }

    fn bots(&self) -> Vec<Uuid> {
        self.game.racers.iter().filter(|racer| racer.bot.is_some()).map(|racer| racer.id).collect()
    }

    fn racer(&self, id: Uuid) -> &Racer {
        self.game.racers.iter().find(|racer| racer.id == id).unwrap()
    }

    fn racer_mut(&mut self, id: Uuid) -> &mut Racer {
        self.game.racers.iter_mut().find(|racer| racer.id == id).unwrap()
    }

    fn stand(&mut self, who: Uuid, at: [f64; 3]) {
        self.standing.insert(who, at);
    }

    /// Ticks at `after` ms past the creation (the race starts at [`COUNTDOWN`]).
    fn tick(&mut self, after: Millis) -> Vec<(Audience, Value)> {
        self.now = START + after;
        let mut ctx = Ctx::new(self.now, &self.players, &self.standing, &mut self.rng);
        self.game.tick(&mut ctx);
        ctx.events().to_vec()
    }

    /// `who` drives through `points`, a tick every `step` ms at each.
    fn drive(&mut self, who: Uuid, points: &[[f64; 3]], step: Millis) {
        for point in points {
            self.stand(who, *point);
            self.tick(self.now - START + step);
        }
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

    /// Ticks every 50 ms from now through `until` ms past the creation, or until the race is over.
    fn run(&mut self, until: Millis) {
        let mut at = self.now - START;
        while at < until && self.game.result().is_none() {
            at += 50;
            self.tick(at);
        }
    }

    /// `who` leaves, as the framework has them: out of the players and the room first.
    fn leave(&mut self, who: Uuid) {
        self.players.retain(|player| player.id != who);
        self.standing.remove(&who);
        let mut ctx = Ctx::new(self.now, &self.players, &self.standing, &mut self.rng);
        self.game.leave(who, &mut ctx);
    }

    fn view(&self, who: Uuid) -> Value {
        self.game.view(Some(who), self.now)
    }

    fn views(&self) -> Vec<Value> {
        self.players.iter().map(|player| self.view(player.id)).chain([self.game.view(None, self.now)]).collect()
    }

    /// The order the views show, by racer.
    fn order(&self) -> Vec<Uuid> {
        let view = self.game.view(None, self.now);
        view["racers"].as_array().unwrap().iter().map(|racer| racer["id"].as_str().unwrap().parse().unwrap()).collect()
    }
}

fn item() -> Value {
    json!({"do": "item"})
}

#[test]
fn a_layout_is_checked_before_the_race_starts() {
    assert_eq!(refused(layout(), 1), None);
    for (changes, people) in [
        (json!({"checkpoints": null}), 1),
        (json!({"checkpoints": gates()[..7]}), 1),
        (json!({"checkpoints": vec![spot(0.0, 0.0); 65]}), 1),
        (
            json!({"checkpoints": [spot(0.0, 0.0), spot(0.5, 0.0), spot(40.0, 0.0), spot(40.0, 40.0), spot(40.0, 80.0),
            spot(0.0, 80.0), spot(-40.0, 80.0), spot(-40.0, 40.0)]}),
            1,
        ),
        (
            json!({"checkpoints": [spot(201.0, 0.0), spot(40.0, 0.0), spot(40.0, 40.0), spot(40.0, 80.0),
            spot(0.0, 80.0), spot(-40.0, 80.0), spot(-40.0, 40.0), spot(-40.0, 0.0)]}),
            1,
        ),
        (json!({"radius": null}), 1),
        (json!({"radius": 1.9}), 1),
        (json!({"radius": 15.1}), 1),
        (json!({"radius": "8"}), 1),
        (json!({"grid": grid()[..7]}), 1),
        (json!({"grid": null}), 1),
        (json!({"boxes": vec![spot(20.0, 0.0); 25]}), 1),
        (json!({"boosts": vec![spot(20.0, 0.0); 25]}), 1),
        (json!({"boxes": [[1.0, 2.0]]}), 1),
        (json!({"laps": 0}), 1),
        (json!({"laps": 6}), 1),
        (json!({"laps": "3"}), 1),
        (json!({"bots": 8}), 1),
        (json!({"bots": -1}), 1),
    ] {
        assert_eq!(refused(with(changes.clone()), people), Some(BAD_LAYOUT), "{changes}");
    }
    // Eight karts at most, people and bots together.
    assert_eq!(refused(with(json!({"bots": 7})), 1), None);
    assert_eq!(refused(with(json!({"bots": 3})), 6), Some(MANY_RACERS));
    // Laps three, no bots, boxes and pads none when not given.
    let play = Play::new(1, with(json!({"laps": null, "bots": null, "boxes": null, "boosts": null})));
    let view = play.view(play.ids()[0]);
    assert_eq!((view["laps"].clone(), view["racers"].as_array().unwrap().len()), (json!(3), 1));
    assert_eq!(
        (view["boxes"].clone(), view["boosts"].clone(), view["bots"].clone()),
        (json!([]), json!([]), json!([]))
    );
}

#[test]
fn everyone_starts_on_a_grid_slot_of_their_own_and_the_countdown_runs_three_seconds() {
    let mut play = Play::new(3, with(json!({"bots": 4})));
    let ids = play.ids();
    let view = play.view(ids[0]);
    assert_eq!(view["phase"], "countdown");
    assert_eq!((view["startsAt"].clone(), view["endsAt"].clone()), (json!(START + 3_000), json!(START + 3_000 + CAP)));
    assert_eq!(view["me"], json!({"lap": 0, "next": 1, "item": null}));
    assert_eq!((view["gates"].clone(), view["laps"].clone()), (json!(8), json!(1)));
    let slots: Vec<[f64; 3]> = play.game.racers.iter().map(|racer| racer.slot).collect();
    assert_eq!(slots.len(), 7);
    assert!(slots.iter().all(|slot| grid().contains(slot)));
    assert_eq!(slots.iter().map(|slot| format!("{slot:?}")).collect::<std::collections::HashSet<_>>().len(), 7);
    assert_eq!(serde_json::from_value::<[f64; 3]>(view["spawn"].clone()).unwrap(), play.racer(ids[0]).slot);
    // Colours one each; the bots' routes wait on their slots until the start.
    let colors: Vec<usize> = play.game.racers.iter().map(|racer| racer.color).collect();
    assert_eq!(colors, (0..7).collect::<Vec<_>>());
    for bot in &view["bots"].as_array().unwrap()[..] {
        assert_eq!(bot["route"]["departAt"], json!(START + 3_000));
    }
    play.tick(2_950);
    assert_eq!(play.view(ids[0])["phase"], "countdown");
    play.tick(3_000);
    assert_eq!(play.view(ids[0])["phase"], "race");
    // Someone watching sees the race but no slot or item of anyone's.
    let onlooker = play.game.view(None, play.now);
    assert_eq!((onlooker["me"].clone(), onlooker["spawn"].clone()), (Value::Null, Value::Null));
}

#[test]
fn gates_count_only_in_order_from_the_start_and_the_first_after_the_last_ends_a_lap() {
    let mut play = Play::new(1, with(json!({"laps": 2})));
    let me = play.ids()[0];
    let gates = gates();
    // Standing at the first gate during the countdown counts for nothing, even where the race then finds them.
    play.stand(me, gates[1]);
    play.tick(1_000);
    play.stand(me, gates[3]);
    play.tick(3_000);
    assert_eq!(play.racer(me).next, 1);
    // In order: gate 1, then skipping 2 for 3 counts for nothing until 2 is passed (and 3 once more after it).
    play.drive(me, &[gates[1], gates[3]], 500);
    assert_eq!(play.racer(me).next, 2);
    play.drive(me, &[gates[2], gates[3]], 500);
    assert_eq!(play.racer(me).next, 4);
    // Passing a gate on the way between two ticks counts it: 10 m before gate 4 to 10 m after it goes through it.
    play.drive(me, &[spot(10.0, 80.0)], 500);
    assert_eq!(play.racer(me).next, 4);
    play.drive(me, &[spot(-10.0, 80.0)], 500);
    assert_eq!(play.racer(me).next, 5);
    play.drive(me, &[gates[5]], 500);
    assert_eq!(play.racer(me).next, 6);
    play.drive(me, &[gates[6], gates[7]], 500);
    assert_eq!((play.racer(me).lap, play.racer(me).next), (0, 0));
    play.drive(me, &[gates[0]], 500);
    assert_eq!((play.racer(me).lap, play.racer(me).next), (1, 1));
    assert_eq!(play.view(me)["me"], json!({"lap": 1, "next": 1, "item": null}));
    // The island right under the track is not the track; a teleport is not a drive past the gates under its way.
    play.stand(me, [gates[1][0], 0.0, gates[1][2]]);
    play.tick(play.now - START + 500);
    play.stand(me, gates[3]);
    play.tick(play.now - START + 500);
    play.stand(me, spot(-40.0, 0.0));
    play.tick(play.now - START + 500);
    assert_eq!(play.racer(me).next, 1);
}

#[test]
fn the_first_to_finish_ranks_first_and_the_race_ends_once_every_person_has() {
    let mut play = Play::new(2, layout());
    let [a, b] = play.ids()[..] else { panic!() };
    play.tick(3_000);
    play.drive(a, &lap(), 500);
    let finished = play.now;
    assert_eq!(play.racer(a).finished, Some(finished - START - 3_000));
    assert_eq!(play.view(b)["endsAt"], json!(finished + FINISH_WINDOW));
    assert_eq!(play.order(), vec![a, b]);
    assert!(play.game.result().is_none());
    // Done is done: more laps change nothing.
    play.drive(a, &lap(), 500);
    assert_eq!(play.racer(a).finished, Some(finished - START - 3_000));
    play.drive(b, &lap(), 400);
    // Both are in: three seconds more, for the finish on their pages, then it is over.
    let settled = play.now;
    assert_eq!(play.view(a)["endsAt"], json!(settled + SETTLE));
    play.tick(settled - START + SETTLE - 50);
    assert!(play.game.result().is_none());
    play.tick(settled - START + SETTLE);
    let result = play.game.result().expect("over");
    let ranking = result["ranking"].as_array().unwrap();
    assert_eq!(ranking.len(), 2);
    assert_eq!(
        ranking[0],
        json!({"id": a, "name": "player0", "bot": false, "rank": 1, "finishedAt": finished - START - 3_000, "laps": 1})
    );
    assert_eq!((ranking[1]["id"].clone(), ranking[1]["rank"].clone()), (json!(b), json!(2)));
    assert_eq!(play.view(a)["phase"], "ended");
}

#[test]
fn karts_still_racing_at_the_close_rank_by_laps_then_gates_then_how_near_the_next_gate() {
    let mut play = Play::new(4, with(json!({"laps": 2})));
    let [a, b, c, d] = play.ids()[..] else { panic!() };
    let gates = gates();
    play.tick(3_000);
    // A does a lap; B gets to gate 5; C and D to gate 2, D nearer gate 3.
    play.drive(a, &lap(), 300);
    play.drive(b, &lap()[..5], 300);
    play.drive(c, &gates[1..3], 300);
    play.drive(d, &gates[1..3], 300);
    play.stand(c, spot(40.0, 50.0));
    play.stand(d, spot(40.0, 60.0));
    play.tick(play.now - START + 50);
    assert_eq!(play.order(), vec![a, b, d, c]);
    let view = play.view(c);
    let ranks: Vec<(Value, Value)> =
        view["racers"].as_array().unwrap().iter().map(|racer| (racer["rank"].clone(), racer["lap"].clone())).collect();
    assert_eq!(ranks, vec![(json!(1), json!(1)), (json!(2), json!(0)), (json!(3), json!(0)), (json!(4), json!(0))]);
    // A finishes the second lap: the others have thirty seconds.
    play.drive(a, &lap(), 300);
    let first = play.now;
    play.tick(first - START + FINISH_WINDOW - 50);
    assert!(play.game.result().is_none());
    play.tick(first - START + FINISH_WINDOW);
    let result = play.game.result().expect("over");
    let ranking: Vec<(Value, Value, Value)> = result["ranking"]
        .as_array()
        .unwrap()
        .iter()
        .map(|racer| (racer["id"].clone(), racer["finishedAt"].clone(), racer["laps"].clone()))
        .collect();
    assert_eq!(ranking[0], (json!(a), json!(first - START - 3_000), json!(2)));
    assert_eq!(
        ranking[1..],
        [(json!(b), Value::Null, json!(0)), (json!(d), Value::Null, json!(0)), (json!(c), Value::Null, json!(0))]
    );
}

#[test]
fn a_race_nobody_finishes_closes_six_minutes_after_the_start() {
    let mut play = Play::new(1, layout());
    play.tick(3_000 + CAP - 50);
    assert!(play.game.result().is_none());
    play.tick(3_000 + CAP);
    assert!(play.game.result().is_some());
}

#[test]
fn an_item_box_gives_an_empty_slot_an_item_and_comes_back_four_seconds_later() {
    let mut play = Play::new(2, layout());
    let [a, b] = play.ids()[..] else { panic!() };
    let gates = gates();
    // Nothing before the start, even standing on the box.
    play.stand(a, spot(20.0, 0.0));
    play.tick(2_000);
    assert_eq!(play.racer(a).item, None);
    play.stand(a, gates[0]);
    play.tick(3_000);
    // Driving through it (it lies between two ticks' places) takes it.
    play.drive(a, &[gates[1]], 500);
    let taken = play.now;
    assert!(play.racer(a).item.is_some());
    let item = play.racer(a).item.unwrap().name();
    assert_eq!(play.view(a)["me"]["item"], item);
    assert_eq!(play.view(b)["boxes"][0], json!({"id": 0, "position": spot(20.0, 0.0), "ready": false}));
    // Not for B meanwhile, nor for A again once its slot is full.
    play.stand(b, gates[0]);
    play.tick(taken - START + 100);
    play.drive(b, &[gates[1]], 100);
    assert_eq!(play.racer(b).item, None);
    // Back four seconds after: B takes it; A, holding one, drives over it and leaves it.
    play.tick(taken - START + RESPAWN);
    assert_eq!(play.view(b)["boxes"][0]["ready"], true);
    play.drive(a, &[gates[0], gates[1]], 100);
    assert_eq!(play.view(b)["boxes"][0]["ready"], true);
    play.drive(b, &[gates[0], gates[1]], 100);
    assert!(play.racer(b).item.is_some());
    assert_eq!(play.view(b)["boxes"][0]["ready"], false);
}

#[test]
fn a_booster_speeds_its_own_kart_and_a_bubble_traps_the_kart_just_ahead() {
    let mut play = Play::new(3, layout());
    let [a, b, c] = play.ids()[..] else { panic!() };
    let gates = gates();
    // Not before the start, not without an item, nothing unknown, nobody out of the race.
    play.racer_mut(b).item = Some(Item::Bubble);
    assert_eq!(play.act(b, item()), Err(NOT_NOW));
    play.tick(3_000);
    assert_eq!(play.act(c, item()), Err(NO_ITEM));
    assert_eq!(play.act(b, json!({"do": "fly"})), Err(BAD_ACTION));
    assert_eq!(play.act(Uuid::new_v4(), item()), Err(BAD_ACTION));
    // A leads, B second, C third.
    play.drive(a, &gates[1..4], 300);
    play.drive(b, &gates[1..3], 300);
    play.drive(c, &gates[1..2], 300);
    assert_eq!(play.order(), vec![a, b, c]);
    // B's bubble catches A, and only A hears of it.
    let events = play.act(b, item()).unwrap();
    let until = play.now + TRAP;
    assert_eq!(events, vec![(Audience::Only(vec![a]), json!({"type": "trapped", "until": until}))]);
    assert_eq!((play.racer(b).item, play.racer(a).trapped_until), (None, until));
    assert_eq!(play.view(c)["racers"][0]["trappedUntil"], json!(until));
    // A's bubble has nobody ahead: spent for nothing.
    play.racer_mut(a).item = Some(Item::Bubble);
    assert_eq!(play.act(a, item()).unwrap(), vec![]);
    assert_eq!(play.racer(a).item, None);
    // C's booster is C's own.
    play.racer_mut(c).item = Some(Item::Booster);
    let events = play.act(c, item()).unwrap();
    assert_eq!(events, vec![(Audience::Only(vec![c]), json!({"type": "boost", "until": play.now + BOOST}))]);
    assert_eq!(play.view(a)["racers"][2]["boostUntil"], json!(play.now + BOOST));
    // Once finished, the ones just behind have nobody racing ahead of them.
    play.drive(a, &lap()[3..], 300);
    play.racer_mut(b).item = Some(Item::Bubble);
    assert_eq!(play.act(b, item()).unwrap(), vec![]);
    play.racer_mut(a).item = Some(Item::Booster);
    assert_eq!(play.act(a, item()), Err(NOT_NOW));
}

#[test]
fn a_bubble_stops_a_bot_ahead_for_a_moment_and_then_it_drives_on() {
    let mut play = Play::new(1, with(json!({"bots": 1, "boxes": null})));
    let me = play.ids()[0];
    let bot = play.bots()[0];
    play.stand(me, play.racer(me).slot);
    play.run(8_000);
    assert_eq!(play.order(), vec![bot, me]);
    play.racer_mut(me).item = Some(Item::Bubble);
    assert_eq!(play.act(me, item()).unwrap(), vec![]);
    let caught = play.now;
    assert_eq!(play.racer(bot).trapped_until, caught + TRAP);
    let stopped = play.racer(bot).bot.as_ref().unwrap().route.at(caught);
    play.run(caught - START + TRAP - 50);
    assert_eq!(play.racer(bot).bot.as_ref().unwrap().route.at(play.now), stopped);
    play.run(caught - START + TRAP + 1_000);
    assert!(distance_xz(play.racer(bot).bot.as_ref().unwrap().route.at(play.now), stopped) > 10.0);
}

#[test]
fn bots_race_on_their_own_take_boxes_and_use_items_so_one_person_can_race_them() {
    let mut play = Play::new(1, with(json!({"bots": 3, "laps": 3})));
    let me = play.ids()[0];
    play.stand(me, play.racer(me).slot);
    let mut taken = false;
    let mut used = false;
    let mut at = 0;
    while play.game.result().is_none() && at < 3_000 + CAP {
        at += 50;
        play.tick(at);
        taken |= play.game.boxes.iter().any(|item| item.ready_at > play.now);
        used |= play.game.racers.iter().any(|racer| racer.boost_until > 0 || racer.trapped_until > 0);
        // Every bot's route, as the views carry it, puts it where the server has it.
        for bot in play.game.view(None, play.now)["bots"].as_array().unwrap() {
            assert!(bot["route"]["points"].as_array().unwrap().len() <= gates().len() + 2);
        }
    }
    assert!(taken && used);
    let result = play.game.result().expect("over");
    let ranking = result["ranking"].as_array().unwrap();
    assert_eq!(ranking.len(), 4);
    // The bots finished three laps each, by time; the person who never moved comes last.
    let times: Vec<u64> = ranking[..3].iter().map(|racer| racer["finishedAt"].as_u64().unwrap()).collect();
    assert!(times.windows(2).all(|pair| pair[0] <= pair[1]), "{times:?}");
    assert!(ranking[..3].iter().all(|racer| racer["bot"] == true && racer["laps"] == 3));
    assert_eq!((ranking[3]["id"].clone(), ranking[3]["laps"].clone()), (json!(me), json!(0)));
    // Three laps of 320 m at 16 to 20 m/s, give or take a lap's wobble, boosts and bubbles.
    assert!((3 * 320 * 1000 / 23..3 * 320 * 1000 / 14).contains(&times[0]), "{times:?}");
}

#[test]
fn leaving_drops_the_racer_and_the_last_person_out_ends_the_race() {
    let mut play = Play::new(2, with(json!({"bots": 2})));
    let [a, b] = play.ids()[..] else { panic!() };
    play.tick(3_000);
    play.leave(b);
    let view = play.view(a);
    assert_eq!(view["racers"].as_array().unwrap().len(), 3);
    assert!(!view.to_string().contains(&b.to_string()));
    assert!(play.game.result().is_none());
    // Someone who left does nothing more.
    assert_eq!(play.act(b, item()), Err(BAD_ACTION));
    play.leave(a);
    let result = play.game.result().expect("over");
    assert_eq!(result["ranking"].as_array().unwrap().len(), 2);
}

#[test]
fn once_the_people_left_have_all_finished_the_race_is_over() {
    let mut play = Play::new(2, layout());
    let [a, b] = play.ids()[..] else { panic!() };
    play.tick(3_000);
    play.drive(a, &lap(), 400);
    assert!(play.game.result().is_none());
    play.leave(b);
    assert!(play.game.result().is_none());
    play.tick(play.now - START + SETTLE);
    assert_eq!(play.game.result().unwrap()["ranking"][0]["id"], json!(a));
}

#[test]
fn karts_side_by_side_keep_their_order_until_one_is_a_step_nearer_the_next_gate() {
    let mut play = Play::new(2, layout());
    let [a, b] = play.ids()[..] else { panic!() };
    play.tick(3_000);
    play.stand(a, spot(30.0, 0.0));
    play.stand(b, spot(25.0, 0.0));
    play.tick(3_050);
    assert_eq!(play.order(), vec![a, b]);
    // Level, or half a meter either way: no change.
    play.stand(b, spot(29.4, 1.0));
    play.tick(3_100);
    assert_eq!(play.order(), vec![a, b]);
    play.stand(b, spot(30.5, 1.0));
    play.tick(3_150);
    assert_eq!(play.order(), vec![b, a]);
}
