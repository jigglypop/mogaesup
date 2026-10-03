# 모개숲 구현 보고

설명 입력으로 매장 타일·벽·기물을 배치하고, 사진을 브라우저에서 편집해 업로드하며, 옷장 파츠 크기를 실제 저장 모델에 반영하도록 연결했다. 네이티브 조립 결과를 버전·해시에 고정해 검수하고 기존 API를 호출하는 로컬 MCP도 추가했다.

## 화면과 저장

- 섬 꾸미기의 **매장 배치**: 카페·매장·사무실, 4m 타일, 8~24m 크기, 0~12석. 실제 로드한 GLB 경계로 기존 기물·주민·도착 위치·통로를 보호한다. 독립 미리보기에서 확인하고 한 번의 되돌리기로 적용을 취소한다. 기존 섬 저장을 사용하며 편집 중 상태가 바뀌면 적용을 거부한다. [배치](../frontend/src/minihome/edit/layout.ts), [화면](../frontend/src/minihome/edit/LayoutComposer.tsx)
- 무료 해석은 브라우저에서 동작한다. 유료 AI 해석은 설정과 `paid_operator` 권한이 있을 때 사용한다. 게이트웨이 예산을 적용하고 호출 전 영수증을 저장한다. 같은 요청 ID는 결과를 재사용하며 불확실한 제출을 다시 결제하지 않는다. [API](../backend/src/api/layouts.py), [서비스](../backend/src/services/store_layouts.py)
- 운영 스튜디오 사진: 파일·드롭·붙여넣기 → 방향 적용 → 자르기 → 긴 변 최대 2048px 새 PNG/JPEG → 처리본 확인 → 업로드. 캔버스 재인코딩으로 원본 EXIF를 전달하지 않는다. [처리](../frontend/src/character/photo-preparation.ts), [화면](../frontend/src/character/factory/PhotoPreparation.tsx)
- 회원 옷장: 헤어·앞머리·뒷머리·모자·안경의 축별 크기 80~120%, 위치 ±5cm, 초기화. `LookRequest.partEdits`를 저장·복원하며 서버가 착용 파츠·범위를 다시 검증한다. 본·가중치·inverse bind는 보존하고 원본 rest geometry의 공통 몸 좌표 bounds 중심으로 tuck 이후 변형한다. morph가 있는 파츠는 기본 착용을 유지하며 크기 편집을 거절한다. [변형](../frontend/src/character/part-edit.ts), [저장](../server/src/looks.rs), [GLB 구움](../server/src/look_bake.rs)

크기·위치를 바꾼 파츠의 원본 coverage로 피부를 삭제하거나 다른 파츠를 그 아래로 tuck하지 않는다. 보수적으로 원래 피부를 보존해 축소·이동 뒤 구멍이 드러나는 것을 막으며, 초기화하면 원본 coverage를 복원한다. 자동 침투 제거를 통과했다는 판정은 하지 않는다.
- 네이티브 검수: `POST /api/avatar-factory/jobs/{job}/native-parts/{version}/review`. 현재 버전·조립 SHA·전 산출물 해시·기술 검사·표정 완료·미완성 파츠·네 방향과 동작 렌더를 검사한다. 별도 `reviews.json`으로 sealed quality/record를 보존한다. 근거가 바뀌면 승인 overlay가 stale이다. [검수](../backend/src/services/avatar_native_reviews.py), [화면](../frontend/src/character/factory/NativeReview.tsx)

## MCP와 생성 에셋

`uv run --extra studio-mcp asset-studio-mcp`로 인증 API를 감싸는 stdio 서버를 실행한다. API origin과 세션은 로컬 환경으로 전달한다. 읽기 도구와 구조화된 검수 작업을 제공하며 쓰기는 `MOGA_STUDIO_MCP_WRITE=1`에서 활성화한다. [설정과 도구](studio-api-mcp-spec.md), [구현](../backend/src/studio_mcp.py)

오트밀 유틸리티 블루종 참조 이미지를 built-in imagegen으로 실제 생성했다. 제공받은 Meshy 설정으로 해당 이미지 한 장을 기존 `character_jobs.generate_multiview_part` 서비스에 제출했고, Meshy 7.1·Standard·2K PBR·triangle 설정에서 **30크레딧**을 사용해 GLB를 받았다. 의상 스타일에서 기존 `AssetModelPreview`로 네 방향·와이어프레임을 볼 수 있고 PNG 텍스처 참조 업로드도 유지한다. [이미지](../frontend/public/character/references/oatmeal-utility-blouson.png), [실제 GLB](../frontend/public/character/references/oatmeal-utility-blouson.glb), [원문 프롬프트·SHA·작업 ID·검사 기록](generated-assets-2026-10-03.json)

추가로 제공된 OpenAI·Meshy 설정은 Git에서 제외된 로컬 파일에만 저장했다. `gpt-5.4-nano`의 실제 AI 해석도 성공했다(12m × 16m 카페, 4석, 월넛). Tripo는 V2/V3 잔액 조회에서 401을 받았고 유료 생성을 제출하지 않았다. 전달된 `tcli_` 형식은 [공식 FAQ](https://docs.tripo3d.ai/other/support-faq.html)상 Client ID이며 인증 API 키는 `tsk_`다. 로컬에 Client ID로 분리해 보관한다. GLB는 **리깅 없는 디자인 참조**이며 18,569개 삼각형으로 top 목표 18,000개를 넘는다. 로컬 canonical body가 없어 착용·몸 맞춤·애니메이션 검수나 카탈로그 승인을 하지 않았다. 개인별 사진 제작 소유권 매핑과 몸 체형 변경은 기존 운영 스튜디오·공용 몸의 경계를 따른다.

## 검증

- Rust 1.95: `cargo fmt`, `cargo clippy --all-targets --locked -- -D warnings`, `cargo test --locked` 통과. PostgreSQL 통합 테스트 포함 **180개**.
- `npm run typecheck`, `npm test` **66파일 435개**, `npm run build` 통과.
- `uv run --no-sync python -m compileall -q backend/src`, 전체 `pytest -q` **1184개** 통과. AI 제출 후 불확실 응답이나 결과 기록 실패는 504로 반환해 게이트웨이 월 예산에서 빠지지 않으며 해당 API 14개를 확인했다. Tripo Client ID 설정은 capability에서 제외하고 생성 접수·HTTP 클라이언트 생성 전에 차단한다.
- Chrome **WebGPU** 캐릭터 E2E 통과: 가져오기·공개·회원 권한·이동·주민·모자 색/크기/위치 편집·서버 저장/구움·재접속 복원·섬 착용·실시간 공유.
- 매장 브라우저 검사: 실제 GLB와 3D 미리보기, 12m 카페 5기물/2석, 적용·저장 → 되돌리기·저장 → 다시 하기·저장, PUT 3회, 오류 0. [재현 스크립트](../frontend/src/minihome/__tests__/layout.browser.mjs)
- 실제 의상 GLB: 9,147,684바이트, 구조 검사 오류·경고 없음. SinglePart의 실제 WebGPU 뷰어에서 네 방향·와이어프레임·닫기 후 재로드를 확인했다. 해당 화면 검사에서 API mutation은 0회이며 모델 생성은 앞서 저장한 실제 Meshy 작업 하나다.
- CloudFormation `cfn-lint` 통과. macOS 오프라인 infra harness와 브라우저 테스트의 Windows 그래픽 옵션·redirect 대기를 수정했다.
- GNU Bash 5.3에서 변경 감지 테스트 **15개**와 추적 중인 셸 스크립트 **3개** 문법 검사를 통과했다.

캐릭터·매장 화면 검사에는 임시 PostgreSQL과 가짜 캐릭터 서버를 사용하며 공급자 호출은 없다. 실제 생성·AI 해석의 증거는 별도 작업 기록과 구분한다. 미리보기 출입구는 현재 엔진의 arch가 닫힌 문짝을 그리는 문제를 피하도록 벽 한 구간을 비워 실제 4m 통로를 만든다. 최초 구현 `8d60ec6`의 [자동 배포](https://github.com/jigglypop/mogaesup/actions/runs/37123177344)는 검사 및 서버·웹·스튜디오 10개 작업이 모두 성공했고, 운영 PNG의 SHA도 일치했다. 추가 GLB와 미리보기는 후속 main 커밋으로 배포한다.
