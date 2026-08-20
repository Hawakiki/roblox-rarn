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

### M8 — CLI 명령 (계획)

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

### M10 — 발행 (연기, 조사만 완료)

**이번 M8 에 넣지 않기로 했다.** 다만 API 를 실측으로 확인해 뒀으므로 다시 조사할 필요는 없다.

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

예정 명령: `login` `logout` `whoami` `pack` `publish`.
`pack` 이 분량의 대부분 — include/exclude 글롭, `.gitignore` 폴백, `wally.toml` 생성.
`rarn.json` 스키마에 `include`/`exclude` 는 이미 있다.

> **발행은 되돌릴 수 없다.** 레지스트리는 버전을 불변으로 보고 `409` 로 재발행을 막는다.
> `pack --list`(무엇이 들어갈지 미리 보기)와 `publish --dry-run` 은 선택이 아니라 필수다.

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
5. ~~R1 PnP 가능성 연구~~ — 완료, 결론: 도입 안 함
6. ~~M3 리졸버~~ — 완료 (feat/resolver)
7. ~~M4 캐시와 취득~~ — 완료 (feat/cache)
8. ~~M5 가지치기~~ — 완료 (feat/prune)
9. ~~M6 링커~~ — 완료 (feat/linker)
10. ~~M7 락파일~~ — 완료 (feat/lockfile)
11. **M8 나머지 CLI 명령** — 계획 완료, 실행 대기 (feat/commands)
12. M9 마감 → M10 발행 (연기)
13. 각 feat 브랜치는 `--no-ff` 로 `develop` 에 병합
