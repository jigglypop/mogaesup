# 사진 캐릭터 제작 편집과 재검수 설계

2026년 10월 3일 구현 전 저장소 분석과 같은 날 추가한 구현의 계약을 기록한다. 운영 작업을 실행하거나 실제 사진의 생성 품질을 검증한 문서는 아니다. 아래의 **이번 구현**, **구현 전 분석**, **후속 제안**은 별개의 상태다.

## 이번 구현

- [PhotoPreparation.tsx](../frontend/src/character/factory/PhotoPreparation.tsx)와 [photo-preparation.ts](../frontend/src/character/photo-preparation.ts)는 PNG/JPEG 파일 선택·드롭·붙여넣기를 사진 자르기와 처리본 확인으로 통일한다. 디코딩 시 EXIF 방향을 적용하고 새 canvas 이미지로 인코딩해 원본 메타데이터를 전달하지 않는다. 긴 변은 최대 2048px이며 작은 사진을 확대하지 않는다. 사용자가 확인한 처리본만 기존 업로드 API로 전달된다. 얼굴 자동 탐지와 서버 전처리 영수증은 후속 제안이다.
- 회원 [Wardrobe.tsx](../frontend/src/character/studio/Wardrobe.tsx)는 착용 중인 `hair`, `hairFront`, `hairBack`, `hat`, `glasses`의 XYZ 크기 0.8~1.2와 XYZ 위치 ±0.05m를 편집하고 원상복구한다. 개인 `LookRequest.partEdits`에 저장하며 정확한 파츠 version/SHA에만 복원한다. 공용 카탈로그 조합과 파츠 원본을 수정하지 않는다.
- [native-wardrobe.ts](../frontend/src/character/native-wardrobe.ts) 미리보기와 [look_bake.rs](../server/src/look_bake.rs) 최종 GLB 굽기는 source GLB의 원래 rest world bounds 중심을 pivot으로 쓰고, tuck 이후 크기·위치 변형을 적용한다. mesh affine 변환을 보존하고 원본 geometry 기준으로 매번 다시 계산한다. skeleton, weights, inverse bind와 tangent W는 유지한다. 비유한 값·범위 밖 입력·morph 파츠의 nonidentity 편집·서로 다른 world 변환으로 공유하는 mesh의 편집은 거절한다.
- 크기·위치를 바꾼 파츠의 원본 coverage는 새 위치의 피부 가림을 증명하지 못하므로 body triangle/material 가림과 다른 파츠를 그 아래로 누르는 tuck 근거에서 제외한다. 피부를 보존하며, 원상복구하면 원본 coverage를 다시 적용한다. 변경된 coverage를 기하에서 다시 계산하는 기능은 후속 설계다.
- [avatar_native_reviews.py](../backend/src/services/avatar_native_reviews.py)와 [NativeReview.tsx](../frontend/src/character/factory/NativeReview.tsx)는 현재 native 버전과 assembly SHA에 대해 별도 시각 승인 기록을 저장한다. 승인에는 외형·동작 확인과 5~2000자 메모가 필요하며 응답을 잃으면 동일 요청 키로 복구한다. 봉인한 품질 JSON은 유지하며 [PipelineQuality.tsx](../frontend/src/character/factory/PipelineQuality.tsx)는 `review.status`의 승인·수정 필요·재검수 상태와 실제 검수자를 표시한다.
- [garment-styles.json](../frontend/src/character/studio/garment-styles.json)의 오트밀 유틸리티 블루종은 실제 생성한 참조 PNG와 Meshy GLB의 URL/SHA를 포함한다. [SinglePart.tsx](../frontend/src/character/studio/SinglePart.tsx)는 해당 이미지를 보여주고, 사용자가 텍스처 참조로 선택하면 기존 `meshy-options/texture-assets` 업로드 API와 Meshy `texture_mode: image` 입력으로 연결한다. 참조 등록 버튼은 3D 생성 요청을 보내지 않는다. 실제 GLB는 기존 `AssetModelPreview`에서 네 방향과 와이어프레임으로 확인할 수 있는 `3D 참조`다. 공용 골격에 피팅한 착용 파츠나 시각 승인 완료 모델로 취급하지 않는다.

사진 회원별 비공개 제작권한, 얼굴·몸 전체·회전 편집, 일반 rigid/socket 파츠 착용, 닮음 자동 판정과 최신 스타일 자동 수집은 아직 후속 설계다. 운영 공장의 공유 owner와 회원 개인 Look의 소유권 차이는 유지한다. 브라우저 및 오프라인 테스트가 실제 provider 생성 성공이나 사람의 시각 승인 완료를 대신하지 않는다.

## 구현 전 분석: 지원과 누락

| 항목 | 현재 구현 | 추가가 필요한 부분 |
| --- | --- | --- |
| 사진 입력 | PNG와 JPEG의 선택, 드롭, 붙여넣기. 파일 원문을 업로드한다. | 업로드 전 크롭, 용량 축소, EXIF 방향 정리, 사용자에게 보이는 처리 결과. HEIC 입력은 현재 지원하지 않는다. |
| 서버 사진 검사 | 업로드 25MB 제한, PNG와 JPEG 형식 검사, 3200만 픽셀 제한, 파일 검증과 SHA 저장. | 방향을 적용한 디코딩과 메타데이터를 제거한 정규화본, 원본과 처리본의 별도 출처 기록. |
| 사진 기반 SD 제작 | 기준 몸 또는 새 몸 선택, 정면과 측면 표준 이미지 준비, 정면과 측면과 후면 파츠 이미지, 얼굴과 헤어와 의상 등 생성, 리깅과 조립. | 얼굴 사진 전용 크롭 입력 계약과 원사진 대비 닮음 검수. 현재 프롬프트의 identity 보존 문장은 닮음 측정이나 승인 증거가 아니다. |
| 직접 편집 | 착용 파츠, 헤어 색, 의상 부위 색. 운영 화면은 상의와 하의 피팅 기준점, 길이 비율, 소매 비율을 입력한다. 몸 셸 의상은 소매와 밑단과 품을 조정한 뒤 로컬 Blender로 다시 만든다. | 얼굴과 헤어와 몸의 일반 크기, 위치, 회전 편집과 저장. 회원은 공용 의상 shape 재피팅 컨트롤을 받지 않는다. |
| 재피팅과 버전 | 선택한 파츠만 다시 맞추며 다른 파츠와 몸을 고정한다. 원본 SHA, 입력 fingerprint, 요청 키, 새 버전과 이전 버전 선택을 유지한다. | 개인 편집본과 공용 파츠 재피팅을 분리한 소유권 계약. |
| 검수 | 네 방향 렌더, 동작 미리보기, GLB 구조, 삼각형과 텍스처, 후면 헤어 가림, 의상 몸 침투 수치, 봉인한 품질 JSON. | native 조립 결과에 대한 시각 승인 저장 API와 UI. 얼굴 닮음과 눈 가림, 동작 중 간섭 검토의 저장 증거. |
| 최종 사용 | 회원은 옷장 조합과 색을 `/api/looks/me`에 저장한다. Rust 서버가 파츠를 한 GLB로 굽고 섬 플레이어 모델로 사용한다. | 편집 변환과 수정한 geometry, 새 coverage가 미리보기와 최종 GLB에 동일하게 적용되는 경로. |

사진 업로드는 [CharacterFactory.tsx 142행](../frontend/src/character/factory/CharacterFactory.tsx#L142), 사진 생성 입력은 [236행](../frontend/src/character/factory/CharacterFactory.tsx#L236), 업로드 크기 제한은 [characters.py 142행](../backend/src/api/characters.py#L142), 서버 원문 저장은 [character_pipeline.py 319행](../backend/src/services/character_pipeline.py#L319)에 있다. `avatar_openai_images.py`의 [reference_data_url 402행](../backend/src/services/avatar_openai_images.py#L402)은 외부 제공자 입력을 위한 1024px thumbnail 경로다. 브라우저 사진 편집 기능과 동일하지 않다.

표준 이미지 준비는 [avatar_reference_preparation.py 25행](../backend/src/services/avatar_reference_preparation.py#L25), 파츠 입력은 [avatar_image_pipeline.py 145행](../backend/src/services/avatar_image_pipeline.py#L145), 정규 캔버스 맞춤은 [avatar_production_spec.py 181행](../backend/src/services/avatar_production_spec.py#L181)에 있다. 기존 조립을 쓰는 사진 제작은 저장 몸 치수에 맞추고 원사진 몸의 비율로 교체하지 않도록 [reference_prompt 77행](../backend/src/services/avatar_reference_preparation.py#L77)에서 계약한다.

피팅 입력 화면은 [PartFitting.tsx 170행](../frontend/src/character/studio/PartFitting.tsx#L170), 의상 모양 재생성은 [WardrobeShape.tsx 84행](../frontend/src/character/studio/WardrobeShape.tsx#L84), 회원에게 숨기는 기준은 [wardrobe-view.ts 19행](../frontend/src/character/studio/wardrobe-view.ts#L19)에 있다. 서버의 재피팅 검증과 다른 파츠 고정은 [avatar_native_parts.py 197행](../backend/src/services/avatar_native_parts.py#L197)에 있다.

## 구현 전 분석: 시각 승인 분기의 기존 결함

현재 native 품질 봉인은 항상 `visual_review: required`를 기록한다. [avatar_pipeline_quality.py 172행](../backend/src/services/avatar_pipeline_quality.py#L172)에 승인 갱신이 없고, 품질 UI의 [PipelineQuality.tsx 16행](../frontend/src/character/factory/PipelineQuality.tsx#L16)은 `approved`이면 시각 승인 완료라고 표시한다. 저장소의 native 조립 경로에는 이 상태를 쓰는 승인 API가 없으므로 해당 표시 분기에 도달하는 경로가 없다.

위 내용은 구현 전 결함의 근거다. 이번 구현은 봉인 JSON을 변경하지 않고 별도 review overlay를 쓰는 API와 UI를 연결해 이 결함을 해결했다.

기존 `record_review` action은 [character_actions.py 121행](../backend/src/services/character_actions.py#L121)에 있다. 현재 `CharacterPipeline`이 선택한 모델 SHA와 파츠 역할, 동작 확인, 외형 확인, body coverage를 검증하고 `control.json`과 작업 영수증에 기록한다. 이 레거시 제어 기록을 native `job/version/quality.json` 승인 계약으로 자동 간주하면 안 된다. 현재 캐릭터 공장 UI에도 `record_review` 제출을 연결한 화면이 없다.

후면 가림과 침투 수치는 [avatar_quality_blender.py 1행](../backend/src/services/avatar_quality_blender.py#L1)에 명시된 비교 지표이며 시각 합격 판정기가 아니다. 품질 수치가 기록되거나 `review_required` 조립 GLB가 생겼다는 사실로 시각 승인 완료를 보고하지 않는다.

저장 옷장 조합 복원은 [Wardrobe.tsx 265행](../frontend/src/character/studio/Wardrobe.tsx#L265)에서 정확한 version/SHA가 없으면 같은 job과 slot의 현재 파츠를 대신 선택한다. 현재 착용 UX에는 의도된 최신 피팅 반영이지만, 승인한 모습의 정확한 재현은 아니다. 제안하는 검수 화면은 승인 대상의 정확한 SHA를 요구하며, 교체되면 교체 사실과 재검수 상태를 표시한다.

## 회원 제작권한과 소유권 제안

현재 Rust 스튜디오 게이트웨이는 [factory.rs 139행](../server/src/factory.rs#L139)의 설정된 `owner_id`를 `ADMIN` 토큰으로 서명한다. 회원 옷장 요청도 같은 owner의 `ADMIN, MEMBER` 토큰으로 읽고, [Need 259행](../server/src/factory.rs#L259)에서 읽기와 운영 쓰기와 유료 실행을 구분한다. Python은 [auth.py 219행](../backend/src/auth.py#L219)에서 ADMIN을 요구한다. 사진 캐릭터 UI는 [StudioPage.tsx 80행](../frontend/src/studio/StudioPage.tsx#L80)의 운영 탭에 있다. 따라서 일반 회원이 본인 사진으로 비공개 캐릭터를 만드는 self service가 구현됐다고 보고할 수 없다.

Python 작업 디렉터리는 [avatar_factory.py 48행](../backend/src/services/avatar_factory.py#L48)의 정수 owner별 경로이고 원본 캐릭터는 [character_pipeline.py 90행](../backend/src/services/character_pipeline.py#L90)에서 owner를 검사한다. 반면 회원의 최종 Look는 Rust 앱 회원 UUID로 소유한다. 두 ID 체계의 연결은 신규 기능에서 명시적으로 정한다.

제안하는 권한은 다음과 같다.

1. Rust 서버가 로그인 회원 UUID와 별도 backend owner를 매핑한다. 클라이언트가 owner, ADMIN, 다른 회원 ID를 전달해 소유권을 선택할 수 없다.
2. 비공개 사진과 파생 캐릭터는 해당 회원 또는 승인된 운영 담당자만 읽는다. 기존 회원용 공용 옷장 조회 토큰으로 개인 사진 제작 쓰기나 개인 원사진 조회를 열지 않는다.
3. 공용 에셋을 입는 권한, 개인 파생 geometry를 만드는 권한, 공용 파츠를 바꾸는 운영 권한을 구분한다. 회원 크기 편집은 본인의 Look 파생본을 만들며 공용 파츠 버전을 변경하지 않는다.
4. 유료 사진 생성은 개인 제작 capability와 작업별 예산을 검사하고 기존 요청 영수증과 idempotency를 유지한다. MCP나 브라우저가 제공자 키와 서버 경로를 받지 않는다.
5. 개인 승인과 공용 라이브러리 출고 승인을 분리한다. 회원이 자기 모습을 선택한 기록은 운영자가 에셋을 공용으로 출고한 승인과 같지 않다.

이는 신규 설계다. 현재 운영 owner 쓰기 경로를 개인 회원에게 그대로 제공하는 구현은 제안하지 않는다.

## 사진 크롭과 축소 제안

사진 입력 후 바로 브라우저에서 방향을 적용한 미리보기를 띄운다. 크롭 영역, 되돌리기, 처리본 확인만 제공한다. 얼굴 사진이 들어오면 얼굴과 머리 윤곽을 함께 포함하는 크롭을 기본 후보로 잡고 사용자가 수정할 수 있게 한다. 사진에 보이지 않는 뒷머리나 몸을 정확하게 복원했다고 표시하지 않는다.

클라이언트는 방향 처리 후 크롭하고 긴 변 최대 2048px의 PNG 또는 JPEG 처리본을 만든다. 이 2048px는 제안하는 업로드 처리본 상한이며, 현재 생성 파츠의 2048×2048 공통 캔버스 규격과 별도 계약이다. 원사진의 종횡비를 보존하고 업로드 단계에서 정사각형으로 늘리지 않는다. 캔버스를 새로 인코딩해 위치나 기기 정보가 들어 있는 EXIF를 전달하지 않는다. 이미지 디코딩 경로에서 방향을 두 번 적용하지 않도록 명시적으로 관리한다.

서버는 클라이언트 전처리를 신뢰하지 않고 업로드 바이트, 허용 형식, 디코딩 픽셀 수, EXIF 방향을 다시 검사한다. EXIF 방향이 남아 있으면 `ImageOps.exif_transpose`에 해당하는 처리 후 새 이미지로 인코딩한다. 서버 파일 경로나 임의 실행 코드는 입력에 포함하지 않는다. crop은 유한한 `[0,1]` 정규화 좌표와 양의 너비와 높이로 검증한다.

처리 영수증에는 `source_sha256`, `prepared_sha256`, 원래/처리 이미지 치수, 실제 적용한 crop, orientation 처리 여부, 인코더 계약 버전을 저장한다. 새 사진이나 새 crop은 기존 생성 출처를 덮어쓰지 않고 새 입력 버전으로 만든다. 원사진 보관 여부와 기간은 개인 사진 정책에 맞춰 별도 결정하며, 공용 카탈로그에 원사진을 자동 공개하지 않는다.

이 단계는 이미지 유료 생성 없이 구현하고 검증할 수 있다. 얼굴 사진을 SD로 재해석하는 실제 이미지 생성과 3D 생성은 사용자가 요청한 작업 범위와 지출 한도에 맞춰 별도로 실행한다.

## 몸 규격과 편집 범위 제안

현재 [production-v1.json 2행](../backend/assets/avatars/production-v1.json#L2)은 revision 22, 단위 미터, +Y 위, +Z 정면, 원점 양발 사이 바닥, 몸 높이 1.2m, T 자세를 정의한다. 2048×2048 캔버스와 crown/neck/waist/shoulder/wrist/ankle 기준점을 함께 쓴다. 헤어와 장식을 포함한 전체 bbox를 강제로 1.2m에 맞추는 규칙이 아니다.

최소 범위는 얼굴 크기와 헤어 폭/높이/깊이, 제한된 위치 보정, 원래대로 되돌리기다. 몸 전체의 전역 scale을 먼저 개방하면 파츠 피팅, skeleton rest 좌표, inverse bind, 의상 coverage, 표정 UV의 기존 계약과 충돌할 수 있다. 몸의 키나 체형 변경은 새 body profile과 새 rig identity를 만들고 기존 파츠를 다시 맞추는 별도 기능으로 둔다.

서버가 파츠의 현재 skin/anchor 정보와 bounds를 확인한 뒤 `editable_controls`와 허용 범위를 반환한다. 부위별 범위는 기존 실제 몸과 피팅 geometry를 기준으로 정하고 검증하지 않은 공통 배수를 제품에 하드코딩하지 않는다. 편집 컨트롤은 지원되는 파츠에서만 활성화한다. 눈 가림과 두피 침투, 바닥 아래 위치, 음수 scale과 비유한 입력은 서버에서 검사한다.

### rigid 파츠

장식이 실제 rigid mesh이면 서버가 정한 attachment/socket 좌표계에서 translation, quaternion rotation, 양의 scale을 사용한다. 클라이언트가 본 이름이나 pivot 좌표를 임의로 지정하지 못하게 한다. 브라우저 미리보기와 최종 GLB가 같은 socket rest frame을 적용해야 한다.

현재 [look_bake.rs 765행](../server/src/look_bake.rs#L765)은 skinned mesh를 고르고 없는 파츠를 거절하므로 rigid 착용이 현재 지원된다고 주장하지 않는다. rigid 지원 시 해당 병합 경로를 추가하거나 검증한 socket의 단일 본 skin으로 변환하는 명시적 서버 recipe를 만든다. 어느 방법을 쓰든 저장 계약의 `kind`로 구분한다.

### skinned 파츠

헤어와 얼굴과 의상처럼 기존 몸의 skeleton을 공유하는 파츠는 화면 group의 scale만 변경하지 않는다. 현재 [native-wardrobe.ts 34행](../frontend/src/character/native-wardrobe.ts#L34)은 실제 몸의 본과 mixer를 공유하며, Rust 구움은 [look_bake.rs 779행](../server/src/look_bake.rs#L779)에서 본 이름뿐 아니라 부모와 world rest 좌표까지 비교한다.

제안하는 편집은 고정한 bind/rest pose의 geometry에 서버가 정의한 pivot deformation을 한 번 적용하는 방식이다. 원본 position에서 편집본을 다시 계산해 누적 오차를 막고, normals와 tangents, morph deltas와 bounds를 함께 처리한다. joints, weights, 본 계층, animation은 보존하며 mesh local 좌표와 공통 몸 좌표 변환을 명시한다. 브라우저 미리보기도 같은 recipe와 기준 좌표를 사용한다. 처리하지 못하는 morph/skin 구조는 편집을 거절하고 지원 가능한 컨트롤만 제공한다.

파츠 모양이 바뀌면 기존 몸 가림 bitset과 tuck 이동량이 그대로 유효하다고 간주하지 않는다. 새 geometry 기준으로 coverage/tuck과 침투를 다시 계산한 뒤 최종 GLB를 굽는다. 얼굴을 수정한 경우 기존 표정과 얼굴 texture 적용 결과도 함께 재검토한다.

## 저장과 최종 GLB 계약 제안

현재 [LookBody 85행](../server/src/looks.rs#L85)은 `deny_unknown_fields`이며 body와 parts와 hairColor와 colors만 받는다. frontend에 scale 필드만 추가하면 서버가 거절하며, 클라이언트 group scale만 바꾸면 재접속과 최종 GLB에 남지 않는다. Python [NativePartRefitInput 360행](../backend/src/api/avatar_factory.py#L360)에도 일반 변환 필드가 없다.

신규 개인 편집 계약은 다음 정보를 추가한다. 필드명은 구현 전 제안이며 현재 호출할 수 있는 API가 아니다.

```json
{
  "editContract": "character-part-edit-v1",
  "expectedLookRevision": 7,
  "body": {"jobId": "<id>", "version": "<version>", "sha256": "<sha256>"},
  "partEdits": {
    "hair": {
      "source": {"jobId": "<id>", "version": "<version>", "sha256": "<sha256>"},
      "kind": "skinned-rest-deform",
      "controlId": "hair-frame-v1",
      "translationM": [0, 0.005, 0],
      "rotationQuat": [0, 0, 0, 1],
      "scale": [1.02, 1, 1.02]
    }
  }
}
```

`controlId`는 서버가 발급한 고정 pivot/anchor 규칙을 가리킨다. 범위 밖 값, 다른 본에 붙이는 값, client pivot 또는 임의 matrix는 받지 않는다. 개인 편집 소유권과 공용 원본에 대한 읽기 권한을 각각 검사한다. 원본 ID/version/SHA와 몸 SHA가 달라지면 수정 요청을 거절해 새 입력을 확인하게 한다.

요청은 기존 수락/영수증/동일 요청 키 계약에 연결하고 처리 중 다시 클릭을 막는다. 서버가 수락한 입력, deformation recipe hash, 출력 geometry SHA, coverage/tuck SHA, 렌더 SHA, 최종 GLB SHA를 보존한다. 브라우저 종료 후에도 같은 작업을 조회할 수 있어야 한다. 편집본 원본 파일을 덮어쓰거나 공용 파츠 current 포인터를 변경하지 않는다.

현재 [looks.rs 230행](../server/src/looks.rs#L230)의 Look 생성과 [look_bake.rs 739행](../server/src/look_bake.rs#L739)의 병합을 유지해 편집 파생본을 입력으로 받는다. 최종 파일을 다시 검사하고 정지/걷기/달리기와 네 방향을 확인한 다음 ready로 전환한다. 미리보기와 다운로드와 섬이 동일한 출력 GLB SHA를 가리켜야 한다. 변환이 적용된 파츠를 골랐을 때 이미 변형한 파츠에 같은 transform을 중복 적용하지 않도록 출력 identity를 구분한다.

## 버전과 증거에 묶인 승인과 재검수 제안

봉인한 `quality.json`을 승인 시 덮어쓰지 않는다. 기존 [verify_quality 182행](../backend/src/services/avatar_pipeline_quality.py#L182)은 품질 JSON, 결과, delivery, 산출물 SHA가 바뀌면 거절한다. 승인은 immutable 기술 영수증을 참조하는 별도 review record로 저장하고 API가 현재 산출물과 결합해 반환한다.

새 review record에는 reviewer와 권한, 검토 시각, 결정 `approved` 또는 `changes_requested`, notes, `job/version`, body와 part와 expression과 edit의 identity, 완성 GLB SHA, 품질 영수증 SHA, 검토한 렌더와 동작 증거 SHA를 포함한다. 클라이언트가 reviewer나 승인 시간을 지정하지 못하게 한다. 입력은 대상 ID, expected revision/SHA, decision, 실제 체크한 항목과 증거 ID로 제한한다.

기술 검사는 구조와 파일 무결성, rig와 클립, geometry/texture 예산, 처리 가능한 coverage, 편집 bounds를 판정한다. 시각 검토는 원사진에서 반영할 특징, 얼굴 닮음, 눈 가림, 네 방향 실루엣, 후면 헤어, 몸 침투, 의상 개구부, 걷기와 달리기 중 간섭을 사람이 확인한다. 자동 수치와 렌더 생성은 기술 증거이며 사람의 approval을 대신 쓰지 않는다.

상태는 제작 수락 → 편집본 처리 → 기술 검사 → `review_required` → `approved` 또는 `changes_requested`로 관리한다. 수정하면 기존 승인 이력을 지우지 않고 새 candidate를 `review_required`로 만든다. 승인 유효성은 현재 완성 GLB SHA, 전체 조합 fingerprint, 기술 영수증, 선택 표정과 색, 편집 계약이 승인 target과 모두 동일한지 서버가 계산한다.

파츠 새 버전, 사진 crop 변경, 변환 수정, 표정/색 변경, 최종 GLB 교체는 새 target이므로 이전 시각 승인을 승계하지 않는다. 승인 대상이 바뀐 경우 품질 UI가 정확한 변경 이유와 재검수 작업을 표시한다. 저장 옷장 조합의 최신 파츠 fallback도 승인 target을 바꾸므로 다시 검토한다.

승인 저장은 optimistic revision과 idempotency key를 검사한다. 다른 탭이 먼저 수정했거나 현재 모델 SHA가 달라지면 409로 거절한다. 시각 승인 후에도 산출물 조회의 SHA 검증을 유지한다. 개인 회원의 자기 모습 선택과 공용 라이브러리 운영 승인에는 각자의 승인 권한을 사용한다.

## 구현 순서와 완료 기준

1. **사진 준비**: 방향, crop, resize, 처리본 미리보기와 서버 정규화 영수증. 큰 JPEG, 회전 EXIF, 투명 PNG, 잘못된 crop, 손상 입력을 비용 없이 검증한다.
2. **native 승인 기록**: 별도 review 저장, 기존 품질 UI 결합, 정확한 version/SHA 증거, 수정 후 재검수. 다른 탭 충돌과 승인 대상 교체를 가짜 작업으로 검증한다.
3. **개인 편집본**: 한 몸과 검증한 헤어/얼굴부터 제한된 skinned deformation을 구현한다. 공유 원본 불변, 재접속 복원, 되돌리기, animation/표정 유지, coverage 재계산을 확인한다.
4. **최종 GLB 연결**: 편집본을 Look 구움에 전달하고 출력 GLB를 재입력한다. 미리보기/다운로드/섬의 SHA와 모양이 같아야 완료다. 기본값 편집은 기존 결과와 일치해야 한다.
5. **회원 사진 제작**: 회원 backend owner와 private assets, 별도 생성 capability/예산을 연결한다. 다른 회원 사진/작업 조회 거절, 기존 공용 옷장 읽기, 운영 파츠 관리가 각 소유권을 유지하는지 검증한다.

실제 개인 사진의 닮음, Meshy/Tripo 생성 성공, 사람의 최종 시각 승인은 가짜 서버나 build 통과로 검증했다고 보고하지 않는다. 현재 문서는 위 순서를 검토할 수 있게 정리한 설계이며 제품 구현을 변경하지 않았다.
