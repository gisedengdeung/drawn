# 파라메트릭 뷰어·편집 — 미뤄온 것들과 수정 지점

> 작성 2026-09-28 · 브랜치 `parametric-functions-change` · 기준 커밋 `cfdfeb7`
> **짝 문서**: `docs/PARAMETRIC_EDITOR_HANDOFF.md` — 편집 로직 재설계의 구조 분석·구현 단계·결정 사항.
> **후속 문서**: `docs/PARAMETRIC_PLAN_B_HANDOFF.md` — 플랜 A 완료 타임라인과 P서버 기반 플랜 B.
> 이 문서는 그 문서가 다루지 않는 **"계속 미뤄서 못한 것들"** 과 **파일·함수 단위 수정 지점**을 담는다.

---

## 0. 먼저 읽는 순서

1. 이 문서 — 무엇이 밀려 있고 어디를 고쳐야 하는지
2. `docs/PARAMETRIC_EDITOR_HANDOFF.md` — 편집 로직을 어떻게 다시 설계할지
3. 실제 코드

---

## 1. 뷰어는 어떻게 만들어져 있나

`components/parametric-uav-viewer.tsx` (2,362줄). 형상을 만드는 경로가 **둘**이고, 이 구분이 아래 모든 이야기의 전제다.

```
draft 변경
   │
   ├─ assembly.placements 있음  →  buildFromPlacements()   1155행~
   │     STEP 원본 좌표 + 실측 치수                          ← 27,714개 전부 이 경로
   │
   └─ 없음                      →  buildAircraft()          843~1154행
         파라미터로 추정하는 개념 형상                        ← 사실상 죽은 경로
```

`scripts/prepare-part-placements.mjs`가 STEP에서 좌표를 뽑아 `public/data/part-placements/`(1,405파일)에 저장하므로 **모든 설계가 placements를 가진다.** 즉 `buildAircraft()`는 데이터 로딩이 실패했을 때만 쓰인다.

**이 사실이 중요한 이유**: 아래 3-A에서 보듯, 일부 슬라이더는 `buildAircraft()`에만 반영되어 있어 실제로는 아무 효과가 없다.

### 편집이 형상에 닿는 경로

```
design-lab-view.tsx  mutateDraft()      슬라이더 → draft 수정
        ↓
parametric-uav-viewer.tsx  buildFromPlacements()
        ↓
  ① baseLengthByKey     sourceParameters 의 Arm_*_Length 를 키로 수집
  ② armKeysOfSegment    draft.segments[i] ↔ 파라미터 키 매칭 (길이 근접도 2%)
  ③ lengthByKey         편집된 길이로 덮어씀
  ④ editedArms          각 팔의 회전·이동 보정(Adjustment) 생성
  ⑤ rotorAdjustment     조립 트리의 바깥쪽 subtree 에 보정 전파
  ⑥ 부품별 mesh 생성     placeOf(part) 로 보정된 좌표에 배치
```

---

## 2. 계속 미뤄온 것들

우선순위 순. 각 항목의 수치는 이번에 코드/데이터로 다시 확인한 값이다.

### 2-A. 회전축이 보정 체인을 따라가지 않는다 ⚠ 편집 기능의 핵심 결함

`장착 각도` 슬라이더가 어긋난다. **길이 편집은 고쳤지만 각도는 한 번도 검증하지 않았다.**

```
parametric-uav-viewer.tsx:1515   const along = outwardFrom(arm, spinChain(toDirection(arm.z), chain), centre);
                                                              ↑ 체인 회전이 반영된 축
parametric-uav-viewer.tsx:1534   const axis = basisOf(part)[2];
                                       ↑ 체인 회전이 반영되지 않은 축
parametric-uav-viewer.tsx:1637   orient(bar, axis);
                                       ↑ 안 돌아간 축으로 부품을 세움
```

보정 쪽(1515)과 렌더 쪽(1534)이 **서로 다른 축을 쓴다.** 안쪽 마디를 회전시키면 바깥 부품의 위치는 따라오지만 **방향이 따라오지 않는다.**

**고칠 곳**: `buildFromPlacements()`의 부품 루프 시작부(1534행). `basisOf(part)`를 체인으로 돌린 값으로 바꾸고, `orient()`·`orientToBasis()`를 쓰는 모든 분기를 함께 점검.

### 2-B. 관절이 팔 사이를 메우지 못한다

관절(BEND·BRANCH·CROSS·FLANGE)을 **실측 크기 상자로만** 그린다.

```
parametric-uav-viewer.tsx:1649   new THREE.BoxGeometry(size[0], size[1], size[2])
```

팔을 늘리면 팔은 길어지는데 관절은 제자리 크기라, 이음매에 관절 두께만큼(약 20mm) 틈이 남는다. 편집 전에는 원본 좌표라 맞물리지만 편집 후에는 다리를 놓지 못한다.

```
관절류 부품 약 280,562개 (전체 1,317,521개의 21%)
```

굽은 관(elbow)으로 그리는 것은 오래전부터 backlog에 있었으나 "3초 안에 눈에 안 띈다"는 이유로 계속 밀렸다. **편집 기능에서는 눈에 띈다.**

### 2-C. 효과가 없는 슬라이더가 있다

`형상만` 배지가 붙은 슬라이더 중 일부는 **주 경로에서 아무것도 하지 않는다.**

| 슬라이더 | 위치 | 뷰어에서 쓰이는 곳 | 실제 효과 |
|---|---|---|---|
| 내부 배치 X·Y | `design-lab-view.tsx:493` | `parametric-uav-viewer.tsx:1131` | **없음** — `buildAircraft()` 전용 |
| 동체 바닥 높이 | `design-lab-view.tsx:449` | `parametric-uav-viewer.tsx:882` | **없음** — `buildAircraft()` 전용 |
| 탑재 화물 질량 | `design-lab-view.tsx:484` | 14곳 | 있음 (화물 상자 크기) |

`draft.layout`은 1131행에서만 쓰이고 그 행은 `buildAircraft()`(843~1154) 안이다. `floorHeight`도 882행 하나뿐으로 같은 경로다. **placements가 항상 있으므로 두 슬라이더는 어떤 설계에서도 형상을 바꾸지 않는다.**

선택지는 셋 중 하나다 — `buildFromPlacements()`에 반영하거나, 슬라이더를 감추거나, "이 값은 형상에도 반영되지 않음"을 명시.

### 2-D. 파라미터↔부품 연결이 휴리스틱이다

`armKeysOfSegment`는 **길이 값이 2% 안에서 가장 가까운** 파라미터를 짝으로 고른다. 이름이 아니라 숫자로 맞추는 방식이다.

```
parametric-uav-viewer.tsx  armKeysOfSegment 생성부
  for (const target of armTargetsOf(original)) {
    ... Math.abs(value - target) 가 가장 작은 키 선택
    if (!best || error >= Math.max(target * 0.02, 1)) return;   // 실패하면 조용히 포기
  }
```

현재 전수에서 100% 연결되지만, **길이가 같은 팔이 여럿이면 어느 것이 어느 것인지 보장이 없다.** 편집 대상이 인스턴스 단위로 내려가면 이 방식은 깨진다. HANDOFF 문서 7.2가 같은 문제를 다룬다.

### 2-E. 원본 STL 12개는 `성능 확인`에서 편집이 반영되지 않는다

그 탭은 `ModelStage → StlViewer(design.modelPath)`로 **원본 `.stl` 파일을 그대로 읽는다.** 나머지 27,702개는 파라메트릭이라 반영된다. 같은 설계인데 탭을 옮기면 형상이 달라 보인다.

의도된 구분일 수 있어(그 화면은 "기준 설계 원본 시뮬레이션"이다) 사용자 판단이 필요하다.

### 2-F. 연결이 끊긴 설계 26개 (0.1%)

STEP 파서 버그를 고치면서 129개 → 26개로 줄었으나 **나머지 26개는 원인을 조사하지 않았다.**

### 2-G. 날개 `taperOffset` 앞전 방향 미검증

날개 테이퍼가 앞전 쪽인지 뒷전 쪽인지 확인한 적이 없다. 좌우가 뒤집혀 있어도 지금은 알 방법이 없다.

### 2-H. `public/data` 367MB · 압축 미설정

```
design-trees      216 MB     gzip 17MB  · brotli 8MB
part-placements   132 MB     gzip 19MB  · brotli 15MB
design-index       19 MB     gzip 2.2MB · brotli 1.5MB
────────────────────────────────────────────────────
합계              367 MB  →  gzip 38MB (−90%)
```

`infra/nginx.conf`에 **gzip 설정이 하나도 없다**(확인됨). `design-index.json` 19MB를 앱 열 때마다 생으로 내려보낸다. nginx에 3줄이면 되고 코드는 안 건드린다.

```nginx
gzip on;
gzip_types application/json;
gzip_min_length 1024;
```

단, 개발은 `npm run dev`(Vite)로 하고 nginx는 Docker 스택에만 있어 **개발 중에는 체감되지 않는다.**

### 2-I. 저장소에 있으면 안 될 파일 (develop에서 유입)

우리가 넣은 것은 아니지만 남아 있다.

```
outputs/trim-validity-v2-review.zip     36.9 MB   .gitignore 에 /outputs/ 가 있는데도 추적 중
ml/sources/dongha/**/dataset_510k.csv   87 MB     학습 데이터셋 (의도일 수 있음)
ml/sources/dongha/**/desktop.ini  ×3     1 KB     OneDrive 찌꺼기 — 확실히 실수
```

`.gitignore`는 **이미 추적 중인 파일을 막지 못한다.** 빼려면 `git rm --cached`가 필요하다. `.gitignore`에 `desktop.ini`가 없다.

### 2-J. 용도 매칭 — 로드맵 1단계, 미착수

설계를 "무엇에 쓸 것인지"로 고르는 기능. 한 번도 시작하지 않았다.

**제약**: AircraftVerse는 `CargoMass`를 **0.5kg으로 고정**해 생성했다(표본 900개 전부 0.5). "5kg 실을 수 있는 드론"은 못 거른다. 쓸 수 있는 축은 비행거리·체공시간·최고속도·소비전력·질량·형태 여섯 개이고, **성능 4축은 38.7%(비행 해석 성공분)에만 값이 있다.**

---

## 3. 수정 지점 요약

| 항목 | 파일 | 위치 | 난이도 |
|---|---|---|---|
| 회전축 체인 미반영 | `components/parametric-uav-viewer.tsx` | 1534행 + `orient` 사용처 | 중 |
| 관절이 틈을 못 메움 | 같은 파일 | 1649행 | 중~상 |
| 죽은 슬라이더 2종 | `components/views/design-lab-view.tsx` | 449·493행 | 하 |
| 파라미터↔부품 binding | 같은 뷰어 | `armKeysOfSegment` | 상 |
| STL 12개 탭 불일치 | `components/views/shared.tsx` `ModelStage` | — | 하(결정 필요) |
| nginx 압축 | `infra/nginx.conf` | — | 하 |
| 깃 정리 | `.gitignore` + `git rm --cached` | — | 하 |

---

## 4. 이미 고친 것 (되돌리지 말 것)

PR #19에서 해결했다. 같은 문제를 다시 만들지 않도록 기록해 둔다.

1. **꺾인 마디 미연결** — `AngledWingArm`·`DoubleBendSegment`는 `segment.length`가 `arm1Length + arm2Length` **합계**라 맞는 파라미터가 없었다. 9,439개 마디에서 편집이 100% 실패했다. 두 팔로 나눠 각각 찾는다.
2. **`outboardOf`가 안쪽까지 밀어버림** — 허브만 막고 그래프를 걸어 안쪽 팔이 통과했다(팔 56.9% · 설계 49.6%). 허브를 뿌리로 **BFS 트리**를 세우고 제 아래 가지만 센다.
3. **팔 방향을 "원점 바깥"으로 추측** — 갈라진 뒤 되꺾이는 팔에서 반대로 잡혔다(팔 3.5% · 설계 10.3%). `outwardFrom()`이 **부모에서 멀어지는 쪽**을 쓴다.

결과: 슬라이더 연결률 90.1% → 100%, 모든 팔 1.8배 확대 시 최대 이음매 간격이 관절 두께(20mm)로 고정.

**이 셋이 전부 같은 뿌리에서 나왔다** — 뷰어가 STEP에 구워진 좌표에 **증분 보정을 덧칠**하는 방식이라 편집이 겹칠수록 어긋남이 쌓인다. 2-A·2-B도 같은 뿌리다. HANDOFF 문서 7.4와 8단계가 이 구조를 갈아엎는 방향을 다룬다.

---

## 5. 실패한 시도 (다시 하지 말 것)

- **설계별 실루엣 이미지** — 27,714장을 5.2MB로 뽑았으나 썸네일에서 알아보기 어려워 사용자가 롤백 지시. 분류값(`방향 수 + 위상`)에서 도형을 그 자리에서 그리는 `components/shape-icon.tsx`로 대체했다. 데이터 0 byte.
- **원본 `design_tree.json`으로 생김새 분류** — 제작 방식의 트리라 생김새와 어긋난다. `ConnectedHub6_Sym`과 `ConnectedHub6_2_2_2`는 위에서 보면 프로펠러가 같은 자리인데 다른 칸에 놓이고, 한 칸 내려가면 10 → 1,034가지로 터진다.
- **"도형이 기수 쪽으로 돌아갔는지"(쿼드 +형/X형) 축** — 쿼드·헥사에서는 깨끗이 갈리지만 프로펠러 8개를 넘으면 두 칸이 같아진다(9방향 이상 78% 대 76%). 사용자가 두 번 물어볼 만큼 뜻이 안 보여 뺐다. 계산값은 `shape-classes.json`에 남아 있다.
- **형상 점수 도구의 측정 버그 4종** — ASCII STL 정규식이 음수 지수를 놓침 / 점군 최근접이 샘플 간격을 오차 바닥으로 만듦 / 원통·테이퍼를 상자로 재기. **네 번 모두 존재하지 않는 문제를 만들어냈다.** 측정 결과가 이상하면 먼저 측정 코드를 의심할 것.

---

## 6. 환경 함정

전부 이 프로젝트에서 실제로 겪은 것들이다.

- **Docker는 `start`/`stop`만. `up` 금지** — `up`은 컨테이너를 다시 만들어 8000번 포트 매핑이 날아가고 `npm run dev`가 FastAPI를 못 찾는다.
  ```
  docker compose --env-file .env.docker.local start postgres api
  ```
  `--env-file`은 `stop`에도 필요하다(compose가 명령과 무관하게 파일 전체를 먼저 해석한다).
- **Windows에서 `npm install` 금지** — 락 파일에서 `@emnapi` 항목이 빠져 Docker 빌드(`npm ci`)가 실패한다.
- **브랜치를 바꾸면 dev 서버 재시작** — 모듈 그래프가 깨져 전 요청이 500이 된다.
- **새 `public/data` 파일을 추가하면 dev 서버 재시작** — 시작 시점에 목록을 캐시한다.
- **Windows에서 `npm run build`·`npm test`가 크래시한다(`0xC0000409`)** — develop에서도 동일하므로 이 브랜치 문제가 아니다. Docker 빌드(Linux)는 정상. 테스트는 개별 assertion은 통과하고 파일 종료 시점에만 깨지므로, **러너 문제와 실제 실패를 구분할 것.**

---

## 7. 팀 규칙

- `backend/`(Python·FastAPI)와 AI 모델 연동은 팀원 담당 — 건드리지 않는다
- 요청받은 것만 수정하고, 개선 제안은 코드 수정 전에 먼저 묻는다
- 원본 STL은 **비교 기준**이지 편집 결과물이 아니다
- `sourceParameters`·`nodes`·`physicalComponents`의 권위 데이터를 사용자 편집으로 임의 변경하지 않는다
