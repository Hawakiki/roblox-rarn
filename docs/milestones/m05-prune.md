> PLAN.md §2 에서 2026-08-21 에 이관한 기록이다. 완료 시점의 실측을 보존한다.
> 문서 경로 참조만 이관 시점 구조에 맞게 고쳤고, 내용은 편집하지 않는다.

# M5 — 프로젝트 해석과 가지치기 ✅

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

**실측으로 계획을 정정했다** (표본 13개, [docs/research/r1-pnp-feasibility.md](docs/research/r1-pnp-feasibility.md) 7절):

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
