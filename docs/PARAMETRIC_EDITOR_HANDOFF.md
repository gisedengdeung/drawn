# 파라메트릭 뷰어 편집 핵심 로직 인수인계

> 작성 기준: 2026-09-25  
> 브랜치: `feature/parametric-edit`  
> 기준 커밋: `cfdfeb7 ui: 비행 장소, 자잘한 마무리들`
>
> **2026-09-29 후속 문서**: 플랜 A의 실제 완료 결과와 P서버 기반 플랜 B 전환은
> `docs/PARAMETRIC_PLAN_B_HANDOFF.md`를 우선해서 읽는다.
>
> **2026-09-30 제출 계획**: P서버는 제출 이후로 보류했다. 2026-10-01 19:00까지의
> 편집 MVP 범위는 `docs/PARAMETRIC_EDIT_SUBMISSION_PLAN.md`를 우선한다.

## 1. 문서의 목적

이 문서는 UI 개편 이후 진행할 **파라메트릭 뷰어 편집 핵심 로직** 작업을 새 대화에서 이어가기 위한 단일 기준 문서다.

작업 흐름은 다음과 같다.

1. 파라메트릭 뷰어 형상 정확도와 조립 좌표 처리를 장기간 개선했다.
2. 설계 선택·파라미터 편집·성능 확인·비교 화면의 UI를 전면 개편했다.
3. 다음 단계에서 파라메트릭 형상을 실제로 안정적으로 편집하는 핵심 로직을 만든다.

기존 `PROGRESS.md`는 과거 세션의 기록으로 참고할 수 있지만, 미커밋 상태와 남은 작업 목록 일부가 현재 코드와 맞지 않는다. 새 작업은 이 문서와 실제 코드를 우선한다.

## 2. 새 대화에서 가장 먼저 할 일

구현을 바로 시작하지 말고 다음 순서를 지킨다.

1. 이 문서를 끝까지 읽는다.
2. 아래 핵심 파일과 현재 데이터 흐름을 직접 확인한다.
3. 9번의 제품 결정 사항을 사용자와 확정한다.
4. 편집 명령과 변환 불변조건을 먼저 설계한다.
5. 작은 대표 설계들로 순수 로직 테스트를 만든 뒤 Three.js 렌더러와 연결한다.

새 대화 시작 프롬프트 예시:

> `docs/PARAMETRIC_EDITOR_HANDOFF.md`를 먼저 전부 읽고 실제 코드와 비교해줘. 파라메트릭 뷰어 편집 기능은 UI 추가가 아니라 핵심 조립·변환 로직 작업이다. 기존 설계 선택, 비교, 성능 분석 UI를 회귀시키지 말고 먼저 편집 의미와 불변조건을 정리한 뒤 구현 계획을 제안해줘.

## 3. 현재 상태

문서 작성 직전 작업 트리는 깨끗했고 로컬과 원격 브랜치는 같은 커밋을 가리켰다.

```text
feature/parametric-edit
cfdfeb7 (HEAD, origin/feature/parametric-edit)
```

이 문서가 추가되면서 문서 파일만 새 변경으로 남는다. 다음 작업 시작 시 반드시 다시 `git status --short`를 확인한다.

현재 UI 큰 틀은 완료된 것으로 본다. 다음 작업에서 UI를 다시 전면 개편하지 않는다.

- 설계 선택과 파라미터 편집 아일랜드
- 파라메트릭 형상, 원본 STL, 듀얼 뷰
- Baseline과 현재 Draft 비교
- 데이터셋 설계 A/B 비교와 카메라 연동
- 기존 설계 KPI와 현재 Draft 비교
- AI 속도별 예측 분석 보드
- AI 예측과 원본 시뮬레이션 trim 전환
- 속도별 자세, 힘 화살표, 카드, 곡선, 비수렴 구간
- 측면 복귀와 측면 고정

## 4. 현재 데이터 흐름

```text
design-index / design-tree shard / part placements / part catalog
                         │
                         ▼
              useDesignWorkspace
              ├─ baseline: 원본 DesignDraft
              ├─ draft: 편집 중 DesignDraft
              ├─ placements: AssemblyInfo
              └─ catalogs
                         │
                         ▼
              DesignLabView의 편집 컨트롤
              └─ mutateDraft(group, mutator)
                         │
                         ▼
              cloneDraft → 값 변경 → setDraft
                         │
               ┌─────────┴─────────┐
               ▼                   ▼
      ParametricUavViewer      AI/KPI/비교 기능
               │
               ▼
          buildAircraft
          ├─ placements 존재: buildFromPlacements
          └─ placements 없음: 계층 기반 개념 형상 fallback
```

중요한 점:

- `baseline`은 편집 전 원본이며 reset, ghost, 비교 기준이다.
- `draft`는 편집 상태의 단일 전달 객체다.
- `setDraft`는 잘못된 `baselineId`가 들어오지 못하게 막는다.
- `placements`는 STEP에서 추출한 위치·방향·실측 치수와 조립 연결을 풀어 놓은 `AssemblyInfo`다.
- 원본 `sourceParameters`는 서버 검증에서 변경 불가다. UI는 `parameterDefinitions[].value`와 친화적 필드를 편집한다.
- AI 예측은 뷰어의 Three.js 형상에서 값을 읽지 않는다. `draft`의 지원 입력을 별도 feature로 변환한다.

## 5. 핵심 데이터 구조

### `DesignDraft`

위치: `lib/drawn-types.ts`

주요 필드:

- `segments`: 팔/마디의 계층, 길이, 각도, 오프셋, 부모 경로, 깊이
- `fuselage`: 길이, 가로·세로 지름, 바닥 높이
- `propulsionGroups`: 모터·프로펠러 선택과 연결 세그먼트
- `wings`: span, chord, 회전, 조종면, tube offset, NACA
- `energy`: 배터리 구성
- `payload`, `layout`: 화물과 내부 배치
- `parameterDefinitions`: UI에서 편집 가능한 원본 변수의 안전한 overlay
- `sourceParameters`: 데이터셋 원본 튜플. 현재 서버 규칙상 immutable
- `nodes`, `physicalComponents`: 원본 구성과 BOM의 권위 데이터

### `PartPlacement`

- `n`: 부품 인스턴스 이름
- `p`: STEP 좌표계 위치(mm)
- `x`, `z`: 로컬 축
- `s`: 로컬 축 기준 실측 치수(mm)

### `AssemblyInfo`

- `placements`: 모든 부품 배치
- `neighbours`: 부품 조립 그래프
- `typeOf`, `modelOf`: 부품 분류와 카탈로그 모델

## 6. 현재 파라메트릭 뷰어 구조

핵심 파일: `components/parametric-uav-viewer.tsx`

### 렌더러 생명주기

- 첫 `useEffect`가 scene, camera, renderer, OrbitControls, grid, picking, resize, render loop를 만든다.
- 별도 `useEffect`가 `draft` 변경 시 기존 model/ghost/force group을 제거하고 다시 `buildAircraft()` 한다.
- 화면에 가려진 뷰어는 `paused`로 렌더링을 멈춘다.
- `maxFps`, 카메라 sync, 자동 프레이밍, side preset/lock을 지원한다.

### 두 형상 경로

1. `assembly.placements`가 있으면 `buildFromPlacements()` 사용
   - 원본 STEP 좌표와 실측 치수를 사용한다.
   - 조립 그래프로 허브에서 바깥쪽 parent/child 관계를 만든다.
   - 팔 길이·각도·오프셋 보정을 하위 부품으로 전파한다.
   - 부품 이름, 실측 치수, 카탈로그 선택을 이용해 단순 Three.js geometry를 만든다.
2. placements가 없으면 `buildAircraft()`의 계층 기반 fallback 사용
   - `segments.parentPath`, multiplicity, topology를 이용해 개념 형상을 만든다.
   - 실제 STEP 재현이 아니라 안전한 대체 표시다.

### 이미 구현된 보정

- STEP Z-up/mm → Three.js Y-up/scene scale 변환
- 실제 부품 hull 기반 카메라 fit
- 허브에서 BFS로 조립 parent 관계 생성
- 바깥쪽 subtree만 이동하는 arm 보정
- 꺾인 마디의 여러 팔 길이 분배
- 안쪽 변환부터 적용하는 adjustment chain
- 모터·허브 원통 축 추정
- 배터리·화물·동체·날개의 실측 치수 기반 표시
- 선택 부품 강조와 비선택 부품 dimming
- 공유 material cache로 shader/material 수 제한
- 힘 벡터, 피치 자세, baseline ghost, 카메라 연동

## 7. 현재 편집 구현의 구조적 한계

다음은 새 핵심 로직에서 우선 해결하거나 명시적으로 유지해야 할 부분이다.

### 7.1 편집값의 권위 소스가 여러 개다

같은 의미가 다음 위치에 중복될 수 있다.

- `segments`, `wings`, `fuselage`, `layout`
- `parameterDefinitions[].value`
- immutable `sourceParameters`
- `placements`의 원본 좌표와 치수

`applySourceParameter()`는 변수명 정규식과 baseline 값 근접도를 이용해 친화적 필드에 값을 복사한다. 반대로 일반 슬라이더가 모든 `parameterDefinitions`에 동일하게 반영되는 구조는 아니다. 대규모 편집 기능 전에 **무엇이 canonical state인지**, 파생 필드는 어떻게 동기화할지 확정해야 한다.

### 7.2 원본 변수와 실제 부품의 연결이 휴리스틱이다

현재 arm은 이름과 기준 길이, wing은 그룹 순위, 일부 부품은 첫 번째 motor/propeller/battery/wing 값을 사용한다. 일반적인 형상 표시에는 유용하지만 인스턴스 단위 편집의 정확한 binding으로 쓰기에는 부족하다.

필요한 방향:

- parameter definition → affected draft field → affected placement instance를 명시적으로 연결
- 대칭 복제와 multiplicity를 별도 규칙으로 표현
- 매칭 실패를 조용히 다른 부품에 적용하지 말고 진단 결과로 노출

### 7.3 변경마다 전체 모델을 다시 만든다

`draft`가 바뀌면 model group 전체를 dispose/rebuild한다. 슬라이더를 연속 조작하면 geometry와 material 생성이 반복되므로 대규모 편집에서 체감 성능 문제가 될 수 있다.

장기적으로는 다음을 분리하는 편이 안전하다.

- 변하지 않는 원본 조립 인덱스
- 부품별 local/world transform 계산
- geometry 크기 변경
- material/선택 상태 변경
- 실제 scene graph patch

### 7.4 변환 규칙이 렌더링 함수 안에 섞여 있다

조립 트리, 편집 보정, 부품 치수 추정, Three.js mesh 생성이 `buildFromPlacements()` 하나에 함께 있다. 이 상태에서는 변환 정확도를 DOM/WebGL 없이 단위 테스트하기 어렵다.

새 로직은 최소한 다음 순수 계층을 분리하는 것을 권장한다.

```text
Draft + Assembly + Edit bindings
            │
            ▼
    Parametric scene model
    ├─ part id/type/model
    ├─ local transform
    ├─ world transform
    ├─ dimensions
    └─ parent/children
            │
            ▼
      Three.js renderer
```

### 7.5 지원하지 않는 편집의 의미가 섞여 있다

일부 값은 3D 형상만 바꾸고 AI에는 사용되지 않는다. UI의 `형상만` 표시는 `backend/app/performance_features.py::unsupported_changes()`와 의미가 맞아야 한다. 편집 로직을 고친다고 AI가 자동으로 해당 입력을 지원하는 것은 아니다.

## 8. 권장 구현 단계

### 1단계: 편집 계약 정의

- 편집 명령 타입 정의: 대상, 연산, 값, 단위, 대칭/복제 범위
- canonical draft field와 파생 필드 정의
- reset, cancel, commit, undo의 의미 정의
- 편집 불가능하거나 binding이 없는 값을 명시적으로 실패 처리

예시 형태일 뿐 아직 확정된 API는 아니다.

```ts
type ParametricEditCommand = {
  target: { kind: 'segment' | 'wing' | 'fuselage' | 'component'; id: string };
  property: string;
  value: number | string | boolean;
  scope: 'instance' | 'symmetric-set' | 'design-rule';
};
```

### 2단계: 순수 편집·binding 모듈

- UI나 Three.js 없이 `applyEdit(draft, command)` 구현
- parameter definition과 실제 field/placement binding 생성
- affected instance 목록과 진단 결과 반환
- 동일 입력의 결정성, reset round-trip, 범위/단위 검증 테스트

### 3단계: 순수 조립·변환 solver

- assembly graph를 root 기준 tree/forest로 정규화
- 각 부품의 local transform과 world transform 계산
- 길이, 회전, 오프셋을 정확한 pivot과 axis에 적용
- descendant 전파와 형제 branch 격리
- 대칭/반복 인스턴스 규칙 적용
- 연결부 gap, NaN, 비정상 scale을 진단

### 4단계: 렌더러 분리와 점진 갱신

- `partName → THREE.Object3D` 인덱스 유지
- transform-only 변경은 matrix만 갱신
- dimension 변경은 해당 geometry만 교체·dispose
- material과 선택 변경은 모델 재조립 없이 반영
- topology가 바뀌는 경우에만 전체 scene graph 재생성

### 5단계: 편집 UI 연결

- 기존 왼쪽 파라미터 UI와 새 편집 명령을 연결
- 3D 직접 조작을 채택한다면 selection과 gizmo를 동일 명령 계층에 연결
- 드래그 중 preview와 commit 시점을 구분해 AI 요청 폭주 방지
- reset, undo/redo, 변경 요약과 동일 상태 공유

### 6단계: AI·비교·저장 연동 검증

- 편집된 `draft` fingerprint가 정확히 바뀌는지 확인
- AI가 지원하는 값과 geometry-only 값을 계속 구분
- Baseline vs Draft, 설계 A/B 비교, 갤러리 저장/복원이 같은 draft를 사용하는지 확인
- 원본 trim은 baseline 데이터이며 편집 Draft 결과로 오인되지 않게 유지

## 9. 사용자와 반드시 먼저 결정할 사항

아래 내용은 아직 이 문서에서 임의로 정하지 않는다.

1. 편집은 왼쪽 패널만 사용하는가, 3D 직접 조작도 포함하는가?
2. 3D에서 선택하는 단위는 부품 인스턴스, 파라미터 그룹, 조립 마디 중 무엇인가?
3. 한 부품 편집은 해당 인스턴스만 바꾸는가, 대칭 부품 전체를 바꾸는가?
4. 사용자가 직접 바꿀 연산은 무엇인가?
   - 길이
   - 회전
   - 결합 오프셋
   - 부품 교체
   - 날개 크기/회전
   - 내부 부품 배치
5. 대칭 유지, 충돌 방지, 최소 간격 같은 제약을 강제할 것인가?
6. 슬라이더/드래그 중 실시간 반영할 것인가, 미리보기 후 확정할 것인가?
7. undo/redo와 편집 이력은 이번 범위에 포함되는가?
8. 기존 설계 topology 자체의 추가/삭제까지 허용하는가, 치수·부품 변경만 허용하는가?
9. 저장·공유 시 원본 변수와 새 편집 명령 중 무엇을 영속화할 것인가?

이 답에 따라 데이터 모델이 달라지므로 추측으로 구현하지 않는다.

## 10. 최소 불변조건과 완료 기준

새 편집 로직은 최소한 다음 조건을 만족해야 한다.

- baseline 상태를 렌더링하면 현재 기준 형상과 동일하다.
- 편집 후 reset하면 위치·회전·크기와 fingerprint가 기준 상태로 돌아온다.
- 한 branch 편집이 무관한 형제 branch를 움직이지 않는다.
- 부모의 이동·회전은 모든 descendant에 같은 순서로 전파된다.
- 팔 길이 변경 시 뿌리는 유지되고 바깥쪽 부품만 이동한다.
- 연결된 팔·관절·모터·프로펠러 사이에 새 gap이 생기지 않는다.
- 대칭 편집 범위가 UI 표시와 일치한다.
- NaN, Infinity, 음수 치수, zero-scale mesh를 만들지 않는다.
- 슬라이더 연속 조작 중 WebGL context와 메모리 사용량이 계속 증가하지 않는다.
- selection, ghost, force arrows, camera sync가 편집 이후에도 동작한다.
- 설계 선택, Baseline 비교, A/B 비교, AI 성능 분석 UI를 회귀시키지 않는다.
- placements가 없는 설계의 fallback도 빈 화면이 되지 않는다.

## 11. 테스트 전략

### 순수 로직 테스트

대표 fixture를 최소 다음 유형으로 고른다.

- 단일 직선 arm
- 꺾인 arm
- branch/cross가 있는 arm
- 대칭 허브
- 서로 다른 길이의 여러 arm
- wing 포함 설계
- placements가 없는 fallback 설계

검증 항목:

- parent/child 관계
- 편집 전후 transform
- pivot 고정
- descendant 이동량
- 형제 branch 불변
- 대칭 복제 수
- reset round-trip
- binding 실패 진단

### 브라우저 검증

- 대표 설계별 before/after 스크린샷
- 슬라이더를 빠르게 왕복할 때 프레임 저하와 누적 메모리 확인
- viewer를 열고 닫거나 AI/원본·듀얼 뷰를 반복 전환해 WebGL context 누수 확인
- 작은 화면에서 아일랜드와 편집 도구가 3D를 완전히 가리지 않는지 확인

## 12. 핵심 파일 지도

| 파일 | 역할 |
|---|---|
| `components/parametric-uav-viewer.tsx` | Three.js 런타임, 형상 생성, 조립 보정, picking, 카메라 |
| `components/views/design-lab-view.tsx` | 편집 UI, `mutateDraft`, 원본 변수 adapter, 비교·성능 보드 |
| `hooks/use-design-workspace.ts` | baseline/draft/catalog/assembly 로딩과 편집 상태 소유 |
| `lib/drawn-types.ts` | Draft, segment, placement, assembly 타입 |
| `lib/design-draft.ts` | draft hydrate/clone/fallback와 원본 변수 definition 생성 |
| `lib/assembly.ts` | 저장된 placement와 catalog를 `AssemblyInfo`로 변환 |
| `lib/viewer-camera-sync.ts` | 서로 다른 3D 뷰어의 정규화 카메라 동기화 |
| `scripts/prepare-part-placements.mjs` | STEP 기반 placement/연결/치수 데이터 생성 |
| `scripts/prepare-aircraftverse.mjs` | 설계 tree와 source parameter 데이터 생성 |
| `backend/app/performance_features.py` | AI가 실제로 사용하는 편집 입력과 미지원 변경 정의 |
| `lib/agent/draft-validation.ts` | 서버 측 Draft 허용 범위와 immutable 필드 검증 |

## 13. 성능과 안전 주의사항

- 여러 뷰어를 동시에 마운트하지 말고 필요 없는 뷰어는 unmount하거나 `paused` 처리한다.
- geometry/material을 교체할 때 반드시 dispose한다.
- render loop와 ResizeObserver, DOM listener는 unmount 시 정리한다.
- 연속 드래그를 매 프레임 React deep clone + AI API 요청으로 연결하지 않는다.
- 사용자 편집으로 `sourceParameters`, `nodes`, `physicalComponents`의 권위 데이터를 임의 변경하지 않는다.
- backend와 모델 입력 지원 범위를 확장하는 작업은 별도 합의 없이 포함하지 않는다.
- 기존 작업 트리의 사용자 변경을 덮어쓰거나 destructive git 명령을 사용하지 않는다.

## 14. 현재 검증 명령과 알려진 테스트 상태

UI 개편 마지막 상태에서 다음 검사는 통과했다.

```powershell
npm run typecheck
npx oxlint components/views/design-lab-view.tsx components/views/performance-prediction-panel.tsx
npm run build
```

전체 `npm test`에서는 개별 assertion 172개가 통과했지만 여러 테스트 파일이 마지막 file-level process 종료 오류로 잡혀 명령의 최종 exit code가 실패했다. 파라메트릭 편집 작업을 시작할 때 테스트 러너 문제와 실제 assertion 실패를 구분한다.

프로젝트 루트에서 불필요하게 `npm install`하여 lockfile을 바꾸지 않는다. 새 정적 `public/data` 파일을 만들었다면 dev 서버 재시작이 필요할 수 있다.

## 15. 작업 범위 원칙

- 다음 작업의 핵심은 새 패널을 더 만드는 것이 아니라 **편집 명령, parameter binding, assembly transform 전파, 점진 렌더링**이다.
- UI는 핵심 로직을 호출하고 상태를 설명하는 얇은 계층으로 유지한다.
- 정확히 정의되지 않은 편집 의미를 정규식이나 좌표 근접도로 조용히 추측하지 않는다.
- 모든 설계를 한 번에 완벽히 지원하려 하지 말고 대표 fixture에서 불변조건을 만족시킨 뒤 범위를 넓힌다.
- 원본 STL은 비교 기준이지 편집 결과물이 아니다. 편집 결과는 파라메트릭 형상으로 표현한다.
