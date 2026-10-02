# 스튜디오 모델 보강 계획 · 2026-10-02

현재 확인된 파일과 아직 확인하지 못한 운영 재고를 구분한다. 이 문서는 새 유료 작업의 실행 영수증이 아니다.

## 확인 범위와 실제 증거

- 기존 로그인된 운영 관리자 화면에서 확인한 스튜디오 완성 모델은 **3개**, 가져오기·초안·공개 모델은 각각 0개다. 라이브러리의 해당 갤러리 필터에서 저장 파츠는 **107개**(기본몸 2, 헤어 19, 머리·장식 9, 상의 30, 하의 23, 신발 24), 휴지통은 157개로 별도 표시되었다. 이는 UI 재고이며 모두 품질 승인된 모델 수는 아니다. 헤어 19개 중 조립 완료 17, 생성 중단 2다.
- 첫 로컬 전신 GLB 표본은 **2종**이었다. 여성은 운영 기본 여성 `6cd3a71c00769378836c036d` / `466a31b98a08b0065715be77`과 같고, 첫 남성 표본은 이전 스튜디오의 별개 파일이다. 현재 운영 기본 남성 `c9b23638d84dd5b851764cef` / `38397fdd68583e147834cb0b`는 `admin-male.glb`로 추가 다운로드하여 별도로 검사한다.
- 저장소의 `frontend/src/character/studio/garment-styles.json`에는 **27개 디자인 문장**이 있다: 상의 12, 하의 6, 신발 5, 모자 4. 이는 생산·승인된 3D 모델 27개라는 뜻이 아니다.
- 운영 DB/provider 계정의 SSM 재고 수집 요청은 자동 승인 검토에서 실행 전에 거절되었다. 재시도하거나 다른 경로로 우회 수집하지 않았다. 운영 전체 목록은 기존 로그인된 제품 화면에서 필요한 범위를 별도로 확인한다.
- 잔액은 기존 `backend/.env`에 설정된 계정의 읽기 전용 GET으로 확인했다. 값·확인 시간은 `.data/audit/studio-quality/local-facts.json`에 있다. 운영 컨테이너 계정과 동일한지는 확인하지 않았다. 유료 POST, 구매, 재제출은 0회다.

| 표본 | 원본 파일 | 삼각형 | 정점 | glTF 재질 | 본 | 기본 동작 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| female | 10,790,688 B | 44,406 | 28,712 | 3 | 24 | idle, walk, run, jump, fall |
| male | 20,362,140 B | 33,109 | 21,531 | 8 | 24 | idle, walk, run, jump, fall |
| admin-male 현재 운영 | 7,759,664 B | 15,181 | 10,843 | 2 | 24 | idle, walk, run, jump, fall |
| female-hair-a 조립본 | 10,541,420 B | 42,367 | 28,533 | 2 | 24 | idle, walk, run, jump, fall |
| female-hair-g 조립본 | 13,973,676 B | 43,756 | 29,247 | 3 | 24 | idle, walk, run, jump, fall |

원본 구조 검사는 두 파일 모두 오류 0개다. 2K 텍스처 정책으로 검사하면 둘 다 텍스처 예산 경고가 나온다. 전체 내장 이미지 픽셀 합은 female 41,943,040, male 58,720,256이다. 모든 이미지가 RGBA8로 상주한다고 가정한 기본 레벨만 각각 160/224 MiB이며, 실제 GPU 메모리 측정값은 아니다.

기존 Rust 검증은 메모리 내 웹 파생본도 검사했다: female 2,195,524 B, male 2,428,268 B, 텍스처 최대 1024px, 두 결과 `webPlayable=true`. 아직 이 파생 GLB를 디스크나 운영 저장소에 새 자산으로 저장하지 않았다.

Blender 5.2.1 LTS의 독립 CPU 프로세스에서 기존 백엔드 조명·카메라 함수를 사용해 두 원본의 정면/측면/후면/반대 측면을 렌더링했다. 기본 장면 오브젝트와 glTF importer의 본 표시용 widget을 제외했다. 원본 바이트는 보존했다.

- [4방향 비교](../.data/audit/studio-quality/authored-four-views.png)
- [female 렌더 영수증](../.data/audit/studio-quality/female/render-receipt.json), [male 렌더 영수증](../.data/audit/studio-quality/male/render-receipt.json)
- [독립 정적 검사](../.data/audit/studio-quality/static-inspection.json)
- 원본 SHA256: female `5f8b4dfb53db4a80e1e3e1282a93ecd280e8f5f3c4a469c59c6a8d2a07ae9066`, male `af681744bf1a0fa08a86491224dfbb2b6b183551b303b7628694266854f93c8a`.
- [현재 운영 여성·남성 4방향](../.data/audit/studio-quality/current-admin-four-views.png), [헤어 a/g 4방향 비교](../.data/audit/studio-quality/hair-a-g-four-views.png), [추가 파일 정적 검사](../.data/audit/studio-quality/current-part-inspection.json)

## 표본에서 드러난 보강점

1. 두 파일의 실제 렌더 재질은 이미 무광이다(roughness 약 0.95, metalness 0, 두 맵 연결 없음). 무광 비교 렌더에서 큰 변화가 없다. 원격 아바타가 전체 분홍색이 되는 문제는 원본 재질의 광택으로 해결할 문제가 아니며, 엔진의 자동 전체 tint와 로컬/원격 재질 정책 차이는 별도로 수정했다.
2. female의 후면은 이 표본에서 닫혀 있다. 과거 작업에서 보고된 뒤통수 구멍을 이 모델에도 있다고 단정하지 않는다. 앞머리는 정면에서 눈의 상단을 많이 가리므로 신규 스타일에서는 눈 가림 정도를 검수 항목으로 둔다.
3. male은 체크 셔츠·데님 하의·신발이 들어 있고 female은 기본복과 헤어를 포함한다. 새 의상을 덧씌울 때 기본복/기존 의상에 대한 가림 처리가 필요하다. 남성 표본의 헤어가 없는 상태는 교체용 기본 몸에서 가능한 상태다.
4. 두 파일은 본 이름 24개가 같지만 inverse-bind matrix의 최대 원소 차이는 약 0.00255다. 이름만 같다는 이유로 다른 몸의 스킨 바인딩을 그대로 바꾸지 않는다. 몸 GLB SHA, 리깅·피팅 버전을 고정한다.
5. 원본 텍스처가 모바일 웹에 비해 크다. 먼저 기존 웹 파생 경로를 저장·검수하고 원본/편집본과 배포본을 분리한다. 생성 모델을 다시 구매할 이유가 되는 문제는 아니다.
6. 현재 파츠별 최대 삼각형 예산을 동시에 사용하면 몸+헤어+상의+하의+신발+모자 합이 110,000개다. 기본 전체 DeliveryPolicy 100,000개보다 크다. 신규 묶음은 파츠별 상한뿐 아니라 조립 전체 상한도 검사한다.

## 실제 무료 보강 1건: 헤어 a

운영 UI에서 다운로드한 a의 원본은 job `dbe9e9656c8fc069518f53b1`, native version `c76f7ae3d814f0949df7c200`이다. `body.glb`, 피팅된 `hair.glb`, 제공자의 `generated-hair.glb`를 추가로 보존했다. 원본 생성기는 GLB 메타데이터상 Tripo이고, 기존 작업 계약에 따라 +X 정면을 피팅 기준 +Z로 회전한다. 후면 원화 `hair-back.png`는 404였으며, 확보한 후면 원화가 있다고 주장하지 않는다.

- a의 정면은 눈·이마가 보이나 후면 중앙에 큰 피부 구멍이 실제로 보인다. g는 후면이 닫혔지만 눈을 가리는 앞머리와 bun+긴 웨이브가 헤어 자체에 함께 있다. g의 body 노드만 렌더하면 완전한 민머리여서 기존 몸에 붙은 머리의 중복이 아니다.
- **v1 기술 후보**는 기존 `add_scalp_cap`로 2,147개 삼각형의 두피 보강면을 더했다. 원본 몸·가닥·UV·스킨·동작의 모든 기존 glTF table entry와 BIN 전체 prefix는 바이트 동일하다. 새 GLB를 다시 불러와 4방향과 walk 25%의 4방향을 확인했다. 후면 구멍은 닫혔으나 넓은 매끈한 갈색 패치라 스타일 품질 승인에는 부족하다는 검수를 받았다. `review_required`로 유지한다.
- **v2 형태 후보**는 원본을 보존한 채 뒤 정수리에서 중앙·목 뒤·아래 웨이브로 이어지는 넓은 머리 흐름 mesh를 추가한다. 9개 큰 clump, 7,092개 추가 삼각형, 헤어 전체 39,095개로 기존 40k 상한 안이다. 앞머리·눈·이마의 원본 geometry를 바꾸지 않는다. 이 후보는 후면 원화를 복원한 결과가 아니라 로컬 조형 후보이며, 운영 자산으로 자동 승인하지 않는다.
- 별도로 기존 `avatar_native_parts_blender.py`를 저장된 몸+generated 헤어에 실제 실행했다. 몸을 고정하고 얼굴 텍스처를 유지한 상태에서 새 `model/body/hair.glb`, 4방향, motion, `complete.json`을 만들었다. 헤어 29,856→32,003, 조립 44,514개 삼각형, 24본과 기존 동작이 남고 구조 오류는 없다. 전체 재피팅은 Blender의 재출력으로 컨테이너·일부 부동소수점 값이 달라질 수 있으므로, v2의 원본 바이트 보존을 이 경로에도 그대로 주장하지 않는다.
- 기존 native 결과에서 별도 **1024px 웹 파생본** 3개를 만들었다. 조립 3,260,944 B, 몸 1,434,084 B, 헤어 2,022,264 B이고 1K 정책 구조 오류·예산 경고는 없다. geometry·UV·skin·animation accessor bytes와 관련 glTF tables는 그대로 유지하고 내장 이미지와 BIN 배치만 바꿨다. 원본과 편집 GLB는 보존한다.

모든 후보는 로컬 `.data/audit/studio-quality/`에 있으며 유료 제출·운영 업로드는 0회다. 운영 UI의 실제 refit 실행은 배포 담당이 한 건부터 진행하고, 그 서버 버전·검수 결과와 로컬 후보를 별도로 기록한다. 로컬 파일이 생겼다는 이유로 운영 라이브러리 보강 완료나 대량 품질 승인으로 취급하지 않는다.

- [v1 원본·보강·걷기 비교](../.data/audit/studio-quality/female-hair-a-refit-v1/before-after-walk.png)
- [v1 품질 영수증](../.data/audit/studio-quality/female-hair-a-refit-v1/quality-record.json)
- [v2 품질 영수증](../.data/audit/studio-quality/female-hair-a-refit-v2/quality-record.json)
- [기존 native 실행 영수증](../.data/audit/studio-quality/female-hair-a-native-refit-v1/complete.json), [웹 파생 영수증](../.data/audit/studio-quality/female-hair-a-native-refit-v1/web-1024/web-derivative-receipt.json)

## 네 가지 무료 헤어 후보와 연결 경로

원본 a의 후면을 보강한 롱 웨이브, 하단 곡률을 유지한 미디엄 웨이브, 목 주변으로 둥글게 정리한 단발, g의 눈을 드러낸 핑크 번을 만들었다. 색상 복제 네 개가 아니라 서로 다른 geometry의 로컬 후보 네 개이며, 원본 몸·UV·스킨·동작 파일은 보존했다. 각 후보의 1K 헤어는 2.6~2.9 MB이고 헤어 삼각형은 40,000개 이하이다. 정면·양 측면·후면·걷기 렌더를 확인했으며 사람의 품질 승인 상태는 변경하지 않았다.

기존 미리 맞춰진 헤어를 unrigged 입력으로 바꾸어 다시 피팅하면 g의 앞머리가 늘어나 눈을 다시 가리는 문제가 실제 Blender 재현에서 나왔다. 따라서 소유자가 업로드한 native hair만 기존 `fit` 경로에서 형태를 보존한다. 본 이름·부모·world rest·inverse-bind·동작·정규화된 Head 계열 스킨·명시적 hair 태그·40k/2K 예산이 고정한 몸과 일치해야 하며, 잘못된 입력은 착용 불가로 기록한다. 제공자가 만든 리깅 파츠에 이 예외를 주거나 새로운 HTTP action을 추가하지 않는다. 기존 일반 파츠 피팅과 sealed prefit 경로는 유지한다.

`backend/infra/import-studio-glb.py --fitted-native-hair`는 고정한 로컬 SHA·운영 몸 job/version/SHA를 실제 파일과 대조한 뒤 기존 업로드→라이브러리 등록→fit API를 호출한다. 요청 키와 의도 영수증은 POST 전에 저장하며 불확실한 응답은 동일 요청 조회로 복구한다. 접수된 fit에는 여섯 공급자 예산이 모두 0이어야 한다. 기존 owner-1 운영 채널을 사용하므로 Rust의 월간 요청 집계를 통과하지 않으며, 이 사실을 영수증에 남긴다. 운영 키를 출력·파일 저장하거나 다른 소유권을 가장하지 않는다.

실제 Blender 조립 경로에 네 후보를 넣고 다시 GLB를 불러온 결과, 네 헤어 모두 출력 `hair.glb`가 입력과 SHA256까지 동일했고 원본 몸도 바뀌지 않았다. 전체 조립본의 기존 몸 텍스처는 원본 예산 경고가 있어 1K 웹 파생본을 별도로 만들었으며, 파생본은 구조·텍스처 예산 검사와 정면·양 측면·후면·walk 25% 재입력 렌더를 통과했다. [조립 후 네 스타일 비교](../.data/audit/studio-quality/strict-native-four-styles.png), [기술 영수증](../.data/audit/studio-quality/strict-native-fit-acceptance.json).

운영 등록과 옷장 미리보기 검수는 이 경로가 실제 배포된 뒤 실행한다. 아래 로컬 결과가 운영 등록 완료를 뜻하지 않는다.

- [a 롱 웨이브](../.data/audit/studio-quality/female-hair-a-refit-v2/)
- [a 미디엄 웨이브](../.data/audit/studio-quality/female-hair-a-medium-v1/)
- [a 라운드 단발](../.data/audit/studio-quality/female-hair-a-bob-v1/)
- [g 핑크 번](../.data/audit/studio-quality/female-hair-g-refit-v1/)

## 공통 신규 스타일 규격

규격은 현재 `backend/assets/avatars/production-v1.json` revision 22를 기준으로 동결한다. 단위는 미터, +Y 위, +Z 정면, 바닥의 양발 사이가 원점, **몸 높이 1.2m**다. 헤어·모자까지 포함한 전신 bbox를 1.2m로 강제로 줄이지 않는다. 저장된 몸의 앵커·캔버스·스킨·표정 UV를 유지한다.

- 대두 SD, 큰 형태 위주, 매끈한 무광, 작은 장식·로고·글자·실사 주름 제외. 기존 귀·눈·얼굴 실루엣은 보존한다.
- 팔을 편 동일한 T 자세, 직교 정면/오른쪽 측면/후면 3장을 필수로 하고 비대칭 스타일은 반대 측면도 추가한다. 후면을 정면과 별개 디자인으로 생성하지 않는다.
- 현재 2048×2048 캔버스, 중심 X=1024, 발바닥 Y=1800, 머리 기준 Y=300을 그대로 쓴다.
- 색상은 cream `#E9E1CE`, butter `#EAD97D`, mint `#98BCA9`, navy `#344A67`, coral `#CD8E7D`, cocoa `#6A5048` 중심으로 제한한다. 원화의 파츠 색을 보존하며 플레이어 이름표 색으로 모델 전체를 칠하지 않는다.
- 헤어는 정수리·양옆·후면을 연결하고 얼굴·목 구멍과 두상 안쪽 공간을 남긴다. 의상은 목·소매·밑단 개구부를 남기고 몸·피부·손·다른 파츠를 섞지 않는다.
- 배포 텍스처는 최대 2K, 기본 월드 파생본은 1K부터 검수한다. 신규 단순 파츠의 목표는 헤어 20k, 상의 12k, 하의 8k, 신발 6k, 모자 5k 삼각형이고 조립 전체는 80k 이하를 목표로 한다. 이 수치는 검수 목표이며 현행 파이프라인이 모든 결과에 이미 달성한다고 주장하지 않는다.
- 색만 다른 복제는 색상 변형으로 세고, 모델 가짓수는 서로 다른 실루엣/geometry hash의 승인된 스타일로 센다.

## 1차 12개 후보

인접한 `studio-style-candidates-2026-10-02.json`은 실행 전 규격·디자인 후보다. 실제 target body/job/version, 기존 라이브러리 중복 여부, 예산을 확인한 뒤 서버의 기존 작업 계약으로 제출한다.

| 파츠 | 후보 |
| --- | --- |
| 헤어 4 | 단정 숏컷, 귀밑 둥근 단발, 어깨 길이 스트레이트, 낮은 묶음머리 |
| 상의 3 | 크림 반팔 티, 버터 후드티(후드 내림), 민트 단순 가디건 |
| 하의 2 | 네이비 스트레이트 반바지, 코랄 A라인 치마 |
| 신발 2 | 크림 로우탑 운동화, 코코아 둥근 로퍼 |
| 모자 1 | 네이비 단순 베레모 |

처음에는 짧은 헤어 1개와 상의 1개만 후보로 만들고, 같은 몸에 입힌 4방향·걷기 검수를 통과하면 남은 10개를 같은 규격으로 확장한다. 기존에 승인된 동일 스타일이 있으면 새 유료 작업 대신 재사용한다. 추가 12개/24개 확장은 승인된 첫 묶음과 실제 영수증 단가로 산정한다.

## 공식 단가와 비용 경계

2026-10-02 확인: Meshy meshy-7.1/6의 textured multi-image 2K/4K는 30 credits, 8K는 35, Ultra geometry는 +5다. Rig 5, animation 3/action. [Meshy API 가격](https://docs.meshy.ai/en/api/pricing)

Tripo H-series standard textured image/multiview는 30 credits, 1 credit=USD 0.01이다. HD geometry +20, HD texture +10. 저장소 기본은 `v3.1-20260211`, standard geometry/texture, PBR다. [Tripo API 가격](https://developers.tripo3d.ai/en/pricing), [multiview 계약](https://developers.tripo3d.ai/en/docs/generation-multiview-to-model/standard)

따라서 **새 파츠 12개 3D만 약 360 credits**가 기준이다. Tripo로 전부 생성하면 3D 기본 단가 약 USD 3.60이며, **2D 원화 생성·재텍스처·재리깅·애니메이션·재시도는 포함하지 않는다**. 기존 몸의 24본과 기본 동작을 재사용하면 새 몸/리깅/동작을 다시 구매하지 않아도 된다. 현재 잔액을 작업 실행 허가나 총 현금 예산으로 취급하지 않는다.

유료 호출은 사용자가 지정한 총 지출 상한과 2D/3D 대상이 확정된 뒤 기존 durable job·idempotency 경로로 실행한다. 402/2010·불확실 접수·provider 실패가 나오면 같은 그림을 자동 재제출하지 않고 저장된 task ID와 영수증부터 확인한다.

## 무료 보강과 검수 순서

1. 운영 UI의 기존 목록에서 unique geometry/hash, 파츠 종류, 현재 버전, 기본 몸 연결, 기술 통과/시각 승인, 실패/접수 불확실 상태를 확인한다. 오래된 재고 숫자를 현재 숫자로 재사용하지 않는다.
2. 지금 가진 2종의 웹 파생 GLB를 새 버전으로 저장하고 구조/본/클립/텍스처/크기 검사를 반복한다. 운영 업로드·선택 변경은 배포 담당과 순서를 맞춘다.
3. 기존 저장 헤어는 원본·착용 파생본·뒷면 원화를 대조하고, 빈 뒤통수가 실제로 있는 1건에만 현재 `native-parts-v14-matte-limb-fit` refit을 먼저 적용한다. 후면 cap을 모든 헤어에 일괄 덧붙이지 않는다.
4. 기존 의상은 공통 몸 SHA와 `garment-fit-v1` profile을 묶어 소매/허리/밑단 개구부, 관절 변형, 기본복 가림을 검사한다. 검증된 기본 동작과 스킨을 보존한다.
5. `POST /api/avatar-factory/jobs/{id}/native-parts/refit`의 기존 action/state/잠금 계약을 사용한다. 원본 버전은 유지하고 새 `review_required` 후보를 만든다. 서버의 `next_actions`를 따르고 강제로 실패 상태를 성공 처리하지 않는다.
6. 각 후보에서 원본 SHA, 새 GLB SHA, 삼각형/재질/내장 텍스처 크기, 본/클립, 정면/측면/후면/반대 측면, 걷기 중간 프레임을 기록한다. 독립 로컬 metrics는 `uv run asset-quality <assembly-folder>`로 비교한다. 렌더 생성·빌드 통과와 사람의 시각 승인은 별도 상태다.
7. 앱에서는 같은 GLB hierarchy·figure material policy의 로컬/원격 모습을 비교하고 걷기→정지의 방향·표정·재질을 확인한다. CPU Blender 렌더를 WebGPU/GPU 검증 완료로 보고하지 않는다.

`game-dev` CLI는 현재 PATH에 없어 해당 CLI의 doctor/normalize/package 명령을 실행하지 않았다. 이 저장소의 기존 GLB inspector와 Blender 서비스를 사용했고, `Game Asset Production` 스킬의 원본 보존·유료 상한·증거 단계 구분을 적용했다.
