# M6 — 현장 보고 대응

> 완료 시점의 사실만 담고 이후 편집하지 않는다 — 링크 수정만 예외.

**완료:** 2026-08-22
**결과:** 결함 4개(RN-7 ~ RN-10), 에러 메시지 2건, 문서 3건. 전부 재현부터 하고 고쳤다.

---

## 어디서 왔나

Rarn 을 모르는 세션이 **다른 폴더에서 react-lua 로 틱택토를 만들었다.** 문서는 대충만
읽으라고 했고, 막혀도 도와주지 않았고, 도구를 평가 중이라는 사실도 알려주지 않았다.
산출물은 `NOTES.md` — 무엇에 막혔고 몇 번 만에 빠져나왔는지, 에러 메시지만으로 다음 수가
정해졌는지를 항목마다 적은 것.

**이건 1.0 게이트를 닫지 못한다.** 게이트는 "우리 밖 프로젝트 3~5개" 를 요구하고 이건
우리가 돌린 세션이다. 하지만 게이트가 열릴 때까지 아무것도 안 하는 것과, 한 사람이
처음 5분에 무엇을 만나는지 지금 아는 것은 다르다.

## 보고된 것 vs 실제

`NOTES.md` 의 rarn 관련 지적은 **전부 재현됐다.** 그리고 재현하는 과정에서 **보고에 없던
가장 큰 것 하나**가 나왔다 — 그 세션은 `rarn doctor` 를 한 번도 돌리지 않았다.

| | 보고자 | 재현 | 등급 |
|---|---|---|---|
| doctor 가 `:WaitForChild` 를 못 읽음 | **우리** | 1663 중 1655 | RN-7 |
| doctor 요약이 읽은 파일 수를 줄여 말함 | **우리** | 444 → "212" | RN-10 |
| `init` 이 비-TTY 에서 조용히 아무것도 안 함 | 현장 | exit 0, 파일 없음 | RN-8 |
| `init` 의 Rojo 안내가 빈 폴더에서만 침묵 | **우리**\* | 재현됨 | RN-9 |
| RN0012 이 없는 파일을 가리킴 | 현장 | `validate.ts:38` | 메시지 |
| `unknown field` 가 아는 필드를 안 알려줌 | 현장 | ajv 원문 그대로 | 메시지 |
| `rokit add` 가 alias 를 `roblox-rarn` 으로 | 현장 | 재현됨 | 문서 |
| `_DEV` 디렉터리 이름과 마운트 위치 | 현장 | 다이어그램에만 암시 | 문서 |
| 패키지가 자기 `*.spec.lua` 를 배포 | 현장 | 2개 발견 | 문서 |

\* 현장은 **증상**을 보고했다 — `init` 다음에 `rarn add -D` 가 RN0031 로 죽었다는 것.
원인이 `init` 의 안내가 침묵한 것이라는 건 그 경로를 그대로 다시 걸어서 나왔다.

## RN-7 — 레지스트리 절반의 require 를 못 읽고 있었다

`doctor` 는 패키지 소스를 읽어 "선언했는데 안 쓴다 / 안 선언했는데 쓴다" 를 본다. 그
스캐너가 아는 표기는 `.Foo` 와 `["Foo"]` 두 가지였다. 그런데 JS 포팅 계열 — react-lua,
jest-lua, luau-polyfill, `jsdotlua/*` 전부 — 은 **오직** 이렇게 쓴다:

```lua
require(script.Parent.Parent:WaitForChild('shared'))
```

캐시에 있는 **584개 패키지 / 8820 파일**로 잰 분포. 못 읽은 8317건 중:

| 형태 | 건수 |
|---|---|
| `:WaitForChild('X')` | 2772 (33.3%) |
| `:FindFirstChild('X')` | 280 (3.4%) |
| 꼬리가 두 단계 이상 (`script.Parent.Parent.X.Y`) | ~1000 |
| 나머지 (진짜 동적, 문자열 require, 비-Roblox 파일) | 나머지 |

**실제 설치에서는 비율이 훨씬 나쁘다.** 52패키지 react 프로젝트에서 **1663건 중 1655건
(99.5%)** 이 `WaitForChild` 하나였다. `FindFirstChild` 는 0.

그리고 이게 조용한 실패가 아니었다. 못 읽은 require 는 "선언했는데 안 쓴다" 로 뒤집혀
나온다 — **올바른 설치에 대고 310줄의 확신에 찬 오보.**

고친 것: 네 표기를 한 연산으로 읽고, 부모 체인 다음 **첫 단계만** 의존성으로 센다.
그리고 인스턴스 이름 안의 점을 구두점으로 지우지 않는다 (Rojo 는 확장자 하나만 떼므로
`ReactFiberWorkLoop.new.lua` 는 `ReactFiberWorkLoop.new` 라는 인스턴스가 된다).

| | 전 | 후 |
|---|---|---|
| 못 읽은 require | 1663 | **10** |
| 출력 | 310줄 | 46줄 |
| 거짓 "never required" | 다수 | 0 |

남은 10건은 하나하나 확인했고 **전부 진짜 동적**이다:

```
init.spec.lua:2              script.Parent              (자기 부모를 require)
ReactFiberHostConfig.test:11 require("@pkg/@jsdotlua/…") (Luau 문자열 require)
__mocks__/Module/init.lua:34 module                      (런타임 변수)
State.lua:309                self._snapshotPath.getInstance()
```

**대조군**: 수정을 stash 하면 새 테스트 10개 중 7개가 실패한다. 나머지 3개는 수정 전후
모두 통과 — 원래도 동적으로 분류되던 것들이라 그게 맞다.

**다른 생태계에서도 확인했다.** `test/game`(knit·comm·sift·promise, 22패키지)은 잔여
161건이 나오는데, **147건이 한 패키지에서 나온다** — `b-j-roberts/starknet-luau` 는 내부
참조를 Luau **문자열 require** 로 쓴다(`require("../crypto/BigInt")`, 156곳). 인스턴스
경로가 아니므로 스캐너가 읽을 것이 애초에 없고, `declares Promise — never required` 도
참이다(Promise 는 주석에만 나온다). 스캐너 구멍이 아니라 그 패키지의 성질이다.

## RN-10 — 검사가 스스로의 범위를 줄여 말했다

RN-7 을 고치고 나서야 보였다. 요약이 이렇게 나온다:

```
scanned 212 files across 52 packages
```

`212` 는 **보고할 것이 있던 패키지**의 파일만 센 것이고, `52` 는 전부다. 실제로 읽은 것은
444개. 한 문장 안에서 분모가 둘이었고, 도구가 좋아질수록 숫자가 줄어드는 방향이었다 —
커버리지처럼 읽히면서 잡음을 재고 있었다.

## RN-8 / RN-9 — `rarn init` 에 테스트가 하나도 없었다

두 결함 다 이국적이지 않다. 하나는 **stdin 을 리다이렉트해서 돌리는 것**(모든 스크립트,
모든 CI), 다른 하나는 **빈 디렉터리에서 돌리는 것**(첫 `rarn init` 이 언제나 있는 상태).

RN-8 이 나쁜 쪽이다. 프롬프트 반 줄을 찍고, 파일을 안 쓰고, 아무 말도 안 하고, **exit 0**.
성공과 구별이 안 되는 유일한 실패 모양. 이제 기본값으로 진행하고 그 사실을 말한다.
Ctrl+D 로 입력을 끊는 경우도 같은 증상이었고 `RN0004` 로 보고한다.

RN-9 는 방향이 반대로 돼 있었다. 안내를 가장 필요로 하는 사람 — 프로젝트 파일이 아직
하나도 없는 사람 — 만 안내를 못 받았다. `install` 에서는 그 침묵이 여전히 옳다(라이브러리는
place 가 없는 게 정상이다). **두 명령이 같은 스캔에 다른 질문을 한다**는 것을 코드가
구분하지 않고 있었다.

`tests/init.test.ts` 가 생겼다. 테스트 8개.

## 메시지 두 건

**RN0012 이 없는 파일을 가리켰다.** `"The full schema is in schemas/rarn.schema.json"` —
저장소 경로이고, 릴리스 바이너리를 받은 사람에게는 바이너리밖에 없다. 현장 보고에는
"안내한 파일이 로컬엔 없다(패키지 저장소 안에 있는 듯)" 라고 적혀 있었다. 찾아본 것이다.

이제 URL 을 주되, **URL 이 필요하기 전에 답을 준다**:

```
(root): unknown field 'dependancies' — did you mean 'dependencies'?
place: unknown field 'clientPackages' (this object takes sharedPackages, serverPackages)
```

**`place.devPackages` 는 따로 답한다.** 의존성 섹션은 셋인데 `place` 는 둘이라 사람들이
반드시 셋째를 지어낸다. "unknown field" 는 맞는 말이고 어려운 절반을 남긴다 — *그럼 dev
패키지는 어디로 가나.* 현장은 그 답을 생성된 shim 을 grep 해서 알아냈다.

```
RN0012: place.devPackages is not a field, and dev packages do not need one.

  Dev packages install into Packages_DEV/, beside Packages/.
  Mount it wherever you like in whichever Rojo project runs your tests.

Remove it. 'place' only names the realms something has to reach *into* by absolute
path, and nothing ever reaches into dev: a package lands in the widest realm that
asked for it, so anything requiring a dev package would have pulled it out of dev
already.
```

**반대 사례도 기록해 둔다.** 같은 세션이 `RN0031` 을 두고 *"이 프로젝트에서 만난 에러
메시지 중 제일 좋았다"* 고 적었다. 이유는 하나다 — 붙여넣을 JSON 을 그대로 준다. 조언이
아니라 답이었다. 그게 목표선이다.

## 문서 세 건

**설치 명령이 실행되지 않는 도구를 만들었다.** README 는 완성된 `rokit.toml` 만 보여줬고,
`rokit add Hawakiki/roblox-rarn` 는 도구 이름을 저장소 이름에서 가져온다. 그래서:

```
$ rokit add Hawakiki/roblox-rarn
$ rarn --version
ERROR Failed to find tool 'rarn' in any project manifest file.
Add the tool to a project using 'rokit add' before running it.
```

`~/.rokit/bin` 에는 `rarn.exe` 가 **있다.** 에러는 *추가하라*고 읽히니 다시 추가하게 되고,
아무것도 변하지 않는다. 실제로 검증한 고침:

```
$ rokit add Hawakiki/roblox-rarn rarn     # 둘째 낱말이 alias
$ rarn --version
0.1.1
```

나머지 둘 — `<packageDir>_SERVER` / `_DEV` 라는 규칙과 셋 중 둘만 `place` 가 필요하다는
것, 그리고 패키지가 자기 `*.spec.lua` 를 같이 배포한다는 것(jest 의 기본 `testMatch` 가
그걸 잡아간다). 후자는 **Rarn 이 고치지 않는다** — 모듈 루트는 저자가 선언한 것이고,
패키지 매니저가 거기 대고 조용히 이견을 내는 쪽이 더 큰 문제다. `globIgnorePaths` 가 답이고
README 가 그렇게 말한다.

## 남긴 것

**설계 마찰 하나는 이 마일스톤에서 손대지 않았다.** 링크 shim 이 exported type alias 를
전달하지 않아서, `--!strict` 로 타입 있는 패키지를 쓰면 `Unknown type 'React.Node'` 가
호출부마다 난다. 현장에서 **가장 오래 걸린 항목**이었고(프로브 3번), 회피책은 둘 다 나쁘다 —
`_Index["jsdotlua_react@17.2.1"]` 를 앱 코드에 박거나, 패키지마다 파사드를 손으로 쓰거나.

luau-lsp 로 재현과 해법을 둘 다 확인했다:

| shim | `L.Node` | `L.Box<number>` |
|---|---|---|
| `return require(...)` (현재) | `Unknown type 'L.Node'` | — |
| `local M = require(...)` + `export type Node = M.Node` + `return M` | 해결 | 해결 (제네릭 포함) |

크기가 다르다 — 패키지 엔트리에서 `export type Name<params>` 헤더를 뽑는 파서가 필요하고
(react 는 31개, 기본값과 제네릭 팩이 섞여 있다), 실패해도 런타임은 안 깨지지만 사용자의
분석 출력에 우리 파일이 등장한다. **포맷 동결과는 무관하다** — shim 내용은 매니페스트도
락파일도 아니고, `SHIM_MARKER` 검사는 양쪽 다 `includes` 라 여러 줄이어도 무사하다.
별도 마일스톤으로 뺐다.

## 배운 것

**결함은 여전히 테스트가 아니라 접촉에서 나왔다.** RN-7 은 506개 테스트를 전부 통과한
채로 출하돼 있었고, 실제 react 프로젝트에 `doctor` 를 한 번 돌리자 즉시 나왔다. RN-1(R2 가
워크플로를 돌려서), RN-6(벤치마크가 실제 패키지를 밟아서)에 이어 세 번째다.

**그리고 이번엔 보고서조차 접촉의 전부는 아니었다.** 가장 큰 결함 두 개(RN-7, RN-10)는
`NOTES.md` 에 없다 — 그 세션이 `doctor` 를 안 돌렸기 때문이다. 현장 보고는 **그 사람이
실제로 밟은 경로**를 준다. 밟지 않은 곳은 여전히 우리가 가야 한다.

**침묵의 방향을 확인하는 값싼 질문 하나.** RN-9 는 "이 경고가 언제 안 나오나" 를 물었으면
바로 나왔을 것이다. 조건이 `if (!scan.scanned) return []` 한 줄이었다.
