use super::*;
use crate::games::{Audience, BAD_LAYOUT, Member};
use rand::{SeedableRng, rngs::StdRng};
use std::collections::HashSet;

const START: Millis = 1_000_000;
const TABLE: [f64; 3] = [0.0, 0.0, 0.0];
const VENTS: [[f64; 3]; 3] = [[-20.0, 0.0, 30.0], [0.0, 0.0, 30.0], [20.0, 0.0, 30.0]];
/// Where nobody's station, the table or a vent is near.
const NOWHERE: [f64; 3] = [60.0, 0.0, 60.0];

fn members(count: usize) -> Vec<Member> {
    (0..count).map(|index| Member { id: Uuid::new_v4(), name: format!("player{index}") }).collect()
}

/// The table at the origin, `count` stations 8 m apart in a row 30 m north of it, and three vents 30 m south.
fn layout(count: usize) -> Value {
    let stations: Vec<[f64; 3]> = (0..count).map(|index| [index as f64 * 8.0 - 40.0, 0.0, -30.0]).collect();
    json!({"table": TABLE, "stations": stations, "vents": VENTS})
}

/// The same with `bots` bots, and the role of someone playing alone.
fn with_bots(bots: usize, role: Option<&str>) -> Value {
    let mut layout = layout(8);
    layout["bots"] = json!(bots);
    layout["role"] = json!(role);
    layout
}

fn refused(layout: Value, people: usize) -> Option<GameError> {
    let players = members(people);
    let mut rng = StdRng::seed_from_u64(1);
    let positions = HashMap::new();
    let mut ctx = Ctx::new(START, &players, &positions, &mut rng);
    Impostor::new(&layout, &mut ctx).err()
}

fn task() -> Value {
    json!({"do": "task"})
}

fn finish() -> Value {
    json!({"do": "finish"})
}

fn kill(target: Uuid) -> Value {
    json!({"do": "kill", "target": target})
}

fn report(body: u32) -> Value {
    json!({"do": "report", "body": body})
}

fn call() -> Value {
    json!({"do": "meeting"})
}

fn vote(target: Option<Uuid>) -> Value {
    json!({"do": "vote", "target": target})
}

fn say(text: &str) -> Value {
    json!({"do": "say", "text": text})
}

fn vent(to: Option<usize>) -> Value {
    match to {
        Some(to) => json!({"do": "vent", "to": to}),
        None => json!({"do": "vent"}),
    }
}

fn sabotage(kind: &str) -> Value {
    json!({"do": "sabotage", "kind": kind})
}

fn fix() -> Value {
    json!({"do": "fix"})
}

/// Whether `text` is one of the strings anywhere in `value`.
fn mentions(value: &Value, text: &str) -> bool {
    match value {
        Value::String(found) => found == text,
        Value::Array(items) => items.iter().any(|item| mentions(item, text)),
        Value::Object(fields) => fields.values().any(|item| mentions(item, text)),
        _ => false,
    }
}

/// A game in hand: its people, where they stand in the room, its random numbers and the clock.
struct Play {
    game: Impostor,
    players: Vec<Member>,
    standing: HashMap<Uuid, [f64; 3]>,
    rng: StdRng,
    now: Millis,
}

impl Play {
    fn new(count: usize, seed: u64) -> Self {
        Self::with(count, seed, layout(8))
    }

    fn with(count: usize, seed: u64, layout: Value) -> Self {
        let players = members(count);
        let mut rng = StdRng::seed_from_u64(seed);
        let standing = HashMap::new();
        let mut ctx = Ctx::new(START, &players, &standing, &mut rng);
        let game = Impostor::new(&layout, &mut ctx).unwrap();
        Self { game, players, standing, rng, now: START }
    }

    fn role(&self, role: Role) -> Vec<Uuid> {
        self.game.players.iter().filter(|player| player.role == role).map(|player| player.id).collect()
    }

    fn impostor(&self) -> Uuid {
        self.role(Role::Impostor)[0]
    }

    fn crew(&self) -> Vec<Uuid> {
        self.role(Role::Crew)
    }

    fn ids(&self) -> Vec<Uuid> {
        self.players.iter().map(|player| player.id).collect()
    }

    fn bots(&self) -> Vec<Uuid> {
        self.game.players.iter().filter(|player| player.bot.is_some()).map(|player| player.id).collect()
    }

    fn index(&self, id: Uuid) -> usize {
        self.game.players.iter().position(|player| player.id == id).unwrap()
    }

    fn player(&self, id: Uuid) -> &Player {
        &self.game.players[self.index(id)]
    }

    fn name(&self, id: Uuid) -> String {
        self.player(id).name.clone()
    }

    /// Where `who`'s `index`th task is done.
    fn station(&self, who: Uuid, index: usize) -> [f64; 3] {
        self.game.stations[self.player(who).tasks[index].station]
    }

    fn stand(&mut self, who: Uuid, at: [f64; 3]) {
        self.standing.insert(who, at);
    }

    /// Puts bot `who` standing at `at`, resting a long while.
    fn park(&mut self, who: Uuid, at: [f64; 3]) {
        let index = self.index(who);
        let now = self.now;
        let bot = self.game.players[index].bot.as_mut().unwrap();
        bot.route = Route::still(at, now);
        bot.plan = bots::Plan::Rest(Millis::MAX);
    }

    /// Sets the clock to `after` ms past the start.
    fn at(&mut self, after: Millis) {
        self.now = START + after;
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

    /// Ticks at `after` ms past the start.
    fn tick(&mut self, after: Millis) -> Vec<(Audience, Value)> {
        self.at(after);
        let mut ctx = Ctx::new(self.now, &self.players, &self.standing, &mut self.rng);
        self.game.tick(&mut ctx);
        ctx.events().to_vec()
    }

    /// Ticks every 100 ms from now through `until` ms past the start (or until the game ends), and the events.
    fn run(&mut self, until: Millis) -> Vec<(Audience, Value)> {
        let mut events = Vec::new();
        let mut at = self.now - START;
        while at < until && self.game.result().is_none() {
            at += 100;
            events.extend(self.tick(at));
            // Every view can still be made.
            for id in self.ids() {
                self.view(id);
            }
        }
        events
    }

    /// `who` leaves, as the framework has them: out of the players and the room first.
    fn leave(&mut self, who: Uuid) -> Vec<(Audience, Value)> {
        self.players.retain(|player| player.id != who);
        self.standing.remove(&who);
        let mut ctx = Ctx::new(self.now, &self.players, &self.standing, &mut self.rng);
        self.game.leave(who, &mut ctx);
        ctx.events().to_vec()
    }

    fn view(&self, who: Uuid) -> Value {
        self.game.view(Some(who), self.now)
    }

    fn onlooker(&self) -> Value {
        self.game.view(None, self.now)
    }

    fn views(&self) -> Vec<Value> {
        self.players.iter().map(|player| self.view(player.id)).chain([self.onlooker()]).collect()
    }

    /// `impostor` kills `victim` standing at `at` from a meter away.
    fn kill_at(&mut self, impostor: Uuid, victim: Uuid, at: [f64; 3]) -> Vec<(Audience, Value)> {
        if self.player(victim).bot.is_some() {
            self.park(victim, at);
        } else {
            self.stand(victim, at);
        }
        self.stand(impostor, [at[0] + 1.0, at[1], at[2]]);
        self.act(impostor, kill(victim)).unwrap()
    }

    /// `caller` calls an emergency meeting from beside the table.
    fn call(&mut self, caller: Uuid) -> Vec<(Audience, Value)> {
        self.stand(caller, [1.0, 0.0, 1.0]);
        self.act(caller, call()).unwrap()
    }

    fn meeting(&self) -> &Meeting {
        self.game.meeting.as_ref().unwrap()
    }

    /// Ticks the meeting on to its vote, then returns how long past the start the vote ends.
    fn open_vote(&mut self) -> Millis {
        self.tick(self.meeting().discuss_until - START);
        self.meeting().vote_until - START
    }

    /// `who` does their `index`th task from start to finish.
    fn do_task(&mut self, who: Uuid, index: usize) {
        let place = self.station(who, index);
        self.stand(who, place);
        self.act(who, task()).unwrap();
        let ready = self.player(who).working.unwrap().ready;
        self.at(ready - START);
        self.act(who, finish()).unwrap();
    }
}

#[test]
fn layouts_need_six_to_twelve_stations_apart_from_each_other_and_the_table() {
    assert_eq!(refused(json!(null), 4), Some(BAD_LAYOUT));
    assert_eq!(refused(json!({"stations": layout(6)["stations"]}), 4), Some(BAD_LAYOUT));
    assert_eq!(refused(json!({"table": TABLE}), 4), Some(BAD_LAYOUT));
    assert_eq!(refused(layout(5), 4), Some(BAD_LAYOUT));
    assert_eq!(refused(layout(13), 4), Some(BAD_LAYOUT));
    for bad in [json!([1.0, 0.0]), json!([1.0, 0.0, 200.5]), json!(["1", 0, 0]), json!(null), json!({"x": 1})] {
        let mut station = layout(6);
        station["stations"][2] = bad.clone();
        assert_eq!(refused(station, 4), Some(BAD_LAYOUT), "station {bad}");
        let mut table = layout(6);
        table["table"] = bad.clone();
        assert_eq!(refused(table, 4), Some(BAD_LAYOUT), "table {bad}");
        if !bad.is_null() {
            let mut vents = layout(6);
            vents["vents"][1] = bad.clone();
            assert_eq!(refused(vents, 4), Some(BAD_LAYOUT), "vent {bad}");
        }
    }
    // Two stations at one place (3 m apart), or one by the table, leave five places.
    let mut doubled = layout(6);
    doubled["stations"][5] = json!([-37.0, 0.0, -30.0]);
    assert_eq!(refused(doubled, 4), Some(FEW_STATIONS));
    let mut tabled = layout(6);
    tabled["stations"][0] = json!([2.0, 0.0, -2.0]);
    assert_eq!(refused(tabled, 4), Some(FEW_STATIONS));
    // With a station to spare, the one too near another is dropped.
    let players = members(4);
    let mut rng = StdRng::seed_from_u64(1);
    let positions = HashMap::new();
    let mut ctx = Ctx::new(START, &players, &positions, &mut rng);
    let mut spare = layout(7);
    spare["stations"][6] = json!([-40.0, 0.0, -26.5]);
    let game = Impostor::new(&spare, &mut ctx).unwrap();
    assert_eq!(game.stations, serde_json::from_value::<Vec<[f64; 3]>>(layout(6)["stations"].clone()).unwrap());
    let mut edge = layout(12);
    edge["table"] = json!([-200.0, -3.5, 200]);
    let game = Impostor::new(&edge, &mut ctx).unwrap();
    assert_eq!((game.stations.len(), game.table), (12, [-200.0, -3.5, 200.0]));
    // Vents and walking spots are optional, at most eight and four hundred; vents 2 m apart are one.
    let mut bare = layout(6);
    bare.as_object_mut().unwrap().remove("vents");
    assert!(Impostor::new(&bare, &mut ctx).unwrap().vents.is_empty());
    let mut many = layout(6);
    many["vents"] = json!(vec![[0.0, 0.0, 9.0]; 9]);
    assert_eq!(refused(many, 4), Some(BAD_LAYOUT));
    let mut close = layout(6);
    close["vents"] = json!([[0.0, 0.0, 30.0], [1.0, 0.0, 30.0], [10.0, 0.0, 30.0]]);
    assert_eq!(Impostor::new(&close, &mut ctx).unwrap().vents.len(), 2);
    let mut walk = layout(6);
    walk["walk"] = json!(vec![[0.0, 0.0, 9.0]; 401]);
    assert_eq!(refused(walk, 4), Some(BAD_LAYOUT));
}

#[test]
fn people_and_bots_together_are_four_to_fifteen() {
    assert_eq!(refused(layout(8), 3), Some(FEW_PLAYERS));
    assert_eq!(refused(with_bots(2, None), 1), Some(FEW_PLAYERS));
    assert_eq!(refused(with_bots(0, None), 1), Some(FEW_PLAYERS));
    assert_eq!(refused(with_bots(9, None), 7), Some(MANY_PLAYERS));
    assert_eq!(refused(with_bots(10, None), 1), Some(BAD_LAYOUT));
    for bad in [json!("3"), json!(-1), json!(2.5)] {
        let mut odd = layout(8);
        odd["bots"] = bad.clone();
        assert_eq!(refused(odd, 4), Some(BAD_LAYOUT), "{bad}");
    }
    for bad in [json!("boss"), json!(1)] {
        let mut odd = with_bots(3, None);
        odd["role"] = bad.clone();
        assert_eq!(refused(odd, 1), Some(BAD_LAYOUT), "{bad}");
    }
    assert!(refused(with_bots(3, None), 1).is_none());
    assert!(refused(with_bots(9, None), 6).is_none());
}

#[test]
fn bots_fill_the_table_and_someone_alone_may_pick_their_side() {
    let play = Play::with(1, 3, with_bots(5, None));
    let me = play.ids()[0];
    let bots = play.bots();
    assert_eq!(bots.len(), 5);
    assert_eq!(play.role(Role::Impostor).len(), 1);
    let names: HashSet<String> = bots.iter().map(|bot| play.name(*bot)).collect();
    assert_eq!(names.len(), 5);
    assert!(!names.contains("player0"));
    let view = play.view(me);
    let listed: Vec<(Value, Value)> = view["players"]
        .as_array()
        .unwrap()
        .iter()
        .map(|player| (player["id"].clone(), player["bot"].clone()))
        .collect();
    assert_eq!(listed.len(), 6);
    assert_eq!(listed[0], (json!(me), json!(false)));
    assert!(listed[1..].iter().all(|(_, bot)| *bot == true));
    // Every bot stands at its own place around the table, as the person's spawn is.
    let shown = view["bots"].as_array().unwrap();
    assert_eq!(shown.len(), 5);
    let colors: HashSet<u64> = shown.iter().map(|bot| bot["color"].as_u64().unwrap()).collect();
    assert_eq!(colors, (0..5).collect());
    let spawn: [f64; 3] = serde_json::from_value(view["spawn"].clone()).unwrap();
    assert!((SEAT_NEAR - 0.01..=SEAT_FAR + 0.01).contains(&distance_xz(spawn, TABLE)));
    for bot in shown {
        let at: [f64; 3] = serde_json::from_value(bot["route"]["points"][0].clone()).unwrap();
        assert!(distance_xz(at, TABLE) <= SEAT_FAR + 0.01);
        assert!(distance_xz(at, spawn) > 0.5);
        assert_eq!(bot["ghost"], false);
    }
    // Alone, the chosen side is theirs; with others, nobody chooses.
    for seed in 0..12 {
        let crew = Play::with(1, seed, with_bots(5, Some("crew")));
        assert_eq!(crew.player(crew.ids()[0]).role, Role::Crew);
        let impostor = Play::with(1, seed, with_bots(8, Some("impostor")));
        assert_eq!(impostor.player(impostor.ids()[0]).role, Role::Impostor);
        assert_eq!(impostor.role(Role::Impostor).len(), 2);
    }
    let picked: HashSet<bool> = (0..40)
        .map(|seed| {
            let pair = Play::with(2, seed, with_bots(4, Some("impostor")));
            pair.player(pair.ids()[0]).role == Role::Impostor
        })
        .collect();
    assert_eq!(picked.len(), 2, "with two people the role is dealt");
}

#[test]
fn one_two_or_three_impostors_by_head_count_and_anyone_may_be_one() {
    for count in 4..=15 {
        let play = Play::new(count, count as u64);
        let impostors = match count {
            4..=6 => 1,
            7..=10 => 2,
            _ => 3,
        };
        assert_eq!(play.role(Role::Impostor).len(), impostors, "{count} players");
        assert_eq!(play.crew().len(), count - impostors);
    }
    // Bots count in the head count.
    assert_eq!(Play::with(2, 1, with_bots(9, None)).role(Role::Impostor).len(), 3);
    let seats: HashSet<usize> = (0..60)
        .map(|seed| Play::new(5, seed).game.players.iter().position(|player| player.role == Role::Impostor))
        .map(Option::unwrap)
        .collect();
    assert_eq!(seats.len(), 5);
    // The same seed deals the same game.
    let (first, again) = (Play::new(6, 9), Play::new(6, 9));
    let deal = |play: &Play| -> Vec<(Role, Vec<usize>)> {
        play.game.players.iter().map(|p| (p.role, p.tasks.iter().map(|t| t.station).collect())).collect()
    };
    assert_eq!(deal(&first), deal(&again));
    assert_eq!((first.game.chores.clone(), first.game.panels), (again.game.chores.clone(), again.game.panels));
}

#[test]
fn every_station_has_a_kind_of_task_and_panels_for_the_sabotages() {
    let play = Play::new(4, 2);
    let kinds: HashSet<&str> = play.game.chores.iter().map(|chore| chore.name()).collect();
    assert_eq!(kinds.len(), 6, "eight stations carry all six kinds");
    let view = play.view(play.ids()[0]);
    assert_eq!(view["stationKinds"].as_array().unwrap().len(), 8);
    // The reactor's two panels are the stations farthest apart; the lights and the comms two others.
    let panels = play.game.panels;
    assert_eq!(panels.reactor, [0, 7]);
    let all = HashSet::from([panels.lights, panels.comms, panels.reactor[0], panels.reactor[1]]);
    assert_eq!(all.len(), 4);
    assert_eq!(view["panels"], json!({"lights": panels.lights, "comms": panels.comms, "reactor": [0, 7]}));
    assert_eq!(view["vents"], json!(VENTS));
}

#[test]
fn the_map_may_name_the_panels_of_each_sabotage() {
    let mut named = layout(8);
    named["panels"] = json!({"lights": 2, "comms": 5, "reactor": [1, 6]});
    let play = Play::with(4, 3, named.clone());
    assert_eq!(play.game.panels, Panels { lights: 2, comms: 5, reactor: [1, 6] });
    for bad in [
        json!({"lights": 2, "comms": 2, "reactor": [1, 6]}),
        json!({"lights": 2, "comms": 5, "reactor": [1]}),
        json!({"lights": 8, "comms": 5, "reactor": [1, 6]}),
        json!({"lights": "2", "comms": 5, "reactor": [1, 6]}),
        json!([2, 5, 1, 6]),
    ] {
        let mut odd = layout(8);
        odd["panels"] = bad.clone();
        assert_eq!(refused(odd, 4), Some(BAD_LAYOUT), "{bad}");
    }
    // A station dropped as too near another: the game picks the panels itself.
    let mut crowded = named;
    crowded["stations"][7] = json!([-40.0, 0.0, -27.0]);
    let play = Play::with(4, 3, crowded);
    assert_eq!(play.game.stations.len(), 7);
    assert_eq!(play.game.panels.reactor, [0, 6]);
}

#[test]
fn everyone_gets_four_different_stations_and_the_impostors_are_fake() {
    let mut play = Play::new(6, 3);
    for player in &play.game.players {
        let stations: HashSet<usize> = player.tasks.iter().map(|task| task.station).collect();
        assert_eq!(stations.len(), TASKS_EACH);
        assert!(stations.iter().all(|station| *station < 8));
    }
    let (impostor, crew) = (play.impostor(), play.crew());
    let view = play.view(crew[0]);
    assert_eq!(view["progress"], json!({"done": 0, "total": 20}), "five crew, four tasks each");
    assert_eq!(view["role"], "crew");
    assert_eq!(view["tasks"].as_array().unwrap().len(), 4);
    assert_eq!(view["stations"].as_array().unwrap().len(), 8);
    assert_eq!(view["table"], json!(TABLE));
    let fake = play.view(impostor);
    assert_eq!(fake["role"], "impostor");
    assert_eq!(fake["tasks"].as_array().unwrap().len(), 4);
    // An impostor at a station of their list does nothing there.
    play.at(1_000);
    let place = play.station(impostor, 0);
    play.stand(impostor, place);
    assert_eq!(play.act(impostor, task()), Err(NO_TASK));
}

#[test]
fn a_task_is_done_on_the_page_no_sooner_than_its_kind_takes_and_stepping_away_drops_it() {
    let mut play = Play::new(4, 5);
    let me = play.crew()[0];
    let (first, second) = (play.station(me, 0), play.station(me, 1));
    let station = play.player(me).tasks[0].station;
    let least = play.game.chores[station].least();
    // Not placed yet, then just out of reach: nothing to do; nothing to finish.
    assert_eq!(play.act(me, task()), Err(NO_TASK));
    assert_eq!(play.act(me, finish()), Err(NO_TASK));
    play.stand(me, [first[0] + 1.81, 0.0, first[2]]);
    assert_eq!(play.act(me, task()), Err(NO_TASK));
    assert_eq!(play.act(me, json!({"do": "dance"})), Err(BAD_ACTION));
    assert_eq!(play.act(me, json!({"task": true})), Err(BAD_ACTION));
    // Within reach on the ground, however high.
    play.at(1_000);
    play.stand(me, [first[0] + 1.0, 4.0, first[2] - 1.0]);
    play.act(me, task()).unwrap();
    let kind = play.game.chores[station].name();
    let working = json!({"station": station, "kind": kind, "readyAt": START + 1_000 + least});
    assert_eq!(play.view(me)["working"], working);
    assert_eq!(play.act(me, task()), Err(BUSY));
    // Ticks alone finish nothing; the page's finish does, once the kind's time has passed.
    play.tick(1_000 + least + 5_000);
    assert_eq!(play.view(me)["tasks"][0], json!({"station": station, "done": false}));
    play.at(1_000 + least - 1);
    assert_eq!(play.act(me, finish()), Err(NOT_YET));
    play.at(1_000 + least);
    play.act(me, finish()).unwrap();
    let view = play.view(me);
    assert_eq!(view["tasks"][0], json!({"station": station, "done": true}));
    assert_eq!(view["working"], Value::Null);
    assert_eq!(view["progress"], json!({"done": 1, "total": 12}));
    assert_eq!(play.view(play.impostor())["progress"], json!({"done": 1, "total": 12}));
    assert_eq!(play.onlooker()["progress"], json!({"done": 1, "total": 12}));
    // A finished task is not done again.
    assert_eq!(play.act(me, task()), Err(NO_TASK));
    // Stepping away drops the next one; so does stop, and leaving the room.
    play.stand(me, second);
    play.act(me, task()).unwrap();
    play.stand(me, [second[0], 0.0, second[2] + 1.9]);
    play.tick(20_000);
    assert_eq!(play.view(me)["working"], Value::Null);
    play.stand(me, second);
    play.act(me, task()).unwrap();
    play.act(me, json!({"do": "stop"})).unwrap();
    assert_eq!(play.view(me)["working"], Value::Null);
    play.act(me, task()).unwrap();
    play.standing.remove(&me);
    play.tick(21_000);
    assert_eq!(play.view(me)["working"], Value::Null);
    assert_eq!(play.view(me)["progress"]["done"], 1);
    // Out of reach when it would finish: refused, and the tick drops it.
    play.stand(me, second);
    play.act(me, task()).unwrap();
    play.at(40_000);
    play.stand(me, [second[0], 0.0, second[2] + 1.9]);
    assert_eq!(play.act(me, finish()), Err(TOO_FAR));
}

#[test]
fn ghosts_of_the_crew_still_finish_their_tasks() {
    let mut play = Play::new(5, 6);
    let (impostor, crew) = (play.impostor(), play.crew());
    let ghost = crew[0];
    play.at(KILL_COOLDOWN);
    let place = play.station(ghost, 2);
    play.stand(ghost, place);
    play.act(ghost, task()).unwrap();
    play.kill_at(impostor, ghost, place);
    assert_eq!(play.view(ghost)["alive"], false);
    assert_eq!(play.view(ghost)["working"], Value::Null, "dying stops the task underway");
    play.do_task(ghost, 2);
    assert_eq!(play.view(ghost)["tasks"][2]["done"], true);
    assert_eq!(play.view(crew[1])["progress"], json!({"done": 1, "total": 16}));
}

#[test]
fn impostors_kill_living_crew_in_reach_once_their_wait_is_over() {
    let mut play = Play::new(7, 8);
    let impostors = play.role(Role::Impostor);
    let (a, b) = (impostors[0], impostors[1]);
    let crew = play.crew();
    let (c, d, e) = (crew[0], crew[1], crew[2]);
    play.stand(a, [10.0, 0.0, 10.0]);
    play.stand(b, [10.0, 0.0, 12.0]);
    play.stand(c, [12.2, 0.0, 10.0]);
    // Not in the first 15 s.
    play.at(FIRST_KILL - 1);
    assert_eq!(play.act(a, kill(c)), Err(COOLDOWN));
    play.at(KILL_COOLDOWN);
    // Only impostors kill, only living crew, named by id.
    assert_eq!(play.act(c, kill(a)), Err(BAD_ACTION));
    assert_eq!(play.act(a, kill(b)), Err(NO_TARGET));
    assert_eq!(play.act(a, kill(Uuid::new_v4())), Err(NO_TARGET));
    assert_eq!(play.act(a, json!({"do": "kill", "target": "c"})), Err(BAD_ACTION));
    assert_eq!(play.act(a, json!({"do": "kill"})), Err(BAD_ACTION));
    // Within 2.2 m on the ground, not farther, and not someone out of the room.
    play.stand(c, [12.21, 0.0, 10.0]);
    assert_eq!(play.act(a, kill(c)), Err(TOO_FAR));
    play.standing.remove(&c);
    assert_eq!(play.act(a, kill(c)), Err(TOO_FAR));
    play.stand(c, [12.2, 5.0, 10.0]);
    let events = play.act(a, kill(c)).unwrap();
    assert_eq!(events, vec![(Audience::Only(vec![c]), json!({"type": "killed"}))], "only the victim is told");
    let seen = play.view(d);
    assert_eq!(
        seen["bodies"],
        json!([{"id": 1, "victim": c, "color": null, "name": play.name(c), "position": [12.2, 5.0, 10.0], "reported": false}])
    );
    assert_eq!(seen["hidden"], json!([c]));
    assert!(seen["players"].as_array().unwrap().iter().all(|player| player["alive"] == true), "not public yet");
    assert_eq!(play.view(c)["alive"], false);
    assert_eq!(play.view(c)["hidden"], json!([]), "the dead see the dead");
    // The dead are no targets; the killer waits again, the other impostor need not.
    assert_eq!(play.act(b, kill(c)), Err(NO_TARGET));
    play.stand(d, [10.0, 0.0, 11.0]);
    assert_eq!(play.act(a, kill(d)), Err(COOLDOWN));
    assert_eq!(play.view(a)["kill"]["readyAt"], START + 2 * KILL_COOLDOWN);
    play.act(b, kill(d)).unwrap();
    // Not during a meeting, and not in the 25 s after one.
    play.at(2 * KILL_COOLDOWN);
    play.call(e);
    play.stand(e, [11.0, 0.0, 10.0]);
    assert_eq!(play.act(a, kill(e)), Err(NOT_NOW));
    let ended = play.open_vote();
    play.tick(ended);
    assert!(play.game.meeting.is_none());
    play.stand(e, [11.0, 0.0, 10.0]);
    play.at(ended + KILL_COOLDOWN - 1);
    assert_eq!(play.act(a, kill(e)), Err(COOLDOWN));
    assert_eq!(play.act(b, kill(e)), Err(COOLDOWN));
    play.at(ended + KILL_COOLDOWN);
    play.act(a, kill(e)).unwrap();
}

#[test]
fn a_living_player_near_an_unreported_body_reports_it() {
    let mut play = Play::new(5, 9);
    let (impostor, crew) = (play.impostor(), play.crew());
    let (victim, finder) = (crew[0], crew[1]);
    play.at(KILL_COOLDOWN);
    play.kill_at(impostor, victim, [20.0, 0.0, 20.0]);
    // Not the dead, not from farther than 3 m, not a body that is not there.
    assert_eq!(play.act(victim, report(1)), Err(OUT));
    play.stand(finder, [23.01, 0.0, 20.0]);
    assert_eq!(play.act(finder, report(1)), Err(TOO_FAR));
    play.stand(finder, [22.0, 0.0, 22.0]);
    assert_eq!(play.act(finder, report(2)), Err(NO_BODY));
    assert_eq!(play.act(finder, json!({"do": "report"})), Err(BAD_ACTION));
    let events = play.act(finder, report(1)).unwrap();
    assert_eq!(
        events,
        vec![(
            Audience::Everyone,
            json!({"type": "meeting", "number": 1, "reason": "report", "caller": finder, "victim": victim})
        )]
    );
    let meeting = play.view(crew[2])["meeting"].clone();
    assert_eq!(meeting["reason"], "report");
    assert_eq!((&meeting["caller"], &meeting["callerName"]), (&json!(finder), &json!(play.name(finder))));
    assert_eq!(meeting["body"], json!({"victim": victim, "name": play.name(victim)}));
    assert_eq!(play.view(finder)["bodies"][0]["reported"], true);
    assert_eq!(play.act(finder, report(1)), Err(NOT_NOW));
}

#[test]
fn emergency_meetings_are_called_at_the_table_once_each_and_not_too_soon() {
    let mut play = Play::new(5, 10);
    let (impostor, crew) = (play.impostor(), play.crew());
    let (first, second) = (crew[0], crew[1]);
    play.stand(first, [2.0, 0.0, 2.0]);
    assert_eq!(play.view(first)["emergencyLeft"], 1);
    assert_eq!(play.view(first)["emergencyFrom"], START + CALM);
    play.at(CALM - 1);
    assert_eq!(play.act(first, call()), Err(TOO_SOON));
    play.at(CALM);
    play.stand(first, [3.01, 0.0, 0.0]);
    assert_eq!(play.act(first, call()), Err(TOO_FAR));
    play.stand(first, [2.0, 0.0, 2.0]);
    let events = play.act(first, call()).unwrap();
    assert_eq!(
        events,
        vec![(
            Audience::Everyone,
            json!({"type": "meeting", "number": 1, "reason": "emergency", "caller": first, "victim": null})
        )]
    );
    let view = play.view(second);
    assert_eq!((view["phase"].as_str(), &view["meeting"]["body"]), (Some("discuss"), &Value::Null));
    assert_eq!((play.view(first)["emergencyLeft"].as_u64(), view["emergencyLeft"].as_u64()), (Some(0), Some(1)));
    // Nobody votes; the meeting ends with the vote's time.
    let ended = play.open_vote();
    play.tick(ended);
    assert_eq!(play.view(second)["phase"], "play");
    assert_eq!(play.view(second)["emergencyFrom"], START + ended + CALM);
    // One call each; the others wait 15 s after a meeting too.
    play.at(ended + CALM);
    assert_eq!(play.act(first, call()), Err(CALLED));
    play.stand(second, [0.5, 0.0, 0.0]);
    play.at(ended + CALM - 1);
    assert_eq!(play.act(second, call()), Err(TOO_SOON));
    // The dead call nothing.
    play.at(ended + KILL_COOLDOWN);
    play.kill_at(impostor, second, [0.5, 0.0, 0.0]);
    assert_eq!(play.act(second, call()), Err(OUT));
    assert_eq!(play.view(second)["emergencyLeft"], 0);
    play.stand(impostor, [0.0, 0.0, 1.0]);
    play.act(impostor, call()).unwrap();
    assert_eq!(play.meeting().number, 2);
}

#[test]
fn a_meeting_seats_the_living_around_the_table_and_talks_before_it_votes() {
    let mut play = Play::new(8, 11);
    let (impostor, crew) = (play.impostor(), play.crew());
    let (victim, worker, caller) = (crew[0], crew[1], crew[2]);
    play.at(KILL_COOLDOWN);
    play.kill_at(impostor, victim, [30.0, 0.0, 30.0]);
    let place = play.station(worker, 0);
    play.stand(worker, place);
    play.act(worker, task()).unwrap();
    play.call(caller);
    let view = play.view(worker);
    assert_eq!(view["phase"], "discuss");
    assert_eq!(view["working"], Value::Null, "a meeting stops the tasks underway");
    assert_eq!(view["meeting"]["stage"], "discuss");
    assert_eq!(view["meeting"]["endsAt"], START + KILL_COOLDOWN + DISCUSS);
    assert_eq!((view["meeting"]["voted"].as_u64(), view["meeting"]["voters"].as_u64()), (Some(0), Some(7)));
    assert_eq!(view["meeting"]["myVote"], Value::Null);
    // Every death turns public as the meeting starts, the unreported one too.
    let shown = view["players"].as_array().unwrap().iter().find(|player| player["id"] == json!(victim)).cloned();
    assert_eq!(shown.unwrap()["alive"], false);
    // Every living player has a seat of their own around the table; the dead and onlookers have none.
    let seats: Vec<[f64; 3]> = play
        .ids()
        .into_iter()
        .filter(|id| *id != victim)
        .map(|id| serde_json::from_value(play.view(id)["meeting"]["seat"].clone()).unwrap())
        .collect();
    for (index, seat) in seats.iter().enumerate() {
        let away = distance_xz(TABLE, *seat);
        assert!((SEAT_NEAR - 0.01..=SEAT_FAR + 0.01).contains(&away), "{away}");
        assert_eq!(seat[1], TABLE[1]);
        assert!(seats[..index].iter().all(|other| distance_xz(*other, *seat) > 1.0), "{seats:?}");
    }
    assert_eq!(play.view(victim)["meeting"]["seat"], Value::Null);
    assert_eq!(play.onlooker()["meeting"]["seat"], Value::Null);
    // Nothing else happens in a meeting, and the votes wait for the talk to end.
    assert_eq!(play.act(worker, task()), Err(NOT_NOW));
    assert_eq!(play.act(impostor, kill(worker)), Err(NOT_NOW));
    assert_eq!(play.act(worker, report(1)), Err(NOT_NOW));
    assert_eq!(play.act(worker, call()), Err(NOT_NOW));
    assert_eq!(play.act(worker, vote(None)), Err(NOT_NOW));
    play.tick(KILL_COOLDOWN + DISCUSS - 1);
    assert_eq!(play.view(worker)["phase"], "discuss");
    play.tick(KILL_COOLDOWN + DISCUSS);
    let view = play.view(worker);
    assert_eq!((view["phase"].as_str(), view["meeting"]["stage"].as_str()), (Some("vote"), Some("vote")));
    assert_eq!(view["meeting"]["endsAt"], START + KILL_COOLDOWN + DISCUSS + VOTE);
    // Fifteen around the table still have room.
    let mut crowd = Play::new(15, 12);
    let host = crowd.crew()[0];
    crowd.at(CALM);
    crowd.call(host);
    let seats: Vec<[f64; 3]> = crowd.meeting().seats.iter().map(|(_, seat)| *seat).collect();
    assert_eq!(seats.len(), 15);
    for (index, seat) in seats.iter().enumerate() {
        assert!(distance_xz(TABLE, *seat) <= SEAT_FAR + 0.01);
        assert!(seats[..index].iter().all(|other| distance_xz(*other, *seat) > 0.75), "{seats:?}");
    }
    // Alone among bots, the talk is short.
    let mut alone = Play::with(1, 4, with_bots(4, Some("crew")));
    let me = alone.ids()[0];
    alone.at(CALM);
    alone.call(me);
    assert_eq!(alone.meeting().discuss_until, START + CALM + DISCUSS_ALONE);
}

/// Votes by player index: a target's index, or None to skip.
type Votes = &'static [(usize, Option<usize>)];

/// A meeting of seven, called by the last of them, where `votes` are cast before time runs out.
fn meeting_of_seven(votes: Votes) -> (Play, Vec<Uuid>, Vec<(Audience, Value)>) {
    let mut play = Play::new(7, 12);
    let ids = play.ids();
    play.at(CALM);
    play.call(ids[6]);
    let ended = play.open_vote();
    for (voter, target) in votes {
        play.act(ids[*voter], vote(target.map(|target| ids[target]))).unwrap();
    }
    let events = play.tick(ended);
    (play, ids, events)
}

#[test]
fn the_unique_top_target_with_more_votes_than_skips_is_ejected() {
    let cases: [(Votes, Option<usize>); 6] = [
        (&[(0, Some(1)), (2, Some(1)), (3, Some(4)), (5, None)], Some(1)),
        (&[(0, Some(1)), (2, Some(1)), (3, Some(4)), (5, Some(4))], None),
        (&[(0, Some(1)), (2, Some(1)), (3, None), (5, None)], None),
        (&[(0, Some(1)), (2, Some(1)), (4, Some(1)), (3, None), (5, None)], Some(1)),
        (&[(0, None), (1, None)], None),
        (&[], None),
    ];
    for (votes, ejected) in cases {
        let (play, ids, events) = meeting_of_seven(votes);
        let out = ejected.map(|index| ids[index]);
        let impostor = out.map(|id| play.player(id).role == Role::Impostor);
        let name = out.map(|id| play.name(id));
        assert_eq!(
            events,
            vec![(
                Audience::Everyone,
                json!({"type": "verdict", "number": 1, "ejected": out, "name": name, "impostor": impostor})
            )],
            "{votes:?}"
        );
        assert!(play.game.meeting.is_none());
        let view = play.view(ids[0]);
        assert_eq!(view["phase"], "play");
        let cast: Vec<Value> = votes
            .iter()
            .map(|(voter, target)| json!({"voter": ids[*voter], "target": target.map(|target| ids[target])}))
            .collect();
        let remaining = 2 - usize::from(impostor == Some(true));
        assert_eq!(
            view["lastMeeting"],
            json!({"number": 1, "ejected": out, "name": name, "impostor": impostor, "remaining": remaining, "votes": cast})
        );
        for id in &ids {
            let gone = Some(*id) == out;
            assert_eq!(play.player(*id).alive, !gone);
            let shown = view["players"].as_array().unwrap().iter().find(|player| player["id"] == json!(id)).cloned();
            assert_eq!(shown.unwrap()["alive"], !gone, "an ejection is public at once");
        }
    }
}

#[test]
fn the_vote_ends_once_every_living_player_has_voted() {
    let mut play = Play::new(5, 13);
    let (impostor, crew) = (play.impostor(), play.crew());
    play.at(KILL_COOLDOWN);
    play.kill_at(impostor, crew[0], [30.0, 0.0, 30.0]);
    play.stand(crew[1], [30.0, 0.0, 31.0]);
    play.act(crew[1], report(1)).unwrap();
    play.open_vote();
    // The dead have no vote; nobody votes twice, for the dead or for a stranger.
    assert_eq!(play.act(crew[0], vote(None)), Err(OUT));
    assert_eq!(play.act(crew[1], vote(Some(crew[0]))), Err(NO_TARGET));
    assert_eq!(play.act(crew[1], vote(Some(Uuid::new_v4()))), Err(NO_TARGET));
    assert_eq!(play.act(crew[1], json!({"do": "vote"})), Err(BAD_ACTION));
    assert_eq!(play.act(crew[1], json!({"do": "vote", "target": 3})), Err(BAD_ACTION));
    play.act(crew[1], vote(Some(impostor))).unwrap();
    assert_eq!(play.act(crew[1], vote(None)), Err(VOTED));
    play.act(crew[2], vote(Some(impostor))).unwrap();
    play.act(impostor, vote(Some(crew[2]))).unwrap();
    assert_eq!(play.view(crew[3])["meeting"]["voted"], 3);
    assert!(play.game.meeting.is_some());
    let events = play.act(crew[3], vote(None)).unwrap();
    let name = play.name(impostor);
    let verdict = json!({"type": "verdict", "number": 1, "ejected": impostor, "name": name, "impostor": true});
    assert_eq!(events, vec![(Audience::Everyone, verdict)]);
    assert!(play.game.meeting.is_none());
    let result = play.game.result().unwrap();
    assert_eq!((result["winner"].as_str(), result["reason"].as_str()), (Some("crew"), Some("impostorsOut")));
    assert_eq!(play.view(crew[1])["phase"], "ended");
}

#[test]
fn when_a_meeting_ends_the_bodies_go_and_the_waits_start_again() {
    let mut play = Play::new(7, 14);
    let impostors = play.role(Role::Impostor);
    let crew = play.crew();
    play.at(KILL_COOLDOWN);
    play.kill_at(impostors[0], crew[0], [30.0, 0.0, 30.0]);
    play.kill_at(impostors[1], crew[1], [-30.0, 0.0, 30.0]);
    play.stand(crew[2], [30.0, 0.0, 32.0]);
    play.act(crew[2], report(1)).unwrap();
    let living = play.view(crew[3]);
    assert_eq!(living["bodies"].as_array().unwrap().len(), 2, "the bodies stay through the meeting");
    let dead: Vec<&Value> =
        living["players"].as_array().unwrap().iter().filter(|player| player["alive"] == false).collect();
    assert_eq!(dead.len(), 2, "both deaths are public at the meeting");
    let ended = play.open_vote();
    // Two votes out of five for an impostor, then time runs out: the impostor is ejected.
    play.act(crew[2], vote(Some(impostors[0]))).unwrap();
    play.act(crew[3], vote(Some(impostors[0]))).unwrap();
    play.tick(ended);
    let view = play.view(crew[3]);
    assert_eq!(view["bodies"], json!([]));
    let out: HashSet<String> = view["players"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|player| player["alive"] == false)
        .map(|player| player["id"].as_str().unwrap().to_owned())
        .collect();
    let expected: HashSet<String> = [crew[0], crew[1], impostors[0]].iter().map(Uuid::to_string).collect();
    assert_eq!(out, expected);
    assert_eq!(
        (view["lastMeeting"]["impostor"].as_bool(), view["lastMeeting"]["remaining"].as_u64()),
        (Some(true), Some(1))
    );
    assert_eq!(view["emergencyFrom"], START + ended + CALM);
    assert_eq!(play.view(impostors[1])["kill"]["readyAt"], START + ended + KILL_COOLDOWN);
    assert_eq!(play.view(impostors[1])["sabotageFrom"], START + ended + SABOTAGE_COOLDOWN);
    // An ejected impostor kills no more.
    assert_eq!(play.view(impostors[0])["kill"], Value::Null);
    play.at(ended + KILL_COOLDOWN);
    play.stand(impostors[0], [0.0, 0.0, 0.0]);
    play.stand(crew[3], [1.0, 0.0, 0.0]);
    assert_eq!(play.act(impostors[0], kill(crew[3])), Err(OUT));
    assert!(play.game.result().is_none());
}

#[test]
fn the_crew_win_once_every_crew_task_is_done() {
    let mut play = Play::new(4, 15);
    let crew = play.crew();
    let last = crew[2];
    for player in &mut play.game.players {
        if crew.contains(&player.id) {
            for task in &mut player.tasks {
                task.done = player.id != last;
            }
        }
    }
    for index in 0..4 {
        assert!(play.game.result().is_none());
        play.do_task(last, index);
    }
    let result = play.game.result().unwrap();
    assert_eq!((result["winner"].as_str(), result["reason"].as_str()), (Some("crew"), Some("tasks")));
    let roles: Vec<(Value, Value, Value)> = result["players"]
        .as_array()
        .unwrap()
        .iter()
        .map(|player| (player["id"].clone(), player["role"].clone(), player["bot"].clone()))
        .collect();
    let expected: Vec<(Value, Value, Value)> =
        play.game.players.iter().map(|player| (json!(player.id), json!(player.role.name()), json!(false))).collect();
    assert_eq!(roles, expected);
    assert_eq!(play.view(last)["phase"], "ended");
    assert_eq!(play.act(last, task()), Err(NOT_NOW));
}

#[test]
fn the_impostors_win_once_they_are_as_many_as_the_living_crew() {
    // By kills: one impostor and three crew, two kills.
    let mut play = Play::new(4, 16);
    let (impostor, crew) = (play.impostor(), play.crew());
    play.at(KILL_COOLDOWN);
    play.kill_at(impostor, crew[0], [10.0, 0.0, 10.0]);
    assert!(play.game.result().is_none());
    play.at(2 * KILL_COOLDOWN);
    play.kill_at(impostor, crew[1], [20.0, 0.0, 10.0]);
    let result = play.game.result().unwrap();
    assert_eq!((result["winner"].as_str(), result["reason"].as_str()), (Some("impostor"), Some("parity")));
    let alive: Vec<bool> = result["players"].as_array().unwrap().iter().map(|p| p["alive"] == true).collect();
    assert_eq!(alive.iter().filter(|alive| !**alive).count(), 2);
    assert!(play.game.bodies.len() == 2 && play.view(crew[2])["phase"] == "ended");
    // Once over, everyone sees everyone again.
    assert_eq!(play.view(crew[2])["hidden"], json!([]));
    // By an ejection: one kill, then the crew vote one of their own out.
    let mut play = Play::new(4, 17);
    let (impostor, crew) = (play.impostor(), play.crew());
    play.at(KILL_COOLDOWN);
    play.kill_at(impostor, crew[0], [10.0, 0.0, 10.0]);
    play.stand(crew[1], [10.0, 0.0, 11.0]);
    play.act(crew[1], report(1)).unwrap();
    play.open_vote();
    play.act(impostor, vote(Some(crew[1]))).unwrap();
    play.act(crew[2], vote(Some(crew[1]))).unwrap();
    play.act(crew[1], vote(Some(impostor))).unwrap();
    let result = play.game.result().unwrap();
    assert_eq!((result["winner"].as_str(), result["reason"].as_str()), (Some("impostor"), Some("parity")));
}

#[test]
fn players_who_leave_drop_out_of_the_tasks_the_votes_and_the_counts() {
    let mut play = Play::new(6, 18);
    let (impostor, crew) = (play.impostor(), play.crew());
    // A crew member who leaves takes their tasks with them.
    assert!(play.leave(crew[0]).is_empty());
    let view = play.view(crew[1]);
    assert_eq!(view["progress"], json!({"done": 0, "total": 16}));
    assert_eq!(view["players"].as_array().unwrap().len(), 5);
    // A vote of someone who left, and one for them, no longer count; nor is the leaver waited for.
    play.at(CALM);
    play.call(crew[1]);
    let ended = play.open_vote();
    play.act(crew[1], vote(Some(crew[4]))).unwrap();
    play.act(crew[2], vote(Some(crew[1]))).unwrap();
    play.act(crew[3], vote(Some(crew[2]))).unwrap();
    play.act(crew[4], vote(Some(crew[2]))).unwrap();
    play.leave(crew[1]);
    assert_eq!(play.view(crew[2])["meeting"]["voters"], 4);
    assert!(play.game.meeting.is_some());
    // Counted, the leaver's vote would tie crew[4] with crew[2].
    play.act(impostor, vote(Some(crew[4]))).unwrap();
    assert!(play.game.meeting.is_none(), "everyone still in has voted");
    let last = play.view(crew[3])["lastMeeting"].clone();
    assert_eq!(last["ejected"], json!(crew[2]));
    let counted = json!([
        {"voter": crew[3], "target": crew[2]},
        {"voter": crew[4], "target": crew[2]},
        {"voter": impostor, "target": crew[4]},
    ]);
    assert_eq!(last["votes"], counted);
    // The impostor gone, the crew win, and the result lists those who left.
    play.at(ended + 1_000);
    assert!(play.game.result().is_none());
    play.leave(impostor);
    let result = play.game.result().unwrap();
    assert_eq!((result["winner"].as_str(), result["reason"].as_str()), (Some("crew"), Some("impostorsOut")));
    let left: Vec<&Value> = result["players"].as_array().unwrap().iter().filter(|p| p["left"] == true).collect();
    assert_eq!(left.len(), 3);
    assert_eq!(result["players"].as_array().unwrap().len(), 6);
}

#[test]
fn the_living_talk_in_meetings_and_the_dead_among_themselves() {
    let mut play = Play::new(5, 19);
    let (impostor, crew) = (play.impostor(), play.crew());
    let (ghost, living) = (crew[0], crew[1]);
    // The living keep quiet between meetings.
    play.at(1_000);
    assert_eq!(play.act(living, say("안녕")), Err(NOT_NOW));
    play.at(KILL_COOLDOWN);
    play.kill_at(impostor, ghost, [30.0, 0.0, 30.0]);
    // The dead talk any time, to the dead only.
    play.act(ghost, say("  누가 그랬어요 ")).unwrap();
    let line = json!({"id": 1, "from": ghost, "name": play.name(ghost), "text": "누가 그랬어요", "ghost": true});
    assert_eq!(play.view(ghost)["talk"], json!([line]));
    assert_eq!(play.view(living)["talk"], json!([]));
    assert_eq!(play.view(impostor)["talk"], json!([]));
    assert_eq!(play.onlooker()["talk"], json!([]));
    // Something, at most 120 characters, nothing that is not text, one line a second.
    let long = "가".repeat(121);
    for bad in ["", "   ", long.as_str(), "a\u{7}b", "a\nb", "\u{202e}abc"] {
        assert_eq!(play.act(ghost, say(bad)), Err(BAD_TEXT), "{bad:?}");
    }
    assert_eq!(play.act(ghost, json!({"do": "say"})), Err(BAD_ACTION));
    play.at(KILL_COOLDOWN + 999);
    assert_eq!(play.act(ghost, say("또")), Err(TOO_FAST));
    play.at(KILL_COOLDOWN + 1_000);
    play.act(ghost, say(&"가".repeat(120))).unwrap();
    // In a meeting the living talk to everyone; the dead still to the dead.
    play.stand(living, [30.0, 0.0, 31.0]);
    play.act(living, report(1)).unwrap();
    play.act(living, say("시체를 찾았어요")).unwrap();
    play.at(KILL_COOLDOWN + 2_000);
    play.act(ghost, say("나예요")).unwrap();
    let public =
        json!([{"id": 3, "from": living, "name": play.name(living), "text": "시체를 찾았어요", "ghost": false}]);
    assert_eq!(play.view(living)["talk"], public);
    assert_eq!(play.view(impostor)["talk"], public);
    assert_eq!(play.onlooker()["talk"], public);
    let ids: Vec<u64> =
        play.view(ghost)["talk"].as_array().unwrap().iter().map(|line| line["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, [1, 2, 3, 4]);
    // The meeting's lines go with it; the dead's stay, the last thirty of them.
    let ended = play.open_vote();
    play.tick(ended);
    assert_eq!(play.view(living)["talk"], json!([]));
    assert_eq!(play.view(ghost)["talk"].as_array().unwrap().len(), 3);
    for index in 0..40 {
        play.at(ended + 1_000 * (index + 1));
        play.act(ghost, say(&format!("{index}"))).unwrap();
    }
    let talk = play.view(ghost)["talk"].clone();
    assert_eq!(talk.as_array().unwrap().len(), TALK_KEPT);
    assert_eq!(talk[TALK_KEPT - 1]["text"], "39");
}

#[test]
fn roles_and_votes_stay_with_their_owners_until_the_end() {
    let mut play = Play::new(11, 20);
    let impostors = play.role(Role::Impostor);
    let crew = play.crew();
    assert_eq!(impostors.len(), 3);
    // Impostors see one another; the crew and onlookers see no role but their own.
    for id in &impostors {
        let view = play.view(*id);
        assert_eq!(view["impostors"], json!(impostors));
        assert_eq!(view["kill"], json!({"readyAt": START + FIRST_KILL, "targets": []}));
        assert_eq!(view["sabotageFrom"], START + FIRST_SABOTAGE);
    }
    for view in crew.iter().map(|id| play.view(*id)).chain([play.onlooker()]) {
        assert_eq!(
            (&view["impostors"], &view["kill"], &view["sabotageFrom"]),
            (&Value::Null, &Value::Null, &Value::Null)
        );
        assert!(!mentions(&view, "impostor"), "{view}");
    }
    assert_eq!(play.onlooker()["role"], Value::Null);
    assert_eq!(play.onlooker()["tasks"], json!([]));
    assert_eq!(play.onlooker()["spawn"], Value::Null);
    // Nobody sees who voted for whom while the meeting is on; everyone does once it ends.
    play.at(CALM);
    play.call(crew[0]);
    let ended = play.open_vote();
    play.act(crew[0], vote(Some(impostors[0]))).unwrap();
    play.act(impostors[0], vote(Some(crew[0]))).unwrap();
    for id in play.ids() {
        let meeting = play.view(id)["meeting"].clone();
        assert_eq!(meeting["voted"], 2);
        let mine = if id == crew[0] {
            json!({"target": impostors[0]})
        } else if id == impostors[0] {
            json!({"target": crew[0]})
        } else {
            Value::Null
        };
        assert_eq!(meeting["myVote"], mine);
        let keys: HashSet<&str> = meeting.as_object().unwrap().keys().map(String::as_str).collect();
        let expected: HashSet<&str> = [
            "number",
            "stage",
            "caller",
            "callerName",
            "reason",
            "body",
            "endsAt",
            "seat",
            "voted",
            "voters",
            "myVote",
        ]
        .into();
        assert_eq!(keys, expected);
    }
    play.tick(ended);
    let votes = json!([{"voter": crew[0], "target": impostors[0]}, {"voter": impostors[0], "target": crew[0]}]);
    assert_eq!(play.onlooker()["lastMeeting"]["votes"], votes);
    assert_eq!(play.view(crew[5])["lastMeeting"]["votes"], votes);
}

#[test]
fn views_light_up_what_each_viewers_buttons_reach_as_of_the_last_tick() {
    let mut play = Play::new(5, 21);
    let (impostor, crew) = (play.impostor(), play.crew());
    let (me, other) = (crew[0], crew[1]);
    let station = play.player(me).tasks[0].station;
    play.stand(me, play.station(me, 0));
    assert_eq!(play.view(me)["near"]["station"], Value::Null, "not before a tick has seen it");
    play.tick(100);
    let near = json!({"station": station, "body": null, "table": false, "vent": null, "panel": false});
    assert_eq!(play.view(me)["near"], near);
    // Someone else's station is not mine.
    let theirs = (0..8).find(|station| play.player(me).tasks.iter().all(|task| task.station != *station)).unwrap();
    play.stand(me, play.game.stations[theirs]);
    play.tick(200);
    assert_eq!(play.view(me)["near"]["station"], Value::Null);
    // The table from within 3 m.
    play.stand(me, [2.9, 0.0, 0.0]);
    play.tick(300);
    assert_eq!(play.view(me)["near"]["table"], true);
    // A vent within 1.5 m, for a living impostor only.
    play.stand(me, [0.0, 0.0, 31.0]);
    play.stand(impostor, [1.0, 0.0, 30.5]);
    play.tick(350);
    assert_eq!(play.view(impostor)["near"]["vent"], 1);
    assert_eq!(play.view(me)["near"]["vent"], Value::Null);
    // The impostor's reach: living crew within 2.2 m, nearest first; the crew have none.
    play.stand(impostor, [50.0, 0.0, 50.0]);
    play.stand(me, [51.5, 0.0, 50.0]);
    play.stand(other, [50.0, 0.0, 51.0]);
    play.stand(crew[2], [52.3, 0.0, 50.0]);
    play.tick(400);
    assert_eq!(play.view(impostor)["kill"], json!({"readyAt": START + FIRST_KILL, "targets": [other, me]}));
    assert_eq!(play.view(me)["kill"], Value::Null);
    // A body within 3 m, for the living only.
    play.at(KILL_COOLDOWN);
    play.act(impostor, kill(me)).unwrap();
    play.tick(KILL_COOLDOWN + 100);
    assert_eq!(play.view(other)["near"]["body"], 1);
    assert_eq!(play.view(me)["near"]["body"], Value::Null);
    assert_eq!(play.view(impostor)["kill"]["targets"], json!([other]));
    // In a meeting nothing is in reach.
    play.act(other, report(1)).unwrap();
    play.tick(KILL_COOLDOWN + 200);
    let none = json!({"station": null, "body": null, "table": false, "vent": null, "panel": false});
    assert_eq!(play.view(other)["near"], none);
    assert_eq!(play.view(impostor)["kill"]["targets"], json!([]));
}

#[test]
fn living_impostors_hide_in_the_vents_and_move_between_them() {
    let mut play = Play::new(5, 22);
    let (impostor, crew) = (play.impostor(), play.crew());
    let me = crew[0];
    // Only a living impostor, near a vent.
    play.stand(me, VENTS[0]);
    assert_eq!(play.act(me, vent(None)), Err(BAD_ACTION));
    play.stand(impostor, [VENTS[0][0] + 1.6, 0.0, VENTS[0][2]]);
    assert_eq!(play.act(impostor, vent(None)), Err(NO_VENT));
    assert_eq!(play.act(impostor, vent(Some(1))), Err(NO_VENT));
    play.stand(impostor, [VENTS[0][0] + 1.0, 0.0, VENTS[0][2]]);
    assert!(play.act(impostor, vent(None)).unwrap().is_empty(), "nobody is told");
    assert_eq!(play.view(impostor)["venting"], 0);
    for viewer in [me, crew[1]] {
        assert_eq!(play.view(viewer)["hidden"], json!([impostor]));
        assert_eq!(play.view(viewer)["venting"], Value::Null);
    }
    // Inside: on to another vent, not the same one nor one that is not there; nothing else.
    assert_eq!(play.act(impostor, vent(Some(0))), Err(BAD_ACTION));
    assert_eq!(play.act(impostor, vent(Some(3))), Err(BAD_ACTION));
    assert_eq!(play.act(impostor, json!({"do": "vent", "to": "1"})), Err(BAD_ACTION));
    play.at(FIRST_KILL);
    play.stand(me, [VENTS[0][0] + 1.0, 0.0, VENTS[0][2] + 1.0]);
    assert_eq!(play.act(impostor, kill(me)), Err(IN_VENT));
    play.act(impostor, vent(Some(2))).unwrap();
    assert_eq!(play.view(impostor)["venting"], 2);
    // The page takes them to the new vent; the tick keeps them in while they stand by one.
    play.tick(FIRST_KILL + 100);
    assert_eq!(play.view(impostor)["venting"], 2);
    play.stand(impostor, VENTS[2]);
    play.tick(FIRST_KILL + 200);
    assert_eq!(play.view(impostor)["near"]["vent"], 2);
    // Out again where they are; walking off climbs out too.
    play.act(impostor, vent(None)).unwrap();
    assert_eq!(play.view(me)["hidden"], json!([]));
    play.act(impostor, vent(None)).unwrap();
    play.stand(impostor, [VENTS[2][0] + 3.1, 0.0, VENTS[2][2]]);
    play.tick(FIRST_KILL + 300);
    assert_eq!(play.view(impostor)["venting"], Value::Null);
    // A meeting brings everyone out.
    play.stand(impostor, VENTS[2]);
    play.act(impostor, vent(None)).unwrap();
    play.at(CALM);
    play.call(crew[1]);
    assert_eq!(play.view(impostor)["venting"], Value::Null);
}

#[test]
fn impostors_sabotage_and_anyone_alive_fixes_it_at_its_panel() {
    let mut play = Play::new(5, 23);
    let (impostor, crew) = (play.impostor(), play.crew());
    let me = crew[0];
    let panels = play.game.panels;
    // Not the crew, not before 20 s, not a kind that is not one.
    play.at(FIRST_SABOTAGE - 1);
    assert_eq!(play.act(impostor, sabotage("lights")), Err(COOLDOWN));
    play.at(FIRST_SABOTAGE);
    assert_eq!(play.act(me, sabotage("lights")), Err(BAD_ACTION));
    assert_eq!(play.act(impostor, sabotage("doors")), Err(BAD_ACTION));
    assert_eq!(play.act(me, fix()), Err(NOTHING_BROKEN));
    // The comms: the crew lose their task bar, the impostors keep theirs; no emergency meeting meanwhile.
    let events = play.act(impostor, sabotage("comms")).unwrap();
    assert_eq!(events, vec![(Audience::Everyone, json!({"type": "sabotage", "kind": "comms"}))]);
    assert_eq!(play.act(impostor, sabotage("lights")), Err(NOT_NOW));
    assert_eq!(play.view(me)["progress"], Value::Null);
    assert_eq!(play.onlooker()["progress"], Value::Null);
    assert_eq!(play.view(impostor)["progress"], json!({"done": 0, "total": 16}));
    assert_eq!(play.view(me)["sabotage"], json!({"kind": "comms", "endsAt": null, "held": [false, false]}));
    play.at(CALM.max(FIRST_SABOTAGE));
    play.stand(me, [1.0, 0.0, 1.0]);
    assert_eq!(play.act(me, call()), Err(BROKEN));
    // Fixed at its own panel only.
    play.stand(me, play.game.stations[panels.lights]);
    assert_eq!(play.act(me, fix()), Err(NO_PANEL));
    play.stand(me, play.game.stations[panels.comms]);
    play.tick(FIRST_SABOTAGE + 100);
    assert_eq!(play.view(me)["near"]["panel"], true);
    let events = play.act(me, fix()).unwrap();
    assert_eq!(events, vec![(Audience::Everyone, json!({"type": "fixed", "kind": "comms"}))]);
    assert_eq!(play.view(me)["sabotage"], Value::Null);
    assert_eq!(play.view(me)["progress"], json!({"done": 0, "total": 16}));
    // The next one waits 30 s; a meeting fixes it.
    let fixed = play.now - START;
    play.at(fixed + SABOTAGE_COOLDOWN - 1);
    assert_eq!(play.act(impostor, sabotage("lights")), Err(COOLDOWN));
    play.at(fixed + SABOTAGE_COOLDOWN);
    play.act(impostor, sabotage("lights")).unwrap();
    play.stand(crew[1], [5.0, 0.0, 5.0]);
    play.kill_at(impostor, crew[2], [5.0, 0.0, 6.0]);
    play.stand(crew[1], [5.0, 0.0, 7.0]);
    play.act(crew[1], report(1)).unwrap();
    assert_eq!(play.view(me)["sabotage"], Value::Null);
}

#[test]
fn the_reactor_needs_both_panels_held_at_once_or_it_melts_down() {
    let mut play = Play::new(5, 24);
    let (impostor, crew) = (play.impostor(), play.crew());
    let [a, b] = play.game.panels.reactor.map(|station| play.game.stations[station]);
    play.at(FIRST_SABOTAGE);
    play.act(impostor, sabotage("reactor")).unwrap();
    let deadline = START + FIRST_SABOTAGE + REACTOR_TIME;
    assert_eq!(play.view(crew[0])["sabotage"], json!({"kind": "reactor", "endsAt": deadline, "held": [false, false]}));
    // One holds a panel while in reach; one person holds only one at a time.
    play.stand(crew[0], a);
    play.act(crew[0], fix()).unwrap();
    assert_eq!(play.view(crew[1])["sabotage"]["held"], json!([true, false]));
    play.stand(crew[0], [a[0] + 2.0, 0.0, a[2]]);
    play.tick(FIRST_SABOTAGE + 100);
    assert_eq!(play.view(crew[1])["sabotage"]["held"], json!([false, false]), "stepping away lets go");
    play.stand(crew[0], a);
    play.act(crew[0], fix()).unwrap();
    // Both at once fixes it.
    play.stand(crew[1], b);
    let events = play.act(crew[1], fix()).unwrap();
    assert_eq!(events, vec![(Audience::Everyone, json!({"type": "fixed", "kind": "reactor"}))]);
    assert!(play.game.sabotage.is_none());
    // Left alone it melts down: the impostors win.
    let mut play = Play::new(5, 25);
    let impostor = play.impostor();
    play.at(FIRST_SABOTAGE);
    play.act(impostor, sabotage("reactor")).unwrap();
    play.tick(FIRST_SABOTAGE + REACTOR_TIME - 1);
    assert!(play.game.result().is_none());
    play.tick(FIRST_SABOTAGE + REACTOR_TIME);
    let result = play.game.result().unwrap();
    assert_eq!((result["winner"].as_str(), result["reason"].as_str()), (Some("impostor"), Some("meltdown")));
}

#[test]
fn crew_bots_walk_to_their_stations_do_their_tasks_and_win() {
    // Playing the impostor alone and doing nothing, the five crew bots finish every task.
    let mut play = Play::with(1, 26, with_bots(5, Some("impostor")));
    let me = play.ids()[0];
    play.stand(me, NOWHERE);
    play.run(10_000);
    let moved = play
        .game
        .players
        .iter()
        .filter_map(|player| player.bot.as_ref())
        .filter(|bot| bot.route.at(play.now) != bot.route.end() || bot.route.end() != play.game.spawns[&me])
        .count();
    assert!(moved > 0);
    play.run(600_000);
    let result = play.game.result().expect("the crew bots finish their tasks");
    assert_eq!((result["winner"].as_str(), result["reason"].as_str()), (Some("crew"), Some("tasks")));
    assert!(result["players"].as_array().unwrap().iter().filter(|player| player["bot"] == true).count() == 5);
}

#[test]
fn a_bot_impostor_kills_someone_alone_and_crew_bots_report_and_vote_for_whom_they_saw() {
    // A bot impostor beside a person alone kills them once it may.
    let mut play = Play::with(1, 27, with_bots(4, Some("crew")));
    let me = play.ids()[0];
    let killer = play.impostor();
    play.stand(me, NOWHERE);
    for bot in play.bots() {
        play.park(bot, [-60.0, 0.0, -60.0]);
    }
    play.park(killer, [NOWHERE[0] + 1.5, 0.0, NOWHERE[2]]);
    play.tick(FIRST_KILL - 100);
    assert_eq!(play.view(me)["alive"], true);
    let events = play.tick(FIRST_KILL);
    assert_eq!(events, vec![(Audience::Only(vec![me]), json!({"type": "killed"}))]);
    assert_eq!(play.view(me)["alive"], false);
    assert_eq!(play.game.bodies[0].victim, me);
    // Not with someone else in sight.
    let mut play = Play::with(1, 27, with_bots(4, Some("crew")));
    let me = play.ids()[0];
    let killer = play.impostor();
    let friend = play.crew().into_iter().find(|id| *id != me).unwrap();
    play.stand(me, NOWHERE);
    for bot in play.bots() {
        play.park(bot, [-60.0, 0.0, -60.0]);
    }
    play.park(killer, [NOWHERE[0] + 1.5, 0.0, NOWHERE[2]]);
    play.park(friend, [NOWHERE[0] - 5.0, 0.0, NOWHERE[2]]);
    play.tick(FIRST_KILL);
    assert_eq!(play.view(me)["alive"], true);

    // A person playing the impostor kills a bot in front of another: it reports, says so and votes for them.
    let mut play = Play::with(1, 28, with_bots(4, Some("impostor")));
    let me = play.ids()[0];
    let crew = play.crew();
    let (victim, witness) = (crew[0], crew[1]);
    for bot in play.bots() {
        play.park(bot, [-60.0, 0.0, -60.0]);
    }
    play.park(witness, [NOWHERE[0], 0.0, NOWHERE[2] + 2.5]);
    play.at(FIRST_KILL);
    play.kill_at(me, victim, NOWHERE);
    let index = play.index(witness);
    assert_eq!(play.game.players[index].bot.as_ref().unwrap().saw, Some((me, victim)));
    let events = play.tick(FIRST_KILL + 100);
    let meeting = json!({"type": "meeting", "number": 1, "reason": "report", "caller": witness, "victim": victim});
    assert_eq!(events, vec![(Audience::Everyone, meeting)]);
    let until = play.meeting().discuss_until - START;
    play.run(until - 1);
    let said: Vec<String> = play.view(me)["talk"]
        .as_array()
        .unwrap()
        .iter()
        .map(|line| line["text"].as_str().unwrap().to_owned())
        .collect();
    let (name, victim_name) = (play.name(me), play.name(victim));
    assert!(said.contains(&format!("{victim_name}님이 쓰러져 있었어요.")), "{said:?}");
    assert!(said.contains(&format!("{name}님이 {victim_name}님을 처치하는 걸 봤어요!")), "{said:?}");
    play.run(until + 10_000);
    let votes = &play.meeting().votes;
    assert!(votes.contains(&(witness, Some(me))), "{votes:?}");
}

#[test]
fn bots_fix_the_reactor_and_the_lights_before_it_is_too_late() {
    for kind in ["reactor", "lights", "comms"] {
        let mut play = Play::with(1, 29, with_bots(5, Some("impostor")));
        let me = play.ids()[0];
        play.stand(me, NOWHERE);
        play.run(FIRST_SABOTAGE);
        play.act(me, sabotage(kind)).unwrap();
        let fixed = (FIRST_SABOTAGE..FIRST_SABOTAGE + REACTOR_TIME).step_by(100).find(|at| {
            play.tick(*at);
            play.game.sabotage.is_none()
        });
        assert!(fixed.is_some(), "{kind}");
        assert!(play.game.result().is_none(), "{kind}");
    }
}

#[test]
fn whole_games_with_bots_end_and_every_view_can_be_made_along_the_way() {
    let mut ended = 0;
    for seed in 0..10 {
        let role = if seed % 2 == 0 { "crew" } else { "impostor" };
        let mut play = Play::with(1, 100 + seed, with_bots(7, Some(role)));
        let me = play.ids()[0];
        // The person stays where they started.
        let spawn = play.game.spawns[&me];
        play.stand(me, spawn);
        play.run(20 * 60_000);
        if play.game.result().is_some() {
            ended += 1;
        }
        // The bots were where the views said they were going.
        for player in &play.game.players {
            if let Some(bot) = &player.bot {
                let at = bot.route.at(play.now);
                assert!(at.iter().all(|value| value.is_finite() && value.abs() <= MAX_COORDINATE_TEST));
            }
        }
    }
    assert!(ended >= 8, "{ended} of 10 ended");
}

const MAX_COORDINATE_TEST: f64 = crate::games::MAX_COORDINATE;
