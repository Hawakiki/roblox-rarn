# Rarn — 구현 계획

> 이 문서는 **무엇을 어떤 순서로 만들지**를 정한다.
> 플랫폼 제약과 검증된 API 사실은 [CLAUDE.md](CLAUDE.md)에 있으며, 여기서 반복하지 않는다.

---

## 0. 확정된 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| 구현 언어 | TypeScript + Bun | 부품(zip·semver·HTTP) 전부 성숙, `--compile`로 단일 바이너리까지 해결 |
| 패키지 소스 | Wally 레지스트리 API | 기존 Roblox 생태계를 그대로 흡수 |
| 설치 위치 | `RARN_MODULE/` | `node_modules` 감각. 내부는 `_Index` + shim (구조는 강제사항) |
| 매니페스트 | `rarn.json` | npm 표기법 `"@evaera/promise": "^4.0.0"` |
| 락파일 | `rarn.lock` (JSON) | 정렬된 키, 재현 가능 |
| 스키마 | JSON Schema 2020-12 | `schemas/` 가 두 포맷의 단일 진실 |
| 캐시 | 전역 캐시 + **복사** | 하드링크는 프로젝트 간 편집 전파 사고 위험 |
| MVP 범위 | `init` `add` `install` `remove` `list` | CLI 표면 전체를 얇게 |
| 차별점 | 좋은 CLI 경험 + dedupe 가시화 | `why` / `dedupe` 는 Wally에 없는 영역 |
| 배포 | 로컬 실행만 | 크로스컴파일·릴리스는 기능 완성 후 |
| 린트 | Biome 포매터 + ESLint 타입룰 | Biome은 타입 인지 린팅이 **구조적으로** 불가 |
| 훅 | husky `pre-commit` 에 전부 | 느려지면 `pre-push` 로 분리 |
| 에러 코드 | `RN####` (Yarn Berry `YN0060` 방식) | 검색 가능한 고정 식별자 |

### Yarn에서 가져온 것

| Yarn | Rarn | 비고 |
|---|---|---|
| `resolutions` | `resolutions` | **버전 강제 통일.** 충돌 시 유일한 탈출구 |
| `yarn up [--latest]` | `rarn up [--latest]` | 업그레이드 |
| `YN0060` 코드 | `RN0210` 코드 | 메시지 문구는 바뀌어도 코드는 불변 |
| `yarn why` / `dedupe` | 동일 | 이미 계획에 있었음 |
| `--frozen-lockfile` | 동일 | Classic 철자 유지 (Berry는 `--immutable`) |

### 채택하지 않은 것과 그 이유

| 후보 | 왜 안 했나 |
|---|---|
| Luau + Lune | Lune에 **zip 해제가 없다**. Wally가 zip을 주므로 치명적 |
| Rust | 생태계 정통성은 최고지만 개발 속도 손해가 큼 |
| 하드링크 캐시 | 한 프로젝트의 편집이 다른 프로젝트로 전파됨 |
| 자체 레지스트리 | 서버 운영·인증·스토리지가 MVP 범위를 크게 넘음 |
| `.rbxm` 직접 생성 | 바이너리 포맷 직렬화 난이도가 높음. `rarn pack`으로 후순위 |

---

## 1. 아키텍처 요약

```
rarn.json
   |
   v
[resolver] --(metadata API)--> 정확한 버전 집합 + dedupe 판정
   |
   v
[cache] --(miss: contents API -> zip -> unzip)--> extracted/
   |
   v
[project] --(default.project.json)--> 모듈 루트만 골라냄
   |
   v
[linker] --> RARN_MODULE/_Index/... + *.luau shim
   |
   v
rarn.lock
```

`resolver`는 **네트워크를 metadata 호출로만 쓴다.** zip은 버전 집합이 확정된 뒤에만 받는다.
메타데이터가 의존성 그래프를 통째로 주기 때문에 가능한 설계이며, 이게 속도의 대부분을 만든다.

---

## 2. 마일스톤

### M0 — 툴체인 부트스트랩 ✅

- [x] Bun 1.3.14 설치 확인
- [x] `package.json`, `tsconfig.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- [x] 의존성 확정 — **전부 순수 JS** (네이티브 애드온은 크로스컴파일 불가)

| 용도 | 패키지 | 비고 |
|---|---|---|
| CLI 파싱 | `commander` | |
| 색상 | `chalk` | |
| 스피너/진행 | `ora` | |
| semver | `semver` | Cargo 문법 번역 후 투입 |
| zip 해제 | `fflate` | 순수 JS |
| 스키마 검증 | `ajv` + `ajv-formats` | `schemas/*.json`을 그대로 소비 |
| HTTP / 해시 / 파일 | Bun 내장 | `fetch`, `crypto.subtle`, `Bun.file` |

TOML 파서는 **필요 없다.** 의존성 별칭까지 metadata API가 JSON으로 준다.

- [x] `biome` 린트 설정, `bun test` 동작 확인
- [x] `src/` 레이어 디렉터리 골격 생성
- [x] `src/util/errors.ts` — `what` / `where` / `how` 3요소 에러
- [x] `src/util/package-name.ts` — 이름 4형태 변환, 별칭 도출
- [x] **`src/util/version-range.ts` — Cargo→npm 범위 번역** (최고 위험 항목, M2보다 앞당김)
- [x] `src/cli.ts` — commander 배선, 전 명령 스텁
- [x] `bun build --compile` 단일 바이너리 확인 (99MB)
- [x] ESLint 타입 인지 룰 (`typescript-eslint` `strictTypeChecked`)
- [x] husky `pre-commit` + lint-staged
- [x] `src/util/codes.ts` — `RN####` 에러 코드 체계
- [x] `resolutions` 필드, `rarn up` 명령

M0 상태: **86 tests pass / eslint clean / typecheck clean / biome clean.**

> 번역 로직을 M2가 아니라 M0에서 끝냈다. 위험도 1순위였고 순수 함수라 의존성이 없었다.
> 테스트에는 *번역하지 않은 범위가 다른 의미로 파싱된다*는 것을 고정하는 케이스를 넣어,
> 이 변환이 왜 필요한지가 코드에 남도록 했다.

> `--bytecode` 는 CommonJS로 내보내므로 top-level await 를 쓸 수 없다.
> `src/cli.ts` 진입점을 async IIFE로 감싸 둔 이유다 — 안 그러면 인터프리터 실행은 되는데
> 컴파일된 바이너리만 깨진다.

---

### M1 — 매니페스트 ✅

- [x] `manifest/types.ts` — 스키마의 TS 미러 + realm 디렉터리 규칙
- [x] `manifest/validate.ts` — **2단 검증** (ajv 형태 + 의미)
- [x] `manifest/read.ts` — 읽기, 기본값 채우기, 이름 제안
- [x] `manifest/write.ts` — 필드 순서 고정, 의존성 정렬, 미지 필드 보존
- [x] `cli/commands/init.ts` — 대화형/`-y`/`--force`, `.gitignore` 갱신
- [x] `util/fs.ts` — 중복됐던 `isNotFoundError` / `pathExists` 추출

M1 상태: **120 tests pass / eslint clean / tsc clean / biome clean.**

**검증 2단 구조.** JSON Schema는 형태만 본다. `^^4` 가 진짜 semver 범위인지,
두 패키지가 같은 shim 이름을 만드는지, `resolutions` 값이 범위가 아닌지는
스키마가 표현할 수 없다. 스키마는 "패턴 불일치"까지밖에 말 못 하지만 의미 검사는
어느 두 패키지가 부딪혔고 뭘 고쳐야 하는지 말할 수 있다.

**예외:** 버전 형태만은 의미 검사를 ajv **앞에** 돌린다. 스키마에도 semver 패턴이
있어서 그냥 두면 스키마가 먼저 잡고 "형태가 틀렸다"고만 말한다. `resolutions` 는
*왜* 범위가 거부되는지가 답의 핵심이라 그걸 잃으면 안 된다. 스키마 패턴은
에디터 자동완성용으로 남기고, CLI에서는 더 나은 메시지가 이긴다.

**완료 기준 달성 — 실제 출력:**

```
RN0021: dependencies["@evaera/promise"] is '^^4', which is not a valid version range.
  at .../rarn.json

Use a range such as '^4.0.0', '~1.2.3', '>=1.0.0 <2.0.0', or '*'.
```

```
RN0030: 2 packages would both be installed as 'Promise'.
  at .../rarn.json

  @a/promise
  @b/promise

Give one of them a different name under "aliases", for example:
  "aliases": { "@a/promise": "Promise2" }
```

> 매니페스트 에러를 사용자가 실제로 보게 되는 건 M8부터다. 지금은 `init` 만
> 구현돼 있고 그건 매니페스트를 읽지 않는다. 레이어 자체는 완성이며 테스트로 고정했다.

---

### M2 — 레지스트리 클라이언트 ✅

- [x] `registry/types.ts` — 와이어 타입과 파싱된 타입 분리
- [x] `registry/parse.ts` — kebab-case, `null`, **Cargo 범위**를 여기서 전부 차단
- [x] `registry/client.ts` — 3개 엔드포인트, 재시도, 캐시, API URL 해석
- [x] 인덱스 `config.json` 해석 (기본 인덱스는 요청 0회)
- [x] in-flight 프로미스 캐시 — 동시 호출도 요청 1회
- [x] 지수 백오프 (네트워크·5xx·429 한정, 4xx 즉시 실패)

M2 상태: **145 tests pass / eslint clean / tsc clean / biome clean.**

**실측으로 발견한 API 특이점:** 없는 패키지가 **404가 아니라 500**을 반환한다.

```
$ curl -o /dev/null -w "%{http_code}" .../package-metadata/nobody/does-not-exist-xyz
500
{"message":"could not open package nobody/does-not-exist-xyz from index ..."}
```

500을 곧이곧대로 서버 오류로 보면 오타 하나에 백오프를 전부 돌고 나서 엉뚱한 원인을
보고한다. 본문을 보고 "없는 패키지"로 판정해 **재시도 없이 즉시** 실패시킨다.
브리틀한 판정이지만 대안이 더 나쁘다.

**API URL 해석은 기본 인덱스에서 네트워크를 쓰지 않는다.** `config.json` 이 레지스트리
수명 내내 `api.wally.run` 을 가리켜 왔고, 상수를 재발견하려고 매 실행 라운드트립을
쓸 이유가 없다. 커스텀 인덱스만 GitHub raw 로 읽는다.

**완료 기준 달성 — 실서버 확인:**

```
getMetadata: 29 versions in 441ms
sleitnick/knit@1.7.0  realm=shared
  Comm       -> sleitnick/comm  >=1.0.0 <2.0.0
  Promise    -> evaera/promise  >=4.0.0 <5.0.0
getContents: 7793 bytes, magic=50 4b 03 04 (zip)
RN0110: nobody/does-not-exist-xyz does not exist in the registry.
```

> 테스트는 녹화된 픽스처만 쓴다 (`tests/fixtures/registry/`). 네트워크 없이 돈다.

---

### M3 — 리졸버 (여기가 제일 어렵다)

Wally의 리졸버는 **탐욕적 + 백트래킹 없음**이라 큐 순서에 결과가 좌우되고,
`^1.2.0` 과 `^1.5.0` 처럼 명백히 풀리는 조합에서도 실패할 수 있다
(상세: [docs/wally-internals.md](docs/wally-internals.md) 2절).

**"major당 한 버전" 정책은 그대로 유지하되, 알고리즘을 순서 독립적으로 만든다.**
버전을 하나라도 고르기 전에 제약을 전부 모으는 게 핵심이다.

```
1. rarn.json 직접 의존성을 큐에 넣는다
2. 큐가 빌 때까지 — 아직 버전을 고르지 않는다:
     메타데이터 조회 -> 후보 버전 목록
     이 이름에 걸린 범위를 수집만 한다
     의존성을 큐에 추가 (이름+범위 쌍 기준으로 방문 표시)
3. 이제 이름별로 버전 집합 최소화:
     모든 범위의 교집합이 비지 않으면 -> 최고 버전 1개
     비면 -> 겹치는 범위끼리 묶어 그룹 수만큼 버전 선택
4. 각 요구자에 대해 자신이 쓸 버전을 매핑 -> dependencies 맵
5. realm 결정: 요구자들 중 가장 넓은 placement (shared > server > dev)
```

2단계에서 후보 목록을 받으려면 전이 의존성을 알아야 하는데, 그건 아직 버전이 안 정해진
상태에서 필요하다. 해결: **범위에 맞는 모든 후보의 의존성을 큐에 넣고**, 3단계에서 실제로
선택된 버전의 것만 남긴다. 후보가 많으면 메타데이터 요청이 늘지만 전부 캐시되고 병렬이다.

- [ ] `resolver/graph.ts` — 그래프 순회, 방문 표시
- [ ] `resolver/dedupe.ts` — 범위 교집합 기반 버전 수 최소화
- [ ] `resolver/errors.ts` — 충돌 시 **왜 안 되는지** 출력

```
X @evaera/promise 를 하나의 버전으로 통합할 수 없습니다

    ^3.2.0  <- @nevermore/signal@2.1.0 이 요구
    ^4.0.0  <- rarn.json 이 직접 요구

  두 범위는 겹치지 않아 각각 설치됩니다.
  두 사본은 런타임에 서로 다른 모듈이 되어 싱글톤이 깨질 수 있습니다.
  -> @nevermore/signal 을 올릴 수 있는지 확인하세요.
```

- [ ] 순환 의존성 감지 (에러가 아니라 경고 — Luau에서는 성립할 수 있다)
- [ ] pre-release 는 명시적으로 요구된 경우에만 후보에 넣는다

**완료 기준:** `@sleitnick/knit@^1.7.0` 하나로 knit·comm·promise가 각 1버전씩 나온다.

---

### M4 — 캐시와 취득

- [ ] `cache/paths.ts` — Windows `%LOCALAPPDATA%\rarn\cache`, 그 외 XDG
- [ ] `cache/store.ts` — `downloads/`(zip), `extracted/`(트리)
- [ ] sha256 무결성 계산·검증, 락파일과 대조
- [ ] `fetch/download.ts` — 동시성 상한을 둔 병렬 다운로드
- [ ] `fetch/extract.ts` — fflate 해제
  - **매직바이트로 판별한다.** `Content-Type: application/gzip` 이라고 오지만 실제는 zip (`PK 03 04`)
  - zip slip 방어: `..` 를 포함하는 엔트리는 거부
- [ ] 원자적 쓰기: 임시 디렉터리에 풀고 완료 후 rename (중단 시 반쪽 캐시 방지)

**완료 기준:** 두 번째 `rarn install`이 네트워크 요청 0회로 끝난다.

---

### M5 — 프로젝트 해석과 가지치기

가장 큰 실용적 이득이 나오는 단계다. `evaera/promise@4.0.0` 은 zip 안에 **340개 파일**이
들어 있지만 실제 모듈은 `lib/init.lua` **1개**다.

- [ ] `project/rojo.ts` — `default.project.json` 파싱
  - `{ "name": ..., "tree": { "$path": "lib" } }` 단순형 지원 (대다수가 여기 해당)
  - `$className`, 중첩 노드, 다중 `$path` 는 **미지원으로 판정하고 통째 복사 + 경고**
  - 프로젝트 파일 부재 시에도 통째 복사 + 경고
- [ ] `project/prune.ts` — 모듈 루트만 복사
- [ ] `.lua` / `.luau` 확장자 양쪽 처리
- [ ] 판정 결과를 락파일 `moduleRoot` 에 기록 (폴더 이름은 패키지 이름에서 유도되므로 기록 불필요)

> **절대 이것 때문에 설치를 실패시키지 않는다.** 해석 못 하면 전부 복사하고 경고만 남긴다.

**완료 기준:** promise 설치 결과가 340개가 아니라 1개 파일이고, `_Index/evaera_promise@4.0.0/promise/init.lua` 에 놓인다.

---

### M6 — 링커

- [ ] `linker/layout.ts` — `RARN_MODULE/`, `_Index/{scope}_{name}@{version}/{패키지이름}/`
- [ ] `linker/shim.ts` — shim 생성
  - 최상위: `return require(script.Parent._Index["evaera_promise@4.0.0"].promise)`
  - `_Index` 내부: `return require(script.Parent.Parent["evaera_promise@4.0.0"].promise)`
- [ ] 별칭 도출: `@evaera/promise` → `Promise`. 충돌은 하드 에러, `aliases`로 해소
- [ ] realm별 형제 디렉터리 3개: `RARN_MODULE/`, `RARN_MODULE_SERVER/`, `RARN_MODULE_DEV/`
- [ ] 교차 realm shim — `place.sharedPackages` 절대 경로 사용.
      선언이 없는데 필요하면 **무엇을 추가해야 하는지 알려주고 실패**
- [ ] shared 패키지가 server 패키지에 의존하면 거부 (플랫폼 규칙)
- [ ] 설치 = realm 디렉터리 삭제 후 재생성. **Rarn 소유 디렉터리 밖은 절대 건드리지 않는다**

**완료 기준:** Studio에 수동 배치한 뒤 `require(RARN_MODULE.Promise)` 가 실제로 동작한다.

---

### M7 — 락파일

- [ ] `lockfile/write.ts` — 키 정렬, 후행 개행. 같은 입력 → 바이트 동일 출력
- [ ] `lockfile/read.ts` — 스키마 검증, `lockfileVersion` 미래 버전은 하드 에러
- [ ] 신선도 판정: `root` 스냅샷 vs 현재 `rarn.json`
- [ ] `--frozen-lockfile` — 락파일이 낡았으면 갱신하지 않고 실패 (CI용)

**완료 기준:** `rarn install` 두 번 실행 후 `git diff rarn.lock` 이 비어 있다.

---

### M8 — CLI 명령

| 명령 | 동작 |
|---|---|
| `rarn init` | `rarn.json` 생성, `.gitignore` 갱신 |
| `rarn add <pkg>` | 해석 → 매니페스트 갱신 → 설치. `-D`, `--server` |
| `rarn install` | 락파일 우선, 낡았으면 재해석 |
| `rarn remove <pkg>` | 매니페스트에서 제거 후 재설치 (고아 정리) |
| `rarn list` | 트리 출력. `--depth`, `--json` |
| `rarn why <pkg>` | 그 패키지가 왜 들어왔는지 경로 표시 |
| `rarn dedupe` | 중복 버전 진단 및 축약 제안 |

전 명령 공통: `--verbose`, `--silent`, `--no-color`, `--cwd`.
종료 코드는 `0` 성공 / `1` 사용자 오류 / `2` 네트워크·레지스트리 오류로 구분한다.

---

### M9 — 마감

- [ ] `ora` 진행 표시 (TTY 아닐 때는 자동 비활성)
- [ ] 에러 메시지 통일: **무엇이 / 어디서 / 어떻게 고치는지** 세 줄
- [ ] 설치 요약 — 추가·제거·재사용 개수와 소요 시간
- [ ] `README.md` 사용법 확장

---

## 3. 이후 (MVP 밖)

| 항목 | 비고 |
|---|---|
| `rarn pack` → `.rbxm` | Rojo 없이 Studio 드래그. 바이너리 직렬화 필요 |
| `rarn publish` | GitHub OAuth 필요 |
| 워크스페이스 | 모노레포 |
| `--linked` 캐시 | 하드링크 옵트인 |
| `rarn doctor` | 수동 배치된 중복 패키지 탐지 |
| 크로스컴파일·릴리스 | 3개 OS 바이너리, Rokit 배포 |
| `wally.toml` 임포트 | 마이그레이션 경로 |

---

## 4. 위험 요소

| 위험 | 영향 | 대응 |
|---|---|---|
| Cargo 범위 문법 번역 누락 | 범위를 조용히 오해석 | 전용 유닛 테스트, M2에서 최우선 |
| `default.project.json` 형태가 다양함 | 잘못된 트리 배치 | 단순형만 처리, 나머지는 통째 복사 + 경고 |
| `Content-Type` 이 거짓말함 | 해제 실패 | 매직바이트로만 판별 |
| Wally API 스펙 변경 | 전면 고장 | 클라이언트를 한 파일에 격리, 검증 사실을 CLAUDE.md에 기록 |
| zip slip | 임의 파일 쓰기 | 엔트리 경로 검증 |
| Bun `--compile` 바이너리 크기 (50~110MB) | 배포 부담 | `--minify --bytecode` |
| 순환 의존성 | 무한 루프 | 방문 표시, 순환은 경고 처리 |

---

## 5. 테스트 전략

| 층 | 방식 |
|---|---|
| `resolver` | 순수 함수. 손으로 만든 메타데이터 픽스처로 표 기반 테스트 |
| `registry` | 녹화된 HTTP 픽스처. **CI에서 네트워크 금지** |
| `project` | 실제 `default.project.json` 샘플 모음 |
| `linker` | 임시 디렉터리에 설치 후 트리 구조와 shim 내용 스냅샷 |
| 통합 | `@sleitnick/knit` 설치 → 정확한 트리 검증 (네트워크 필요, 별도 태그) |

### `test/roblox/` — 실제 동작 검증장 (Rojo는 여기서만 도입)

위의 자동화 테스트는 **파일 트리가 맞는지**까지만 본다. `require` 가 런타임에 정말 해결되는지는
Roblox 안에서만 확인할 수 있다. 그래서 실제 Roblox 프로젝트를 하나 둔다.

```
test/roblox/
  rarn.json                 <- 여러 패키지를 일부러 섞어 넣은 매니페스트
  default.project.json      <- Rojo 프로젝트 (여기서만 Rojo를 쓴다)
  src/
    verify.server.luau      <- 각 패키지를 require 하고 결과를 출력
  RARN_MODULE/              <- rarn install 산출물 (gitignore)
```

**Rojo는 이 폴더 전용이다.** Rarn 자체는 Rojo에 의존하지 않으며 — 오히려 Rojo 없이 동작하는 게
목표다 — 여기서는 산출물을 Studio로 밀어넣는 **운반 수단**으로만 쓴다.

검증 시나리오는 난이도 순으로 쌓는다:

| # | 시나리오 | 무엇을 증명하나 |
|---|---|---|
| 1 | 의존성 없는 패키지 1개 (`@evaera/promise`) | 기본 트리와 shim이 맞다 |
| 2 | 전이 의존성 (`@sleitnick/knit` → comm, promise) | `_Index` 내부 형제 shim이 해결된다 |
| 3 | 두 패키지가 같은 의존성 공유 | **dedupe** — 두 경로의 require가 같은 테이블을 반환한다 |
| 4 | `serverDependencies` 포함 | realm 분리와 교차 realm 절대 경로 shim |
| 5 | major가 다른 두 버전 공존 | 비호환 버전이 각자 자기 것을 본다 |
| 6 | 가지치기 전후 비교 | 파일 수가 줄어도 동작이 같다 |

3번이 가장 중요하다. 이렇게 확인한다:

```lua
-- src/verify.server.luau
local direct   = require(game.ReplicatedStorage.RARN_MODULE.Promise)
local viaKnit  = require(game.ReplicatedStorage.RARN_MODULE._Index["sleitnick_knit@1.7.0"].Promise)
assert(direct == viaKnit, "dedupe 실패: Promise 사본이 2개다")
print("✓ dedupe 확인")
```

`direct == viaKnit` 이 참이어야 한다. 거짓이면 ModuleScript 인스턴스가 둘이라는 뜻이고,
싱글톤이 깨진다 — 파일 트리 스냅샷 테스트로는 절대 잡을 수 없는 종류의 버그다.

절차: `rarn install` → `rojo build` 또는 `rojo serve` → Studio에서 실행 → 출력 확인.
Studio MCP를 쓰지 않으므로 **마지막 실행은 수동**이다. M6 완료 시 최소 1회, 이후 링커를
건드릴 때마다 반복한다.

---

## 6. 다음 행동

1. ~~Bun 설치~~ — 완료
2. ~~M0 스캐폴딩~~ — 완료 (feat/toolchain)
3. ~~M1 매니페스트~~ — 완료 (feat/manifest)
4. ~~M2 레지스트리 클라이언트~~ — 완료 (feat/registry)
5. **M3 리졸버** — feat/resolver (다음, 가장 어려움)
6. 각 feat 브랜치는 `--no-ff` 로 `develop` 에 병합
