//! 캐치마인드 (draw and guess). The players draw once each, in the order they joined (eight turns at most), a word from
//! the bank that only the drawer sees, and the others guess it. A turn lasts 80 seconds, or until everyone else has
//! guessed it, and is followed by a four-second pause that shows the word to all. A right guess earns 10 points and
//! one more for every whole eight seconds left, once a turn; the drawer earns 5 for each player who guesses. The most
//! points win, ties sharing a place.
//!
//! Layout: `{}` (nothing on the island; any layout is taken).
//!
//! Actions:
//! - the drawer, while the turn lasts: `{"stroke": {"points": [[x, y], …], "color": "#rrggbb", "size": 1–3}}` with 1 to
//!   64 points from 0 to 1 across and down the board and a colour of [`PALETTE`]; `"join": true` carries on the turn's
//!   last stroke (same colour and size), so a long line goes in several messages. `{"clear": true}` empties the board,
//!   `{"undo": true}` takes its last stroke away. What arrives after the turn has ended is dropped. The board holds 600
//!   strokes and 20 000 points; more is refused.
//! - the others, while the turn lasts: `{"guess": "…"}`, 1 to 30 characters once trimmed, no control characters. It is
//!   right when it is the word once spaces are taken out of both and case is ignored; each player is right once a turn.
//! - anyone, players or people watching: `{"replay": true}` asks for the turn's strokes (on joining or reconnecting
//!   mid-turn); they come back to the asker alone, at most once a second (a quicker ask is answered a beat later).
//!
//! View: `{"phase": "drawing"|"reveal", "turn", "turns", "drawer", "role": "drawer"|"guesser"|"watcher", "word",
//! "letters", "scores": [{id, name, score}], "guessed": [id], "endsAt"}`. `word` is the drawer's alone while the turn
//! lasts (null for everyone else) and everyone's during the pause; `letters` counts its syllables. The strokes are
//! never in the view: views go out again whenever they change.
//!
//! Events:
//! - to everyone but the drawer: `{"type": "stroke", "turn", "stroke": {points, color, size, join}}`,
//!   `{"type": "clear", "turn"}`, `{"type": "undo", "turn"}`;
//! - to whoever asked: `{"type": "replay", "turn", "part", "parts", "strokes": [{points, color, size, join}]}`, the
//!   board in parts of at most 600 points and 50 pieces (a piece with `join` carries on the stroke before it);
//! - to everyone: `{"type": "chat", "player", "text"}` (a wrong guess), `{"type": "guessed", "player", "points"}` (a
//!   right one, without the word) and `{"type": "reveal", "turn", "drawer", "word"}` when a turn ends.
//!
//! Result: `{"ranking": [{id, name, score, rank}]}`, best first.

use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;

use super::{BAD_ACTION, Ctx, Game, GameError, Kind, Millis, pick_many};

mod words;

pub(crate) const KIND: Kind = Kind::new("draw", MIN_PLAYERS, 12, create).ticking(4);

const MIN_PLAYERS: usize = 2;
/// Turns at most: the first eight players draw.
const MAX_TURNS: usize = 8;
const TURN: Millis = 80_000;
/// The pause after a turn, showing its word.
const PAUSE: Millis = 4_000;
const GUESS_POINTS: u32 = 10;
/// A right guess earns a point more for every this much of the turn left.
const BONUS_EVERY: Millis = 8_000;
const DRAWER_POINTS: u32 = 5;
const MAX_GUESS: usize = 30;
/// The colours a stroke may have.
const PALETTE: [&str; 8] = ["#222222", "#e5484d", "#f5a524", "#ffd60a", "#30a46c", "#3b82f6", "#8e4ec6", "#8b5a2b"];
const MAX_SIZE: u64 = 3;
/// Points in one stroke message.
const MAX_PIECE: usize = 64;
const MAX_STROKES: usize = 600;
const MAX_POINTS: usize = 20_000;
/// A replay part's most points and pieces: under 13 KB of JSON.
const REPLAY_POINTS: usize = 600;
const REPLAY_PIECES: usize = 50;
/// How often one person is sent the board.
const REPLAY_GAP: Millis = 1_000;
/// Points are kept to a ten-thousandth of the board.
const GRID: f64 = 10_000.0;

const NOT_DRAWER: GameError = GameError::new("not_drawer", "그리는 사람만 할 수 있어요.");
const DRAWER_GUESS: GameError = GameError::new("drawer_guess", "그리는 사람은 맞힐 수 없어요.");
const ALREADY_GUESSED: GameError = GameError::new("guessed", "이미 맞혔어요.");
const NOT_NOW: GameError = GameError::new("not_now", "지금은 맞힐 수 없어요.");
const BAD_GUESS: GameError = GameError::new("bad_guess", "보낼 수 없는 답이에요.");
const BAD_STROKE: GameError = GameError::new("bad_stroke", "그릴 수 없는 선이에요.");
const BOARD_FULL: GameError = GameError::new("board_full", "더 그릴 수 없어요.");
const NOTHING_TO_UNDO: GameError = GameError::new("nothing_to_undo", "되돌릴 선이 없어요.");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Drawing,
    /// The pause after a turn.
    Reveal,
}

#[derive(Clone, Debug, PartialEq)]
struct Stroke {
    color: &'static str,
    size: u64,
    points: Vec<[f64; 2]>,
}

/// One stroke message, checked.
struct Piece {
    stroke: Stroke,
    join: bool,
}

pub(crate) struct Draw {
    /// Who plays, in the order they joined.
    players: Vec<(Uuid, String)>,
    scores: HashMap<Uuid, u32>,
    /// Who draws each turn: the first eight players, less those who left before their turn.
    order: Vec<Uuid>,
    /// A different word for each turn.
    words: Vec<&'static str>,
    /// The turn now, an index into `order` and `words`.
    turn: usize,
    phase: Phase,
    ends_at: Millis,
    /// Who has guessed this turn's word, in order.
    guessed: Vec<Uuid>,
    strokes: Vec<Stroke>,
    /// Points in `strokes`.
    points: usize,
    /// Who asked for the board and has not been sent it yet.
    wanted: Vec<Uuid>,
    /// When each person was last sent the board.
    sent: HashMap<Uuid, Millis>,
    over: bool,
}

fn create(_layout: &Value, ctx: &mut Ctx) -> Result<Box<dyn Game>, GameError> {
    let players: Vec<(Uuid, String)> = ctx.players().iter().map(|player| (player.id, player.name.clone())).collect();
    let words = pick_many(ctx.rng(), words::WORDS, players.len().min(MAX_TURNS));
    Ok(Box::new(Draw::new(players, words, ctx.now())))
}

impl Draw {
    /// The first turn, starting `now`, with these players and one word for each turn.
    fn new(players: Vec<(Uuid, String)>, words: Vec<&'static str>, now: Millis) -> Self {
        let order = players.iter().take(MAX_TURNS.min(words.len())).map(|(id, _)| *id).collect();
        Self {
            players,
            scores: HashMap::new(),
            order,
            words,
            turn: 0,
            phase: Phase::Drawing,
            ends_at: now + TURN,
            guessed: Vec::new(),
            strokes: Vec::new(),
            points: 0,
            wanted: Vec::new(),
            sent: HashMap::new(),
            over: false,
        }
    }

    fn drawer(&self) -> Uuid {
        self.order[self.turn]
    }

    fn word(&self) -> &'static str {
        self.words[self.turn]
    }

    fn score(&self, player: Uuid) -> u32 {
        self.scores.get(&player).copied().unwrap_or(0)
    }

    /// Whether strokes and guesses count now.
    fn open(&self, now: Millis) -> bool {
        !self.over && self.phase == Phase::Drawing && now < self.ends_at
    }

    /// Whether every player but the drawer has guessed the word.
    fn all_guessed(&self) -> bool {
        let drawer = self.drawer();
        self.players.iter().filter(|(id, _)| *id != drawer).all(|(id, _)| self.guessed.contains(id))
    }

    /// Ends the turn: everyone is told the word, and the pause begins.
    fn end_turn(&mut self, ctx: &mut Ctx) {
        self.phase = Phase::Reveal;
        self.ends_at = ctx.now() + PAUSE;
        ctx.emit(json!({"type": "reveal", "turn": self.turn + 1, "drawer": self.drawer(), "word": self.word()}));
    }

    /// The next turn on a blank board, or the end after the last one.
    fn next_turn(&mut self, now: Millis) {
        if self.turn + 1 >= self.order.len() {
            self.over = true;
            return;
        }
        self.turn += 1;
        self.phase = Phase::Drawing;
        self.ends_at = now + TURN;
        self.guessed.clear();
        self.strokes.clear();
        self.points = 0;
    }

    /// `stroke`, `clear` and `undo`: the drawer's alone. After the turn they are dropped, not refused: a line still on
    /// its way when the last guess lands is no mistake.
    fn draw(&mut self, player: Uuid, what: &str, value: &Value, ctx: &mut Ctx) -> Result<(), GameError> {
        if player != self.drawer() {
            return Err(NOT_DRAWER);
        }
        let piece = if what == "stroke" { Some(Piece::read(value)?) } else { None };
        if !self.open(ctx.now()) {
            return Ok(());
        }
        let turn = self.turn + 1;
        match piece {
            Some(Piece { stroke, join }) => {
                if join {
                    let last = self.strokes.last().ok_or(BAD_STROKE)?;
                    if last.color != stroke.color || last.size != stroke.size {
                        return Err(BAD_STROKE);
                    }
                } else if self.strokes.len() >= MAX_STROKES {
                    return Err(BOARD_FULL);
                }
                if self.points + stroke.points.len() > MAX_POINTS {
                    return Err(BOARD_FULL);
                }
                self.points += stroke.points.len();
                let piece = piece_json(&stroke, &stroke.points, join);
                let event = json!({"type": "stroke", "turn": turn, "stroke": piece});
                match self.strokes.last_mut().filter(|_| join) {
                    Some(last) => last.points.extend(stroke.points),
                    None => self.strokes.push(stroke),
                }
                ctx.emit_except(&[player], event);
            }
            None if what == "undo" => {
                let undone = self.strokes.pop().ok_or(NOTHING_TO_UNDO)?;
                self.points -= undone.points.len();
                ctx.emit_except(&[player], json!({"type": "undo", "turn": turn}));
            }
            None => {
                self.strokes.clear();
                self.points = 0;
                ctx.emit_except(&[player], json!({"type": "clear", "turn": turn}));
            }
        }
        Ok(())
    }

    fn guess(&mut self, player: Uuid, value: &Value, ctx: &mut Ctx) -> Result<(), GameError> {
        let drawer = self.drawer();
        if player == drawer {
            return Err(DRAWER_GUESS);
        }
        let now = ctx.now();
        if !self.open(now) {
            return Err(NOT_NOW);
        }
        if self.guessed.contains(&player) {
            return Err(ALREADY_GUESSED);
        }
        let text = value
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty() && text.chars().count() <= MAX_GUESS && !text.chars().any(char::is_control))
            .ok_or(BAD_GUESS)?;
        if plain(text) != plain(self.word()) {
            ctx.emit(json!({"type": "chat", "player": player, "text": text}));
            return Ok(());
        }
        let left = self.ends_at - now;
        let points = GUESS_POINTS + u32::try_from(left / BONUS_EVERY).unwrap_or(0);
        *self.scores.entry(player).or_default() += points;
        *self.scores.entry(drawer).or_default() += DRAWER_POINTS;
        self.guessed.push(player);
        ctx.emit(json!({"type": "guessed", "player": player, "points": points}));
        if self.all_guessed() {
            self.end_turn(ctx);
        }
        Ok(())
    }

    /// Notes that `viewer` wants the board and sends it to whoever is due.
    fn ask(&mut self, viewer: Uuid, ctx: &mut Ctx) {
        if !self.wanted.contains(&viewer) {
            self.wanted.push(viewer);
        }
        self.serve(ctx);
    }

    /// Sends the board to whoever asked for it and was not sent it in the last [`REPLAY_GAP`]; the rest wait for a
    /// later tick.
    fn serve(&mut self, ctx: &mut Ctx) {
        let now = ctx.now();
        self.sent.retain(|_, at| now < *at + REPLAY_GAP);
        let (due, waiting): (Vec<Uuid>, Vec<Uuid>) =
            self.wanted.iter().copied().partition(|viewer| !self.sent.contains_key(viewer));
        if due.is_empty() {
            return;
        }
        self.wanted = waiting;
        let parts = self.replay();
        for viewer in due {
            self.sent.insert(viewer, now);
            for part in &parts {
                ctx.emit_one(viewer, part.clone());
            }
        }
    }

    /// The turn's strokes in replay events of at most [`REPLAY_POINTS`] points and [`REPLAY_PIECES`] pieces each; a
    /// stroke split across parts carries on with `join`. One empty part for a blank board.
    fn replay(&self) -> Vec<Value> {
        let mut parts: Vec<Vec<Value>> = vec![Vec::new()];
        let (mut points, mut pieces) = (0, 0);
        for stroke in &self.strokes {
            let mut rest = stroke.points.as_slice();
            let mut join = false;
            while !rest.is_empty() {
                if points == REPLAY_POINTS || pieces == REPLAY_PIECES {
                    parts.push(Vec::new());
                    (points, pieces) = (0, 0);
                }
                let (head, tail) = rest.split_at(rest.len().min(REPLAY_POINTS - points));
                if let Some(part) = parts.last_mut() {
                    part.push(piece_json(stroke, head, join));
                }
                points += head.len();
                pieces += 1;
                join = true;
                rest = tail;
            }
        }
        let count = parts.len();
        let turn = self.turn + 1;
        parts
            .into_iter()
            .enumerate()
            .map(|(part, strokes)| {
                json!({"type": "replay", "turn": turn, "part": part, "parts": count, "strokes": strokes})
            })
            .collect()
    }
}

impl Piece {
    /// A stroke message's `stroke`, or why it cannot be drawn.
    fn read(value: &Value) -> Result<Self, GameError> {
        let fields = value.as_object().ok_or(BAD_STROKE)?;
        let points = fields
            .get("points")
            .and_then(Value::as_array)
            .filter(|points| (1..=MAX_PIECE).contains(&points.len()))
            .ok_or(BAD_STROKE)?
            .iter()
            .map(board_point)
            .collect::<Option<Vec<_>>>()
            .ok_or(BAD_STROKE)?;
        let color = fields
            .get("color")
            .and_then(Value::as_str)
            .and_then(|color| PALETTE.iter().copied().find(|known| *known == color))
            .ok_or(BAD_STROKE)?;
        let size = fields
            .get("size")
            .and_then(Value::as_u64)
            .filter(|size| (1..=MAX_SIZE).contains(size))
            .ok_or(BAD_STROKE)?;
        let join = match fields.get("join") {
            None | Some(Value::Bool(false)) => false,
            Some(Value::Bool(true)) => true,
            Some(_) => return Err(BAD_STROKE),
        };
        Ok(Self { stroke: Stroke { color, size, points }, join })
    }
}

/// `[x, y]` on the board (0 to 1 each), kept to the [`GRID`].
fn board_point(value: &Value) -> Option<[f64; 2]> {
    let [x, y] = value.as_array()?.as_slice() else { return None };
    let on_board =
        |value: &Value| value.as_f64().filter(|v| (0.0..=1.0).contains(v)).map(|v| (v * GRID).round() / GRID + 0.0);
    Some([on_board(x)?, on_board(y)?])
}

fn piece_json(stroke: &Stroke, points: &[[f64; 2]], join: bool) -> Value {
    json!({"points": points, "color": stroke.color, "size": stroke.size, "join": join})
}

/// A guess or a word as they are compared: no spaces, lower case.
fn plain(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect()
}

/// The action's one field: its name and value.
fn single(action: &Value) -> Option<(&str, &Value)> {
    let fields = action.as_object().filter(|fields| fields.len() == 1)?;
    fields.iter().next().map(|(name, value)| (name.as_str(), value))
}

impl Game for Draw {
    fn view(&self, viewer: Option<Uuid>, _now: Millis) -> Value {
        let drawer = self.drawer();
        let drawing = self.phase == Phase::Drawing;
        let role = match viewer {
            Some(id) if id == drawer => "drawer",
            Some(_) => "guesser",
            None => "watcher",
        };
        // The word is the drawer's alone until the turn ends.
        let word = (!drawing || viewer == Some(drawer)).then(|| self.word());
        json!({
            "phase": if drawing { "drawing" } else { "reveal" },
            "turn": self.turn + 1,
            "turns": self.order.len(),
            "drawer": drawer,
            "role": role,
            "word": word,
            "letters": self.word().chars().count(),
            "scores": self.players.iter().map(|(id, name)| json!({
                "id": id,
                "name": name,
                "score": self.score(*id),
            })).collect::<Vec<_>>(),
            "guessed": self.guessed,
            "endsAt": self.ends_at,
        })
    }

    fn act(&mut self, player: Uuid, action: &Value, ctx: &mut Ctx) -> Result<(), GameError> {
        match single(action) {
            Some(("replay", Value::Bool(true))) => {
                self.ask(player, ctx);
                Ok(())
            }
            Some((what @ ("clear" | "undo"), Value::Bool(true))) => self.draw(player, what, &Value::Null, ctx),
            Some(("stroke", stroke)) => self.draw(player, "stroke", stroke, ctx),
            Some(("guess", text)) => self.guess(player, text, ctx),
            _ => Err(BAD_ACTION),
        }
    }

    fn watch(&mut self, viewer: Uuid, action: &Value, ctx: &mut Ctx) -> Result<(), GameError> {
        match single(action) {
            Some(("replay", Value::Bool(true))) => {
                self.ask(viewer, ctx);
                Ok(())
            }
            _ => Err(BAD_ACTION),
        }
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        if self.over {
            return;
        }
        if ctx.now() >= self.ends_at {
            match self.phase {
                Phase::Drawing => self.end_turn(ctx),
                Phase::Reveal => self.next_turn(ctx.now()),
            }
        }
        if !self.over {
            self.serve(ctx);
        }
    }

    fn leave(&mut self, player: Uuid, ctx: &mut Ctx) {
        self.players.retain(|(id, _)| *id != player);
        self.scores.remove(&player);
        self.guessed.retain(|id| *id != player);
        self.wanted.retain(|id| *id != player);
        // Out of the turns still to come; a turn they drew or are drawing stays theirs.
        let mut index = 0;
        let turn = self.turn;
        self.order.retain(|id| {
            index += 1;
            index <= turn + 1 || *id != player
        });
        if self.over {
            return;
        }
        let drawing = self.phase == Phase::Drawing;
        if self.players.len() < MIN_PLAYERS {
            // No one left to draw for: the word is shown and the game ends.
            if drawing {
                self.end_turn(ctx);
            }
            self.over = true;
        } else if drawing && (player == self.drawer() || self.all_guessed()) {
            self.end_turn(ctx);
        }
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
    const TEST_WORDS: [&str; 8] = ["사과", "기린", "우산", "자전거", "눈사람", "피아노", "등대", "고래"];

    type Events = Vec<(Audience, Value)>;

    /// A game of `count` players over the test words, begun at [`START`]; players are named by their place.
    struct Table {
        all: Vec<Member>,
        here: Vec<Member>,
        game: Draw,
        rng: StdRng,
    }

    impl Table {
        fn new(count: usize) -> Self {
            Self::with_words(count, TEST_WORDS.to_vec())
        }

        fn with_words(count: usize, words: Vec<&'static str>) -> Self {
            let all: Vec<Member> =
                (0..count).map(|index| Member { id: Uuid::new_v4(), name: format!("player{index}") }).collect();
            let game = Draw::new(all.iter().map(|player| (player.id, player.name.clone())).collect(), words, START);
            Self { here: all.clone(), all, game, rng: StdRng::seed_from_u64(1) }
        }

        fn id(&self, player: usize) -> Uuid {
            self.all[player].id
        }

        fn act(&mut self, player: usize, action: Value, now: Millis) -> Result<Events, GameError> {
            let positions = HashMap::new();
            let mut ctx = Ctx::new(now, &self.here, &positions, &mut self.rng);
            let id = self.all[player].id;
            self.game.act(id, &action, &mut ctx).map(|()| ctx.events().to_vec())
        }

        fn watch(&mut self, viewer: Uuid, action: Value, now: Millis) -> Result<Events, GameError> {
            let positions = HashMap::new();
            let mut ctx = Ctx::new(now, &self.here, &positions, &mut self.rng);
            self.game.watch(viewer, &action, &mut ctx).map(|()| ctx.events().to_vec())
        }

        fn tick(&mut self, now: Millis) -> Events {
            let positions = HashMap::new();
            let mut ctx = Ctx::new(now, &self.here, &positions, &mut self.rng);
            self.game.tick(&mut ctx);
            ctx.events().to_vec()
        }

        /// `player` leaves, as the framework does it: out of the players first, then the game hears.
        fn leave(&mut self, player: usize, now: Millis) -> Events {
            let id = self.all[player].id;
            self.here.retain(|member| member.id != id);
            let positions = HashMap::new();
            let mut ctx = Ctx::new(now, &self.here, &positions, &mut self.rng);
            self.game.leave(id, &mut ctx);
            ctx.events().to_vec()
        }

        fn view(&self, player: Option<usize>) -> Value {
            self.game.view(player.map(|index| self.all[index].id), START)
        }

        /// The board as someone who asks now is sent it: its replay events, each with who they go to.
        fn board(&mut self, now: Millis) -> Events {
            let viewer = Uuid::new_v4();
            self.watch(viewer, json!({"replay": true}), now).unwrap()
        }
    }

    fn stroke(points: &[[f64; 2]], color: &str, size: u64) -> Value {
        json!({"stroke": {"points": points, "color": color, "size": size}})
    }

    fn joined(points: &[[f64; 2]], color: &str, size: u64) -> Value {
        json!({"stroke": {"points": points, "color": color, "size": size, "join": true}})
    }

    /// `count` points along a line, on the grid and each coordinate as long as it allows.
    fn line(count: u32) -> Vec<[f64; 2]> {
        (0..count).map(|index| [f64::from(1234 + index % 500) / 10_000.0, 0.5678]).collect()
    }

    /// The strokes a replay rebuilds: pieces with `join` carry on the stroke before them.
    fn rebuilt(events: &Events) -> Vec<Value> {
        let mut strokes: Vec<Value> = Vec::new();
        for (_, event) in events {
            for piece in event["strokes"].as_array().unwrap() {
                if piece["join"] == true {
                    let last = strokes.last_mut().unwrap();
                    let more = piece["points"].as_array().unwrap().clone();
                    last["points"].as_array_mut().unwrap().extend(more);
                } else {
                    strokes.push(json!({"points": piece["points"], "color": piece["color"], "size": piece["size"]}));
                }
            }
        }
        strokes
    }

    fn types(events: &Events) -> Vec<&str> {
        events.iter().map(|(_, event)| event["type"].as_str().unwrap()).collect()
    }

    #[test]
    fn players_draw_in_the_order_they_joined_for_eighty_seconds_and_the_word_shows_for_four() {
        let mut table = Table::new(3);
        let (a, b, c) = (table.id(0), table.id(1), table.id(2));
        let drawer = table.view(Some(0));
        assert_eq!(drawer["phase"], "drawing");
        assert_eq!((drawer["turn"].as_u64(), drawer["turns"].as_u64()), (Some(1), Some(3)));
        assert_eq!((drawer["drawer"].clone(), drawer["role"].clone()), (json!(a), json!("drawer")));
        assert_eq!((drawer["word"].clone(), drawer["letters"].clone()), (json!("사과"), json!(2)));
        assert_eq!(drawer["endsAt"], START + TURN);
        assert_eq!(drawer["guessed"], json!([]));
        assert_eq!(
            drawer["scores"],
            json!([
                {"id": a, "name": "player0", "score": 0},
                {"id": b, "name": "player1", "score": 0},
                {"id": c, "name": "player2", "score": 0},
            ])
        );
        assert_eq!(table.view(Some(1))["role"], "guesser");
        assert_eq!(table.view(None)["role"], "watcher");

        assert!(table.tick(START + TURN - 1).is_empty());
        let ended = table.tick(START + TURN);
        assert_eq!(ended, [(Audience::Everyone, json!({"type": "reveal", "turn": 1, "drawer": a, "word": "사과"}))]);
        for viewer in [Some(1), Some(2), None] {
            let view = table.view(viewer);
            assert_eq!((view["phase"].as_str(), view["word"].as_str()), (Some("reveal"), Some("사과")));
            assert_eq!(view["endsAt"], START + TURN + PAUSE);
        }
        assert!(table.tick(START + TURN + PAUSE - 1).is_empty());
        table.tick(START + TURN + PAUSE);
        let second = table.view(Some(1));
        assert_eq!((second["turn"].as_u64(), second["drawer"].clone()), (Some(2), json!(b)));
        assert_eq!((second["role"].as_str(), second["word"].as_str()), (Some("drawer"), Some("기린")));
        assert_eq!(second["endsAt"], START + 2 * TURN + PAUSE);
        assert_eq!(table.view(Some(0))["role"], "guesser");

        let mut now = START + TURN + PAUSE;
        for turn in 2..=3 {
            now += TURN;
            assert_eq!(table.tick(now)[0].1["turn"], turn);
            assert!(table.game.result().is_none());
            now += PAUSE;
            table.tick(now);
        }
        assert_eq!(table.view(None)["drawer"], json!(c));
        let result = table.game.result().expect("over after everyone has drawn once");
        assert_eq!(result["ranking"].as_array().unwrap().len(), 3);
        assert!(table.tick(now + TURN).is_empty(), "nothing moves once it is over");
    }

    #[test]
    fn twelve_players_play_eight_turns_with_eight_different_words() {
        let players: Vec<Member> =
            (0..12).map(|index| Member { id: Uuid::new_v4(), name: format!("player{index}") }).collect();
        let positions = HashMap::new();
        let words_of = |seed: u64| {
            let mut rng = StdRng::seed_from_u64(seed);
            let mut ctx = Ctx::new(START, &players, &positions, &mut rng);
            // Any layout is taken: nothing on the island is needed.
            let mut game = create(&json!({}), &mut ctx).unwrap();
            assert!(create(&Value::Null, &mut ctx).is_ok());
            assert_eq!(game.view(None, START)["turns"], 8);
            let mut words = Vec::new();
            let mut now = START;
            for player in players.iter().take(8) {
                let view = game.view(Some(player.id), now);
                assert_eq!(view["role"], "drawer");
                words.push(view["word"].as_str().unwrap().to_owned());
                now += TURN;
                game.tick(&mut Ctx::new(now, &players, &positions, &mut rng));
                now += PAUSE;
                game.tick(&mut Ctx::new(now, &players, &positions, &mut rng));
            }
            assert!(game.result().is_some());
            words
        };
        let words = words_of(5);
        let mut distinct = words.clone();
        distinct.sort();
        distinct.dedup();
        assert_eq!(distinct.len(), 8);
        assert!(words.iter().all(|word| words::WORDS.contains(&word.as_str())));
        assert_eq!(words_of(5), words, "the same seed picks the same words");
        assert_ne!(words_of(6), words);
    }

    #[test]
    fn a_right_guess_scores_by_the_time_left_and_the_turn_ends_once_everyone_has_it() {
        let mut table = Table::new(3);
        let (a, b, c) = (table.id(0), table.id(1), table.id(2));
        // 79 seconds left: 10 + 9.
        let events = table.act(1, json!({"guess": "사과"}), START + 1_000).unwrap();
        assert_eq!(events, [(Audience::Everyone, json!({"type": "guessed", "player": b, "points": 19}))]);
        let view = table.view(Some(2));
        assert_eq!(view["guessed"], json!([b]));
        assert_eq!(view["scores"][0]["score"], 5, "the drawer: 5 a guesser");
        assert_eq!(view["scores"][1]["score"], 19);
        assert_eq!(view["phase"], "drawing");
        assert_eq!(table.act(1, json!({"guess": "사과"}), START + 2_000), Err(ALREADY_GUESSED));
        assert_eq!(table.act(1, json!({"guess": "기린"}), START + 2_000), Err(ALREADY_GUESSED));
        // 7.999 seconds left: no bonus. The last guesser ends the turn at once.
        let events = table.act(2, json!({"guess": "사과"}), START + 72_001).unwrap();
        assert_eq!(types(&events), ["guessed", "reveal"]);
        assert_eq!(events[0].1["points"], 10);
        assert_eq!(events[1], (Audience::Everyone, json!({"type": "reveal", "turn": 1, "drawer": a, "word": "사과"})));
        let view = table.view(Some(0));
        assert_eq!((view["phase"].as_str(), view["endsAt"].as_u64()), (Some("reveal"), Some(START + 72_001 + PAUSE)));
        assert_eq!(
            view["scores"],
            json!([
                {"id": a, "name": "player0", "score": 10},
                {"id": b, "name": "player1", "score": 19},
                {"id": c, "name": "player2", "score": 10},
            ])
        );
        // Exactly eight seconds left is one point more; the whole turn left, ten more.
        let mut edge = Table::new(3);
        assert_eq!(edge.act(1, json!({"guess": "사과"}), START + TURN - 8_000).unwrap()[0].1["points"], 11);
        assert_eq!(edge.act(2, json!({"guess": "사과"}), START).unwrap()[0].1["points"], 20);
    }

    #[test]
    fn guesses_are_trimmed_and_match_without_spaces_or_case() {
        assert_eq!(plain(" Ab C\tD\u{3000}"), "abcd");
        let mut table = Table::with_words(3, vec!["New York"]);
        assert_eq!(table.act(1, json!({"guess": "  newyork "}), START).unwrap()[0].1["type"], "guessed");
        let mut table = Table::new(4);
        assert_eq!(table.act(1, json!({"guess": " 사 과 "}), START).unwrap()[0].1["type"], "guessed");
        // A wrong guess is said to everyone, trimmed.
        let wrong = table.act(2, json!({"guess": "  사과나무  "}), START).unwrap();
        assert_eq!(wrong, [(Audience::Everyone, json!({"type": "chat", "player": table.id(2), "text": "사과나무"}))]);
        let longest = "가".repeat(30);
        assert_eq!(table.act(2, json!({"guess": format!(" {longest} ")}), START).unwrap()[0].1["text"], longest);
        let long = "가".repeat(31);
        for bad in [json!(""), json!("   "), json!(long), json!("사\u{7}과"), json!("사\n과"), json!(3), json!(null)]
        {
            assert_eq!(table.act(2, json!({"guess": bad}), START), Err(BAD_GUESS), "{bad}");
        }
        // The drawer can neither guess nor say the word.
        assert_eq!(table.act(0, json!({"guess": "사과"}), START), Err(DRAWER_GUESS));
        assert_eq!(table.act(0, json!({"guess": "힌트"}), START), Err(DRAWER_GUESS));
        // Time is up before the tick has ended the turn, and during the pause: no guessing.
        assert_eq!(table.act(2, json!({"guess": "사과"}), START + TURN), Err(NOT_NOW));
        table.tick(START + TURN);
        assert_eq!(table.act(3, json!({"guess": "사과"}), START + TURN + 1), Err(NOT_NOW));
        assert_eq!(table.view(None)["guessed"], json!([table.id(1)]));
    }

    #[test]
    fn no_one_but_the_drawer_sees_the_word_until_the_turn_ends() {
        let mut table = Table::new(4);
        let mut now = START;
        for (turn, word) in TEST_WORDS.into_iter().enumerate().take(4) {
            let others: Vec<Option<usize>> = (0..4).filter(|player| *player != turn).map(Some).chain([None]).collect();
            let mut said = Vec::new();
            said.extend(table.act(turn, stroke(&[[0.5, 0.5]], PALETTE[0], 1), now).unwrap());
            let guesser = (turn + 1) % 4;
            said.extend(table.act(guesser, json!({"guess": "모르겠어"}), now).unwrap());
            said.extend(table.act(guesser, json!({"guess": word}), now).unwrap());
            said.extend(table.watch(Uuid::new_v4(), json!({"replay": true}), now).unwrap());
            for viewer in &others {
                let view = table.view(*viewer).to_string();
                assert!(!view.contains(word), "turn {turn}: {viewer:?} sees {view}");
                assert_eq!(table.view(*viewer)["letters"], word.chars().count());
            }
            assert_eq!(table.view(Some(turn))["word"], word);
            for (_, event) in &said {
                assert!(!event.to_string().contains(word), "{event}");
            }
            now += TURN;
            let reveal = table.tick(now);
            assert_eq!(reveal[0].1["word"], word, "the turn's end tells everyone");
            assert!(others.iter().all(|viewer| table.view(*viewer)["word"] == word));
            now += PAUSE;
            table.tick(now);
        }
    }

    #[test]
    fn strokes_are_checked_kept_to_the_grid_and_sent_to_everyone_but_the_drawer() {
        let mut table = Table::new(3);
        let a = table.id(0);
        let events = table.act(0, stroke(&[[0.123_46, 0.5], [1.0, 0.0], [0.000_04, 0.999_96]], "#e5484d", 2), START);
        assert_eq!(
            events.unwrap(),
            [(
                Audience::Except(vec![a]),
                json!({"type": "stroke", "turn": 1, "stroke": {
                    "points": [[0.1235, 0.5], [1.0, 0.0], [0.0, 1.0]], "color": "#e5484d", "size": 2, "join": false,
                }})
            )]
        );
        let lots = line(65);
        let bad = [
            json!({"stroke": {"color": "#222222", "size": 1}}),
            json!({"stroke": {"points": [], "color": "#222222", "size": 1}}),
            json!({"stroke": {"points": lots, "color": "#222222", "size": 1}}),
            json!({"stroke": {"points": [[1.0001, 0.5]], "color": "#222222", "size": 1}}),
            json!({"stroke": {"points": [[0.5, -0.1]], "color": "#222222", "size": 1}}),
            json!({"stroke": {"points": [[0.5, 0.5, 0.5]], "color": "#222222", "size": 1}}),
            json!({"stroke": {"points": [["0.5", 0.5]], "color": "#222222", "size": 1}}),
            json!({"stroke": {"points": [[0.5]], "color": "#222222", "size": 1}}),
            json!({"stroke": {"points": [[0.5, 0.5]], "size": 1}}),
            json!({"stroke": {"points": [[0.5, 0.5]], "color": "#000000", "size": 1}}),
            json!({"stroke": {"points": [[0.5, 0.5]], "color": "#E5484D", "size": 1}}),
            json!({"stroke": {"points": [[0.5, 0.5]], "color": "#222222", "size": 0}}),
            json!({"stroke": {"points": [[0.5, 0.5]], "color": "#222222", "size": 4}}),
            json!({"stroke": {"points": [[0.5, 0.5]], "color": "#222222", "size": 1.5}}),
            json!({"stroke": {"points": [[0.5, 0.5]], "color": "#222222", "size": "2"}}),
            json!({"stroke": {"points": [[0.5, 0.5]], "color": "#222222", "size": 2, "join": "yes"}}),
            json!({"stroke": [[0.5, 0.5]]}),
        ];
        for action in bad {
            assert_eq!(table.act(0, action.clone(), START + 1), Err(BAD_STROKE), "{action}");
        }
        // 64 points go in one message; a line goes on with `join`, in its own colour and size only.
        assert!(table.act(0, stroke(&line(64), "#3b82f6", 3), START + 2).is_ok());
        let more = table.act(0, joined(&[[0.9, 0.9]], "#3b82f6", 3), START + 3).unwrap();
        assert_eq!(more[0].1["stroke"]["join"], true);
        assert_eq!(table.act(0, joined(&[[0.9, 0.9]], "#e5484d", 3), START + 4), Err(BAD_STROKE));
        assert_eq!(table.act(0, joined(&[[0.9, 0.9]], "#3b82f6", 1), START + 4), Err(BAD_STROKE));
        assert_eq!(table.act(1, stroke(&[[0.5, 0.5]], "#222222", 1), START + 4), Err(NOT_DRAWER));
        let board = rebuilt(&table.board(START + 5));
        assert_eq!(board.len(), 2);
        assert_eq!(board[1]["points"].as_array().unwrap().len(), MAX_PIECE + 1);
        assert_eq!(board[0]["points"], json!([[0.1235, 0.5], [1.0, 0.0], [0.0, 1.0]]));
        // A blank board takes no `join`.
        let mut blank = Table::new(2);
        assert_eq!(blank.act(0, joined(&[[0.5, 0.5]], "#222222", 1), START), Err(BAD_STROKE));
        // Once time is up, and during the pause, what the drawer still sends is dropped.
        assert_eq!(table.act(0, stroke(&[[0.5, 0.5]], "#222222", 1), START + TURN), Ok(vec![]));
        assert_eq!(table.act(0, json!({"clear": true}), START + TURN), Ok(vec![]));
        table.tick(START + TURN);
        assert_eq!(table.act(0, json!({"undo": true}), START + TURN + 1), Ok(vec![]));
        assert_eq!(table.act(0, joined(&[[0.1, 0.1]], "#3b82f6", 3), START + TURN + 1), Ok(vec![]));
        assert_eq!(table.act(0, stroke(&[[2.0, 0.1]], "#3b82f6", 3), START + TURN + 1), Err(BAD_STROKE));
        assert_eq!(rebuilt(&table.board(START + TURN + 2)), board);
    }

    #[test]
    fn the_board_holds_six_hundred_strokes_and_twenty_thousand_points() {
        let mut table = Table::new(2);
        for index in 0..MAX_STROKES {
            assert!(table.act(0, stroke(&[[0.5, 0.5]], PALETTE[index % 8], 1), START).is_ok(), "{index}");
        }
        assert_eq!(table.act(0, stroke(&[[0.5, 0.5]], "#222222", 1), START), Err(BOARD_FULL));
        // The last stroke still goes on; taking one away makes room for one.
        assert!(table.act(0, joined(&[[0.6, 0.6]], PALETTE[(MAX_STROKES - 1) % 8], 1), START).is_ok());
        assert!(table.act(0, json!({"undo": true}), START).is_ok());
        assert!(table.act(0, stroke(&[[0.5, 0.5]], "#222222", 1), START).is_ok());
        assert_eq!(table.act(0, stroke(&[[0.5, 0.5]], "#222222", 1), START), Err(BOARD_FULL));

        let mut table = Table::new(2);
        let full = MAX_POINTS / MAX_PIECE;
        for _ in 0..full {
            assert!(table.act(0, stroke(&line(64), "#222222", 2), START).is_ok());
        }
        let left = u32::try_from(MAX_POINTS - full * MAX_PIECE).unwrap();
        assert_eq!(table.act(0, stroke(&line(left + 1), "#222222", 2), START), Err(BOARD_FULL));
        assert!(table.act(0, stroke(&line(left), "#222222", 2), START).is_ok());
        assert_eq!(table.act(0, joined(&line(1), "#222222", 2), START), Err(BOARD_FULL));
        assert_eq!(table.game.points, MAX_POINTS);
        assert!(table.act(0, json!({"clear": true}), START).is_ok());
        assert!(table.act(0, stroke(&line(64), "#222222", 2), START).is_ok());
        assert_eq!(table.game.points, MAX_PIECE);
    }

    #[test]
    fn undo_takes_the_whole_last_stroke_and_clear_the_whole_board() {
        let mut table = Table::new(3);
        let a = table.id(0);
        table.act(0, stroke(&[[0.1, 0.1], [0.2, 0.2]], "#222222", 1), START).unwrap();
        table.act(0, stroke(&[[0.3, 0.3]], "#30a46c", 3), START).unwrap();
        table.act(0, joined(&[[0.4, 0.4], [0.5, 0.5]], "#30a46c", 3), START).unwrap();
        let undone = table.act(0, json!({"undo": true}), START + 1).unwrap();
        assert_eq!(undone, [(Audience::Except(vec![a]), json!({"type": "undo", "turn": 1}))]);
        assert_eq!(
            rebuilt(&table.board(START + 2)),
            [json!({"points": [[0.1, 0.1], [0.2, 0.2]], "color": "#222222", "size": 1})]
        );
        assert_eq!(table.game.points, 2);
        assert_eq!(table.act(1, json!({"undo": true}), START + 3), Err(NOT_DRAWER));
        assert_eq!(table.act(2, json!({"clear": true}), START + 3), Err(NOT_DRAWER));
        let cleared = table.act(0, json!({"clear": true}), START + 3).unwrap();
        assert_eq!(cleared, [(Audience::Except(vec![a]), json!({"type": "clear", "turn": 1}))]);
        assert_eq!(rebuilt(&table.board(START + 4)), Vec::<Value>::new());
        assert_eq!(table.game.points, 0);
        assert_eq!(table.act(0, json!({"undo": true}), START + 5), Err(NOTHING_TO_UNDO));
        assert!(table.act(0, json!({"clear": true}), START + 5).is_ok(), "a blank board clears again");
    }

    #[test]
    fn a_replay_goes_to_whoever_asked_alone_in_parts_of_bounded_size() {
        let mut table = Table::new(3);
        let (b, c) = (table.id(1), table.id(2));
        // A blank board: one empty part.
        let empty = table.act(1, json!({"replay": true}), START).unwrap();
        assert_eq!(
            empty,
            [(Audience::Only(vec![b]), json!({"type": "replay", "turn": 1, "part": 0, "parts": 1, "strokes": []}))]
        );
        // Two long lines and hundreds of short ones, every coordinate as long as the grid allows.
        let mut sent: Vec<Value> = Vec::new();
        for color in ["#8e4ec6", "#f5a524"] {
            table.act(0, stroke(&line(64), color, 3), START).unwrap();
            for _ in 1..100 {
                table.act(0, joined(&line(64), color, 3), START).unwrap();
            }
            sent.push(json!({"points": line(64).repeat(100), "color": color, "size": 3}));
        }
        for index in 0..550 {
            let mut points = line(10);
            points.push([0.9999, f64::from(index + 1) / 10_000.0]);
            table.act(0, stroke(&points, "#ffd60a", 1), START).unwrap();
            sent.push(json!({"points": points, "color": "#ffd60a", "size": 1}));
        }
        assert_eq!(table.game.points, 2 * 6_400 + 550 * 11);
        let parts = table.act(2, json!({"replay": true}), START + 10).unwrap();
        assert!(parts.len() > 10);
        for (index, (audience, part)) in parts.iter().enumerate() {
            assert_eq!(audience, &Audience::Only(vec![c]));
            assert_eq!((part["part"].as_u64(), part["parts"].as_u64()), (Some(index as u64), Some(parts.len() as u64)));
            assert_eq!(part["turn"], 1);
            let pieces = part["strokes"].as_array().unwrap();
            let points: usize = pieces.iter().map(|piece| piece["points"].as_array().unwrap().len()).sum();
            assert!(pieces.len() <= REPLAY_PIECES && points <= REPLAY_POINTS, "part {index}");
            // As the socket sends it, well under a client frame's 16 KiB.
            let frame = json!({"type": "Event", "kind": "draw", "event": part}).to_string();
            assert!(frame.len() < 13 * 1024, "part {index}: {} bytes", frame.len());
        }
        assert_eq!(rebuilt(&parts), sent);
        // Asking again within a second is answered a beat later, by the tick; others are not held up.
        assert!(table.act(2, json!({"replay": true}), START + 500).unwrap().is_empty());
        let drawer = table.act(0, json!({"replay": true}), START + 500).unwrap();
        assert_eq!((drawer.len(), drawer[0].0.clone()), (parts.len(), Audience::Only(vec![table.id(0)])));
        assert!(table.tick(START + 1_009).is_empty());
        let later = table.tick(START + 1_010);
        assert_eq!(later.len(), parts.len());
        assert!(later.iter().all(|(audience, _)| audience == &Audience::Only(vec![c])));
        assert!(table.tick(START + 2_500).is_empty(), "once");
        // Someone watching may ask too, and only for this.
        let watcher = Uuid::new_v4();
        let watched = table.watch(watcher, json!({"replay": true}), START + 3_000).unwrap();
        assert_eq!(watched[0].0, Audience::Only(vec![watcher]));
        assert_eq!(table.watch(watcher, json!({"guess": "사과"}), START + 3_000), Err(BAD_ACTION));
        assert_eq!(table.watch(watcher, json!({"clear": true}), START + 3_000), Err(BAD_ACTION));
        // A player who leaves while waiting is not sent it.
        table.act(1, json!({"replay": true}), START + 3_100).unwrap();
        table.act(1, json!({"replay": true}), START + 3_200).unwrap();
        table.leave(1, START + 3_300);
        assert!(table.tick(START + 5_000).is_empty());
        // The pause shows the finished drawing; the next turn starts blank.
        table.tick(START + TURN);
        assert_eq!(rebuilt(&table.board(START + TURN + 1)), sent);
        table.tick(START + TURN + PAUSE);
        let blank = table.board(START + TURN + PAUSE + 1);
        assert_eq!(blank[0].1, json!({"type": "replay", "turn": 2, "part": 0, "parts": 1, "strokes": []}));
    }

    #[test]
    fn players_who_leave_drop_out_and_the_turns_close_up() {
        let mut table = Table::new(4);
        let (a, b, d) = (table.id(0), table.id(1), table.id(3));
        // C leaves before their turn: three turns now.
        assert!(table.leave(2, START + 1_000).is_empty());
        assert_eq!(table.view(None)["turns"], 3);
        assert_eq!(table.view(None)["scores"].as_array().unwrap().len(), 3);
        // The drawer leaves mid-turn: the word is told and the pause begins.
        let gone = table.leave(0, START + 2_000);
        assert_eq!(gone, [(Audience::Everyone, json!({"type": "reveal", "turn": 1, "drawer": a, "word": "사과"}))]);
        assert_eq!(table.view(None)["endsAt"], START + 2_000 + PAUSE);
        table.tick(START + 2_000 + PAUSE);
        assert_eq!((table.view(None)["turn"].as_u64(), table.view(None)["drawer"].clone()), (Some(2), json!(b)));
        // B's turn runs out; D draws the last one.
        table.tick(START + 2_000 + PAUSE + TURN);
        table.tick(START + 2_000 + 2 * PAUSE + TURN);
        let view = table.view(Some(3));
        assert_eq!((view["turn"].as_u64(), view["drawer"].clone()), (Some(3), json!(d)));
        assert_eq!(view["role"], "drawer");
        // Down to one player: the word is told and the game ends with them.
        let last = table.leave(1, START + 2_000 + 2 * PAUSE + TURN + 1_000);
        assert_eq!(types(&last), ["reveal"]);
        let result = table.game.result().unwrap();
        assert_eq!(result, json!({"ranking": [{"id": d, "name": "player3", "score": 0, "rank": 1}]}));

        // A guesser leaving when everyone left has guessed ends the turn.
        let mut table = Table::new(3);
        table.act(1, json!({"guess": "사과"}), START + 1_000).unwrap();
        assert_eq!(table.view(None)["phase"], "drawing");
        let events = table.leave(2, START + 2_000);
        assert_eq!(types(&events), ["reveal"]);
        assert_eq!(table.view(None)["guessed"], json!([table.id(1)]));
        // Leaving during the pause changes nothing but the scores; the last turn's end ends the game.
        let mut table = Table::new(3);
        table.tick(START + TURN);
        assert!(table.leave(1, START + TURN + 1).is_empty());
        assert_eq!(table.view(None)["phase"], "reveal");
        table.tick(START + TURN + PAUSE);
        assert_eq!(table.view(None)["drawer"], json!(table.id(2)));
    }

    #[test]
    fn the_ranking_puts_the_most_points_first_and_ties_share_a_place() {
        let mut table = Table::new(4);
        let ids: Vec<Uuid> = (0..4).map(|player| table.id(player)).collect();
        table.game.scores = HashMap::from([(ids[0], 12), (ids[1], 30), (ids[2], 30), (ids[3], 5)]);
        assert!(table.game.result().is_none());
        table.game.over = true;
        let ranking = table.game.result().unwrap()["ranking"].clone();
        assert_eq!(
            ranking,
            json!([
                {"id": ids[1], "name": "player1", "score": 30, "rank": 1},
                {"id": ids[2], "name": "player2", "score": 30, "rank": 1},
                {"id": ids[0], "name": "player0", "score": 12, "rank": 3},
                {"id": ids[3], "name": "player3", "score": 5, "rank": 4},
            ])
        );
    }

    #[test]
    fn an_action_is_one_known_field() {
        let mut table = Table::new(2);
        for action in [
            json!({}),
            json!("undo"),
            json!({"dance": true}),
            json!({"undo": false}),
            json!({"clear": 1}),
            json!({"replay": "yes"}),
            json!({"undo": true, "clear": true}),
        ] {
            assert_eq!(table.act(0, action.clone(), START), Err(BAD_ACTION), "{action}");
        }
    }
}
