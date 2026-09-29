//! Relationship-based access control, after Google's Zanzibar.
//!
//! Access is a relation between an object and a subject, written `object#relation@subject`:
//! `system:mogaesup#operator@user:<id>`, or `system:mogaesup#operator@group:crew#member` for every member of a group.
//! [`SCHEMA`] names each object type's relations, who a stored tuple may name, and each relation's rewrite: the union
//! of its own tuples, other relations (on the same object or on a fixed one) and facts other tables already hold.
//! Only explicit grants are stored (`auth_tuples`); a home's owner, its visibility and 일촌 are read from `homes` and
//! `ilchons` when a check needs them, so they are never written twice. [`Checker`] follows rewrites and usersets with a
//! depth limit, a lookup budget and memoization, explains a decision as a tree and expands a relation into who holds
//! it; [`grant`] and [`revoke`] change tuples and append every change to `auth_audit`.

use futures_util::future::BoxFuture;
use serde::Serialize;
use sqlx::{PgConnection, PgPool, Row};
use std::{
    collections::{BTreeSet, HashMap},
    fmt,
    sync::Arc,
};
use uuid::Uuid;

/// The id of the one `system` object and of the one `catalog` object.
pub const SITE: &str = "mogaesup";
/// Rewrites and usersets followed below one check; a deeper branch counts as not holding.
const MAX_DEPTH: u32 = 12;
/// Tuple reads one check may make; past it, the branches left count as not holding.
const LOOKUP_BUDGET: u32 = 64;
/// Tuples read per object and relation. Grants are few; this only bounds a runaway table.
const TUPLES_PER_READ: i64 = 500;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    User,
    System,
    Group,
    Home,
    Catalog,
}

impl Kind {
    const ALL: [Kind; 5] = [Kind::User, Kind::System, Kind::Group, Kind::Home, Kind::Catalog];

    pub const fn as_str(self) -> &'static str {
        match self {
            Kind::User => "user",
            Kind::System => "system",
            Kind::Group => "group",
            Kind::Home => "home",
            Kind::Catalog => "catalog",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == text)
    }
}

/// A group id: 2–32 lowercase letters, digits, `_` or `-`, starting with a letter or digit.
pub fn group_id(id: &str) -> bool {
    (2..=32).contains(&id.len())
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// A UUID written the way `Uuid` prints it, as users and homes are stored.
fn canonical_uuid(id: &str) -> bool {
    Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id)
}

/// `kind:id`: a user, the site (`system:mogaesup`), the catalog (`catalog:mogaesup`), a group, or a home (by its
/// owner's id).
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Object {
    pub kind: Kind,
    pub id: String,
}

impl Object {
    pub fn new(kind: Kind, id: impl Into<String>) -> Self {
        Self { kind, id: id.into() }
    }

    pub fn system() -> Self {
        Self::new(Kind::System, SITE)
    }

    pub fn catalog() -> Self {
        Self::new(Kind::Catalog, SITE)
    }

    pub fn group(id: &str) -> Self {
        Self::new(Kind::Group, id)
    }

    pub fn home(owner: Uuid) -> Self {
        Self::new(Kind::Home, owner.to_string())
    }

    pub fn user(id: Uuid) -> Self {
        Self::new(Kind::User, id.to_string())
    }

    /// Whether the id fits the type.
    pub fn well_formed(&self) -> bool {
        match self.kind {
            Kind::System | Kind::Catalog => self.id == SITE,
            Kind::Group => group_id(&self.id),
            Kind::User | Kind::Home => canonical_uuid(&self.id),
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        let (kind, id) = text.split_once(':')?;
        let object = Self::new(Kind::parse(kind)?, id);
        object.well_formed().then_some(object)
    }

    /// The user this object is, for users and homes (whose id is their owner's).
    pub fn uuid(&self) -> Option<Uuid> {
        matches!(self.kind, Kind::User | Kind::Home).then(|| Uuid::parse_str(&self.id).ok()).flatten()
    }
}

impl fmt::Display for Object {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.kind.as_str(), self.id)
    }
}

/// What a stored tuple names: one user (`user:<id>`), or everyone holding a relation on an object, a userset
/// (`group:<id>#member`).
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SubjectRef {
    pub object: Object,
    pub relation: Option<&'static str>,
}

impl SubjectRef {
    pub fn user(id: Uuid) -> Self {
        Self { object: Object::user(id), relation: None }
    }

    pub fn members(group: &str) -> Self {
        Self { object: Object::group(group), relation: Some("member") }
    }

    pub fn parse(text: &str) -> Option<Self> {
        let (object, relation) = match text.split_once('#') {
            Some((object, relation)) => (object, Some(relation)),
            None => (text, None),
        };
        Self::from_parts(Object::parse(object)?, relation)
    }

    fn from_parts(object: Object, relation: Option<&str>) -> Option<Self> {
        let relation = match relation {
            None => None,
            Some(name) => Some(relation_def(object.kind, name)?.name),
        };
        Some(Self { object, relation })
    }

    fn from_row(kind: &str, id: &str, relation: Option<&str>) -> Option<Self> {
        let object = Object::new(Kind::parse(kind)?, id);
        object.well_formed().then_some(())?;
        Self::from_parts(object, relation)
    }
}

impl fmt::Display for SubjectRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.relation {
            Some(relation) => write!(f, "{}#{relation}", self.object),
            None => self.object.fmt(f),
        }
    }
}

/// Who a stored tuple of a relation may name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Allowed {
    User,
    GroupMember,
}

/// A fact another table holds, read when a check reaches it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Fact {
    /// The subject is the home's owner (`homes.owner_id`).
    HomeOwner,
    /// The home is public (`homes.visibility`): everyone, signed in or not.
    PublicHome,
    /// The home is open to 일촌 and the subject is one of the owner's (`ilchons`).
    IlchonOfOwner,
}

/// One part of a relation's rewrite. A relation holds when any of its parts does.
#[derive(Clone, Copy, Debug)]
pub enum Rule {
    /// Its own tuples: the users they name, and the members of each userset they name.
    This,
    /// Another relation on the same object.
    Computed(&'static str),
    /// A relation on the site's own object of a type (`system:mogaesup`, `catalog:mogaesup`).
    Site(Kind, &'static str),
    Fact(Fact),
}

pub struct RelationDef {
    pub name: &'static str,
    /// Who a stored tuple may name; none for a relation computed from the others only.
    pub subjects: &'static [Allowed],
    pub rewrite: &'static [Rule],
}

pub struct TypeDef {
    pub kind: Kind,
    pub relations: &'static [RelationDef],
}

const PEOPLE: &[Allowed] = &[Allowed::User, Allowed::GroupMember];
const COMPUTED: &[Allowed] = &[];

/// The model. `admin` names users only, never a group, so who is an admin is always one table read and the last one
/// can be kept.
pub const SCHEMA: &[TypeDef] = &[
    TypeDef {
        kind: Kind::System,
        relations: &[
            RelationDef { name: "admin", subjects: &[Allowed::User], rewrite: &[Rule::This] },
            // Paid studio work (generation, rigging, retries), within FACTORY_ACCESS and the monthly budget.
            RelationDef { name: "paid_operator", subjects: PEOPLE, rewrite: &[Rule::This, Rule::Computed("admin")] },
            // Changing the studio's records (uploads, selections, outfits).
            RelationDef { name: "operator", subjects: PEOPLE, rewrite: &[Rule::This, Rule::Computed("paid_operator")] },
            // Guestbook and catalog moderation.
            RelationDef { name: "moderator", subjects: PEOPLE, rewrite: &[Rule::This, Rule::Computed("admin")] },
            // Reading the studio beyond the wardrobe: its screens, models, power and usage.
            RelationDef {
                name: "studio_viewer",
                subjects: COMPUTED,
                rewrite: &[Rule::Computed("operator"), Rule::Site(Kind::Catalog, "editor")],
            },
        ],
    },
    TypeDef {
        kind: Kind::Catalog,
        relations: &[RelationDef {
            name: "editor",
            subjects: PEOPLE,
            rewrite: &[Rule::This, Rule::Site(Kind::System, "moderator")],
        }],
    },
    TypeDef {
        kind: Kind::Group,
        relations: &[RelationDef { name: "member", subjects: PEOPLE, rewrite: &[Rule::This] }],
    },
    TypeDef {
        kind: Kind::Home,
        relations: &[
            RelationDef { name: "owner", subjects: COMPUTED, rewrite: &[Rule::Fact(Fact::HomeOwner)] },
            RelationDef { name: "editor", subjects: PEOPLE, rewrite: &[Rule::Computed("owner"), Rule::This] },
            RelationDef {
                name: "viewer",
                subjects: PEOPLE,
                rewrite: &[
                    Rule::Fact(Fact::PublicHome),
                    Rule::Computed("editor"),
                    Rule::This,
                    Rule::Fact(Fact::IlchonOfOwner),
                ],
            },
        ],
    },
];

pub fn relation_def(kind: Kind, name: &str) -> Option<&'static RelationDef> {
    SCHEMA.iter().find(|def| def.kind == kind)?.relations.iter().find(|relation| relation.name == name)
}

/// A permission a route asks for: a relation on the site's own object of a type, and the refusal when it is missing.
#[derive(Clone, Copy, Debug)]
pub struct Permission {
    /// How the app names it (`/api/auth/me`).
    pub name: &'static str,
    pub kind: Kind,
    pub relation: &'static str,
    pub code: &'static str,
    pub message: &'static str,
}

impl Permission {
    pub fn object(&self) -> Object {
        Object::new(self.kind, SITE)
    }
}

const fn site(name: &'static str, code: &'static str, message: &'static str) -> Permission {
    Permission { name, kind: Kind::System, relation: name, code, message }
}

pub const ADMIN: Permission = site("admin", "admin_only", "관리자만 쓸 수 있습니다.");
pub const PAID_OPERATOR: Permission =
    site("paid_operator", "paid_operator_only", "비용이 드는 캐릭터 작업을 시작할 권한이 없습니다.");
pub const OPERATOR: Permission = site("operator", "operator_only", "캐릭터 스튜디오 기록을 바꿀 권한이 없습니다.");
pub const MODERATOR: Permission = site("moderator", "moderator_only", "방명록과 카탈로그를 관리할 권한이 없습니다.");
pub const STUDIO_VIEWER: Permission =
    site("studio_viewer", "studio_viewer_only", "캐릭터 스튜디오를 볼 권한이 없습니다.");
pub const CATALOG_EDITOR: Permission = Permission {
    name: "catalog_editor",
    kind: Kind::Catalog,
    relation: "editor",
    code: "catalog_editor_only",
    message: "카탈로그를 관리할 권한이 없습니다.",
};
/// What `/api/auth/me` tells the app a user may do.
pub const PERMISSIONS: [Permission; 6] = [ADMIN, PAID_OPERATOR, OPERATOR, MODERATOR, CATALOG_EDITOR, STUDIO_VIEWER];

/// SQL for a `users u` row: `'admin'` when the account holds `system:mogaesup#admin`, else `'user'`. Admin takes users
/// only, so the stored tuple is the whole answer and sessions need no extra round trip.
pub const ROLE_COLUMN: &str = "CASE WHEN EXISTS (SELECT 1 FROM auth_tuples t WHERE t.object_type = 'system'
    AND t.object_id = 'mogaesup' AND t.relation = 'admin' AND t.subject_type = 'user' AND t.subject_id = u.id::text)
    THEN 'admin' ELSE 'user' END AS role";

/// Who a check is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Subject {
    Anonymous,
    User(Uuid),
}

impl fmt::Display for Subject {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Subject::Anonymous => f.write_str("anonymous"),
            Subject::User(id) => write!(f, "user:{id}"),
        }
    }
}

/// `object#relation@subject`, checked against [`SCHEMA`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tuple {
    pub object: Object,
    pub relation: &'static str,
    pub subject: SubjectRef,
}

/// Why a tuple cannot be stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Invalid {
    Object,
    /// Not a relation of the object's type, or one computed from others only.
    Relation,
    Subject,
    /// A subject the relation does not take (a group as admin).
    NotAllowed,
    /// A group as its own members.
    SelfMember,
}

impl Tuple {
    pub fn new(object: Object, relation: &str, subject: SubjectRef) -> Result<Self, Invalid> {
        if object.kind == Kind::User || !object.well_formed() {
            return Err(Invalid::Object);
        }
        let def =
            relation_def(object.kind, relation).filter(|def| !def.subjects.is_empty()).ok_or(Invalid::Relation)?;
        let allowed = match (subject.object.kind, subject.relation) {
            (Kind::User, None) => Allowed::User,
            (Kind::Group, Some("member")) => Allowed::GroupMember,
            _ => return Err(Invalid::Subject),
        };
        if !subject.object.well_formed() {
            return Err(Invalid::Subject);
        }
        if !def.subjects.contains(&allowed) {
            return Err(Invalid::NotAllowed);
        }
        if subject.object == object && subject.relation == Some(def.name) {
            return Err(Invalid::SelfMember);
        }
        Ok(Self { object, relation: def.name, subject })
    }

    pub fn admin(user: Uuid) -> Self {
        Self { object: Object::system(), relation: "admin", subject: SubjectRef::user(user) }
    }

    fn is_admin(&self) -> bool {
        self.object == Object::system() && self.relation == "admin"
    }
}

impl fmt::Display for Tuple {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}#{}@{}", self.object, self.relation, self.subject)
    }
}

/// How a check decided, node by node: a relation (children: its rewrite in order, up to the first part that held),
/// `direct` (its own tuples; children: the usersets they name), `userset` (child: the subject's membership of that
/// set), `fact`, or `limit` (a branch cut short by depth, a cycle or the lookup budget; it counts as not holding).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trace {
    pub kind: &'static str,
    pub object: String,
    pub relation: &'static str,
    pub allowed: bool,
    /// The user a direct tuple names, or the set a userset tuple names.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fact: Option<Fact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<&'static str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Trace>,
}

impl Trace {
    fn node(kind: &'static str, object: &Object, relation: &'static str, allowed: bool, children: Vec<Trace>) -> Self {
        Self { kind, object: object.to_string(), relation, allowed, subject: None, fact: None, limit: None, children }
    }
}

/// Who holds a relation: the relation (children: its rewrite), `user` (named by a tuple, or a home's owner),
/// `userset` (a set named by a tuple; child: that set), `fact` (users the rule stands for without listing them:
/// everyone for a public home, the owner's 일촌), or `limit`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Expansion {
    pub kind: &'static str,
    pub object: String,
    pub relation: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fact: Option<Fact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<&'static str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Expansion>,
}

impl Expansion {
    fn node(kind: &'static str, object: &Object, relation: &'static str) -> Self {
        Self {
            kind,
            object: object.to_string(),
            relation,
            subject: None,
            fact: None,
            limit: None,
            children: Vec::new(),
        }
    }

    /// Every user listed anywhere below.
    pub fn users(&self) -> BTreeSet<Uuid> {
        let mut found = BTreeSet::new();
        self.collect(&mut found);
        found
    }

    fn collect(&self, found: &mut BTreeSet<Uuid>) {
        if self.kind == "user"
            && let Some(id) = self.subject.as_deref().and_then(|s| s.strip_prefix("user:"))
            && let Ok(id) = Uuid::parse_str(id)
        {
            found.insert(id);
        }
        for child in &self.children {
            child.collect(found);
        }
    }
}

/// One stored tuple as a check reads it.
struct Stored {
    relation: String,
    subject: SubjectRef,
}

struct Eval {
    allowed: bool,
    /// False when a cut branch may have hidden a path: such a denial is not remembered.
    settled: bool,
    trace: Option<Trace>,
}

type Found = Arc<[Stored]>;

/// Answers checks for one request. Decisions, tuple reads and home facts are remembered for the checker's life, so
/// build one per request (or per group of checks) and let it go.
pub struct Checker<'a> {
    db: &'a PgPool,
    memo: HashMap<(Subject, Object, &'static str), bool>,
    /// Per subject and object: the tuples naming that user directly, and every userset.
    tuples: HashMap<(Subject, Object), Found>,
    visibility: HashMap<String, Option<String>>,
    ilchons: HashMap<(Uuid, String), bool>,
    path: Vec<(Object, &'static str)>,
    lookups: u32,
}

fn cut(object: &Object, relation: &'static str, limit: &'static str) -> Trace {
    Trace { limit: Some(limit), ..Trace::node("limit", object, relation, false, Vec::new()) }
}

impl<'a> Checker<'a> {
    pub fn new(db: &'a PgPool) -> Self {
        Self {
            db,
            memo: HashMap::new(),
            tuples: HashMap::new(),
            visibility: HashMap::new(),
            ilchons: HashMap::new(),
            path: Vec::new(),
            lookups: 0,
        }
    }

    /// A home's visibility the caller has just read, so checks on that home need not read it again.
    pub fn know_home(&mut self, owner: Uuid, visibility: &str) {
        self.visibility.insert(owner.to_string(), Some(visibility.to_owned()));
    }

    pub async fn check(&mut self, subject: Subject, object: &Object, relation: &str) -> sqlx::Result<bool> {
        let Some(def) = relation_def(object.kind, relation) else { return Ok(false) };
        self.start();
        Ok(self.eval(subject, object.clone(), def.name, 0, false).await?.allowed)
    }

    pub async fn allows(&mut self, subject: Subject, permission: &Permission) -> sqlx::Result<bool> {
        self.check(subject, &permission.object(), permission.relation).await
    }

    /// The same decision as [`Checker::check`] with how it was reached; None for a relation the type does not have.
    pub async fn explain(&mut self, subject: Subject, object: &Object, relation: &str) -> sqlx::Result<Option<Trace>> {
        let Some(def) = relation_def(object.kind, relation) else { return Ok(None) };
        self.start();
        Ok(self.eval(subject, object.clone(), def.name, 0, true).await?.trace)
    }

    /// Who holds `relation` on `object`, as a tree; None for a relation the type does not have.
    pub async fn expand(&mut self, object: &Object, relation: &str) -> sqlx::Result<Option<Expansion>> {
        let Some(def) = relation_def(object.kind, relation) else { return Ok(None) };
        self.start();
        self.expand_node(object.clone(), def.name, 0).await.map(Some)
    }

    fn start(&mut self) {
        self.path.clear();
        self.lookups = 0;
    }

    /// Counts one table read; false once the budget is spent.
    fn spend(&mut self) -> bool {
        self.lookups += 1;
        self.lookups <= LOOKUP_BUDGET
    }

    /// Why a branch at `depth` must stop here, if it must.
    fn limit(&self, object: &Object, relation: &'static str, depth: u32) -> Option<&'static str> {
        if depth > MAX_DEPTH {
            Some("depth")
        } else if self.path.iter().any(|(seen, name)| seen == object && *name == relation) {
            Some("cycle")
        } else if self.lookups > LOOKUP_BUDGET {
            Some("budget")
        } else {
            None
        }
    }

    fn eval<'s>(
        &'s mut self,
        subject: Subject,
        object: Object,
        relation: &'static str,
        depth: u32,
        explain: bool,
    ) -> BoxFuture<'s, sqlx::Result<Eval>> {
        Box::pin(async move {
            let key = (subject, object.clone(), relation);
            if !explain && let Some(&allowed) = self.memo.get(&key) {
                return Ok(Eval { allowed, settled: true, trace: None });
            }
            if let Some(limit) = self.limit(&object, relation, depth) {
                // Group cycles are allowed and end here; running out of depth or budget means the model needs a look.
                if limit != "cycle" {
                    tracing::warn!(%subject, %object, relation, limit, "Permission check cut short");
                }
                return Ok(Eval {
                    allowed: false,
                    settled: false,
                    trace: explain.then(|| cut(&object, relation, limit)),
                });
            }
            let Some(def) = relation_def(object.kind, relation) else {
                return Ok(Eval {
                    allowed: false,
                    settled: true,
                    trace: explain.then(|| Trace::node("relation", &object, relation, false, Vec::new())),
                });
            };
            self.path.push((object.clone(), relation));
            let mut settled = true;
            let mut allowed = false;
            let mut children = Vec::new();
            for rule in def.rewrite {
                let part = match *rule {
                    Rule::This => self.direct(subject, &object, relation, depth, explain).await,
                    Rule::Computed(other) => self.eval(subject, object.clone(), other, depth + 1, explain).await,
                    Rule::Site(kind, other) => {
                        self.eval(subject, Object::new(kind, SITE), other, depth + 1, explain).await
                    }
                    Rule::Fact(fact) => self.fact(subject, &object, relation, fact, explain).await,
                };
                let part = match part {
                    Ok(part) => part,
                    Err(error) => {
                        self.path.pop();
                        return Err(error);
                    }
                };
                settled &= part.settled;
                children.extend(part.trace);
                if part.allowed {
                    allowed = true;
                    break;
                }
            }
            self.path.pop();
            if allowed || settled {
                self.memo.insert(key, allowed);
            }
            Ok(Eval {
                allowed,
                settled: allowed || settled,
                trace: explain.then(|| Trace::node("relation", &object, relation, allowed, children)),
            })
        })
    }

    /// The relation's own tuples: one naming the user, or a userset the user belongs to.
    async fn direct(
        &mut self,
        subject: Subject,
        object: &Object,
        relation: &'static str,
        depth: u32,
        explain: bool,
    ) -> sqlx::Result<Eval> {
        let node = |allowed, children| Trace::node("direct", object, relation, allowed, children);
        // No tuple names a signed-out visitor, nor a set one belongs to.
        let Subject::User(user) = subject else {
            return Ok(Eval { allowed: false, settled: true, trace: explain.then(|| node(false, Vec::new())) });
        };
        let Some(found) = self.stored(subject, object).await? else {
            return Ok(Eval {
                allowed: false,
                settled: false,
                trace: explain.then(|| cut(object, relation, "budget")),
            });
        };
        let me = SubjectRef::user(user);
        if found.iter().any(|tuple| tuple.relation == relation && tuple.subject == me) {
            let trace = explain.then(|| Trace { subject: Some(me.to_string()), ..node(true, Vec::new()) });
            return Ok(Eval { allowed: true, settled: true, trace });
        }
        let mut settled = true;
        let mut children = Vec::new();
        for tuple in found.iter().filter(|tuple| tuple.relation == relation) {
            let Some(member) = tuple.subject.relation else { continue };
            let part = self.eval(subject, tuple.subject.object.clone(), member, depth + 1, explain).await?;
            settled &= part.settled;
            if explain {
                children.push(Trace {
                    subject: Some(tuple.subject.to_string()),
                    ..Trace::node("userset", object, relation, part.allowed, part.trace.into_iter().collect())
                });
            }
            if part.allowed {
                return Ok(Eval { allowed: true, settled: true, trace: explain.then(|| node(true, children)) });
            }
        }
        Ok(Eval { allowed: false, settled, trace: explain.then(|| node(false, children)) })
    }

    /// The tuples on `object` that can matter for `subject`: those naming it, and every userset. None past the budget.
    async fn stored(&mut self, subject: Subject, object: &Object) -> sqlx::Result<Option<Found>> {
        let key = (subject, object.clone());
        if let Some(found) = self.tuples.get(&key) {
            return Ok(Some(found.clone()));
        }
        if !self.spend() {
            return Ok(None);
        }
        let user = match subject {
            Subject::User(id) => Some(id.to_string()),
            Subject::Anonymous => None,
        };
        let rows = sqlx::query(
            "SELECT relation, subject_type, subject_id, subject_relation FROM auth_tuples
             WHERE object_type = $1 AND object_id = $2
               AND (subject_relation IS NOT NULL OR (subject_type = 'user' AND subject_id = $3))
             ORDER BY relation, subject_type, subject_id LIMIT $4",
        )
        .bind(object.kind.as_str())
        .bind(&object.id)
        .bind(user)
        .bind(TUPLES_PER_READ)
        .fetch_all(self.db)
        .await?;
        let found: Found = rows
            .iter()
            .filter_map(|row| {
                let subject = SubjectRef::from_row(
                    row.get("subject_type"),
                    row.get("subject_id"),
                    row.get::<Option<&str>, _>("subject_relation"),
                )?;
                Some(Stored { relation: row.get("relation"), subject })
            })
            .collect();
        self.tuples.insert(key, found.clone());
        Ok(Some(found))
    }

    async fn fact(
        &mut self,
        subject: Subject,
        object: &Object,
        relation: &'static str,
        fact: Fact,
        explain: bool,
    ) -> sqlx::Result<Eval> {
        let allowed = match (fact, subject) {
            (Fact::HomeOwner, Subject::User(id)) => id.to_string() == object.id && self.home(object).await?.is_some(),
            (Fact::PublicHome, _) => self.home(object).await?.as_deref() == Some("public"),
            (Fact::IlchonOfOwner, Subject::User(id)) => {
                self.home(object).await?.as_deref() == Some("ilchon") && self.ilchon(id, object).await?
            }
            (Fact::HomeOwner | Fact::IlchonOfOwner, Subject::Anonymous) => false,
        };
        let trace =
            explain.then(|| Trace { fact: Some(fact), ..Trace::node("fact", object, relation, allowed, Vec::new()) });
        Ok(Eval { allowed, settled: true, trace })
    }

    /// A home's visibility, None when there is no such home.
    async fn home(&mut self, object: &Object) -> sqlx::Result<Option<String>> {
        if let Some(known) = self.visibility.get(&object.id) {
            return Ok(known.clone());
        }
        let found = match object.uuid().filter(|_| object.kind == Kind::Home) {
            Some(owner) => {
                sqlx::query_scalar("SELECT visibility FROM homes WHERE owner_id = $1")
                    .bind(owner)
                    .fetch_optional(self.db)
                    .await?
            }
            None => None,
        };
        self.visibility.insert(object.id.clone(), found.clone());
        Ok(found)
    }

    async fn ilchon(&mut self, user: Uuid, home: &Object) -> sqlx::Result<bool> {
        let key = (user, home.id.clone());
        if let Some(&known) = self.ilchons.get(&key) {
            return Ok(known);
        }
        let Some(owner) = home.uuid() else { return Ok(false) };
        let found: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM ilchons WHERE user_id = $1 AND friend_id = $2)")
                .bind(user)
                .bind(owner)
                .fetch_one(self.db)
                .await?;
        self.ilchons.insert(key, found);
        Ok(found)
    }

    fn expand_node<'s>(
        &'s mut self,
        object: Object,
        relation: &'static str,
        depth: u32,
    ) -> BoxFuture<'s, sqlx::Result<Expansion>> {
        Box::pin(async move {
            let mut node = Expansion::node("relation", &object, relation);
            if let Some(limit) = self.limit(&object, relation, depth) {
                return Ok(Expansion { limit: Some(limit), ..Expansion::node("limit", &object, relation) });
            }
            let Some(def) = relation_def(object.kind, relation) else { return Ok(node) };
            self.path.push((object.clone(), relation));
            let result = self.expand_rules(&object, def, depth).await;
            self.path.pop();
            node.children = result?;
            Ok(node)
        })
    }

    async fn expand_rules(
        &mut self,
        object: &Object,
        def: &'static RelationDef,
        depth: u32,
    ) -> sqlx::Result<Vec<Expansion>> {
        let mut children = Vec::new();
        for rule in def.rewrite {
            match *rule {
                Rule::This => {
                    if !self.spend() {
                        children
                            .push(Expansion { limit: Some("budget"), ..Expansion::node("limit", object, def.name) });
                        continue;
                    }
                    let rows = sqlx::query(
                        "SELECT subject_type, subject_id, subject_relation FROM auth_tuples
                         WHERE object_type = $1 AND object_id = $2 AND relation = $3
                         ORDER BY subject_type, subject_id LIMIT $4",
                    )
                    .bind(object.kind.as_str())
                    .bind(&object.id)
                    .bind(def.name)
                    .bind(TUPLES_PER_READ)
                    .fetch_all(self.db)
                    .await?;
                    for row in &rows {
                        let Some(subject) = SubjectRef::from_row(
                            row.get("subject_type"),
                            row.get("subject_id"),
                            row.get::<Option<&str>, _>("subject_relation"),
                        ) else {
                            continue;
                        };
                        let mut leaf = Expansion {
                            subject: Some(subject.to_string()),
                            ..Expansion::node("user", object, def.name)
                        };
                        if let Some(member) = subject.relation {
                            leaf.kind = "userset";
                            leaf.children.push(self.expand_node(subject.object.clone(), member, depth + 1).await?);
                        }
                        children.push(leaf);
                    }
                }
                Rule::Computed(other) => children.push(self.expand_node(object.clone(), other, depth + 1).await?),
                Rule::Site(kind, other) => {
                    children.push(self.expand_node(Object::new(kind, SITE), other, depth + 1).await?)
                }
                Rule::Fact(fact) => {
                    let visibility = self.home(object).await?;
                    let leaf = match (fact, visibility.as_deref()) {
                        (Fact::HomeOwner, Some(_)) => Some(Expansion {
                            subject: Some(format!("user:{}", object.id)),
                            ..Expansion::node("user", object, def.name)
                        }),
                        (Fact::PublicHome, Some("public")) | (Fact::IlchonOfOwner, Some("ilchon")) => {
                            Some(Expansion { fact: Some(fact), ..Expansion::node("fact", object, def.name) })
                        }
                        _ => None,
                    };
                    children.extend(leaf);
                }
            }
        }
        Ok(children)
    }
}

/// Who changes a tuple: an account, or the server itself (`bootstrap`).
#[derive(Clone, Copy, Debug)]
pub struct Actor<'a> {
    pub id: Option<Uuid>,
    pub name: &'a str,
}

impl<'a> Actor<'a> {
    pub fn server(name: &'a str) -> Self {
        Self { id: None, name }
    }
}

async fn audit(db: &mut PgConnection, action: &str, tuple: &Tuple, actor: Actor<'_>, reason: &str) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO auth_audit (action, object_type, object_id, relation, subject_type, subject_id, subject_relation,
         actor_id, actor, reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(action)
    .bind(tuple.object.kind.as_str())
    .bind(&tuple.object.id)
    .bind(tuple.relation)
    .bind(tuple.subject.object.kind.as_str())
    .bind(&tuple.subject.object.id)
    .bind(tuple.subject.relation)
    .bind(actor.id)
    .bind(actor.name)
    .bind(reason)
    .execute(db)
    .await?;
    Ok(())
}

/// Stores `tuple` and audits it; false when it was already there (nothing is written then).
pub async fn grant(db: &PgPool, tuple: &Tuple, actor: Actor<'_>, reason: &str) -> sqlx::Result<bool> {
    let mut tx = db.begin().await?;
    let inserted = sqlx::query(
        "INSERT INTO auth_tuples (object_type, object_id, relation, subject_type, subject_id, subject_relation, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT ON CONSTRAINT auth_tuples_key DO NOTHING",
    )
    .bind(tuple.object.kind.as_str())
    .bind(&tuple.object.id)
    .bind(tuple.relation)
    .bind(tuple.subject.object.kind.as_str())
    .bind(&tuple.subject.object.id)
    .bind(tuple.subject.relation)
    .bind(actor.id)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;
    if inserted {
        audit(&mut tx, "grant", tuple, actor, reason).await?;
    }
    tx.commit().await?;
    Ok(inserted)
}

#[derive(Debug)]
pub enum RevokeError {
    /// The tuple is the only admin left.
    LastAdmin,
    Database(sqlx::Error),
}

impl From<sqlx::Error> for RevokeError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// Removes `tuple` and audits it; false when it was not there. The last admin is never removed.
pub async fn revoke(db: &PgPool, tuple: &Tuple, actor: Actor<'_>, reason: &str) -> Result<bool, RevokeError> {
    let mut tx = db.begin().await?;
    if tuple.is_admin() {
        // Every admin row is locked, so two revocations at once cannot both see another admin left.
        let admins: Vec<String> = sqlx::query_scalar(
            "SELECT subject_id FROM auth_tuples WHERE object_type = 'system' AND object_id = $1 AND relation = 'admin'
             ORDER BY subject_id FOR UPDATE",
        )
        .bind(SITE)
        .fetch_all(&mut *tx)
        .await?;
        if admins.len() <= 1 && admins.contains(&tuple.subject.object.id) {
            return Err(RevokeError::LastAdmin);
        }
    }
    let deleted = sqlx::query(
        "DELETE FROM auth_tuples WHERE object_type = $1 AND object_id = $2 AND relation = $3 AND subject_type = $4
         AND subject_id = $5 AND subject_relation IS NOT DISTINCT FROM $6",
    )
    .bind(tuple.object.kind.as_str())
    .bind(&tuple.object.id)
    .bind(tuple.relation)
    .bind(tuple.subject.object.kind.as_str())
    .bind(&tuple.subject.object.id)
    .bind(tuple.subject.relation)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;
    if deleted {
        audit(&mut tx, "revoke", tuple, actor, reason).await?;
    }
    tx.commit().await?;
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every rewrite names a relation that exists, `Site` points at a type with a site object, and following
    /// `Computed`/`Site` edges never comes back to where it started (usersets may cycle; rewrites may not).
    #[test]
    fn the_schema_is_closed_and_acyclic() {
        fn visit(kind: Kind, name: &'static str, path: &mut Vec<(Kind, &'static str)>) {
            assert!(!path.contains(&(kind, name)), "rewrite cycle through {kind:?}#{name}: {path:?}");
            let def = relation_def(kind, name).unwrap_or_else(|| panic!("{kind:?}#{name} is not in the schema"));
            path.push((kind, name));
            for rule in def.rewrite {
                match *rule {
                    Rule::Computed(other) => visit(kind, other, path),
                    Rule::Site(target, other) => {
                        assert!(Object::new(target, SITE).well_formed(), "{target:?} has no site object");
                        visit(target, other, path)
                    }
                    Rule::This => assert!(!def.subjects.is_empty(), "{kind:?}#{name} reads tuples it cannot store"),
                    Rule::Fact(_) => assert_eq!(kind, Kind::Home, "facts are about homes"),
                }
            }
            path.pop();
        }
        for def in SCHEMA {
            for relation in def.relations {
                visit(def.kind, relation.name, &mut Vec::new());
            }
        }
        for permission in PERMISSIONS {
            assert!(relation_def(permission.kind, permission.relation).is_some(), "{}", permission.name);
            assert!(permission.object().well_formed());
        }
        assert_eq!(relation_def(Kind::System, "admin").unwrap().subjects, &[Allowed::User]);
    }

    #[test]
    fn objects_and_subjects_parse_only_in_their_own_shape() {
        let id = Uuid::new_v4();
        assert_eq!(Object::parse("system:mogaesup"), Some(Object::system()));
        assert_eq!(Object::parse(&format!("home:{id}")), Some(Object::home(id)));
        assert_eq!(Object::parse("system:other"), None);
        assert_eq!(Object::parse("group:Crew"), None);
        assert_eq!(Object::parse(&format!("home:{}", id.to_string().to_uppercase())), None);
        assert_eq!(Object::parse("planet:x"), None);
        assert_eq!(SubjectRef::parse("group:crew#member"), Some(SubjectRef::members("crew")));
        assert_eq!(SubjectRef::parse(&format!("user:{id}")), Some(SubjectRef::user(id)));
        assert_eq!(SubjectRef::parse("group:crew#owner"), None);
        assert_eq!(SubjectRef::members("crew").to_string(), "group:crew#member");
    }

    #[test]
    fn tuples_take_only_the_subjects_their_relation_allows() {
        let user = SubjectRef::user(Uuid::new_v4());
        let crew = SubjectRef::members("crew");
        assert!(Tuple::new(Object::system(), "operator", crew.clone()).is_ok());
        assert_eq!(Tuple::new(Object::system(), "admin", crew.clone()), Err(Invalid::NotAllowed));
        assert_eq!(Tuple::new(Object::system(), "studio_viewer", user.clone()), Err(Invalid::Relation));
        assert_eq!(Tuple::new(Object::system(), "owner", user.clone()), Err(Invalid::Relation));
        assert_eq!(Tuple::new(Object::group("crew"), "member", crew.clone()), Err(Invalid::SelfMember));
        assert!(Tuple::new(Object::group("staff"), "member", crew).is_ok());
        assert_eq!(Tuple::new(Object::user(Uuid::new_v4()), "member", user.clone()), Err(Invalid::Object));
        let group_as_user = SubjectRef { object: Object::group("crew"), relation: None };
        assert_eq!(Tuple::new(Object::system(), "operator", group_as_user), Err(Invalid::Subject));
        let tuple = Tuple::admin(Uuid::nil());
        assert_eq!(tuple.to_string(), format!("system:mogaesup#admin@user:{}", Uuid::nil()));
    }
}
