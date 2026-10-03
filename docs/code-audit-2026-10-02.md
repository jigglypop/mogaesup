# 모개숲 코드 감사와 수정 결과

2026년 10월 2일, main의 e8b476b와 기존 작업 폴더 변경을 기준으로 웹·Rust 서버·캐릭터 서버·DB·실시간 방·캐릭터 산출물·배포 경로를 검토했다. 이 문서는 최초 감사에서 찾은 결함과 후속 수정·검증을 함께 기록한다. 최초 감사에서는 기존 변경을 보존하고 브랜치 생성·푸시·운영 배포·유료 생성을 하지 않았다. 이후 사용자가 승인한 배포 단계에서 `f131f12`와 `9935dc7`을 main에 반영했고 실제 CI·운영 배포를 검증했다. 유료 생성은 실행하지 않았다.

“수정 완료”는 아래 코드 경계와 회귀 검사에 대한 상태다. 모든 기기에서의 화면 품질·FPS나 운영 배포 성공을 뜻하지 않는다.

## 감사에서 찾은 결함의 처리

| 항목 | 수정한 동작 | 근거 |
| --- | --- | --- |
| P1 이전 계정 저장이 다음 계정의 섬에 들어갈 수 있음 | 월드·프로필 저장에 expectedOwnerId 필수, 서버에서 인증 사용자와 비교. 계정 교체 시 이전 요청·예약·재시도 취소 | [homes.rs](../server/src/homes.rs), [sessionWork.ts](../frontend/src/auth/sessionWork.ts), 서버 API·보안 및 웹 persistence 회귀 |
| P1 권한 회수 후 기존 실시간 연결 유지 | 직접 viewer·그룹 membership·공개 범위·일촌 변경 시 영향받는 연결 재검사·종료 | [permissions.rs](../server/src/permissions.rs), [rooms.rs](../server/src/rooms.rs), 실제 소켓 회귀 |
| P1 로그아웃 실패를 성공으로 표시 | 서버 오류 시 로그인 상태 보존, 실패 표시. 늦은 로그인·/me 응답이 새 세션을 덮지 못함 | [AuthProvider.tsx](../frontend/src/auth/AuthProvider.tsx), session 회귀 |
| 조건부 P1 관리자 이름 선점·bootstrap 승격 | 기존 계정은 비밀번호 소유권 확인 후 승격. 관리자 이름 예약. 옛 이름 기반 마이그레이션 전 소유권 점검 | [auth.rs](../server/src/auth.rs), [교정 마이그레이션](../server/migrations/20261002100000_security_boundaries.sql), permissions·security 회귀 |
| 조건부 P1 공개 스튜디오 gateway key 누락 | 빈 키·약한 키면 기동 거절. 공개 nginx는 내부 drain에 접근할 수 없음 | [entrypoint.py](../backend/infra/entrypoint.py), [nginx.conf](../backend/infra/nginx.conf), backend auth·entrypoint 회귀 |
| 조건부 P1 DB URL 상실과 S3 marker 오류 시 옛 JSON 기록 사용 | 이전 여부를 확인할 수 없으면 기동 거절. DB 준비는 실제 schema·namespace·기록 테이블 검사 | [object_storage.py](../backend/src/services/object_storage.py), [record_store.py](../backend/src/services/record_store.py), record store 회귀 |
| P1 배포·자동 종료가 진행 중 유료 작업을 자를 수 있음 | API·CLI·Blender 공통 수락 잠금과 OS lease. 먼저 drain 후 기존 작업 완료 대기. 후보는 닫힌 상태로 검증·commit 후 수락 개방 | [runtime_activity.py](../backend/src/services/runtime_activity.py), [deploy-on-instance.sh](../backend/infra/deploy-on-instance.sh), [idle-stop.sh](../backend/infra/idle-stop.sh), 배포·idle·process 회귀 |
| P2 로그아웃·세션 만료 후 소켓 유지 | 티켓·연결을 실제 세션에 바인딩. 로그아웃·세션 상한 정리 즉시 종료, 만료·읽기 권한 15초 주기 재확인 | [rooms.rs](../server/src/rooms.rs), rooms 회귀 |
| P2 동시 로그인 실패 제한 우회 | 실패 슬롯 원자적 예약, 성공·비밀번호 검증 오류의 정합적 환급 | [security.rs](../server/src/security.rs), security 회귀 |
| P2 Looks 상한·메모리 경계 | 16개 수락을 DB에서 원자적 예약. 다운로드 전 2개 실행 슬롯 확보. 파일·마스크·가림 정보 합계 64MiB, 이미지 decode 4096px·64MiB | [looks.rs](../server/src/looks.rs), [look_bake.rs](../server/src/look_bake.rs), 동시 수락·대기 중 다운로드 차단 회귀 |
| P2 ReBAC 500개 제한이 직접 권한을 누락 | userset 확장과 직접 사용자 권한을 분리해 직접 부여 누락 방지 | [rebac.rs](../server/src/rebac.rs), permissions 회귀 |
| P2 빈 스킨·애니메이션 이름만 있는 GLB를 playable로 인증 | 표준 typed schema와 실제 mesh·joint·accessor·buffer·morph·animation 채널 검증. 사이클·잘못된 변환·필수 외 애니메이션의 잘못된 참조도 거절 | [glb_validation.rs](../server/src/glb_validation.rs), 위조·손상 GLB 회귀 |
| P2 익명 방문 수 조작 | 클라이언트 UUID 대신 서버의 IP·날짜 기반 식별, 요청 속도·일일 상한 | [homes.rs](../server/src/homes.rs), api·security 회귀 |
| P2 방명록 무제한 제출 | 사용자별 속도·총량 제한을 원자적으로 적용 | [social.rs](../server/src/social.rs), security 회귀 |
| P2 반대 방향 일촌 요청·수락 경합 | 사용자 쌍 DB 잠금으로 요청·수락·해제 직렬화, 응답도 같은 트랜잭션에서 결정 | [social.rs](../server/src/social.rs), 동시 요청 회귀 |
| P2 옷장이 저장한 조합을 복원하지 않음 | 저장한 몸·파츠·색 복원, 단일 진행 조회와 세대 비교로 늦은 응답 차단 | [Wardrobe.tsx](../frontend/src/character/studio/Wardrobe.tsx), 빌드·타입 검사. 캐릭터 회귀 코드는 추가했지만 로컬 실행은 지침상 제외 |
| P2 검색·방명록 중복 페이지 | 검색 교체 시 목록·cursor 초기화. 제출·페이지 조회 즉시 잠금과 이전 세대 취소 | [ExplorePage.tsx](../frontend/src/pages/ExplorePage.tsx), [Guestbook.tsx](../frontend/src/minihome/Guestbook.tsx), 웹 회귀 |
| P2 프로필 마지막 입력 유실·저장 오류 미표시 | 이동 시 flush, 실패한 draft 복구, 새 입력 보존·오류 표시 | [Profile.tsx](../frontend/src/minihome/Profile.tsx), profile 회귀 |
| 임의 HTTPS 파일 리다이렉트 | 설정한 factory 출처 또는 표준 HTTPS AWS S3 호스트만 허용 | [factory.rs](../server/src/factory.rs), gateway 회귀 |
| 서버 중복 기동이 기존 작업을 interrupted 처리 | DB 전용 세션 프로세스 잠금을 먼저 획득. 마이그레이션·복구·HTTP 실행 동안 연결 감시, 소유 연결 상실 시 종료 | [runtime.rs](../server/src/runtime.rs), [main.rs](../server/src/main.rs), 실제 DB 잠금·종료 회귀 |

관리자 이름 기반의 이미 적용된 역사적 마이그레이션은 고치지 않았다. 새 교정 마이그레이션과 기동 전 소유권 검사를 추가했으며, 이미 정상 부여된 관리자 권한은 보존한다. 운영 계정 소유권이나 실제 secret 값은 출력하지 않았다.

## 추가 접수된 원격 캐릭터와 스튜디오 문제

확인한 코드 원인은 다음과 같다.

| 문제 | 수정 |
| --- | --- |
| 원격 GLB의 모든 재질에 이름표 색 덮어쓰기 | 원본 재질 색 보존. 전체 tint는 명시적 선택으로만 활성화. 로컬·원격 모두 figure 재질 정책 사용 |
| 이동 방향 180도 반전·정지 시 방향 초기화 | 실제 화면 그룹의 월드 회전 전송. 잠긴 물리 body 회전과 속도 기반의 잘못된 +PI 교정을 제거 |
| 로컬·원격 모델 계층과 애니메이션 소스 불일치 | 로컬도 전체 GLB node TRS·bind 구조 보존. 실제 재생 중인 scoped AnimationBridge 상태를 전송하고 공통 clip alias로 해석 |
| 큰 값·아주 작은 비단위 네트워크 quaternion | 서버·수신 엔진 모두 최대 성분으로 먼저 스케일 후 정규화, 방향 보존 |
| 관리자 미리보기의 별도 WebGL/PBR 경로 | WebGPU 우선 createRenderer와 figure 재질·동일 조명 정책 적용, 실제 fallback 표시·자원 정리 |
| 스튜디오의 옛 루트 query 링크·선택 유실 | 중앙 경로 helper, 생성 job·version·body·part 선택 보존. 제작 화면 열기가 실제 React Router 주소를 바꿈. history monkeypatch·click 가로채기 제거 |
| 모델 파일이 S3 redirect와 브라우저 CORS에 의존 | 인증된 같은-origin API의 256KiB streaming. Range·HEAD·ETag·Last-Modified 보존, 연결 종료·전송 오류 시 S3 body 정리 |

엔진 변경은 gaesup-world 레포에서 했고 앱은 [로컬 npm 패키지](../frontend/vendor/gaesup-world-1.7.0-mogaesup.2.tgz)로 받는다(10월 3일 원격 이동 수정을 더한 mogaesup.2로 교체). 설치돼 있던 npm 1.7.0의 정확한 sourceCommit을 복구해 변경분만 빌드했다. 오래된 현재 엔진 checkout 버전으로 내려 빌드하지 않았다. [소스 패치·출처·검증 기록](../frontend/vendor/gaesup-world-1.7.0-mogaesup.2.md)과 파일별 자산 해시를 함께 남겼다. 필수 WASM 두 개와 원본·웹용 기본 GLB의 해시는 교체 전후 동일하다.

운영 브라우저에서는 기존 카탈로그 모델 미리보기와 생성 완료 작업·산출물이 존재하는 것을 읽기로 확인했다. S3 CORS와 studio 인스턴스 running도 확인했다. 그러므로 현재 전체 스튜디오 장애를 CORS 문제로 단정하지 않는다. 실패한 사용자의 기기·브라우저·접속 화면 정보는 아직 없고, 수정 버전의 실제 두 사용자 화면·WebGPU/GPU 검증은 수행하지 않았다.

## 최종 교차 검토에서 추가로 수정한 GLB 경계

- 같은 BIN 범위를 여러 bufferView가 참조할 때 중복 재포장으로 메모리가 커지는 경로를 차단했다. 동일 범위는 재사용하고 재포장·변환 산출물·최종 GLB는 복사 전에 64MiB 상한을 검사한다.
- 같은 이미지 범위를 공유하는 모든 image의 변환 MIME을 갱신하고 재질별 요구 해상도의 최댓값을 적용한다.
- 잘못된 accessor count의 geometry 합산은 saturating 처리해 panic·wrap 대신 과대 크기 보고·거절로 이어진다.
- 인스턴스·중복 accessor·animation sampler 재사용도 전체 스캔 예산을 공유한다.
- 노드의 zero/non-unit 회전, matrix와 TRS 동시 지정, matrix 노드의 animation은 인증하지 않는다. 변환 규칙은 [glTF 2.0 공식 규격](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#transformations)에 대조했다.

## 기존 생성 모델의 오프라인 검증

새 이미지·3D 생성 없이 기존 S3 산출물 두 개를 읽어 검사했다. 치수와 삼각형은 정적 파일 통계이고 화면 품질 평가는 아니다.

| 모델 | 원본 바이트 | 웹용 바이트 | joints | 필수 idle·walk / 웹용 playable |
| --- | ---: | ---: | ---: | --- |
| 여성 | 10,790,688 | 2,195,524 | 24 | 통과 / 통과 |
| 남성 | 20,362,140 | 2,428,268 | 24 | 통과 / 통과 |

두 모델의 typed schema 오류는 0개, 웹용 최대 texture edge는 1024px이다. 최종 검증기·재포장 수정 후에도 다시 확인했다. 실행 도구는 [inspect_glb.rs](../server/examples/inspect_glb.rs), 로컬 결과는 .data/audit/models/verification.jsonl이다. 검사만으로 시각 승인이나 실제 모델 입기 성공을 주장하지 않는다.

## 전투 초안의 처리

server/src/war의 누락 routes 선언을 제거하고 lib의 실제 컴파일·검사에 포함했다. 손상된 카탈로그 이름을 원래 설계 문서에 맞춰 복구했고, 생성자가 진영·병력·맵·선공 값을 검증한다. 턴제 설계에 맞춰 사거리 배율을 적용하고 사용되지 않는 실시간 공격 간격을 제거했다. 잘못된 입력·벽·반격·종료·범위 동작을 9개 회귀로 확인했다.

로컬 제외 규칙 때문에 미래 커밋에서 이 소스가 빠지지 않도록 세 파일만 intent-to-add로 등록했다. 전투 HTTP/UI/저장·실제 PvP 서비스를 새로 구현한 것은 아니다.

## 번들 측정

초기 화면의 static JS closure는 raw 264,893바이트 / gzip 88,558바이트다. 초기 engine·Three·R3F 소스 유입은 0개이다. 섬의 static closure는 raw 5,585,340바이트 / gzip 1,835,013바이트로 여전히 무겁다. 기존 2.99MB three.tsl 청크 경고를 초기 화면 문제로 오인하거나 청크 분할을 총량 최적화로 보고하지 않았다. 경고 임계값·분할 설정은 바꾸지 않았다.

이 수치는 빌드 그래프·gzip 측정이며 로딩 지연·브라우저 p95·FPS·GPU 메모리 측정이 아니다. 로컬 근거는 .data/audit/frontend-route-bundles.json이다.

## 자동 배포

[파이프라인](../.github/workflows/pipeline.yml)은 PR·main push에서 변경 영역을 검사한다. 통과한 main push만 마지막 성공 실행 이후 변경을 서버 → 웹 → 스튜디오 순으로 배포한다. 첫 push는 전체, 수동 실행은 all/server/web/studio 선택이며 main 외에는 배포하지 않는다. 실행 중 배포는 취소하지 않고 직렬화하며 실패한 이전 변경도 다음 실행의 비교 범위에 남는다. vendor 엔진 변경도 웹 재배포 대상이다.

AWS의 mogaesup-github-deploy OIDC 역할을 배포했고 main 브랜치·해당 저장소에 한정한다. 릴리스 S3·지정 SSM·CloudFront 무효화·스택 읽기를 허용하며 IAM·CloudFormation 변경·EC2 시작은 허용하지 않는다. 실제 GitHub OIDC 인증은 최초 `f131f12` 실행에서 immutable repository ID 기반 subject에 맞춘 trust 교정 후 통과했고, 후속 `9935dc7` 실행도 전체 성공했다.

웹은 index 마지막 업로드·기존 hashed asset 보존·CloudFront 대기 후 index/API와 필수 WASM 두 개·기본 GLB의 MIME·SHA256을 검사한다. 스튜디오는 수락 차단→기존 API/CLI/Blender 완료→닫힌 후보 검증→commit→개방 순서다. 실패·중단 시 기존 설정·컨테이너·접수를 복원하고, 개방 후 응답이 불확실하면 새로 수락된 유료 작업을 자르지 않도록 후보를 보존한다.

**drain 없는 운영 구버전의 최초 스튜디오 교체는 자동으로 강행하지 않는다.** [백엔드 AWS 절차](../backend/README.md#aws-배포)에 따라 접수·CLI를 닫고 실제 작업 종료를 확인한 뒤 일회성 최초 전환을 완료했다. 후속 배포는 자동 drain 계약으로 통과했다. 꺼진 studio 인스턴스는 CI가 켜지 않는다.

최초 [36997500756](https://github.com/jigglypop/mogaesup/actions/runs/36997500756) attempt 2와 후속 [37000544937](https://github.com/jigglypop/mogaesup/actions/runs/37000544937) attempt 1 모두 서버·웹·스튜디오 배포가 성공했다. 후속 운영 index는 SHA256 `5ba6df60c3dd0918c913c97f5f964024b53ce1c7c50e4dd5c3b0c63a65621e3b`이고, 실제 파일 19개의 MIME·SHA·크기, 직접 링크 6개, API health 검사를 통과했다. 스튜디오 후속 릴리스 SHA256은 `3c06f692c0d9bd5b92f68de373eccc2b4321a10f6bba94c0a46c3e933b15136c`이다. [배포 기록](production-release-2026-10-02.md)에 실행·SSM 식별자와 복구 이력을 기록했다.

## 검증 결과와 남은 확인

검증 수는 소스 버전별로 구분한다. 최초 배포 `f131f12`의 CI 기준은 프런트엔드 276개, Python 731개, Rust 147개였다. 아래 최신 전체 게이트는 후속 배포 `9935dc7`의 287/769/148개 기준이며, 이후 변경의 검증 결과는 별도 기록한다.

| 검사 | 확인한 결과 |
| --- | --- |
| Rust fmt·all-target clippy -D warnings·전체 cargo test --locked --no-fail-fast | `9935dc7` 통과, 148개 |
| backend compileall·전체 offline pytest | `9935dc7` 통과, 769개. CI Python 3.11/3.12 모두 통과 |
| frontend TypeScript·Vite build·전체 CI Vitest | `9935dc7` 통과, 287개 |
| 최초 감사의 로컬 비캐릭터 Vitest | 당시 통과, 25 files / 180 tests. 최신 전체 CI 수와 다른 검사 범위 |
| 정확한 엔진 릴리스의 회귀·전체 타입·ESM/CJS/declarations build·publint·fresh consumer | 통과, focused 38 tests |
| 변경 감지 실제 Git fixture 회귀 | 통과, 15개 |
| actionlint·cfn-lint·배포 PowerShell 구문·Bash 구문 | 통과 |
| 웹 배포 script의 모의 MIME·SHA 검증 | 정상 1개·잘못된 MIME 3개·잘못된 SHA 3개 통과, AWS 쓰기 없음 |
| 새 npm checkout의 file 패키지·lock 설치 | 격리 npm ci 통과, lifecycle·정상 peer 검사 유지·lock 불변. Linux native optional dependency 누락 없음 |
| 실제 GitHub OIDC·Linux release/PowerShell 7·서버/웹/스튜디오 배포 | `f131f12`, `9935dc7` 두 실행 모두 성공. 후속 운영 index·19개 파일·6개 링크·API health 일치 |
| 로컬 캐릭터 unit·Playwright·유료 생성 | 로컬 캐릭터 지침에 따라 미실행. 캐릭터를 포함한 CI 결과와 구분 |
| 두 물리 네트워크의 WebGPU·원격 색/방향·걷기→정지·브라우저 FPS/GPU 수치 | 미검증 |

임시 DB의 실제 소켓·동시성 회귀와 외부 서비스를 대체한 테스트를 구분했다. 캐릭터 빌드 성공을 생성 공급자 성공이나 사람의 시각 승인으로 보고하지 않는다. 확인된 결함은 위 코드에서 수정됐으며, 다른 네트워크·기기의 전체 체감 품질과 무거운 섬 진입 성능은 아직 측정하지 않았다.

새 npm 설치의 격리 로컬 검증 환경은 Windows·Node 24이다. 이후 Ubuntu·Node 22의 실제 GitHub 실행도 통과했으며, 로컬 검사와 실제 CI 기록을 구분했다. 배포·공개 GET 일치 검사는 두 물리 네트워크의 브라우저 체감·GPU 검증을 대신하지 않는다.
