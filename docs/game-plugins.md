# 섬 게임 플러그인

섬마다 게임 세션 하나를 서버가 돌린다. 게임 하나는 **서버 파일 하나**(`server/src/games/<name>.rs`)와 **클라이언트 폴더 하나**(`frontend/src/games/<name>/`), 그리고 양쪽 등록부에 **한 줄씩**이다. 파일이 여럿인 게임은 서버에서 폴더(`server/src/games/<name>/mod.rs`)로 둔다. 지금 섬이 돌리는 게임은 임포스터(`server/src/games/impostor/`, `frontend/src/games/impostor/`)와 카트(`server/src/games/kart/`, `frontend/src/games/kart/`)이고, 아래 예제는 가상의 `relay`다. 둘 다 진행하는 동안 섬 자리를 자기 맵으로 바꾼다(카트는 해안·바다·숲이 있는 경주 섬, 임포스터는 우주선. 섬의 땅 높이에 놓이고 끝나면 섬이 그대로 돌아온다): `frontend/src/games/arenaMap.ts`(땅 높이 `MAP_Y`, 격자 맵·바닥·벽 상자, 게임의 index·layout이 import해도 되는 순수 모듈)와 `arena.tsx`(`ArenaColliders`, `ArenaBlocks`, 시작하면 맵의 제자리(구경하는 사람은 구경 자리)로 데려갔다가 끝나면 원래 자리로 돌려보내는 `useArenaTrip(entry, props)`와 `standFor(session)`; World·Overlay에서만 import한다). 프레임워크는 `server/src/games/mod.rs`와 `frontend/src/games/`의 나머지 파일이다.

## 동작

- 섬의 실시간 방(`/api/rooms/{username}`)에 들어온 회원의 페이지가 게임 소켓 `GET /api/games/{username}?ticket=&peer=`를 따로 연다(티켓은 방과 같은 `POST /api/auth/realtime-ticket`, `peer`는 방이 준 이 페이지의 `client_id`). 방 소켓(gaesup-world 프로토콜)에는 아무것도 더하지 않는다.
- 서버가 판정한다. 게임 상태·시간·점수는 서버의 `Game` 객체에 있고, 클라이언트는 보여 주고 `Act`만 보낸다. 플레이어 위치는 서버가 실시간 방에서 읽는다(클라이언트가 위치를 보내지 않는다).
- `lobby` → `playing` → `ended`. 방장은 `players[0]`이고, 나가면 다음 사람이 방장이 된다. 방장만 시작하고, 닫기는 방장과 섬 주인이 한다. 섬 주인이 남의 세션을 닫으면 그 방장과 연 사람은 3분 동안 새로 열지 못한다(`closed_by_owner`, 사람마다 따로 기억하고 섬이 비어도 남는다). 마지막 사람이 나가거나 10분 동안 아무도 손대지 않으면 세션이 닫힌다(진행 중인 게임은 참가자가 실시간 방에서 움직이는 동안 손댄 것으로 친다. 서 있기만 해서는 열려 있지 않다). 실시간 방을 10초 넘게 떠난 사람은 게임에서 빠진다(`leave`). 게임 코드가 패닉하면 그 세션만 끝나고 모두에게 `Error{code:"game_failed"}`가 간다.
- 실시간 방은 누구든 속도 안에서만 움직이게 한다(섬 30 m/s, 끊겼던 링크가 몰아 보낸 걸음은 15 m까지 한 번에). 걸음은 말한 순서대로 따라가므로 모퉁이를 가로지르지 않고, 같은 자리를 다시 말하면(멈춰 섬) 마지막으로 그대로 받아 준 때부터 그 속도로 갈 수 있었던 만큼까지 바로 받는다. 진행 중인 게임은 매번 `movement`와 `hidden`으로 이 규칙을 플레이어마다 바꾼다(아래). 그 답은 섬 잠금 안에서 방에 넘어가므로, 나중에 계산한 답이 먼저 적용되는 일은 없다.

## 서버

### 등록

`server/src/games/mod.rs`의 등록부에 파일 이름 한 줄을 더한다. 이 매크로가 모듈을 선언하고 `KINDS`에 넣는다.

```rust
registry! {
    impostor,
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
| `movement(player, now)` (선택) | 진행 중 매 호출 뒤에 묻는다. `Some(Movement)`이면 실시간 방이 그 사람을 이 규칙으로 움직인다. `speed`(m/s), `burst`(끊김 뒤 한 번에 따라잡는 거리, 기본 `GAME_BURST` 40 m), `settle`(멈춰 서면 바로 받기, 기본 켬. 지나온 길로 판정하는 게임은 끈다: 카트의 게이트), `hold`(한 자리 근처에 묶기: 카운트다운, 함정), `teleports`(게임이 보내는 순간 이동: `to` 반경 `radius` 안으로, 어디서 오든 소켓마다 한 번. 맵이 섬 자리에 놓이므로 출발한 높이로 가리지 않는다. 캔버스가 새로 놓여 제자리를 잃은 페이지는 속도대로 걸어 돌아간다), `mute`(방 채팅을 아무도 못 듣게). `Movement::default()`에서 시작해 바꾼다. 게임이 끝나거나 그 사람이 빠지면 2분 동안 시작 때 자리(`home`)로 돌아가는 순간 이동만 남는다. |
| `stand()` (선택) | 맵이 섬 자리를 차지하는 게임의 구경 자리 `Stand { at, apart }`. 진행 중 섬에 게임 소켓이 있고 참가하지 않은 사람(진행 중에 나간 참가자도)은 모두 구경하는 사람이 되어, 처음 선 자리(`home`)가 기록되고 그곳으로 한 번 순간 이동(반경 `STAND_REACH` 2.5 m)을 허가받으며, 끝나면 2분 동안 `home`으로 돌아가는 순간 이동을 받는다. `apart`면 구경하는 사람끼리만 서로 보고 참가자에게는 보이지도 들리지도 않는다(임포스터). 카트·임포스터는 layout의 `stand` 점을 쓴다. 기본 `None`: 구경하는 사람은 그대로 둔다. |
| `hidden()` (선택) | 실시간 방이 숨길 사람과, 그래도 그 사람을 보는 사람들. 나머지에게는 섬 아래 같은 한 점(`[0, -500, 0]`)에 서 있다고 알리고 움직임·말을 보내지 않는다("함께 N명"에는 센다). 게임을 나간 사람은 숨기지 않는다. 화면(view)에 숨김 목록을 넣지 않는다. |

모든 메서드는 그 섬의 잠금 안에서 불린다(섬마다 잠금이 따로다). 기다리는 일(DB, 파일, 네트워크, sleep)을 하지 않는다. 거절 메시지는 `GameError::new("code", "…해요.")`로 쓰고, 공용으로 `BAD_LAYOUT`·`BAD_ACTION`이 있다.

### `Ctx`와 도우미

- `ctx.now()`: 서버 시각(ms, 단조 증가, Unix 시각에 가까움). `ctx.players()`: 참가 순서의 `Member { id, name }`(반복 중에도 `emit` 가능). `ctx.is_player(id)`, `ctx.name(id)`.
- `ctx.position(id)` / `ctx.positions()`: 실시간 방에서 그 사람 페이지가 알린 위치 `[x, y, z]`. 아직 자리를 잡지 않았거나 방에 없으면 없다. 이번 호출 시점의 스냅샷이다.
- `ctx.rng()`: 세션마다 시드가 다른 `StdRng`. `Games::new(kinds, Some(seed))`면 재현된다.
- 이벤트: `ctx.emit(event)`(섬의 게임 소켓 모두), `ctx.emit_to(&[ids], event)`, `ctx.emit_one(id, event)`, `ctx.emit_except(&[ids], event)`(그 사람들만 빼고 모두). 클라이언트에는 `{"type":"Event","kind":"<kind>","event":…}`로 가고 같은 변화의 `Session`보다 뒤에 도착한다. 놓쳐도 되는 일회성 알림에만 쓰고, 상태는 `view`에 둔다.
- `distance_xz`, `within(center, point, radius)`(땅 위 거리), `pick`, `pick_many`, `point`, `layout_points(layout, field, min, max)`(모양·개수·좌표: 유한, 각 축 |값| ≤ 200), `distinct(points, gap)`(가까운 점 하나로). 프레임은 16 KiB까지라 점은 200개쯤이 한도다.

### 프로토콜 요약

- 클라이언트 → 서버: `Open{kind}`, `Join`, `Leave`, `Start{layout}`(방장), `Act{action}`, `Close`(방장·섬 주인), `Ping{ts}`, `Pet{pet}`(섬 주인, 아래 "펫 중계").
- 서버 → 클라이언트: `Session{session}`(없으면 `null`. `id`, `kind`, `phase`, `startedAt`(게임이 시작한 서버 시각, 전이면 null), `canClose`(이 사람이 닫을 수 있는지: 방장·섬 주인), `host`, `players[{id,name,peer}]`, `you`, `home`(게임이 시작할 때(구경하는 사람은 구경 자리로 가기 전) 이 사람이 서 있던 방의 자리: 돌아가는 순간 이동이 그 근처로만 허가된다. 데려간 곳이 없으면 null), `stand`(구경하는 사람의 구경 자리, 그 밖에는 null), `game`=`view`, `result`, `seq`, `now`), `Event{kind,event}`, `Error{code,message}`, `Pong{ts}`, `Pet{pet}`.
- 소켓: 섬당 30개(일촌 몫 6개를 빼면 24개, 섬 주인은 따로), 한 섬에 계정당 3개·주소(IPv6는 /64)당 10개, 계정당 4개, 서버 전체에서 주소당 32개·모두 512개. 자리가 없으면 업그레이드를 받은 뒤 바로 4409와 까닭(페이지에 그대로 보일 한국어 문장)으로 닫는다(방 소켓도 같다). 3초에 120개(넘으면 4429), 잘못된 프레임은 초당 10개까지(넘으면 4400), 큐가 차면 4408, 15초마다 세션(4401)·공개 범위(4403) 확인(같은 로그인의 방 소켓과 함께 한 번).

### 펫 중계

게임 소켓은 세션과 따로 섬 펫의 위치도 중계한다. 펫 뇌는 주인 페이지에서 돌고 서버는 프레임을 검사해(`server/src/pets.rs`의 `relay_frame`) 나눠 주기만 한다.

- 주인 페이지 → 서버: `{"type":"Pet","pet":{"id","t","at":[x,y,z],"ry","move","speed","clip","gesture","ball"}}`. 움직일 때 5Hz, 멈춰 있으면 1Hz(초당 10개 이하). `id`는 펫 uuid, `t`는 주인 시계, `at`은 |x|·|z| ≤ 200·y −50..300, `speed` 0..30, `clip`은 `idle`·`walk`·`run`·`sit_hold`·`lie_hold`·`sit`·`lie`, `gesture`는 null 또는 `{clip: bark|jump|sit|lie, at}`(받는 쪽은 `at`이 바뀔 때만 재생), `ball`은 null 또는 `{at, held}`. JSON 512바이트까지이고, 모르는 필드는 버리고 검사한 필드만 보낸다. 3초에 36개를 넘는 프레임은 버린다.
- 섬 주인의 소켓만 보낸다(아니면 `Error{code:"not_owner"}`, 형식이 틀리면 `bad_pet`). 처음 보낸 소켓이 맡고, 그동안 주인의 다른 소켓은 `pet_busy`를 받는다. 맡은 소켓이 10초 동안 아무것도 보내지 않았으면(백그라운드 탭) 다른 소켓이 넘겨받는다.
- 서버 → 나머지 소켓: 같은 `{"type":"Pet","pet":{…}}`. 새로 연결한 소켓은 10초 안에 온 마지막 프레임을 바로 받는다.
- `{"type":"Pet","pet":null}`: 맡은 소켓이 `null`을 보내거나 닫히면 모두에게 간다. 펫은 집 자리에서 쉰다. 받는 쪽은 10초 넘게 프레임이 오지 않아도 쉬는 것으로 다룬다.

## 클라이언트

### 폴더와 등록

```
frontend/src/games/relay/
  index.ts    view·result 타입과 defineGame(...)
  Panel.tsx   진행 중 HUD와 결과
  World.tsx   섬 캔버스(R3F) 안의 표시
  Lobby.tsx   (선택) 방장의 대기실 설정
  Overlay.tsx (선택) 진행 중 페이지 위에 늘 보이는 것
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
  Lobby: RelayLobby,    // 선택
  Overlay: RelayOverlay, // 선택
  Result: RelayResult,
});
```

- `layout(ctx)`: 방장의 시작이 보낼 값. `ctx.building`(불러온 섬의 `BuildingSerializedState`), `ctx.spots()`(`openSpots`: 걸을 수 있고 아무것도 놓이지 않은 바닥 칸 가운데, 북서쪽부터, cm 반올림, 200개까지. 모자라면 섬 범위 격자를 더한다), `ctx.position`(방장 위치), `ctx.session`, `ctx.options`(방장이 `Lobby`에서 정한 값, 없으면 undefined). 던지면 그 메시지가 방장에게 보인다.
- `Lobby`(선택): 대기실에서 방장에게만 보이는 설정(`LobbyProps`: `session`, `options`, `setOptions`). 정한 값은 그 게임의 `layout`이 `options`로 받아 시작에 실어 보낸다(임포스터의 봇 수와 혼자일 때의 역할). 서버는 그 값도 layout처럼 검사한다.
- `Overlay`(선택): 진행 중에 패널을 접어도 페이지 위(`document.body`)에 그려지는 것. 같은 `GameProps`를 받는다(임포스터의 행동 버튼, 작업 미니게임, 사보타주 경보, 정전의 어둠).
- `attention(view)`(선택): 플레이어가 패널에서 답해야 하는 것(임포스터의 회의 투표)이 있으면 그 키를, 없으면 null을 돌려준다. 키가 새로 바뀔 때마다 접힌 패널이 한 번 다시 열린다.
- `canStart(session, options)`(선택): 방장의 시작 버튼이 켜지는 조건(사람과 봇 합계 등). 서버의 `create`가 같은 조건으로 거절하게 맞춘다. 없으면 `minPlayers`만 본다.
- `replacesIsland`(선택): 진행하는 동안 섬 자리를 게임 맵으로 바꾼다. 섬의 건물·타일·충돌체·주민·펫·영역과 섬 패널(이야기 패널, 레일, 아래 막대, 시각)이 물러나고(패널은 접어 둔 상태 그대로 남는다) `World`가 땅 높이에 맵을 그린다. 끝나거나 닫히면 섬이 돌아온다. 섬 주인이 꾸미는 동안에는 바꾸지 않는다. 게임 소켓이 잠깐 끊긴 동안에는 여정 중인 사람의 맵과 게임을 마지막 모습 그대로 둔다(`useGameStage`, `useActiveGame`). 서버 게임은 `stand()`를 준다.
- `controlsPlayer`(선택): 게임이 참가자의 몸을 직접 움직인다(카트). 진행 중 그 사람의 캐릭터와 클릭 이동이 꺼진다. `foldPanelOnStart`(선택): 시작할 때 패널을 열지 않는다(오버레이로 충분한 게임). 끝나면 결과 패널이 열린다.
- 터치 조작: 터치 화면(`(pointer: coarse), (max-width: 720px)`)에는 섬과 구경하는 게임에 걷기 패드(`WalkingControls`, 엔진 입력에 자기 출처로 WASD를 누른다)가 나온다. 걸어 다니는 게임은 Overlay에서 `<WalkingControls placement="game" disabled={…} />`로 자기 패드를 둔다(임포스터: 회의·작업·환풍구 동안 꺼짐). 카트는 `kart/controls.ts`의 버튼(왼손 브레이크·조향, 오른손 가속·드리프트, 아이템)을 쓴다. 손가락마다 따로 누르고, 손을 떼거나 터치가 취소되거나 창·탭이 초점을 잃거나 꺼지면 놓인다.
- `Panel`, `World`, `Result`가 받는 값(`GameProps<View>`): `session`, `view`(=`session.game`, 이 사람의 화면), `me`(참가자면 내 항목), `act(action)`, `onEvent(listener)`(이 게임의 이벤트만, 해제 함수를 돌려준다), `serverNow()`, `teleport(ground)`, `position()`(보는 사람 캐릭터의 지금 위치), `body()`(보는 사람의 물리 몸체: 카트처럼 게임이 직접 움직일 때), `trip()`/`setTrip(trip)`(게임이 데려간 여정: `{key, home, at, to, body}`. 게임 소켓이 끊겼다 붙어도 남는다). `Result`는 `result`도 받는다. 함수들은 게임 동안 같은 것이라 effect 의존성에 넣어도 된다.
- 시간: `useRemaining(view.endsAt, serverNow)`와 `clock(ms)`(`../time`). 서버 시계는 `performance.now` 기준이라 기기 시계를 바꿔도 튀지 않는다. 화면 필드가 이전 서버에 없을 수 있으면(새 필드) 있는지 보고 그린다(임포스터 패널의 남은 시간).
- 아바타 맞추기: `session.players[].peer`가 실시간 방의 `client_id`(gaesup-world `players` 지도의 키)다. 방 밖에 있으면 `null`.
- 순간 이동: `teleport([x, y, z])`. 땅 위 점(예: `spots()`의 점)을 주면 몸을 그 1 m 위에 두고 속도를 없애며, 클릭 이동도 멈춘다. 서버는 사람을 옮길 수 없으므로, 서버가 각자의 화면에 목적지를 넣고 클라이언트가 그것을 보고 이동하며, 서버의 `movement`가 그 순간 이동을 허가한다(허가 밖의 순간 이동은 속도대로 따라간다).
- 자기 맵으로 데려가기: World에서 `useArenaTrip(entry, props)`(`../arena`). `entry`는 참가자면 화면의 시작 자리, 구경하는 사람이면 `standFor(session)`(서버의 `session.stand` 둘레에 사람마다 조금씩 흩은 자리)이다. 시작하면 `entry`로 데려가고 `trip`에 `{key: 세션 id와 시작 시각, home, at, to, body}`를 남긴다. `home`은 서버가 알려 준 `session.home`(없으면 그때 서 있던 자리)이고, 끝나거나 빠지면 그리로 돌려보낸다. 같은 게임에서 `entry`가 바뀌면(진행 중에 나가 구경 자리로) 그리로 옮긴다. 맵 안에서 서 있는 자리를 `at`에 0.25초마다 남기고, 몸이 새로 만들어졌으면(캔버스가 새로 놓여 섬의 출발점에 생긴 몸. 맵이 섬 자리에 있어 높이로는 알 수 없다) 또는 맵 밖으로 20 m 넘게 떨어졌으면 `at`으로 되돌린다. 세션이 그사이 닫혔으면 섬의 `GameWorld`가 돌려보낸다.
- 아바타 숨기기: 서버의 `hidden()`이 실시간 방에서 숨긴다(위). 페이지에서만 가릴 것이 있으면 컴포넌트 안에서 `useHidePeers('relay', peers)`(붙어 있는 동안 숨김), 밖에서는 `hiddenPeers.set('relay', ids)`/`hiddenPeers.clear('relay')`(`../hiddenPeers`). 섬의 `LiveAvatars`가 합친 목록을 빼고 그린다. 임포스터는 방이 직접 숨기기 전의 서버(배포를 되돌린 경우)가 화면에 보내는 `hidden` 목록을 이것으로 가린다. 지금 서버는 그 목록을 한 릴리스 동안 빈 배열로 보낸다.
- 자리가 없어 닫힌 소켓(4409): 게임 소켓은 그 까닭을 `useGameState().error`(`code: 'no_seat'`)로 내고, 방 소켓은 채팅 막대 자리에 보인다. 둘 다 30초 뒤에 다시 연결한다.
- 그 밖에 `useGameState()`, `useActiveGame()`, `useGameRoom()`(`../room`)으로 소켓 상태를 읽을 수 있지만 보통은 props로 충분하다.

## 화면 규칙

- 입력, 상태, 실제 결과, 가능한 작업만 둔다. 규칙 설명·안내·홍보 문구, 준비 중 표시를 넣지 않는다.
- 글래스 토큰(`--mg-*`, `frontend/src/ui/tokens.css`)과 `ui.css`의 `.mg-btn`, `.mg-badge`, `.mg-error` 등, 게임 패널의 `games.css` 클래스(`.mg-game-hud`, `.mg-game-timer`, `.mg-game-scores`, `.mg-game-actions`)를 쓴다. `tokens.css` 밖에 색을 쓰지 않는다. 3D 재질 색은 토큰을 더하고 `getComputedStyle(document.documentElement).getPropertyValue('--mg-…')`로 읽는다(임포스터 `World.tsx`).
- 짧은 이름, '-어요' 말투. 버튼은 `<button>`으로, 키보드로 쓸 수 있고 포커스가 보여야 하며 360px 폭에서 깨지지 않아야 한다.
- 캔버스 안 표시는 `raycast={() => null}`로 클릭 이동을 가리지 않는다.

## 테스트

- 서버(게임 파일 안 `#[cfg(test)]`): `Ctx::new(now, &members, &positions, &mut StdRng::seed_from_u64(…))`로 `create`·`tick`·`act`·`leave`·`result`를 시간과 위치를 직접 넣어 부른다. layout 거절, 판정, 끝, 결과, 비밀이 주인 화면에만 있는지, `ctx.events()`로 이벤트 대상을 확인한다. `movement`·`hidden`의 답도 시간을 넣어 확인한다. `impostor/tests.rs`가 예다(봇이 끝까지 하는 판도 시계를 넣어 돌린다). 실제 소켓 흐름이 필요하면 `server/tests/games_impostor.rs`처럼 방에 들어가 `Update`로 움직인다(방이 받는 속도 안에서 걷는다).
- 클라이언트: `frontend/src/games/__tests__/gameDock.test.tsx`처럼 가짜 client로 `Panel`·`Result`를 그려 확인하고, `layout`을 섬(`createVillage()`)으로 단위 테스트한다. `registry.test.ts`가 등록 전체를 검사한다.
- 검증: `server/`에서 `cargo fmt --check`, `rustfmt --edition 2024 --check $(find src/games -name '*.rs')`(게임 모듈은 `registry!` 안에서 선언되어 `cargo fmt`가 보지 않는다), `cargo clippy --all-targets --locked -- -D warnings`, `cargo test --locked`. 루트에서 `npm run typecheck`, `npm test`, `npm run build`.
