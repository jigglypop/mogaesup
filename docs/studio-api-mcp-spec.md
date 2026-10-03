# 모개숲 API 검수용 MCP 설계

작성일: 2026-10-03. 로컬 stdio API 어댑터와 네이티브 조립 검수 API는 구현되었다. 아래에서 등록된 tool과 후속 제안을 구분한다. 원격 HTTP MCP/OAuth와 회원별 사진 제작 API는 구현되지 않았다. 어댑터 검증은 가짜 HTTP 응답과 임시 조립 산출물을 사용한다.

## 현재 구현과 실행 설정

[studio_mcp.py](../backend/src/studio_mcp.py)는 기존 Rust 게이트웨이를 호출한다. MCP SDK는 선택 의존성 `mcp==1.30.0`이며 실제 stdio 초기화 테스트에서 프로토콜 `2025-11-25`를 확인한다.

```sh
uv sync --locked --extra studio-mcp
uv run --no-sync asset-studio-mcp
```

프로세스 환경에 아래 설정을 전달한다. `backend/.env`를 읽지 않으며 자격 증명을 tool 인수나 MCP 출력에 넣지 않는다. 환경의 비밀값을 대화나 명령 기록에 출력하지 않는다.

| 환경 변수 | 값과 동작 |
| --- | --- |
| `MOGA_STUDIO_API_URL` | Rust API의 HTTPS origin. 로컬 개발은 loopback HTTP origin도 허용. 경로·query·사용자정보 금지 |
| `MOGA_STUDIO_SESSION` | 기존 로그인 세션의 64자리 hex 자격 증명. 요청의 `mogaesup_session` 쿠키에만 사용 |
| `MOGA_STUDIO_APP_ORIGIN` | 선택 사항. Rust의 `APP_ORIGIN`과 같은 origin; 미설정 시 API origin. 개발 웹과 API 포트가 다르면 설정 |
| `MOGA_STUDIO_MCP_WRITE` | 기본 읽기 전용. 정확히 `1`일 때 아래 세 mutation만 요청 가능 |

현재 읽기 tool은 `get_my_permissions`, `list_catalog_items`, `list_wardrobe_bodies`, `get_my_look`, `get_factory_usage`, `get_character`, `get_character_operation`, `get_factory_job`, `get_native_assembly`다. 변경 tool은 `inspect_character`, `record_character_review`, `record_native_review`다. 각각 ID와 revision 또는 조립 SHA, idempotency key, bounded 검수 입력만 받으며 임의 HTTP/API/코드/경로 tool은 없다. 게이트웨이의 로그인·ReBAC·서버 전체 access와 backend의 소유권·상태 검사를 그대로 통과해야 한다. 유료 생성 tool은 없다.

`record_native_review`는 `POST /api/avatar-factory/jobs/{job_id}/native-parts/{version}/review`에 `Idempotency-Key`와 `{expected_assembly_sha256, decision, appearance_checked, motion_checked, notes}`를 보낸다. notes는 승인에도 5~2000자 필수다. 서버는 현재 완료된 버전과 전체 sealed 산출물 hash, 기술 오류·미완성 파츠·표정 적용 여부를 다시 확인한다. 승인에는 외형/동작 체크와 네 방향·동작 렌더가 필요하다. `reviews.json`은 원본 `record.json`·`quality.json`과 별도로 저장되며 GET과 버전 목록의 `review.status`에 결합된다. 산출물이 달라지면 `stale`이다. `reviewer_id`는 공유 factory owner, `reviewer_name`은 게이트웨이가 서명한 실제 조작자 이름이다. MCP의 검사 결과 자체는 사람의 시각 승인을 대신하지 않는다.

HTTP/API 오류의 status와 허용된 안정적인 code만 출력하고 내부 메시지·토큰·절대 경로·서명 URL은 정리한다. 응답은 8MiB까지 읽는다. timeout이나 5xx 이후 POST를 자동 재시도하지 않는다. 캐릭터 operation ID를 조회하거나 동일 key와 입력으로 사용자가 명시적으로 복구한다. [API·stdio 테스트](../backend/tests/api/test_studio_mcp.py), [네이티브 검수 테스트](../backend/tests/api/test_native_reviews.py).

## 1. 연결 위치

현재 로컬 `stdio` MCP 서버는 기존 Rust API의 제한된 조회와 검수 작업을 호출한다. 로그인한 계정의 상태, 옷장, 생성 작업, 검수 영수증을 조회하며 환경에서 변경을 허용한 경우 검사·검수 기록을 요청한다. 유료 생성과 외부 에셋 수집은 후속 범위다.

```text
MCP 클라이언트
  → 로컬 stdio 어댑터: 고정 tool 목록, 입력 스키마, 응답 정리
  → Rust API: 세션 인증, ReBAC 권한, 월별 작업 한도, 요청 감사 기록
  → Python Character API: 소유권, 작업 상태, revision, 실행 영수증
  → 기존 서비스 / 저장소 / Blender / 공급자
```

어댑터는 서비스 로직을 다시 구현하지 않는다. 특히 임의 URL·HTTP 메서드·헤더·셸 명령·Python/Blender 코드·서버 파일 경로를 받는 범용 tool은 제공하지 않는다. 이미지와 GLB도 서버가 발급한 업로드 ID, 산출물 ID와 해시로 다룬다.

현재 Rust 경로는 세션 쿠키를 검사한다. 로컬 어댑터는 환경에 주입된 기존 세션 자격 증명을 쿠키로 전달하며 MCP용 Bearer/OAuth 인증은 없다. 비밀값은 tool 인수, 대화, 출력에 포함하지 않는다. 원격 HTTP MCP를 공개할 때는 MCP 리소스 전용 OAuth 인증을 추가하고 audience를 검증한다. MCP 클라이언트의 토큰을 downstream API에 그대로 전달하지 않는다. 원격 HTTP 인증은 별도 구현 과제다.

첫 구현 기준은 MCP `2025-11-25`와 검증한 SDK 버전 고정이다. `2026-07-28` draft의 transport 변경은 별도 평가한다. 근거: [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

## 2. 이미 있는 Blender MCP와 구분

기존 [blender_mcp.py](../backend/src/services/blender_mcp.py#L21)는 `blender-mcp` 프로세스에 연결하는 **클라이언트**다. 서버가 만든 고정 편집 스크립트를 `execute_blender_code`로 보내며 공급자 키를 자식 프로세스에서 제거한다. 제출 후 완료를 확인하지 못하면 `BlenderExecutionUncertain`을 반환하고 자동 재실행하지 않는다.

[editor_cli.py](../backend/src/editor_cli.py#L72)는 `start`, `import`, `edit`, `inspect`, `history`, `deliver`를 제공한다. [blender_edits.py](../backend/src/services/blender_edits.py#L16)의 검증된 명령은 위치·회전·배율, 재질, 표시 여부, 본 부착이다. CLI는 로컬 경로와 운영자 전용 Blender 인스턴스를 대상으로 하므로 브라우저나 외부 MCP에 그대로 노출하면 안 된다.

현재 API MCP는 기존 모개숲 HTTP API를 조회하고 구조화된 검사·검수 요청을 전달한다. 기존 Blender 실행 tool은 등록하지 않는다.

## 3. 현재 권한과 개인 제작의 경계

- Rust의 [`require`](../server/src/auth.rs#L111)는 세션 계정을 확인하고 ReBAC 권한을 검사한다. `studio_viewer`, `operator`, `paid_operator`, `catalog_editor`는 [rebac.rs](../server/src/rebac.rs#L304)에 정의되어 있다.
- 일반 회원은 `/api/avatar-factory/wardrobe/*`와 허용된 파츠 GLB를 읽는다. 기타 스튜디오 읽기는 `studio_viewer`, 변경은 `operator`, 대부분의 POST는 `paid_operator`가 필요하다. 서버 전체 `FACTORY_ACCESS`와 월별 유료 요청 한도도 적용된다. [분류와 검사](../server/src/factory.rs#L329).
- 게이트웨이의 backend JWT는 실제 회원 UUID 대신 고정 `FactoryToken.owner_id`를 `sub`와 `userId`로 넣고 `ADMIN`을 부여한다. 일반 회원의 옷장 읽기에는 `ADMIN`, `MEMBER`를 함께 넣어 노출 범위를 제한한다. [JWT 발급](../server/src/factory.rs#L139), [회원 범위 적용](../server/src/factory.rs#L523).
- Python API도 JWT 검증과 `ADMIN`을 요구하며, 서비스는 전달받은 정수 owner ID로 소유권을 확인한다. [인증](../backend/src/auth.py#L150), [접근 조건](../backend/src/auth.py#L219), [캐릭터 소유권](../backend/src/services/character_pipeline.py#L90).
- `X-User-Id`는 실제 loopback 소켓, loopback Host, 안전한 Origin이며 forwarding 헤더가 없는 로컬 개발 요청에만 허용된다. 외부 MCP의 인증으로 사용하지 않는다. [로컬 경계](../backend/src/auth.py#L123).

따라서 회원이 자신의 얼굴 사진으로 제작하려면 Rust 회원 UUID와 backend owner의 매핑, 사진·작업·파츠의 개인 공개 범위, 삭제, 저장 기한을 먼저 구현해야 한다. 운영 스튜디오의 공유 owner를 개인 사용자로 간주하거나 고정 ADMIN JWT를 MCP 클라이언트에게 제공하지 않는다. 일반 회원이 기존 옷장 파츠를 조합하고 자기 모습으로 저장하는 [`/api/looks/me`](../server/src/looks.rs#L65)는 이미 별도 기능으로 존재한다.

## 4. 1단계 읽기 tool과 실제 API

상단 현재 구현 목록의 tool은 등록되어 있고, 나머지 아래 이름은 후속 제안이다. API 열의 경로는 현재 존재한다. 경로는 Rust API 기준이며 Python 스튜디오 엔드포인트도 같은 이름으로 프록시된다.

| 제안 tool | 실제 API | 현재 필요한 권한 / 입력 |
| --- | --- | --- |
| `get_my_permissions` | `GET /api/auth/me` | 로그인 세션. 현재 계정과 권한 목록 |
| `list_catalog_items` | `GET /api/catalog/items` | 공개. 현재 tool은 kind 입력 없이 published 목록 반환 |
| `get_my_island` | `GET /api/homes/me`와 `GET /api/homes/{username}/world?worldId=...` | 로그인. username은 현재 계정에서 결정; worldId만 입력. 저장된 revision·envelope 조회 |
| `get_my_look` | `GET /api/looks/me` | 로그인. 자신의 옷장 조합과 조립 상태 |
| `list_wardrobe_bodies` | `GET /api/avatar-factory/wardrobe/bodies` | 로그인 회원. 게이트웨이의 MEMBER 범위 적용 |
| `list_wardrobe_parts` | `GET /api/avatar-factory/wardrobe/bodies/{job_id}/parts` | 로그인 회원. 서버가 발급한 job ID |
| `get_character` | `GET /api/characters/{character_id}` | `studio_viewer`. revision, 모델 해시, inspection, review, next_actions |
| `get_character_operation` | `GET /api/characters/{character_id}/operations/{operation_id}` | `studio_viewer`. 저장된 작업 영수증 |
| `get_factory_job` | `GET /api/avatar-factory/jobs/{job_id}` | `studio_viewer`. 파츠별 상태와 조립 버전 |
| `get_native_assembly` | `GET /api/avatar-factory/jobs/{job_id}/native-parts` | 등록됨. `studio_viewer`. 현재 모델 SHA와 검수 overlay |
| `get_model_stats` | `GET /api/avatar-factory/jobs/{job_id}/model-stats?name=...&version=...` | `studio_viewer`. 허용한 산출물 name enum과 저장 버전 |
| `get_generation` | `GET /api/studio/generations/{job_id}` | `studio_viewer`. prop·texture·illustration 작업 상태 |
| `get_glb_asset` | `GET /api/studio/glb-assets/{asset_id}` | `studio_viewer`. 등록된 GLB 및 준비 작업 상태 |
| `get_catalog_import` | `GET /api/catalog/admin/imports/{id}` | `catalog_editor`. 기술검사·파일해시·버전과 실패 지점 |
| `get_factory_usage` | `GET /api/catalog/admin/factory-usage` | `studio_viewer`. 서버 access 및 월별 요청 수·한도 |

근거: [Rust 라우터](../server/src/lib.rs#L83), [섬 라우터](../server/src/homes.rs#L45), [카탈로그 라우터](../server/src/catalog.rs#L34), [캐릭터 API](../backend/src/api/characters.py#L117), [옷장 API](../backend/src/api/avatar_factory.py#L401), [작업·모델 통계 API](../backend/src/api/avatar_factory.py#L750), [소품 생성 상태 API](../backend/src/api/studio.py#L91), [GLB API](../backend/src/api/studio_glb_assets.py#L43).

`get_character`와 `get_factory_job`은 서로 다른 생산 흐름이다. 하나의 ID가 두 API에서 모두 유효하다고 추정하지 않는다. 보존된 inspection이 없으면 “현재 검사 기록 없음”을 결과 데이터에 표시하고 MCP GET이 검사나 공급자 polling을 자동 수행하지 않는다. [`character_flow`](../backend/src/services/avatar_character_flow.py#L11)도 저장 영수증만 요약한다.

`readOnlyHint` 등의 annotations는 클라이언트에 주는 힌트이며 권한 검사를 대신하지 않는다. tool마다 서버 인증과 최소 권한을 강제한다. `inputSchema`는 JSON Schema 2020-12 기준으로 작성하고 `outputSchema`와 `structuredContent`의 결과가 일치하는지 검증한다. 모든 응답에서 토큰, 절대 경로, 내부 예외, 공급자 raw 영수증을 제거한다.

## 5. 후속 mutation 연결과 아직 없는 기능

| 기능 / 제안 tool | 현재 연결 가능한 계약 | 구현 상태 또는 선행 과제 |
| --- | --- | --- |
| 캐릭터 검사 `inspect_character` | `POST /api/characters/{id}/actions/inspect_model` | MCP 등록됨. 무료 변경으로 분류. operator, If-Match와 Idempotency-Key 필요 |
| 원본 면 분리 `separate_character_parts` | `POST /api/characters/{id}/actions/separate_parts` | 실제 action 존재. 원본 GLB hash, node/primitive index와 faces만 받음 |
| 파츠 역할 지정 `organize_character_parts` | `POST /api/characters/{id}/actions/organize_parts` | 실제 action 존재. 모든 메시를 하나의 역할에 배정하고 body coverage 기록 |
| 캐릭터 검수 `record_character_review` | `POST /api/characters/{id}/actions/record_review` | MCP 등록됨. 무료 변경. operator, If-Match와 Idempotency-Key, 체크와 notes 필요 |
| 네이티브 조립 검수 `record_native_review` | `POST /api/avatar-factory/jobs/{job_id}/native-parts/{version}/review` | MCP 등록됨. 무료 변경. operator, 조립 SHA와 Idempotency-Key, 체크와 notes 필요 |
| 2D 사진·파츠 배치 편집 | `PUT /api/avatar-blueprints/{character_id}` | crop·placement·opacity·order 저장 API 존재. 3D 메시 편집 API와 구분 |
| GLB 옷·소품 반입 | `POST /api/studio/glb-assets/upload`, `POST /api/studio/glb-assets` | 업로드 ID와 slot으로 등록 가능. 외부 출처·라이선스 증거 기록은 추가 필요 |
| 3D 몸 기준 옷·헤어 fitting | `POST /api/studio/glb-assets/{asset_id}/prepare` 또는 `POST /api/avatar-factory/jobs/{job_id}/native-parts/refit` | 실제 계약 존재. `prepare`의 fit·rig는 gateway에서 모두 유료 분류; action별 분류 정리 필요 |
| 옷장 조합 저장·착용 | `PUT /api/looks/me`, `PATCH /api/looks/me` | 일반 회원 API 존재. 서버가 옷장 버전·해시를 재검사하고 GLB 조립; 개인 사진 생성 API는 아님 |
| 기업·매장 자연어 배치 | `GET /api/studio/layouts/capabilities`, `POST /api/studio/layouts/interpret` 및 기존 섬 저장 API | 규칙 해석·실제 GLB 치수로 타일/벽/기물 계획·미리보기·적용 연결 구현됨. 선택 AI 해석은 유료 권한과 요청 영수증 필요. MCP tool은 미등록 |
| 옷장 헤어·옷·소품 배율 저장 | `PUT /api/looks/me`의 `partEdits` | 브라우저에서 허용된 배율을 저장하고 서버가 hash·skin·동작을 보존해 look GLB 조립. MCP tool은 미등록. 원본 몸 메시 수정과 구분 |
| 개인 사진 제작 | 운영자 `POST /api/avatar-factory/image-jobs` 존재 | 회원별 owner 매핑과 권한·사진 보관 계약 없이는 회원에게 열지 않음 |
| 외부 에셋 검색·최신 스타일 수집 | 대응 API 없음 | 허용 소스, 라이선스, 출처, 취득일, 스타일 tags와 해시를 기록하는 수집 계약 추가 필요 |

근거: [action 입력 스키마](../backend/src/api/characters.py#L40), [2D blueprint 계약](../backend/src/api/avatar_blueprints.py#L21), [GLB 준비 계약](../backend/src/api/studio_glb_assets.py#L20), [단일 파츠 refit](../backend/src/api/avatar_factory.py#L699), [사진 제작 API](../backend/src/api/avatar_factory.py#L651), [모습 조합 계약](../server/src/looks.rs#L84).

범용 `run_http_request`나 `execute_blender_code`를 후속 mutation 대체 수단으로 추가하지 않는다. 별도 에셋 스크립트도 MCP를 통해 임의 경로나 운영자 계정으로 실행하지 않는다.

## 6. 중복 요청·동시 편집·영수증

캐릭터 action은 다음 순서를 유지한다.

1. 현재 로그인 계정과 소유권을 확인하고 서버에서 최신 detail을 읽는다.
2. 요청하는 action이 서버의 `next_actions`에 있으며 `enabled=true`인지 확인한다. 클라이언트 확인 이후에도 서비스가 다시 검사한다.
3. `If-Match`에는 사용자가 편집한 revision, `Idempotency-Key`에는 요청 전체 생애 동안 유지할 키를 넣는다. 현재 캐릭터 action 키 형식은 영문·숫자·밑줄·하이픈 8~100자다.
4. 서비스는 동일 키·동일 입력을 재사용하고 동일 키·다른 입력을 충돌로 거절한다. 실행 전 accepted 영수증을 저장하고 202 및 operation ID를 반환한다.
5. MCP는 별도 읽기 tool로 상태를 조회한다. 연결 종료나 timeout은 실패 확정이 아니다. 새 키를 만들거나 POST를 자동 재전송하지 않는다. 같은 키 재요청도 해당 endpoint에 실제 idempotency가 있을 때만 사용한다.
6. 복구는 기존 작업 ID와 저장된 영수증으로 진행한다. `running` 상태만 보고 잠금을 삭제하거나 Blender를 재실행하지 않는다.

근거: [action 수락](../backend/src/api/characters.py#L162), [owner·revision·키·입력 fingerprint·상태 검사](../backend/src/services/character_pipeline.py#L365), [읽기 재시도만 허용](../backend/src/services/provider_http.py#L87), [유료 제출 의도와 task ID 저장](../backend/src/services/character_jobs.py#L71), [gateway keyed POST 목록](../server/src/factory.rs#L301).

모든 API가 이 계약을 이미 공유하지는 않는다. 카탈로그 import는 실행 중 같은 item을 unique index로 막지만 완료 이후 동일 요청의 idempotency replay 계약은 없다. 섬 저장은 `If-Match` 대신 JSON의 `expectedOwnerId`, `worldId`, `baseRevision`, `data`를 사용한다. 어댑터는 실제 endpoint의 계약을 유지하고 범용 헤더 하나로 안전하다고 가정하지 않는다. [카탈로그 수락](../server/src/imports.rs#L339), [섬 저장 입력](../server/src/homes.rs#L429).

유료 생성 tool은 읽기 MCP 이후 별도 범위로 구현한다. 명시적인 유료 작업 요청, 대상과 설정, 작업 한도를 바탕으로 실행하며 현재 `FACTORY_ACCESS`, `paid_operator`, 서버 월별 한도를 그대로 통과해야 한다. 비용은 provider 실제 과금 영수증과 gateway 요청 수를 구분한다.

## 7. 검수와 에셋 반입에서 해결할 갭

**로컬 검수 분류.** gateway의 FREE_POSTS/KEYED_POSTS에 `inspect_model`, `organize_parts`, `record_review`와 네이티브 버전별 검수의 정확한 경로를 추가했다. 다른 캐릭터 actions는 기존 분류를 유지한다. `external_mutation` 힌트만으로 권한을 결정하지 않는다. [gateway 분류](../server/src/factory.rs#L277), [로컬 검사·검수 실행](../backend/src/services/character_actions.py#L94).

**조립 완료와 검수 승인의 분리.** Avatar flow는 `review_required` 조립을 stage `complete`로 표시하고, Rust 카탈로그 목록은 `complete`, `expressions`를 완성 단계로 취급한다. 카탈로그 import는 GLB 형식·해시·스킨·동작을 검사하지만 선택된 모델 해시에 맞는 외형 승인 영수증을 필수로 확인하지 않는다. 공개/published 조건에 현재 모델 hash와 연결한 검수 결정을 추가해야 한다. 기존 캐릭터 control의 `record_review`는 기술 오류, 현재 파츠 hash, 외형·동작 체크, body coverage를 확인하므로 이 계약을 참고한다. [조립 상태](../backend/src/services/avatar_character_flow.py#L20), [목록 조건](../server/src/studio.rs#L104), [기술검사](../server/src/imports.rs#L158), [검수 영수증](../backend/src/services/character_actions.py#L121).

**소품 생성과 카탈로그 반입의 연결.** 카탈로그 import는 `factoryJobId`로 `avatar-factory/jobs/{id}`의 assembly version을 조회한다. `/api/studio/generations`의 prop 결과는 다른 생산 흐름이므로 같은 import 입력으로 직접 연결되지 않는다. 현재 소품 작업은 [generate.py](../scripts/props/generate.py#L104)에서 생성한 뒤 [props-normalize.mjs](../frontend/scripts/props-normalize.mjs#L39)가 크기·방향·pivot·재질·텍스처를 정규화해 `frontend/public/gltf`에 기록한다. 운영 카탈로그 반입에는 `sourceKind`와 산출물 ID를 명시하는 확장 계약이 필요하다. [현재 source 조회](../server/src/imports.rs#L504), [캐릭터 source 계약](../server/src/studio.rs#L211).

**외부 기물·의상 출처.** 현재 GLB 등록은 `name`, `slot`, `model_asset`와 원본 hash를 보존한다. 카탈로그의 출처는 `builtin`, `factory` 중심이며 외부 에셋의 license·attribution·source URL·취득일·원본 hash 계약은 없다. 외부 수집을 제품에 연결할 때 이 정보를 등록 레코드와 공개 가능 판정에 추가한다. 트렌드 참고와 실제 사용 권한은 각각 기록한다. [GLB 등록](../backend/src/api/studio_glb_assets.py#L20), [원본 hash 확인](../backend/src/services/studio_glb_assets.py#L39), [카탈로그 schema](../server/migrations/0004_catalog.sql#L1).

**3D 수정 후 재검수.** 새로운 크기 편집은 원본을 보존하고 새 산출물 해시·revision을 만든다. 변경된 GLB의 inspection과 visual/motion review는 다시 계산·확인한다. 레이어 crop/placement 변경이나 화면상의 임시 scale만으로 저장된 3D 모델이 수정되었다고 표시하지 않는다. 골격·skin·본 부착을 보존하는 허용 연산을 서비스에 정의해야 한다.

## 8. 구현 검증 기준

첫 MCP 구현은 fake Rust HTTP 응답으로 인증, tool별 허용 endpoint, 잘못된 ID 거절, 권한 오류 전달, 민감한 출력 제거, outputSchema 일치, 읽기 tool의 mutation 부재를 검사한다. 새 mutation을 붙이면 동일 키 재요청, 키 충돌, stale revision, 소유권 충돌, 작업 timeout 이후 기존 영수증 조회, drain 중 거절을 검증한다.

현재 backend 테스트는 [conftest.py](../backend/tests/conftest.py#L1)가 `.env` 로딩을 막고 키·AWS·DB 설정을 비우며 임시 데이터 루트와 외부 연결 차단을 사용한다. 캐릭터 API, 공급자 실패·복구, 기록 DB, 파일 잠금, runtime admission, 옷장 범위 등을 다룬다. DB 테스트는 로컬 PostgreSQL이 없으면 skip될 수 있다. Rust 통합 테스트는 [common/mod.rs](../server/tests/common/mod.rs#L18)의 로컬 테스트 PostgreSQL에 임시 DB를 만든다.

CI는 Rust fmt·clippy·test, backend offline pytest, frontend typecheck·test·build를 실행한다. backend-check는 `uv sync --locked --extra studio-mcp`로 실제 SDK 테스트도 설치한다. 일반 `uv sync --locked`에서 선택 의존성 미설치 시 두 SDK/stdio 테스트만 명시적으로 skip되며 HTTP adapter 테스트는 계속 돈다. [pipeline.yml](../.github/workflows/pipeline.yml#L70). 오프라인 검사와 stdio 실행 검증은 실제 provider 성공이나 Blender 시각 품질의 증거가 아니다.
