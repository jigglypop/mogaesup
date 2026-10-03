# 매장 기물과 캐릭터 의상 수집 계획

아래 후보 목록은 착수 시점의 출처 조사다. 이후 블루종 참조 이미지 1장과 Meshy GLB 1개를 실제 생성해 의상 brief는 28개가 되었고 스타일의 네 방향·와이어프레임 미리보기와 텍스처 참조 업로드를 연결했다. GLB는 리깅 전 디자인 참조이며 착용 카탈로그에 승인한 파츠는 아니다. [생성 기록](generated-assets-2026-10-03.json), [최종 구현 보고](implementation-2026-10-03.md)

2026년 10월 3일 확인한 코드와 공식 출처를 바탕으로 재사용할 기물, 외부 수집 경로, 의상 스타일 후보를 정리했다. 먼저 기존 모델을 골라 실제 크기와 공통 몸 호환성을 확인하고, 필요한 형태가 없을 때 외부 모델이나 새 제작 후보를 추가한다. 이번에는 출처와 디자인 후보만 수집했다. 외부 모델 다운로드·정규화·리깅·운영 등록이나 유료 생산을 완료한 목록은 아니다.

기계가 읽는 출처·후보 목록은 [asset-source-catalog-2026-10-03.json](asset-source-catalog-2026-10-03.json)이다. `source_verified`는 출처 설명을 확인했다는 뜻이며 `ready`나 품질 승인을 뜻하지 않는다.

## 기존 코드와 에셋

- [scripts/props/manifest.json](../scripts/props/manifest.json): 기물 설명 69개. furniture 32, tree 23, prop 14이며 카페 테이블·정원 벤치·가판대·책상·의자 등을 포함한다. 생성 요청 명세이고 생성 완료 재고가 아니다.
- [garment-styles.json](../frontend/src/character/studio/garment-styles.json): 의상 brief 27개. 상의 12, 하의 6, 신발 5, 모자 4. 후드티·가디건·셔켓·와이드 팬츠·플리스·로퍼 등 기존 문장을 재사용할 수 있다.
- [studio-style-candidates-2026-10-02.json](studio-style-candidates-2026-10-02.json): 이전에 정한 헤어·옷·신발·모자 제작 후보. 승인된 파츠인지 현재 라이브러리에서 대조한 뒤 재사용 또는 제작을 선택한다.
- [props-normalize.mjs](../frontend/scripts/props-normalize.mjs): 기존 기물의 실제 크기에 맞춰 바닥 중심과 방향을 맞추고 무광·512px 텍스처의 웹 GLB를 만든다. 새 외부 패키지를 아무 처리 없이 등록하는 도구는 아니다.

## 공식 수집 출처

| 출처 | 확인한 내용 | 모개숲에 활용할 범위 |
| --- | --- | --- |
| [Kenney Furniture Kit](https://kenney.nl/assets/furniture-kit) | 3D 가구 140개, CC0, 2018년 출시 | 테이블·의자·수납장·조명의 부족한 형태. 실제 파일을 검사한 뒤 현재 섬의 작은 무광 형태에 맞춘다. |
| [Kenney Building Kit](https://kenney.nl/assets/building-kit) | 건축 기물 80개, CC0, 2024년 출시, 애니메이션 포함 | 문·창·벽 장식 후보. 배치 엔진의 벽/타일과 직접 호환되는지는 별도 검사한다. |
| [Poly Haven](https://polyhaven.com/license) | 에셋은 CC0. 모델·텍스처·HDRI 제공 | 단순 나무·석재 바닥 재질과 필요한 기물 후보. 원본의 실사 형태·고해상도를 그대로 제품에 넣지 않는다. |
| [Poly Haven API](https://polyhaven.com/our-api) | 2026-07-18 안내 기준 상용 무료, 고유 User-Agent와 사용자에게 보이는 출처 표시 요구 | `/assets`로 목록, `/files/{id}`로 파일 링크·크기·해시를 얻는 서버 수집 어댑터 후보. CC0 에셋 조건과 live API 조건을 구분한다. |

위 공식 페이지에서 라이선스·범위를 확인했다. 실제 모델별 geometry·skin·외부 파일 참조·압축 확장·치수는 다운로드 후 검사해야 한다. API 자동 수집은 제품의 출처 필드와 캐시를 연결한 뒤 구현한다.

## 최신 의상 참고와 모개숲 후보

공식 [Uniqlo U 2026 가을겨울 컬렉션](https://www.uniqlo.com/jp/ja/women/special-collaboration/uniqlo-u)에서 짧은 플리스 재킷·유틸리티 재킷·울 혼방 짧은 코트 등 현재 컬렉션 항목을 확인했다. 일본 공식 안내의 판매 시작일은 [2026-09-11](https://faq.uniqlo.com/articles/Knowledge/100015686/?l=ja)이다. 한 브랜드의 현재 항목이라는 근거이며 전체 시장의 유행 순위를 입증하지는 않는다.

이 항목과 기존 스타일 문장을 참고하여 다음 여섯 디자인을 제안한다. 색과 단순화 방식은 모개숲용 제안이다. 브랜드 사진과 로고를 재배포 에셋으로 수집한 것은 아니다.

| 파츠 | 디자인 제안 | 기존 코드에서 재사용할 근거 |
| --- | --- | --- |
| 상의 | 오트밀 짧은 플리스 집업, 둥근 칼라와 큰 지퍼만 남김 | 기존 뽀글이 플리스 집업 brief |
| 상의 | 카키 유틸리티 셔켓, 큰 앞주머니 두 개와 단순 밑단 | 기존 코듀로이 셔켓의 외곽 형태와 현재 공식 유틸리티 재킷 참고 |
| 상의 | 코코아 짧은 코트, 넓은 칼라와 큰 버튼 | 현재 공식 짧은 코트 항목 참고 |
| 하의 | 네이비 와이드 스트레이트 팬츠 | 기존 와이드 카고/와이드 데님의 실루엣을 장식 없이 단순화 |
| 신발 | 크림 로우 프로파일 운동화 | 기존 레트로 스웨이드 스니커즈 brief |
| 신발 | 코코아 둥근 로퍼와 크림 양말 | 기존 로퍼와 흰 양말 brief |

원본 문장 중 광택을 요구하는 항목은 모개숲의 무광 정책과 맞춰 별도 후보 brief로 수정한다. 광택 파츠를 전체 흰색으로 덮거나 UV·얼굴 텍스처를 지우는 방식으로 통일하지 않는다.

## 수집 에셋 저장 계약 제안

현재 외부 출처 저장 API는 없다. 다음 필드를 가진 `asset-source-v1` 기록을 새로 제안한다.

| 필드 | 저장 의미 |
| --- | --- |
| `sourceUrl`, `author`, `license`, `verifiedAt` | 원본 출처와 확인 날짜 |
| `sourceSha256`, `artifactSha256`, `derivativeOf` | 받은 원본과 앱용 파생본의 연결 |
| `units`, `axes`, `pivot`, `bounds`, `footprint` | 정규화 전후 실제 치수와 배치 충돌 기준 |
| `kind`, `tags`, `styleRevision` | 기물/의상 종류와 디자인 검색 |
| `targetBodyJob`, `targetBodyVersion`, `targetBodySha256` | 의상·헤어가 맞춰진 정확한 몸 |
| `triangles`, `textureMaxEdge`, `bytes`, `skin`, `clips` | 구조·파일 예산 검사 결과 |
| `technicalStatus`, `reviewId`, `publicationStatus` | 기술검사, 시각 승인, 서비스 공개를 별도 상태로 기록 |

캐릭터 몸은 [production-v1.json](../backend/assets/avatars/production-v1.json)의 1.2m·T pose·+Y 위·+Z 정면 규격을 사용한다. 외부 의상의 뼈 이름이 같아도 rest matrix·inverse bind가 다른 경우 같은 몸에 호환되는 것으로 인정하지 않는다.

## 첫 수집 묶음과 검수

첫 매장 묶음은 테이블·의자·카운터 또는 가판대·조명·식물의 다섯 종류로 제한한다. 의상은 헤어 한 종류와 상의 한 종류부터 같은 몸의 정면·양 측면·후면·걷기로 확인한다. 여섯 디자인을 한 번에 생산하는 요청으로 해석하지 않는다.

수집 순서는 후보 목록 → 중복 SHA/실루엣 확인 → 원본 보존 → 치수·방향·피벗·텍스처 정규화 → 구조검사 → 네 방향/동작 검수 → 승인 버전 등록 → 배치 카탈로그에 실치수 제공이다. 신규 기물은 캐릭터 가져오기 API에 prop 작업 ID를 넣는 대신 별도 기물 import 경로를 연결해야 한다. 그 코드 경계는 [프로그램 분석](program-analysis-2026-10-03.md)과 [API 및 MCP 명세](studio-api-mcp-spec.md)에 정리했다.
