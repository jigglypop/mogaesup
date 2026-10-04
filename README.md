# 모개숲

[gaesup-world](https://github.com/jigglypop/gaesup-world)의 예제 섬 "모개숲"을 서비스로 만든 통합 레포입니다. 운영 주소: https://mogaesup.com

## 구조

| 폴더 | 역할 |
| --- | --- |
| `frontend/` | 프론트엔드 하나. React 19 + Vite 8, 3D 섬은 npm의 `gaesup-world`로 그린다. 글래스 디자인(`--mg-*` 토큰)으로 로그인·가입, 섬(`/@아이디`)과 꾸미기(`/@아이디/edit`), 둘러보기, 운영(`/admin`), 내 캐릭터 옷장(`/character`), 캐릭터 공장(`/admin/studio`, 화면은 `src/character/`) |
| `server/` | 웹서버. Rust(axum + sqlx) + PostgreSQL. 회원과 세션 쿠키, 섬 프로필·섬 저장(리비전)·방문자, 방명록·이웃(API 이름은 ilchon), 미니미 카탈로그와 캐릭터 가져오기, 캐릭터 스튜디오 API 중계(권한·유료 한도·기록), 실시간 방(WebSocket, gaesup-world 멀티플레이 프로토콜) |
| `backend/` | 캐릭터 서버. Python(FastAPI) + Blender. 캐릭터 몸·파츠·의상·기물의 이미지·3D 생성, 리깅, 조립, 검수. AWS 스튜디오 배포는 `backend/infra/`. 자세한 것은 [backend/README.md](backend/README.md) |
| `scripts/` | 루트 기동(`dev.ps1`)과 섬 기물 생성(`props/`) |

엔진인 gaesup-world는 이 레포에 넣지 않고 npm 패키지로 받는다. 엔진을 고치면 gaesup-world 레포의 `main`에 올리고, CI가 새 버전을 npm에 낸 뒤 `frontend/`에서 버전을 올린다.

의존성은 루트에서 한 번에 받는다. `npm install`이 npm 워크스페이스(`frontend`)의 `node_modules`를, `uv sync`가 uv 워크스페이스(멤버 `backend`)의 `.venv`를 만든다.

## 로컬 실행

1. 설치: 루트에서 `npm install`과 `uv sync`. 필요한 도구는 Node 22.12 이상(`.nvmrc`), Rust 1.95 이상(cargo), uv, Docker(compose)다.
2. 기동: `npm run dev`(= `scripts/dev.ps1`). Docker PostgreSQL(127.0.0.1:55432)과 Rust 서버(`127.0.0.1:8080`), 웹(`http://127.0.0.1:5180`, `/api`와 WebSocket을 8080으로 넘긴다)을 숨은 프로세스로 띄우고 로그는 `.data/dev/`에 둔다. 이미 떠 있는 포트는 그대로 쓴다. `npm run dev:stop`이 이 스크립트가 띄운 것을 끈다(기록한 프로세스 이름과 시작 시각이 맞는 것만). `npm run dev`·`dev:character`·`dev:stop`은 Windows PowerShell 스크립트라 Windows에서만 돈다. 다른 OS에서는 `server/scripts/start-rust-server.ps1`이 하는 대로 PostgreSQL·환경 변수·`cargo build`를 맞추고 `npm run dev -w frontend`를 따로 띄운다.
3. 캐릭터 파이프라인까지: `npm run dev:character`. 캐릭터 서버를 루트 `.venv`로 `127.0.0.1:8016`에 띄우고(멈춘 유료 단계 자동 재개는 끈다), `backend/.env`(`backend/.env.example`에서 만든다)의 API 키와 JWT 설정을 Rust 서버의 스튜디오 게이트웨이에 넘겨 `/admin` 가져오기와 `/admin/studio`·`/character`가 끝까지 돈다. 관리자는 기록을 바꿀 수 있고(`FACTORY_ACCESS=write`), 비용이 드는 작업은 `scripts/dev.ps1 -Character -Paid`(월 `-PaidMonthly`건)일 때만 열린다. `.env`는 운영 키이니 필요할 때만 쓴다.
4. 관리자: 서버를 `BOOTSTRAP_ADMIN_USERNAME`·`BOOTSTRAP_ADMIN_PASSWORD`와 함께 띄우면 그 계정을 만들거나(있으면 비밀번호는 그대로) 관리자 권한을 준다. 그 밖의 역할은 `/admin/permissions`에서 준다. 설정 목록은 `server/.env.example`에 있다.
5. 섬 기물 다시 만들기(유료): `uv run python scripts/props/generate.py --only <id>`로 하나씩 확인한 뒤 `--all`, 그다음 `node frontend/scripts/props-normalize.mjs`가 크기·방향·무광 재질을 섬에 맞춰 `frontend/public/gltf/`에 넣는다(패키지의 같은 경로 모델을 대신한다).

## 캐릭터 스튜디오

운영 스튜디오 사진은 자르기·최대 2048px 처리본 확인 뒤 업로드한다. 회원 옷장은 헤어·앞머리·뒷머리·모자·안경·상의·하의·신발의 크기(축마다 60~150%)와 위치(상하 ±15cm·앞뒤 ±10cm·좌우 ±5cm)를 조정해 실제 착용 GLB로 저장하며, 운영 조립본은 버전·SHA에 묶인 외형·동작 검수를 기록한다. 섬 꾸미기의 **매장 배치**는 설명으로 타일·벽·기물을 미리 보고 한 번에 적용·되돌린다. [구현과 검증](docs/implementation-2026-10-03.md)

캐릭터 스튜디오 화면(`frontend/src/character/`)은 둘로 나뉜다. `/character`(`frontend/src/studio/CharacterPage.tsx`)는 회원 누구나 쓰는 옷장이고, `/admin/studio`(`frontend/src/studio/StudioPage.tsx`, 운영 탭 '캐릭터 공장')는 스튜디오 운영 권한이 있어야 열리며, 만들기 화면(기본몸·파츠·바닥 타일 등 생성을 시작하는 화면)은 모두 유료 작업 권한이 있을 때만 보여서 그 권한이 없는 운영자는 에셋 라이브러리와 프롬프트만 본다. 옛 `/studio` 주소는 이 둘로 넘긴다. 스튜디오 스타일시트는 한 페이지짜리로 쓰였으므로 `.studio-root` 안으로 가둔다(`frontend/vite/studio.ts`). 화면이 부르는 `/api/avatar-factory`·`/api/studio`·`/api/avatar-blueprints`·`/api/characters`는 서버가 받아 권한을 본 뒤 캐릭터 서버로 넘긴다. 회원은 옷장 읽기(`wardrobe/*`, 파츠 GLB)만, 그 밖의 읽기는 스튜디오 보기(운영·카탈로그 편집), 기록 변경은 스튜디오 운영, 비용이 드는 작업은 유료 작업 권한이 있어야 한다(아래 권한). `FACTORY_ACCESS`가 `read`(기본)면 읽기만, `write`면 기록 변경까지, `paid`면 비용이 드는 작업까지 열고, 유료는 `FACTORY_PAID_MONTHLY` 한도 안에서만 통과한다. 알려진 업로드·선택과 이미지만 자르는 `part-batches/split-sheet` 외의 POST는 유료로 본다. 바꾸는 요청은 `factory_requests`에 남고, 월 한도는 동시에 들어온 요청도 넘지 않게 센다. 관리자용 `/api/factory/*`도 같은 `FACTORY_ACCESS`·월 한도·기록을 따른다(읽기는 스튜디오 보기, 바꾸기는 관리자). 요청 경로는 한 번 디코드한 조각마다 검사해서 `.`·`..`·빈 조각·디코드 뒤에도 남은 `%`·`/`·`\`가 있으면 404로 거절하고, 권한 판단과 캐릭터 서버로 보내는 주소에 같은 조각을 쓴다(`%2e%2e`로 옷장 허용 경로를 벗어날 수 없다). 캐릭터 서버와는 연결 10초·응답 대기 600초로 통신하고, JSON 응답은 8 MiB까지 읽는다. 파일 리다이렉트는 `FACTORY_URL`과 같은 출처 또는 표준 HTTPS AWS S3 호스트만 따른다. S3 산출물은 인증된 앱 API가 작은 청크로 전달하며 Range·HEAD·ETag를 보존한다.

## 캐릭터 가져오기

`/admin`은 캐릭터 서버의 완성 캐릭터를 스튜디오와 같은 기준으로 보여 준다: 봉인된 `character_parts` 조립본, 캐릭터(`character_id`)마다 가장 최근 작업, 삭제·보관한 것 제외. 카탈로그 항목은 캐릭터로 짝지어서, 같은 캐릭터를 새 작업으로 다시 만들면 새 항목이 아니라 그 항목의 새 버전이 된다. 작업·조립본·고른 표정·단계 중 하나라도 바뀌면 "새 버전 있음"과 그 이유가 뜬다.

가져오기는 백그라운드 작업이다. `POST /api/catalog/admin/import`가 바로 202와 가져오기 id를 돌려주고(동시에 2개), 서버가 작업 확인 → 모델 받기 → 검사 → 텍스처 줄이기(색상 1024px, 그 밖 512px, 불투명 맵은 JPEG) → 저장 → 대표 그림 → 카탈로그 반영을 차례로 하며 단계와 진행률을 `catalog_imports`에 남긴다. 검사는 끝까지 모아 보고서(스킨·관절, 빠진 클립과 모든 애니메이션, 삼각형·정점 수, 텍스처와 파일 크기 전후, 높이, 대표 그림)로 남기고, GLB가 아니거나 SHA-256이 다르거나 미니미에 스킨·`idle`·`walk`가 없을 때만 실패한다. 서버가 다시 뜨면 끝나지 않은 가져오기는 중단으로 표시된다.

모델은 `MODEL_STORE`에 해시 이름으로 저장하고 지우지 않는다(운영은 웹 버킷의 `models/`, CloudFront `/models/*` 1년 불변 캐시). 항목마다 버전(`catalog_versions`)이 쌓이고 관리 화면에서 되돌릴 수 있다. 다시 가져와도 공개 상태·이름·이모지·순서는 그대로다. 처음 가져온 항목은 초안이고, 공개하면 미니미 목록에 나온다. 섬 주인은 공개된 미니미나 기본 미니미만 고를 수 있다.

가져올 때 종류를 고른다: 미니미(사람이 걷는 캐릭터, 스킨·`idle`·`walk` 필요)나 주민(`npc`, 섬에 서 있는 캐릭터, 스킨·`idle`만 필요). gaesup-world 패키지의 figure 가운데 기본 미니미 `man` 하나만 남긴다(빌드와 개발 서버도 그것만 낸다). 없어진 figure를 골랐던 섬은 기본 미니미로 옮겨지고, 화면도 카탈로그에 없는 미니미는 기본으로 그린다.

## 주민과 내 캐릭터

- 주민: 섬 주인이 꾸미기의 `주민` 탭에서 공개된 주민을 골라 이름과 인사말을 주고 보는 곳 가운데에 둔다(섬마다 12명). 섬 저장 봉투의 `residents` 영역으로 함께 저장되고, 서버가 모양과 카탈로그의 주민인지 확인한다(`server/src/residents.rs`). 섬은 gaesup-world의 NPC 시스템으로 그리며(idle, 이름표, 화면 밖·먼 주민 생략), 가까이 온 사람을 바라보고, 상호작용(E 키·버튼)하면 인사말을 보여 준다. 방문자도 같은 저장을 읽으니 같은 주민을 본다.
- 내 캐릭터: 옷장에서 `내 캐릭터로 입기`를 누르면 `PUT /api/looks/me`가 몸·파츠·색을 캐릭터 서버의 옷장 목록과 SHA-256까지 대조한 뒤 뒤에서 하나의 GLB로 조립한다(`server/src/look_bake.rs`: 파츠를 몸의 뼈에 이름으로 묶고, 가려지는 몸 삼각형과 재질을 빼고, 안쪽 옷을 밀착시키고, 머리·옷 색을 새 텍스처로 굽는다). 검사·텍스처 줄이기를 거쳐 가져온 모델처럼 `MODEL_STORE`에 저장되고, 섬의 내 캐릭터와 실시간 방의 `Join.modelUrl`이 그 모델이 된다. 회원은 자기 것(`/api/looks/me`)만 읽고 쓴다. 섬의 미니미를 고르면 내 모습을 벗고, 소개 탭의 `내 모습`으로 다시 입는다. 굽는 동안 미니미를 골랐으면 다 구워져도 입지 않는다(`wear_on_ready`).
  - 가림 영역을 읽지 못한 옷(`look_coverage`)이나 색 정보를 읽지 못한 색 선택(`look_colors`)은 조용히 넘기지 않고 실패한다(몸이 옷을 뚫은 모델을 `ready`로 저장하지 않는다). 그 밖에 건너뛴 항목은 결과 보고서의 `skippedHides`·`skippedTucks`·`unreadableMaps`로 센다. 결과가 16 MiB나 삼각형 15만을 넘으면 `look_too_large`이다.
  - 굽는 중인 모습이 이미 16개면 새 저장은 429 `looks_busy`이다. 수락은 DB에서 원자적으로 예약하고, 실제 파일 다운로드와 조립은 두 작업만 동시에 진행한다. 한 작업의 파일·마스크·가림 정보 합계는 64 MiB까지이다. 이미 밀린 굽기는 시작 전에 자기 차례인지(수정 번호) 다시 확인한다. 서버가 다시 시작되면 굽던 모습은 `interrupted`로 바로 실패 처리한다. 같은 DB에 두 서버가 기동해 서로의 작업을 중단하지 않도록 프로세스 잠금을 잡는다. 만든 모델은 해시 이름으로 `MODEL_STORE`에 남고 지우지 않는다. 오래된 모델을 줄이려면 버킷의 `models/` 수명주기 규칙으로 정한다.


## 실시간 방과 섬 저장

- 방: 일회용 티켓으로 들어오고(60초), 방문자가 보내는 `modelUrl`은 `APP_ORIGIN`과 같은 출처의 `/gltf/*.glb`나 `/models/<sha>.glb`만, 색은 `#` 16진 값만 받는다. 한 계정은 소켓을 4개까지 열 수 있고(넘으면 핸드셰이크 429), 섬의 공개 범위·일촌·직접 권한·그룹 구성 변경으로 접근을 잃으면 close 코드 4403으로 내보낸다. 회전은 정규화해서 전달한다. 연결은 로그인 세션에 바인딩하며 로그아웃·세션 정리 시 닫고, 만료된 세션과 읽기 권한은 15초마다 다시 확인한다.
- 섬 저장: `PUT /api/homes/me/world`는 10분에 120번까지이고 리비전과 `expectedOwnerId`가 맞을 때만 받는다. 프로필 저장도 `expectedOwnerId`를 요구한다. 계정이 바뀌면 이전 계정의 예약·재시도 요청을 취소한다. 한 계정은 섬 월드 행을 8개까지 두며, 새 월드를 처음 저장해 8개를 넘으면 가장 오래 손대지 않은 월드부터 지운다(예: `minihome-v<N>`의 옛 버전).
- 둘러보기: `GET /api/homes?limit=&before=&q=`는 공개 섬을 새 순서로 돌려주고, `q`(40자까지)는 아이디·이름·제목에 들어 있는 글자를 대소문자 구분 없이 찾는다.
- 로그인 세션: 세션과 쿠키는 30일이다. 앱을 열 때 묻는 `GET /api/auth/me`가 만료까지 29일이 안 남은 세션을 다시 30일로 늘리고 쿠키를 새 Max-Age로 보낸다(세션 행은 하루에 한 번쯤 쓴다). 오래 열어 둔 화면도 12시간마다 보일 때 다시 묻는다. 한 계정은 기기 20개까지 로그인해 두고, 새 로그인이 넘치면 가장 오래 쓰지 않은 세션부터 끝내며 그 세션의 실시간 방 연결도 닫는다. 다른 기기의 로그인·로그아웃은 쓰던 기기를 끝내지 않는다.
- 공유: 섬 위쪽 막대의 링크 복사가 `<사이트>/api/share/@아이디`를 복사한다(터치 기기는 공유 창). 이 주소는 링크 미리보기(카카오톡 등)가 읽는 서버의 작은 HTML로, 섬 이름·주인 이름과 상태 메시지·공유 사진을 Open Graph 태그로 알리고 자기 주소를 `og:url`로 둔다(카카오톡은 `og:url`의 태그를 다시 읽는다). 브라우저는 페이지 CSP가 해시로 허용한 한 줄 스크립트로 섬(`/@아이디`)에 넘어가고, 크롤러가 따라가는 meta refresh는 쓰지 않는다. 익명 방문자가 볼 수 없는 섬(이웃 공개·비공개)과 없는 섬은 사이트 이름과 기본 그림(`frontend/public/share.jpg`)만 알린다. 공유 사진은 섬 주인이 소개 탭에서 사진을 고르거나 붙여 넣거나 지금 보이는 섬 화면을 담아 정한다. 브라우저가 가운데를 1200×630 JPEG(600KB 이하)로 잘라 `PUT /api/homes/me/thumbnail`(`expectedOwnerId` 필요, 10분에 20번)로 보내면 서버가 1 MiB·4096px 이하만 읽어 다시 1200×630 JPEG로 만들고 `MODEL_STORE`(`/models/<sha>.jpg`)에 둔다. `DELETE`는 기본 그림으로 되돌린다.

## 권한

서버의 권한은 관계 기반(ReBAC, Zanzibar 방식)이다(`server/src/rebac.rs`). `객체#관계@주체` 튜플을 `auth_tuples`에 두고, 주체는 사용자(`user:<id>`)나 그룹 구성원(`group:<이름>#member`, 그룹 안의 그룹도 된다)이다. 섬 주인·공개 범위·일촌처럼 이미 다른 테이블에 있는 것은 튜플로 옮기지 않고 판단할 때 그 테이블을 읽는다.

| 객체 | 관계 | 포함 |
| --- | --- | --- |
| `system:mogaesup` | `admin`(사용자만), `paid_operator`(유료 스튜디오 작업), `operator`(스튜디오 기록 변경), `moderator`(방명록·카탈로그 관리), `studio_viewer`(계산만) | admin ⊂ paid_operator ⊂ operator ⊂ studio_viewer, admin ⊂ moderator |
| `catalog:mogaesup` | `editor`(가져오기·공개·되돌리기) | moderator ⊂ editor ⊂ studio_viewer |
| `group:<이름>` | `member` | |
| `home:<주인 id>` | `owner`(`homes.owner_id`), `editor`, `viewer` | owner ⊂ editor ⊂ viewer, 공개 섬은 모두, 일촌 공개 섬은 주인의 일촌 |

`FACTORY_ACCESS`와 월 유료 한도는 권한과 따로 서버 전체의 상한으로 남는다. 관리자는 `/admin/permissions`에서 사람을 찾아 역할과 그룹을 바꾸고(사유를 적어야 하며 `auth_audit`에 남는다), 판단 근거와 역할별 보유자, 변경 기록을 본다. 마지막 관리자는 해제되지 않는다. 이 방식 이전의 관리자(`users.role = 'admin'`)는 마이그레이션으로 관리자 튜플에 연결되고, `users.role`은 이전 바이너리로 되돌릴 때를 위해 관리자 튜플을 따라간다. 기존 이름만으로 bootstrap 관리자에 승격하지 않고 비밀번호로 소유권을 확인한다. 예약된 관리자 이름은 일반 가입으로 선점할 수 없다. 옛 `ydh2244` 이름 기반 승격 마이그레이션이 아직 적용되지 않은 DB에는 기동 전에 소유권 확인을 요구한다.

## 로컬 API 검수 MCP

`uv sync --locked --extra studio-mcp` 후 `uv run --no-sync asset-studio-mcp`로 stdio 서버를 실행한다. 프로세스 환경의 `MOGA_STUDIO_API_URL`에는 Rust API origin을, `MOGA_STUDIO_SESSION`에는 기존 로그인 세션 자격 증명을 전달한다. Rust의 `APP_ORIGIN`과 API origin이 다르면 `MOGA_STUDIO_APP_ORIGIN`도 설정한다. 기본은 조회이며 `MOGA_STUDIO_MCP_WRITE=1`에서만 검사·캐릭터 검수·버전/SHA에 묶인 네이티브 조립 검수 기록이 가능하다. `MOGA_STUDIO_MCP_PAID=1`까지 설정해야 회원 옷장 의상을 만드는 유료 tool이 목록에 생긴다. 스튜디오 단일 파츠 화면과 같은 요청을 게이트웨이(유료 작업 권한·`FACTORY_ACCESS=paid`·월 한도)로 보내고 호출마다 idempotency key를 받는다. 로컬 큐(`.data/studio-mcp/`)는 한 번에 3건까지 새로 접수하고 첫 거절에서 멈추며 응답이 불확실한 의상은 다시 보내지 않는다. 터미널에서는 `uv run --no-sync asset-studio-mcp garments --max-new 3 --until-empty --max-paid 9`가 같은 큐를 돌린다. 서버의 회원 권한과 소유권 검사를 유지하며 비밀값·임의 URL·코드·파일 경로를 tool 인수로 받지 않는다. 전체 설정과 등록 tool은 [API MCP 명세](docs/studio-api-mcp-spec.md#현재-구현과-실행-설정)에, 의상 tool·큐·종료 코드는 [옷장 의상 생성](docs/studio-api-mcp-spec.md#옷장-의상-생성-유료)에 있다.

## 검증

- 서버: `cd server && docker compose up -d --wait && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`. 테스트는 실제 PostgreSQL에 임시 DB를 만들어 돌고, 운영자 토큰이 캐릭터 서버의 `auth.py`(`backend/src`)를 통과하는지도 확인한다(`uv`가 있을 때).
- 캐릭터 서버: `uv run python -m compileall -q backend/src`. 테스트(`uv run pytest`)는 외부 API·Blender·DB를 대체한 것만 돈다.
- 웹: `npm run typecheck && npm test && npm run build`(루트). 서버와 `npm run dev`가 떠 있으면 `npm run smoke`가 Chrome(이 PC의 GPU, WebGPU)으로 가입부터 꾸미기 저장·방문·실시간 방·방명록·이웃까지 확인한다. 주소를 주면 그곳을 확인한다(빌드본은 `npm run preview -w frontend`의 `http://127.0.0.1:4173`).
- 캐릭터: `npm run test:character`(루트)가 `server/`를 빌드해 임시 DB와 가짜 캐릭터 서버(`frontend/scripts/e2e/`)로 띄우고 웹 개발 서버와 함께 빈 포트에서 Chrome(WebGPU)으로 확인한다: 관리자가 완성 캐릭터를 가져와 검사·공개하고 스튜디오 화면을 열며, 새 회원이 그 미니미로 섬을 걷고 옷장만 보고, 다시 가져오면 공개 그대로 새 버전이 되며, `walk`가 없는 캐릭터는 이유와 함께 실패한다. 그 캐릭터를 주민으로 가져와 회원이 인사말과 함께 섬에 두면 방문자가 상호작용 버튼으로 인사말을 읽고, 회원이 옷장에서 모자를 씌워 저장한 모습으로 섬을 걷고 실시간 방에 알리며, 없어진 figure를 고른 섬은 기본 미니미로 걷는다. 로컬 PostgreSQL(55432)과 cargo만 있으면 되고 비용이 들지 않으며, 끝나면 띄운 것과 DB를 지운다. 스크린샷은 인자로 준 폴더(기본 `.data/character-e2e`)에 남긴다.
- 성능: 서버와 빌드본(`npm run build` 뒤 `npm run preview -w frontend`, `http://127.0.0.1:4173`, `/api`는 8080으로 넘긴다)이 떠 있으면 `npm run perf -w frontend -- http://127.0.0.1:4173`이 이 PC의 GPU(Chrome, WebGPU, vsync 끔)로 섬 로딩 시간·전송량·서 있을 때와 걸을 때의 프레임·메인 스레드 상위 함수를 잰다(주소를 빼면 개발 서버 5180을 잰다). 대상 서버에 측정용 계정을 하나 만들고, loopback이 아닌 주소는 `--allow-remote` 없이 거절한다.
- 빌드는 패키지의 캐릭터 GLB(`gltf/*.glb`) 텍스처를 섬 카메라에 맞게 줄인다(색상 1024px, 그 밖 512px, WebP). 원본은 패키지에 그대로 있다.

## 배포 (AWS 서울 리전)

CloudFront(mogaesup.com, www는 경로와 쿼리 그대로 apex로 이동)가 정적 파일은 비공개 S3에서, `/api/*`(WebSocket 포함)는 VPC origin으로 EC2의 Rust 서버에서 받는다. 서버는 비공개 RDS PostgreSQL 17을 쓰고 인터넷에 직접 열려 있지 않다.

1. 리눅스 바이너리: `server`에서 `docker run --rm -e "RUSTFLAGS=-C target-feature=+crt-static" -e CARGO_TARGET_DIR=/src/target -v ${PWD}:/src -w /src rust:1.95.0-alpine sh -c "apk add --no-cache musl-dev && cargo build --release --locked --target x86_64-unknown-linux-musl"`
2. 서버: `python server/scripts/deploy-rust-server.py --factory-url <캐릭터 서버 주소> --factory-access write`. 스택(`mogaesup-server`)을 맞추고, S3와 SSM으로 바이너리를 올려 체크섬을 확인한 뒤 systemd로 띄운다. 주지 않은 `--factory-*`·`--studio-instance-id`는 서버에 있는 값을 그대로 유지하고(끝에 `Studio gateway:` 한 줄로 적용된 값을 보여 준다), 스택 변경이 있으면 변경 세트만 보여 주고 멈추므로 확인한 뒤 `--yes`로 다시 실행한다. 새 바이너리가 시작하지 않거나 건강 검사에 실패하면 이전 바이너리(`mogaesup-server.prev`)로 돌아가 non-zero로 끝난다. 비밀값은 개발 PC로 가져오지 않는다. 스택의 `FactoryGatewaySecret`이 `FACTORY_GATEWAY_KEY`로 들어가 캐릭터 서버 요청마다 `x-gateway-key`로 실린다. 캐릭터 서버 인스턴스는 쉬면 스스로 꺼지므로, 처음 한 번 `--studio-instance-id <인스턴스 ID>`를 주면 스택(`StudioInstanceId`)이 기억하고 서버 역할에 그 인스턴스만 켤 권한(`ec2:StartInstances`)을 준다. 서버는 닿지 않는 스튜디오 요청에 인스턴스를 켜고 켜질 때까지 503 `studio_waking`으로 답하며, 관리자는 `/api/catalog/admin/studio-power`로 상태를 보고 켠다.
3. 웹: `frontend/scripts/deploy-aws.ps1`. 스택(`mogaesup-web`)을 맞추고 빌드·업로드·무효화한 뒤 운영 주소의 `index.html`과 `/api/health`를 확인한다. 스택의 응답 헤더 정책(`frontend/infra/aws-static.yaml`)은 CSP에 `frontend/index.html` 인라인 스크립트의 sha256을 담는다. 그 스크립트를 바꾸면 템플릿의 해시도 바꾸고 `-ProvisionOnly`로 스택을 맞춘다(자동 배포는 스택을 적용하지 않으며, 그동안 브라우저는 그 스크립트를 건너뛴다).
4. 캐릭터 서버: `backend/infra/prepare-aws.ps1 -Upload` 뒤 `backend/infra/deploy-aws.ps1`(자세한 것은 `backend/README.md`). 컨테이너는 API만 낸다. 스튜디오 스택(`gaesup-asset-studio`, `backend/infra/ec2.yaml`)을 갱신할 때는 `ReleaseKey`에 지금 설치된 릴리스(인스턴스의 `/opt/asset-studio/current.json`이나 `backend/dist/aws/deployment-receipt.json`의 `release_key`)를 준다. SSM 배포(`deploy-aws.ps1`과 자동 배포)는 이 파라미터를 바꾸지 않으므로 예전 값으로 갱신하면 교체된 인스턴스가 첫 부팅에 옛 릴리스를 설치한다. 값이 바뀌면 사용자 데이터가 바뀌어 교체되지 않는 갱신에서도 인스턴스가 한 번 멈췄다 켜지므로 진행 중인 작업이 없을 때 적용한다.
5. 스튜디오 잠금: `python server/scripts/lock-studio.py --allow-ip <주인 IP>`. 캐릭터 스튜디오의 CloudFront에 함수를 붙여 게이트웨이 키를 가진 이 서버와 적은 IP만 통과시킨다(`--unlock`으로 뗀다). 스튜디오 스택(`gaesup-asset-studio`)을 다시 배포하면 떨어지니 그 뒤에 다시 돌린다.

### 자동 배포 (GitHub Actions)

`.github/workflows/pipeline.yml`이 위 1~4를 대신한다. 스택(CloudFormation)과 5번은 자동으로 적용하지 않는다.

- 풀 리퀘스트와 `main` 푸시는 바뀐 곳만 점검한다(`.github/`가 바뀌면 모두). 서버는 `cargo fmt --check`·`clippy -D warnings`·`cargo test`(PostgreSQL 17을 55432에 띄움), 캐릭터 서버는 Python 3.11·3.12에서 `uv sync --locked --extra studio-mcp`·`compileall`·`pytest`(같은 PostgreSQL. CI에서는 기록 DB 테스트가 건너뛰지 않고 실패한다), 웹은 `typecheck`·`test`·`build`와 `index.html` 인라인 스크립트의 CSP 해시(`frontend/infra/aws-static.yaml`), 템플릿과 스크립트는 `cfn-lint`·문법 검사·actionlint·변경 감지 회귀 검사다. 서버 배포 스크립트(`server/scripts/`)나 기물 생성(`scripts/props/`)이 바뀌면 그 테스트가 있는 캐릭터 서버 점검도 돈다. uv는 스튜디오 이미지와 같은 버전(0.11.9), Node는 `.nvmrc`를 쓴다. `npm run smoke`·`test:character`는 브라우저와 GPU가 필요해 돌리지 않는다.
- `main`의 실행이 점검을 통과하면 서버 → 웹 → 스튜디오 순서로, 파트마다 그 파트를 마지막으로 배포한 커밋 이후 바뀐 곳이 있으면 배포한다(`.github/scripts/deploy_bases.py`: 그 파트의 배포 작업이 성공한 가장 최근 실행, 또는 모두 통과한 가장 최근 푸시 실행). 한 파트의 배포가 실패해도 다른 파트는 다시 배포하지 않고, 실패한 파트만 다음 실행이 이어 배포한다. 점검이 하나라도 실패하면 배포하지 않고, 배포하는 파트는 같은 실행에서 점검을 거친다. 배포 대상은 각 파트의 릴리스에 들어가는 경로다(`.github/scripts/release_parts.sh`). `server/`·`frontend/`·`backend/` 아래의 새 파일은 실행에 쓰이지 않는다고 알려진 것(테스트, 템플릿, 개발용 스크립트, 문서 `*.md`, 엔진 패키지의 출처 기록)이 아니면 배포 대상이고, 스튜디오 대상은 `backend/infra/prepare-aws.ps1`이 묶는 파일과 같다(테스트가 둘을 맞춘다). `.github/workflows/pipeline.yml`이 바뀌면 전체를 다시 배포하고, 그 밖의 `.github/` 변경은 점검만 한다.
- 서버는 점검과 같은 Rust 1.95.0의 Alpine 이미지로 musl 바이너리를 만들어(크레이트와 빌드 결과를 캐시해 의존성이 그대로면 다시 컴파일하지 않는다) `deploy-rust-server.py --skip-provision`으로, 웹은 웹 점검이 만든 빌드를 그대로 `deploy-aws.ps1 -SkipBuild -SkipProvision`으로, 스튜디오는 `prepare-aws.ps1 -Upload`와 `deploy-aws.ps1`로 올린다. 서버는 설치를 한 번에 하나만 하고, 건강 검사에 실패하면 마지막으로 건강 검사를 통과한 바이너리로 돌아가며(실패한 기동의 서비스 로그는 공개 실행 기록이 아니라 인스턴스의 `/var/log/mogaesup-failed-release.log`에 남긴다), 릴리스 폴더는 최근 5개만 둔다. 스튜디오도 후보 컨테이너의 건강 검사에 실패하면 이전 컨테이너를 복구한다. 웹은 엔진 파일(WASM, 기본 미니미)이 빌드에 있는지 올리기 전에 확인하고, 이름에 해시가 없는 WASM은 브라우저가 매번 바뀌었는지 묻게 올린다. 되돌리는 커밋을 푸시하면 이전 모습으로 다시 배포된다. 앞 단계 배포가 실패하면 뒤 단계는 실행하지 않는다.
- 비교할 이전 실행이 없는 첫 `main` 푸시(그 실행의 커밋이 사라진 경우도)는 전체를 점검하고 배포한다. 수동 실행은 Actions의 Run workflow에서 `target`(`all`·`server`·`web`·`studio`)을 고르며, 점검은 모두 돌고 고른 곳과 아직 배포되지 않은 변경이 있는 곳을 배포한다(대기 중이던 푸시 실행을 대신한 경우에도 그 변경이 빠지지 않는다). `main` 외의 브랜치와 풀 리퀘스트는 배포하지 않고, 배포 대기열과 따로 점검만 한다. 이전 실행을 다시 돌리면(Re-run) 그 커밋이 `main`의 최신일 때만 배포한다. 옛 커밋을 다시 배포하면 운영이 되돌아가기 때문이다.
- 스튜디오 인스턴스는 2시간 쉬면 스스로 꺼지고(`backend/infra/idle-stop.sh`), 배포는 꺼진 인스턴스를 켜지 않는다. 그 실행은 실패로 끝나지만 서버·웹은 다시 배포하지 않고 스튜디오만 대기로 남는다. 켠 뒤 `main`에서 `target=studio`로 실행하거나 다음 푸시가 이어 배포한다. 실행 중인 런타임의 신규 작업 접수를 먼저 닫고 기존 API·CLI·Blender 작업이 끝나야 교체한다. 시간이 지나도 비지 않으면 종료 코드 4, 활동·DB·수락 차단을 확인할 수 없으면 5로 중지하고 기존 서비스를 유지한다. 후보 실패·배포 중단 시 이전 설정과 컨테이너를 복구하고 접수를 다시 연다. drain을 지원하지 않는 구버전의 최초 교체는 [백엔드 배포 절차](backend/README.md#aws-배포)에 따라 접수를 닫고 작업 종료를 확인하는 점검 시간이 필요하다.
- AWS에는 비밀값 없이 OIDC로 들어간다. 역할 `mogaesup-github-deploy`(`.github/aws/deploy-role.yaml`)는 `main` 브랜치의 이 저장소만 맡을 수 있고, 릴리스 파일 올리기·CloudFront 무효화·SSM 설치 명령·스택과 인스턴스 상태 읽기·템플릿 검사만 허용한다. CloudFormation 변경과 IAM은 못 한다. 한 번 만든다.
  ```bash
  aws cloudformation deploy --region ap-northeast-2 --stack-name mogaesup-github-deploy --template-file .github/aws/deploy-role.yaml --capabilities CAPABILITY_NAMED_IAM --tags application=mogaesup
  ```
  서버·스튜디오 인스턴스가 교체되거나 웹 배포(CloudFront) ID가 바뀌면 템플릿의 파라미터를 갱신해 다시 배포한다.
