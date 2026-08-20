# PnP 가능성 연구

> **결론: PnP식 해석 간접화는 도입하지 않는다.**
>
> 원리적으로 막힌 부분이 절반이고, 나머지 절반은 기술적으로 가능해졌지만 **얻는 게 측정해보니
> 거의 없고 깨뜨리는 게 크다.** 다만 재검토 조건이 명확해서 그걸 기록해 둔다.
>
> 조사일: 2026-08-20. 표본: 실제 Wally 패키지 13개, require 호출 440건(설치 대상 기준).

---

## 0. 요약

| 질문 | 답 |
|---|---|
| Yarn PnP를 Roblox에 그대로 가져올 수 있나 | **아니오.** 핵심 기둥 하나가 플랫폼상 불가능 |
| 부분적으로라도 가능한가 | **기술적으로는 가능해졌다** (2026-01 `@game/` 도입) |
| 그럼 해야 하나 | **아니오.** 이득이 측정 결과 미미하고 인기 패키지를 깨뜨린다 |
| 언제 다시 볼까 | Roblox가 `.luaurc` **alias 맵**을 지원하면 |
| 지금 가져올 절반은 | 아래 5절 — 3가지 |

---

## 1. PnP를 분해하면

Yarn Berry의 PnP는 세 기둥이다.

| # | 기둥 | Yarn에서 하는 일 |
|---|---|---|
| 1 | **해석 간접화** | `.pnp.cjs`가 (패키지, 요청자) → 위치를 매핑. Node의 `Module._resolveFilename`을 후킹 |
| 2 | **아카이브 저장** | 패키지를 zip인 채로 두고 가상 FS(`zipfs`)로 읽음. 설치 시 복사가 0 |
| 3 | **엄격성** | 선언 안 한 의존성을 require하면 실패 |

Yarn이 얻는 속도의 대부분은 **2번**에서 나온다. 1번은 그걸 가능케 하는 수단이다.

---

## 2. 기둥 2 — 원리적으로 불가능

Roblox에는 **파일시스템이 없다.** `require`는 이미 DataModel에 존재하는 `ModuleScript`
**Instance**만 받는다. "요청이 올 때 아카이브에서 꺼내 만든다"가 성립하지 않는다.

- 가상 FS를 끼울 자리가 없다
- Instance는 `require` 이전에 이미 트리에 있어야 한다
- 따라서 **설치 시 복사를 없앨 방법이 없다**

> Yarn PnP가 파는 가치의 절반은 여기서 끝난다. 이 부분은 우회로가 없고, 앞으로도 생길
> 가능성이 낮다. Roblox의 실행 모델 자체가 다르다.

---

## 3. 기둥 1 — 2026년 1월에 기술적으로 열렸다

### Require-by-String은 이미 라이브다

[Introducing Require-by-String](https://devforum.roblox.com/t/introducing-require-by-string/3405078)
(2025-01-22 발표, 플랫폼 전체 적용):

| 문법 | 의미 | 상태 |
|---|---|---|
| `require("./Sibling")` | 형제 | O |
| `require("../X")`, `../../X` | 부모의 형제 (점 2개까지) | O |
| `require("@self/Child")` | 직계 자식 | O |
| `require("@game/ReplicatedStorage/X")` | **DataModel 루트부터 절대 경로** | O (2026-01-08 추가) |
| `require("@myalias/X")` | **커스텀 alias** | **X — 미지원** |

### 그런데 alias 맵이 없다

[Luau RFC](https://rfcs.luau.org/require-by-string-aliases.html)가 명시한다:

> "providing support for alias maps within the Roblox engine is out of the scope of this RFC
> **but is being considered internally**"

`.luaurc`의 `aliases`가 곧 PnP의 `.pnp.cjs`에 해당한다. **그게 없으면 네이티브 간접화는 없다.**

### 그럼에도 길은 있다 — `@game/` 를 쓴 런타임 모듈

`@game/`이 생겼으므로 이런 게 가능해졌다:

```lua
-- 설치 시점에 패키지 소스를 이렇게 재작성
local rarn = require("@game/ReplicatedStorage/RARN_MODULE/_Runtime")
local Promise = rarn("sleitnick_knit@1.7.0", "Promise")
```

`_Runtime`이 (요청자, 별칭) → ModuleScript 매핑을 들고 있으면 이게 곧 `.pnp.cjs`다.
**2026년 1월 이전에는 이것조차 불가능했다.**

---

## 4. 그런데 하면 안 된다 — 측정 결과

### 4-1. 이득이 거의 없다 (가설이 틀렸다)

연구 시작 시 내 가설은 "shim 파일이 폭발한다"였다. `N + N×M`개가 생기니 30개 패키지면
90개쯤 될 거라고 봤다. **실측하니 틀렸다.**

실제 레지스트리 그래프를 걸어서 센 결과:

| 시나리오 | 패키지 | shim 파일 | 총 인스턴스 |
|---|---|---|---|
| promise 하나 | 1 | 1 | 3 |
| knit 프레임워크 | 5 | 6 | 16 |
| knit + roact + rodux | 7 | 8 | 22 |
| 위 + 유틸 6종 | 12 | **19** | 43 |

**큰 프로젝트도 shim 19개다.** 90개가 아니라.

이유는 Roblox 생태계의 의존성 그래프가 npm보다 훨씬 **얕기** 때문이다. knit 전체 그래프를
펼쳐도 이렇다:

```
sleitnick/knit@1.7.0    deps: Comm, Promise
sleitnick/comm@1.0.1    deps: Option, Promise, Signal
evaera/promise@4.0.0    deps: (없음)
sleitnick/option@1.0.5  deps: (없음)
sleitnick/signal@2.0.3  deps: (없음)
```

5개 중 3개가 의존성 0개다. **한 줄짜리 파일 19개를 없애자고 전체 설계를 바꿀 이유가 없다.**

### 4-2. Knit이 깨진다 — 그것도 두 겹으로

`sleitnick/knit`의 실제 코드:

```lua
--[=[
    @prop Util Folder
    @within KnitClient
    @readonly
    References the Util folder. ...
]=]
KnitClient.Util = (script.Parent :: Instance).Parent

local Promise = require(KnitClient.Util.Promise)
local Comm = require(KnitClient.Util.Comm)
```

**첫째, 정적 재작성이 불가능하다.** 소스에 `require(script.Parent.Parent.Promise)`가
없다. 의존성 폴더를 변수에 담아두고 그 변수를 통해 부른다. 정규식은 물론이고
제대로 된 데이터플로 분석 없이는 못 따라간다.

**둘째, 더 나쁜 게 있다.** `Util`은 `@prop`으로 문서화된 **공개 API**다. `_Index` 폴더가
Instance 그대로 노출된다. 사용자 코드가 `Knit.Util.Signal`을 쓸 수 있다는 뜻이고,
실제로 그렇게 쓰는 코드가 있다.

> 즉 **`_Index` 폴더에 물리적 shim 파일이 존재한다는 사실 자체가 관측 가능한 API 표면**이다.
> PnP식으로 shim을 없애면 `Knit.Util.X`가 `nil`이 된다. 재작성으로 고칠 수 있는 종류의
> 문제가 아니다 — 사용자 코드까지 고쳐야 한다.

### 4-3. 동적 require 비율

설치 대상 코드 440건 기준:

| 패턴 | 건수 | 비율 |
|---|---|---|
| 정적 (`script.X`, `game.X`, 문자열) | 420 | 95.5% |
| **동적 (변수 경유)** | **20** | **4.5%** |

4.5%는 얼핏 작아 보이지만 대부분이 문서 주석 예제(`somewhere.MyComponent`)고,
**진짜 동적은 knit에 몰려 있다.** 하필 가장 인기 있는 프레임워크다.

그리고 `require(v)` 형태 — `GetChildren()` 루프에서 사용자 모듈을 로드하는 코드 — 도 있다.
이건 의존성이 아니라 사용자 코드라 재작성 대상은 아니지만, "정적으로 다 잡을 수 있다"는
가정이 성립하지 않음을 보여준다.

### 4-4. 그 밖의 비용

| 항목 | 문제 |
|---|---|
| Wally 호환 상실 | Rarn ↔ Wally 전환이 불가능해진다 |
| 절대 경로 고정 | `@game/ReplicatedStorage/RARN_MODULE/...`이 모든 패키지 소스에 박힌다. 위치를 옮기면 전부 깨짐 |
| 디버깅 | 스택 트레이스가 런타임 모듈을 경유 |
| 설치 속도 | **전혀 개선되지 않는다.** 소스는 여전히 전부 복사해야 한다 (2절) |

마지막 줄이 핵심이다. **PnP를 흉내 내도 PnP의 속도는 안 온다.**

---

## 5. 그럼에도 가져올 절반

### 5-1. 현재 레이아웃이 이미 require-by-string과 호환된다 (확인됨)

`_Index/sleitnick_knit@1.7.0/knit/init.luau`에서:

```lua
require("../Promise")   -- knit 의 형제 = _Index/sleitnick_knit@1.7.0/Promise = shim
```

`../`가 "내 부모의 형제"이므로 **기존 shim 레이아웃이 새 문법으로도 그대로 해석된다.**
아무것도 안 해도 되지만, 이걸 문서화해 두면 나중에 패키지들이 문자열 require로 옮겨가도
Rarn이 대응할 필요가 없다는 걸 알 수 있다. (표본에서 이미 10건이 문자열 require였다.)

### 5-2. 엄격성은 설치 시점 검사로 (`rarn doctor`)

기둥 3은 런타임 강제는 못 하지만 **설치 시점 정적 검사**로 상당 부분 얻을 수 있다:

- 패키지 소스가 `script.Parent.Parent.X`를 부르는데 `X`가 선언된 의존성에 없으면 경고
- 반대로 선언했는데 아무 데서도 안 쓰면 경고
- 4.5%의 동적 require는 검사 불가 — **그 사실을 그대로 보고**한다

PnP처럼 강제하지는 못해도 "선언과 실제가 어긋났다"를 알려주는 것만으로 값이 있다.

### 5-3. 해석 맵을 데이터로 노출 (`_Meta.luau`)

간접화는 하지 않되, 해석 결과를 **읽기 전용 데이터**로 하나 심어둔다:

```lua
-- RARN_MODULE/_Meta.luau  (생성물)
return {
  packages = {
    ["evaera/promise"] = { version = "4.0.0", indexDir = "evaera_promise@4.0.0" },
    ...
  },
  requestedBy = { ... },
}
```

shim은 그대로 두므로 아무것도 깨지지 않는다. 대신 게임 안에서 버전 확인, 중복 탐지,
`rarn why`에 해당하는 조회가 가능해진다. **PnP의 지도만 가져오고 간접화는 안 가져오는 것.**

---

## 6. 재검토 조건

아래 중 하나라도 성립하면 이 문서를 다시 연다:

1. **Roblox가 `.luaurc` alias 맵을 지원** ← 가장 중요. RFC가 "내부 검토 중"이라고 명시
2. Knit이 `Util` 공개 노출을 걷어냄 (또는 Knit이 생태계에서 밀려남)
3. 의존성 그래프가 깊어져 shim이 세 자릿수가 되는 프로젝트가 실제로 나타남

1번이 오면 상황이 근본적으로 달라진다. 소스 재작성 없이, Wally 호환을 깨지 않고,
엔진이 직접 해석해 준다. **그때는 할 만하다.**

---

## 7. 부수 수확 — M5에 반영할 것

패키지 13개를 뜯어보다 M5(가지치기) 계획의 구멍이 드러났다.

**`default.project.json`이 없는 패키지가 표본의 절반이다.**

| 패키지 | 프로젝트 파일 | 모듈 루트 |
|---|---|---|
| sleitnick 계열 7개 | **없음** | zip 루트가 곧 모듈 (`init.lua`가 루트에) |
| evaera/promise | 있음 | `lib` (340 → 2 파일) |
| roblox/roact | 있음 | `src` (126 → 79) |
| jsdotlua/react | 있음 | `src` (20 → 17) |
| **red-blox/signal** | 있음 | **`Signal.luau` — 디렉터리가 아니라 파일** |

두 가지를 M5가 반드시 처리해야 한다:

1. **프로젝트 파일 부재가 예외가 아니라 정상 경로다.** `include`를 잘 쓴 패키지는 zip 루트가
   이미 깨끗하다. 경고를 띄우면 절반이 경고를 뿜는다 — 조용히 zip 루트를 쓰면 된다.
2. **`$path`가 파일을 가리킬 수 있다.** 디렉터리로 가정하면 `red-blox/signal`에서 깨진다.

가지치기 이득도 실측됐다: 100% ~ 15%로 편차가 크다. promise가 340 → 2로 극적인 건
사실이지만 **모든 패키지가 그렇지는 않다.**
