# 모개숲

[gaesup-world](https://github.com/jigglypop/gaesup-world)의 예제 미니홈피 "모개숲"을 서비스로 만든 통합 레포입니다. 운영 주소: https://mogaesup.com

## 구조

| 폴더 | 역할 |
| --- | --- |
| `web/` | 프론트엔드. React 19 + Vite 8, 3D 섬은 npm의 `gaesup-world`로 그린다. 로그인·가입, 미니홈피(`/@아이디`), 둘러보기, 관리(`/admin`) |
| `server/` | 웹서버. Rust(axum + sqlx) + PostgreSQL. 회원과 세션 쿠키, 미니홈피 프로필·섬 저장(리비전)·방문자, 방명록·일촌, 미니미 카탈로그와 캐릭터 가져오기, 캐릭터 서버 프록시, 실시간 방(WebSocket, gaesup-world 멀티플레이 프로토콜) |
| `gaesup-character/` | 캐릭터 서버(관리자용 에셋 생성·캐릭터 커스텀). [별도 레포](https://github.com/jigglypop/gaesup-character)를 서브모듈로 연결한다 |

엔진인 gaesup-world는 이 레포에 넣지 않고 npm 패키지로 받는다. 엔진을 고치면 gaesup-world 레포의 `main`에 올리고, CI가 새 버전을 npm에 낸 뒤 `web/`에서 버전을 올린다.

```
git clone --recurse-submodules https://github.com/jigglypop/mogaesup.git
```

## 로컬 실행

1. 서버: `server/scripts/start-rust-server.ps1`. Docker로 PostgreSQL(127.0.0.1:55432)을 띄우고 `127.0.0.1:8080`에서 돈다. 설정 목록은 `server/.env.example`에 있다.
2. 웹: `cd web && npm install && npm run dev`. `http://127.0.0.1:5180`에서 열리고 `/api`(WebSocket 포함)를 8080으로 넘긴다.
3. 관리자: 서버를 `BOOTSTRAP_ADMIN_USERNAME`·`BOOTSTRAP_ADMIN_PASSWORD`와 함께 띄우면 그 계정을 만들거나 관리자로 올린다. `/admin`에서 캐릭터 서버의 완성 캐릭터를 가져오려면 `-FactoryUrl`로 캐릭터 서버 주소를 준다.

## 캐릭터 가져오기

`/admin`은 캐릭터 서버(gaesup-character)의 완성 캐릭터를 스튜디오와 같은 기준으로 보여 준다: 봉인된 `character_parts` 조립본, 캐릭터마다 가장 최근 작업, 삭제·보관한 것 제외. 가져오면 서버가 표정이 구워진 사본(없으면 기본 조립본)을 받아 캐릭터 서버 기록의 SHA-256과 대조하고, 스킨과 `idle`·`walk` 클립을 확인한 뒤 텍스처를 웹용으로 줄여(색상 1024px, 그 밖 512px, 불투명 맵은 JPEG) `MODEL_STORE`에 해시 이름으로 저장한다. 운영에서는 웹 버킷의 `models/`이고 CloudFront가 `/models/*`로 1년 불변 캐시로 내준다. 초안으로 들어오니 확인한 뒤 공개하면 미니미 목록에 나온다.

## 검증

- 서버: `cd server && docker compose up -d --wait && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`. 테스트는 실제 PostgreSQL에 임시 DB를 만들어 돌고, 운영자 토큰이 gaesup-character의 `auth.py`를 통과하는지도 확인한다(`uv`가 있을 때).
- 웹: `cd web && npm run typecheck && npm test && npm run build`. 서버와 `npm run dev`가 떠 있으면 `npm run smoke`가 Chromium으로 가입부터 방문·실시간 방·방명록·일촌까지 확인한다.

## 배포 (AWS 서울 리전)

CloudFront(mogaesup.com, www는 apex로 이동)가 정적 파일은 비공개 S3에서, `/api/*`(WebSocket 포함)는 VPC origin으로 EC2의 Rust 서버에서 받는다. 서버는 비공개 RDS PostgreSQL 17을 쓰고 인터넷에 직접 열려 있지 않다.

1. 리눅스 바이너리: `server`에서 `docker run --rm -e "RUSTFLAGS=-C target-feature=+crt-static" -e CARGO_TARGET_DIR=/src/target -v ${PWD}:/src -w /src rust:1-alpine sh -c "apk add --no-cache musl-dev && cargo build --release --locked --target x86_64-unknown-linux-musl"`
2. 서버: `python server/scripts/deploy-rust-server.py --factory-url <캐릭터 서버 주소>`. 스택(`mogaesup-server`)을 맞추고, S3와 SSM으로 바이너리를 올려 체크섬을 확인한 뒤 systemd로 띄운다. 비밀값은 개발 PC로 가져오지 않는다.
3. 웹: `web/scripts/deploy-aws.ps1 -FactoryUiUrl <캐릭터 서버 주소>`. 스택(`mogaesup-web`)을 맞추고 빌드·업로드·무효화한 뒤 운영 주소의 `index.html`과 `/api/health`를 확인한다.
