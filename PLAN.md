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

## 2. 마일스톤 — 1.0.0 으로 가는 길

**1.0.0 은 포맷 동결이다.** `rarn.json` 과 `rarn.lock` 의 모양을 되돌릴 수 없게 만드는
약속이지 기능 완성 선언이 아니다. CLAUDE.md 와 CHANGELOG 가 이미 그렇게 적어 두었다 —
*"the manifest and lockfile formats are not stable yet."*

그래서 아래는 전부 **동결하기 전에 결론이 나야 하는 것**들이다. 새 기능은 없다.

0.1.1 까지의 기록(M0 ~ M17)은 [`docs/archived/v0.1.0-v0.1.1/`](docs/archived/v0.1.0-v0.1.1/) 에
동결돼 있다. 번호는 여기서 M1 부터 다시 시작하므로 **같은 번호가 두 시대에 있다** — 경로로
구분한다. 수식 없는 `M1` 은 이 시대를 뜻한다.

| | 마일스톤 | 상태 | 끝나는 조건 / 결과 |
|---|---|---|---|
| M1 | 라이브 발행 1회 | ✅ | `hawakiki/luau-mathlib@0.1.0` 발행. Rarn·Wally 양쪽에서 설치 확인 — [기록](docs/milestones/v1/m01-live-publish.md) |
| M2 | 별칭 충돌 정책 확정 | ✅ | 섹션 단위로 확정. 규칙은 CLAUDE.md Naming 에 — [기록](docs/milestones/v1/m02-alias-scope.md) |
| M3 | 파이프라인을 `cli/` 에서 꺼내기 | ✅ | `src/install/run.ts`. 합성 테스트 8개, 행동 변화 0 — [기록](docs/milestones/v1/m03-install-pipeline.md) |
| M4 | 스키마 동결 리뷰 | | 두 스키마의 모든 필드를 한 번씩 변호한다. **이게 동결 그 자체다** |
| M5 | 문서·주장 감사 | ✅ | 낡은 것 3, 빠진 것 2. 나머지는 맞았다 — [기록](docs/milestones/v1/m05-doc-audit.md) |

M4 만 남았다.

### M1 — 라이브 발행 1회 ✅

`hawakiki/luau-mathlib@0.1.0` 을 발행하고, 그것을 Rarn 과 Wally 양쪽으로 다시 설치해 동작을
확인했다. 상세는 [기록](docs/milestones/v1/m01-live-publish.md).

**M4 로 넘어간 것:** 기본 `exclude` 가 Wally 의 `Packages/`·`DevPackages/` 를 모른다.
`alwaysExcluded` 는 `packageDir` 로 Rarn 자신의 realm 디렉터리만 계산하므로, Wally 에서
이주한 사용자는 `exclude` 를 손으로 적지 않으면 의존성 트리를 통째로 발행하게 된다.
실제로 아카이브가 388개 파일로 나왔다가 45개가 됐다.

### M2 — 별칭 충돌 정책 확정 ✅

**섹션 단위로 정했다.** 루트 shim 이 매니페스트 섹션별로 다른 realm 디렉터리에 쓰이므로,
두 별칭이 같은 경로에 오는 것은 같은 섹션에서만 일어난다.

세 개를 합쳐 세던 것은 레이아웃보다 엄격했고, 하나는 그냥 틀렸다 — 같은 패키지를 두 섹션에
선언하는 것을 자기 자신과의 충돌로 읽어, `writeRootShims` 가 주석으로 명시한 동작을 도달
불가능하게 만들고 있었다. 규칙은 CLAUDE.md 의 Naming 에 적었다(R2 가 지적한 "문서에 없다").

상세와 측정은 [기록](docs/milestones/v1/m02-alias-scope.md).

### M3 — 파이프라인을 `cli/` 에서 꺼내기 ✅

`src/install/run.ts` 가 파이프라인을 갖고 `src/cli/commands/install.ts` 는 배선만 남았다.
진행 상황은 `observer` 로 뒤집어, 터미널 없는 호출자가 특수한 경우가 아니게 했다.

합성 테스트 8개가 생겼다. **행동 변화 0** — 실제 설치의 출력과 파일 트리를 옛 코드와
`diff` 해서 확인했다. 상세는 [기록](docs/milestones/v1/m03-install-pipeline.md).

### M4 — 스키마 동결 리뷰

두 스키마를 처음부터 끝까지 읽고 **모든 필드를 한 번씩 변호한다.** 바꿀 것이 있으면 그것이
마지막 breaking change 이고 0.2.0 으로 낸다. 없으면 없다는 결론을 근거와 함께 기록한다.

미리 아는 안건: `lockfileVersion` 을 1 로 둘 것인가 · `place` 에 dev 가 없는 것이 맞나 ·
`resolutions` 의 의미 · `aliases`(M2 의 결과) · M1 이 발행 경로에서 무엇을 드러내는가.

### M5 — 문서·주장 감사 ✅

경로 21 · 에러 코드 8 · CLI 명령 16 · 스크립트 7 · 레이어 디렉터리 12 · 식별자 9 · 링크 35,
그리고 Wally API 사실 5개를 라이브로. **낡은 것 3, 빠진 것 2.**

낡은 셋 중 둘은 같은 날 바뀐 코드를 문서가 못 따라간 것이다 — 문제는 문서를 안 쓴 것이 아니라
**코드와 같은 커밋에서 안 고친 것**이었다. 상세는 [기록](docs/milestones/v1/m05-doc-audit.md).

---

## 3. 1.0 게이트

마일스톤이 다 끝나도 1.0 이 아니다. 아래가 **참이 되어야** 한다. 우리가 앞당길 수 없는 것들이라
마일스톤으로 적지 않는다 — 기다림을 마일스톤에 넣으면 계획이 영원히 안 끝난 것처럼 보인다.

- [ ] **우리 밖 프로젝트 3~5개가 0.1.x 로 설치해서 돌아간다.**
      지금 별 0, 포크 0, 다운로드는 전부 우리 것이다.
- [ ] **마지막 스키마 변경 후 한 달간 스키마를 건드릴 이유가 안 생겼다.**
- [ ] **`docs/known-issues.md` 미해결 0.** (지금 0)

라이브 발행은 M1 에서 닫혔다 — 1.0.0 선행조건 중 실행이 남아 있던 마지막 항목이었다.

게이트가 열릴 때까지 **0.1.x 를 계속 낸다.** 기다리는 동안 배포가 멈추면 신호를 받을 창구가
사라진다.

### 왜 이렇게 늦추나

이 프로젝트에서 결함을 찾은 것은 테스트가 아니라 현실이었다.

| 결함 | 무엇이 찾았나 | 테스트 463개는 |
|---|---|---|
| RN-1 데이터 손실 (0.1.0 철회) | R2 가 문서화된 워크플로를 끝까지 돌려서 | 못 잡음 |
| RN-6 512 KiB 언팩 불가 | 벤치마크가 실제 패키지를 밟아서 | 못 잡음 |
| 무제한 동시 요청 | 그래프를 506개로 키워서 | 못 잡음 |

아무도 안 써본 포맷을 동결하는 것은 찍는 것이고, 지금 1.0 을 박으면 그 다음에 나올 것들을
breaking change 로 갚아야 한다.

---

## 4. 1.0 밖

**포맷 동결**이 1.0 의 뜻이므로 기능은 전부 1.x 다. 근거와 함께 적어 둔다 — 나중에
"왜 안 넣었더라" 가 되지 않게.

| 항목 | 왜 밖인가 |
|---|---|
| **워크스페이스** | R2 가 REDUCE_SCOPE(신뢰도 80%). 둘 이상의 `rarn.json` 을 한 리포에 둔 **실제 사용자**가 나타난 뒤에만 연다. 이제 그 신호를 읽을 계측기가 있다 — `rarn dedupe` 의 `RN0213` |
| **메타데이터 캐시** (+ `--prefer-offline`) | 콜드 설치가 Wally 보다 느린 원인이고 고치면 눈에 띄게 빨라진다([벤치마크](test/benchmark/README.md): 506개에서 37.3s 중 8.9s). 그러나 **새 기능이고 스키마를 건드리지 않는다.** CLAUDE.md 가 `--prefer-offline` 은 메타데이터를 캐시하는 날 돌아온다고 적어 두었다 |
| `rarn pack` → `.rbxm` | Rojo 없이 Studio 드래그. 바이너리 직렬화가 필요해 사실상 단독 마일스톤 |
| `--linked` 캐시 | 하드링크 옵트인. 언제든, 단독 |
| `pack` 의 `.gitignore` 폴백 | 파일 목록 로직을 어차피 건드릴 때 |
| `_Meta.luau` | R1 보류분 |
| 하니스의 별칭 동일성 비교 | 506개 트리에서 40개 별칭이 겹쳐 거짓 실패를 낸다([벤치마크](test/benchmark/README.md)). 하니스 개선이지 제품이 아니다 |

---

## 5. 브랜치

정확한 규칙과 근거는 [CLAUDE.md](CLAUDE.md) 의 Conventions 에 있다. 여기서는 어디를 보면
되는지만 적는다 — 규칙이 두 곳에 있으면 언젠가 갈라진다.

`.husky/branch-guard.sh` 가 이름을 검사한다. `master` 직접 커밋과 `feat/` · `hotfix/` ·
`release/` 가 아닌 접두어를 막고, 머지 해결과 detached HEAD 는 통과시킨다.

---

## 6. 위험 요소

| 위험 | 영향 | 대응 |
|---|---|---|
| Cargo 범위 문법 번역 누락 | 범위를 조용히 오해석 | 전용 유닛 테스트. [아카이브 M2](docs/archived/v0.1.0-v0.1.1/m02-registry.md) 에서 처리 |
| `default.project.json` 형태가 다양함 | 잘못된 트리 배치 | 단순형만 처리, 나머지는 통째 복사 + 경고 |
| `Content-Type` 이 거짓말함 | 해제 실패 | 매직바이트로만 판별 |
| Wally API 스펙 변경 | 전면 고장 | 클라이언트를 한 파일에 격리, 검증 사실을 CLAUDE.md에 기록 |
| zip slip | 임의 파일 쓰기 | 엔트리 경로 검증 |
| Bun `--compile` 바이너리 크기 (50~110MB) | 배포 부담 | `--minify --bytecode` |
| 순환 의존성 | 무한 루프 | 방문 표시, 순환은 경고 처리 |
| **런타임별 라이브러리 동작 차이** | 테스트는 통과하고 출하본이 깨진다 | Bun 에서 fflate 의 워커가 512 KiB 넘는 엔트리에 실패했다(RN-6). Node 에서는 멀쩡했다. Bun 으로 테스트하는 것만으로는 부족했고, 픽스처가 그 경계를 넘겨야 잡혔다 |
| **상한 없는 팬아웃** | 넓은 그래프에서 급격히 느려짐 | 모든 병렬 지점에 상한을 두고, 값은 측정으로 고른다 (메타데이터 32, 다운로드 8). 무제한은 최적의 12배였다 |

---

## 7. 테스트 전략

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

절차: `rarn install` → `rojo build` → Studio에서 열기 → `execute_luau` 로 검증.

**Studio MCP 를 쓸 수 있게 되어 이 단계가 더 이상 수동이 아니다.** 2026-08-21 에 처음
돌렸고, 결과는 CLAUDE.md 의 "The model has been checked against real Studio" 에 있다.
요약하면 하니스가 모델 안에서 주장하던 것이 전부 실제로도 참이었다 — dedupe 동일성,
교차 realm 동일성, `Knit.Util` 이 `_Index` 엔트리 폴더라는 것, 그리고 knit/promise/signal
이 실제로 실행된다는 것.

모델이 맞다고 확인된 것은 **이 트리 모양 하나**다. 링커를 건드리면 다시 돌린다 —
자동화된 것은 하니스이고, 하니스가 옳은지는 여기서만 확인된다.

---

