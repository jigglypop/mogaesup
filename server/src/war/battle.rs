//! Tactical battle core. Online match routes and persistence are not connected yet.
use super::{Army, Catalog};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const WIDTH: i32 = 11;
pub const HEIGHT: i32 = 9;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unit {
    pub id: usize,
    pub side: usize,
    pub role: String,
    pub x: i32,
    pub y: i32,
    pub hp: f64,
    pub max_hp: f64,
    pub damage: f64,
    pub armor: f64,
    pub movement: i32,
    pub range: i32,
    pub acted: bool,
    pub moved: bool,
    pub guarding: bool,
    pub retaliated: bool,
    pub cooldown: u32,
    pub attacks: u32,
    pub shield: f64,
    pub boost: bool,
    pub slowed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Battle {
    pub version: String,
    pub armies: [Army; 2],
    pub units: Vec<Unit>,
    pub walls: Vec<[i32; 2]>,
    pub map: String,
    pub side: usize,
    pub round: u32,
    pub revision: u32,
    pub locked_unit: Option<usize>,
    pub command_cooldown: [u32; 2],
    pub log: Vec<String>,
    pub winner: Option<usize>,
    pub finished: bool,
    pub seed: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Action {
    pub kind: String,
    pub unit: Option<usize>,
    pub target: Option<usize>,
    pub x: Option<i32>,
    pub y: Option<i32>,
}

impl Action {
    pub fn new(kind: &str, unit: usize, target: Option<usize>) -> Self {
        Self { kind: kind.into(), unit: Some(unit), target, x: None, y: None }
    }
}

fn distance(a: (i32, i32), b: (i32, i32)) -> i32 {
    (a.0 - b.0).abs() + (a.1 - b.1).abs()
}

impl Battle {
    pub fn new(catalog: &Catalog, armies: [Army; 2], map: &str, seed: u64, first: usize) -> Result<Self, &'static str> {
        for army in &armies {
            catalog.validate(army, None)?;
        }
        if first > 1 {
            return Err("선공 진영이 올바르지 않습니다.");
        }
        if !["plain", "ruins", "crossing"].contains(&map) {
            return Err("알 수 없는 전장입니다.");
        }
        let mut units = Vec::new();
        for (side, army) in armies.iter().enumerate() {
            let faction = catalog.faction(&army.faction).expect("validated army");
            for (slot, id) in army.units.iter().enumerate() {
                let role = catalog.role(id).expect("validated role");
                let ranged = role.range > 2.;
                let (depth, y) = match army.formation.as_str() {
                    "spread" => ((slot / 4) as i32, [1, 3, 5, 7, 2, 6][slot]),
                    "wedge" => ((slot % 3) as i32, slot as i32 + 1),
                    _ => (i32::from(ranged), slot as i32 + 1),
                };
                let hp = role.health * faction.health;
                units.push(Unit {
                    id: units.len(),
                    side,
                    role: id.clone(),
                    x: if side == 0 { 2 - depth } else { 8 + depth },
                    y,
                    hp,
                    max_hp: hp,
                    damage: role.damage * faction.damage * faction.power,
                    armor: role.armor * faction.armor,
                    movement: (role.speed * faction.speed).round().clamp(2., 4.) as i32,
                    // First convert the role's range to grid cells. Apply the faction multiplier once,
                    // rounding up so grove's 15% bonus retains its existing extra cell.
                    range: if ranged {
                        ((role.range * 0.65).round() * faction.range).ceil().clamp(1., (WIDTH + HEIGHT - 2) as f64)
                            as i32
                    } else {
                        1
                    },
                    acted: false,
                    moved: false,
                    guarding: false,
                    retaliated: false,
                    cooldown: 0,
                    attacks: 0,
                    shield: 0.,
                    boost: false,
                    slowed: false,
                });
            }
        }
        let walls = match map {
            "ruins" => vec![[5, 2], [5, 3], [5, 5], [5, 6]],
            "crossing" => vec![[4, 1], [6, 1], [4, 7], [6, 7], [5, 4]],
            _ => vec![],
        };
        Ok(Self {
            version: catalog.version.clone(),
            armies,
            units,
            walls,
            map: map.into(),
            side: first,
            round: 1,
            revision: 0,
            locked_unit: None,
            command_cooldown: [0, 0],
            log: vec!["두 군단이 전장에 도착했습니다.".into()],
            winner: None,
            finished: false,
            seed,
        })
    }

    pub fn reachable(&self, id: usize) -> Vec<[i32; 2]> {
        let Some(unit) = self.units.get(id) else { return vec![] };
        if unit.hp <= 0. || unit.moved || unit.acted {
            return vec![];
        }
        let limit = (unit.movement - i32::from(unit.slowed)).max(1);
        let mut seen = vec![[unit.x, unit.y]];
        let mut queue = VecDeque::from([(unit.x, unit.y, 0)]);
        while let Some((x, y, steps)) = queue.pop_front() {
            if steps == limit {
                continue;
            }
            for [dx, dy] in [[1, 0], [-1, 0], [0, 1], [0, -1]] {
                let cell = [x + dx, y + dy];
                if !(0..WIDTH).contains(&cell[0])
                    || !(0..HEIGHT).contains(&cell[1])
                    || seen.contains(&cell)
                    || self.walls.contains(&cell)
                    || self.units.iter().any(|u| u.hp > 0. && [u.x, u.y] == cell)
                {
                    continue;
                }
                seen.push(cell);
                queue.push_back((cell[0], cell[1], steps + 1));
            }
        }
        seen.into_iter().skip(1).collect()
    }

    pub fn visible(&self, from: (i32, i32), to: (i32, i32)) -> bool {
        let steps = (from.0 - to.0).abs().max((from.1 - to.1).abs());
        (1..steps).all(|i| {
            let t = i as f64 / steps as f64;
            let cell = [
                (from.0 as f64 + (to.0 - from.0) as f64 * t).round() as i32,
                (from.1 as f64 + (to.1 - from.1) as f64 * t).round() as i32,
            ];
            !self.walls.contains(&cell)
        })
    }

    pub fn can_attack(&self, a: usize, b: usize) -> bool {
        let (Some(a), Some(b)) = (self.units.get(a), self.units.get(b)) else { return false };
        a.hp > 0.
            && b.hp > 0.
            && a.side != b.side
            && distance((a.x, a.y), (b.x, b.y)) <= a.range + i32::from(a.boost && self.armies[a.side].faction == "cog")
            && self.visible((a.x, a.y), (b.x, b.y))
    }

    fn random(&mut self) -> f64 {
        self.seed = self.seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.seed >> 32) as u32) as f64 / u32::MAX as f64
    }

    fn hurt(&mut self, target: usize, raw: f64, pierce: bool) -> f64 {
        let u = &self.units[target];
        let faction = self.armies[u.side].faction.as_str();
        let nearby = self
            .units
            .iter()
            .any(|v| v.id != target && v.side == u.side && v.hp > 0. && distance((u.x, u.y), (v.x, v.y)) <= 1);
        let leader = self.units.iter().any(|v| {
            v.id != target
                && v.side == u.side
                && v.hp > 0.
                && v.role == "champion"
                && distance((u.x, u.y), (v.x, v.y)) <= 2
        });
        let armor = u.armor * if pierce { 0.5 } else { 1. } + if u.guarding { 45. } else { 0. };
        let mut damage = raw * 100. / (100. + armor);
        if faction == "dawn" && nearby {
            damage *= 0.88;
        }
        if leader {
            damage *= 0.92;
        }
        if faction == "iron" {
            damage = (damage - 2.).max(1.);
        }
        let absorbed = self.units[target].shield.min(damage);
        self.units[target].shield -= absorbed;
        let actual = (damage - absorbed).min(self.units[target].hp);
        self.units[target].hp = (self.units[target].hp - actual).max(0.);
        actual
    }

    fn strike(&mut self, actor: usize, target: usize, scale: f64, retaliation: bool) {
        let a = self.units[actor].clone();
        let faction = self.armies[a.side].faction.clone();
        let mut raw = a.damage * scale * (0.9 + self.random() * 0.2);
        if a.boost {
            raw *= 1.25;
        }
        if faction == "fang" {
            raw *= 1. + (1. - a.hp / a.max_hp) * 0.3;
        }
        if faction == "grove" && a.attacks == 0 {
            raw *= 1.2;
        }
        if a.role == "rider" && a.attacks == 0 {
            raw *= 1.35;
        }
        if faction == "cog" && a.attacks % 3 == 2 {
            raw *= 1.35;
        }
        self.units[actor].attacks += 1;
        if a.range > 1 && distance((a.x, a.y), (self.units[target].x, self.units[target].y)) == 1 {
            raw *= 0.65;
        }
        let dealt = self.hurt(target, raw, a.role == "mystic");
        if faction == "veil" {
            self.units[actor].hp = (a.hp + dealt * 0.16).min(a.max_hp);
        }
        if faction == "ember" {
            let t = self.units[target].clone();
            let splash: Vec<usize> = self
                .units
                .iter()
                .filter(|u| u.side != a.side && u.hp > 0. && u.id != target && distance((u.x, u.y), (t.x, t.y)) <= 1)
                .map(|u| u.id)
                .collect();
            for id in splash {
                self.hurt(id, raw * 0.2, false);
            }
        }
        self.log.push(format!("{}번 → {}번: 피해 {}", actor + 1, target + 1, dealt.round()));
        if !retaliation
            && a.range == 1
            && self.units[target].hp > 0.
            && !self.units[target].retaliated
            && distance((a.x, a.y), (self.units[target].x, self.units[target].y)) == 1
        {
            self.units[target].retaliated = true;
            self.strike(target, actor, 0.65, true);
        }
    }

    fn command(&mut self) -> Result<(), &'static str> {
        if self.command_cooldown[self.side] > 0 {
            return Err("진영 명령을 아직 사용할 수 없습니다.");
        }
        let faction = self.armies[self.side].faction.clone();
        match faction.as_str() {
            "ember" => {
                let center = self
                    .units
                    .iter()
                    .filter(|u| u.side != self.side && u.hp > 0.)
                    .max_by_key(|t| {
                        self.units
                            .iter()
                            .filter(|u| u.side != self.side && u.hp > 0. && distance((u.x, u.y), (t.x, t.y)) <= 1)
                            .count()
                    })
                    .map(|t| (t.x, t.y));
                if let Some(center) = center {
                    let targets: Vec<usize> = self
                        .units
                        .iter()
                        .filter(|u| u.side != self.side && u.hp > 0. && distance((u.x, u.y), center) <= 1)
                        .map(|u| u.id)
                        .collect();
                    for id in targets {
                        self.hurt(id, 18., true);
                    }
                }
            }
            _ => {
                for u in &mut self.units {
                    if u.hp <= 0. {
                        continue;
                    }
                    if u.side == self.side {
                        match faction.as_str() {
                            "dawn" => u.shield = u.shield.max(14.),
                            "grove" => {
                                u.slowed = false;
                                u.shield = u.shield.max(6.);
                                u.boost = true;
                            }
                            "iron" => {
                                u.guarding = true;
                                u.shield = u.shield.max(6.);
                            }
                            "fang" | "cog" => u.boost = true,
                            "veil" => u.hp = (u.hp + u.max_hp * 0.1).min(u.max_hp),
                            "tide" => u.hp = (u.hp + u.max_hp * 0.05).min(u.max_hp),
                            _ => {}
                        }
                    } else if faction == "tide" {
                        u.slowed = true;
                    }
                }
            }
        }
        self.command_cooldown[self.side] = 3;
        self.log.push(format!("{}: {}", self.armies[self.side].faction, super::command_name(&faction)));
        Ok(())
    }

    fn ability(&mut self, actor: usize, target: Option<usize>) -> Result<(), &'static str> {
        let a = self.units[actor].clone();
        if a.cooldown > 0 {
            return Err("특수능력을 아직 사용할 수 없습니다.");
        }
        match a.role.as_str() {
            "guard" => {
                self.units[actor].shield += 35.;
                self.units[actor].guarding = true;
            }
            "mystic" | "champion" => {
                let t = target.unwrap_or(actor);
                let u = self.units.get(t).ok_or("대상이 없습니다.")?;
                if u.hp <= 0. || u.side != a.side || distance((a.x, a.y), (u.x, u.y)) > 3 {
                    return Err("3칸 안의 생존한 아군을 선택해 주세요.");
                }
                if a.role == "mystic" {
                    self.units[t].hp = (u.hp + 45.).min(u.max_hp);
                } else {
                    self.units[t].shield += 40.;
                }
            }
            _ => {
                let t = target.ok_or("적 대상을 선택해 주세요.")?;
                if !self.can_attack(actor, t) {
                    return Err("공격 범위 안의 적을 선택해 주세요.");
                }
                let center = (self.units[t].x, self.units[t].y);
                self.strike(actor, t, if a.role.starts_with("special") { 1.35 } else { 1.6 }, false);
                if a.role.starts_with("special") {
                    let targets: Vec<usize> = self
                        .units
                        .iter()
                        .filter(|u| u.side != a.side && u.hp > 0. && distance((u.x, u.y), center) <= 1)
                        .map(|u| u.id)
                        .collect();
                    for id in targets {
                        if id != t {
                            self.hurt(id, a.damage * 0.5, true);
                        }
                        if a.role == "special_b" {
                            self.units[id].slowed = true;
                        }
                    }
                }
            }
        }
        self.units[actor].cooldown = 3;
        self.log.push(format!("{}번 특수능력", actor + 1));
        Ok(())
    }

    pub fn act(&mut self, side: usize, action: &Action) -> Result<(), &'static str> {
        if self.finished {
            return Err("이미 끝난 전투입니다.");
        }
        if side > 1 {
            return Err("진영이 올바르지 않습니다.");
        }
        if side != self.side {
            return Err("상대의 차례입니다.");
        }
        if action.kind == "resign" {
            self.finished = true;
            self.winner = Some(1 - side);
            self.revision += 1;
            return Ok(());
        }
        if action.kind == "command" {
            self.command()?;
            self.revision += 1;
            self.check_end();
            return Ok(());
        }
        let id = action.unit.ok_or("피규어를 선택해 주세요.")?;
        let u = self.units.get(id).ok_or("피규어가 없습니다.")?;
        if u.side != side || u.hp <= 0. || u.acted {
            return Err("행동 가능한 내 피규어를 선택해 주세요.");
        }
        if self.locked_unit.is_some_and(|locked| locked != id) {
            return Err("이동한 피규어의 행동을 먼저 마쳐 주세요.");
        }
        match action.kind.as_str() {
            "move" => {
                let target =
                    [action.x.ok_or("이동할 칸을 선택해 주세요.")?, action.y.ok_or("이동할 칸을 선택해 주세요.")?];
                if !self.reachable(id).contains(&target) {
                    return Err("이동할 수 없는 칸입니다.");
                }
                self.units[id].x = target[0];
                self.units[id].y = target[1];
                self.units[id].moved = true;
                self.locked_unit = Some(id);
                self.revision += 1;
                return Ok(());
            }
            "attack" => {
                let target = action.target.ok_or("적을 선택해 주세요.")?;
                if !self.can_attack(id, target) {
                    return Err("공격할 수 없는 대상입니다.");
                }
                self.strike(id, target, 1., false);
            }
            "ability" => self.ability(id, action.target)?,
            "defend" => {
                self.units[id].guarding = true;
                self.log.push(format!("{}번 방어", id + 1));
            }
            _ => return Err("알 수 없는 명령입니다."),
        }
        self.units[id].acted = true;
        self.locked_unit = None;
        self.revision += 1;
        self.check_end();
        if !self.finished {
            self.advance();
        }
        if self.log.len() > 14 {
            self.log.drain(..self.log.len() - 14);
        }
        Ok(())
    }

    fn check_end(&mut self) {
        let alive = [0, 1].map(|s| self.units.iter().any(|u| u.side == s && u.hp > 0.));
        if !alive[0] || !alive[1] {
            self.finished = true;
            self.winner = if alive[0] {
                Some(0)
            } else if alive[1] {
                Some(1)
            } else {
                None
            };
        }
    }

    fn advance(&mut self) {
        let pending = [0, 1].map(|s| self.units.iter().any(|u| u.side == s && u.hp > 0. && !u.acted));
        if pending[1 - self.side] {
            self.side = 1 - self.side;
        } else if !pending[self.side] {
            self.round += 1;
            if self.round > 45 {
                self.finished = true;
                return;
            }
            self.side = (self.round as usize + (self.seed as usize & 1)) % 2;
            for u in &mut self.units {
                u.acted = false;
                u.moved = false;
                u.guarding = false;
                u.retaliated = false;
                u.boost = false;
                u.slowed = false;
                u.cooldown = u.cooldown.saturating_sub(1);
                u.shield *= 0.5;
                if u.hp > 0. && self.armies[u.side].faction == "tide" {
                    u.hp = (u.hp + u.max_hp * 0.04).min(u.max_hp);
                }
            }
            for c in &mut self.command_cooldown {
                *c = c.saturating_sub(1);
            }
        }
    }

    /// A bounded, deterministic tactical opponent. Used by practice and the balance report, not a claim of optimal play.
    pub fn ai_action(&self) -> Action {
        if self.command_cooldown[self.side] == 0 {
            return Action { kind: "command".into(), unit: None, target: None, x: None, y: None };
        }
        let candidates: Vec<&Unit> = self
            .units
            .iter()
            .filter(|u| u.side == self.side && u.hp > 0. && !u.acted && self.locked_unit.is_none_or(|id| u.id == id))
            .collect();
        for u in &candidates {
            if u.cooldown == 0
                && u.role == "mystic"
                && let Some(t) = self
                    .units
                    .iter()
                    .filter(|t| {
                        t.hp > 0. && t.side == u.side && t.max_hp - t.hp >= 40. && distance((u.x, u.y), (t.x, t.y)) <= 3
                    })
                    .min_by(|a, b| (a.hp / a.max_hp).total_cmp(&(b.hp / b.max_hp)))
            {
                return Action::new("ability", u.id, Some(t.id));
            }
            if let Some(t) =
                self.units.iter().filter(|t| self.can_attack(u.id, t.id)).min_by(|a, b| a.hp.total_cmp(&b.hp))
            {
                let ability = u.cooldown == 0 && !["guard", "mystic", "champion"].contains(&u.role.as_str());
                return Action::new(if ability { "ability" } else { "attack" }, u.id, Some(t.id));
            }
        }
        let mut best: Option<(i32, usize, [i32; 2])> = None;
        for u in &candidates {
            let enemies: Vec<&Unit> = self.units.iter().filter(|t| t.side != u.side && t.hp > 0.).collect();
            for p in self.reachable(u.id) {
                let score = enemies
                    .iter()
                    .map(|t| {
                        let d = distance((p[0], p[1]), (t.x, t.y));
                        (d - u.range).max(0) * 10 + if self.visible((p[0], p[1]), (t.x, t.y)) { 0 } else { 20 }
                    })
                    .min()
                    .unwrap_or(1000);
                if best.is_none_or(|b| score < b.0) {
                    best = Some((score, u.id, p));
                }
            }
        }
        if let Some((_, id, p)) = best {
            return Action { kind: "move".into(), unit: Some(id), target: None, x: Some(p[0]), y: Some(p[1]) };
        }
        Action::new("defend", candidates.first().map_or(0, |u| u.id), None)
    }

    pub fn autoplay(&mut self) {
        for _ in 0..1800 {
            if self.finished {
                break;
            }
            let action = self.ai_action();
            if self.act(self.side, &action).is_err() {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::war::{catalog, preset};

    fn battle() -> Battle {
        Battle::new(catalog(), [preset("dawn", 0), preset("fang", 0)], "ruins", 42, 0).unwrap()
    }

    #[test]
    fn rejects_wrong_turn_and_illegal_movement_without_changing_state() {
        let mut b = battle();
        let before = serde_json::to_value(&b).unwrap();
        assert!(b.act(1, &Action::new("attack", 6, Some(0))).is_err());
        assert!(
            b.act(0, &Action { kind: "move".into(), unit: Some(0), target: None, x: Some(100), y: Some(0) }).is_err()
        );
        assert_eq!(serde_json::to_value(&b).unwrap(), before);
    }

    #[test]
    fn moving_locks_the_unit_and_cannot_happen_twice() {
        let mut b = battle();
        let p = b.reachable(0)[0];
        let a = Action { kind: "move".into(), unit: Some(0), target: None, x: Some(p[0]), y: Some(p[1]) };
        b.act(0, &a).unwrap();
        assert!(b.act(0, &a).is_err());
        assert!(b.act(0, &Action::new("defend", 1, None)).is_err());
        b.act(0, &Action::new("defend", 0, None)).unwrap();
        assert_eq!(b.side, 1);
    }

    #[test]
    fn all_factions_and_special_presets_are_legal_and_resolve_reproducibly() {
        let c = catalog();
        for f in &c.factions {
            for p in 0..4 {
                c.validate(&preset(&f.id, p), None).unwrap();
            }
        }
        let mut a = battle();
        let mut b = a.clone();
        a.autoplay();
        b.autoplay();
        assert!(a.finished);
        assert_eq!(serde_json::to_value(&a).unwrap(), serde_json::to_value(&b).unwrap());
    }

    #[test]
    fn collection_budget_duplicate_and_special_limits_are_enforced() {
        let c = catalog();
        let mut a = preset("dawn", 0);
        assert!(c.validate(&a, Some(&[])).is_err());
        a.units = vec!["champion".into(); 4];
        assert!(c.validate(&a, None).is_err());
        a.units = ["special_a", "special_b", "soldier"].map(String::from).into();
        assert!(c.validate(&a, None).is_err());
    }

    #[test]
    fn constructor_refuses_invalid_armies_maps_sides_and_stats() {
        let c = catalog();
        let make = |army, map, first| Battle::new(c, [army, preset("fang", 0)], map, 42, first);
        let mut army = preset("dawn", 0);
        army.faction = "unknown".into();
        assert!(make(army, "plain", 0).is_err());
        let mut army = preset("dawn", 0);
        army.units[0] = "unknown".into();
        assert!(make(army, "plain", 0).is_err());
        let mut army = preset("dawn", 0);
        army.units = vec!["guard".into(); 7];
        army.formation = "spread".into();
        assert!(make(army, "plain", 0).is_err());
        let mut army = preset("dawn", 0);
        army.formation = "unknown".into();
        assert!(make(army, "plain", 0).is_err());
        assert!(make(preset("dawn", 0), "unknown", 0).is_err());
        assert!(make(preset("dawn", 0), "plain", usize::MAX).is_err());

        for invalid in [f64::NAN, f64::INFINITY, -1., 0.] {
            let mut modified = c.clone();
            modified.roles[0].health = invalid;
            assert!(Battle::new(&modified, [preset("dawn", 0), preset("fang", 0)], "plain", 42, 0).is_err());
        }
        let mut modified = c.clone();
        modified.roles[0].cost = u32::MAX;
        assert!(Battle::new(&modified, [preset("dawn", 0), preset("fang", 0)], "plain", 42, 0).is_err());
        let mut modified = c.clone();
        modified.factions[0].range = f64::NAN;
        assert!(Battle::new(&modified, [preset("dawn", 0), preset("fang", 0)], "plain", 42, 0).is_err());
    }

    #[test]
    fn faction_range_is_applied_once_and_grove_keeps_its_extra_cell() {
        let b = Battle::new(catalog(), [preset("dawn", 1), preset("grove", 1)], "plain", 42, 0).unwrap();
        assert_eq!(b.units[3].range, 4);
        assert_eq!(b.units[4].range, 3);
        assert_eq!(b.units[8].range, 5);
        assert_eq!(b.units[9].range, 4);
        let mut modified = catalog().clone();
        modified.factions[0].range = 0.5;
        let shorter = Battle::new(&modified, [preset("dawn", 1), preset("grove", 1)], "plain", 42, 0).unwrap();
        assert_eq!(shorter.units[3].range, 2);
        assert_eq!(shorter.units[0].range, 1);
    }

    #[test]
    fn illegal_attacks_and_actions_leave_the_battle_unchanged() {
        let mut b = battle();
        let before = serde_json::to_value(&b).unwrap();
        for action in [
            Action::new("attack", 0, Some(1)),
            Action::new("attack", 0, Some(6)),
            Action::new("attack", 0, Some(usize::MAX)),
            Action::new("ability", 0, Some(usize::MAX)),
            Action::new("defend", usize::MAX, None),
            Action::new("unknown", 0, None),
        ] {
            // Guard's ability has no target; use the ranged soldier for its invalid target.
            let action = if action.kind == "ability" { Action::new("ability", 4, action.target) } else { action };
            assert!(b.act(0, &action).is_err());
            assert_eq!(serde_json::to_value(&b).unwrap(), before);
        }
        assert!(b.act(usize::MAX, &Action::new("resign", 0, None)).is_err());
        assert_eq!(serde_json::to_value(&b).unwrap(), before);
    }

    #[test]
    fn walls_block_attacks_and_retaliation_happens_once_per_round() {
        let mut b = battle();
        b.units[4].x = 4;
        b.units[4].y = 3;
        b.units[6].x = 6;
        b.units[6].y = 3;
        assert!(!b.can_attack(4, 6));
        b.units[0].x = 4;
        b.units[0].y = 4;
        b.units[6].x = 5;
        b.units[6].y = 4;
        b.units[1].x = 6;
        b.units[1].y = 4;
        b.strike(0, 6, 1., false);
        assert_eq!(b.units[6].attacks, 1);
        assert!(b.units[6].retaliated);
        b.strike(1, 6, 1., false);
        assert_eq!(b.units[6].attacks, 1);
        for u in &mut b.units {
            u.acted = true;
        }
        b.advance();
        assert!(!b.units[6].retaliated);
    }

    #[test]
    fn completed_battles_cannot_accept_actions() {
        let mut b = battle();
        b.act(0, &Action::new("resign", 0, None)).unwrap();
        assert!(b.finished);
        assert_eq!(b.winner, Some(1));
        let before = serde_json::to_value(&b).unwrap();
        assert!(b.act(0, &Action::new("command", 0, None)).is_err());
        assert_eq!(serde_json::to_value(&b).unwrap(), before);
    }
}
