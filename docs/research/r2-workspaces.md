# R2 — Roblox 에서 워크스페이스란 무엇인가

> **결론: REDUCE_SCOPE.** 확신도 80%.
> 조사일: 2026-08-21. 9-agent 워크플로(독립 조사 7 + 적대적 검증 1 + 종합 1),
> 에러 0건, 도구 호출 653회, 72분.

이 문서는 R2 연구의 산출물이다. M15 의 범위는 여기서 도출된다.
결론을 미리 정하지 않았음을 보이기 위해, 무엇이 결론을 뒤집었을지도 함께 적었다.

---
# 워크스페이스 설계 연구 (R2)

> **결론: M15를 스케치대로 짓지 않는다. 범위를 줄인다.**
>
> place 지향 워크스페이스는 **짓지 않는다** — 실측 결과 이미 서비스되고 있고, 수요가 0이며,
> 발생률이 ~1%다. 패키지 지향 워크스페이스는 **기각되지 않았다** — Rarn 자신의 제약 5가
> 새고 있고(재현함), 수요가 12 대 0으로 한쪽으로만 쏠려 있다. 그러나 지금 지을 수 없다:
> 인스톨러가 그 기능의 이름이 된 디렉터리를 지우고, 모든 후보 설계가 쓰는 shim 형태를
> 프로젝트 자신의 하니스가 검증하지 못하며, 정규 멤버 형태의 설치 출력이 Rojo에
> 조용히 도달하지 못한다.
>
> **신뢰도 80%.** 조사일: 2026-08-21. 저장소 상태: HEAD `7061a60`, `src/`·`schemas/`가
> `v0.1.0` 태그와 바이트 동일(`git diff --stat v0.1.0 HEAD -- src/ schemas/` 공백).
> 아래 모든 측정은 이 소스와 출하된 `dist/rarn-windows-x64.exe`(자기 보고 `0.1.0`)에
> 대해 직접 실행했다. 저장소는 변경되지 않았다.

---

## 0. 요약

| 질문 | 답 |
|---|---|
| Rarn 워크스페이스란 무엇인가 | **하나의 DataModel로 함께 마운트되는 설치 트리들의 집합.** 리포지터리가 아니라 place가 경계다 |
| npm의 워크스페이스 모델이 이전되는가 | **절반만.** 호이스팅은 *목표*만 이전되고 *메커니즘*은 이전되지 않는다. task running과 `--filter`는 전혀 이전되지 않는다 |
| 다중 place 프로젝트가 워크스페이스를 필요로 하는가 | **아니오.** 루트 매니페스트 하나가 이미 완전히 서비스한다 (§3.3에서 측정) |
| 라이브러리 monorepo가 필요로 하는가 | **필요는 실재한다.** 5년째 열려 있는 Wally 이슈 4건, 레지스트리 엣지의 46.0%가 scope 내부 |
| 그럼 지어야 하는가 | **지금은 아니다.** 선행 결함 4개가 워크스페이스를 지을 수도 검증할 수도 없게 만든다 |
| 지금 지을 것 | 선행 결함 4개 + 크로스 트리 중복 **진단** (스키마 변경 0) |
| 언제 다시 볼까 | 둘 이상의 `rarn.json`을 둔 실제 Rarn 사용자가 나타났을 때 |

---

## 1. Rarn 워크스페이스의 정의

**먼저 정의하고, 그다음에 지을지 정한다.** 이 순서가 중요한 이유는 "워크스페이스"라는
단어가 Roblox에서 서로 반대되는 두 가지를 가리키기 때문이다.

### 1.1 경계는 매니페스트가 아니라 DataModel이다

세 개의 후보 경계가 있었고, 코드가 셋 다에 답한다.

| 후보 | 경계인가 | 근거 |
|---|---|---|
| **realm** | **아니다** | `ResolvedPackage.placement`는 스칼라 하나(`src/resolver/types.ts:24`)이고 링커는 그것으로 엔트리 디렉터리를 정한다(`src/linker/link.ts:113`). 다른 realm은 절대 DataModel 경로로 도달한다. **버전당 물리 사본 정확히 1개** |
| **매니페스트** | **구현상 그렇다** | `resolve()`는 `NormalizedManifest` 하나만 받는다(`src/resolver/resolve.ts:60`). 직접 엣지는 전부 `from: 'root'`로 찍힌다 |
| **DataModel** | **요구상 그렇다** | `require`는 Instance 단위로 캐시하고, Instance는 정확히 하나의 DataModel에 속한다. Roblox 공식 문서: 모듈은 "Lua 환경당 단 한 번" 실행되고, 클라이언트/서버 경계 양쪽에서 require하면 "각 쪽마다 고유 참조"를 반환한다 |

**둘은 같은 경계가 아니다.** "매니페스트 하나 = place 하나"인 동안만 겹친다 — 그리고
워크스페이스란 정확히 그 전제가 깨지는 상황이다.

Rarn 자신의 소스가 이미 이걸 안다. `src/project/place.ts:89-99`는 한 realm 디렉터리가
두 DataModel 경로에 마운트되는 경우를 보고하며 주석에 이렇게 적혀 있다: *"Two DataModel
paths for one realm means two copies of every package in it at runtime — the duplication
this whole layout exists to prevent."* 그것은 매니페스트 경계가 유지되는 동안 DataModel
경계가 깨지는 경우다. 워크스페이스 문제는 그 거울상이다.

### 1.2 정의

> **Rarn 워크스페이스란, 각자 `rarn.json`을 가진 디렉터리들이 하나의 Rojo 프로젝트
> 파일에 의해 하나의 DataModel로 마운트될 때, 그 전체를 단일 제약 그래프로 해석해
> 각 패키지가 그 DataModel 안에서 정확히 하나의 ModuleScript Instance만 갖게 만드는
> 단위다** — 그리고 그 부수 효과로 멤버가 발행 이전에 형제 멤버를 참조할 수 있게 하는 것.

따름 결과 두 가지, 그리고 둘은 서로 반대 방향을 가리킨다.

- **같은 place로 가는 멤버들**은 하나의 그래프로 해석되어야 하고 설치 트리가 호이스트되어야
  한다. 그렇지 않으면 §3.1의 correctness 버그가 그대로 나온다.
- **다른 place로 가는 멤버들**은 런타임에 아무것도 공유하지 않는다. 크로스 멤버 dedupe는
  불필요한 정도가 아니라 **의미가 없고**, 하나의 물리 트리로 호이스팅하면 오히려 해롭다 —
  크로스 realm shim이 절대 DataModel 경로를 파일에 문자 그대로 굽기 때문이다(측정된
  shim 본문: `return require(game.ReplicatedStorage.Packages._Index["evaera_promise@4.0.0"]["promise"])`).

### 1.3 Rarn의 realm machinery는 이미 워크스페이스다

이것이 이 조사에서 가장 유용한 관찰이고, 남은 작업의 정직한 크기를 보여 준다.

| 워크스페이스가 필요로 하는 것 | Rarn에 이미 있는가 | 어디 |
|---|---|---|
| 하나의 해석이 N개 설치 트리를 먹인다 | ✅ | `resolve()` → 3개 realm 디렉터리 |
| 패키지당 물리 사본 정확히 1개 (가장 넓은 placement) | ✅ | `ResolvedPackage.placement` 스칼라 + `link.ts:113` |
| 트리 간 링크를 절대 DataModel 경로로 | ✅ | `crossRealmShim` (`src/linker/shim.ts:42-48`) |
| 트리당 최상위 shim 네임스페이스 | ✅ | `writeRootShims` |
| 다운로드/압축해제 dedupe | ✅ | 전역 캐시 (측정: 별개 프로젝트 2개가 각각 `0 downloaded, 4 cached`) |
| **멤버 목록이 데이터인 것** | ❌ | 상수 `{shared, server, dev}`로 하드코딩 |
| **로컬 의존성 지정자** | ❌ | `dependencyMap` 값은 `$defs/range`뿐 |
| **복수형 락파일 `root`** | ❌ | 단일 객체 |

**빠진 것은 링킹 시스템이 아니라 멤버 목록, 로컬 지정자, 복수형 스냅샷 셋뿐이다.**
이건 "워크스페이스"라는 단어가 시사하는 것보다 훨씬 작다. 그리고 훨씬 작은 것은
미루기도 쉽다.

### 1.4 정의가 성립하지 않는 경우

place 지향 해석에서는 이 정의가 **공집합을 가리킨다**. 멤버가 place라면 각자 자기
DataModel을 가지므로 "함께 마운트된다"가 성립하지 않고, 남는 것은 리포지터리와 캐시와
`resolutions` 맵을 공유하는 N개의 독립 해석 — 즉 워크스페이스가 아니라 그냥 여러
프로젝트다. **이것도 정의이고, 유효한 정의다.** 그리고 §3.3에서 보듯 그 경우는 이미
해결되어 있다.

---

## 2. npm vs Roblox 개념 대응표

npm의 "package"는 네 역할을 겸한다. Roblox는 그것을 네 개의 다른 산출물로 쪼개고,
그중 하나는 npm이 생각할 필요조차 없는 방식으로 쪼개진다.

| npm의 "package"가 하는 역할 | Roblox/Rarn 산출물 | 1:1? |
|---|---|---|
| 발행·버저닝 단위 | Wally 패키지 `scope/name@version` = `_Index` 엔트리 폴더 | 예 |
| 의존성 선언 단위 | `rarn.json` (Wally: `wally.toml`) | 예 |
| 해석 루트(설치 트리 소유) | 프로젝트 디렉터리 — 단 **3개** 트리를 소유 | **1:3** |
| **런타임 모듈 정체성** | **ModuleScript Instance** | **아니오** |

네 번째 행이 문제의 전부다. npm에서 정체성은 패키지를 따라간다 — 같은 패키지를 두 번
해석해도 Node 캐시는 해석된 *경로*를 키로 쓰므로 같은 모듈이다. Roblox에서 키는
Instance이고, 한 디렉터리를 두 DataModel 위치에 마운트하면 Instance가 둘이 된다.
(Agent 1이 측정: 한 실디렉터리를 junction 2개 + 직접 `$path` 1개로 3회 마운트 →
서로 다른 ModuleScript 3개, 셋 다 `filePaths: ["../real/src/init.luau"]`. **Rojo는
실경로로 dedupe하지 않는다.**)

> **"패키지 하나 = 모듈 하나"는 Roblox가 주는 속성이 아니다. 링커가 만드는 속성이다** —
> 소스를 정확히 한 번만 마운트하고 모든 요구자를 shim으로 그 한 곳에 보냄으로써.
> `_Index`가 하는 일이 바로 그것이다.

### 2.1 대응물이 아예 없는 npm 개념

| npm 개념 | 왜 대응물이 없는가 |
|---|---|
| 해석 알고리즘 (walk-up) | 엔진에 없다. `require`는 Instance를 받는다. (단서는 §2.3) |
| **호이스팅** | npm에서 호이스팅은 walk-up 리졸버가 허용하는 최적화다. 리졸버가 없으면 "찾을 수 있는 곳으로 옮긴다"가 성립하지 않는다. 여기서 한 곳에 두는 유일한 이유는 **Instance 정체성** — 즉 호이스팅은 크기 메커니즘이 아니라 correctness 메커니즘이다 |
| "리포지터리당 의존성 트리 하나" | 한 리포가 N개 place를 빌드할 수 있고, 각 place는 별개 DataModel이며 Instance를 하나도 공유하지 않는다. 리포 전체를 아우르는 런타임이 없다 |
| topological task running / `--filter` | Rarn에 `scripts` 필드가 없고(스키마 `additionalProperties: false`), 파이프라인은 `link`에서 끝나며, 발행되는 Wally 아티팩트는 소스 그 자체다. 형제를 먼저 빌드해야 하는 것이 아무것도 없다. 조사한 실제 monorepo 4곳 중 멤버를 위상 정렬하는 곳은 0곳 |

### 2.2 npm에 대응물이 없는 Roblox 개념

| Roblox 개념 | npm에 유사물이 없는 이유 |
|---|---|
| **place** (`.rbxl`, DataModel-형 Rojo 프로젝트로 빌드) | npm은 "의존성 트리가 실행 중인 프로그램의 *어디에* 구체화되는가"를 말할 필요가 없다 |
| **realm** (`shared`/`server`/`dev`) | npm의 `devDependencies`는 하나의 트리에 대한 *필터*다. realm은 서로 다른 서비스로 동기화되는 물리적으로 분리된 3개 트리이고, 크로스 링크는 절대 DataModel 경로다 |

### 2.3 CLAUDE.md 제약 1에 붙일 단서

제약 1은 "해석 알고리즘이 없다 — `node_modules`를 찾아 디렉터리를 거슬러 올라가는
것이 없다"고 적는다. **엔진에 대해서는 참이고 생태계에 대해서는 거짓이다.**
Quenty/NevermoreEngine(별 606개, 283개 워크스페이스 멤버)은
`src/loader/src/Dependencies/DependencyUtils.lua`에 `iterNodeModulesUp(module)`을 담아
`.Parent`를 거슬러 올라가며 `node_modules` Folder를 찾고, 헤더 주석이 스스로를
"the node_modules dependency resolution algorithm"이라 부른다.

이것이 Rarn의 결정을 바꾸지는 않는다 — 런타임 리졸버는 모든 패키지가
`local require = require(script.Parent.loader).load(script)`로 **opt-in** 해야 하고,
Rarn이 설치하는 레지스트리 패키지는 그러지 않기 때문이다. 그러나 제약 1이
"불가능"으로 읽히지 않도록 반 문장을 덧붙일 가치는 있다: *"엔진은 제공하지 않고, 직접
지은 리졸버는 패키지 저자가 opt-in 해야 한다"* — 후자가 Rarn에서 쓸 수 없는 진짜 이유다.

---

## 3. 네 가지 핵심 질문

PLAN.md R2가 던진 네 질문. 각각에 대해 결론과 증거 수준을 붙인다.

### 3.1 `_Index`를 루트에 하나로 호이스팅하나, 멤버별로 두나 — **[FACT] 질문이 잘못 놓여 있다**

PLAN.md의 근거: *"제약 1의 논리상 하나가 맞다 (dedupe가 워크스페이스 전체로 확장).
그런데 멤버마다 동기화되는 place가 다를 수 있다."*

**전제가 테스트를 통과하지 못한다.** 제약 1의 범위는 하나의 Lua 환경 = 하나의 DataModel이지
리포지터리가 아니다. 정답은 "경우에 따라"이고, 경우를 가르는 것은 **멤버들이 같은 place로
마운트되는가**이다. Agent 3, 6, 8이 독립적으로 같은 결론에 도달했고, 나는 양쪽을 직접 측정했다.

**같은 place면 호이스팅이 필수다.** 내가 재현한 것 (모든 명령을 직접 실행):

```
alpha/rarn.json   "@evaera/promise": ">=3.1.0 <=3.2.0"   ->  _Index/evaera_promise@3.2.0
beta/rarn.json    "@evaera/promise": ">=3.2.0 <4.0.0"    ->  _Index/evaera_promise@3.2.1

rarn dedupe (alpha):  no duplicates — every package is installed at exactly one version
rarn dedupe (beta):   no duplicates — every package is installed at exactly one version

rojo sourcemap, 둘 다 한 place에 마운트:
  promise ModuleScript instances in ONE DataModel: 2
    ws.ReplicatedStorage.Alpha._Index.evaera_promise@3.2.0.promise
    ws.ReplicatedStorage.Beta._Index.evaera_promise@3.2.1.promise
```

두 범위의 교집합은 **정확히 3.2.0 하나**다. Rarn의 리졸버는 이미 그 교집합을 순서
독립적으로 계산한다 — 두 매니페스트를 동시에 본 적이 없을 뿐이다. 결과는 제약 5가
금지하는 semver-**호환** 중복 두 개가 한 DataModel에 들어가고, 그것을 잡으라고 만든
진단이 양쪽 모두에서 "이상 없음"을 선언하는 것이다.

**다른 place면 호이스팅은 이득 0, 손해 실재.** 크로스 realm shim은 절대 DataModel 경로를
파일에 문자 그대로 굽는다(내가 확인한 실제 shim 본문):

```lua
-- Packages_SERVER/_Index/sleitnick_comm@1.0.1/Promise.luau
return require(game.ReplicatedStorage.Packages._Index["evaera_promise@4.0.0"]["promise"])
```

두 place가 그 트리를 서로 다른 DataModel 경로에 마운트하면 이 문자열은 한쪽에서만 유효하다.

**그리고 병합 자체가 새 실패를 만든다.** 내가 측정: `dependencies`에 comm(shared),
`serverDependencies`에 promise를 선언하면 promise가 **복제되는 shared 디렉터리**
`Packages/_Index/evaera_promise@4.0.0`에 놓인다. `serverDependencies`는 "이건 클라이언트로
복제되면 안 된다"는 진술인데, 가장 넓은 realm 규칙(`PLACEMENT_RANK` shared 3 > server 2)이
그것을 조용히 뒤집는다. 단일 매니페스트 안에서는 한 저자가 둘 다 썼으므로 올바르고
의도된 동작이지만, 멤버 경계를 넘으면 소유권 경계를 넘는 무보고 override가 된다.
Agent 6은 여기에 더해 각각 단독으로는 링크되던 두 멤버가 병합 시 `RN0031
MissingPlacePath`로 죽는 것을 측정했다.

**최상위 alias 독점.** 호이스트된 realm 디렉터리는 최상위에서 alias당 버전 **하나**만
서비스할 수 있다(`writeRootShims`가 매니페스트 키당 `.luau` 하나). 전이 중복은 각자
`_Index` 엔트리에 살아 무관하지만, 두 멤버가 같은 **직접** 의존성의 다른 major를 원하면
하나의 호이스트 최상위로는 둘 다 서비스할 수 없다.

### 3.2 멤버 간 의존을 어떻게 링크하나 — **[FACT] 심링크는 닫힌 문제**

세 방향의 독립 측정이 일치한다. 나는 이것들을 재실행하지 않았고 세 에이전트의 측정이
서로 모순 없이 일치하며 upstream 이슈 2건이 뒷받침한다.

| 메커니즘 | 디스크 | `rojo build`/`sourcemap` | `rojo serve` 라이브 동기화 | DataModel의 B 인스턴스 수 | Rarn 하니스 |
|---|---|---|---|---|---|
| **복사** | 전체 중복 | 평범한 파일 | n/a (재설치까지 stale) | 사본당 1 | **통과** (3/3) |
| **심링크/junction** | reparse point 1개 | 따라감. `filePaths`는 **실경로** 보고. 전체 서브트리 구체화 | **아니오** | 링크당 1 | 통과 |
| **하드링크** | inode 공유 | 평범한 파일 | **아니오** | 1 | 통과 후 썩음 |
| **중첩 Rojo 프로젝트** | 작은 JSON 1개 | 프로젝트 파일 `name`으로 인스턴스 명명 | **아니오** | 1 | **실패** (1/3) |
| **절대경로 shim** | `.luau` 한 줄 | 평범한 ModuleScript | **예** | **추가 0** | 실패 (크로스 realm과 동일 원인, §3.5) |

통합 규칙 하나가 이 표를 무너뜨린다:

> **Rojo는 *최상위* 프로젝트 파일의 `$path`가 지명한 파일시스템 루트만 감시한다.**
> 인스턴스는 자신의 해석된 `filePaths`가 그 루트 중 하나 아래에 있을 때만 라이브 갱신된다 —
> 어떤 경로로 도달했는지와 무관하게.

즉 "아니오" 열은 멤버의 실디렉터리가 최상위 `$path`로 **독립적으로** 마운트되는 순간
전부 "예"가 된다. 그러면 어떤 링크도 복사가 주지 못하는 것을 주지 않는다.

그리고 dedupe 관점에서 결정적인 것: **심링크는 Instance 정체성을 보존하지 않는다.**
Rojo는 링크를 해석한 다음 *사본을 구체화한다*. Rarn이 실제로 신경 쓰는 축 —
"이게 ModuleScript 하나냐 둘이냐" — 에서 심링크는 `cp -r`와 구별되지 않는다.

upstream이 뒷받침한다: rojo #278 "Symlinked folders drop changes on some platforms"
(2019년부터 open), #392 "build fails when src contains symlinked folders"
(2021년부터 open). 그리고 Wally는 2021년에 같은 갈림길에 도달했다 — issue #7이
정확히 Symlinks 대 Rojo Project Composition을 나열하고, 심링크의 단점으로
*"Rojo has known bugs when interacting with symlinks that are hard to solve"* 를 적는다.
그 이슈의 작성자는 Rojo와 Wally를 둘 다 만든 사람이다.

**남는 후보는 둘.**

- **복사** — 링커 변경이 **전혀 필요 없다.** `LinkOptions.sources`는 `packageKey → 디렉터리`
  맵이고 하류 어디도 그 디렉터리의 출처를 묻지 않는다. Agent 4가 무수정 `link()`에 멤버
  디렉터리를 넘겨 정상 설치 + 하니스 3/3을 확인했다. Wally의 현행 WIP(PR #256)가 실제로
  구현하는 것도 이것이다 — `PathSource::download_package`가 멤버 디렉터리를 아카이브로
  **pack** 한다. 단 하나의 약점(멤버 편집이 재설치 전까지 Studio에 도달하지 않음)은 멤버가
  별도로 최상위 마운트되지 않는 한 **다른 모든 메커니즘도 공유한다.**
- **절대 DataModel 경로 shim** — 유일하게 Instance 정체성을 보존하고 라이브 동기화되며
  아무것도 복사하지 않는다. 그리고 링크를 하지 않음으로써 그렇게 한다: 사용자가 이미
  가진 마운트를 가리킨다. 메커니즘은 `crossRealmShim`으로 **이미 존재한다.**
  비용은 멤버당 `place`-형 선언이 필요하다는 것과, 틀리면 Studio에서
  `Requested module experienced an error while loading` 한 줄만 남는다는 것 —
  CLAUDE.md가 설치 시점 `place` 검증을 정당화할 때 쓴 바로 그 논거다.

**정직한 설계 질문은 "복사냐 심링크냐"가 아니다** — 그건 측정으로 닫혔다. 진짜 질문은
*Rarn이 멤버가 DataModel에 마운트되어 있기를 요구하는가*이다. 요구한다면 shim 메커니즘이
거의 공짜이고 올바르다. 요구하지 않는다면 복사가 유일한 선택지다.

**한 가지 함정.** Rojo는 shadow하지 않는다. 같은 `$path` 아래에 디스크에 이미 존재하는
이름을 프로젝트 파일 자식으로 선언하면 override가 아니라 **같은 이름의 형제 인스턴스 2개**가
생긴다(Agent 4 측정). 실제 리포 4곳이 손으로 쓰는 오버레이 패턴
(`"Packages": { "$path": "../../Packages", "Spark": { "$path": "../../" } }`)이 정확히
그 형태이므로, Rarn이 그 이름을 함께 쓰기 시작하면 조용한 이름 충돌이 된다. CLAUDE.md가
이미 Studio 결과를 기록해 두었다: `FindFirstChild`는 먼저 추가된 쪽을 반환하고 다른 쪽은
도달 불가능해지며 에러는 없다.

### 3.3 락파일은 루트 하나인가 — **[FACT] 하나여도 dedupe를 주지 않는다**

Agent 5가 이 조사에서 가장 중요한 반증 하나를 냈고, 아무도 반박하지 않았다.

동일한 매니페스트를 가진 두 멤버를 독립 설치해 **같은 버전에 합의**시킨 뒤 — 루트 락파일이
낼 수 있는 최선의 결과 — 두 트리를 한 디렉터리에 넣고 프로젝트 자신의 Lune 하니스를 돌렸다:

```
member A Knit == member B Knit ?           false
same shim twice ?                          true     <- 대조군: 하니스가 구별력이 있다
member A top shim == its _Index module ?   true
```

> **루트 락파일은 dedupe하지 않는다. 버전 합의는 Instance 정체성이 아니다.**

바이트 단위로 knit 1.7.0에 합의한 두 멤버가 한 DataModel에서 여전히 **두 개의 모듈
테이블**을 만든다. Instance가 둘이기 때문이다. 따라서:

- Instance 정체성은 **물리 트리 하나**를 요구하지 락파일 하나를 요구하지 않는다.
- 제약 1 논거가 정당화하는 것은 **호이스트된 설치 트리**다. 루트 락파일은 그 결정의
  *따름 결과*이지 독립적인 선(善)이 아니다.
- **PLAN.md M15가 "지금 확정할 수 있는 것"으로 적어 둔 "루트 단일 락파일"은 확정되지
  않았다.** 락파일 결정은 트리 결정을 따라갈 수는 있어도 이끌 수 없다.

**루트 락파일이 실제로 주는 것**은 버전 합의와 리뷰 가능한 단일 diff다. 가질 만하다.
같은 값을 매기면 안 된다.

**구체적 차단 요소.** 로컬 멤버는 오늘 `rarn.lock`에 기록될 수 없다:

| 차단 | 위치 |
|---|---|
| digest 없으면 `InternalError`("This is a bug in Rarn. Please report it.") | `src/lockfile/write.ts:43-50` |
| `contentsUrl(...)`을 무조건 호출 → `https://api.wally.run/...` 합성 | `src/lockfile/write.ts:55` |
| `lockedPackage.required = ["version","resolved","integrity","realm"]` | `schemas/rarn.lock.schema.json:71` |
| `packageKey` 패턴 `^@scope/name@.+$` — `rarn.json`이 허용하는 bare 이름 멤버 거부 | `schemas/rarn.lock.schema.json:62-65` |
| `additionalProperties: false` — 새 `members` 키 불가 | `schemas/rarn.lock.schema.json:8` |
| `lockfileVersion`이 `"const": 1` | `schemas/rarn.lock.schema.json:13` |

Agent 5가 합성 URL이 실제 네트워크 요청을 일으키는 것까지 확인했다: 비운 캐시 +
`RARN_NO_NETWORK=1`에서 락파일이 **fresh 판정**을 받았는데도
`RN0130: Network access is turned off. at https://api.wally.run/v1/package-contents/acme/lib-b/0.0.0`.

**범프 방법에도 함정이 있다.** `"const": 1`을 `"const": 2`로 바꾸면 기존 v1 파일이 전부
`RN0500`으로 실패하고, 그 조언은 "삭제하고 다시 install"이다 — 워크스페이스에서는 리포
전체 해석의 유일한 기록을 지우라는 말이 된다. 최소 요구사항: `"enum": [1, 2]`
+ **내용 기반 버전 쓰기**(멤버가 있을 때만 2). 그렇지 않으면 워크스페이스를 열지도 않은
단일 프로젝트 사용자가 업그레이드만으로 팀 전체에 `RN0501` 연쇄를 일으킨다.

**freshness 스냅샷.** `checkFreshness`는 `lockfile.root`만 하나의 매니페스트에 대해
비교한다. 워크스페이스 루트 매니페스트는 자기 의존성이 없으므로 빈 맵 3개를 빈 맵 3개와
비교해 **무조건 `fresh: true`** 를 반환한다 — CLAUDE.md의 비대칭 규칙이 금지하는 느슨한
방향이다. 다만 **오늘의 결함은 아니다**(Agent 8이 옳게 반박했고 내가 확인했다):
`buildLockfile`은 받은 매니페스트 하나로 `root`를 쓰므로 Rarn이 그런 락파일을 만들 수 없다.
가설적 설계에 대한 제약으로 기록해야 하지 출하된 버그로 기록하면 안 된다.

### 3.4 멤버들이 서로 다른 major를 요구하면 — **[FACT] 실측상 발생하지 않는다. 발생하는 건 반대다**

Agent 6이 실제 Roblox monorepo 12곳에서 멤버 매니페스트 229개 / 의존 요구 554건을
모아 Rarn 자신의 `fromCargoRange`와 `semver.intersects`로 계산했다.

| 측정 | 값 |
|---|---|
| 멤버 매니페스트 | 229 |
| 멤버 → 멤버 엣지 | **312** |
| 멤버 → 레지스트리 엣지 | 242 |
| 둘 이상 멤버가 원한 외부 패키지 | 36 |
| …범위 문자열이 다른 것 | 11 |
| …**서로소(disjoint)인 쌍** | **0** |

**모든 차이 나는 쌍이 교차한다.** 워크스페이스 병합이 버전 충돌을 만들지 않는다.

한 가지 부수 사실이 중요하다: 11쌍 중 2쌍(`sleitnick/trove "1.8.0" | "1.5.1"`,
`howmanysmall/typed-promise "4.0.3" | "^4.0.6"`)은 범위 텍스트를 npm 문자 그대로 읽으면
**서로소로 보인다**. Cargo가 bare 버전을 캐럿으로 읽기 때문에만 교차한다. 워크스페이스
구현이 범위를 `fromCargoRange`에 통과시키지 않고 텍스트로 비교하면 존재하지 않는 충돌
2건을 만들어 낸다.

**실제로 발생하는 것은 §3.1의 반대 방향이다** — 독립 해석이 **호환** 버전으로 조용히
갈라진다. 그리고 그것을 잡을 진단이 전부 단일 매니페스트에 묶여 있다.

주목할 만한 두 번째 사실: 554개 엣지 중 **312개가 멤버 → 멤버**다. 실제 Roblox
monorepo에서 내부 의존성이 레지스트리 의존성보다 많다. 워크스페이스 기능이 주로
무엇을 위한 것인지에 대한 사실이고, 그건 버전 통일이 아니다.

### 3.5 [보너스] 제약 5가 단일 매니페스트 안에서도 이미 새고 있다 — **[FACT]**

Agent 6이 찾았고 Agent 8이 확인했으며 나도 실제 `selectVersions`를 직접 호출해 재현했다.
**워크스페이스와 무관한 기존 결함이다.**

```
~1.2.0 + ^1.5.0 :  groups: 1.9.0<-[^1.5.0, ~1.2.0]  | unsat: 0
reversed        :  groups: 1.9.0<-[^1.5.0, ~1.2.0]  | unsat: 0   <- 순서 독립
=1.2.0 + ^1.5.0 :  groups: 1.9.0<-[^1.5.0, 1.2.0]   | unsat: 0
ctrl ^1.2+^1.5  :  groups: 1.9.0<-[^1.2.0, ^1.5.0]  | unsat: 0   <- 대조군, 올바름

semver.satisfies("1.9.0","~1.2.0") = false
semver.intersects("~1.2.0","^1.5.0") = false        <- 교집합이 진짜로 비어 있다
```

CLAUDE.md 제약 5: *"Only report a conflict when the intersection is genuinely empty."*
교집합이 진짜로 비었는데 충돌이 보고되지 않고, 만족하지 않는 버전이 설치되며,
락파일이 위반된 범위를 그 버전 옆에 기록한다. `mergeCompatible`(`src/resolver/select.ts`)이
같은 major 그룹을 합치고 높은 쪽을 취하기 때문이다 — 캐럿에는 맞는 논거지만 `~`와
정확 핀에는 맞지 않는다. `assemble`의 유일한 검사는 *어떤 발행 버전이라도* 제약을
만족하는지 묻지, *선택된* 버전이 만족하는지 묻지 않는다.

오늘의 심각도는 제한적이다: 실제 요구 554건 중 `~` 0건, `=` 0건(CLAUDE.md 자신의
76/76 인덱스 조사와 일치). 손으로 쓴 `rarn.json`으로만 도달 가능하다. 그러나 워크스페이스에서는
멤버 B의 `^1.5.0`이 멤버 A의 핀을 소유권 경계를 넘어 조용히 override하게 된다.
**두 번째 매니페스트를 먹이기 전에 닫아야 한다.**

---

## 4. 아키텍처 영향

무엇이 어떻게 바뀌어야 하는지, 파일 경로와 스키마 필드로.

| 계층 | 오늘 | 워크스페이스가 요구하는 것 |
|---|---|---|
| **매니페스트 스키마** | `workspaces` → `RN0012 unknown field` (측정), `workspace:*` → `RN0021` (측정). `dependencyMap` 값은 `$defs/range`뿐. `propertyNames`가 `@scope/name` 요구 → bare 이름 멤버 지정 불가 | breaking change 필수. 로컬 지정자 형태가 새로 필요 |
| **락파일 스키마** | `root`가 단일 객체. `root.dependencies`는 패키지당 범위 1개인 `rangeMap`이라 합집합 흡수도 불가. `additionalProperties: false` | `members` 맵 + `lockfileVersion` `enum: [1,2]` + 내용 기반 쓰기 |
| **freshness** | `lockfile.root`만 매니페스트 하나와 비교 | 멤버 하나라도 다르면 stale, 멤버 집합이 다르면 stale, **멤버가 사라져도 stale**(제약이 빠지면 선택 버전이 올라갈 수 있다), 파싱 실패는 skip이 아니라 error |
| **리졸버** | `resolve()`가 매니페스트 하나. `collectRootEdges`가 `from: 'root'` 하드코딩 | edge 수집만 변경. **알고리즘은 그대로** — 순서 독립 교집합이 이미 정확히 필요한 계산이다. 단 `'root'` 리터럴 특수 취급 3곳(`link.ts:266`, `dedupe.ts:68`, `why.ts:101`)과 `placementOfRequester`(`resolve.ts:199`)의 `slice(1, lastIndexOf('@'))` 파싱 |
| **링커** | `sources`는 `packageKey → 디렉터리` 맵. 출처를 묻지 않음 | **새 source type 불필요**(측정됨). 단 `readTreePath`가 `$path` 외 `tree` 키를 거부하므로 place-형 프로젝트 파일 멤버는 자기 `Packages/_Index/`까지 복사되어 중복을 하나 더 만든다 |
| **`packageDir`** | 스키마 패턴 `^(?!\.{1,2}$)[A-Za-z0-9._-]+$` + `assertSafePackageDir`(구분자·`..`·절대경로 거부) | 멤버가 루트 공유 트리를 가리키는 것은 불가능. **이 가드는 유지되어야 한다** (§6.1) |
| **캐시** | `cacheKey` = `{scope}_{name}@{version}`, "레지스트리 패키지는 불변" 근거. `ensure`가 디렉터리 존재만으로 단축 | 로컬 멤버는 캐시를 **완전히 우회해야 한다.** 가변 멤버는 머신 전역 모든 프로젝트와 충돌하고 낡은 바이트를 낸다 |
| **place 스캔** | `join(projectDir, 'default.project.json')` 하나만 읽음. 라이브러리형은 `:73`에서 `EMPTY`, `:167`의 `if (!scan.scanned) return []` | 파일 목록으로 확대 필요 (§6.3) |
| **CLI** | 파이프라인 합성이 `src/cli/commands/install.ts` 한 곳. `src/cli/` 밖에서 import 0건, **`tests/`에서 import 0건** | 추출이 **선행 조건**. CLAUDE.md 레이어 표가 `cli`에 비즈니스 로직을 금지한다. 부수적으로 제품에서 유일하게 테스트 없는 부분에 첫 합성 테스트가 생긴다 |
| **read-only 명령** | `loadInstalled`(`src/cli/project.ts:27`)가 cwd에 락파일 없으면 `LockfileStale` | 루트 전용 락파일에서 멤버 디렉터리의 `list`/`why`/`dedupe`/`doctor`가 전부 실패 |
| **alias 네임스페이스** | `assertNoAliasCollisions`가 3개 realm을 합쳐 프로젝트 전역 강제 (측정: `@evaera/promise` + `@nezuo/promise` → `RN0030`) | 레이아웃이 요구하는 것보다 엄격하고 문서에 없다. 호이스팅에서는 per-tree여야 하므로 지금 기본값이 틀린 방향으로 고정 |

---

## 5. 대안

워크스페이스가 아닌 방법들. 값과 비용을 정직하게.

| # | 대안 | 스키마 변경 | 오늘 동작하나 | 무엇을 주나 | 무엇을 못 주나 |
|---|---|---|---|---|---|
| 1 | **크로스 트리 중복 진단** | **0** | 아니오 (지어야 함) | correctness 누수를 **가시화**. 워크스페이스가 작동하는지 알려 줄 유일한 물건 | 고치지는 않는다 |
| 2 | **place 스캔 확대** | **0** | 아니오 | 다중 place 리포 30곳 중 25곳, 라이브러리형 프로젝트 전부에서 꺼져 있는 경고를 켠다 | 워크스페이스가 아니다 |
| 3 | **루트 매니페스트 1개 + place 프로젝트 N개** | **0** | **예** | 다중 place 레이아웃 완전 서비스 (§5.1 측정) | 멤버별 의존성 집합 불가 |
| 4 | **`resolutions`를 수렴 도구로** | 0 | 예 | 같은 place 멤버들의 강제 수렴 | 멤버마다 반복, 갈라짐을 아무도 못 봄 |
| 5 | **생태계 우회 (사용자 측)** | 0 | 예 | 오늘 사람들이 실제로 하는 것 | 문제가 실재한다는 **증거**이지 해결이 아니다 |
| 6 | **pesde로 보내기** | 0 | 예 | monorepo가 절실한 소수는 이미 갈 곳이 있다 | Rarn이 그 공간을 비운다 |
| 7 | **Wally PR #256 기다리기** | 0 | — | 머지되면 같은 철자가 공짜, 갈라지면 상호운용성 상실 | #7이 5년, #88이 4년째 open |

### 5.1 대안 3을 직접 측정했다 — 다중 place는 이미 서비스된다

이것이 "짓지 말라"는 논거 중 가장 깨끗한 형태이고, 일곱 에이전트 중 아무도 끝까지
돌려 보지 않았다. 나는 돌렸다.

```
mp/rarn.json                             매니페스트 1개, packageDir "Packages", place 선언
mp/places/lobby/default.project.json     ../../Packages, ../../Packages_SERVER 마운트
mp/places/game/default.project.json      동일
```

`rarn install` → 4 packages, `Packages` + `Packages_SERVER`. 그다음 Rojo 7.7.0으로
각 place의 `rojo sourcemap`:

```
lobby nodes: 36   game nodes: 36
trees identical (루트 이름 제외): true

lobby.ReplicatedStorage.Packages._Index.evaera_promise@4.0.0.promise           [ModuleScript]
lobby.ServerScriptService.ServerPackages._Index.sleitnick_comm@1.0.1.Promise   [ModuleScript]
```

디스크에 설치 1개, promise 사본 1개, place당 인스턴스 1개, 그리고 크로스 realm shim
(`game.ReplicatedStorage.Packages._Index[...]`)이 **양쪽에서 유효**하다 — 두 place가
shared realm을 같은 DataModel 경로에 마운트하기 때문이다.

**워크스페이스 기능 없음, 스키마 변경 없음, 링커 변경 없음, 새 의존성 source type 없음.**

마찰점은 하나뿐이고 나도 측정했다: 선언된 `place`를 빼면 `RN0031`로 실패한다.
`scanPlaceProject`가 `<projectDir>/default.project.json` 하나만 읽는데 다중 place
리포에는 거기에 파일이 없기 때문이다. 사용자에게는 `place` 블록 한 번 손으로 쓰는
비용이고, 에러는 명확하며 실행 가능하다. **대안 2가 이것을 없앤다** — 3줄짜리 변경이지
워크스페이스가 아니다.

Agent 2가 측정한 것이 이를 뒷받침한다: 의존성 디렉터리를 마운트하는 다중 place 리포
**12곳 중 12곳**이 모든 place에서 **동일한 DataModel 경로**에 마운트한다.
PLAN.md R2의 반대 논거("멤버마다 동기화되는 place가 다를 수 있다")는 관측 사례가 **0건**이다.

---

## 6. M15 결정 — 그리고 무엇이 이걸 뒤집었을까

## **결정: REDUCE_SCOPE**

### 6.1 선행 차단 요소 — 이것들이 서 있는 한 워크스페이스는 지을 수도 검증할 수도 없다

#### 차단 1 — 인스톨러가 기능의 이름이 된 디렉터리를 지운다 (데이터 손실, 0.1.0에 출하됨)

Agent 4가 찾았고 Agent 8이 더 도달 가능함을 보였다. **나는 문서화된 워크플로 전체를 통해
재현했다.**

```
$ rarn import        # "packageDir": "Packages" 를 쓴다 (src/import/wally.ts:15)
$ ls
packages  rarn.json  wally.toml
$ rarn install
nothing to install
$ ls
rarn.json  rarn.lock  wally.toml
$ test -f packages/core/src/init.luau
*** DELETED ***
```

문서화된 명령 두 개, 플래그 없음, 손으로 편집한 것 없음, 그리고 사용자의 `packages/`
트리 전체가 성공 메시지와 함께 사라진다. **출하된 `dist/rarn-windows-x64.exe`
(자기 보고 `0.1.0`)에서도 재현했고, `git diff --stat v0.1.0 HEAD -- src/ schemas/`는
공백이므로 이건 출하된 동작이다.** 그리고 **의존성이 0개여도 발동한다**(위 재현은
빈 `[dependencies]`다).

메커니즘: `swapIn`(`src/linker/swap.ts`)이 `pathExists(<proj>/Packages)`를 부르는데,
`pathExists`는 `fs.access`이고(`src/util/fs.ts`) NTFS와 기본 APFS에서는 `packages/`만
있어도 참이다. `moveAside`가 사용자 디렉터리를 `.rarn-old-<token>/shared`로 rename하고,
마지막 `rm(retiredRoot, {recursive:true, force:true})`가 지운다 — 아무것도 rename-in
되지 않았더라도.

`assertSafePackageDir`(`src/linker/layout.ts:45`)의 주석은 설치가 "Rarn 자신의
디렉터리만" 지울 수 있다고 길게 설명한다. 실제 보장은 "프로젝트 안의 단일 디렉터리
*이름*만"이고, Windows와 macOS에서 그건 그 이름의 모든 대소문자 변형을 포함한다.
어떤 테스트도 여기 도달하지 못한다: 대소문자 무시 파일시스템 **그리고** 충돌하는
디렉터리가 둘 다 필요한데, 어떤 테스트도 후자를 만들지 않고 CI의 `check` 잡은
ubuntu와 windows에서 돈다.

> **PLAN.md M15 스케치는 `workspaces: ["packages/*"]`를 제안한다.** `rarn import`가
> 쓰는 `packageDir`은 `Packages`다. Windows와 기본 macOS에서 그 둘은 같은 경로다.
> 즉 이건 엣지 케이스가 아니라 Wally에서 마이그레이션하는 모든 사용자의 **기본 설정**이다.

이건 일정 문제가 아니라 "멈추고 먼저 고쳐라" 문제다.

#### 차단 2 — 하니스가 모든 후보 설계의 shim 형태를 검증하지 못하고, 정상을 실패로 보고한다

Agent 3이 찾았다. **나는 실제 설치를 짓고 직접 돌렸다.**

모든 후보 워크스페이스 설계 — Agent 1의 정의 A/B, Agent 3의 "호이스트 + 멤버별 shim 폴더",
Agent 4의 ABSOLUTE-PATH SHIM, Agent 6의 "호이스트된 `_Index`를 가리키는 멤버별 최상위
shim 폴더" — 가 절대 DataModel 경로를 명명하는 shim으로 호이스트된 저장소에 도달한다.
Agent 3의 표현: *"the mechanism a workspace needs already exists as `crossRealmShim`."*

```
shim 본문:  return require(game.ReplicatedStorage.Packages._Index["evaera_promise@4.0.0"]["promise"])

$ lune run tests/roblox/verify.luau -- <dir>/Packages_SERVER Packages_SERVER
  FAIL  _Index["sleitnick_comm@1.0.1"].Promise resolves
          [string "luau.load(...)"]:2: attempt to index nil with '_Index'
  7/8 checks passed

$ lune run tests/roblox/verify.luau -- <dir>/Packages     # 대조군, 크로스 realm shim 없음
  3/3 checks passed
```

shim은 **정확하다** — CLAUDE.md가 문서화한 형태 그대로다. `game` 스텁
(`tests/roblox/verify.luau:65-70`)이 `{Name = key}`를 반환하므로 `game.ReplicatedStorage`가
맨 테이블이고 `.Packages`가 `nil`이다. 두 가지가 이걸 악화시킨다:

- `tests/roblox/emulate.luau:213`이 shim을 **매 실행마다** 실행하므로 `--execute` 없이도
  스텁에 도달한다 — 두 줄 위 주석이 정반대로 말하고 있다.
- `tests/roblox-harness.test.ts:47`이 항상 디렉터리 하나와 realm 이름 없이 호출하므로
  **CI가 이 경로를 본 적이 없다.**

CLAUDE.md는 이 하니스를 *"한 공유 패키지와 그 사본 두 개를 구별할 수 있는 유일한 테스트"*
라고 부른다. 워크스페이스가 딛고 설 유일한 shim 형태를 검증하지 못하고, 시도하면 거짓
음성을 낸다. **제품의 가장 어려운 부분을 검증 장치를 끈 채로 짓는 것**이 된다.
이건 순서에 관한 논거이고, "지금은 아니다"에 대해서는 결정적이다.

#### 차단 3 — 정규 멤버 형태의 설치 출력이 조용히 Rojo에 도달하지 못한다

Agent 1이 찾았다. **나는 재현했다.**

정규 워크스페이스 멤버는 발행 가능한 패키지이고, 그 `default.project.json`은
`{"tree": {"$path": "src"}}` — CLAUDE.md 제약 3이 통째로 다루는 그 형태다.

```
$ rarn install
installed 1 packages into RARN_MODULE
  2 files, 1 links, 338 pruned          <- 경고 한 줄 없음

$ rojo sourcemap default.project.json
{"name":"mylib","className":"ModuleScript","filePaths":["src/init.luau","default.project.json"]}
                                        <- RARN_MODULE/ 의 아무것도 마운트되지 않음
```

`src/project/place.ts:73`이 이 형태에 대해 `EMPTY`(`scanned: false`)로 단락하고,
`unmountedRealms`(`:167`)가 `if (!scan.scanned) return []`로 시작한다. 단락을 정당화하는
코드 주석은 *walk*에 대해 옳고 *warning*에 대해 침묵한다.

CLAUDE.md §2a는 약속한다: *"A realm directory the project file does not mount is a warning,
not an error."* place-형 프로젝트 파일에 대해서는 그 약속이 지켜진다. 라이브러리형 —
Agent 1이 조사한 7개 monorepo 전부의 모든 멤버가 쓰는 형태 — 에 대해서는 동일한 실패가
완전히 침묵한다. **워크스페이스 기능은 지금 드문 경우를 모든 멤버의 기본 형태로 만든다.**

#### 차단 4 — 제약 5가 이미 단일 매니페스트 안에서 위반된다

§3.5. 두 번째 매니페스트를 먹이기 전에 닫아야 한다. `assemble`에 그룹별
`semver.satisfies(chosen, constraint.range)` 단언 하나면 닫힌다.

### 6.2 왜 BUILD가 아닌가

PLAN.md M15 스케치의 전제 — *"제약 1의 논리상 [`_Index` 호이스팅이] 하나가 맞다,
dedupe가 워크스페이스 전체로 확장"* — 는 npm의 프레임이고 테스트를 통과하지 못했다(§3.1).
그리고 §6.1의 네 차단 요소가 오늘 존재한다. 전부 내가 직접 재현했다.

여기에 하나 더: **Rarn 사용자 중 한 리포에 `rarn.json`을 둘 이상 둔 사람의 실측 수는 0이다.**
0.1.0이 오늘 출하되었고 별 0개, 포크 0개, 자산 다운로드 총 4건이다. 이 보고서의 모든
monorepo 숫자는 npm·pnpm·Yarn·Rotriever·Wally-without-Rarn 위의 **다른 사람들의 리포**에
관한 것이다.

### 6.3 왜 DO_NOT_BUILD가 아닌가

**R1의 선례가 권위로 이전되지 않는다.** `docs/research/r1-pnp-feasibility.md`는 **플랫폼 불가능성**
위에 서 있었다 — *"Roblox에는 파일시스템이 없다"*, `require`가 Instance만 받음,
`.luaurc` alias 맵 없음. 우회로가 없는 하드 블록이다. 여기에는 그런 블록이 없다:
pesde가 Luau용 워크스페이스를 출하했고, Roblox 자신의 Rotriever가 `[workspace] members`와
`{ path = "../sibling" }`을 출하했으며, Wally PR #256이 살아 있다.
**증거에서 정직하게 나오는 판정은 "불가능"이 아니라 "필요성이 입증되지 않음"이고,
그것은 훨씬 약한 진술이다.**

**재현 가능한 correctness 누수가 있다.** §3.1. 그리고 이것은 npm의 편의 기능을 수입하는
문제가 아니라 **Rarn 자신의 제약 5가 모델하지 않는 경계에서 새는 것**이다. 누구에게
monorepo가 몇 개나 있는지와 무관하게, *누군가* 한 리포에 `rarn.json` 두 개를 두기만 하면
발생한다 — 레지스트리 엣지의 46%가 scope 내부인 레지스트리를 위한 패키지 매니저라면
예상해야 할 일이다.

**수요 신호가 측정되어 있고 한쪽으로만 쏠려 있다.** 내가 직접 확인한 수치:

| 측정 | 값 |
|---|---|
| Wally 이슈 중 monorepo / workspace / path dependencies 언급 | **12** |
| Wally 이슈 중 multi-place 언급 | **0** |
| #7 "Path dependencies" | 2021-03-15 부터 **open** |
| #88 "Add Path Dependencies" (PR) | 2022-06-15 부터 **open** |
| #153 "Monorepos and small dependencies are awkward!" | 2023-06-13 부터 **open** |
| #256 "[WIP] Add monorepo support" (PR) | 2026-04-02 부터 **open** |
| `"[workspace]" filename:wally.toml` | **0** — 기능 자체가 없다 |
| 레지스트리 의존성 엣지 중 같은 scope 내부 | **46.0%** (2,671 / 5,810) |
| ≥10개 패키지를 내는 scope | 128개(8.6%)가 레지스트리의 **44.3%**를 보유 |

대조군(place 쪽): `path:places` 41건 대 place를 짓는 프로젝트 파일 3,968건(~1%),
발견된 모든 다중 place 리포의 별 상한 16개, 이슈 0건, 그리고 §5.1에서 이미 동작함.

**발행된 Wally 버전은 영구적이다.** Wally 메인테이너 `magnalite`가 #153에서:
*"If you want to update a package which would otherwise just exist in your codebase you have
to swap editor/git contexts, make the change, publish and then install back into the main
codebase."* monorepo 멤버를 한 번 시험할 때마다 되돌릴 수 없는 버전 번호가 하나씩 탄다.
`resolutions`도 루트 매니페스트도 이걸 건드리지 않는다. **편의 격차가 아니라, 시험 결과를
얻기 위해 도구가 되돌릴 수 없는 행동을 강요하는 것이다.**

**우회책은 문제가 해결되었다는 증거가 아니라 실재한다는 증거다.** RbxUtil의 10개짜리
Python 툴체인(멤버마다 `wally install` 후 `Packages/*`를 한 단계 위로 올림 — 25개 멤버 중
11개가 `evaera/promise`를 선언하므로 한 DataModel에 최대 11개 사본), Flow의 발행되지 않는
가짜 루트 패키지 `jsdotlua/no-op`(주석: *"This config exists so we can import the
dependencies of all packages"*), charm의 손으로 쓴 한 줄 shim + `wally.toml` `exclude`,
jest-roblox가 같은 그래프를 `rotriever.toml`과 34개 `wally.toml`에 두 번 유지하는 것,
Nevermore가 Node의 walk-up 리졸버를 Luau로 재구현한 것. **아무도 재미로 이런 걸 짓지 않는다.**

### 6.4 REDUCE_SCOPE가 구체적으로 뜻하는 것

| 단계 | 무엇 | 스키마 변경 | 왜 지금 |
|---|---|---|---|
| **1** | 데이터 손실 수정 (`assertSafePackageDir`에 대소문자 무시 충돌 검사, 또는 `swapIn`이 자기가 만든 것만 지우도록) | 0 | 0.1.0에 출하됨. M15 스케치가 이것을 기본 설정으로 만든다 |
| **2** | 하니스 `game` 스텁 수정 + `roblox-harness.test.ts`가 크로스 realm 케이스를 돌리도록 | 0 | 이게 없으면 워크스페이스를 검증할 수 없다 |
| **3** | 라이브러리형 프로젝트 파일에서도 unmounted-realm 경고 (`place.ts:73`/`:167`) + place 스캔 확대 (대안 2) | 0 | 워크스페이스가 이 실패를 기본값으로 만든다 |
| **4** | `assemble`에 그룹별 `satisfies` 단언 (§3.5) | 0 | 두 번째 매니페스트를 먹이기 전에 |
| **5** | **크로스 트리 중복 진단** (대안 1) | **0** | correctness 누수를 가시화. 워크스페이스가 작동하는지 알려 줄 유일한 계측기 |
| **6** | 파이프라인을 `cli/`에서 추출 | 0 | 워크스페이스 드라이버의 선행 조건. 부수적으로 첫 합성 테스트 |
| **7** | *(조건부)* 패키지 지향 워크스페이스 | breaking | 둘 이상의 `rarn.json`을 둔 실제 Rarn 사용자가 나타난 뒤 |

**place 지향 워크스페이스는 짓지 않는다.** §5.1에서 측정했듯 이미 서비스되고 있다.

1–6은 전부 워크스페이스가 아니고, 전부 M15와 무관하게 값이 있으며, 하나라도 서 있는 한
워크스페이스는 올바르게 지어질 수도 검증될 수도 없다. **그리고 5번이 7번을 열지 말지를
판정할 계측기다** — 오늘 Rarn은 React 두 개짜리 place를 만들고 초록색 요약을 찍으며
`dedupe`는 "정확히 한 버전"이라고 말하고 하니스는 두 번 통과한다.

이것은 R1의 답이 취한 것과 같은 모양이다 — R1의 결론을 빌리지 않고서.

### 6.5 무엇이 이 결정을 뒤집었을까

| 방향 | 필요했을 증거 | 실제 |
|---|---|---|
| **BUILD** | 차단 요소 4개가 이미 고쳐져 있고, **동시에** 둘 이상의 `rarn.json`을 둔 실제 Rarn 사용자가 한 명이라도 있을 것 | 넷 다 서 있다. 후자는 0 |
| **DO_NOT_BUILD** | 호환 중복 누수가 재현되지 않을 것 | 재현됨 (3.2.0 + 3.2.1, `dedupe`가 양쪽에서 "no duplicates") |
| **DO_NOT_BUILD** | 수요 신호가 반대로 나올 것 | 12 대 0으로 한쪽 |
| **DO_NOT_BUILD** | 플랫폼이 금지할 것 (R1의 논거 구조) | pesde와 Rotriever가 Luau용으로 출하함 |
| **place 지향으로 확대** | Agent 2의 "다중 place ~1%" 카운트가 틀릴 것 | 여섯 개 카운트를 전부 정확히 재현. 다만 Agent 8의 `path:modules` = 140은 프로브 집합이 **monorepo 쪽을 과소 계상**함을 보인다 — 오차가 짓는 쪽에 유리하다 |

---

## 7. 신뢰도 · 남은 미지수 · 가장 중요한 가정

### 7.1 신뢰도: 80%

높은 이유: 결정에 실린 모든 사실을 내가 직접 재현했다 — 데이터 손실(출하 바이너리 포함),
호환 중복(rojo sourcemap 포함), `mergeCompatible` 위젠(실제 `selectVersions` 호출),
하니스 거짓 실패(대조군 포함), 라이브러리형 침묵, 다중 place가 이미 동작함(36노드 동일 트리),
수요 신호(12 대 0), 코드검색 카운트 6개, 락파일 차단(소스 읽기), 릴리스 노출(0/0/4),
placement 위젠, alias 네임스페이스.

낮은 이유: 모집단 질문이 Rarn에 대해서는 진짜로 미지다. 그리고 Windows 11 / NTFS
단일 플랫폼 측정이다.

### 7.2 에이전트 간 불일치와 어느 쪽 증거가 강한가

| 불일치 | 판정 |
|---|---|
| Agent 1 "두 모집단이 비슷한 규모" vs Agent 2 "다중 place는 ~1%" | **Agent 2 + Agent 8이 이긴다.** 카운트가 단단하다(41 대 3,968). Agent 1의 "비슷한 규모"는 코드검색 한 페이지씩이었다. 나는 여섯 카운트를 전부 재현했다 |
| PLAN.md R2 전제 vs Agent 3/6/8 | **Agent 3/6/8이 이긴다.** 셋이 독립적으로 도달했고 나는 양쪽을 측정했다. 제약 1의 범위는 DataModel이다 |
| Agent 1 "멤버가 다른 place로 가는 것이 어려운 경우" vs Agent 2 측정 | **Agent 2가 이긴다.** 12/12가 동일 경로에 마운트하고, 나는 그 경우가 그냥 동작함을 확인했다 |
| Agent 4 "데이터 손실은 멤버가 있어야 발동" vs Agent 8 "빈 해석에서도 발동" | **Agent 8이 이긴다.** 나는 더 나아가 `rarn import`를 통해, 출하 바이너리로 재현했다 |
| Agent 5 "freshness가 지금 조용히 깨져 있다" vs Agent 8 반박 | **Agent 8이 이긴다.** `buildLockfile`이 그런 락파일을 만들 수 없으므로 가설적 설계의 제약이지 출하된 결함이 아니다 |
| Agent 6 "병합이 충돌을 만들지 않는다" vs Agent 7 "호환 드리프트 누수" | **모순이 아니라 상보적이다.** 둘 다 성립한다: 병합은 *버전* 충돌을 만들지 않고, 독립 해석이 *중복*을 만든다 |

### 7.3 FACT로 라벨되었지만 실은 INFERENCE인 것

- **Agent 2 "다중 place는 생태계의 약 1%"** — 카운트는 FACT(재현함). "생태계의 1%"는
  GitHub 코드검색이 대표성을 갖고 프로브 집합이 완전하다는 데 기대는 INFERENCE.
  Agent 2 자신이 UNKNOWN에 적어 두고 요약에서 확정으로 쓴다. 그리고 프로브 집합은
  **증명 가능하게 불완전**하다(`path:modules` = 140).
- **Agent 2 "전부 별 16개 이하의 취미 프로젝트"** — 별 수는 FACT, "취미 프로젝트"는 판단.
  범위가 공개 GitHub인데 Agent 2 자신이 그것으로 답할 수 없다고 적었다.
- **Agent 3 "dedupe의 올바른 단위는 리포가 아니라 place"** — 뒤의 3멤버/2place 측정은
  FACT, 규범적 "올바른 단위"는 결론. 사소하지만 확정으로 인용되기 쉬운 프레이밍.

### 7.4 남은 미지수 (조건부로만 말할 수 있는 것)

1. **Rarn 사용자 중 한 리포에 `rarn.json`을 둘 이상 둔 사람이 있는가.** 여러 보고서가
   "필요하다는 증거 없음"과 "필요 없다는 증거"를 뒤섞는다. 지금 성립하는 것은 전자뿐이다.
   → 시간, 또는 초기 채택자와의 직접 접촉.
2. **두 멤버 중복이 실제 Studio에서 모델대로 행동하는가.** CLAUDE.md가 단일 프로젝트
   사례를 한 번 확인했고 Roblox 공식 문서가 독립적으로 뒷받침하지만, 이번 조사 중
   Studio가 연결되어 있지 않았다. → 2멤버 place를 `rojo build`하고 한쪽을 변형해 비교.
3. **46.0%가 실제 단일 git 리포에 대응하는가.** scope는 네임스페이스다.
   `package.repository`는 10.1%에만 설정되어 있다. → 대형 scope의 패키지를 GitHub 리포로 해소.
4. **코드검색이 대표성을 갖는가.** `path:modules` = 140이 프로브 집합의 과소 계상을 증명한다 —
   짓는 쪽에 유리한 방향의 오차. → 검색이 아니라 크롤.
5. **Wally PR #256이 머지되는가.** → 지켜보기.
6. **호이스트된 저장소가 Knit의 `Util` 공개 API와 더 깊은 `Parent` walk를 견디는가.**
   Agent 3이 knit+comm+promise 사례가 살아남음을 측정했다. 더 넓은 표본은 아무도 안 봤다.
   → `doctor` 스캐너를 넓은 표본에 — 단 하니스가 고쳐지기 전엔 검증 불가.
7. **`packageDir` 대소문자 삭제가 macOS에서도 발동하는가.** 메커니즘상 발동해야 하지만
   내 측정은 전부 Windows/NTFS다. Linux는 대소문자 구분이라 CI의 ubuntu 레그가
   구조적으로 볼 수 없다. → macOS 러너.
8. **멤버의 module root 규칙이 `main` 같은 필드를 읽어야 하는가.** react-lua 멤버들은
   `"main": "src/init.luau"`를 선언한다. → 측정이 아니라 정책 결정.

### 7.5 가장 중요한 가정

> **"둘 이상의 `rarn.json`을 한 리포에 두는 Rarn 사용자가 언젠가 생긴다."**

이 조사의 모든 correctness 논거 — 호환 중복 누수, `dedupe`의 거짓 무결 보고,
한 DataModel의 두 React — 는 그 상황이 실제로 발생할 때만 값을 갖는다. 오늘 그
실측 발생 횟수는 0이다.

가정이 틀리면(Rarn이 단일 프로젝트 도구로만 쓰이면) REDUCE_SCOPE는 사실상
DO_NOT_BUILD가 되고 남는 것은 §6.4의 1–4단계뿐이다 — 그런데 그 넷은 워크스페이스와
무관하게 값이 있으므로 **결정 자체는 여전히 옳다.**

가정이 맞으면 5단계(크로스 트리 중복 진단)가 곧바로 값을 내고 7단계를 열 근거가 생긴다.

즉 이 가정은 결정의 **방향**이 아니라 **속도**를 지배한다. 그것이 지금 REDUCE_SCOPE를
고른 이유이기도 하다 — 가정이 판명되기를 기다리는 동안 지어야 할 것이 이미 넷 있고,
**그 넷 중 하나가 가정을 판명할 계측기다.**

---

## 부록 A — CLAUDE.md 자체에 대한 발견

조사 중 문서와 구현이 갈라지는 지점들. 전부 내가 확인했다.

| # | DOCUMENTED | IMPLEMENTED | DIFFERENCE |
|---|---|---|---|
| 1 | §2a: *"A realm directory the project file does not mount is a warning, not an error."* | `place.ts:73`이 라이브러리형에서 `EMPTY`(`scanned:false`)로 단락하고 `:167`이 `if (!scan.scanned) return []` | 경고는 place-형 프로젝트 파일만 커버한다. 라이브러리형 — 모든 발행 가능 패키지와 모든 라이브러리 워크스페이스 멤버의 형태 — 에서는 동일한 실패가 완전히 침묵 |
| 2 | `layout.ts` `assertSafePackageDir` 주석: 설치는 "Rarn 자신의 디렉터리만" 지운다 | 빈 문자열·프로젝트 루트·`..`·구분자만 검사. 대소문자 변형 충돌은 통과 | 실제 보장은 "프로젝트 안의 단일 디렉터리 *이름*만"이고 Windows/macOS에서 그건 모든 대소문자 변형을 포함한다 |
| 3 | `verify.luau:65-70` 주석: *"Only reached with --execute"* | `emulate.luau:213`이 shim을 항상 실행하므로 매 실행마다 도달 | 크로스 realm shim이 있으면 `--execute` 없이도 거짓 실패. CI는 `roblox-harness.test.ts:47`이 디렉터리 하나만 넘기므로 본 적 없음 |
| 4 | 제약 5: *"Only report a conflict when the intersection is genuinely empty"* | `mergeCompatible`이 같은 major 그룹을 합쳐 높은 쪽을 취함 | 교집합이 진짜로 빈 `~1.2.0` + `^1.5.0`이 충돌 없이 1.9.0으로 해석되고, 락파일이 위반된 범위를 그 버전 옆에 기록 |
| 5 | 제약 1: *"There is also no resolution algorithm — no walking up directories looking for `node_modules`"* | 엔진에 대해서는 참. Quenty/NevermoreEngine이 `iterNodeModulesUp`을 Luau로 구현해 283개 멤버가 사용 | 반 문장 단서가 필요: *"엔진은 제공하지 않고, 직접 지은 리졸버는 패키지 저자가 opt-in 해야 한다"* — 후자가 Rarn에서 쓸 수 없는 진짜 이유다 |
| 6 | §Naming: alias 충돌은 하드 에러 | `assertNoAliasCollisions`가 3개 realm을 합쳐 프로젝트 전역 강제 (측정: `RN0030`) | 두 파일이 서로 다른 디렉터리에 있어 디스크에서 충돌할 수 없는데도 거부. 레이아웃이 요구하는 것보다 엄격하고 문서에 없다 |
| 7 | 아키텍처 표: `cli`는 비즈니스 로직을 담지 않는다. "테스트할 가치가 있는 것은 CLI 없이 도달 가능해야 한다" | 파이프라인 합성이 `src/cli/commands/install.ts` 한 곳에만. `tests/` 어디서도 import 0건 | 제품에서 유일하게 직접 테스트가 없는 부분이 워크스페이스 드라이버가 N번 호출해야 할 바로 그것 |
| 8 | §Schemas: *"rarn.lock is written with sorted keys"* | 맵만 정렬된다. 고정 형태 객체는 선언 순서. `packages`는 codepoint, 레코드는 `localeCompare` — 비교자 둘이 한 writer 안에 | 진짜 속성은 정렬이 아니라 **구성 순서에 의한 결정성**이다. 더 낫지만 파일에 적힌 것과 다르다 |
| 9 | — | `### 2a-2. The shim files are observable API` 절이 246-265행과 267-286행에 **축자 중복**. "Three things a 13-package survey" 문단이 355-362행과 364-371행에 중복 | 무해하지만 이 파일은 프로젝트의 1차 추론 산출물이다 |

## 부록 B — 이번 조사에서 직접 재현한 것

| 주장 | 출처 | 판정 |
|---|---|---|
| `rarn import` → `rarn install`이 `packages/`를 삭제 | A4, A8 | **확인**, 출하 0.1.0 바이너리 + 의존성 0개 + 문서화된 워크플로 전체 |
| `mergeCompatible`이 빈 교집합을 위젠 | A6, A8 | **확인**, 실제 `selectVersions`, 순서 독립, 대조군 정상 |
| 두 멤버 → 한 DataModel에 호환 버전 2개 | A7, A1, A3, A8 | **확인**, 3.2.0 + 3.2.1, `dedupe` 양쪽 "no duplicates", sourcemap 2개 인스턴스 |
| 루트 매니페스트 하나가 다중 place를 서비스 | A8 | **확인**, 36노드 동일 트리, 크로스 realm shim 양쪽 유효 |
| 라이브러리형 프로젝트 파일 침묵 | A1, A8 | **확인**, install 성공, rojo가 아무것도 마운트 안 함, 경고 0 |
| Lune 하니스가 정상 크로스 realm shim을 실패로 보고 | A3, A8 | **확인**, 7/8, 대조군 3/3 |
| Wally 수요 12 대 0 | A2, A7, A8 | **확인**, 이슈 4건 전부 open |
| 코드검색 모집단 카운트 6개 | A2, A8 | **확인**, 6/6 정확히 재현 (`path:modules` = 140 포함) |
| 락파일이 로컬 멤버를 막는다 | A4, A5 | **확인**, 소스 읽기 |
| 릴리스 노출 0 star / 4 download | A5, A8 | **확인** |
| placement가 server→shared로 위젠 | A6, A8 | **확인**, server-declared promise가 복제 realm에 착지 |
| alias 네임스페이스가 프로젝트 전역 | A1, A8 | **확인**, `RN0030` |

재실행하지 않고 다른 에이전트에 의존한 것: Rojo 심링크/junction 측정(세 에이전트 일치,
모순 없음, upstream 이슈 2건이 뒷받침), pesde·Rotriever 소스 읽기, 개별 리포 조사
(charm / react-lua / RbxUtil / Nevermore), Wally 인덱스 전수 조사(Agent 7 계산,
Agent 8이 자기 버그를 잡아 가며 독립 재현 — 독립 반증 시도를 견딘 센서스는 그냥 보고된
것보다 값이 크다).

**저장소는 변경되지 않았다.** `git status --porcelain` 공백, HEAD `7061a60`.
모든 실험은 `%TEMP%/a9/` 아래에서 수행하고 삭제했다.
