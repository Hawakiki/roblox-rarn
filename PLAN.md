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

### R1 — PnP 가능성 연구 ✅ (M3 앞에 삽입)

**결론: PnP식 해석 간접화는 도입하지 않는다.** 전문: [docs/pnp-feasibility.md](docs/pnp-feasibility.md)

| 기둥 | 판정 |
|---|---|
| 아카이브 저장 (설치 복사 제거) | **원리적 불가.** Roblox엔 FS가 없고 `require`는 기존 Instance만 받음 |
| 해석 간접화 | **기술적으로는 가능해졌다** — 2026-01 `@game/` 도입. 단 `.luaurc` alias는 **미지원** |
| 엄격성 | 설치 시점 정적 검사로 일부 대체 가능 |

**하지 않는 이유는 측정 결과다. 시작 가설이 틀렸다.**

"shim 파일이 폭발한다(30패키지 → 90개)"고 가정했는데, 실제 그래프를 걸어보니
**큰 프로젝트도 shim 19개**였다. Roblox 생태계의 의존성 그래프는 npm보다 훨씬 얕다
(knit 그래프 5개 중 3개가 의존성 0). 한 줄짜리 파일 19개를 없애자고 설계를 뒤엎을 이유가 없다.

**그리고 Knit이 두 겹으로 막는다.** 의존성 폴더를 변수에 담아 쓰므로 정적 재작성이
불가능하고, 그 변수 `Util`이 `@prop`으로 문서화된 **공개 API**다. shim 파일의 물리적
존재 자체가 관측 가능한 API 표면이라 없애면 사용자 코드가 깨진다.

가져온 절반:
- [x] 기존 shim 레이아웃이 require-by-string과 **이미 호환**됨을 확인 (`../Promise`)
- [ ] `rarn doctor` — 선언 ↔ 실제 require 불일치 검사 (MVP 밖)
- [ ] `_Meta.luau` — 해석 맵을 읽기 전용 데이터로 노출 (MVP 밖)

**재검토 조건:** Roblox가 `.luaurc` alias 맵을 지원하면. RFC가 "내부 검토 중"이라고 명시.

---

### M3 — 리졸버 ✅

Wally의 리졸버는 **탐욕적 + 백트래킹 없음**이라 큐 순서에 결과가 좌우되고,
`^1.2.0` 과 `^1.5.0` 처럼 명백히 풀리는 조합에서도 실패할 수 있다
(상세: [docs/wally-internals.md](docs/wally-internals.md) 2절).

**"major당 한 버전" 정책은 그대로 유지하되, 알고리즘을 순서 독립적으로 만든다.**
버전을 하나라도 고르기 전에 제약을 전부 모으는 게 핵심이다.

**고정점 반복**으로 푼다. 매 회차마다 제약을 **처음부터 다시 쌓는다.**

```
chosen = {}
반복:
    constraints = rarn.json 의 직접 의존성
    for (이름, 버전들) in chosen:                 # 선택된 버전의 의존성만 펼친다
        for 버전 in 버전들:
            for (별칭, 요구) in 버전.dependencies:
                constraints[요구.이름] += (출처=버전, 범위=요구.범위)

    next = {}
    for 이름 in constraints:                      # 이름별로 독립적으로 푼다
        후보 = 메타데이터(이름).versions
        resolutions 에 있으면 그 버전으로 고정
        next[이름] = solve(후보, constraints[이름])

    if next == chosen: 끝
    chosen = next
```

**왜 매번 다시 쌓나.** 증분으로 제약을 더하면 어떤 버전이 탈락했을 때 *그 버전이 기여했던
제약*을 정확히 걷어내야 하는데, 그 부기가 틀리기 쉽고 틀리면 과도 제약이 되어 조용히
엉뚱한 버전을 고른다. 매 회차 재구축은 그 문제가 원천적으로 없다. 메타데이터는 전부
캐시되므로 재구축 비용은 사실상 0이다.

> **이전 계획을 정정했다.** 원래는 "범위에 맞는 *모든 후보*의 의존성을 큐에 넣고 나중에
> 추린다"였는데, 범위 하나가 20개 버전에 걸리면 20개 전부의 전이 의존성을 캐게 되어
> 조합적으로 터진다. 선택된 버전의 것만 펼치고 반복하는 쪽이 단순하면서 정확하다.

**수렴.** 실전에서는 그래프 깊이 + 1회 안에 멈춘다. 다만 이론적으로는 진동이 가능하다 —
버전이 내려가면 그 의존성이 달라지고, 그래서 다른 곳의 제약이 사라져 또 다른 버전이
올라갈 수 있다. **회차 상한을 두고 초과하면 내부 오류로 실패**시킨다. 조용히 아무 답이나
내놓는 것보다 낫다.

- [x] `resolver/types.ts` — placement 규칙, realm 유효성
- [x] `resolver/select.ts` — 범위 그룹핑, 버전 선택
- [x] `resolver/resolve.ts` — 고정점 루프, placement 완화(relaxation)
- [x] `resolver/conflict.ts` — 충돌 시 **누가 뭘 요구했는지** 출력

```
X @evaera/promise 를 하나의 버전으로 통합할 수 없습니다

    ^3.2.0  <- @nevermore/signal@2.1.0 이 요구
    ^4.0.0  <- rarn.json 이 직접 요구

  두 범위는 겹치지 않아 각각 설치됩니다.
  두 사본은 런타임에 서로 다른 모듈이 되어 싱글톤이 깨질 수 있습니다.
  -> @nevermore/signal 을 올릴 수 있는지 확인하세요.
```

- [x] 순환 의존성은 자연히 종료된다 (고정점이라 별도 감지 불필요)
- [x] pre-release 는 범위가 명시적으로 언급한 경우에만 후보에 들어간다

M3 상태: **178 tests pass / eslint clean / tsc clean / biome clean.**

**완료 기준 달성 — 실서버:**

```
=== knit 하나 ===   5 packages in 1108ms
  @evaera/promise@4.0.0     shared
  @sleitnick/comm@1.0.1     shared  Option->@sleitnick/option@1.0.5 Promise->@evaera/promise@4.0.0 Signal->@sleitnick/signal@2.0.3
  @sleitnick/knit@1.7.0     shared  Comm->@sleitnick/comm@1.0.1 Promise->@evaera/promise@4.0.0
  @sleitnick/option@1.0.5   shared
  @sleitnick/signal@2.0.3   shared

=== 만족 불가 범위 ===
RN0200: No published version of evaera/promise satisfies every requirement.
  ^99.0.0              <- rarn.json (direct dependency)
  published: 4.0.0, 4.0.0-rc.2, 3.2.1, 3.2.0, 3.1.0
```

**구현하며 잡은 것 3가지:**

1. **`assemble` 이 `chosen` 을 순회하고 있었다.** 해석에 실패한 패키지는 `chosen` 에
   애초에 안 들어가므로, 에러를 내는 대신 **조용히 빠진 채 설치가 성공**했다.
   선언한 의존성이 사라지는데 아무 말도 안 하는 것 — 제약(constraints)을 순회하도록 고쳤다.
2. **중복 판정이 `semver.major` 를 쓰고 있었다.** 셀렉터는 `areCompatible` 을 쓰는데
   둘이 `0.x` 에서 갈린다. `0.2.0` 과 `0.3.0` 은 major 가 같지만 호환되지 않는다.
   정상적인 조합을 "Rarn 버그" 로 보고하고 있었다. 같은 정책은 한 함수만 써야 한다.
3. **충돌 메시지가 모든 요구자를 모든 버전 아래에 나열**하고 있었다. 그 버전이 실제로
   만족시키는 요구자만 보여주도록 고쳤다.

**placement 는 완화(relaxation)로 푼다.** 간선은 요청자의 placement 를 물려받는데
요청자의 placement 는 자기를 가리키는 간선들이 정한다 — 순환이다. 가장 좁은 realm 에서
시작해 변화가 없을 때까지 넓히면 3단계 안에서 단조 증가하므로 반드시 멈춘다.

---

### M4 — 캐시와 취득 ✅

- [x] `cache/paths.ts` — Windows `%LOCALAPPDATA%`, 그 외 XDG, `RARN_CACHE_DIR` 오버라이드
- [x] `cache/integrity.ts` — sha256 계산·검증
- [x] `cache/archive.ts` — 매직바이트 판별, zip slip 방어, 역슬래시 정규화
- [x] `cache/store.ts` — `downloads/`(zip) + `extracted/`(트리), 원자적 rename
- [x] `cache/fetch.ts` — 동시성 상한을 둔 병렬 취득
- [x] `util/concurrency.ts` — `mapWithConcurrency` (입력 순서 보존, 첫 실패 전파)

M4 상태: **209 tests pass / eslint clean / tsc clean / biome clean.**

**완료 기준 달성 — 실서버 (knit + roact, 6 패키지):**

| | 다운로드 | 캐시 | contents 요청 | 시간 |
|---|---|---|---|---|
| 콜드 캐시 | 6 | 0 | 6회 | 2153ms |
| **웜 캐시** | **0** | **6** | **0회** | **4ms** |

> **정직한 단서:** 위 4ms 는 같은 프로세스라 메타데이터도 메모리 캐시에 남아 있었다.
> 실제로 `rarn install` 을 두 번 실행하면 **contents 요청은 진짜 0회**지만 메타데이터는
> 다시 받는다. 그걸 없애는 건 락파일 단락(M7)의 몫이다.

**Windows 특이점을 반영했다.** `rename` 이 POSIX 와 달리 **기존 경로를 덮어쓰지 못한다.**
대상이 이미 있다는 건 다른 프로세스가 같은 작업을 먼저 끝냈다는 뜻이므로, 에러가 아니라
"상대 것을 쓰고 내 임시본을 버린다" 로 처리한다.

**캐시 위치는 `%APPDATA%` 가 아니라 `%LOCALAPPDATA%` 다.** 로밍 프로필은 `%APPDATA%` 를
기기 간 동기화하는데, 재생성 가능한 캐시를 네트워크로 복사할 이유가 없다.

**Wally 소스에서 본 역슬래시 문제도 처리했다.** Windows 에서 만든 zip 이 엔트리 이름에
`\` 를 박을 수 있고, 그러면 Unix 에서 디렉터리 트리가 아니라 긴 파일명 하나로 풀린다.
최신 Wally 는 쓸 때 정리하지만 그 수정 이전에 발행된 패키지가 레지스트리에 남아 있다.

**무결성은 매 설치 검증한다.** 캐시된 엔트리도 검증하므로 손상된 캐시가 통과하지 못한다.
Wally 는 `checksum` 필드를 두고도 채우지 않아 실질적으로 검증이 없다 — 버전만 고정하고
바이트를 고정하지 않는 락파일은 정작 중요한 걸 고정하지 않는다.

**구현하며 잡은 것:** 캐시에 트리는 있는데 zip 이 사라진 경우, 처음엔 *빈 바이트의 해시*를
돌려주고 있었다. 실재하지 않는 바이트를 설명하는 값이 락파일에 박힐 뻔했다. 무결성을
확인할 수 없으면 다시 받는 게 맞다.

---

### M5 — 프로젝트 해석과 가지치기 ✅

- [x] `project/rojo.ts` — `default.project.json` 해석, 모듈 루트 판정
- [x] `project/prune.ts` — 모듈 루트만 복사, 절약량 보고

M5 상태: **229 tests pass / eslint clean / tsc clean / biome clean.**

**완료 기준 달성 — 실제 레지스트리 패키지 8개:**

```
패키지                   zip   설치   절약   모듈루트 / 출처
evaera/promise           340     2    99%   lib [directory] / project-file
roblox/roact             126    79    37%   src [directory] / project-file
roblox/rodux              48    19    60%   src [directory] / project-file
jsdotlua/react            20    17    15%   src [directory] / project-file
red-blox/signal            4     1    75%   Signal.luau [file] / project-file
sleitnick/knit             5     5     0%   (zip 루트) / archive-root
sleitnick/comm            12    12     0%   (zip 루트) / archive-root
osyrisrblx/t               6     1    83%   lib [directory] / project-file
합계                      561   136    76%
```

**해석 가능한 형태만 해석한다.** 레지스트리에서 표본으로 뽑은 패키지는 전부
`{ "name": ..., "tree": { "$path": "src" } }` 하나뿐이었다. 중첩 노드나 `$className`
같은 건 트리가 무엇이 되는지를 바꾸는데 그건 Rojo 만 수행할 수 있다. 어설프게 절반만
해석해 미묘하게 틀린 걸 설치하느니 사양하고 통째로 복사한다 — 어차피 Wally 가 모든
패키지에 대해 하는 일이 그것이다.

**`$path` 도 escape 검사를 거친다.** 패키지가 제공한 데이터이므로 아카이브 엔트리와
같은 취급이다. `"../.."` 가 캐시 밖으로 나가지 못한다.

기존 계획 내용:

가장 큰 실용적 이득이 나오는 단계다. `evaera/promise@4.0.0` 은 zip 안에 **340개 파일**이
들어 있지만 실제 모듈은 `lib/init.lua` **1개**다.

- [ ] `project/rojo.ts` — `default.project.json` 파싱
  - `{ "name": ..., "tree": { "$path": "lib" } }` 단순형 지원
  - **`$path` 가 디렉터리가 아니라 파일일 수 있다** (`red-blox/signal` → `"Signal.luau"`)
  - `$className`, 중첩 노드, 다중 `$path` 는 **미지원으로 판정하고 통째 복사 + 경고**
  - **프로젝트 파일 부재는 경고 대상이 아니다** — 아래 참고
- [ ] `project/prune.ts` — 모듈 루트만 복사
- [ ] `.lua` / `.luau` 확장자 양쪽 처리
- [ ] 판정 결과를 락파일 `moduleRoot` 에 기록 (폴더 이름은 패키지 이름에서 유도되므로 기록 불필요)

> **절대 이것 때문에 설치를 실패시키지 않는다.** 해석 못 하면 전부 복사하고 넘어간다.

**실측으로 계획을 정정했다** (표본 13개, [docs/pnp-feasibility.md](docs/pnp-feasibility.md) 7절):

| 패키지 | 프로젝트 파일 | 모듈 루트 | 가지치기 효과 |
|---|---|---|---|
| sleitnick 계열 7개 | **없음** | zip 루트가 곧 모듈 | 해당 없음 |
| evaera/promise | 있음 | `lib` | 340 → 2 (100%) |
| roblox/roact | 있음 | `src` | 126 → 79 (38%) |
| jsdotlua/react | 있음 | `src` | 20 → 17 (15%) |
| red-blox/signal | 있음 | **`Signal.luau` (파일!)** | — |

- **프로젝트 파일 없는 게 표본의 절반이다.** `include` 를 잘 쓴 패키지는 zip 루트가 이미
  깨끗하다. 부재를 경고하면 설치할 때마다 경고가 절반씩 뜬다 → 조용히 zip 루트를 쓴다.
- **`$path` 가 파일을 가리키는 경우가 실제로 있다.** 디렉터리로 가정하면 깨진다.
- 가지치기 이득은 100%~15%로 편차가 크다. promise 가 극적인 건 사실이지만 일반적이지 않다.

**완료 기준:** promise 설치 결과가 340개가 아니라 1개 파일이고, `_Index/evaera_promise@4.0.0/promise/init.lua` 에 놓인다.

---

### M6 — 링커 ✅

- [x] `linker/layout.ts` — realm 디렉터리, **`packageDir` 안전 가드**
- [x] `linker/shim.ts` — shim 3종 (루트 / 형제 / 교차 realm)
- [x] `linker/link.ts` — 삭제 후 재생성, 가지치기 연결, 충돌 검출
- [x] `tests/roblox/emulate.luau` — **Roblox require 의미론 에뮬레이터** (Lune)
- [x] `tests/roblox/verify.luau` — 트리 해석 + dedupe 검증
- [x] `tests/roblox-harness.test.ts` — `bun test` 에 연결, **대조군 3개 포함**
- [x] `test/roblox/` — Studio 수동 검증장 (Rojo)
- [x] `rarn install` / `rarn add` 배선 (M8에서 당겨옴)

M6 상태: **261 tests pass / eslint clean / tsc clean / biome clean.**

**완료 기준 달성 — 실제 설치:**

```
$ rarn add @sleitnick/knit @evaera/promise
added @sleitnick/knit@^1.7.0
added @evaera/promise@^4.0.0
installed 5 packages into RARN_MODULE
  26 files, 7 links, 338 pruned
  5 downloaded, 0 cached  1619ms
```

**Wally 실물과 대조 — 뼈대 완전 일치.** 같은 매니페스트로 `wally install` 을 돌려
비교했다. shim 내용은 헤더 주석을 빼면 **바이트 단위로 동일**하다:

```
Wally: return require(script.Parent._Index["sleitnick_knit@1.7.0"]["knit"])
Rarn : return require(script.Parent._Index["sleitnick_knit@1.7.0"]["knit"])
```

유일한 차이는 가지치기다. **371 파일 → 33 파일.**

**같은 하니스를 양쪽에 돌린 결과가 이 프로젝트의 논지 그 자체다:**

| | 결과 |
|---|---|
| Rarn 산출물 | **15/15 통과** |
| Wally 산출물 (Rojo 없이) | 9/13 — `evaera/promise` 관련 4개 실패 |

Wally 쪽 실패는 Wally 의 버그가 아니다. `promise` 모듈이 `lib/` 안에 한 단계 더
들어가 있고 Rojo 가 sync 시점에 펴 주기를 전제하기 때문이다. 그 전제가 없으면
`require(_Index[...].promise)` 가 Folder 에 닿는다.

### Lune 하니스 — 무엇을 증명하고 무엇을 못 하나

`luau.load(src, { environment })` 로 `script` 와 `require` 를 주입해 **Roblox 의
require 의미론을 재구현**한다. 핵심 두 가지를 그대로 재현한다 — 인스턴스 기반 탐색,
**인스턴스 단위 캐싱**.

**대조군 없이는 하니스를 믿을 수 없으므로 3개를 테스트에 넣었다:**

| 일부러 깨뜨린 것 | 잡히나 |
|---|---|
| dedupe 파괴 (사본 2개) | O — `two copies resolved` |
| 가지치기 실패 (모듈이 한 단계 깊게) | O — `pruning may have left it nested` |
| shim 이 없는 곳을 가리킴 | O |

**패키지 코드는 기본적으로 실행하지 않는다.** 실제 패키지는 모듈 스코프에서
`game:GetService`, `task.defer`, `RunService` 이벤트를 부른다. 실행하면 *스텁이
얼마나 완전한지*를 재는 것이지 트리가 맞는지를 재는 게 아니다. 대신 패키지 모듈은
인스턴스마다 고유한 sentinel 로 해석되는데, 정작 물어야 할 두 질문에는 그걸로 충분하다.

> **한계는 분명하다.** 검증하는 건 "Roblox 에서 되는가"가 아니라 "내 에뮬레이터에서
> 되는가"다. 모델이 틀렸다면 하니스는 통과하고 Studio 는 깨진다. 그래서
> `test/roblox/` 를 **없애지 않고** 남겨 뒀다 — 링커를 건드릴 때마다 Studio 에서 1회.

**작업 중 발견:** 처음엔 shim 판별을 "Rarn 헤더 주석이 있는가"로 했는데, 그러면 Wally
산출물의 링크가 전부 패키지 코드로 오인돼 스텁 처리되고 **실패가 통과로 바뀌었다.**
`return require(...)` 한 줄이라는 구조로도 판별하도록 고쳤다.

**`packageDir` 안전 가드.** 설치는 이 디렉터리를 지우고 다시 만든다. 그런데 스키마의
문자 클래스가 `"."` 를 허용해서, 그대로 두면 shared realm 이 프로젝트 루트로 해석되어
**다음 설치 때 사용자 프로젝트 전체가 지워진다.** 복구할 방법이 없는 실패라 스키마와
런타임 양쪽에서 막는다.

기존 계획 내용:

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

### M7 — 락파일 ✅

- [x] `lockfile/types.ts` — 스키마의 TS 미러
- [x] `lockfile/write.ts` — 키 정렬, 후행 개행. 같은 입력 → 바이트 동일 출력
- [x] `lockfile/read.ts` — 스키마 검증 + **Resolution 재구성**
- [x] `lockfile/freshness.ts` — `root` 스냅샷 vs 현재 매니페스트
- [x] `--frozen-lockfile` (CI용)

M7 상태: **292 tests pass / eslint clean / tsc clean / biome clean.**

**완료 기준 달성 — 실제 설치 (knit + promise, 5 패키지):**

| 회차 | 해석 | 시간 |
|---|---|---|
| 1회차 (락파일 없음) | `resolved` | 670ms |
| **2회차 (락파일 재사용)** | **`lockfile`** | **45ms** |

`rarn install` 두 번 실행 후 `rarn.lock` 은 **바이트 동일**하다.

**M4 에서 달아둔 빚을 갚았다.** 그때 정직하게 적어둔 단서가 있었다 —
"두 번 실행하면 contents 요청은 0회지만 **메타데이터는 다시 받는다.**" 이제 락파일이
신선하면 **해석 단계를 통째로 건너뛴다.** 네트워크를 쓰는 단계는 해석뿐이므로
(취득은 캐시, 링크는 로컬) 재설치가 완전히 오프라인이 된다.

**신선도 판정은 의도적으로 비대칭이다.** 너무 엄격하면 라운드트립 몇 초를 낭비할 뿐이지만,
너무 느슨하면 **매니페스트가 더는 요구하지 않는 버전을 설치하고 성공했다고 보고한다.**
그래서 모든 비교가 "낡음" 쪽으로 기울어 있다.

비교 대상은 **해석에 영향을 주는 것만**이다. `packageDir`, `place`, `aliases` 는 파일이
어디 놓이는지를 바꿀 뿐이고 링크는 매 설치 실행되므로, 이것들로 무효화하면 디렉터리
이름 하나 바꿨다고 전체 재해석을 하게 된다.

**범위는 정규형으로 비교한다.** `^1.0.0` 을 `1.x` 로 고쳐 써도 요구사항은 그대로이므로
낡았다고 보지 않는다. 반면 `^1.0.0`(= `>=1.0.0 <2.0.0-0`)과 `>=1.0.0 <2.0.0` 은
프리릴리스 취급이 달라 **진짜로 다른 요구사항**이고, 정규형이 그 차이를 정확히 잡는다.

**작업 중 잡은 것 — 이름이 같은 두 개의 다른 값:**

락파일 최상위 `registry` 는 아카이브를 받아온 **API URL**(`api.wally.run/`)이고,
매니페스트의 `registry` 는 **인덱스 저장소 URL**(`github.com/UpliftGames/wally-index`)이다.
신선도 검사가 이 둘을 비교하고 있어서 **모든 락파일이 영원히 낡은 것으로 판정**됐다.
테스트 5개가 동시에 실패해서 드러났다. 인덱스 URL 을 `root.registry` 로 따로 기록하고
그걸 비교하도록 고쳤다.

**`moduleRoot` 는 정보용이다.** 설치할 때는 캐시된 아카이브에서 다시 유도한다. 작은 파일
하나 더 읽는 비용이, 낡은 락파일이 설치 내용을 조용히 바꾸는 부류의 버그보다 싸다.

**`--production` 은 락파일을 쓰지 않는다.** devDependencies 를 뺀 그래프는 매니페스트를
더 이상 설명하지 않으므로, 그걸로 덮어쓰면 다음 사람이 잘못된 락파일을 받는다.

---

### M8 — CLI 명령 ✅

**이미 동작하는 것:** `init` `add` `install` — M1·M6 에서 배선했다.

M8 은 **10개**를 추가한다. 발행 계열은 이번에 넣지 않는다 (아래 M10).

전 명령 공통: `--verbose`, `--silent`, `--no-color`, `--cwd`.
종료 코드는 `0` 성공 / `1` 사용자 오류 / `2` 네트워크·레지스트리 오류.

#### A. 편집·조회 (5개) — 밑단이 전부 있음

| 명령 | 옵션 | 하는 일 | 크기 |
|---|---|---|---|
| `remove <pkg...>` | | 매니페스트에서 제거 후 재설치 | S |
| `up [pkg...]` | `--latest` | 범위 내 최신으로 올리고 **매니페스트 범위도 갱신** | S |
| `list` (`ls`) | `--depth` `--json` | 락파일로 트리 출력. 네트워크 0 | S |
| `why <pkg>` | `--json` | 루트까지 역추적 | S |
| `dedupe` | `--json` | 중복 버전 진단 | S |

- `remove` 는 **어느 섹션에 있든 찾아서** 지운다. `withoutDependency` 가 M1 에 이미 있고
  아직 안 쓰인다. 없는 패키지를 지우라고 하면 조용히 성공하지 말고 그렇게 말한다.
- `up` 은 `install` 과 다르다. `install` 은 매니페스트를 안 건드리지만 `up` 은
  **범위를 새 버전에 맞춰 다시 쓴다** (Yarn 과 동일). `--latest` 는 선언된 범위를 무시한다.
- `why` 는 락파일의 `requestedBy` 가 곧 역방향 간선이라 **네트워크 없이** 된다.
  직접 요구자만이 아니라 **루트까지의 경로 전체**를 보여준다.

> **`dedupe` 는 Yarn 과 역할이 다르다.** Yarn 의 `dedupe` 는 재해석해서 버전 수를 줄인다.
> Rarn 의 리졸버는 **이미 제약을 다 모은 뒤 교집합으로 푸는** 순서 독립 알고리즘이라
> 결과가 항상 최소다 — 더 줄일 여지가 없다. 그래서 Rarn 의 `dedupe` 는 축약이 아니라
> **"왜 못 합쳤는지 설명하고 `resolutions` 를 제안"** 하는 진단 명령이다.

#### B. 탐색 (3개)

| 명령 | 하는 일 | 크기 |
|---|---|---|
| `search <query>` | 레지스트리 검색 | **XS** |
| `info <pkg>[@ver]` | 버전 목록·설명·라이선스·realm·의존성 | S |
| `outdated` | 설치본 vs 범위 내 최신 vs 전체 최신 | S |

> `search` 는 **M2 에서 이미 구현했고 버그까지 고쳤는데** (scope/name 분리 필드)
> 아무 데서도 안 부른다. 배선만 하면 끝난다.

`outdated` 는 Yarn Classic 형식으로 `current / wanted / latest` 3열. CI 용으로
낡은 게 있으면 종료 코드를 1로 할지는 구현 시 결정한다 — 기본은 0, `--check` 로 옵트인이
안전해 보인다.

#### D. 유지보수 (2개)

| 명령 | 하는 일 | 크기 |
|---|---|---|
| `cache dir\|clean\|verify` | 캐시 경로 출력 / 비우기 / 무결성 재검사 | S |
| `doctor` | 선언 ↔ 실제 require 불일치 검사 | M |

- `cache verify` 는 `downloads/` 를 다시 해싱해 `extracted/` 와 대조한다.
  M4 의 무결성 코드를 그대로 쓴다.
- `cache clean` 은 **되돌릴 수 없으므로** 지울 용량과 항목 수를 먼저 보여준다.
- `doctor` 는 [R1 연구](docs/pnp-feasibility.md) 5-2 에서 나온 항목이다. 패키지 소스가
  `script.Parent.Parent.X` 를 부르는데 `X` 가 선언된 의존성에 없으면 경고, 반대로 선언만
  하고 안 쓰면 경고. **표본의 4.5% 는 동적 require 라 검사 불가인데, 그 사실을 그대로 보고한다.**
  Wally 에 없는 영역이다.

---

#### 실측 결과

10개 전부 구현·배선했다. 아래는 `@sleitnick/knit` + `@evaera/promise` 를 설치한
스크래치 프로젝트에서 실제로 받은 출력이다.

| 명령 | 확인한 것 |
|---|---|
| `remove` | 매니페스트에서 지우고 재설치. 없는 패키지는 `RN0002` 로 거부하고 **아무것도 안 지운다** |
| `up` | `^1.4.0` → `^1.7.0` 으로 **범위까지 다시 씀**. `--latest` 는 범위를 넘어 `^3.2.1` → `^4.0.0` |
| `list` | 트리 + 중복 경고. 재방문 노드는 `·` 로 접는다 |
| `why` | 루트까지의 경로 전체. 사슬이라 항상 `└─` |
| `dedupe` | 버전별 요구자와 범위, `resolutions` 제안 |
| `search` | `--limit` 동작. M2 의 scope/name 분리 필드 그대로 |
| `info` | 버전 목록·realm·라이선스·의존성 |
| `outdated` | `current / wanted / latest` 3열. 범위 밖 최신만 노랑 |
| `cache` | `dir` / `clean` / `verify` — verify 는 락파일과 대조 |
| `doctor` | 아래 |

`up` 이 실제 중복을 만들어 `dedupe` 를 검증할 재료가 되어 줬다:

```
@evaera/promise is installed at 2 versions:
  4.0.0
    >=4.0.0 <5.0.0       <- @sleitnick/comm@1.0.1
    >=4.0.0 <5.0.0       <- @sleitnick/knit@1.7.0
  3.2.1
    ^3.2.1               <- rarn.json (direct dependency)

  Force one version with:  "resolutions": { "@evaera/promise": "4.0.0" }
```

**`doctor` 는 대조군으로 검증했다.** 통과만으로는 검사기가 아무것도 안 하고 있는
경우와 구별이 안 되기 때문이다.

| 주입한 결함 | 결과 |
|---|---|
| 선언 안 한 `NotDeclared` 를 require | `requires NotDeclared — not a declared dependency` + 파일·줄 번호, 종료 1 |
| Knit 소스에서 `Comm` require 제거 | `declares Comm — never required`, 종료 0 |

두 번째가 중요하다. Knit 은 `KnitClient.Util = (script.Parent :: Instance).Parent`
로 한 번 변수를 경유해서 require 한다. **그 require 를 지웠을 때만 `unused` 로 바뀌었다는 건
스캐너가 변수 경유를 실제로 따라가고 있다는 뜻이다** — 안 따라갔다면 애초에 `Comm` 을
쓰는 걸 못 봤을 테니 지우기 전에도 `unused` 라고 했을 것이다.

`missing` 은 런타임에 `nil` 이 되는 진짜 결함이라 종료 1, `unused` 는 매니페스트가
넉넉한 것뿐이라 종료 0 으로 나눴다.

스캐너가 못 보는 것도 그대로 보고한다: `7 requires are built at runtime and could not be checked`.

문자열 처리에 걸린 게 하나 있다. 주석 속 예제 코드를 진짜 require 로 읽지 않으려면
문자열을 지워야 하는데, 그러면 `folder["Promise"]` 의 이름까지 날아간다. 이름 하나짜리
리터럴만 남기고 나머지를 지우는 것으로 갈랐다 — `require(...)` 를 숨길 만큼 긴 문자열이
문제였던 거지 짧은 이름은 아니었다.

전체 검사 초록: 315 tests pass, 0 fail (12 files, 1467ms).

---

### M10 — 발행 ✅

원래 M8 에서 빼기로 했다가, 시간 사정으로 여기서 같이 끝냈다. 바이너리 배포는 여전히 나중이다.

조사해 둔 API 사실은 아래 그대로다.

| 항목 | 확인된 사실 |
|---|---|
| 엔드포인트 | `POST {api}/v1/publish` |
| 헤더 | `Wally-Version`, `Authorization: Bearer <token>`, `accept: application/json` |
| 본문 | **raw zip 바이트** (multipart 아님) |
| 크기 제한 | **2 MiB** |
| 로그인 | **GitHub device flow** — `github.com/login/device/code` → 폴링 → `login/oauth/access_token` |
| client_id | 인덱스 `config.json` 의 `github_oauth_id` (기본 인덱스: `7bd503594a0f9a9f7ed3`) |
| 토큰 저장 | API URL 별. Wally 는 `~/.wally/auth.toml` |
| 에러 | `400` 이름·버전·zip 문제 / `401` 스코프 권한 없음 / `409` **버전 이미 존재** / `500` 저장 실패 |

**핵심 제약 — 서버가 zip 안의 `wally.toml` 을 읽는다.** 백엔드 publish 핸들러가 업로드된
아카이브에서 `wally.toml` 을 꺼내 파싱해 패키지 이름과 버전을 얻는다. 따라서
`rarn publish` 는 **`rarn.json` 에서 `wally.toml` 을 생성해 zip 에 넣어야** 한다.

**여기서 파생되는 제약:** 생성된 `wally.toml` 의 범위는 **Cargo 문법이어야** 한다.
`^1.0.0`, `~1.2.3`, `>=1.0.0, <2.0.0` 은 되지만 **`||`(OR)와 하이픈 범위는 Cargo 에 없다.**
그런 범위를 쓴 프로젝트는 발행 시 거부하거나 경고해야 한다.

**첫 발행 시 스코프가 자동으로 등록된다.** 오타난 스코프로 발행하면 그 스코프를 점유한다.

구현한 명령: `login` `logout` `whoami` `pack` `publish`.

#### 실측 결과

| 확인 | 결과 |
|---|---|
| `wally.toml` 생성 | `rarn.json` 에서 만들어 zip 에 넣는다. 프로젝트에 있던 `wally.toml` 은 덮어쓴다 |
| Cargo 범위 변환 | `>=1.0.0 <2.0.0` → `>=1.0.0, <2.0.0`. `||` 와 하이픈 범위는 거부 |
| `pack --list` | 파일 목록과 크기, 2 MiB 대비 비율 |
| `publish --dry-run` | 생성될 `wally.toml` 을 그대로 보여주고 업로드는 안 한다 |
| `private: true` | `RN0624` 로 차단. 다른 어떤 실패보다 먼저 검사한다 |
| 로그인 안 한 상태 | `RN0600`, 종료 1 |
| `logout` 두 번 | 실패가 아니라 "not logged in". 상태를 요구하는 명령이고 그 상태는 이미 성립한다 |

**`.env` 가 아카이브에 들어가는 걸 실측에서 잡았다.** `pack --list` 를 처음 돌렸을 때
`.env` 가 그대로 목록에 있었다. 발행은 되돌릴 수 없고 레지스트리에 unpublish 가 없으므로,
올라간 자격증명은 회수가 아니라 교체밖에 답이 없다. 기본 제외에 `.env`, `.env.*`,
`*.key`, `*.pem` 을 넣었다.

틀릴 수 있는 두 방향이 대칭이 아니다 — 한 파일을 덜 보내면 설치가 깨지고 몇 분 만에 고쳐지지만,
한 파일을 더 보내면 아예 되돌릴 수가 없다.

**`include` 가 기본 제외를 이기게 하되, 정확한 경로일 때만.** 처음엔 주석에
"`include` 에 적으면 된다" 고 써 놓고 구현은 `exclude` 가 무조건 이기게 돼 있었다.
테스트 이름은 그걸 검증한다고 했지만 실제로는 아무것도 검증하지 않았다.
`.env` 라고 정확히 쓰는 건 의도일 수밖에 없지만 `src/**` 는 디렉터리에 대한 말이지
거기 있는 줄도 몰랐던 `src/.env` 에 대한 말이 아니다. 그래서 글롭은 못 이긴다.

**업로드는 재시도하지 않는다.** 나머지 호출은 멱등한 읽기라 재시도하지만, 이건 쓰기이고
타임아웃 뒤의 결과를 정말로 알 수 없다. 첫 시도가 성공했는데 재시도하면 두 번째 발행이 되고,
레지스트리는 `409` 로 막아 주긴 하지만 성공한 일을 실패로 보고하게 된다.

`mtime` 은 ZIP 에포크(1980-01-01)로 고정한다. 같은 입력이 같은 바이트를 내야
`pack` 두 번이 "비슷한 두 개" 가 아니라 "하나" 임을 확인할 수 있다. `0` 은 중립값이
아니라 인코딩 불가능한 값이다 — ZIP 은 DOS 날짜를 저장해서 1980 이전을 표현하지 못한다.

**아직 라이브로 발행해 보지는 않았다.** 레지스트리 버전은 불변이라 시험 발행이
영구히 남고 스코프까지 점유한다. `--dry-run` 까지만 확인했다.
> **발행은 되돌릴 수 없다.** 레지스트리는 버전을 불변으로 보고 `409` 로 재발행을 막는다.
> `pack --list` 와 `publish --dry-run` 은 선택이 아니라 필수다.

아직 안 한 것: `.gitignore` 폴백 (지금은 기본 제외 목록만), 라이브 발행 검증.

---

### M9 — 마감 ✅

- [x] `ora` 진행 표시 (TTY 아닐 때는 자동 비활성)
- [x] 에러 메시지 통일: **무엇이 / 어디서 / 어떻게 고치는지**
- [x] 설치 요약 — 캐시 적중과 락파일 재사용까지
- [x] `README.md` 사용법 확장

**진행 표시는 stderr 로 나간다.** 여러 명령이 stdout 에 JSON 을 뱉는데,
스피너가 그 스트림 한가운데서 자기 줄을 다시 그리면 어떤 파서도 못 읽는 출력이 된다.
진행 상황은 진단이므로 진단 채널에 속한다.

TTY 가 아니면 아예 사라진다. 줄을 다시 그리는 이스케이프 코드는 CI 로그에서
수백 줄의 쓰레기가 된다. 파이프·리다이렉트 상태에서는 `--verbose` 일 때만 단계별로
한 줄씩 찍고, 나머지는 설치 요약이 대신한다.

에러 쪽에서 새로 잡은 것:

| 항목 | 내용 |
|---|---|
| 오프라인 | `ENOTFOUND` 류를 가로채 `RN0100` 으로. Node 원문(`getaddrinfo ENOTFOUND`)은 내부 결함처럼 읽힌다 |
| 종료 코드 | `exitCodeFor` 로 분리 — 사용자 오류 `1`, 레지스트리·네트워크 `2` |
| `--verbose` | `RarnError.cause` 와 스택을 보여준다. 평소엔 절대 안 보인다 |
| 코드 없는 에러 | "Rarn 의 버그" 라고 그대로 말한다. 사용자 잘못처럼 포장하면 없는 실수를 찾게 만든다 |

**색 처리에서 한 번 오진했다.** 파이프에 색이 나오고 `NO_COLOR` 가 안 먹길래
`bun build --compile` 바이너리에서 chalk 의 TTY 감지가 깨진 줄 알았는데,
실제 원인은 내 셸에 걸려 있던 `FORCE_COLOR=3` 이었다. chalk 는 멀쩡했다.

그래서 실제로 바꾼 건 우선순위 하나뿐이다. chalk 는 `FORCE_COLOR` 가 `NO_COLOR` 를
이기게 하는데, 여기서는 `NO_COLOR` 가 이긴다 — 터미널은 자기가 띄우는 모든 것에
`FORCE_COLOR` 를 한 번 걸어두지만 `NO_COLOR` 는 *이번 실행*에 대고 거는 것이라,
더 구체적인 요청이 이겨야 한다.

`isTTY` 는 Node 타입이 `boolean` 이라고 하지만 파이프에서는 `undefined` 다.
선언을 곧이곧대로 믿으면 타입 검사기 눈에 undefined 분기가 도달 불가로 보이고,
그게 멀쩡한 가드가 "불필요하다" 며 지워지는 경로다. 실제 타입을 `isInteractive`
한 곳에 적어 두고 거기서만 읽는다.

---

### M11 — CI와 빌드 검증 ✅

**목표:** `develop`/`master` 로 가는 PR 이 사람 손 없이 검증되고, 3개 OS 바이너리가 매번
실제로 실행되는지까지 확인된다.

`.husky/pre-commit` 은 로컬 전용이다. 훅이 죽으면 `--no-verify` 가 정답처럼 보이기 시작하고,
그 순간부터 아무것도 검증되지 않는다. CI 는 그 마지막 그물이다.

| 잡 | 축 | 내용 |
|---|---|---|
| `check` | `os: [ubuntu, windows]` | `bun run check` (format → lint → typecheck → test) |
| `build` | `target: [windows-x64, darwin-arm64, linux-x64]` | ubuntu 한 대에서 전부 크로스컴파일, 아티팩트 업로드 |
| `smoke` | `os` ↔ `target` 매핑 | 각 바이너리를 **자기 OS 에서** 실행. `--version`, `--help`, `pack --list` |
| `release` | — | 태그 기반. **스켈레톤만 두고 비활성** (1.0.0 에서) |

매트릭스 축이 두 개인 것이 아니라 **잡마다 축이 다르다.** 합치면 안 된다:

- `build` 의 축은 *타깃* 이고 러너는 하나다. 한 호스트에서 3개가 다 나오는지가 검증 대상이기
  때문이다 (CLAUDE.md 가 주장하는 사실이므로 CI 가 매번 재확인해야 한다).
- `smoke` 의 축은 *러너 OS* 다. 빌드 성공은 동작 보장이 아니다 — ubuntu 가 만든 darwin
  바이너리는 ubuntu 에서 실행조차 안 되므로, 만든 곳에서 확인하면 아무것도 확인한 게 아니다.
- `fail-fast: false`. 윈도우만 깨졌는데 리눅스 결과까지 취소되면, 깨진 게 플랫폼 문제인지
  공통 문제인지 판단할 근거가 사라진다.

**윈도우 러너는 뺄 수 없다.** 테스트가 임시 디렉터리와 경로 구분자를 만지고, `renameIntoPlace`
는 "윈도우는 기존 경로 위로 rename 하지 못한다" 는 사실 위에 서 있다. 리눅스에서만 도는 CI 는
그 분기를 한 번도 밟지 않는다.

**CI 에서 네트워크를 금지한다.** 지금 "레지스트리 테스트는 픽스처로" 는 관례일 뿐이라, 누군가
테스트에 실제 요청을 하나 넣으면 조용히 통과하고 그때부터 CI 는 api.wally.run 의 가용성을
같이 테스트하게 된다. `RARN_NO_NETWORK=1` 을 레지스트리 클라이언트가 읽어 즉시 `RN01xx` 로
던지게 하고 CI 환경에 걸어 두면, 관례가 규칙이 된다. 같은 스위치를 M12 의 `--offline` 이
그대로 쓴다.

**판정:** lint 를 일부러 깨뜨린 PR 이 머지 불가가 되는가. 스모크 3개가 전부 초록인가.

#### 실측 결과

8개 잡 전부 초록. 다섯 판 돌렸고, 초록이 되기까지 CI 가 잡아낸 것이 셋이다.

| # | 잡은 것 | 어떻게 드러났나 |
|---|---|---|
| 1 | 하니스가 약속한 스킵을 안 하고 있었다 | 첫 판, 양쪽 OS 에서 lune 이 없어 ENOENT. 주석에는 "Skipped when Lune is absent" 라고 적혀 있었지만 코드에는 없었다 |
| 2 | **ubuntu 에서 만든 윈도우 바이너리가 시작하자마자 세그폴트** | `build` 는 초록, `smoke (windows)` 만 빨강. 빌드 로그에는 아무 것도 없다 |
| 3 | cache 테스트의 ZIP 이 비결정적 | 윈도우 러너에서 한 번 터졌다. 앞 판에서는 통과했다 |

2번을 대조군으로 갈랐다. 같은 호스트, 같은 타깃, `--bytecode` 만 뺀 빌드는 스모크
여섯 개를 전부 통과한다. 깨지는 조합은 **"윈도우 타깃 + 크로스컴파일 + bytecode"**
하나다 — 같은 호스트의 darwin-arm64 는 macOS 에서 정상이고, 윈도우에서 네이티브로
만든 것도 정상이다.

bytecode 는 시작을 178ms → 152ms 로 줄인다(윈도우, `--version` 10회 평균). 15% 를
포기하는 대신 윈도우만 네이티브로 짓기로 했다. 하필 윈도우가 Roblox 개발자가 가장 많이
쓰는 플랫폼이라, 거기를 느리게 만드는 선택은 가장 나쁜 쪽으로 틀리는 것이다.
CLAUDE.md 의 "어느 호스트에서든 크로스컴파일된다" 는 주장은 이 예외를 달아 고쳤다.

3번은 `makeZip` 이 `zipSync` 에 `mtime` 을 안 넘겨 현재 시각이 찍힌 것이었다.
`pack.ts` 는 같은 이유로 이미 고정하고 있었는데 테스트 헬퍼만 안 하고 있었다.
두 호출이 DOS 타임스탬프 눈금을 사이에 두고 떨어질 때만 어긋나므로, 로컬에서는
거의 안 터지고 러너에서만 가끔 터진다. **CI 없이는 못 잡는 종류다.**

| 항목 | 결과 |
|---|---|
| `check` (ubuntu / windows) | 초록. 하니스 포함 363 tests |
| `build` ×3 | 초록. windows 는 네이티브, 나머지는 ubuntu 에서 크로스컴파일 |
| `smoke` ×3 | 초록. 6개 검사 (`--version`, `--help` 18명령, `init`, `pack --list`, RN0510, RN0130) |
| 전체 소요 | 약 2분 |

브랜치 보호는 걸지 않았다. 리포가 private 이라 필수 상태 검사는 유료 플랜에서만 된다.
그래서 "빨간 PR 은 머지 불가" 는 아직 규칙이 아니라 관례다.

아직 안 한 것: 릴리스 잡(M16), `build` 잡의 의존성 캐시.

---

### M12 — 설치 트리 원자성과 오프라인 ✅

**목표:** 설치가 중간에 죽어도 결과는 *이전 트리 그대로* 이거나 *완전히 새 트리* 이거나, 둘 중
하나다.

지금 `link()` 는 realm 디렉터리를 먼저 `rm` 하고 제자리에서 다시 짓는다. Ctrl-C 한 번이면
멀쩡하던 트리는 이미 사라졌고 반쪽만 남는다. `cache/store.ts` 가 정확히 이 문제를 temp+rename
으로 이미 풀어 두었는데 링커만 그 기준에 미달이다 — 안 만든 기능이 아니라 **자기 기준을 한
군데서 안 지킨 것** 이라 성격이 다르다.

| 단계 | 내용 |
|---|---|
| 1 | 모든 realm 을 `<projectDir>/.rarn-tmp/<realm>` 에 **전부** 짓는다 |
| 2 | 다 완성된 뒤에야 스왑. realm 별로 `기존 → .rarn-old-N`, `신규 → 제자리`, `.rarn-old-N` 삭제 |
| 3 | 시작 시 남아 있는 `.rarn-tmp` / `.rarn-old-*` 는 이전 실행의 잔해로 보고 청소 |

temp 를 OS 임시 디렉터리가 아니라 **프로젝트 안** 에 두는 이유는 캐시와 같다. 크로스디바이스
rename 은 원자적이지 않고, 조용히 복사로 전락한다.

realm 3개에 걸친 스왑은 원자적이지 않다. 그 창을 *디렉터리 rename 두 번* 까지 줄이는 것이
현실적 최선이고, **그 한계를 주석에 적는다.** 원자적인 척하는 편이 안 하는 것보다 나쁘다.

같이 넣는 스위치:

| 플래그 | 동작 |
|---|---|
| `--offline` | 네트워크가 필요해지면 실패. 락파일 재사용으로 되면 그대로 진행 |
| `--prefer-offline` | 캐시에 있으면 캐시, 없으면 받는다 |
| `RARN_NO_NETWORK` | 같은 차단을 환경변수로. M11 의 CI 가 이것을 쓴다 |

신선한 락파일이면 지금도 결과적으로 오프라인이지만 **그건 우연이지 보장이 아니다.** 비행기에서
`rarn install` 이 45ms 에 끝날지 타임아웃 30초를 먹을지 실행해 봐야 아는 상태다.

**판정:** 링크 도중 강제 종료 → 이전 트리로 Studio 가 그대로 뜨는가. `--offline` 로 캐시에 없는
패키지를 요청 → 네트워크를 타지 않고 즉시 실패하는가.

#### 실측 결과

`src/linker/swap.ts` 가 새로 생겼고 `link()` 는 `.rarn-tmp` 에 지은 뒤 realm 별로
`기존 → .rarn-old-<token>`, `신규 → 제자리` 로 바꿔 넣는다. 366 → **373 tests**
(원자성 5개 + 오프라인 2개 추가).

| 확인 | 결과 |
|---|---|
| 성공 후 잔여물 | `.rarn-tmp`, `.rarn-old-*` 둘 다 없음 |
| 링크 중 실패 | 이전 트리 파일 내용까지 그대로. 스테이징도 정리됨 |
| 더 이상 안 쓰는 realm | 제거됨 (server 의존성을 빼면 `RARN_MODULE_SERVER` 가 사라진다) |
| 중단된 실행의 잔해 | 다음 실행 시작 시 청소됨 |
| `--offline` + 신선한 락파일 | 69ms, 네트워크 0회 |
| `--offline` + 어긋난 락파일 | RN0130, 종료 코드 1, **기존 트리는 살아 있음** |

**테스트 하나가 바로 값을 했다.** 실패 경로에서 `.rarn-tmp` 가 남는 것을 잡았다.
다음 실행이 어차피 치우지만 "다음 실행" 은 며칠 뒤일 수 있고, 그 사이에 반쯤 지어진
트리가 커밋된다. `link()` 를 `try/finally` 로 감싸 실패해도 치우게 했다.

**`--prefer-offline` 은 넣지 않았다.** Yarn 의 그것은 캐시된 *메타데이터* 를 선호한다는
뜻인데 Rarn 은 아카이브만 캐시하고 메타데이터는 캐시하지 않는다. 지금 넣으면 이미
일어나는 일을 설명할 뿐 아무것도 바꾸지 않는 플래그가 된다 — 아무것도 안 하면서 뭔가
하는 척하는 플래그는 없는 것만 못하다. 메타데이터를 캐시하는 날 돌아온다.

**라이브로 못 한 것:** 링크 도중 실제 Ctrl-C. 캐시가 따뜻하면 링크 구간이 수십 ms 라
손으로 그 창을 맞출 수 없다. 유닛 테스트가 같은 실패 지점을 결정적으로 재현하므로
그쪽을 근거로 삼았다.

새 코드: `RN0420` (스왑 실패 후 롤백도 실패). 윈도우에서 Studio 나 rojo serve 가 파일을
잡고 있으면 rename 이 거부되고, 되돌리는 rename 도 같은 이유로 실패할 수 있다. 그때
사용자가 트리 둘 다 없이 남겨지지 않도록 이전 트리가 어디 있는지 말한다.

`init` 이 `.gitignore` 에 `.rarn-tmp/` 와 `.rarn-old-*/` 도 넣는다.

---

### M13 — `rarn import` — Wally 에서 이주 ✅

**목표:** 기존 Roblox 프로젝트에서 `rarn import && rarn install` 두 줄로 끝난다.

기존 프로젝트는 **전부** `wally.toml` 을 갖고 있다. 이주 경로가 없으면 "좋은데 옮기기 귀찮네"
에서 끝나므로, 채택 관점에서는 이것이 M11~M15 중 가장 값이 크다.

`renderWallyToml` 의 역방향이고, **역방향에만 있는 함정이 하나 있다.**

> **Cargo 에서 맨 버전은 정확한 버전이 아니라 캐럿이다.** `Promise = "evaera/promise@4.0.0"`
> 은 `4.0.0` 이 아니라 `^4.0.0` 을 뜻한다. exact 로 옮기면 모든 의존성이 조용히 못 박히고,
> 아무 에러 없이 영원히 업데이트되지 않는 프로젝트가 된다. `toCargoRange` 가 이 문제의 절반
> 이었다면 이쪽이 나머지 절반이며, **이쪽이 훨씬 조용히 틀린다** — 설치는 성공하고 트리도
> 멀쩡하다.

| wally.toml | rarn.json | 주의 |
|---|---|---|
| `[package] name` | `name` | `@scope/name` 로 `@` 부착 |
| `version`, `realm`, `registry` | 동일 | `registry` 는 인덱스 저장소 URL |
| `[dependencies]` | `dependencies` | 범위 역번역 |
| `[server-dependencies]` | `serverDependencies` | |
| `[dev-dependencies]` | `devDependencies` | |
| `[place]` 항목 | `place` | 교차 realm shim 이 여기에 의존한다 |
| 키 이름(별칭) | `aliases` | **파생 별칭과 다를 때만** 기록 |

범위 역번역: `,` → 공백(AND), 맨 버전 → 캐럿, `=1.0.0` → `1.0.0`, `*` → `*`. 애매한 것은
추측하지 말고 그대로 둔 뒤 경고한다 — 발행 쪽에서 `||` 를 넓히지 않고 거부한 것과 같은 원칙이다.

**`wally.lock` 은 가져오지 않는다.** Wally 락파일은 `checksum` 이 비어 있어서, 옮겨 봐야
검증 불가능한 다이제스트를 가진 락파일이 된다. 다시 해석하는 편이 옳고, 그 과정에서 제약 5의
순서 무관 해석이 Wally 와 다른 (더 나은) 결과를 내놓는 것을 바로 보여 주게 된다.

부가: `--dry-run`, 기존 `rarn.json` 이 있으면 `--force` 없이 거부, 변환 요약표 출력.

**판정:** 실제 공개 프로젝트 3개 — knit 사용 1, react-lua 사용 1, 의존성 10개 이상 1 — 를
import → install → Lune 하니스 통과.

#### 실측 결과

판정을 그대로 통과했고, 그 위에 **`wally install` 과 해석 결과가 같은지**까지 봤다.
rokit 으로 실제 wally 0.3.2 를 돌려 같은 `wally.toml` 을 설치하고 `_Index` 를 비교했다.

| 프로젝트 | 패키지 | 해석 일치 | 하니스 |
|---|---|---|---|
| knit + component | 8 | ✅ | 20/20 |
| react-roblox (react-lua) | 16 | ✅ | 58/58 |
| luau-polyfill (직접 의존성 10개) | 10 | ✅ | 35/35 |

409 tests (373 → 409). 스모크 9개.

#### 조사부터 했다

문법을 추측하지 않으려고 레지스트리를 먼저 훑었다. 두 가지가 나왔고, 둘 다 계획서의
가정을 바꿨다.

**1. 인덱스는 요구사항을 항상 펼쳐서 저장한다.** 60개 패키지 231개 버전의 의존성 선언
76건이 **전부** `>=X, <Y` 였다. 맨 버전도, `^` 도, `~` 도 하나도 없다.

**2. 그런데 손으로 쓴 `wally.toml` 은 정반대다.** 패키지 zip 에서 실제 매니페스트를
꺼내 보니 `@4`, `@2`, `@1.0.0`, `@17.2.1` 같은 맨 버전이 다수였다.

두 개를 나란히 놓으면 캐럿 규칙이 **이 레지스트리 자체 데이터로 증명된다**:

| 손으로 쓴 것 | 인덱스가 저장한 것 |
|---|---|
| `evaera/promise@4` | `>=4.0.0, <5.0.0` |
| `red-blox/spawn@1.0.0` | `>=1.0.0, <2.0.0` |
| `jsdotlua/shared@17.2.1` | `>=17.2.1, <18.0.0` |

라이브로도 확인했다. `Signal = "sleitnick/signal@2.0.0"` 하나만 있는 프로젝트에서
rarn 과 wally 가 **둘 다 2.0.3** 을 설치한다. exact 로 옮겼다면 2.0.0 에 못박혔을 것이다.

계획서에는 "애매한 건 그대로 두고 경고" 라고 적었는데, **그럴 일이 없다.** Cargo 문법은
npm 문법의 부분집합이다(`||` 도 하이픈 범위도 Cargo 에는 없다). 이 방향은 전사(全射)라
포기할 요구사항이 존재하지 않고, 못 읽으면 그건 깨진 파일이라 하드 에러가 맞다.

#### 도중에 나온 버그 둘 — 둘 다 M13 과 무관한 기존 것

**`alias` 패턴이 하이픈을 금지하고 있었다.** 두 스키마 모두 `^[A-Za-z_][A-Za-z0-9_]*# Rarn — 구현 계획

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

### R1 — PnP 가능성 연구 ✅ (M3 앞에 삽입)

**결론: PnP식 해석 간접화는 도입하지 않는다.** 전문: [docs/pnp-feasibility.md](docs/pnp-feasibility.md)

| 기둥 | 판정 |
|---|---|
| 아카이브 저장 (설치 복사 제거) | **원리적 불가.** Roblox엔 FS가 없고 `require`는 기존 Instance만 받음 |
| 해석 간접화 | **기술적으로는 가능해졌다** — 2026-01 `@game/` 도입. 단 `.luaurc` alias는 **미지원** |
| 엄격성 | 설치 시점 정적 검사로 일부 대체 가능 |

**하지 않는 이유는 측정 결과다. 시작 가설이 틀렸다.**

"shim 파일이 폭발한다(30패키지 → 90개)"고 가정했는데, 실제 그래프를 걸어보니
**큰 프로젝트도 shim 19개**였다. Roblox 생태계의 의존성 그래프는 npm보다 훨씬 얕다
(knit 그래프 5개 중 3개가 의존성 0). 한 줄짜리 파일 19개를 없애자고 설계를 뒤엎을 이유가 없다.

**그리고 Knit이 두 겹으로 막는다.** 의존성 폴더를 변수에 담아 쓰므로 정적 재작성이
불가능하고, 그 변수 `Util`이 `@prop`으로 문서화된 **공개 API**다. shim 파일의 물리적
존재 자체가 관측 가능한 API 표면이라 없애면 사용자 코드가 깨진다.

가져온 절반:
- [x] 기존 shim 레이아웃이 require-by-string과 **이미 호환**됨을 확인 (`../Promise`)
- [ ] `rarn doctor` — 선언 ↔ 실제 require 불일치 검사 (MVP 밖)
- [ ] `_Meta.luau` — 해석 맵을 읽기 전용 데이터로 노출 (MVP 밖)

**재검토 조건:** Roblox가 `.luaurc` alias 맵을 지원하면. RFC가 "내부 검토 중"이라고 명시.

---

### M3 — 리졸버 ✅

Wally의 리졸버는 **탐욕적 + 백트래킹 없음**이라 큐 순서에 결과가 좌우되고,
`^1.2.0` 과 `^1.5.0` 처럼 명백히 풀리는 조합에서도 실패할 수 있다
(상세: [docs/wally-internals.md](docs/wally-internals.md) 2절).

**"major당 한 버전" 정책은 그대로 유지하되, 알고리즘을 순서 독립적으로 만든다.**
버전을 하나라도 고르기 전에 제약을 전부 모으는 게 핵심이다.

**고정점 반복**으로 푼다. 매 회차마다 제약을 **처음부터 다시 쌓는다.**

```
chosen = {}
반복:
    constraints = rarn.json 의 직접 의존성
    for (이름, 버전들) in chosen:                 # 선택된 버전의 의존성만 펼친다
        for 버전 in 버전들:
            for (별칭, 요구) in 버전.dependencies:
                constraints[요구.이름] += (출처=버전, 범위=요구.범위)

    next = {}
    for 이름 in constraints:                      # 이름별로 독립적으로 푼다
        후보 = 메타데이터(이름).versions
        resolutions 에 있으면 그 버전으로 고정
        next[이름] = solve(후보, constraints[이름])

    if next == chosen: 끝
    chosen = next
```

**왜 매번 다시 쌓나.** 증분으로 제약을 더하면 어떤 버전이 탈락했을 때 *그 버전이 기여했던
제약*을 정확히 걷어내야 하는데, 그 부기가 틀리기 쉽고 틀리면 과도 제약이 되어 조용히
엉뚱한 버전을 고른다. 매 회차 재구축은 그 문제가 원천적으로 없다. 메타데이터는 전부
캐시되므로 재구축 비용은 사실상 0이다.

> **이전 계획을 정정했다.** 원래는 "범위에 맞는 *모든 후보*의 의존성을 큐에 넣고 나중에
> 추린다"였는데, 범위 하나가 20개 버전에 걸리면 20개 전부의 전이 의존성을 캐게 되어
> 조합적으로 터진다. 선택된 버전의 것만 펼치고 반복하는 쪽이 단순하면서 정확하다.

**수렴.** 실전에서는 그래프 깊이 + 1회 안에 멈춘다. 다만 이론적으로는 진동이 가능하다 —
버전이 내려가면 그 의존성이 달라지고, 그래서 다른 곳의 제약이 사라져 또 다른 버전이
올라갈 수 있다. **회차 상한을 두고 초과하면 내부 오류로 실패**시킨다. 조용히 아무 답이나
내놓는 것보다 낫다.

- [x] `resolver/types.ts` — placement 규칙, realm 유효성
- [x] `resolver/select.ts` — 범위 그룹핑, 버전 선택
- [x] `resolver/resolve.ts` — 고정점 루프, placement 완화(relaxation)
- [x] `resolver/conflict.ts` — 충돌 시 **누가 뭘 요구했는지** 출력

```
X @evaera/promise 를 하나의 버전으로 통합할 수 없습니다

    ^3.2.0  <- @nevermore/signal@2.1.0 이 요구
    ^4.0.0  <- rarn.json 이 직접 요구

  두 범위는 겹치지 않아 각각 설치됩니다.
  두 사본은 런타임에 서로 다른 모듈이 되어 싱글톤이 깨질 수 있습니다.
  -> @nevermore/signal 을 올릴 수 있는지 확인하세요.
```

- [x] 순환 의존성은 자연히 종료된다 (고정점이라 별도 감지 불필요)
- [x] pre-release 는 범위가 명시적으로 언급한 경우에만 후보에 들어간다

M3 상태: **178 tests pass / eslint clean / tsc clean / biome clean.**

**완료 기준 달성 — 실서버:**

```
=== knit 하나 ===   5 packages in 1108ms
  @evaera/promise@4.0.0     shared
  @sleitnick/comm@1.0.1     shared  Option->@sleitnick/option@1.0.5 Promise->@evaera/promise@4.0.0 Signal->@sleitnick/signal@2.0.3
  @sleitnick/knit@1.7.0     shared  Comm->@sleitnick/comm@1.0.1 Promise->@evaera/promise@4.0.0
  @sleitnick/option@1.0.5   shared
  @sleitnick/signal@2.0.3   shared

=== 만족 불가 범위 ===
RN0200: No published version of evaera/promise satisfies every requirement.
  ^99.0.0              <- rarn.json (direct dependency)
  published: 4.0.0, 4.0.0-rc.2, 3.2.1, 3.2.0, 3.1.0
```

**구현하며 잡은 것 3가지:**

1. **`assemble` 이 `chosen` 을 순회하고 있었다.** 해석에 실패한 패키지는 `chosen` 에
   애초에 안 들어가므로, 에러를 내는 대신 **조용히 빠진 채 설치가 성공**했다.
   선언한 의존성이 사라지는데 아무 말도 안 하는 것 — 제약(constraints)을 순회하도록 고쳤다.
2. **중복 판정이 `semver.major` 를 쓰고 있었다.** 셀렉터는 `areCompatible` 을 쓰는데
   둘이 `0.x` 에서 갈린다. `0.2.0` 과 `0.3.0` 은 major 가 같지만 호환되지 않는다.
   정상적인 조합을 "Rarn 버그" 로 보고하고 있었다. 같은 정책은 한 함수만 써야 한다.
3. **충돌 메시지가 모든 요구자를 모든 버전 아래에 나열**하고 있었다. 그 버전이 실제로
   만족시키는 요구자만 보여주도록 고쳤다.

**placement 는 완화(relaxation)로 푼다.** 간선은 요청자의 placement 를 물려받는데
요청자의 placement 는 자기를 가리키는 간선들이 정한다 — 순환이다. 가장 좁은 realm 에서
시작해 변화가 없을 때까지 넓히면 3단계 안에서 단조 증가하므로 반드시 멈춘다.

---

### M4 — 캐시와 취득 ✅

- [x] `cache/paths.ts` — Windows `%LOCALAPPDATA%`, 그 외 XDG, `RARN_CACHE_DIR` 오버라이드
- [x] `cache/integrity.ts` — sha256 계산·검증
- [x] `cache/archive.ts` — 매직바이트 판별, zip slip 방어, 역슬래시 정규화
- [x] `cache/store.ts` — `downloads/`(zip) + `extracted/`(트리), 원자적 rename
- [x] `cache/fetch.ts` — 동시성 상한을 둔 병렬 취득
- [x] `util/concurrency.ts` — `mapWithConcurrency` (입력 순서 보존, 첫 실패 전파)

M4 상태: **209 tests pass / eslint clean / tsc clean / biome clean.**

**완료 기준 달성 — 실서버 (knit + roact, 6 패키지):**

| | 다운로드 | 캐시 | contents 요청 | 시간 |
|---|---|---|---|---|
| 콜드 캐시 | 6 | 0 | 6회 | 2153ms |
| **웜 캐시** | **0** | **6** | **0회** | **4ms** |

> **정직한 단서:** 위 4ms 는 같은 프로세스라 메타데이터도 메모리 캐시에 남아 있었다.
> 실제로 `rarn install` 을 두 번 실행하면 **contents 요청은 진짜 0회**지만 메타데이터는
> 다시 받는다. 그걸 없애는 건 락파일 단락(M7)의 몫이다.

**Windows 특이점을 반영했다.** `rename` 이 POSIX 와 달리 **기존 경로를 덮어쓰지 못한다.**
대상이 이미 있다는 건 다른 프로세스가 같은 작업을 먼저 끝냈다는 뜻이므로, 에러가 아니라
"상대 것을 쓰고 내 임시본을 버린다" 로 처리한다.

**캐시 위치는 `%APPDATA%` 가 아니라 `%LOCALAPPDATA%` 다.** 로밍 프로필은 `%APPDATA%` 를
기기 간 동기화하는데, 재생성 가능한 캐시를 네트워크로 복사할 이유가 없다.

**Wally 소스에서 본 역슬래시 문제도 처리했다.** Windows 에서 만든 zip 이 엔트리 이름에
`\` 를 박을 수 있고, 그러면 Unix 에서 디렉터리 트리가 아니라 긴 파일명 하나로 풀린다.
최신 Wally 는 쓸 때 정리하지만 그 수정 이전에 발행된 패키지가 레지스트리에 남아 있다.

**무결성은 매 설치 검증한다.** 캐시된 엔트리도 검증하므로 손상된 캐시가 통과하지 못한다.
Wally 는 `checksum` 필드를 두고도 채우지 않아 실질적으로 검증이 없다 — 버전만 고정하고
바이트를 고정하지 않는 락파일은 정작 중요한 걸 고정하지 않는다.

**구현하며 잡은 것:** 캐시에 트리는 있는데 zip 이 사라진 경우, 처음엔 *빈 바이트의 해시*를
돌려주고 있었다. 실재하지 않는 바이트를 설명하는 값이 락파일에 박힐 뻔했다. 무결성을
확인할 수 없으면 다시 받는 게 맞다.

---

### M5 — 프로젝트 해석과 가지치기 ✅

- [x] `project/rojo.ts` — `default.project.json` 해석, 모듈 루트 판정
- [x] `project/prune.ts` — 모듈 루트만 복사, 절약량 보고

M5 상태: **229 tests pass / eslint clean / tsc clean / biome clean.**

**완료 기준 달성 — 실제 레지스트리 패키지 8개:**

```
패키지                   zip   설치   절약   모듈루트 / 출처
evaera/promise           340     2    99%   lib [directory] / project-file
roblox/roact             126    79    37%   src [directory] / project-file
roblox/rodux              48    19    60%   src [directory] / project-file
jsdotlua/react            20    17    15%   src [directory] / project-file
red-blox/signal            4     1    75%   Signal.luau [file] / project-file
sleitnick/knit             5     5     0%   (zip 루트) / archive-root
sleitnick/comm            12    12     0%   (zip 루트) / archive-root
osyrisrblx/t               6     1    83%   lib [directory] / project-file
합계                      561   136    76%
```

**해석 가능한 형태만 해석한다.** 레지스트리에서 표본으로 뽑은 패키지는 전부
`{ "name": ..., "tree": { "$path": "src" } }` 하나뿐이었다. 중첩 노드나 `$className`
같은 건 트리가 무엇이 되는지를 바꾸는데 그건 Rojo 만 수행할 수 있다. 어설프게 절반만
해석해 미묘하게 틀린 걸 설치하느니 사양하고 통째로 복사한다 — 어차피 Wally 가 모든
패키지에 대해 하는 일이 그것이다.

**`$path` 도 escape 검사를 거친다.** 패키지가 제공한 데이터이므로 아카이브 엔트리와
같은 취급이다. `"../.."` 가 캐시 밖으로 나가지 못한다.

기존 계획 내용:

가장 큰 실용적 이득이 나오는 단계다. `evaera/promise@4.0.0` 은 zip 안에 **340개 파일**이
들어 있지만 실제 모듈은 `lib/init.lua` **1개**다.

- [ ] `project/rojo.ts` — `default.project.json` 파싱
  - `{ "name": ..., "tree": { "$path": "lib" } }` 단순형 지원
  - **`$path` 가 디렉터리가 아니라 파일일 수 있다** (`red-blox/signal` → `"Signal.luau"`)
  - `$className`, 중첩 노드, 다중 `$path` 는 **미지원으로 판정하고 통째 복사 + 경고**
  - **프로젝트 파일 부재는 경고 대상이 아니다** — 아래 참고
- [ ] `project/prune.ts` — 모듈 루트만 복사
- [ ] `.lua` / `.luau` 확장자 양쪽 처리
- [ ] 판정 결과를 락파일 `moduleRoot` 에 기록 (폴더 이름은 패키지 이름에서 유도되므로 기록 불필요)

> **절대 이것 때문에 설치를 실패시키지 않는다.** 해석 못 하면 전부 복사하고 넘어간다.

**실측으로 계획을 정정했다** (표본 13개, [docs/pnp-feasibility.md](docs/pnp-feasibility.md) 7절):

| 패키지 | 프로젝트 파일 | 모듈 루트 | 가지치기 효과 |
|---|---|---|---|
| sleitnick 계열 7개 | **없음** | zip 루트가 곧 모듈 | 해당 없음 |
| evaera/promise | 있음 | `lib` | 340 → 2 (100%) |
| roblox/roact | 있음 | `src` | 126 → 79 (38%) |
| jsdotlua/react | 있음 | `src` | 20 → 17 (15%) |
| red-blox/signal | 있음 | **`Signal.luau` (파일!)** | — |

- **프로젝트 파일 없는 게 표본의 절반이다.** `include` 를 잘 쓴 패키지는 zip 루트가 이미
  깨끗하다. 부재를 경고하면 설치할 때마다 경고가 절반씩 뜬다 → 조용히 zip 루트를 쓴다.
- **`$path` 가 파일을 가리키는 경우가 실제로 있다.** 디렉터리로 가정하면 깨진다.
- 가지치기 이득은 100%~15%로 편차가 크다. promise 가 극적인 건 사실이지만 일반적이지 않다.

**완료 기준:** promise 설치 결과가 340개가 아니라 1개 파일이고, `_Index/evaera_promise@4.0.0/promise/init.lua` 에 놓인다.

---

### M6 — 링커 ✅

- [x] `linker/layout.ts` — realm 디렉터리, **`packageDir` 안전 가드**
- [x] `linker/shim.ts` — shim 3종 (루트 / 형제 / 교차 realm)
- [x] `linker/link.ts` — 삭제 후 재생성, 가지치기 연결, 충돌 검출
- [x] `tests/roblox/emulate.luau` — **Roblox require 의미론 에뮬레이터** (Lune)
- [x] `tests/roblox/verify.luau` — 트리 해석 + dedupe 검증
- [x] `tests/roblox-harness.test.ts` — `bun test` 에 연결, **대조군 3개 포함**
- [x] `test/roblox/` — Studio 수동 검증장 (Rojo)
- [x] `rarn install` / `rarn add` 배선 (M8에서 당겨옴)

M6 상태: **261 tests pass / eslint clean / tsc clean / biome clean.**

**완료 기준 달성 — 실제 설치:**

```
$ rarn add @sleitnick/knit @evaera/promise
added @sleitnick/knit@^1.7.0
added @evaera/promise@^4.0.0
installed 5 packages into RARN_MODULE
  26 files, 7 links, 338 pruned
  5 downloaded, 0 cached  1619ms
```

**Wally 실물과 대조 — 뼈대 완전 일치.** 같은 매니페스트로 `wally install` 을 돌려
비교했다. shim 내용은 헤더 주석을 빼면 **바이트 단위로 동일**하다:

```
Wally: return require(script.Parent._Index["sleitnick_knit@1.7.0"]["knit"])
Rarn : return require(script.Parent._Index["sleitnick_knit@1.7.0"]["knit"])
```

유일한 차이는 가지치기다. **371 파일 → 33 파일.**

**같은 하니스를 양쪽에 돌린 결과가 이 프로젝트의 논지 그 자체다:**

| | 결과 |
|---|---|
| Rarn 산출물 | **15/15 통과** |
| Wally 산출물 (Rojo 없이) | 9/13 — `evaera/promise` 관련 4개 실패 |

Wally 쪽 실패는 Wally 의 버그가 아니다. `promise` 모듈이 `lib/` 안에 한 단계 더
들어가 있고 Rojo 가 sync 시점에 펴 주기를 전제하기 때문이다. 그 전제가 없으면
`require(_Index[...].promise)` 가 Folder 에 닿는다.

### Lune 하니스 — 무엇을 증명하고 무엇을 못 하나

`luau.load(src, { environment })` 로 `script` 와 `require` 를 주입해 **Roblox 의
require 의미론을 재구현**한다. 핵심 두 가지를 그대로 재현한다 — 인스턴스 기반 탐색,
**인스턴스 단위 캐싱**.

**대조군 없이는 하니스를 믿을 수 없으므로 3개를 테스트에 넣었다:**

| 일부러 깨뜨린 것 | 잡히나 |
|---|---|
| dedupe 파괴 (사본 2개) | O — `two copies resolved` |
| 가지치기 실패 (모듈이 한 단계 깊게) | O — `pruning may have left it nested` |
| shim 이 없는 곳을 가리킴 | O |

**패키지 코드는 기본적으로 실행하지 않는다.** 실제 패키지는 모듈 스코프에서
`game:GetService`, `task.defer`, `RunService` 이벤트를 부른다. 실행하면 *스텁이
얼마나 완전한지*를 재는 것이지 트리가 맞는지를 재는 게 아니다. 대신 패키지 모듈은
인스턴스마다 고유한 sentinel 로 해석되는데, 정작 물어야 할 두 질문에는 그걸로 충분하다.

> **한계는 분명하다.** 검증하는 건 "Roblox 에서 되는가"가 아니라 "내 에뮬레이터에서
> 되는가"다. 모델이 틀렸다면 하니스는 통과하고 Studio 는 깨진다. 그래서
> `test/roblox/` 를 **없애지 않고** 남겨 뒀다 — 링커를 건드릴 때마다 Studio 에서 1회.

**작업 중 발견:** 처음엔 shim 판별을 "Rarn 헤더 주석이 있는가"로 했는데, 그러면 Wally
산출물의 링크가 전부 패키지 코드로 오인돼 스텁 처리되고 **실패가 통과로 바뀌었다.**
`return require(...)` 한 줄이라는 구조로도 판별하도록 고쳤다.

**`packageDir` 안전 가드.** 설치는 이 디렉터리를 지우고 다시 만든다. 그런데 스키마의
문자 클래스가 `"."` 를 허용해서, 그대로 두면 shared realm 이 프로젝트 루트로 해석되어
**다음 설치 때 사용자 프로젝트 전체가 지워진다.** 복구할 방법이 없는 실패라 스키마와
런타임 양쪽에서 막는다.

기존 계획 내용:

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

### M7 — 락파일 ✅

- [x] `lockfile/types.ts` — 스키마의 TS 미러
- [x] `lockfile/write.ts` — 키 정렬, 후행 개행. 같은 입력 → 바이트 동일 출력
- [x] `lockfile/read.ts` — 스키마 검증 + **Resolution 재구성**
- [x] `lockfile/freshness.ts` — `root` 스냅샷 vs 현재 매니페스트
- [x] `--frozen-lockfile` (CI용)

M7 상태: **292 tests pass / eslint clean / tsc clean / biome clean.**

**완료 기준 달성 — 실제 설치 (knit + promise, 5 패키지):**

| 회차 | 해석 | 시간 |
|---|---|---|
| 1회차 (락파일 없음) | `resolved` | 670ms |
| **2회차 (락파일 재사용)** | **`lockfile`** | **45ms** |

`rarn install` 두 번 실행 후 `rarn.lock` 은 **바이트 동일**하다.

**M4 에서 달아둔 빚을 갚았다.** 그때 정직하게 적어둔 단서가 있었다 —
"두 번 실행하면 contents 요청은 0회지만 **메타데이터는 다시 받는다.**" 이제 락파일이
신선하면 **해석 단계를 통째로 건너뛴다.** 네트워크를 쓰는 단계는 해석뿐이므로
(취득은 캐시, 링크는 로컬) 재설치가 완전히 오프라인이 된다.

**신선도 판정은 의도적으로 비대칭이다.** 너무 엄격하면 라운드트립 몇 초를 낭비할 뿐이지만,
너무 느슨하면 **매니페스트가 더는 요구하지 않는 버전을 설치하고 성공했다고 보고한다.**
그래서 모든 비교가 "낡음" 쪽으로 기울어 있다.

비교 대상은 **해석에 영향을 주는 것만**이다. `packageDir`, `place`, `aliases` 는 파일이
어디 놓이는지를 바꿀 뿐이고 링크는 매 설치 실행되므로, 이것들로 무효화하면 디렉터리
이름 하나 바꿨다고 전체 재해석을 하게 된다.

**범위는 정규형으로 비교한다.** `^1.0.0` 을 `1.x` 로 고쳐 써도 요구사항은 그대로이므로
낡았다고 보지 않는다. 반면 `^1.0.0`(= `>=1.0.0 <2.0.0-0`)과 `>=1.0.0 <2.0.0` 은
프리릴리스 취급이 달라 **진짜로 다른 요구사항**이고, 정규형이 그 차이를 정확히 잡는다.

**작업 중 잡은 것 — 이름이 같은 두 개의 다른 값:**

락파일 최상위 `registry` 는 아카이브를 받아온 **API URL**(`api.wally.run/`)이고,
매니페스트의 `registry` 는 **인덱스 저장소 URL**(`github.com/UpliftGames/wally-index`)이다.
신선도 검사가 이 둘을 비교하고 있어서 **모든 락파일이 영원히 낡은 것으로 판정**됐다.
테스트 5개가 동시에 실패해서 드러났다. 인덱스 URL 을 `root.registry` 로 따로 기록하고
그걸 비교하도록 고쳤다.

**`moduleRoot` 는 정보용이다.** 설치할 때는 캐시된 아카이브에서 다시 유도한다. 작은 파일
하나 더 읽는 비용이, 낡은 락파일이 설치 내용을 조용히 바꾸는 부류의 버그보다 싸다.

**`--production` 은 락파일을 쓰지 않는다.** devDependencies 를 뺀 그래프는 매니페스트를
더 이상 설명하지 않으므로, 그걸로 덮어쓰면 다음 사람이 잘못된 락파일을 받는다.

---

### M8 — CLI 명령 ✅

**이미 동작하는 것:** `init` `add` `install` — M1·M6 에서 배선했다.

M8 은 **10개**를 추가한다. 발행 계열은 이번에 넣지 않는다 (아래 M10).

전 명령 공통: `--verbose`, `--silent`, `--no-color`, `--cwd`.
종료 코드는 `0` 성공 / `1` 사용자 오류 / `2` 네트워크·레지스트리 오류.

#### A. 편집·조회 (5개) — 밑단이 전부 있음

| 명령 | 옵션 | 하는 일 | 크기 |
|---|---|---|---|
| `remove <pkg...>` | | 매니페스트에서 제거 후 재설치 | S |
| `up [pkg...]` | `--latest` | 범위 내 최신으로 올리고 **매니페스트 범위도 갱신** | S |
| `list` (`ls`) | `--depth` `--json` | 락파일로 트리 출력. 네트워크 0 | S |
| `why <pkg>` | `--json` | 루트까지 역추적 | S |
| `dedupe` | `--json` | 중복 버전 진단 | S |

- `remove` 는 **어느 섹션에 있든 찾아서** 지운다. `withoutDependency` 가 M1 에 이미 있고
  아직 안 쓰인다. 없는 패키지를 지우라고 하면 조용히 성공하지 말고 그렇게 말한다.
- `up` 은 `install` 과 다르다. `install` 은 매니페스트를 안 건드리지만 `up` 은
  **범위를 새 버전에 맞춰 다시 쓴다** (Yarn 과 동일). `--latest` 는 선언된 범위를 무시한다.
- `why` 는 락파일의 `requestedBy` 가 곧 역방향 간선이라 **네트워크 없이** 된다.
  직접 요구자만이 아니라 **루트까지의 경로 전체**를 보여준다.

> **`dedupe` 는 Yarn 과 역할이 다르다.** Yarn 의 `dedupe` 는 재해석해서 버전 수를 줄인다.
> Rarn 의 리졸버는 **이미 제약을 다 모은 뒤 교집합으로 푸는** 순서 독립 알고리즘이라
> 결과가 항상 최소다 — 더 줄일 여지가 없다. 그래서 Rarn 의 `dedupe` 는 축약이 아니라
> **"왜 못 합쳤는지 설명하고 `resolutions` 를 제안"** 하는 진단 명령이다.

#### B. 탐색 (3개)

| 명령 | 하는 일 | 크기 |
|---|---|---|
| `search <query>` | 레지스트리 검색 | **XS** |
| `info <pkg>[@ver]` | 버전 목록·설명·라이선스·realm·의존성 | S |
| `outdated` | 설치본 vs 범위 내 최신 vs 전체 최신 | S |

> `search` 는 **M2 에서 이미 구현했고 버그까지 고쳤는데** (scope/name 분리 필드)
> 아무 데서도 안 부른다. 배선만 하면 끝난다.

`outdated` 는 Yarn Classic 형식으로 `current / wanted / latest` 3열. CI 용으로
낡은 게 있으면 종료 코드를 1로 할지는 구현 시 결정한다 — 기본은 0, `--check` 로 옵트인이
안전해 보인다.

#### D. 유지보수 (2개)

| 명령 | 하는 일 | 크기 |
|---|---|---|
| `cache dir\|clean\|verify` | 캐시 경로 출력 / 비우기 / 무결성 재검사 | S |
| `doctor` | 선언 ↔ 실제 require 불일치 검사 | M |

- `cache verify` 는 `downloads/` 를 다시 해싱해 `extracted/` 와 대조한다.
  M4 의 무결성 코드를 그대로 쓴다.
- `cache clean` 은 **되돌릴 수 없으므로** 지울 용량과 항목 수를 먼저 보여준다.
- `doctor` 는 [R1 연구](docs/pnp-feasibility.md) 5-2 에서 나온 항목이다. 패키지 소스가
  `script.Parent.Parent.X` 를 부르는데 `X` 가 선언된 의존성에 없으면 경고, 반대로 선언만
  하고 안 쓰면 경고. **표본의 4.5% 는 동적 require 라 검사 불가인데, 그 사실을 그대로 보고한다.**
  Wally 에 없는 영역이다.

---

#### 실측 결과

10개 전부 구현·배선했다. 아래는 `@sleitnick/knit` + `@evaera/promise` 를 설치한
스크래치 프로젝트에서 실제로 받은 출력이다.

| 명령 | 확인한 것 |
|---|---|
| `remove` | 매니페스트에서 지우고 재설치. 없는 패키지는 `RN0002` 로 거부하고 **아무것도 안 지운다** |
| `up` | `^1.4.0` → `^1.7.0` 으로 **범위까지 다시 씀**. `--latest` 는 범위를 넘어 `^3.2.1` → `^4.0.0` |
| `list` | 트리 + 중복 경고. 재방문 노드는 `·` 로 접는다 |
| `why` | 루트까지의 경로 전체. 사슬이라 항상 `└─` |
| `dedupe` | 버전별 요구자와 범위, `resolutions` 제안 |
| `search` | `--limit` 동작. M2 의 scope/name 분리 필드 그대로 |
| `info` | 버전 목록·realm·라이선스·의존성 |
| `outdated` | `current / wanted / latest` 3열. 범위 밖 최신만 노랑 |
| `cache` | `dir` / `clean` / `verify` — verify 는 락파일과 대조 |
| `doctor` | 아래 |

`up` 이 실제 중복을 만들어 `dedupe` 를 검증할 재료가 되어 줬다:

```
@evaera/promise is installed at 2 versions:
  4.0.0
    >=4.0.0 <5.0.0       <- @sleitnick/comm@1.0.1
    >=4.0.0 <5.0.0       <- @sleitnick/knit@1.7.0
  3.2.1
    ^3.2.1               <- rarn.json (direct dependency)

  Force one version with:  "resolutions": { "@evaera/promise": "4.0.0" }
```

**`doctor` 는 대조군으로 검증했다.** 통과만으로는 검사기가 아무것도 안 하고 있는
경우와 구별이 안 되기 때문이다.

| 주입한 결함 | 결과 |
|---|---|
| 선언 안 한 `NotDeclared` 를 require | `requires NotDeclared — not a declared dependency` + 파일·줄 번호, 종료 1 |
| Knit 소스에서 `Comm` require 제거 | `declares Comm — never required`, 종료 0 |

두 번째가 중요하다. Knit 은 `KnitClient.Util = (script.Parent :: Instance).Parent`
로 한 번 변수를 경유해서 require 한다. **그 require 를 지웠을 때만 `unused` 로 바뀌었다는 건
스캐너가 변수 경유를 실제로 따라가고 있다는 뜻이다** — 안 따라갔다면 애초에 `Comm` 을
쓰는 걸 못 봤을 테니 지우기 전에도 `unused` 라고 했을 것이다.

`missing` 은 런타임에 `nil` 이 되는 진짜 결함이라 종료 1, `unused` 는 매니페스트가
넉넉한 것뿐이라 종료 0 으로 나눴다.

스캐너가 못 보는 것도 그대로 보고한다: `7 requires are built at runtime and could not be checked`.

문자열 처리에 걸린 게 하나 있다. 주석 속 예제 코드를 진짜 require 로 읽지 않으려면
문자열을 지워야 하는데, 그러면 `folder["Promise"]` 의 이름까지 날아간다. 이름 하나짜리
리터럴만 남기고 나머지를 지우는 것으로 갈랐다 — `require(...)` 를 숨길 만큼 긴 문자열이
문제였던 거지 짧은 이름은 아니었다.

전체 검사 초록: 315 tests pass, 0 fail (12 files, 1467ms).

---

### M10 — 발행 ✅

원래 M8 에서 빼기로 했다가, 시간 사정으로 여기서 같이 끝냈다. 바이너리 배포는 여전히 나중이다.

조사해 둔 API 사실은 아래 그대로다.

| 항목 | 확인된 사실 |
|---|---|
| 엔드포인트 | `POST {api}/v1/publish` |
| 헤더 | `Wally-Version`, `Authorization: Bearer <token>`, `accept: application/json` |
| 본문 | **raw zip 바이트** (multipart 아님) |
| 크기 제한 | **2 MiB** |
| 로그인 | **GitHub device flow** — `github.com/login/device/code` → 폴링 → `login/oauth/access_token` |
| client_id | 인덱스 `config.json` 의 `github_oauth_id` (기본 인덱스: `7bd503594a0f9a9f7ed3`) |
| 토큰 저장 | API URL 별. Wally 는 `~/.wally/auth.toml` |
| 에러 | `400` 이름·버전·zip 문제 / `401` 스코프 권한 없음 / `409` **버전 이미 존재** / `500` 저장 실패 |

**핵심 제약 — 서버가 zip 안의 `wally.toml` 을 읽는다.** 백엔드 publish 핸들러가 업로드된
아카이브에서 `wally.toml` 을 꺼내 파싱해 패키지 이름과 버전을 얻는다. 따라서
`rarn publish` 는 **`rarn.json` 에서 `wally.toml` 을 생성해 zip 에 넣어야** 한다.

**여기서 파생되는 제약:** 생성된 `wally.toml` 의 범위는 **Cargo 문법이어야** 한다.
`^1.0.0`, `~1.2.3`, `>=1.0.0, <2.0.0` 은 되지만 **`||`(OR)와 하이픈 범위는 Cargo 에 없다.**
그런 범위를 쓴 프로젝트는 발행 시 거부하거나 경고해야 한다.

**첫 발행 시 스코프가 자동으로 등록된다.** 오타난 스코프로 발행하면 그 스코프를 점유한다.

구현한 명령: `login` `logout` `whoami` `pack` `publish`.

#### 실측 결과

| 확인 | 결과 |
|---|---|
| `wally.toml` 생성 | `rarn.json` 에서 만들어 zip 에 넣는다. 프로젝트에 있던 `wally.toml` 은 덮어쓴다 |
| Cargo 범위 변환 | `>=1.0.0 <2.0.0` → `>=1.0.0, <2.0.0`. `||` 와 하이픈 범위는 거부 |
| `pack --list` | 파일 목록과 크기, 2 MiB 대비 비율 |
| `publish --dry-run` | 생성될 `wally.toml` 을 그대로 보여주고 업로드는 안 한다 |
| `private: true` | `RN0624` 로 차단. 다른 어떤 실패보다 먼저 검사한다 |
| 로그인 안 한 상태 | `RN0600`, 종료 1 |
| `logout` 두 번 | 실패가 아니라 "not logged in". 상태를 요구하는 명령이고 그 상태는 이미 성립한다 |

**`.env` 가 아카이브에 들어가는 걸 실측에서 잡았다.** `pack --list` 를 처음 돌렸을 때
`.env` 가 그대로 목록에 있었다. 발행은 되돌릴 수 없고 레지스트리에 unpublish 가 없으므로,
올라간 자격증명은 회수가 아니라 교체밖에 답이 없다. 기본 제외에 `.env`, `.env.*`,
`*.key`, `*.pem` 을 넣었다.

틀릴 수 있는 두 방향이 대칭이 아니다 — 한 파일을 덜 보내면 설치가 깨지고 몇 분 만에 고쳐지지만,
한 파일을 더 보내면 아예 되돌릴 수가 없다.

**`include` 가 기본 제외를 이기게 하되, 정확한 경로일 때만.** 처음엔 주석에
"`include` 에 적으면 된다" 고 써 놓고 구현은 `exclude` 가 무조건 이기게 돼 있었다.
테스트 이름은 그걸 검증한다고 했지만 실제로는 아무것도 검증하지 않았다.
`.env` 라고 정확히 쓰는 건 의도일 수밖에 없지만 `src/**` 는 디렉터리에 대한 말이지
거기 있는 줄도 몰랐던 `src/.env` 에 대한 말이 아니다. 그래서 글롭은 못 이긴다.

**업로드는 재시도하지 않는다.** 나머지 호출은 멱등한 읽기라 재시도하지만, 이건 쓰기이고
타임아웃 뒤의 결과를 정말로 알 수 없다. 첫 시도가 성공했는데 재시도하면 두 번째 발행이 되고,
레지스트리는 `409` 로 막아 주긴 하지만 성공한 일을 실패로 보고하게 된다.

`mtime` 은 ZIP 에포크(1980-01-01)로 고정한다. 같은 입력이 같은 바이트를 내야
`pack` 두 번이 "비슷한 두 개" 가 아니라 "하나" 임을 확인할 수 있다. `0` 은 중립값이
아니라 인코딩 불가능한 값이다 — ZIP 은 DOS 날짜를 저장해서 1980 이전을 표현하지 못한다.

**아직 라이브로 발행해 보지는 않았다.** 레지스트리 버전은 불변이라 시험 발행이
영구히 남고 스코프까지 점유한다. `--dry-run` 까지만 확인했다.
> **발행은 되돌릴 수 없다.** 레지스트리는 버전을 불변으로 보고 `409` 로 재발행을 막는다.
> `pack --list` 와 `publish --dry-run` 은 선택이 아니라 필수다.

아직 안 한 것: `.gitignore` 폴백 (지금은 기본 제외 목록만), 라이브 발행 검증.

---

### M9 — 마감 ✅

- [x] `ora` 진행 표시 (TTY 아닐 때는 자동 비활성)
- [x] 에러 메시지 통일: **무엇이 / 어디서 / 어떻게 고치는지**
- [x] 설치 요약 — 캐시 적중과 락파일 재사용까지
- [x] `README.md` 사용법 확장

**진행 표시는 stderr 로 나간다.** 여러 명령이 stdout 에 JSON 을 뱉는데,
스피너가 그 스트림 한가운데서 자기 줄을 다시 그리면 어떤 파서도 못 읽는 출력이 된다.
진행 상황은 진단이므로 진단 채널에 속한다.

TTY 가 아니면 아예 사라진다. 줄을 다시 그리는 이스케이프 코드는 CI 로그에서
수백 줄의 쓰레기가 된다. 파이프·리다이렉트 상태에서는 `--verbose` 일 때만 단계별로
한 줄씩 찍고, 나머지는 설치 요약이 대신한다.

에러 쪽에서 새로 잡은 것:

| 항목 | 내용 |
|---|---|
| 오프라인 | `ENOTFOUND` 류를 가로채 `RN0100` 으로. Node 원문(`getaddrinfo ENOTFOUND`)은 내부 결함처럼 읽힌다 |
| 종료 코드 | `exitCodeFor` 로 분리 — 사용자 오류 `1`, 레지스트리·네트워크 `2` |
| `--verbose` | `RarnError.cause` 와 스택을 보여준다. 평소엔 절대 안 보인다 |
| 코드 없는 에러 | "Rarn 의 버그" 라고 그대로 말한다. 사용자 잘못처럼 포장하면 없는 실수를 찾게 만든다 |

**색 처리에서 한 번 오진했다.** 파이프에 색이 나오고 `NO_COLOR` 가 안 먹길래
`bun build --compile` 바이너리에서 chalk 의 TTY 감지가 깨진 줄 알았는데,
실제 원인은 내 셸에 걸려 있던 `FORCE_COLOR=3` 이었다. chalk 는 멀쩡했다.

그래서 실제로 바꾼 건 우선순위 하나뿐이다. chalk 는 `FORCE_COLOR` 가 `NO_COLOR` 를
이기게 하는데, 여기서는 `NO_COLOR` 가 이긴다 — 터미널은 자기가 띄우는 모든 것에
`FORCE_COLOR` 를 한 번 걸어두지만 `NO_COLOR` 는 *이번 실행*에 대고 거는 것이라,
더 구체적인 요청이 이겨야 한다.

`isTTY` 는 Node 타입이 `boolean` 이라고 하지만 파이프에서는 `undefined` 다.
선언을 곧이곧대로 믿으면 타입 검사기 눈에 undefined 분기가 도달 불가로 보이고,
그게 멀쩡한 가드가 "불필요하다" 며 지워지는 경로다. 실제 타입을 `isInteractive`
한 곳에 적어 두고 거기서만 읽는다.

---

### M11 — CI와 빌드 검증 ✅

**목표:** `develop`/`master` 로 가는 PR 이 사람 손 없이 검증되고, 3개 OS 바이너리가 매번
실제로 실행되는지까지 확인된다.

`.husky/pre-commit` 은 로컬 전용이다. 훅이 죽으면 `--no-verify` 가 정답처럼 보이기 시작하고,
그 순간부터 아무것도 검증되지 않는다. CI 는 그 마지막 그물이다.

| 잡 | 축 | 내용 |
|---|---|---|
| `check` | `os: [ubuntu, windows]` | `bun run check` (format → lint → typecheck → test) |
| `build` | `target: [windows-x64, darwin-arm64, linux-x64]` | ubuntu 한 대에서 전부 크로스컴파일, 아티팩트 업로드 |
| `smoke` | `os` ↔ `target` 매핑 | 각 바이너리를 **자기 OS 에서** 실행. `--version`, `--help`, `pack --list` |
| `release` | — | 태그 기반. **스켈레톤만 두고 비활성** (1.0.0 에서) |

매트릭스 축이 두 개인 것이 아니라 **잡마다 축이 다르다.** 합치면 안 된다:

- `build` 의 축은 *타깃* 이고 러너는 하나다. 한 호스트에서 3개가 다 나오는지가 검증 대상이기
  때문이다 (CLAUDE.md 가 주장하는 사실이므로 CI 가 매번 재확인해야 한다).
- `smoke` 의 축은 *러너 OS* 다. 빌드 성공은 동작 보장이 아니다 — ubuntu 가 만든 darwin
  바이너리는 ubuntu 에서 실행조차 안 되므로, 만든 곳에서 확인하면 아무것도 확인한 게 아니다.
- `fail-fast: false`. 윈도우만 깨졌는데 리눅스 결과까지 취소되면, 깨진 게 플랫폼 문제인지
  공통 문제인지 판단할 근거가 사라진다.

**윈도우 러너는 뺄 수 없다.** 테스트가 임시 디렉터리와 경로 구분자를 만지고, `renameIntoPlace`
는 "윈도우는 기존 경로 위로 rename 하지 못한다" 는 사실 위에 서 있다. 리눅스에서만 도는 CI 는
그 분기를 한 번도 밟지 않는다.

**CI 에서 네트워크를 금지한다.** 지금 "레지스트리 테스트는 픽스처로" 는 관례일 뿐이라, 누군가
테스트에 실제 요청을 하나 넣으면 조용히 통과하고 그때부터 CI 는 api.wally.run 의 가용성을
같이 테스트하게 된다. `RARN_NO_NETWORK=1` 을 레지스트리 클라이언트가 읽어 즉시 `RN01xx` 로
던지게 하고 CI 환경에 걸어 두면, 관례가 규칙이 된다. 같은 스위치를 M12 의 `--offline` 이
그대로 쓴다.

**판정:** lint 를 일부러 깨뜨린 PR 이 머지 불가가 되는가. 스모크 3개가 전부 초록인가.

#### 실측 결과

8개 잡 전부 초록. 다섯 판 돌렸고, 초록이 되기까지 CI 가 잡아낸 것이 셋이다.

| # | 잡은 것 | 어떻게 드러났나 |
|---|---|---|
| 1 | 하니스가 약속한 스킵을 안 하고 있었다 | 첫 판, 양쪽 OS 에서 lune 이 없어 ENOENT. 주석에는 "Skipped when Lune is absent" 라고 적혀 있었지만 코드에는 없었다 |
| 2 | **ubuntu 에서 만든 윈도우 바이너리가 시작하자마자 세그폴트** | `build` 는 초록, `smoke (windows)` 만 빨강. 빌드 로그에는 아무 것도 없다 |
| 3 | cache 테스트의 ZIP 이 비결정적 | 윈도우 러너에서 한 번 터졌다. 앞 판에서는 통과했다 |

2번을 대조군으로 갈랐다. 같은 호스트, 같은 타깃, `--bytecode` 만 뺀 빌드는 스모크
여섯 개를 전부 통과한다. 깨지는 조합은 **"윈도우 타깃 + 크로스컴파일 + bytecode"**
하나다 — 같은 호스트의 darwin-arm64 는 macOS 에서 정상이고, 윈도우에서 네이티브로
만든 것도 정상이다.

bytecode 는 시작을 178ms → 152ms 로 줄인다(윈도우, `--version` 10회 평균). 15% 를
포기하는 대신 윈도우만 네이티브로 짓기로 했다. 하필 윈도우가 Roblox 개발자가 가장 많이
쓰는 플랫폼이라, 거기를 느리게 만드는 선택은 가장 나쁜 쪽으로 틀리는 것이다.
CLAUDE.md 의 "어느 호스트에서든 크로스컴파일된다" 는 주장은 이 예외를 달아 고쳤다.

3번은 `makeZip` 이 `zipSync` 에 `mtime` 을 안 넘겨 현재 시각이 찍힌 것이었다.
`pack.ts` 는 같은 이유로 이미 고정하고 있었는데 테스트 헬퍼만 안 하고 있었다.
두 호출이 DOS 타임스탬프 눈금을 사이에 두고 떨어질 때만 어긋나므로, 로컬에서는
거의 안 터지고 러너에서만 가끔 터진다. **CI 없이는 못 잡는 종류다.**

| 항목 | 결과 |
|---|---|
| `check` (ubuntu / windows) | 초록. 하니스 포함 363 tests |
| `build` ×3 | 초록. windows 는 네이티브, 나머지는 ubuntu 에서 크로스컴파일 |
| `smoke` ×3 | 초록. 6개 검사 (`--version`, `--help` 18명령, `init`, `pack --list`, RN0510, RN0130) |
| 전체 소요 | 약 2분 |

브랜치 보호는 걸지 않았다. 리포가 private 이라 필수 상태 검사는 유료 플랜에서만 된다.
그래서 "빨간 PR 은 머지 불가" 는 아직 규칙이 아니라 관례다.

아직 안 한 것: 릴리스 잡(M16), `build` 잡의 의존성 캐시.

---

### M12 — 설치 트리 원자성과 오프라인 ✅

**목표:** 설치가 중간에 죽어도 결과는 *이전 트리 그대로* 이거나 *완전히 새 트리* 이거나, 둘 중
하나다.

지금 `link()` 는 realm 디렉터리를 먼저 `rm` 하고 제자리에서 다시 짓는다. Ctrl-C 한 번이면
멀쩡하던 트리는 이미 사라졌고 반쪽만 남는다. `cache/store.ts` 가 정확히 이 문제를 temp+rename
으로 이미 풀어 두었는데 링커만 그 기준에 미달이다 — 안 만든 기능이 아니라 **자기 기준을 한
군데서 안 지킨 것** 이라 성격이 다르다.

| 단계 | 내용 |
|---|---|
| 1 | 모든 realm 을 `<projectDir>/.rarn-tmp/<realm>` 에 **전부** 짓는다 |
| 2 | 다 완성된 뒤에야 스왑. realm 별로 `기존 → .rarn-old-N`, `신규 → 제자리`, `.rarn-old-N` 삭제 |
| 3 | 시작 시 남아 있는 `.rarn-tmp` / `.rarn-old-*` 는 이전 실행의 잔해로 보고 청소 |

temp 를 OS 임시 디렉터리가 아니라 **프로젝트 안** 에 두는 이유는 캐시와 같다. 크로스디바이스
rename 은 원자적이지 않고, 조용히 복사로 전락한다.

realm 3개에 걸친 스왑은 원자적이지 않다. 그 창을 *디렉터리 rename 두 번* 까지 줄이는 것이
현실적 최선이고, **그 한계를 주석에 적는다.** 원자적인 척하는 편이 안 하는 것보다 나쁘다.

같이 넣는 스위치:

| 플래그 | 동작 |
|---|---|
| `--offline` | 네트워크가 필요해지면 실패. 락파일 재사용으로 되면 그대로 진행 |
| `--prefer-offline` | 캐시에 있으면 캐시, 없으면 받는다 |
| `RARN_NO_NETWORK` | 같은 차단을 환경변수로. M11 의 CI 가 이것을 쓴다 |

신선한 락파일이면 지금도 결과적으로 오프라인이지만 **그건 우연이지 보장이 아니다.** 비행기에서
`rarn install` 이 45ms 에 끝날지 타임아웃 30초를 먹을지 실행해 봐야 아는 상태다.

**판정:** 링크 도중 강제 종료 → 이전 트리로 Studio 가 그대로 뜨는가. `--offline` 로 캐시에 없는
패키지를 요청 → 네트워크를 타지 않고 즉시 실패하는가.

#### 실측 결과

`src/linker/swap.ts` 가 새로 생겼고 `link()` 는 `.rarn-tmp` 에 지은 뒤 realm 별로
`기존 → .rarn-old-<token>`, `신규 → 제자리` 로 바꿔 넣는다. 366 → **373 tests**
(원자성 5개 + 오프라인 2개 추가).

| 확인 | 결과 |
|---|---|
| 성공 후 잔여물 | `.rarn-tmp`, `.rarn-old-*` 둘 다 없음 |
| 링크 중 실패 | 이전 트리 파일 내용까지 그대로. 스테이징도 정리됨 |
| 더 이상 안 쓰는 realm | 제거됨 (server 의존성을 빼면 `RARN_MODULE_SERVER` 가 사라진다) |
| 중단된 실행의 잔해 | 다음 실행 시작 시 청소됨 |
| `--offline` + 신선한 락파일 | 69ms, 네트워크 0회 |
| `--offline` + 어긋난 락파일 | RN0130, 종료 코드 1, **기존 트리는 살아 있음** |

**테스트 하나가 바로 값을 했다.** 실패 경로에서 `.rarn-tmp` 가 남는 것을 잡았다.
다음 실행이 어차피 치우지만 "다음 실행" 은 며칠 뒤일 수 있고, 그 사이에 반쯤 지어진
트리가 커밋된다. `link()` 를 `try/finally` 로 감싸 실패해도 치우게 했다.

**`--prefer-offline` 은 넣지 않았다.** Yarn 의 그것은 캐시된 *메타데이터* 를 선호한다는
뜻인데 Rarn 은 아카이브만 캐시하고 메타데이터는 캐시하지 않는다. 지금 넣으면 이미
일어나는 일을 설명할 뿐 아무것도 바꾸지 않는 플래그가 된다 — 아무것도 안 하면서 뭔가
하는 척하는 플래그는 없는 것만 못하다. 메타데이터를 캐시하는 날 돌아온다.

**라이브로 못 한 것:** 링크 도중 실제 Ctrl-C. 캐시가 따뜻하면 링크 구간이 수십 ms 라
손으로 그 창을 맞출 수 없다. 유닛 테스트가 같은 실패 지점을 결정적으로 재현하므로
그쪽을 근거로 삼았다.

새 코드: `RN0420` (스왑 실패 후 롤백도 실패). 윈도우에서 Studio 나 rojo serve 가 파일을
잡고 있으면 rename 이 거부되고, 되돌리는 rename 도 같은 이유로 실패할 수 있다. 그때
사용자가 트리 둘 다 없이 남겨지지 않도록 이전 트리가 어디 있는지 말한다.

`init` 이 `.gitignore` 에 `.rarn-tmp/` 와 `.rarn-old-*/` 도 넣는다.

---

### M13 — `rarn import` — Wally 에서 이주 ✅

**목표:** 기존 Roblox 프로젝트에서 `rarn import && rarn install` 두 줄로 끝난다.

기존 프로젝트는 **전부** `wally.toml` 을 갖고 있다. 이주 경로가 없으면 "좋은데 옮기기 귀찮네"
에서 끝나므로, 채택 관점에서는 이것이 M11~M15 중 가장 값이 크다.

`renderWallyToml` 의 역방향이고, **역방향에만 있는 함정이 하나 있다.**

> **Cargo 에서 맨 버전은 정확한 버전이 아니라 캐럿이다.** `Promise = "evaera/promise@4.0.0"`
> 은 `4.0.0` 이 아니라 `^4.0.0` 을 뜻한다. exact 로 옮기면 모든 의존성이 조용히 못 박히고,
> 아무 에러 없이 영원히 업데이트되지 않는 프로젝트가 된다. `toCargoRange` 가 이 문제의 절반
> 이었다면 이쪽이 나머지 절반이며, **이쪽이 훨씬 조용히 틀린다** — 설치는 성공하고 트리도
> 멀쩡하다.

| wally.toml | rarn.json | 주의 |
|---|---|---|
| `[package] name` | `name` | `@scope/name` 로 `@` 부착 |
| `version`, `realm`, `registry` | 동일 | `registry` 는 인덱스 저장소 URL |
| `[dependencies]` | `dependencies` | 범위 역번역 |
| `[server-dependencies]` | `serverDependencies` | |
| `[dev-dependencies]` | `devDependencies` | |
| `[place]` 항목 | `place` | 교차 realm shim 이 여기에 의존한다 |
| 키 이름(별칭) | `aliases` | **파생 별칭과 다를 때만** 기록 |

범위 역번역: `,` → 공백(AND), 맨 버전 → 캐럿, `=1.0.0` → `1.0.0`, `*` → `*`. 애매한 것은
추측하지 말고 그대로 둔 뒤 경고한다 — 발행 쪽에서 `||` 를 넓히지 않고 거부한 것과 같은 원칙이다.

**`wally.lock` 은 가져오지 않는다.** Wally 락파일은 `checksum` 이 비어 있어서, 옮겨 봐야
검증 불가능한 다이제스트를 가진 락파일이 된다. 다시 해석하는 편이 옳고, 그 과정에서 제약 5의
순서 무관 해석이 Wally 와 다른 (더 나은) 결과를 내놓는 것을 바로 보여 주게 된다.

부가: `--dry-run`, 기존 `rarn.json` 이 있으면 `--force` 없이 거부, 변환 요약표 출력.

,
근거는 "`require(Packages.Alias)` 가 파싱돼야 한다". 근거는 멀쩡한데 규칙이 틀렸다 —
`jsdotlua` 계열 전체가 `luau-polyfill`, `es7-types`, `instance-of`, `symbol-luau` 로
발행하고, **그 패키지들의 소스가 그 이름으로 require 한다.** 다른 이름을 쓸 수가 없다.

더 나쁜 쪽은 락파일 스키마였다. 거기 `dependencies` 의 키는 레지스트리 메타데이터에서
오는 것이라 Rarn 이 고르는 값이 아니다. 그래서:

```
$ rarn install     # @jsdotlua/luau-polyfill -> 성공, 락파일 씀
$ rarn install     # 같은 락파일 -> RN0500, "지우고 다시 설치하세요"
```

지우고 다시 설치하면 **같은 락파일이 다시 생긴다.** react-lua 생태계 전체가 두 번째
설치부터 막혀 있었고, 조언은 무한 루프였다.

**검증 실패가 아무 필드도 나열하지 않았다.** `formatSchemaErrors` 가
`pattern && data === undefined` 를 걸러내는데, 이 경우 ajv 가 정확히 그 모양으로
보고한다. 그래서 "does not match the schema" 다음에 빈 줄, 그 아래 "위에 나열된 필드를
고치세요". 필터를 `propertyNames` 가 같은 경로에 있을 때로 좁히고, **필터가 전부
걸러내면 거르지 않은 목록을 내놓는** 안전망을 뒀다. 시끄러운 목록이 빈 목록보다 낫다.

#### 결정 몇 가지

- **`packageDir` 는 `Packages`.** `wally install` 을 실제로 돌려 디렉터리 이름을
  확인했다: `Packages`, `ServerPackages`, `DevPackages`. Rarn 은 접미사로 파생하므로
  `Packages_SERVER`/`Packages_DEV` 가 되고 공유 realm 만 맞는다. 이주하는 프로젝트의
  Rojo 파일은 이미 `Packages` 를 가리키므로 그쪽에 맞추고, server/dev 의존성이 있으면
  경고한다.
- **`wally.lock` 은 가져오지 않는다.** 실제 파일을 열어 보니 이름·버전·의존성뿐이고
  체크섬 필드가 아예 없다(`registry = "test"` 로 적히기까지 한다). 옮겨 봐야 검증
  불가능한 락파일이 된다.
- **`wally.toml` 은 지우지 않는다.** 프로젝트의 다른 도구가 아직 읽는 파일이고,
  방금 가져온 것을 지우는 건 importer 가 할 결정이 아니다.
- 별칭은 **파생값과 다를 때만** `aliases` 에 적는다. 항등 매핑으로 가득 찬 맵은 소음이다.

---

### M14 — Rojo·place 연동

**목표:** `place` 를 손으로 적지 않아도 되고, 어긋나면 설치 시점에 잡힌다.

같은 사실이 지금 두 군데에 적혀 있다 — `rarn.json` 의 `place` 와 `default.project.json` 의
트리. 어긋나면 교차 realm shim 이 **존재하지 않는 DataModel 경로** 를 가리키는데, 이건 파일
트리 스냅샷으로도 Lune 하니스로도 잡히지 않는다. Studio 에서 처음 터진다.

| 항목 | 내용 |
|---|---|
| 파생 | `default.project.json` 에서 `$path` 가 realm 디렉터리인 노드를 찾아 그 DataModel 경로를 `place` 로 사용 |
| 우선순위 | 매니페스트의 명시 `place` 가 이긴다. 파생은 **없을 때만** |
| 검증 | 둘 다 있고 다르면 경고 + 어느 쪽을 썼는지 명시 (`RN04xx`) |
| `init` | 프로젝트 파일이 있으면 세 realm 항목을 넣어 줄지 묻고, 거절하면 붙여넣을 스니펫을 출력 |
| 미선언 | 교차 realm 링크가 필요한데 경로를 못 찾으면 **무엇을 어디에 추가할지** 까지 적어서 실패 |

같이 측정할 것: 설치 후 `rojo sourcemap` 재생성이 필요한지, luau-lsp 가 `_Index` 안쪽 타입을
따라가는지. 안 되면 고치는 것과 별개로 **그 사실만이라도 문서화한다.**

**판정:** `place` 를 일부러 틀리게 적은 프로젝트에서 경고가 나오는가. `place` 를 지운 프로젝트가
프로젝트 파일만으로 정상 설치되는가.

---

### R2 — 워크스페이스 설계 연구 (M15 앞에 삽입)

R1 과 같은 이유로 구현 전에 연구 슬롯을 둔다. 답이 정해지지 않은 채로 시작하면 스키마를 두 번
바꾸게 된다.

| 질문 | 왜 어려운가 |
|---|---|
| `_Index` 를 루트에 하나로 호이스팅하나, 멤버별로 두나 | 제약 1의 논리상 하나가 맞다 (dedupe 가 워크스페이스 전체로 확장). 그런데 멤버마다 동기화되는 place 가 다를 수 있다 |
| 멤버 간 의존을 어떻게 링크하나 | 레지스트리 경유가 아닌 로컬 소스. 복사인가 심링크인가, 심링크는 Rojo/Studio 동기화에 어떻게 보이나 |
| 락파일은 루트 하나인가 | 하나가 맞다 (Yarn). 그러면 `root` 스냅샷이 멤버 전부를 담아야 하므로 스키마 변경 |
| 멤버들이 서로 다른 major 를 요구하면 | 제약 5의 충돌 보고를 워크스페이스 범위로 확장 |

산출물: `docs/workspaces-design.md` + 스키마 변경안. R1 이 PnP 를 **기각** 한 것처럼 "Roblox
에서는 워크스페이스가 값을 못 한다" 는 결론이 나올 수도 있고, 그것도 유효한 결과다.

---

### M15 — 워크스페이스

R2 의 결론에 따른다. 지금 확정할 수 있는 것은 `workspaces: ["packages/*"]`, 루트 단일 락파일,
멤버 디렉터리에서의 `install` 이 루트로 위임된다는 것 정도다.

---

### M16 — 1.0.0 배포

배포 설계 자체는 이 문서의 범위 밖이다. 여기에는 **그 전에 참이어야 하는 조건** 만 적는다.

| 선행조건 | 현재 |
|---|---|
| M11 CI 초록 | ✅ |
| 라이브 발행 1회 성공 | ❌ (`--dry-run` 만) |
| M13 import 로 실제 프로젝트 3개 이주 성공 | ✅ |
| `package.json` 이 `0.0.0` / `private: true` 가 아님 | ❌ |
| CHANGELOG 존재 | ❌ |
| 에러 코드표가 문서에 노출 | ❌ (코드에는 있음) |

라이브 발행은 영구적이지만, scope 는 GitHub 계정명이고 그건 어차피 내 것이다.
`hawakiki/rarn-smoke@0.1.0` 을 한 번 올리면 잃는 것은 없고, 얻는 것은 M10 전체가 실제로
동작한다는 유일한 증거다. M16 을 기다릴 이유가 없는 항목.

---

## 3. 이후 (마일스톤에 없는 것)

M11~M16 이 생기면서 이 표의 절반은 마일스톤으로 승격됐다. 여기 남는 것은 **어느 마일스톤에도
속하지 않는** 잔가지뿐이다.

| 항목 | 어디에 얹으면 되나 |
|---|---|
| `rarn pack` → `.rbxm` | Rojo 없이 Studio 드래그. 바이너리 직렬화가 필요해 사실상 별도 마일스톤 |
| `--linked` 캐시 | 하드링크 옵트인. 언제든, 단독 |
| `pack` 의 `.gitignore` 폴백 | M13 근처 — 파일 목록 로직을 어차피 건드릴 때 |
| `_Meta.luau` (해석 맵을 읽기 전용 데이터로) | R1 보류분. 성격은 M14 와 가깝다 |
| CHANGELOG | M16 선행조건 |

승격된 것: 워크스페이스 → **M15**, `wally.toml` 임포트 → **M13**, 크로스컴파일·CI → **M11**,
Rokit 배포 → **M16**. 이미 끝난 것: `rarn publish` → M10, `rarn doctor` → M8.

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
5. ~~R1 PnP 가능성 연구~~ — 완료, 결론: 도입 안 함
6. ~~M3 리졸버~~ — 완료 (feat/resolver)
7. ~~M4 캐시와 취득~~ — 완료 (feat/cache)
8. ~~M5 가지치기~~ — 완료 (feat/prune)
9. ~~M6 링커~~ — 완료 (feat/linker)
10. ~~M7 락파일~~ — 완료 (feat/lockfile)
11. ~~M8 나머지 CLI 명령~~ — 완료 (feat/commands)
12. ~~M9 마감~~ — 완료 (feat/polish)
13. ~~M10 발행~~ — 완료 (feat/polish). 라이브 발행 검증만 남음
14. ~~M11 CI와 빌드 검증~~ — 완료 (feat/ci). 8개 잡 초록
15. ~~M12 설치 트리 원자성과 오프라인~~ — 완료 (feat/atomic-link)
16. ~~M13 `rarn import` — Wally 이주~~ — 완료 (feat/import)
17. **M14 Rojo·place 연동** — 다음 (feat/place)
18. R2 워크스페이스 설계 연구 → M15
19. M16 1.0.0 배포 — 선행조건은 §2 M16 표 참조
20. 각 feat 브랜치는 `--no-ff` 로 `develop` 에 병합
