# 모개숲

[gaesup-world](https://github.com/jigglypop/gaesup-world)의 예제 섬 "모개숲"을 서비스로 만든 통합 레포입니다. 운영 주소: https://mogaesup.com

## 구조

| 폴더 | 역할 |
| --- | --- |
| `frontend/` | 프론트엔드 하나. React 19 + Vite 8, 3D 섬은 npm의 `gaesup-world`로 그린다. 글래스 디자인(`--mg-*` 토큰)으로 로그인·가입, 섬(`/@아이디`)과 꾸미기(`/@아이디/edit`), 둘러보기, 운영(`/admin`), 캐릭터 스튜디오(`/studio`, 화면은 `src/character/`) |
| `server/` | 웹서버. Rust(axum + sqlx) + PostgreSQL. 회원과 세션 쿠키, 섬 프로필·섬 저장(리비전)·방문자, 방명록·이웃(API 이름은 ilchon), 미니미 카탈로그와 캐릭터 가져오기, 캐릭터 스튜디오 API 중계(권한·유료 한도·기록), 실시간 방(WebSocket, gaesup-world 멀티플레이 프로토콜) |
| `backend/` | 캐릭터 서버. Python(FastAPI) + Blender. 캐릭터 몸·파츠·의상·기물의 이미지·3D 생성, 리깅, 조립, 검수. AWS 스튜디오 배포는 `backend/infra/`. 자세한 것은 [backend/README.md](backend/README.md) |
| `scripts/` | 루트 기동(`dev.ps1`)과 섬 기물 생성(`props/`) |

엔진인 gaesup-world는 이 레포에 넣지 않고 npm 패키지로 받는다. 엔진을 고치면 gaesup-world 레포의 `main`에 올리고, CI가 새 버전을 npm에 낸 뒤 `frontend/`에서 버전을 올린다.

의존성은 루트에서 한 번에 받는다. `npm install`이 npm 워크스페이스(`frontend`)의 `node_modules`를, `uv sync`가 uv 워크스페이스(멤버 `backend`)의 `.venv`를 만든다.

## 로컬 실행

1. 설치: 루트에서 `npm install`과 `uv sync`.
2. 기동: `npm run dev`(= `scripts/dev.ps1`). Docker PostgreSQL(127.0.0.1:55432)과 Rust 서버(`127.0.0.1:8080`), 웹(`http://127.0.0.1:5180`, `/api`와 WebSocket을 8080으로 넘긴다)을 숨은 프로세스로 띄우고 로그는 `.data/dev/`에 둔다. 이미 떠 있는 포트는 그대로 쓴다. `npm run dev:stop`이 이 스크립트가 띄운 것을 끈다.
3. 캐릭터 파이프라인까지: `npm run dev:character`. 캐릭터 서버를 루트 `.venv`로 `127.0.0.1:8016`에 띄우고(멈춘 유료 단계 자동 재개는 끈다), `backend/.env`(`backend/.env.example`에서 만든다)의 API 키와 JWT 설정을 Rust 서버의 스튜디오 게이트웨이에 넘겨 `/admin` 가져오기와 `/studio`가 끝까지 돈다. 관리자는 기록을 바꿀 수 있고(`FACTORY_ACCESS=write`), 비용이 드는 작업은 `scripts/dev.ps1 -Character -Paid`(월 `-PaidMonthly`건)일 때만 열린다. `.env`는 운영 키이니 필요할 때만 쓴다.
4. 관리자: 서버를 `BOOTSTRAP_ADMIN_USERNAME`·`BOOTSTRAP_ADMIN_PASSWORD`와 함께 띄우면 그 계정을 만들거나 관리자로 올린다. 설정 목록은 `server/.env.example`에 있다.
5. 섬 기물 다시 만들기(유료): `uv run python scripts/props/generate.py --only <id>`로 하나씩 확인한 뒤 `--all`, 그다음 `node frontend/scripts/props-normalize.mjs`가 크기·방향·무광 재질을 섬에 맞춰 `frontend/public/gltf/`에 넣는다(패키지의 같은 경로 모델을 대신한다).

## 캐릭터 스튜디오

`/studio`는 캐릭터 스튜디오 화면(`frontend/src/character/`)을 앱의 경로 아래에 띄운다(`frontend/src/studio/StudioPage.tsx`). 스튜디오 스타일시트는 한 페이지짜리로 쓰였으므로 `.studio-root` 안으로 가둔다(`frontend/vite/studio.ts`). 화면이 부르는 `/api/avatar-factory`·`/api/studio`·`/api/avatar-blueprints`·`/api/characters`는 서버가 받아 권한을 본 뒤 캐릭터 서버로 넘긴다. 회원은 옷장 읽기(`wardrobe/*`, 파츠 GLB)만, 나머지는 관리자만 쓴다. `FACTORY_ACCESS`가 `read`(기본)면 읽기만, `write`면 기록 변경까지, `paid`면 비용이 드는 작업까지 열고, 유료는 `FACTORY_PAID_MONTHLY` 한도 안에서만 통과한다. 알려진 업로드·선택 외의 POST는 유료로 본다. 바꾸는 요청은 `factory_requests`에 남는다.

## 캐릭터 가져오기

`/admin`은 캐릭터 서버의 완성 캐릭터를 스튜디오와 같은 기준으로 보여 준다: 봉인된 `character_parts` 조립본, 캐릭터(`character_id`)마다 가장 최근 작업, 삭제·보관한 것 제외. 카탈로그 항목은 캐릭터로 짝지어서, 같은 캐릭터를 새 작업으로 다시 만들면 새 항목이 아니라 그 항목의 새 버전이 된다. 작업·조립본·고른 표정·단계 중 하나라도 바뀌면 "새 버전 있음"과 그 이유가 뜬다.

가져오기는 백그라운드 작업이다. `POST /api/catalog/admin/import`가 바로 202와 가져오기 id를 돌려주고(동시에 2개), 서버가 작업 확인 → 모델 받기 → 검사 → 텍스처 줄이기(색상 1024px, 그 밖 512px, 불투명 맵은 JPEG) → 저장 → 대표 그림 → 카탈로그 반영을 차례로 하며 단계와 진행률을 `catalog_imports`에 남긴다. 검사는 끝까지 모아 보고서(스킨·관절, 빠진 클립과 모든 애니메이션, 삼각형·정점 수, 텍스처와 파일 크기 전후, 높이, 대표 그림)로 남기고, GLB가 아니거나 SHA-256이 다르거나 미니미에 스킨·`idle`·`walk`가 없을 때만 실패한다. 서버가 다시 뜨면 끝나지 않은 가져오기는 중단으로 표시된다.

모델은 `MODEL_STORE`에 해시 이름으로 저장하고 지우지 않는다(운영은 웹 버킷의 `models/`, CloudFront `/models/*` 1년 불변 캐시). 항목마다 버전(`catalog_versions`)이 쌓이고 관리 화면에서 되돌릴 수 있다. 다시 가져와도 공개 상태·이름·이모지·순서는 그대로다. 처음 가져온 항목은 초안이고, 공개하면 미니미 목록에 나온다. 섬 주인은 공개된 미니미나 기본 미니미만 고를 수 있다.

## 검증

- 서버: `cd server && docker compose up -d --wait && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`. 테스트는 실제 PostgreSQL에 임시 DB를 만들어 돌고, 운영자 토큰이 캐릭터 서버의 `auth.py`(`backend/src`)를 통과하는지도 확인한다(`uv`가 있을 때).
- 캐릭터 서버: `uv run python -m compileall -q backend/src`. 테스트(`uv run pytest`)는 외부 API·Blender·DB를 대체한 것만 돈다.
- 웹: `npm run typecheck && npm test && npm run build`(루트). 서버와 `npm run dev`가 떠 있으면 `npm run smoke`가 Chromium으로 가입부터 꾸미기 저장·방문·실시간 방·방명록·이웃까지 확인한다.
- 캐릭터: `npm run test:character`(루트)가 `server/`를 빌드해 임시 DB와 가짜 캐릭터 서버(`frontend/scripts/e2e/`)로 띄우고 웹 개발 서버와 함께 빈 포트에서 Chrome(WebGPU)으로 확인한다: 관리자가 완성 캐릭터를 가져와 검사·공개하고 스튜디오 화면을 열며, 새 회원이 그 미니미로 섬을 걷고 옷장만 보고, 다시 가져오면 공개 그대로 새 버전이 되며, `walk`가 없는 캐릭터는 이유와 함께 실패한다. 로컬 PostgreSQL(55432)과 cargo만 있으면 되고 비용이 들지 않으며, 끝나면 띄운 것과 DB를 지운다. 스크린샷은 인자로 준 폴더(기본 `.data/character-e2e`)에 남긴다.
- 성능: 서버와 `npx vite preview`(빌드본)가 떠 있으면 `npm run perf`가 이 PC의 GPU(Chrome, WebGPU, vsync 끔)로 섬 로딩 시간·전송량·서 있을 때와 걸을 때의 프레임·메인 스레드 상위 함수를 잰다. 대상 서버에 측정용 계정을 하나 만든다.
- 빌드는 패키지의 캐릭터 GLB(`gltf/*.glb`) 텍스처를 섬 카메라에 맞게 줄인다(색상 1024px, 그 밖 512px, WebP). 원본은 패키지에 그대로 있다.

## 배포 (AWS 서울 리전)

CloudFront(mogaesup.com, www는 apex로 이동)가 정적 파일은 비공개 S3에서, `/api/*`(WebSocket 포함)는 VPC origin으로 EC2의 Rust 서버에서 받는다. 서버는 비공개 RDS PostgreSQL 17을 쓰고 인터넷에 직접 열려 있지 않다.

1. 리눅스 바이너리: `server`에서 `docker run --rm -e "RUSTFLAGS=-C target-feature=+crt-static" -e CARGO_TARGET_DIR=/src/target -v ${PWD}:/src -w /src rust:1-alpine sh -c "apk add --no-cache musl-dev && cargo build --release --locked --target x86_64-unknown-linux-musl"`
2. 서버: `python server/scripts/deploy-rust-server.py --factory-url <캐릭터 서버 주소> --factory-access write`. 스택(`mogaesup-server`)을 맞추고, S3와 SSM으로 바이너리를 올려 체크섬을 확인한 뒤 systemd로 띄운다. 비밀값은 개발 PC로 가져오지 않는다. 스택의 `FactoryGatewaySecret`이 `FACTORY_GATEWAY_KEY`로 들어가 캐릭터 서버 요청마다 `x-gateway-key`로 실린다. 캐릭터 서버 인스턴스는 쉬면 스스로 꺼지므로, 처음 한 번 `--studio-instance-id <인스턴스 ID>`를 주면 스택(`StudioInstanceId`)이 기억하고 서버 역할에 그 인스턴스만 켤 권한(`ec2:StartInstances`)을 준다. 서버는 닿지 않는 스튜디오 요청에 인스턴스를 켜고 켜질 때까지 503 `studio_waking`으로 답하며, 관리자는 `/api/catalog/admin/studio-power`로 상태를 보고 켠다.
3. 웹: `frontend/scripts/deploy-aws.ps1`. 스택(`mogaesup-web`)을 맞추고 빌드·업로드·무효화한 뒤 운영 주소의 `index.html`과 `/api/health`를 확인한다.
4. 캐릭터 서버: `backend/infra/prepare-aws.ps1 -Upload` 뒤 `backend/infra/deploy-aws.ps1`(자세한 것은 `backend/README.md`). 컨테이너는 API만 낸다.
5. 스튜디오 잠금: `python server/scripts/lock-studio.py --allow-ip <주인 IP>`. 캐릭터 스튜디오의 CloudFront에 함수를 붙여 게이트웨이 키를 가진 이 서버와 적은 IP만 통과시킨다(`--unlock`으로 뗀다). 스튜디오 스택(`gaesup-asset-studio`)을 다시 배포하면 떨어지니 그 뒤에 다시 돌린다.
