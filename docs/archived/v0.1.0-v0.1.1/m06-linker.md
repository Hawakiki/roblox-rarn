> PLAN.md §2 에서 2026-08-21 에 이관한 기록이다. 완료 시점의 실측을 보존한다.
> 문서 경로 참조만 이관 시점 구조에 맞게 고쳤고, 내용은 편집하지 않는다.

# M6 — 링커 ✅

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

## Lune 하니스 — 무엇을 증명하고 무엇을 못 하나

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
