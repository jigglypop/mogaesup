# 모개숲 프로그램 분석

2026년 10월 3일의 로컬 코드 `8fed474`를 기준으로 앱, Rust 서버, 캐릭터 서버, 엔진 패키지, 저장·배포·검수 경로를 분석했다. 목적은 사용자의 설명으로 매장을 배치하고, 본인 사진으로 만든 캐릭터를 브라우저에서 조정하고 재검수하는 기능의 구현 경계를 정하는 것이다.

섬 편집과 캐릭터 생산의 기반은 이미 있다. 추가할 핵심은 **설명을 검증 가능한 배치 계획으로 바꾸는 연결**, **회원별 사진·제작 소유권**, **편집한 변환을 최종 GLB에 반영하는 계약**, **검토한 버전에 묶인 시각 승인**이다. MCP는 이 API들을 호출하는 어댑터로 붙이는 편이 적합하다.

아래는 `8fed474`에서 작업을 시작할 때의 분석이다. 이후 실제 화면·서버·MCP를 구현했다. 최종 변경과 검증 결과는 [구현 보고](implementation-2026-10-03.md)를 기준으로 확인한다. 이 문서의 기존 상태·추가 과제는 착수 시점의 상태다.

## 프로그램 구조

| 영역 | 실제 역할과 코드 |
| --- | --- |
| 화면과 경로 | React·Vite 앱 하나. 로그인, 둘러보기, `/@username`, `/@username/edit`, 회원 옷장 `/character`, 운영 스튜디오 `/admin/studio`, 카탈로그·권한 관리. [main.tsx](../frontend/src/main.tsx) |
| 섬 렌더링 | R3F·Three·WebGPU와 gaesup-world. 엔진의 building plugin으로 섬 상태를 만들고 앱의 주민 저장을 결합한다. [world.ts](../frontend/src/minihome/world.ts), [worldRenderer.ts](../frontend/src/rendering/worldRenderer.ts) |
| 섬 편집 | 타일·벽·기물 설치, 선택·이동·회전·크기 변경, 되돌리기·다시 하기, 저장 충돌 처리. [Decorate.tsx](../frontend/src/minihome/Decorate.tsx), [edit/session.ts](../frontend/src/minihome/edit/session.ts), [edit/history.ts](../frontend/src/minihome/edit/history.ts) |
| 회원과 접근 권한 | Rust axum, 쿠키 세션, PostgreSQL. 역할·그룹·섬 접근을 ReBAC 관계로 검사한다. [auth.rs](../server/src/auth.rs), [rebac.rs](../server/src/rebac.rs), [permissions.rs](../server/src/permissions.rs) |
| 섬 저장과 소셜 | 사용자 소유 섬, 리비전 저장, 공개 범위, 방문자, 방명록, 일촌. [homes.rs](../server/src/homes.rs), [social.rs](../server/src/social.rs) |
| 실시간 방 | 일회용 입장 티켓과 WebSocket. 세션·섬 접근 재확인, 위치·회전·캐릭터 모델 전달. [rooms.rs](../server/src/rooms.rs) |
| 스튜디오 게이트웨이 | 앱 권한, 운영 모드, 월 유료 요청 한도, 요청 기록, 산출물 중계, 스튜디오 인스턴스 기동. [factory.rs](../server/src/factory.rs), [studio_power.rs](../server/src/studio_power.rs) |
| 캐릭터 생산 | FastAPI 입력 검증과 서비스 실행. 사진 준비, 기본몸, 파츠 원화·3D, 리깅·표정, 피팅·조립, 상태·복구. [api/characters.py](../backend/src/api/characters.py), [api/avatar_factory.py](../backend/src/api/avatar_factory.py), [character_pipeline.py](../backend/src/services/character_pipeline.py), [avatar_factory.py](../backend/src/services/avatar_factory.py) |
| 에셋과 라이브러리 | 몸·파츠·GLB 업로드와 목록, 기물·텍스처·일러스트 제작. [studio.py](../backend/src/api/studio.py), [studio_glb_assets.py](../backend/src/api/studio_glb_assets.py), [studio_library.py](../backend/src/services/studio_library.py) |
| 옷장과 최종 착용 | 회원이 공용 몸·파츠·색을 선택. Rust가 파츠 목록과 SHA를 대조하고 GLB를 구워 자기 캐릭터로 저장한다. [Wardrobe.tsx](../frontend/src/character/studio/Wardrobe.tsx), [looks.rs](../server/src/looks.rs), [look_bake.rs](../server/src/look_bake.rs) |
| 카탈로그 배포 | 완성 캐릭터를 미니미·주민으로 가져와 검사·텍스처 축소·해시 저장·썸네일·버전을 만든다. [imports.rs](../server/src/imports.rs), [studio.rs](../server/src/studio.rs), [catalog.rs](../server/src/catalog.rs) |
| 작업 수명과 저장 | 긴 작업의 수락·잠금·재개·공급자 영수증, 비공개 S3 산출물과 선택적 PostgreSQL 기록 저장. [character_jobs.py](../backend/src/services/character_jobs.py), [runtime_activity.py](../backend/src/services/runtime_activity.py), [record_store.py](../backend/src/services/record_store.py) |
| 로컬 편집 도구 | `asset-editor`가 Blender MCP에 연결하여 import·edit·inspect·deliver를 수행한다. 브라우저 API를 감싸는 MCP 서버와는 다른 도구다. [editor_cli.py](../backend/src/editor_cli.py), [asset_editor.py](../backend/src/services/asset_editor.py), [blender_mcp.py](../backend/src/services/blender_mcp.py) |
| 배포 | main push의 검사를 통과한 변경을 서버·웹·스튜디오에 자동 배포한다. 스튜디오 작업은 drain으로 보호한다. [pipeline.yml](../.github/workflows/pipeline.yml), [backend/infra](../backend/infra/) |
| 전투 초안 | Rust `war` 모듈의 턴제 계산 코드가 있다. 현재 앱 라우터에는 전투 HTTP·화면·영속 저장이 연결되어 있지 않다. [lib.rs](../server/src/lib.rs), [war/mod.rs](../server/src/war/mod.rs) |

README는 엔진을 npm 패키지로 받는다고 설명한다. 현재 설치 계약은 공개 registry 버전 대신 `frontend/vendor/gaesup-world-1.7.0-mogaesup.2.tgz`의 file dependency다. 이 패키지 역시 앱 외부에서 빌드한 엔진 산출물이며 엔진 소스를 이 저장소에서 수정하지 않는다. [frontend/package.json](../frontend/package.json), [패키지 기록](../frontend/vendor/gaesup-world-1.7.0-mogaesup.2.md)

## 요청별 현재 지원 범위

| 요청 | 현재 지원 | 추가할 부분 |
| --- | --- | --- |
| 설명으로 매장 대략 배치 | 직접 설치하는 타일·벽·기물 편집기와 저장 | 설명 → 계획 JSON → 검증 → 미리보기 → 편집기로 적용 |
| 타일 설치 정의 | 4m 셀, 타일 모양·재질·높이, 벽과 기물 | 계획의 단위·원점·표면 높이·벽 변환·기물 바닥 면적 계약 |
| 사진 기반 얼굴·헤어·몸 제작 | 운영자의 사진 업로드와 기본몸 재사용/새 몸 생산, 파츠·표정 생산 | 회원별 사진 제작 소유권, 브라우저 자르기·축소, 본인 이미지 비교 흐름 |
| 제작 후 직접 편집 | 운영자의 의상 소매·밑단·품과 기준점 재피팅, 섬 기물의 크기 편집 | 캐릭터 파츠별 크기·위치·회전 입력과 최종 GLB 반영 |
| 재검수 | 기술 품질 JSON·렌더, 별도 character action의 review 기록 | native 조립본의 시각 승인 API·화면, 버전/SHA 고정, 수정 후 승인 무효화 |
| 기물·옷 수집 | 기물 제작 명세 69개, 의상 프롬프트 27개, GLB 라이브러리 | 출처·라이선스·치수·호환 몸·검수 상태를 가진 수집 목록과 신규 기물 배포 연결 |
| MCP에서 API 호출·검수 | Blender MCP 클라이언트와 편집 CLI | 기존 HTTP API를 감싸는 제한된 MCP 서버 |

69와 27은 각각 [기물 명세](../scripts/props/manifest.json)와 [의상 문장](../frontend/src/character/studio/garment-styles.json)의 항목 수다. 실제로 생성되었거나 승인되어 운영에 배치된 에셋 수가 아니다. 과거 문서의 운영 재고 숫자는 이번 작업에서 다시 조회하지 않았다.

## 구현 전에 해결할 코드 경계

### 회원 사진 제작 소유권

게이트웨이의 스튜디오 JWT `sub`와 `userId`는 실제 회원 ID 대신 설정한 공용 `owner_id`를 사용한다. 회원 옷장 토큰도 이 owner에 `ADMIN`·`MEMBER`를 표시한 읽기 토큰이다. 현재 회원이 자기 얼굴을 업로드·제작하는 API를 이 흐름에 그대로 붙이면 개인 사진이 공용 제작 계정으로 저장된다. [factory.rs](../server/src/factory.rs#L139), [auth.py](../backend/src/auth.py)

앱 회원 UUID와 캐릭터 서버 제작 owner를 연결하고, 개인 사진·작업·산출물과 공용 옷장을 구분해야 한다. 일반 회원에게 기존 운영 쓰기 토큰을 제공하는 방식으로 해결하지 않는다. 기존 `/api/looks/me`는 실제 회원 소유의 최종 착용 결과이며 이 계약은 재사용할 수 있다.

### 무료 검수의 권한과 집계

`POST /api/characters/{id}/actions/{action}`은 현재 게이트웨이의 무료 목록에 없어서 모든 action이 Paid로 분류된다. 따라서 로컬 `inspect_model`, `organize_parts`, `record_review`도 유료 작업 권한과 월 한도에 걸린다. 실제 공급자 비용이 발생하는 action과 로컬 검수 action을 정확한 allowlist로 분리해야 한다. 새 POST 전체를 무료로 바꾸면 생성·재개 요청이 유료 통제를 벗어난다. [factory.rs](../server/src/factory.rs#L277), [character_actions.py](../backend/src/services/character_actions.py)

### 기술 통과와 시각 승인

별도 character pipeline에는 현재 모델 해시와 기술 오류·역할·검수 항목을 대조하는 `record_review` action이 있다. 반면 native 조립 결과의 `quality.visual_review`는 `required`로 만들어지고, 해당 버전을 승인으로 바꾸는 저장 API가 없다. UI의 승인 완료 표시만으로 흐름이 완성되지 않는다. 카탈로그 가져오기도 native `review_required`를 완성 단계로 읽으며 승인 decision과 결과 SHA를 확인하지 않는다. [캐릭터 검수 명세](character-photo-edit-review-spec.md), [MCP 명세](studio-api-mcp-spec.md)

조립 GLB·몸·파츠·표정·편집 값의 버전을 고정한 review record를 추가하고, 하나라도 바뀌면 새 후보를 다시 검수해야 한다. 카탈로그 공개 여부와 시각 검수 승인 여부는 별도로 보관한다.

### 월드 저장과 자동 배치 검증

Rust 월드 저장은 owner, 리비전, 봉투의 version/savedAt/domains, 크기, 에셋 URL, 주민을 검사한다. building 내부의 타일 참조·중복 ID·좌표·겹침·동선은 상세 검증하지 않는다. 따라서 모델이 반환한 JSON을 곧바로 월드 저장 API에 넣는 방식은 적합하지 않다. [homes.rs](../server/src/homes.rs#L490)

별도 계획 검증과 컴파일러를 두고, 성공한 결과만 building 공개 API로 적용한다. 기존 섬 저장의 owner·리비전 검사는 그대로 유지한다.

### 생성 기물의 배포 경로

`studio/generations`의 prop 결과와 `avatar-factory/jobs`의 캐릭터 작업은 다른 기록이다. 현재 카탈로그 가져오기 코드는 후자의 완성 캐릭터를 기대하므로 prop 생성 ID를 넣어 바로 가져올 수 없다. 현재 기물 연결은 [generate.py](../scripts/props/generate.py)와 [props-normalize.mjs](../frontend/scripts/props-normalize.mjs)를 통해 앱의 `public/gltf`를 교체하는 경로다. 새 기물을 서비스에서 수집·선택하려면 prop/GLB용 import 계약과 치수 정보를 연결해야 한다.

## 매장 자동 배치 흐름

배치 프롬프트는 [store-layout.system.txt](prompts/store-layout.system.txt), [입력 예제](prompts/store-layout.input.example.json), [출력 예제](prompts/store-layout.output.example.json), [출력 스키마](prompts/store-layout.schema.json)로 나눴다. [사용법과 예제 검사](prompts/README.md)를 함께 제공한다. 출력은 제안하는 `store-layout-v1` 계획이고, 기존 SaveBlob과 구분한다.

실행 흐름은 다음과 같다.

1. 설명, 대상 구역, 최신 카탈로그·실제 치수, 기존 배치, 비워 둘 동선, 현재 월드 리비전을 수집한다.
2. 프롬프트와 입력 JSON으로 모델에 계획만 요청한다. 모델은 업로드·에셋 생성·저장·승인을 실행하지 않는다.
3. JSON Schema와 별도 의미 검증을 실행한다. 카탈로그 ID, 타일 참조, 좌표 정렬, 높이, 회전 후 기물 면적, 벽·기존 물건·동선 충돌을 검사한다.
4. 검증된 계획을 실제 building 상태로 변환하고 평면도·3D 미리보기에서 확인한다.
5. 사용자가 적용하면 한 번의 undo 단위로 해당 구역만 갱신한다. 기존 선택·이동·회전·크기 도구로 수정한다.
6. 기존 섬 저장 API에 `expectedOwnerId`와 `baseRevision`으로 저장한다. 계획 작성 중 리비전이 바뀌었으면 재검증한다.

현재 섬의 셀은 4m, 기물 스냅은 1m다. 초기 섬 14×14의 셀 중심은 `index*4-28`이다. 캐릭터 공장의 1.2m 몸 규격과 섬 셀 크기는 다른 규격이다. 바닥 높이 `topY=0`인 얇은 기본 타일과 양수 높이의 지형 블록을 구분하고, 텍스처를 바꾸려고 바닥을 불필요하게 올리지 않는다. [village.ts](../frontend/src/minihome/village.ts), [objects.ts](../frontend/src/minihome/edit/objects.ts)

첫 범위는 단층 카페·작은 매장·사무 공간의 직사각형 구역이다. 지붕·계단·다층·복잡한 곡선 구조는 같은 계획 계약을 안정화한 뒤 확장한다. 이 범위 선택은 제안이다.

## 사진 제작과 브라우저 편집 흐름

상세 계약은 [character-photo-edit-review-spec.md](character-photo-edit-review-spec.md)에 있다. 순서는 사진 자르기·축소 → 공통 몸 선택 → 얼굴·헤어·의상 후보 생산 → 파츠별 조정 → 새 GLB 저장 → 기술 재검사 → 네 방향과 걷기 확인 → 해당 버전 승인 → 자기 캐릭터로 입기다.

회원 편집 값은 공용 파츠를 직접 덮어쓰지 않고 회원 소유의 Look 초안에 저장한다. 모자·안경 같은 고정 파츠는 부착 뼈 기준 변환으로 시작할 수 있다. 스킨이 있는 헤어·몸·의상은 화면 group의 scale만 바꿔서는 최종 조립이나 걷기와 일치하지 않으므로 rest pose, skin, inverse bind, 가림 영역을 함께 처리하는 재피팅 단계가 필요하다.

현재 소매·밑단·품 변경은 `body_shell` 의상 재생성 경로이고, 일반 캐릭터 변환 편집과는 다르다. 새 입력은 브라우저 타입, Rust `LookBody`, GLB 구움, 서버 검증, 미리보기 모두에 같은 의미로 연결해야 한다. 기존 `LookBody`에 없는 필드를 보내면 거절된다. [WardrobeShape.tsx](../frontend/src/character/studio/WardrobeShape.tsx), [looks.rs](../server/src/looks.rs#L84)

## 에셋 수집과 스타일 갱신

[asset-collection-plan-2026-10-03.md](asset-collection-plan-2026-10-03.md)와 [출처·후보 목록](asset-source-catalog-2026-10-03.json)에 기존 재사용 대상과 공식 출처를 정리했다. 출처 목록은 다운로드·리깅·품질 승인된 모델 목록이 아니다.

매장 기물은 기존 책상·의자·조명·가판대부터 재사용하고, 필요한 것이 없을 때 수집 후보를 채운다. 옷은 현재 공통 몸의 SHA·본·앵커에 맞춰야 하므로 다른 모델의 의상을 가져온 뒤 단순 크기 변경만으로 호환 판정하지 않는다. 최신 스타일은 확인 날짜와 공식 컬렉션 출처를 가진 brief로 저장하고, 브랜드 원본 이미지는 참고용 링크와 실제 재배포 에셋을 구분한다.

## API를 감싸는 MCP

상세 도구 목록과 기존 엔드포인트 대응은 [studio-api-mcp-spec.md](studio-api-mcp-spec.md)에 있다. 첫 단계는 목록·상태·가능한 action·검수 보고서를 읽는 로컬 stdio MCP다. 그다음 무료 검사 실행과 편집 작업을 기존 영수증·idempotency·리비전 계약으로 연결한다.

MCP 입력에는 캐릭터·작업·버전·산출물 ID와 제한된 편집 값만 받는다. 임의 HTTP URL·서버 파일 경로·Blender Python·셸 명령을 받는 도구를 추가하지 않는다. 원격 HTTP 공개는 회원 소유권과 권한 분리가 완성된 뒤 인증·토큰 audience·감사 기록을 기존 서비스에 연결한다.

## 구현 우선순위와 완료 기준

| 순서 | 구현 범위 | 완료를 확인할 결과 |
| --- | --- | --- |
| 1 | 회원 제작 owner와 개인 산출물 접근, 로컬 검수 action의 무료 분류, native review 저장 | 다른 회원의 사진·작업 접근 거절, 무료 검수가 유료 한도를 소비하지 않음, 수정한 버전의 옛 승인 거절 |
| 2 | 매장 계획 의미 검증과 building 컴파일러, 프롬프트 입력 생성 | 실제 카탈로그로 예제 배치, 없는 ID·겹침·동선 침범 거절, 적용 전체를 한 번에 undo, 기존 저장 충돌 처리 |
| 3 | 사진 전처리와 고정 파츠 편집 초안, 최종 GLB 반영 | 잘린 사진과 전송 사진 일치, 미리보기·저장 GLB·섬 착용 일치, 새로고침 후 초안 복원 |
| 4 | 헤어·의상·몸 재피팅과 버전별 기술·시각 재검수 | 네 방향·idle/walk에서 끼임 확인, 스킨·클립 보존, 승인된 정확한 버전을 다시 착용 |
| 5 | 제한된 MCP adapter와 에셋 수집·기물 import | 권한별 tools 목록, 같은 요청 키의 중복 실행 방지, 출처·SHA·실치수·검수 기록이 있는 에셋만 배치 |

매장 계획은 권한·검수 개선과 병행할 수 있다. 회원 사진 업로드·개인 파츠 생산은 소유권 분리 이후에 연결한다. 생성이나 모델 품질의 완료 기준을 화면 빌드 성공으로 대체하지 않는다.

## 착수 시점 로컬 검증

- npm lock 기준 설치와 uv frozen 설치 완료. lockfile 변경 없음.
- `npm run typecheck` 통과.
- `npm test` 통과: 60개 파일, 407개 테스트.
- `npm run build` 통과. 큰 3D 청크 경고는 남아 있으며, 이 결과는 실제 기기 FPS 측정이 아니다.
- `uv run --no-sync python -m compileall -q backend/src` 통과.
- `python3 docs/prompts/validate-example.py` 통과. 9개 타일·12개 벽·5개 기물의 예제에서 원본 GLB 해시·정점과 노드 변환·치수·footprint·참조·내부 충돌·통로를 검사했다. 실제 섬, 외부 접근, 서빙 모델, 렌더링, SaveBlob 크기는 미확인으로 유지한다.
- 독립 `jsonschema`의 Draft 2020-12 검사로 출력 스키마와 예제 검증, blockers가 있는 draft와 잘못된 회전의 거절을 확인했다. 프로젝트 의존성이나 lockfile에는 추가하지 않았다.
- 새 문서·JSON·예제의 상대 링크와 JSON 파싱, 중복 키·문서 공백을 확인했다.
- Python 전체 오프라인 테스트는 1129개가 수집되었고 배포 스크립트 테스트 14개가 실패했다. `--lf --tb=no` 재실행에서도 같은 14개 실패를 확인했다. PostgreSQL 기록 테스트는 로컬 DB 부재로 skip이 있다. 전체 통과로 보고하지 않는다.
- 실패 원인은 macOS 테스트 환경에서 확인했다. 8개는 기본 Bash 3.2가 `exec {lock_fd}>`를 지원하지 않는 문제이고, idle 로그 축소 2개는 GNU `stat -c`·`touch -d`와 BSD 도구 차이다. Rust 배포 모의 테스트 4개는 임시 경로 `/private/var/...`를 순차 문자열 치환하면서 삽입한 경로를 다시 치환해 `/private/private/...`로 만든다. 이 4개는 `/var/`가 없는 별도 로컬 `--basetemp`에서 모두 통과했다. 나머지 10개는 해결하지 않았으며, Linux 배포 동작의 실패로 단정하지 않는다. 테스트 harness의 OS/도구 조건과 경로 치환을 개선할 항목이다. [infra/conftest.py](../backend/tests/infra/conftest.py), [test_deploy_on_instance.py](../backend/tests/infra/test_deploy_on_instance.py), [test_rust_server_deploy.py](../backend/tests/infra/test_rust_server_deploy.py)
- Rust 전체 검사와 캐릭터 브라우저 E2E는 실행하지 못했다. 현재 Rust는 1.84.1로 프로젝트의 1.95 요구보다 낮고, Docker daemon과 로컬 PostgreSQL 55432가 동작하지 않는다. 과거 CI 통과 기록을 이번 로컬 검사 결과로 인용하지 않는다.
- 실제 이미지·3D 유료 생성, 사진 입력에 대한 시각 품질 승인, 운영 API 변경·업로드·푸시·배포는 수행하지 않았다.
