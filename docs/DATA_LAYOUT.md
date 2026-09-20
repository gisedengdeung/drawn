# 데이터 위치와 배포

```text
drawn/
  data/                          # 로컬 전용, Git 추적 제외
    raw/
      AircraftVerse_1/design_*/
      AircraftVerse_2/design_*/
      AircraftVerse_3/design_*/
    cache/                       # 필요한 경우 수집 캐시 보관
    migrations/                  # 위치 이관 전후 파일 목록과 검증 기록
  public/
    data/                        # 앱이 읽는 생성 JSON, Git 추적
    models/                      # 대표 설계 12개 STL, Git 추적
```

원본은 총 27,714개 설계이며 파트마다 9,238개가 있습니다. 앱은 원본 디렉터리를 직접 읽지 않고 `public/data`와 `public/models`를 요청합니다. 원본이 없는 새 checkout도 추적된 웹 자산으로 실행·빌드할 수 있습니다. 원본을 `public` 아래에 넣으면 웹 자산이 되므로 해당 위치를 사용하지 않습니다.

## 전처리

```bash
npm run data:prepare
npm run data:validate
```

경로 선택 순서는 명시한 `--data-root`, 프로젝트의 `data/raw`, 프로젝트 상위 폴더입니다. 한 위치의 파트만 사용하며 두 위치를 합치지 않습니다. 내부에 일부 파트만 있으면 3개 파트 검사에서 오류가 발생하므로 이동을 마친 뒤 전처리를 실행합니다. 이전 압축 해제 구조인 `AircraftVerse_N/AircraftVerse_N/design_*`도 계속 지원합니다.

외부 저장소를 사용하려면 각 파트의 경로를 모두 지정합니다.

```bash
npm run data:prepare -- --data-root "D:/datasets/AircraftVerse_1" --data-root "D:/datasets/AircraftVerse_2" --data-root "D:/datasets/AircraftVerse_3"
```

전처리는 기존 대표 STL 12개가 `public/models`에 있는지 확인합니다. 해당 모델 세트는 원본 이동과 별개로 유지해야 하며 전처리가 자동으로 재생성하지 않습니다. `corpus_dic`과 압축 해제 메타데이터인 `__MACOSX`는 앱에 필요하지 않습니다.

## 이관 검증

2026-09-13 이관은 같은 C: 볼륨의 원본 안쪽 `AircraftVerse_N` 디렉터리를 `data/raw` 아래로 이동합니다. 기존 바깥쪽 폴더, `__MACOSX`, `corpus_dic`는 그대로 둡니다. 로컬 `data/migrations`에 이동 전후 전체 상대 파일 경로·바이트 크기·최종 수정 시각 목록, 목록의 SHA256, 설계 수·파일 수·총 바이트 수를 기록합니다. 목록 해시 비교는 파일 내용 전체를 다시 해시하는 검증과는 다릅니다.

## Git과 배포

`.gitignore`의 `/data/`는 원본·캐시·이관 기록을 제외합니다. 개발 서버 파일 감시와 TypeScript 검사도 이 디렉터리를 건너뜁니다. `public/data`와 `public/models`의 추적은 유지합니다.

배포는 `npm run build`의 `dist` 산출물을 사용합니다. 현재 저장소에는 별도 소스 압축·업로드 스크립트가 없습니다. 향후 프로젝트 디렉터리 전체를 압축하는 업로더를 추가할 때는 `/data/`를 명시적으로 제외해야 합니다. `.gitignore`는 임의 압축 도구의 제외 규칙을 대신하지 않습니다. 원본을 팀과 공유해야 한다면 웹 배포와 분리된 데이터 저장소를 사용합니다.
