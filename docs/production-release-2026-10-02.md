# 운영 배포 검증 · 2026-10-02

## 실제 통과한 배포

- 소스: `f131f12bae32956466eba69c4dca9667e1ca6dd0`, `main`에 일반 push.
- GitHub Actions: [36997500756](https://github.com/jigglypop/mogaesup/actions/runs/36997500756), 재실행 attempt 2, 전체 `success`.
- 실제 CI: 프런트엔드 276개 테스트·typecheck·build, 백엔드 Python 3.11/3.12 각각 731개, Rust fmt·clippy·147개 테스트, 워크플로·변경 감지·CloudFormation·셸·PowerShell 검사 통과.
- 서버 → 웹 → 스튜디오 순서로 세 배포가 모두 성공했다. 스튜디오 SSM `d73214c2-1e98-4fee-aa35-24ca562df70c`, 릴리스 SHA256 `a8c16cfc1f194c3402bc03d5af9b368febd1a0b6f14edda1c5d2b7be619c5a59`, 실제 `deployment healthy`를 확인했다.
- 운영 웹 index가 해당 빌드의 SHA와 같고, 초기·지연 로딩 JS/CSS/WASM/GLB 19개가 HTTP 200·MIME·SHA 검사에 통과했다. 스튜디오/캐릭터/운영의 직접 링크 6개도 같은 index를 반환했다. `/api/health`는 200·ok·no-store였다. 없는 GLB는 XML 오류 응답으로 HTML fallback이 없었다.

## 배포 중 발견하고 복구한 설정

1. 이 저장소는 GitHub의 새 immutable repository ID 기반 OIDC subject를 사용한다. 기존 이름만 허용한 trust로는 AWS 인증이 거절되었다. 저장소 ID `1393605828`, 소유자 ID `52653682`, `main`, audience `sts.amazonaws.com`만 허용하도록 CloudFormation을 수정·적용했다. 역할의 배포 권한은 확대하지 않았다. 동일 실패 실행을 재실행해 실제 AWS 인증과 세 배포의 성공을 확인했다.
2. 기존 스튜디오에는 새 drain/admission 계약이 없었다. 고정한 기존 릴리스·프로세스·접속·작업 상태를 검증하는 일회성 `bootstrap-legacy-runtime.py`로 TERM 종료만 허용하여 전환했다. 첫 후보는 gateway 설정 누락으로 시작을 거절했고, 기존 릴리스로 정상 rollback했다. 기존 서버의 gateway 값을 스튜디오 설정에 동기화한 뒤 새 전환을 실행해 DB·admission·idle timer 정상 상태를 확인했다. 키 값은 출력·로컬 저장하지 않았다.

## 후속 배포도 실제 통과

후속 변경은 immutable OIDC 템플릿, 공개 스튜디오 gateway 설정의 사전 검사, 일회성 전환/설정 도구, 같은 전체 헤어와 분리 헤어의 중복 선택 방지, 몸 버전·SHA 변경 시 파츠 및 coverage cache 갱신이다.

- 소스: `9935dc7d16441e3704e0b90cd03044ef3a8651a5`, `main`.
- GitHub Actions: [37000544937](https://github.com/jigglypop/mogaesup/actions/runs/37000544937), attempt 1, 전체 `success`. 변경 감지·프런트엔드·Python 3.11/3.12·Rust·인프라·gate와 서버 → 웹 → 스튜디오 배포가 모두 성공했다.
- 이 소스의 검증 기준은 프런트엔드 287개·typecheck·build, 백엔드 769개, Rust fmt·clippy·148개 테스트다. 최초 `f131f12`의 276/731/147개 기록과 구분한다.
- 스튜디오 SSM `5dc0d153-03a1-47ff-ae5f-2c944d2ac07d`, 릴리스 SHA256 `3c06f692c0d9bd5b92f68de373eccc2b4321a10f6bba94c0a46c3e933b15136c`로 후속 배포를 확인했다.
- 운영 index SHA256 `5ba6df60c3dd0918c913c97f5f964024b53ce1c7c50e4dd5c3b0c63a65621e3b`가 해당 빌드와 일치했다. 실제 JS/CSS/WASM/GLB 19개는 200·MIME·SHA·크기, 직접 링크 6개는 같은 index 반환 검사를 통과했다. `/api/health`는 200·ok·no-store였다.

근거는 `.data/audit/production-web-followup-pipeline.json`과 `.data/audit/production-web-followup-after.json`이다. 위 테스트 수와 배포 상태는 `9935dc7` 기준이며, 이후 추가 변경의 검사·배포를 대신하지 않는다.

## Native 헤어 업로드 수정의 로컬 게이트

후속 `9935dc7` 이후, 이미 피팅된 소유자 업로드 헤어의 형태를 기존 fit 경로에서 보존하는 변경을 검증했다. 전체 offline Python **876개**, backend/src·infra compileall, 변경 diff 검사가 통과했다. 네 후보의 실제 Blender 조립·GLB 재입력·4방향·walk 25% 렌더를 확인했고, 출력 헤어는 입력 파일과 동일했다. 이 수치는 새 소스의 로컬 결과이며 아래 GitHub 배포 결과와 구분한다. 새 실행·운영 등록 결과는 확인 후 별도 기록한다.

## 검증 경계

배포 성공과 CPU Blender 렌더가 다른 물리 네트워크의 WebGPU 화면·원격 캐릭터 이동 검증을 대신하지 않는다. 실제 두 기기/네트워크의 색·방향·걷기→정지 확인은 남아 있다. 모델 수량·스타일 개선은 [별도 작업 기록](studio-quality-plan-2026-10-02.md)에 기록하며, 디자인 후보나 생성 중단 항목을 승인된 신규 모델로 세지 않는다.
