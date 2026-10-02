pub mod battle;

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

pub const BUDGET: u32 = 600;
pub const MAX_UNITS: usize = 6;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Faction {
    pub id: String,
    pub name: String,
    pub subtitle: String,
    pub description: String,
    pub color: String,
    pub accent: String,
    pub trait_name: String,
    pub trait_text: String,
    pub power: f64,
    pub health: f64,
    pub damage: f64,
    pub armor: f64,
    pub speed: f64,
    pub range: f64,
    pub names: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub id: String,
    pub name: String,
    pub cost: u32,
    pub health: f64,
    pub damage: f64,
    pub armor: f64,
    pub speed: f64,
    pub range: f64,
    pub description: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Catalog {
    pub version: String,
    pub factions: Vec<Faction>,
    pub roles: Vec<Role>,
}

pub fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| serde_json::from_str(include_str!("catalog.json")).expect("valid war catalog"))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Army {
    pub faction: String,
    pub units: Vec<String>,
    pub formation: String,
}

impl Catalog {
    pub fn faction(&self, id: &str) -> Option<&Faction> {
        self.factions.iter().find(|f| f.id == id)
    }

    pub fn role(&self, id: &str) -> Option<&Role> {
        self.roles.iter().find(|r| r.id == id)
    }

    pub fn validate(&self, army: &Army, owned: Option<&[String]>) -> Result<(), &'static str> {
        let faction = self.faction(&army.faction).ok_or("알 수 없는 진영입니다.")?;
        if ![faction.power, faction.health, faction.damage, faction.speed, faction.range]
            .into_iter()
            .all(|value| value.is_finite() && value > 0.)
            || !faction.armor.is_finite()
            || faction.armor < 0.
        {
            return Err("진영 능력치가 올바르지 않습니다.");
        }
        if !["line", "wedge", "spread"].contains(&army.formation.as_str()) {
            return Err("진형을 선택해 주세요.");
        }
        if army.units.len() < 3 || army.units.len() > MAX_UNITS {
            return Err("피규어 3~6기로 부대를 편성해 주세요.");
        }
        let mut cost = 0u32;
        for id in &army.units {
            let role = self.role(id).ok_or("알 수 없는 피규어입니다.")?;
            if ![
                role.health * faction.health,
                role.damage * faction.damage * faction.power,
                role.speed * faction.speed,
                role.range * faction.range,
            ]
            .into_iter()
            .all(|value| value.is_finite() && value > 0.)
                || !role.armor.is_finite()
                || role.armor < 0.
                || !(role.armor * faction.armor).is_finite()
            {
                return Err("피규어 능력치가 올바르지 않습니다.");
            }
            if army.units.iter().filter(|r| *r == id).count() > 2 {
                return Err("같은 피규어는 최대 2기까지 편성할 수 있습니다.");
            }
            if owned.is_some_and(|list| !list.contains(&format!("{}:{}", army.faction, id))) {
                return Err("먼저 피규어를 수집해 주세요.");
            }
            cost = cost.checked_add(role.cost).ok_or("편성 비용은 600 이하로 맞춰 주세요.")?;
        }
        if cost > BUDGET {
            return Err("편성 비용은 600 이하로 맞춰 주세요.");
        }
        if army.units.iter().filter(|r| r.starts_with("special")).count() > 1 {
            return Err("특수군단은 한 부대에 1기만 편성할 수 있습니다.");
        }
        Ok(())
    }
}

pub fn starter_collection() -> Vec<String> {
    catalog().factions.iter().flat_map(|f| ["guard", "soldier", "ranger"].map(|r| format!("{}:{r}", f.id))).collect()
}

pub fn preset(faction: &str, index: usize) -> Army {
    let units: &[&str] = match index % 4 {
        0 => &["guard", "guard", "soldier", "soldier", "ranger", "ranger"],
        1 => &["champion", "guard", "soldier", "ranger", "mystic"],
        2 => &["special_a", "guard", "guard", "soldier", "ranger"],
        _ => &["special_b", "guard", "guard", "soldier", "ranger"],
    };
    Army {
        faction: faction.into(),
        units: units.iter().map(|r| (*r).into()).collect(),
        formation: ["line", "wedge", "spread"][index % 3].into(),
    }
}

pub fn tier(role: &str) -> u32 {
    match role {
        "guard" | "soldier" | "ranger" => 1,
        "special_a" | "special_b" => 3,
        _ => 2,
    }
}

pub fn command_name(faction: &str) -> &'static str {
    match faction {
        "dawn" => "집결의 서약",
        "grove" => "순풍",
        "iron" => "철벽",
        "fang" => "전쟁 함성",
        "veil" => "잔혼 수확",
        "ember" => "화염 폭풍",
        "tide" => "밀려오는 조수",
        _ => "과충전",
    }
}
