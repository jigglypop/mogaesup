# 섬 게임 플러그인

섬마다 게임 세션 하나를 서버가 돌린다. 게임 하나는 **서버 파일 하나**(`server/src/games/<name>.rs`)와 **클라이언트 폴더 하나**(`frontend/src/games/<name>/`), 그리고 양쪽 등록부에 **한 줄씩**이다. 참고 구현은 보물찾기(`server/src/games/treasure.rs`, `frontend/src/games/treasure/`)다. 프레임워크는 `server/src/games/mod.rs`와 `frontend/src/games/`의 나머지 파일이다.

## 동작

- 섬의 실시간 방(`/api/rooms/{username}`)에 들어온 회원의 페이지가 게임 소켓 `GET /api/games/{username}?ticket=&peer=`를 따로 연다(티켓은 방과 같은 `POST /api/auth/realtime-ticket`, `peer`는 방이 준 이 페이지의 `client_id`). 방 소켓(gaesup-world 프로토콜)에는 아무것도 더하지 않는다.
- 서버가 판정한다. 게임 상태·시간·점수는 서버의 `Game` 객체에 있고, 클라이언트는 보여 주고 `Act`만 보낸다. 플레이어 위치는 서버가 실시간 방에서 읽는다(클라이언트가 위치를 보내지 않는다).
- `lobby` → `playing` → `ended`. 방장은 `players[0]`이고, 나가면 다음 사람이 방장이 된다. 방장만 시작·닫기를 한다. 마지막 사람이 나가거나 10분 동안 아무도 손대지 않으면 세션이 닫힌다. 실시간 방을 10초 넘게 떠난 사람은 게임에서 빠진다(`leave`).

## 서버

### 등록

`server/src/games/mod.rs`의 등록부에 파일 이름 한 줄을 더한다. 이 매크로가 모듈을 선언하고 `KINDS`에 넣는다.

```rust
registry! {
    treasure,
    relay,
}
```

게임 파일의 등록 항목은 `Kind::new(kind, min_players, max_players, create)`이다. `kind`는 1–32바이트, `1 ≤ min ≤ max ≤ 30`이고 컴파일할 때 검사된다. 진행 중 틱은 기본 10Hz(`DEFAULT_TICK_HZ`)이고 `.ticking(hz)`로 1–30Hz(`MAX_TICK_HZ`)를 고른다. 대기실·끝난 세션은 1초마다 사람만 확인한다. 테스트 `every_registered_game_has_its_own_kind_and_limits_the_server_keeps`가 등록 전체(중복 kind, 범위)를 검사한다.

### 최소 예제

```rust
use std::collections::HashMap;

use serde_json::{Value, json};
use uuid::Uuid;

use super::{BAD_ACTION, BAD_LAYOUT, Ctx, Game, GameError, Kind, Millis, distinct, layout_points, pick_many, within};

pub(crate) const KIND: Kind = Kind::new("relay", 2, 8, create).ticking(20);

struct Relay {
    flags: Vec<[f64; 3]>,
    /// Each player's own order of flags, and how many they have touched.
    routes: HashMap<Uuid, (Vec<usize>, usize)>,
    ends_at: Millis,
    winner: Option<Uuid>,
    over: bool,
}

fn create(layout: &Value, ctx: &mut Ctx) -> Result<Box<dyn Game>, GameError> {
    // The host's page computed this: check shape, count and coordinates before using it.
    let flags = distinct(layout_points(layout, "flags", 3, 8)?, 2.0);
    if flags.len() < 3 {
        return Err(BAD_LAYOUT);
    }
    let order: Vec<usize> = (0..flags.len()).collect();
    let mut routes = HashMap::new();
    for player in ctx.players() {
        routes.insert(player.id, (pick_many(ctx.rng(), &order, 3), 0));
    }
    ctx.emit(json!({"type": "go"}));
    Ok(Box::new(Relay { flags, routes, ends_at: ctx.now() + 90_000, winner: None, over: false }))
}

impl Game for Relay {
    fn view(&self, viewer: Option<Uuid>, _now: Millis) -> Value {
        // Everyone sees the flags and the progress; only you see your next flag.
        let next = viewer.and_then(|id| self.routes.get(&id)).and_then(|(route, done)| route.get(*done));
        json!({
            "flags": self.flags,
            "done": self.routes.iter().map(|(id, (_, done))| (id.to_string(), *done)).collect::<HashMap<_, _>>(),
            "next": next.map(|flag| self.flags[*flag]),
            "endsAt": self.ends_at,
        })
    }

    fn act(&mut self, player: Uuid, action: &Value, ctx: &mut Ctx) -> Result<(), GameError> {
        if action["type"] != "wave" {
            return Err(BAD_ACTION);
        }
        ctx.emit(json!({"type": "wave", "player": player}));
        Ok(())
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        if self.over || ctx.now() >= self.ends_at {
            self.over = true;
            return;
        }
        for player in ctx.players() {
            let (Some(at), Some((route, done))) = (ctx.position(player.id), self.routes.get_mut(&player.id)) else {
                continue;
            };
            if route.get(*done).is_some_and(|flag| within(self.flags[*flag], at, 1.2)) {
                *done += 1;
                ctx.emit_one(player.id, json!({"type": "touched", "done": *done}));
                if *done == route.len() {
                    self.winner = Some(player.id);
                    self.over = true;
                    return;
                }
            }
        }
    }

    fn leave(&mut self, player: Uuid, _ctx: &mut Ctx) {
        self.routes.remove(&player);
    }

    fn result(&self) -> Option<Value> {
        self.over.then(|| json!({"winner": self.winner}))
    }
}
```

### `Game` 계약

| 메서드 | 할 일 |
| --- | --- |
| `create(layout, ctx)` (`Kind`에 등록) | 방장의 `layout`을 검사하고 게임을 만든다. `Err`면 방장에게 `Error`가 가고 대기실이 그대로다. |
| `view(viewer, now)` | 보는 사람별 화면. `Some(id)`는 참가자, `None`은 구경하는 사람. 비밀(역할, 내 다음 목표)은 그 주인의 화면에만 넣는다. 사람마다 직렬화한 화면을 비교해 바뀐 사람에게만 보내므로, 남은 시간 대신 절대 시각(`endsAt`, 서버 ms)을 넣는다. |
| `act(player, action, ctx)` | 참가자의 행동. `Err(GameError)`는 그 사람에게만 가고, 거절한 행동은 아무것도 바꾸지 않는다(그때 낸 이벤트도 버려진다). |
| `watch(viewer, action, ctx)` (선택) | 구경하는 사람의 `Act`(놓친 것을 달라는 요청 등). 기본은 거절(`not_player`)이다. |
| `tick(ctx)` | 진행 중 `tick_hz`마다. 경과 시간은 `ctx.now()`의 차이로 잰다. |
| `leave(player, ctx)` | 직접 나갔거나 방을 10초 넘게 떠난 사람. 이어 가거나 끝낸다. |
| `result()` | `Some`이 되는 순간 `ended`가 되고 모두에게 보인다. |

모든 메서드는 서버의 잠금 안에서 불린다. 기다리는 일(DB, 파일, 네트워크, sleep)을 하지 않는다. 거절 메시지는 `GameError::new("code", "…해요.")`로 쓰고, 공용으로 `BAD_LAYOUT`·`BAD_ACTION`이 있다.

### `Ctx`와 도우미

- `ctx.now()`: 서버 시각(ms, 단조 증가, Unix 시각에 가까움). `ctx.players()`: 참가 순서의 `Member { id, name }`(반복 중에도 `emit` 가능). `ctx.is_player(id)`, `ctx.name(id)`.
- `ctx.position(id)` / `ctx.positions()`: 실시간 방에서 그 사람 페이지가 알린 위치 `[x, y, z]`. 아직 자리를 잡지 않았거나 방에 없으면 없다. 이번 호출 시점의 스냅샷이다.
- `ctx.rng()`: 세션마다 시드가 다른 `StdRng`. `Games::new(kinds, Some(seed))`면 재현된다.
- 이벤트: `ctx.emit(event)`(섬의 게임 소켓 모두), `ctx.emit_to(&[ids], event)`, `ctx.emit_one(id, event)`, `ctx.emit_except(&[ids], event)`(그 사람들만 빼고 모두). 클라이언트에는 `{"type":"Event","kind":"<kind>","event":…}`로 가고 같은 변화의 `Session`보다 뒤에 도착한다. 놓쳐도 되는 일회성 알림에만 쓰고, 상태는 `view`에 둔다.
- `distance_xz`, `within(center, point, radius)`(땅 위 거리), `pick`, `pick_many`, `point`, `layout_points(layout, field, min, max)`(모양·개수·좌표: 유한, 각 축 |값| ≤ 200), `distinct(points, gap)`(가까운 점 하나로). 프레임은 16 KiB까지라 점은 200개쯤이 한도다.

### 프로토콜 요약

- 클라이언트 → 서버: `Open{kind}`, `Join`, `Leave`, `Start{layout}`(방장), `Act{action}`, `Close`(방장), `Ping{ts}`.
- 서버 → 클라이언트: `Session{session}`(없으면 `null`. `kind`, `phase`, `host`, `players[{id,name,peer}]`, `you`, `game`=`view`, `result`, `seq`, `now`), `Event{kind,event}`, `Error{code,message}`, `Pong{ts}`.
- 소켓: 섬당 30개, 계정당 4개, 초당 40개(넘으면 4429), 잘못된 프레임은 초당 10개까지(넘으면 4400), 큐가 차면 4408, 15초마다 세션(4401)·공개 범위(4403) 확인.

## 클라이언트

### 폴더와 등록

```
frontend/src/games/relay/
  index.ts    view·result 타입과 defineGame(...)
  Panel.tsx   진행 중 HUD와 결과
  World.tsx   섬 캔버스(R3F) 안의 표시
```

`frontend/src/games/registry.ts`에 import 한 줄과 `GAMES` 목록 한 줄을 더한다. 목록 순서가 게임 패널의 순서다.

```ts
export const relay = defineGame<RelayView, RelayOutcome>({
  kind: 'relay',        // 서버 Kind와 같게
  label: '릴레이',
  minPlayers: 2,        // 서버와 같게: 방장의 시작이 이 수를 기다린다
  maxPlayers: 8,
  layout: ({ spots }) => ({ flags: spots().filter((_, index) => index % 12 === 0).slice(0, 8) }),
  Panel: RelayPanel,
  World: RelayWorld,    // 선택
  Result: RelayResult,
});
```

- `layout(ctx)`: 방장의 시작이 보낼 값. `ctx.building`(불러온 섬의 `BuildingSerializedState`), `ctx.spots()`(`openSpots`: 걸을 수 있고 아무것도 놓이지 않은 바닥 칸 가운데, 북서쪽부터, cm 반올림, 200개까지. 모자라면 섬 범위 격자를 더한다), `ctx.position`(방장 위치), `ctx.session`. 던지면 그 메시지가 방장에게 보인다.
- `Panel`, `World`, `Result`가 받는 값(`GameProps<View>`): `session`, `view`(=`session.game`, 이 사람의 화면), `me`(참가자면 내 항목), `act(action)`, `onEvent(listener)`(이 게임의 이벤트만, 해제 함수를 돌려준다), `serverNow()`, `teleport(ground)`. `Result`는 `result`도 받는다. 함수들은 게임 동안 같은 것이라 effect 의존성에 넣어도 된다.
- 시간: `useRemaining(view.endsAt, serverNow)`와 `clock(ms)`(`../time`).
- 아바타 맞추기: `session.players[].peer`가 실시간 방의 `client_id`(gaesup-world `players` 지도의 키)다. 방 밖에 있으면 `null`.
- 순간 이동: `teleport([x, y, z])`. 땅 위 점(예: `spots()`의 점)을 주면 몸을 그 1 m 위에 두고 속도를 없애며, 클릭 이동도 멈춘다. 서버는 사람을 옮길 수 없으므로, 서버가 각자의 화면에 목적지를 넣고 클라이언트가 그것을 보고 이동하며, 서버는 그 뒤의 위치로 확인한다.
- 아바타 숨기기: 컴포넌트 안에서 `useHidePeers('relay', peers)`(붙어 있는 동안 숨김), 밖에서는 `hiddenPeers.set('relay', ids)`/`hiddenPeers.clear('relay')`(`../hiddenPeers`). 섬의 `LiveAvatars`가 합친 목록을 빼고 그린다.
- 그 밖에 `useGameState()`, `useActiveGame()`, `useGameRoom()`(`../room`)으로 소켓 상태를 읽을 수 있지만 보통은 props로 충분하다.

## 화면 규칙

- 입력, 상태, 실제 결과, 가능한 작업만 둔다. 규칙 설명·안내·홍보 문구, 준비 중 표시를 넣지 않는다.
- 글래스 토큰(`--mg-*`, `frontend/src/ui/tokens.css`)과 `ui.css`의 `.mg-btn`, `.mg-badge`, `.mg-error` 등, 게임 패널의 `games.css` 클래스(`.mg-game-hud`, `.mg-game-timer`, `.mg-game-scores`, `.mg-game-actions`)를 쓴다. `tokens.css` 밖에 색을 쓰지 않는다. 3D 재질 색은 토큰을 더하고 `getComputedStyle(document.documentElement).getPropertyValue('--mg-…')`로 읽는다(보물찾기 `World.tsx`).
- 짧은 이름, '-어요' 말투. 버튼은 `<button>`으로, 키보드로 쓸 수 있고 포커스가 보여야 하며 360px 폭에서 깨지지 않아야 한다.
- 캔버스 안 표시는 `raycast={() => null}`로 클릭 이동을 가리지 않는다.

## 테스트

- 서버(게임 파일 안 `#[cfg(test)]`): `Ctx::new(now, &members, &positions, &mut StdRng::seed_from_u64(…))`로 `create`·`tick`·`act`·`leave`·`result`를 시간과 위치를 직접 넣어 부른다. layout 거절, 판정, 끝, 결과, 비밀이 주인 화면에만 있는지, `ctx.events()`로 이벤트 대상을 확인한다. `treasure.rs`의 테스트가 예다. 실제 소켓 흐름이 필요하면 `server/tests/games.rs`처럼 방에 들어가 `Update`로 움직인다.
- 클라이언트: `frontend/src/games/__tests__/gameDock.test.tsx`처럼 가짜 client로 `Panel`·`Result`를 그려 확인하고, `layout`을 섬(`createVillage()`)으로 단위 테스트한다. `registry.test.ts`가 등록 전체를 검사한다.
- 검증: `server/`에서 `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, `cargo test --locked`. 루트에서 `npm run typecheck`, `npm test`, `npm run build`.
