<h1 align="center">Rarn</h1>

<p align="center">
  <b>R</b>oblox + Y<b>arn</b> — Wally 레지스트리를 쓰는 Roblox 패키지 매니저.
</p>

<p align="center">
  <code>wally.toml</code> 대신 <code>rarn.json</code> ·
  진짜 락파일 ·
  전역 캐시 ·
  Rojo 불필요
</p>

<p align="center">
  <a href="README.md">English</a> · <b>한국어</b>
</p>

---

Rarn 은 Wally 와 **같은 레지스트리에서 같은 패키지를** 설치하고, Luau 의 `require` 가 실제로
필요로 하는 모양으로 배치한다. Wally 가 Rojo 에게 미루는 일 — 모듈 루트를 찾고, 아카이브를
가지치고, 링크 shim 을 쓰는 일 — 을 동기화 시점이 아니라 **설치 시점에** 할 뿐이다.

```bash
rarn init
rarn add @sleitnick/knit
```

이미 Wally 를 쓰고 있다면 두 줄:

```bash
rarn import          # wally.toml -> rarn.json
rarn install
```

```
installed 5 packages into RARN_MODULE
  26 files, 8 links, 338 pruned
  5 downloaded, 0 cached, resolved  2039ms
```

**`338 pruned` 이 요점이다.** 저 다섯 패키지는 도합 364개 파일을 배포하는데 그중 모듈은
26개다. 나머지는 문서·테스트·CI 설정이고, Wally 라면 그것들을 플레이스에 그대로 복사한 뒤
동기화 시점에 Rojo 가 알아서 걸러내게 둔다.

> **상태: 0.2.0.** 설치 경로는 완성됐고 검증됐다 — 실제 Studio, 실제 `wally install`, 그리고
> Roblox 의 인스턴스 단위 캐시를 모델링한 require 하니스 세 가지로. 패키지 하나를 라이브
> 레지스트리에 실제로 발행하고 Rarn·Wally 양쪽에서 다시 설치해 확인했다. **매니페스트와
> 락파일 포맷은 1.0 전까지 안정하지 않다** — 1.0 이 뜻하는 것이 그것이다. 기능 목록이 아니라
> **포맷 동결**.
>
> [CHANGELOG.md](CHANGELOG.md) 무엇이 바뀌었나 · [PLAN.md](PLAN.md) 어디로 가나 ·
> [CLAUDE.md](CLAUDE.md) 설계가 딛고 선 플랫폼 제약 전부와 그 근거 측정값.
>
> **이 문서는 [영문 README](README.md)의 번역이다.** 원본이 먼저 갱신되므로, 둘이 어긋나면
> 영문이 맞다.

## 목차

| | |
|---|---|
| [설치](#설치) | 바이너리, Rokit, 소스에서 |
| [왜 Wally 가 아니라](#왜-wally-가-아니라) | 무엇이 실제로 다르고 왜 그런지 |
| [명령](#명령) | 전체 명령을, 하려는 일별로 |
| [매니페스트](#매니페스트) | `rarn.json` 필드별 |
| [설치 결과의 모양](#설치-결과의-모양) | 트리, shim, realm |
| [속도](#속도) | 그리고 [506패키지 Wally 비교](#506개-실제-패키지로-wally-와-비교) |
| [`rarn doctor`](#rarn-doctor) | 설치된 소스가 실제로 무엇을 require 하나 |
| [발행](#발행) | 그리고 기본으로 제외되는 것 |
| [개발](#개발) | 빌드, 테스트, Roblox 쪽 검증 |

처음이라면 [왜 Wally 가 아니라](#왜-wally-가-아니라)가 2분 요약이고,
[설치 결과의 모양](#설치-결과의-모양)은 프로젝트를 이 도구에 맡기기 전에 읽어둘 만한 유일한
절이다.

## 설치

Rarn 은 런타임 의존성이 없는 단일 바이너리다 — Bun 도, Node 도, Rojo 도, git 도 필요 없다.

```bash
rokit add Hawakiki/roblox-rarn rarn      # 두 번째 낱말이 alias 이고, 이게 중요하다
rokit trust Hawakiki/roblox-rarn
rokit install
```

```toml
# 그 뒤의 rokit.toml
[tools]
rarn = "Hawakiki/roblox-rarn@0.2.0"
```

**alias 를 꼭 주자.** Rokit 은 따로 말해주지 않으면 도구 이름을 저장소 이름에서 가져온다.
그냥 `rokit add Hawakiki/roblox-rarn` 하면 `roblox-rarn` 으로 설치되고, `rarn` 은
*"Failed to find tool 'rarn' in any project manifest file"* 로 거절당한다 — `~/.rokit/bin`
에는 `rarn` 셰임이 멀쩡히 있는데도. 에러가 *추가하라*고 읽히니 다시 추가하게 되고, 아무것도
변하지 않는다. `rokit.toml` 의 키를 직접 고쳐도 된다.

trust 단계는 Rokit 의 것이지 Rarn 의 것이 아니다. 아무도 보증하지 않은 도구는 실행을
거부하고, 없이 하면 `rokit install` 이 *"has not been marked as trusted"* 로 멈춘다. 머신당
한 번 묻는다.

또는 [Releases](https://github.com/Hawakiki/roblox-rarn/releases)에서 플랫폼별 아카이브를
받아 바이너리를 PATH 에 두면 된다. Windows x86-64, macOS arm64, Linux x86-64 를 빌드한다.

### 소스에서

```bash
git clone https://github.com/Hawakiki/roblox-rarn
cd roblox-rarn
bun install
bun run build          # -> dist/rarn(.exe)
```

어느 호스트에서든 크로스컴파일된다. 예외가 하나 있는데, Windows 타깃을 `--bytecode` 로
크로스컴파일하면 안 되는 이유는 [CLAUDE.md](CLAUDE.md#verifying-an-install) 에 있다:

```bash
bun build --compile --target=bun-windows-x64  src/cli.ts --outfile dist/rarn.exe
bun build --compile --target=bun-darwin-arm64 src/cli.ts --outfile dist/rarn
bun build --compile --target=bun-linux-x64    src/cli.ts --outfile dist/rarn
```

## 왜 Wally 가 아니라

|  | Wally | Rarn |
|---|---|---|
| 레지스트리 | Wally | Wally — 같은 패키지 |
| 매니페스트 | `wally.toml` | `rarn.json`, npm 표기 |
| 인덱스 접근 | 인덱스 저장소를 clone (`git` 필요) | 순수 HTTP |
| 패키지 가지치기 | 소스 저장소 전체를 배치 | 모듈 트리만 배치 |
| 설치에 Rojo 필요 | 필요 | 불필요 |
| 해석 | 탐욕적, 순서 의존 | 제약을 전부 모은 뒤 교집합 |
| 락파일 재사용 | — | 완전 오프라인 재설치 |
| 링크를 통한 타입 | 사라짐 — 호출부마다 `Unknown type` | 전달됨, `--!strict` 가 된다 |
| 중복 가시성 | 없음 | `rarn why`, `rarn dedupe` |
| 미사용/누락 의존성 | 없음 | `rarn doctor` |

이 중 셋은 표 한 줄 이상의 값이 있다.

**해석 순서가 결과를 바꾼다.** Wally 는 백트래킹 없이 탐욕적으로 해석한다. `^1.2.0` 과
`^1.5.0` 이 있고 `1.9.0` 이 발행돼 있을 때, 어느 범위가 먼저 큐에 들어가느냐에 따라 `1.2.0`
이 활성화되고 이후의 모든 `1.x` 가 "이미 선택됨" 으로 거절당한다 — 명백한 해가 있는 그래프에서
설치가 실패한다. Rarn 은 그래프를 먼저 전부 걷고, 패키지별로 범위를 모으고, 교집합을 낸다.
`^1.2.0 ∩ ^1.5.0` 은 둘 다에게 `1.9.0` 을 준다. 교집합이 **정말로 비었을 때만** 충돌로
보고하고, 그때는 요구자와 그 범위를 이름으로 말한다.

**Wally 아카이브는 모듈이 아니라 소스 저장소다.** `evaera/promise@4.0.0` 은 340개 파일을
배포한다 — `docs/`, `CHANGELOG.md`, 벤더링된 TestEZ — 정작 모듈은 `lib/init.lua` 파일
하나다. Wally 는 전부 풀어놓고 동기화 시점에 Rojo 가 중첩된 프로젝트 파일을 재해석하게
둔다. Rarn 은 `default.project.json` 을 읽어 `$path` 를 풀고 그것만 복사한다. Rarn 의
산출물이 Rojo 없이도 옳은 이유가 이것이다.

**하지만 저자가 모듈 루트 *안에* 넣은 것을 넘겨짚지는 않는다.** 어떤 패키지는 자기 테스트를
거기 둔다 — `jsdotlua/promise` 는 소스 옆에 `init.spec.lua` 를 배포한다 — 그리고 그것들은
나머지와 함께 플레이스에 들어온다. 보통은 몇 킬로바이트라 무해하다. 무해하지 않게 되는
지점은 기본 패턴이 `**/?(*.)+(spec|test)` 인 테스트 프레임워크를 쓸 때다. jest-lua 가
**패키지의 spec 을 당신 것처럼 찾아간다.** 고침은 Rojo 프로젝트 쪽에 있다 — 무엇이 플레이스에
닿는지 결정하는 계층이 거기다:

```jsonc
"globIgnorePaths": ["**/*.spec.lua", "**/*.spec.luau", "**/__tests__/**"]
```

Rarn 이 직접 걷어내지는 않는다. 모듈 루트는 **저자가 선언한 패키지의 정의**이고, 패키지
매니저가 거기 대고 조용히 이견을 내는 쪽이 떠도는 spec 파일 하나보다 큰 문제다.

**링크는 패키지의 타입을 잃어버리고, 그건 고칠 수 있다.** Luau 는 링크 파일을 통해 모듈의
**값**은 넘기고 **타입 alias 는 하나도 안 넘긴다.** 그래서 Wally 링크를 통하면
`React.createElement` 는 타입 체크가 되는데 `React.Node` 는 호출부마다
`Unknown type 'React.Node'` 다 — 타입 있는 패키지에 대고 `--!strict` 시그니처를 쓸 수가
없다. 가장 많이 의존되는 584개 패키지 중 **300개가 이런 식으로 타입을 export 한다.** Rarn 은
엔트리 모듈이 선언한 것을 읽어 재수출하므로, 쓰려던 주석을 그대로 쓸 수 있다. 생성되는 파일은
[설치 결과의 모양](#설치-결과의-모양)에 있다.

## 명령

Yarn 의 이름을 쓴다. Rarn 은 Yarn 의 모델을 Roblox 에 적용한 것이기 때문이다.

### 매일 쓰는 것

| | |
|---|---|
| `rarn init` | `rarn.json` 을 만든다 |
| `rarn import` | 기존 `wally.toml` 에서 만든다. `--dry-run` |
| `rarn add <pkg…>` | 추가하고 설치. `-D` dev, `--server` server, `-E` 정확한 버전 |
| `rarn install` | 매니페스트가 요구하는 것을 설치. `--frozen-lockfile`, `--production` |
| `rarn remove <pkg…>` | 매니페스트에서 빼고 재설치 |
| `rarn up [pkg…]` | `rarn.json` 의 범위를 올린다. `--latest` 는 범위를 아예 무시 |

### 트리를 이해하기

| | |
|---|---|
| `rarn list` (`ls`) | 설치된 트리. `--depth <n>` |
| `rarn why <pkg>` | `rarn.json` 에서 그것까지 가는 모든 경로 |
| `rarn dedupe` | 두 버전 이상으로 설치된 패키지와 요구자 — **같은 DataModel 을 공유하는 이 프로젝트 밖 트리까지 포함** |
| `rarn outdated` | 설치됨 vs 범위 내 최신 vs 최신. CI 용 `--check` |
| `rarn doctor` | 설치된 소스의 require 와 선언된 의존성 대조 |

`place` 는 `rarn.json` 이 선언하지 않으면 프로젝트의 Rojo 파일에서 읽어낸다 — 고정된 한
이름이 아니라 **아무 `*.project.json`** 이다. 멀티 플레이스 저장소는 대부분 플레이스마다
파일 이름을 다르게 짓거나 한 디렉터리씩 중첩하기 때문이다. 두 출처가 어긋날 때, 두 프로젝트
파일이 한 realm 을 다른 곳에 둘 때, 패키지 디렉터리에 어떤 Rojo 프로젝트도 싣지 않는 패키지가
있을 때 Rarn 이 그렇다고 말한다. Roblox 는 잘못된 경로를 `Requested module experienced an
error while loading` 로만 보고하고 **경로는 알려주지 않으므로**, 검사가 여기서 일어나야 한다.

### 레지스트리

| | |
|---|---|
| `rarn search <query>` | 레지스트리 검색 |
| `rarn info <pkg>[@ver]` | 버전, realm, 라이선스, 의존성 |
| `rarn login` / `logout` / `whoami` | GitHub device flow. 토큰은 레지스트리별 |
| `rarn pack` | `publish` 가 올릴 아카이브를 만든다. `--list`, `-o <file>` |
| `rarn publish` | 업로드. `--dry-run` |

### 어디서나

`--cwd <path>` · `--verbose` · `--silent` · `--no-color` · `--offline` · 대부분의 읽기
명령에 `--json`.

`--offline` 은 조용히 네트워크에 손을 뻗는 대신 **아예 거부한다.** 최신 `rarn.lock` 과 따뜻한
캐시가 있으면 설치는 네트워크가 필요 없으므로 이 옵션은 아무 비용도 없고, "마침 네트워크가
필요 없었다" 를 "네트워크를 쓸 수 없다" 로 바꾼다 — 기차 안에서 값이 있는 쪽은 후자다.
`RARN_NO_NETWORK=1` 이 셸 하나나 CI 잡 전체에 같은 일을 한다.

종료 코드: `0` 정상, `1` 당신의 프로젝트나 인자, `2` 레지스트리나 네트워크. 에러는 고정
코드를 단다 — 주변 문구가 어떻게 바뀌든 `RN0210` 은 영원히 같은 뜻이다.

숫자가 어느 계층인지 말해주고, 보통 그것만으로 누구의 문제인지 알 수 있다:

| | |
|---|---|
| `RN00xx` | CLI, 또는 `rarn.json` |
| `RN01xx` | 레지스트리나 네트워크 |
| `RN02xx` | 해석 — 충돌, realm, 순환 |
| `RN03xx` | 캐시, 다운로드, 아카이브 |
| `RN04xx` | 프로젝트 파일 해석, 또는 트리 쓰기 |
| `RN05xx` | `rarn.lock` |
| `RN06xx` | 인증, 패킹, 발행 |
| `RN07xx` | `wally.toml` 가져오기 |

전체 목록은 `src/util/codes.ts`. 출하된 코드는 다른 뜻으로 재사용되지 않고 퇴역한 코드도
삭제되지 않으므로, 번호로 검색하면 언제나 한 가지에 닿는다.

## 매니페스트

```jsonc
{
  "name": "@you/your-game",
  "version": "0.1.0",
  "realm": "shared",

  "dependencies":       { "@sleitnick/knit": "^1.7.0" },
  "serverDependencies": { "@evaera/promise": "^4.0.0" },
  "devDependencies":    { "@roblox/testez":  "^0.4.1" },

  // 두 의존자가 호환되지 않는 major 를 요구할 때 버전을 하나로 강제한다.
  // Roblox 에서는 편의가 아니다 — 대안이 ModuleScript 사본 두 개다.
  "resolutions": { "@evaera/promise": "4.0.0" },

  // server 나 dev 패키지가 shared 패키지에 의존할 때만 필요하다.
  "place": { "sharedPackages": "game.ReplicatedStorage.Packages" }
}
```

범위는 npm 표기다 — `^1.2.3`, `~1.2.3`, `>=1.2.0 <2.0.0`, `1.2.x`, `*`, `||`.

**Wally 는 Cargo 표기를 쓰고, 두 군데가 다르다.** `,` 가 AND 구분자이고, **맨 버전이 캐럿
요구사항**이다 — Cargo 는 `1.0.0` 을 `^1.0.0` 으로 읽는데 npm 은 정확한 핀으로 읽는다. 둘 다
예외를 던지지 않으므로 짐작하지 않고 명시적으로 변환한다. `rarn import` 는
`red-blox/spawn@1.0.0` 을 `^1.0.0` 으로 바꾸는데, 그것이 레지스트리가 그 줄에 대해 실제로
저장해 둔 값이다. 반대 방향으로, `rarn publish` 는 Cargo 가 표현할 수 없는 범위를 조용히
넓히는 대신 **거절한다.**

## 설치 결과의 모양

```
RARN_MODULE/                        <- shared
  Promise.luau                      <- shim. 직접 의존성만 여기 나온다
  _Index/
    evaera_promise@4.0.0/
      promise/                      <- 진짜 소스, 정확히 한 벌
        init.luau
    sleitnick_knit@1.7.0/
      knit/
      Promise.luau                  <- shim. 소스 폴더의 형제
RARN_MODULE_SERVER/                 <- server realm, 같은 모양
RARN_MODULE_DEV/                    <- dev realm, 같은 모양
```

```lua
-- RARN_MODULE/Promise.luau
return require(script.Parent._Index["evaera_promise@4.0.0"]["promise"])
```

**이 모양은 고른 게 아니라 강제된 것이다.** 패키지 소스에는
`require(script.Parent.Parent.Alias)` 호출이 **하드코딩돼** 있으므로, 의존성 shim 은 반드시
그 패키지 소스 폴더의 *형제*로 앉아야 한다. 아니면 그 호출이 `nil` 로 풀린다.

**shim 이 패키지의 타입을 전달하므로 `--!strict` 가 된다.** Luau 는 링크를 통해 모듈의
**값**은 넘기고 타입 alias 는 하나도 안 넘긴다. Wally 링크를 통하면 `React.createElement` 는
타입 체크가 되는데 `React.Node` 가 호출부마다 `Unknown type 'React.Node'` 인 이유가 그것이다.
Rarn 은 엔트리 모듈이 export 하는 것을 읽어 재수출한다:

```lua
-- Packages/React.luau
local Module = require(script.Parent._Index["jsdotlua_react@17.2.1"]["react"])

export type Node = Module.Node
export type PureComponent<Props, State = nil> = Module.PureComponent<Props, State>

return Module
```

가장 많이 의존되는 584개 패키지 중 300개가 이렇게 타입을 export 한다. **확실하게 읽지 못한
것은 추측하지 않고 뺀다** — 빠뜨린 alias 는 어차피 손으로 쓰려던 주석 하나를 뺏지만, 잘못
넘긴 것은 당신이 쓰지도 않은 생성 파일에 에러를 넣는다. 타입을 export 하지 않는 패키지는
원래의 한 줄 shim 을 그대로 쓴다.

**중복은 디스크 낭비가 아니라 정확성 결함이다.** Roblox 의 `require` 는 Instance 를 받고
**ModuleScript 인스턴스 단위로** 캐시한다. 그래서 한 패키지의 사본 두 개는 상태가 따로인
모듈 두 개이고 — 그 안의 모든 싱글턴이 조용히 둘이 된다. 한 버전으로 해석된 두 패키지는 하나의
`_Index` 폴더를 공유하며, 이것이 dedupe 를 관례가 아니라 **구조로** 강제하는 방식이다.

realm 은 서로 형제이고 절대 중첩되지 않는다. 각각이 다른 Roblox 서비스에 동기화되기
때문이다. shim 은 한 realm **안에서만** 상대 경로로 걸을 수 있으므로, shared 패키지에 의존하는
server 패키지에는 절대 DataModel 경로가 필요하다 — `place` 가 그것을 위해 있다. `shared`
패키지는 `shared` 패키지에만 의존할 수 있다. shared 코드는 클라이언트로 복제되므로
shared→server 간선은 런타임에 깨진다.

**형제 둘의 이름은 `packageDir` 에서 온다.** `_SERVER` 와 `_DEV` 를 붙인다. `packageDir` 을
`Packages` 로 두면 세 디렉터리는 `Packages/`, `Packages_SERVER/`, `Packages_DEV/` 다.
따로 설정할 수 없고, `rarn install` 이 무엇을 썼는지 출력한다.

각각 Studio 에 닿으려면 Rojo 항목이 필요하고, 그중 둘만 `place` 가 필요하다:

| 디렉터리 | 마운트 위치 | `place` 항목 |
|---|---|---|
| `Packages/` | shared 코드가 사는 곳, 보통 `ReplicatedStorage` | `sharedPackages` |
| `Packages_SERVER/` | 서버 전용 서비스, 보통 `ServerScriptService` | `serverPackages` |
| `Packages_DEV/` | 아무 데나. 테스트를 돌리는 프로젝트 파일에 | 없음 — 아래 참조 |

`place.devPackages` 는 없고, 표에서 빠진 세 번째 디렉터리도 없다. 패키지는 **그것을 요구한
가장 넓은 realm** 에 놓이므로, dev 에 놓인 패키지를 require 하는 무언가는 애초에 그것을
dev 밖으로 끌어냈을 것이다 — 무엇도 dev *안으로* 절대 경로를 뻗을 일이 없다. 나머지 둘은
그럴 일이 있고, 그것이 `place` 가 존재하는 이유 전부다.

## 속도

네트워크를 건드리는 단계는 해석뿐이다. 가져오기는 전역 캐시를 읽고 링크는 완전히 로컬이므로,
락파일이 최신이면 재설치는 **완전히 오프라인**이다.

| | 5패키지 그래프 |
|---|---|
| 콜드, 캐시 없음 | ~2.0 s |
| 따뜻한 캐시 + 최신 락파일 | **~65 ms** |

콜드 수치는 대부분 네트워크라 당신 것과 다를 것이다. 값이 있는 주장은 따뜻한 쪽이고, **요청이
하나도 없기** 때문이다.

캐시는 아카이브만이 아니라 **압축을 푼 트리**를 저장하므로, 따뜻한 설치는 네트워크 I/O 도
unzip 도 하지 않는다. 하드링크가 아니라 복사한다 — 한 프로젝트에서의 편집이 캐시를 공유하는
다른 모든 프로젝트로 전파되면 안 되기 때문이다.

### 506개 실제 패키지로 Wally 와 비교

다른 패키지가 얼마나 자주 의존하는지로 골라낸 라이브 레지스트리의 506개 패키지, 전이
의존성까지 세면 575개. Windows 11, Bun 1.3.14, Wally 0.3.2. 방법과 다른 크기의 집합,
집합을 고른 기준은 [test/benchmark](test/benchmark/README.md) 에 있다.

| | rarn | wally |
|---|---:|---:|
| 설치, 따뜻한 캐시 | **5.6 s** — 네트워크 전무 | 9.8 s — 575개 전부 재다운로드 |
| 설치, 콜드 캐시 | 37.3 s | 9.8 s |
| 머신에서 첫 실행 | 37.3 s | 9.8 s **+ 12 s** 인덱스 clone (46 MB, `git` 필요) |
| 쓴 파일 수 | **7,045** | 12,956 |
| 쓴 바이트 | **43.3 MB** | 107.9 MB |
| Rojo 없이 풀리는 모듈 루트 | **548 / 556 (98.6%)** | 148 / 575 (25.7%) |
| 링크를 통해 패키지 타입에 닿나 | **닿는다** | 못 닿는다 — 호출부마다 `Unknown type` |

저 표가 숨기지 않는 것 셋:

- **콜드 설치는 Wally 가 이긴다.** 레지스트리 인덱스를 clone 해두므로 해석에 네트워크가 들지
  않는다. Rarn 은 HTTP 로 묻고 37.3 s 중 8.9 s 를 거기 쓴다. `git` 이 필요 없고 46 MB clone
  을 두지 않는 값이다.
- **Wally 에는 패키지 캐시가 없다.** 인덱스만 캐시하므로 매 설치가 아카이브를 전부 다시
  받는다. 그 열에 숫자가 하나뿐인 이유이고, 차이가 드러나는 곳이 CI 인 이유다.
- **마지막 줄은 속도 이야기가 아니다.** Wally 설치는 동기화 시점에 Rojo 가 각 패키지의 중첩
  프로젝트 파일을 재해석해 주기를 기대하므로, 모듈 폴더의 4분의 3에는 루트에 `init` 이 없다.
  Rarn 은 그 일을 설치 시점에 한다. **Wally 는 설치할 수 있는데 Rarn 은 못 하는 패키지는
  없었다.**

벤치마크를 쓰다가 출하된 결함 둘이 나왔고, 둘 다 작은 그래프에서는 안 보이는 것이었다.
512 KiB 넘는 파일이 든 아카이브를 아예 풀 수 없었던 것과, 해석이 패키지마다 소켓을 하나씩
열던 것. 둘 다 고쳤다 — CHANGELOG 참조.

**최신성 판정은 일부러 비대칭이다.** 쓸 수 있는 락파일을 낡았다고 하면 왕복 한 번을 손해 본다.
낡은 것을 쓸 수 있다고 하면 매니페스트가 더 이상 요구하지 않는 버전을 설치하고 **성공했다고
보고한다.** 모든 비교는 낡은 쪽으로 기운다.

## `rarn doctor`

설치된 Luau 에서 모듈 루트를 넘어가는 require — shim 을 통해 풀리는 것들 — 를 훑어 선언된
것과 대조한다.

```
@scope/example@1.0.0
  requires NotDeclared — not a declared dependency
    RARN_MODULE/_Index/scope_example@1.0.0/example/init.lua:13  resolves to nil at runtime

  scanned 20 files across 5 packages
  10 requires are built at runtime and could not be checked
```

누락된 의존성은 `1` 로 끝내고, 미사용 선언은 경고만 한다. 넉넉한 매니페스트는 아무것도 깨지
않기 때문이다. 정적으로 풀 수 없는 require 는 숨기지 않고 세어서 보고한다 — **얼마나 못 봤는지를
감추는 검사는 실제보다 철저해 보인다.**

Roblox 가 한 조회에 대해 받아들이는 **네 가지 표기를 전부** 읽는다. 패키지들이 넷 다 쓰고,
둘만 아는 스캐너는 없느니만 못하기 때문이다:

```lua
require(script.Parent.Parent.Promise)                 -- 인덱싱
require(script.Parent.Parent["Promise"])              -- 대괄호
require(script.Parent.Parent:WaitForChild("promise")) -- 레지스트리의 JS 포팅 계열
require(script.Parent.Parent:FindFirstChild("promise"))
```

세 번째는 예외적인 경우가 아니다. `jsdotlua/*` 패키지 전부 — react-lua, jest-lua,
luau-polyfill — 가 그것만 쓴다. 그래서 52패키지 React 설치에서 **1663건 중 1655건**이 읽히지
않았고, 그 하나하나가 "선언했는데 안 쓴다" 는 **거짓 보고**로 되돌아 나왔다. 지금은 10건이다.

변수를 통한 require 도 따라간다. 생태계에서 가장 많이 쓰이는 프레임워크가 그것을 필요로 하기
때문이다:

```lua
KnitClient.Util = (script.Parent :: Instance).Parent
local Promise = require(KnitClient.Util.Promise)   -- 그래도 찾는다
```

## 발행

```bash
rarn login              # GitHub device flow, read:user 만
rarn pack --list        # 무엇이 올라갈지 정확히 본다
rarn publish --dry-run  # 업로드 빼고 전부
rarn publish
```

레지스트리는 **업로드된 아카이브 안의 `wally.toml`** 을 읽어 패키지 이름과 버전을 알아낸다.
그래서 Rarn 이 `rarn.json` 에서 하나를 생성해 넣는다 — 체크인된 사본이 그것을 가리는 일은
없다.

`.env`, `*.key`, `*.pem` 과 realm 디렉터리들이 기본으로 제외되고, **`_Index/` 를 품은 모든
디렉터리**도 그렇다. 그것은 다른 패키지 매니저의 설치 트리이고, 남의 디렉터리 이름이 무엇인지
Rarn 이 알 수 없으므로 **이름이 아니라 모양으로** 알아본다. 발행된 버전은 영구적이고
공개적이며 취소가 없다. 파일 하나가 모자라면 설치가 깨지고 몇 분 만에 고쳐지지만, 하나가
남으면 **되돌릴 방법이 없다.** `include` 에 파일을 정확한 이름으로 적으면 그 기본 제외를
덮어쓴다. 글롭은 덮어쓰지 않는다.

## 개발

```bash
bun test                 # 전체 스위트
bun run check            # format + lint + typecheck + test, 이 순서로
bun run src/cli.ts <..>  # 빌드 없이 CLI 실행
```

`bun run check` 가 pre-commit 훅이 돌리는 것이다.

Roblox 쪽 검증은 별개이고 `rokit.toml` 에서 온다:

```bash
lune run tests/roblox/verify.luau -- <install-dir> [<realm>] [--mount=<path>=<dir>]... [--execute]
```

Roblox 의 `require` 를 다시 구현한다 — 인스턴스 기반 조회, 인스턴스 단위 캐시 — 그리고 실제
설치 트리 위에서 파일 트리 단언이 **할 수 없는 두 질문**에 답한다. 모든 shim 이 진짜
ModuleScript 에 닿는가, 그리고 **두 경로로 도달한 한 패키지가 하나의 인스턴스로 돌아오는가.**
사본 두 개는 디스크에서 똑같이 생겼고 런타임에만 갈라진다. `bun test` 가 합성 트리 위에서
자동으로 돌리며, **일부러 망가뜨린 트리 셋**도 함께 돌린다. 아무것도 실패시킬 수 없는 하니스는
값이 없기 때문이다.

realm 을 건너는 shim 은 절대 DataModel 경로를 이름으로 대므로, 대조할 것이 있으려면 형제
realm 을 `--mount` 로 등록해야 한다. 없으면 실패가 아니라 *not verified* 로 보고한다 —
2026-08-22 까지는 올바른 shim 을 망가진 것으로 보고했었다.

모델은 실제 Studio 에 한 번 대조했다. `test/roblox/` 를 `rojo build` 한 것 위에서 검사 17개,
**Studio 가 전부 동의했다** — 그중 제일 중요한 둘, 한 소스의 사본 두 개는 테이블 두 개이고 한
인스턴스를 두 번 require 하면 테이블 하나라는 것 포함. `tests/roblox/emulate-selftest.luau`
는 다른 질문을 한다 — **모델이 자기 주장대로 하는가.** 결함 둘이 그 틈에 살고 있었다.

이것이 `test/roblox/` 를 대체하지는 않는다. 하니스는 트리가 Roblox 의 *모델* 아래서 정합함을
증명한다. 모델이 틀리면 하니스는 통과하고 Studio 가 깨진다. 패키지 코드는 `--execute` 를 주지
않으면 실행되지 않고, 줘도 엔진은 거기 없다 — `Enum`, `Instance.new`, `task`, `RunService` 는
**일부러** 모델 밖이다. 스텁을 하나 늘릴 때마다 *통과하는* 하니스가 조용히 틀릴 수 있는 면적이
넓어지기 때문이다.

## 라이선스

MIT
