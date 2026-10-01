# 캐릭터 서버

3D SD 캐릭터의 몸·헤어·의상·장비를 만들고 조립하는 FastAPI 서버와 CLI입니다(`src/`, 테스트 `tests/`, DB migration `migrations/`). 작업 화면은 앱의 `/admin/studio`(옷장은 `/character`, 코드는 `frontend/src/character/`)에 있고, 앱은 Rust 서버의 스튜디오 게이트웨이를 거쳐 이 서버를 부릅니다. 운영 지침은 [AGENTS.md](AGENTS.md)에 있습니다.

## 캐릭터 만들기

저장소 루트에서 `npm run dev:character`로 띄우고(비용이 드는 작업은 `scripts/dev.ps1 -Character -Paid`) 관리자로 **http://127.0.0.1:5180/admin/studio** 를 엽니다. 첫 화면은 **캐릭터 › 사진으로 전체 생성**입니다.

1. 사진을 올리고 생성 버튼을 누릅니다. 공통 기본 몸이 지정돼 있으면 그 몸에 사진의 파츠를 입히고, 없으면 사진에서 새 몸을 만듭니다. 버튼 아래에 유료 이미지 수와 3D 생성 수가 표시됩니다.
2. 공통 규격 원본 → 파츠 이미지 → 3D 파츠 → 리깅·동작 → 피팅·조립 → 기본 표정 순서로 자동 진행됩니다.
3. 실패한 이미지는 **실패한 이미지 재요청**, 실패한 3D 파츠·리깅·표정은 **단계부터 실행**으로 다시 요청합니다. 둘 다 유료입니다.

파츠를 하나씩 바꾸거나 더하려면 **캐릭터 › 파츠**에서 기준을 고릅니다. 기준으로 이전 파츠 결과를 고르면 그 결과의 파츠를 유지한 채 새 파츠를 더합니다.

### 파츠 만드는 방식

기본 몸이 있는 요청은 파츠마다 방식을 정하고, 방식과 3D 공급자는 요청을 받을 때 고정됩니다.

| 방식 | 기본 적용 | 만드는 법 |
|---|---|---|
| `worn` | 머리·상의·하의 | 키 색 마네킹에 입힌 그림으로 3D를 만든 뒤, 기본 몸에 정합하고 키 색 몸 부분을 지웁니다. 머리는 머리 뼈, 치마는 골반 뼈에 붙이고 다른 옷은 몸 가중치를 옮깁니다. |
| `body_shell` | 선택 | 고정된 몸 렌더 위에 그린 옷 그림을 몸 표면에 투영해 옷 메시를 만듭니다. 3D 생성 요청이 없습니다. 몸에 붙는 옷용이며, 가랑이 아래로 내려오는 상의·부피 큰 옷·후드는 만들지 못하고 기본 몸 표면이 깨져 있으면 그대로 따라갑니다. |
| `isolated` | 모자·신발·장비 | 파츠 단독 그림으로 3D를 만들고 몸에 맞춥니다. 기본 몸이 없는 사진 생성도 이 방식입니다. |

**몸에 맞춰 다시 만들기**는 저장된 그림으로 상의·하의를 `body_shell`로 다시 만듭니다. 유료 요청이 없습니다.

### 자동 재시도와 재개

- 업로드 직후 응답 없이 끊긴 이미지 요청과 `429`·`503` 응답은 같은 요청을 최대 2회 다시 보냅니다. 각 시도는 요청 영수증의 `auto_retries`에 남습니다.
- 3D 공급자가 받지 않은 요청(연결 실패, `429`·`503`)은 파츠마다 최대 3회 다시 제출합니다. 이전 시도는 `parts/<slot>/attempts/`에 보존합니다.
- 이미 접수된 작업을 묻는 상태 조회(GET)는 `429`·`5xx`·연결 오류에 1·2·4초 간격으로 최대 4번 시도합니다. POST는 다시 보내지 않습니다. 그래도 조회나 모델 받기가 실패하면 작업은 `provider_poll_failed`·`download_failed`로 멈추고 저장된 작업 ID는 그대로라서, 새 요청 없이 이어서 조회할 수 있습니다.
- 서버가 다시 시작돼도 멈춘 단계를 이어가지 않습니다. `ASSET_AUTO_RESUME`을 `1`(`true`·`yes`도 같음)로 켠 서버만 시작할 때 한 번 훑어 이어가며, 조회(GET)는 이어가기를 시작하지 않습니다. 이어가기는 시도한 적 없는 유료 요청을 보낼 수 있어 기본이 꺼짐입니다. 접수 여부를 확인할 수 없는 유료 요청은 다시 보내지 않고 재요청 버튼으로 남깁니다.
- `scripts/dev.ps1`과 `scripts/props/generate.py`는 `ASSET_AUTO_RESUME=0`으로 띄우고, `dev.ps1`은 포트에 이미 떠 있는 서버를 건드리지 않습니다.

## 시작하기

Python 3.11과 [uv](https://docs.astral.sh/uv/)를 사용합니다. `backend/.env.example`을 `backend/.env`로 복사하고 키를 채웁니다. 캐릭터 생성에는 `OPENAI_API_KEY`와 `MESHY_API_KEY`(Tripo는 `TRIPO_API_KEY`를 더합니다), `ASSET_S3_BUCKET`과 Blender가 필요합니다. 설치는 저장소 루트에서 `uv sync`(루트 uv 워크스페이스의 멤버가 이 폴더)입니다.

`npm run dev:character`가 이 서버(`127.0.0.1:8016`)를 Rust 서버·앱과 함께 띄우고 `backend/.env`의 API 키와 JWT 설정을 게이트웨이에 넘깁니다. 이 서버만 띄울 때는 루트에서 `uv run asset-api`(기본 `API_PORT=8000`)입니다. 로컬 서버는 loopback 전용이고 제어 서버는 단일 worker로 실행합니다. 상태 확인 경로는 `/health`와 `/api/health`입니다.

API는 JWT(`Authorization: Bearer`, 발급자 `mogaesup`, 대상 `mogaesup-client`)로 인증하고, loopback에서 온 `X-User-Id` 헤더는 그 ID의 운영자로 받아들입니다(로컬 개발, `scripts/props/generate.py`). AWS 컨테이너는 JWT를 쓰지 않습니다. nginx가 모든 `/api` 요청에 `X-User-Id: 1`을 붙여 loopback으로 넘기므로 80 포트까지 닿는 요청은 운영자로 처리되고, 그 앞을 CloudFront 게이트와 `STUDIO_GATEWAY_KEY`가 막습니다(아래 "AWS 배포").

## API 범위

앱은 Rust 서버의 스튜디오 게이트웨이(`server/src/factory.rs`)를 거쳐서만 이 서버를 부릅니다.

- `/api/avatar-factory/*`, `/api/studio/*`, `/api/avatar-blueprints/*`, `/api/characters/*`: 스튜디오 화면(`frontend/src/character/`)이 쓰는 API입니다. 게이트웨이가 같은 경로로 받아 권한과 유료 한도를 확인한 뒤 운영자로 서명해 넘깁니다.
- 완성 캐릭터 목록과 카탈로그 가져오기(`server/src/studio.rs`, `server/src/imports.rs`)는 Rust 서버가 `/api/avatar-factory/jobs*`, `/api/studio/catalog`, `/api/studio/bodies/*`와 조립 모델·썸네일을 직접 읽습니다. 브라우저는 모델·썸네일을 관리자용 `/api/factory/*`(이 서버의 `/api/*`로 전달)로 받습니다.
- `scripts/props/generate.py`는 이 서버를 따로 띄우고 `/api/studio/generations*`를 직접 부릅니다.
- 상태 확인은 `/health`, `/api/health`입니다.

Swagger UI는 `/docs`, OpenAPI 문서는 `/openapi.json`에서 확인할 수 있습니다.

## 구성

- 캐릭터 공장 저장소: `ASSET_S3_BUCKET`, `ASSET_S3_REGION=ap-northeast-2`, `ASSET_S3_PREFIX=assets`, 선택 `ASSET_AWS_PROFILE`. 원본·파츠·생성 응답·작업 기록·GLB는 비공개 S3에 저장합니다. 다운로드는 인증 API가 소유권을 확인한 뒤 15분 서명 URL로 전달합니다. 기존 `data/` 자료는 읽기 호환용으로 보존합니다.
- 이미지 생성: `OPENAI_API_KEY`, `AVATAR_IMAGE_MODEL=gpt-image-2.5-sunburst`. TLS 1.3 연결이 끊기는 환경은 `AVATAR_IMAGE_TLS_MAX_VERSION=1.2`를 사용합니다.
- 캐릭터 공장 3D 공급자: `AVATAR_3D_PROVIDER=meshy|tripo`(기본 meshy). Tripo는 `TRIPO_API_KEY`, 선택 `TRIPO_API_BASE_URL`, `TRIPO_MODEL_VERSION`(기본 `v3.1-20260211`). 키가 둘 다 있으면 파츠 화면에서 요청마다 고릅니다.
- `BLENDER_CONCURRENCY`(기본 2): 동시에 실행하는 Blender 피팅 수. vCPU 2개당 1이 기준입니다.
- `ASSET_DETAIL_RENDERS=1`은 파츠별 상세 렌더를, `ASSET_SAVE_MASTER_BLEND=1`은 조립 `master.blend`를 추가로 저장합니다. 기본은 둘 다 끔입니다.
- `CHARACTER_DATABASE_URL`: 작업·캐릭터·생성·설계도 기록과 요청 영수증(저장 이름공간의 `.json`)을 S3 대신 PostgreSQL에 둡니다. 아래 "기록 데이터베이스"를 보세요.
- `ASSET_DATA_ROOT`는 기본 루트 `backend/data/`를, `CHARACTER_OWNER_ID`는 기존 manifest 소유자(기본 1)를, `BLENDER_EXECUTABLE`은 Blender 경로를 지정합니다. 미지정 시 PATH와 Windows 기본 설치 위치를 탐색합니다.

## 기록 데이터베이스

`CHARACTER_DATABASE_URL`이 있으면 `avatar-factory/`, `avatar-blueprints/`, `characters/` 아래의 `.json` 기록은 `character_records.records`에 저장 접두사(`ASSET_S3_PREFIX`)와 데이터 루트 기준 경로로 들어갑니다. 행은 서버가 쓴 바이트를 그대로 담아 해시가 S3 시절과 같고, JSON이면 `doc`(jsonb)으로도 조회할 수 있습니다(`character_records.jobs` 뷰). GLB·PNG·blend 같은 산출물은 그대로 S3에 둡니다. 1 MiB를 넘는 기록(이미지 응답 영수증)은 바이트를 S3 `<접두사>/record-blobs/<sha256>.json`에 두고 행이 가리킵니다. 변수가 비어 있으면 모든 기록을 예전처럼 S3에 둡니다.

전환은 서버를 멈춘 상태에서 합니다. 가져오기는 기록 JSON을 S3에서 지우거나 고치지 않고, 같은 행은 건너뛰며, 가져온 뒤 데이터베이스에서 바뀐 행은 덮어쓰지 않고(실행 중에 서버가 바꾼 행도 같은 조건으로 건너뜁니다) 차이로 보고합니다. 가져오지 않은 접두사의 기록은 빈 목록으로 보이지 않고 거부됩니다.

가져오기를 마치면 S3에 표식 `<접두사>/.records-in-database`를 남깁니다. 기록이 데이터베이스에 있는 접두사인데 `CHARACTER_DATABASE_URL`이 없는 서버(예: 설정을 잃은 교체 인스턴스)는 예전 S3 기록을 조용히 읽고 쓰지 않고 시작할 때 거부합니다. `status`가 표식 유무를 보여 주고 `export`가 표식을 지웁니다. 이 보호는 표식이 생긴 뒤부터 작동하므로 운영 접두사(`assets`)는 한 번 `import --prefix assets`를 돌려야 하고, 이미 가져온 접두사라면 같은 행을 건너뛰어 안전하게 반복됩니다.

```bash
uv run python -m src.records migrate                      # 스키마(backend/migrations) 적용, 반복 실행 가능
uv run python -m src.records import --prefix assets --dry-run
uv run python -m src.records import --prefix assets
uv run python -m src.records status
```

되돌릴 때는 서버를 멈추고 `uv run python -m src.records export --prefix assets`로 전환 뒤 생기거나 바뀐 기록을 S3에 다시 쓴 다음 `CHARACTER_DATABASE_URL`을 비웁니다. 운영 컨테이너는 이 값을 provider secret(JSON)과 같은 형식의 `/run/studio-secrets.json`으로 받습니다. `deploy-on-instance.sh`가 `/etc/asset-studio.env`의 `CHARACTER_DB_SECRET_ARN`·`CHARACTER_DB_HOST`로 배포마다 URL을 만들어 넣고, 스택 파라미터 `CharacterDbSecretArn`·`CharacterDbHost`(서버 스택의 `CharacterDatabaseSecretArn`·`DatabaseEndpoint` 출력)가 그 두 줄을 씁니다. 둘 다 비우면(기본) 기록은 S3에 남습니다. `backend/infra/records-to-postgres.py`가 옮긴 뒤에는 스택에도 같은 두 값을 넣어 두어야 인스턴스가 교체돼도 데이터베이스로 올라옵니다. `scripts/dev.ps1 -Character`는 compose PostgreSQL(127.0.0.1:55432)에 `mogaesup_character`를 만들고 스키마를 적용해 이 서버에만 넘깁니다.

## 빌드

```bash
uv build --package asset-3d-api
docker build -f backend/Dockerfile -t asset-3d-api .
docker run --rm -p 8000:8000 --env-file backend/.env -e API_HOST=0.0.0.0 asset-3d-api
```


## 조립 결과 비교

```bash
uv run asset-quality <조립 폴더> [<조립 폴더> ...] [--images views.json --canvas canvas.json]
```

조립 폴더는 `body.glb`와 피팅된 파츠 GLB가 있는 저장 버전(`native-parts/<version>`)입니다. 뒷머리 덮임 비율, 옷의 몸 관통 비율, 파츠별 삼각형 수를 출력하고, `--images`(`{slot: {view: 캔버스 PNG}}`)와 `--canvas`를 주면 파츠 그림과의 실루엣 IoU를 더합니다. 방식·공급자 비교용이며 작업 결과를 막지 않습니다.

## AWS 배포

`infra/ec2.yaml` 스택(`gaesup-asset-studio`)의 컨테이너는 이 서버의 API만 냅니다(화면은 앱의 `/admin/studio`·`/character`). 릴리스는 `infra/prepare-aws.ps1 -Upload`가 인스턴스 스크립트가 기대하는 배치(`backend/`, `infra/`, 루트의 uv 워크스페이스 파일)로 묶어 S3에 올리고, `infra/deploy-aws.ps1`이 SSM으로 인스턴스에 배포합니다. 기본은 SSM 포트 포워딩(`Access` 출력)으로만 접속합니다. 앱 서버가 인터넷으로 부르려면:

1. provider secret(JSON)에 `OPENAI_API_KEY`와 `MESHY_API_KEY`가 둘 다 있어야 컨테이너가 시작합니다. 선택 키: `TRIPO_API_KEY`, `AVATAR_3D_PROVIDER`, `BLENDER_CONCURRENCY`, `STUDIO_GATEWAY_KEY`(아래).
2. 리전의 CloudFront 관리형 prefix list ID를 확인합니다.
   ```bash
   aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing --query "PrefixLists[0].PrefixListId" --output text
   ```
3. 스택 파라미터 `PublicStudio=true`, `CloudFrontPrefixListId=<위 값>`, `InstanceType=c7i.xlarge`로 배포합니다.

`StudioUrl` 출력(`https://….cloudfront.net`)이 Rust 서버의 `FACTORY_URL`입니다. 80 포트의 보안 그룹은 CloudFront 관리형 prefix list 전체를 받으므로 어느 계정의 CloudFront 배포든 닿을 수 있고, nginx는 닿은 `/api` 요청을 운영자(user 1)로 처리합니다. 막는 것은 둘입니다.

- CloudFront Function(`server/scripts/lock-studio.py`)은 서버가 보내는 `x-gateway-key`나 주인 IP만 통과시킵니다. 스택 밖에서 붙이므로 스택을 다시 배포하면 떨어지고, 그때마다 스크립트를 다시 실행합니다.
- `STUDIO_GATEWAY_KEY`: provider secret(JSON)에 서버 스택 `FactoryGatewaySecret`의 값(서버의 `FACTORY_GATEWAY_KEY`와 같은 값)을 넣으면 컨테이너가 80 포트의 `/api`를 `x-gateway-key`가 같은 요청에만 열고 나머지는 403으로 답합니다. 함수가 떨어져도 남는 검사입니다. 키는 `A-Z a-z 0-9 . _ ~ -` 16자 이상이어야 하고(아니면 컨테이너가 시작하지 않습니다) 로그에 남기지 않습니다. 키 없이 `PublicStudio=true`로 뜨면 시작할 때 경고 한 줄이 컨테이너 로그에 남습니다. SSM 포트 포워딩(8080)은 키를 묻지 않습니다. 키가 있으면 `lock-studio.py --allow-ip`의 주인 IP로 CloudFront 주소를 직접 부르는 요청도 nginx에서 403이 되므로 그때는 8080을 씁니다.

실행 중인 컨테이너는 다음 배포 때 secret을 다시 읽습니다.

### 배포와 갱신

`deploy-on-instance.sh`는 실행 중인 릴리스가 `/api/health`에서 유료 요청과 실행 중 작업이 0이라고 답할 때만 컨테이너를 바꿉니다. `ASSET_DEPLOY_DRAIN_SECONDS`(기본 420)초 안에 비지 않으면 종료 코드 4로 멈춥니다. 상태를 읽을 수 없으면 진행 중인 유료 단계를 끊을 수 있으므로 종료 코드 5로 멈추고, 그래도 바꾸려면 `deploy-aws.ps1 -AllowUnknownDrain`(인스턴스에서는 `ALLOW_UNKNOWN_DRAIN=1`)을 씁니다. 컨테이너 로그는 `json-file` 50 MB 3개로 돌립니다.

스택(`ec2.yaml`)을 갱신하기 전에 변경 세트에서 `Instance`가 교체(Replacement `True`)되지 않는지 봅니다. `ImageId`는 갱신할 때마다 최신 AL2023으로 다시 풀려, 새 이미지가 나왔으면 인스턴스가 교체됩니다(고정하는 방법은 템플릿의 `ImageId` 주석). 교체된 인스턴스는 `CharacterDbSecretArn`·`CharacterDbHost`가 비어 있으면 S3 기록으로 올라옵니다. 역할은 `assets/*`에서 읽기·쓰기·삭제를 합니다(버킷은 버전 관리).

### 쉬면 끄기

인스턴스는 2시간 동안 요청이 없으면 스스로 꺼지고(`systemctl poweroff`, EBS라 중지되며 Elastic IP는 남습니다), 앱 서버가 다음 스튜디오 요청 때 켭니다(`STUDIO_INSTANCE_ID`, `server/src/studio_power.rs`). `infra/idle-stop.sh`를 `asset-studio-idle.timer`가 5분마다 돌리고, 판단은 `journalctl -u asset-studio-idle`에 남습니다. 켠 지 30분 안, 배포 중, `/api/health`의 `paid_requests`·`running_tasks`가 0이 아니거나 읽히지 않으면 끄지 않습니다. 쉰 시간은 nginx가 남긴 마지막 요청(`/var/log/asset-studio/activity.log`, 상태 확인·`version.json` 제외), 마지막으로 일을 본 때, 컨테이너 시작, 부팅 중 늦은 것부터 잽니다. `deploy-on-instance.sh`가 배포마다 설치·갱신하며, 배포 없이 한 번 설치하려면 SSM으로 스크립트를 보내 `bash idle-stop.sh install`을 실행합니다. 설정은 `/etc/asset-studio-idle.env`(`IDLE_STOP_MINUTES=120`, `IDLE_BOOT_GRACE_MINUTES=30`, 계속 켜 두려면 `IDLE_STOP=off`)입니다.
