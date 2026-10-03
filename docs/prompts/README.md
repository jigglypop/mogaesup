# 매장 자동 배치 프롬프트 초안

이 폴더는 `store-layout-v1` 계획 계약과 오프라인 예제다. 제품 UI, LLM 호출 API, 실제 배치 컴파일러, MCP 서버에는 아직 연결하지 않았다.

1. [시스템 본문](store-layout.system.txt)을 시스템 프롬프트로 전달한다.
2. [입력 예제](store-layout.input.example.json)의 구조에 사용자 설명, 현재 월드 snapshot·revision, 사용 가능한 카탈로그와 측정 geometry를 채워 사용자 입력으로 전달한다.
3. [출력 스키마](store-layout.schema.json)를 모델의 JSON 출력 형식 또는 호출 후 구조 검사에 사용한다. [출력 예제](store-layout.output.example.json)는 `proposed_plan`이며 엔진의 `SaveBlob`이나 `/api/homes/me/world` 요청 본문이 아니다.
4. JSON Schema 검사 후 좌표, 참조, 모델 해시, footprint, 기존 객체·벽과의 충돌, 동선, 저장 크기를 별도 검증한다. 검증된 계획을 별도 store에서 미리 보고 사용자가 실제 결과를 확인한 뒤 기존 편집·되돌리기·저장 경로에 적용한다.

예제 `example-store-v1`은 빈 12m × 12m 공간을 가정한 fixture다. 실제 모개숲은 `minihome-v6`이고 이미 바닥·기물·주민이 있으므로 이 예제를 그대로 저장하면 안 된다. fixture를 현재 월드에서 읽은 결과로 표시하지 않는다. 실제 입력은 `baseline.source=runtime_snapshot`과 현재 revision을 사용하고 보호할 영역·기물, 외부 출입 경로도 포함해야 한다. snapshot 수집과 계획 실행은 별도 구현 작업이다.

타일은 4m, 객체 pivot은 1m 격자다. 엔진 전역 셀 중심은 `(4*x, topY, 4*z)`다. 기본 지도 배열 index는 엔진 cell `index-7`에 대응한다. 평지 바닥은 `topY=0`, 두께 `0.04m`, 바닥면 `-0.04m`다. 현재 엔진은 임의 슬래브 두께를 저장하지 않는다. 벽은 `tileId+edge`로 지정하고 엔진의 공개 edge 변환을 통해 컴파일해야 한다.

입력 카탈로그 resolver는 엔진 `DEFAULT_BUILDING_OBJECT_CATALOG`와 서버 `/api/catalog/items`의 published furniture를 합쳐야 한다. 예제 chair/table/lamp/shop-stall 네 ID는 vendor 엔진 카탈로그에서 읽었으며 Rust 공개 API 목록을 읽은 결과가 아니다. 서버 가구는 엔진 기본 배율 정보가 없으면 현재 편집 도구처럼 기본 배율 1을 명시하고 최종 geometry를 측정해야 한다.

sourceAssetSha256은 vendor 원본 해시이며 deliveredAssetSha256과 별개다. vite/gaesupAssets.ts의 public override와 빌드 meshopt 압축·quantize 때문에 원본·서빙 파일의 해시와 geometry는 달라질 수 있다. lossless 파생 파일로 가정하지 않는다. 예제 geometry는 원본 POSITION 정점과 scene node transform을 적용한 AABB이고, footprint는 그 AABB의 XZ 사각형을 배율·회전·위치로 변환한 보수적인 범위다. boundsStage=source_uncompressed는 예제 계산에만 사용한다. 적용 전 실제 서빙 GLB의 deliveredAssetSha256·deliveredBoundsM을 확보하고 재검수해야 한다. 실제 바닥, 충돌, 시각 품질과 사람의 검수는 이 범위 검사만으로 인증되지 않는다.

예제는 현재 snapshot, 외부 접근, 실제 서빙 모델 검증이 없어 status=blocked다. blockers 또는 failed가 하나라도 있으면 blocked이며, 없고 검증이 미완료면 draft다.

Python 3 표준 라이브러리만 사용하는 예제 검사를 실행할 수 있다.

```sh
python3 docs/prompts/validate-example.py
```

검사는 이 스키마에서 사용한 키워드, 예제 ID·좌표·높이·두께·참조, vendor GLB 해시와 측정값, 실제 footprint, 벽·통로 충돌 및 목표 접근을 확인한다. JSON Schema 전체 구현이나 production 배치 검증기가 아니다. fixture 외부 접근, 실제 revision, 렌더링 결과와 엔진 저장 크기는 검증하지 않는다. 예제의 `qualityChecks`와 미해결 조건은 수정하지 않는다.
