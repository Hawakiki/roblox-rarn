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

Wally 와 같은 레지스트리에서 같은 패키지를 받아, Luau 의 `require` 가 실제로 필요로 하는
모양으로 깔아준다. Wally 가 Rojo 에게 미뤄 두는 일 — 모듈 루트 찾기, 아카이브 가지치기,
링크 shim 쓰기 — 을 동기화할 때가 아니라 설치할 때 끝내는 것이 차이의 전부다.

```bash
rarn init
rarn add @sleitnick/knit
```

Wally 를 쓰고 있었다면 두 줄이면 넘어온다.

```bash
rarn import          # wally.toml -> rarn.json
rarn install
```

```
installed 5 packages into RARN_MODULE
  26 files, 8 links, 338 pruned
  5 downloaded, 0 cached, resolved  2039ms
```

**`338 pruned` 를 보자.** 저 패키지 다섯 개가 담고 있는 파일이 364개인데 정작 모듈은 26개다.
나머지는 문서, 테스트, CI 설정 같은 것들이고, Wally 는 그걸 전부 플레이스에 복사한 다음
동기화할 때 Rojo 더러 걸러내라고 한다.

> **상태: 0.2.0.** 설치 경로는 완성됐다. 실제 Studio, 실제 `wally install`, 그리고 Roblox 의
> 인스턴스 단위 캐시를 흉내 낸 require 하니스까지 셋으로 검증했다. 패키지 하나를 라이브
> 레지스트리에 직접 발행해서 Rarn 과 Wally 양쪽으로 다시 설치되는 것도 확인했다.
> **매니페스트와 락파일 포맷은 1.0 전까지 안정하지 않다.** 1.0 이 뜻하는 게 바로 그거다.
> 기능을 다 만들었다는 선언이 아니라, 포맷을 더는 못 바꾸게 못 박겠다는 약속이다.
>
> 나머지 문서는 [docs/](docs/README.md) 가 질문별로 안내한다.
>
> 무엇이 바뀌었는지는 [CHANGELOG.md](CHANGELOG.md), 앞으로 어디로 가는지는
> [PLAN.md](PLAN.md), 설계가 딛고 선 플랫폼 제약과 그 근거 측정값은
> [CLAUDE.md](CLAUDE.md) 에 있다.
>
> 이 문서는 [영문 README](README.md) 를 옮긴 것이다. 원본을 먼저 고치니까, 둘이 어긋나면
> 영문이 맞다.

## 목차

| | |
|---|---|
| [설치](#설치) | 바이너리, Rokit, 소스 빌드 |
| [왜 Wally 가 아니라](#왜-wally-가-아니라) | 뭐가 다르고 왜 그런지 |
| [명령](#명령) | 하려는 일별로 정리한 전체 명령 |
| [매니페스트](#매니페스트) | `rarn.json` 필드 설명 |
| [설치 결과의 모양](#설치-결과의-모양) | 트리, shim, realm |
| [속도](#속도) | 그리고 [506패키지로 Wally 와 비교](#506개-실제-패키지로-wally-와-비교) |
| [`rarn doctor`](#rarn-doctor) | 설치된 소스가 실제로 뭘 require 하는지 |
| [발행](#발행) | 그리고 기본으로 빠지는 것들 |
| [쓰고 계신가요](#쓰고-계신가요) | 한 줄 남기기 — 침묵과 부재를 가르는 유일한 방법 |
| [개발](#개발) | 빌드, 테스트, Roblox 쪽 검증 |

처음이면 [왜 Wally 가 아니라](#왜-wally-가-아니라) 가 2분짜리 요약이고,
[설치 결과의 모양](#설치-결과의-모양) 은 프로젝트를 맡기기 전에 한 번쯤 읽어둘 만하다.

## 설치

런타임 의존성이 없는 단일 바이너리다. Bun 도 Node 도 Rojo 도 git 도 필요 없다.

```bash
rokit add Hawakiki/roblox-rarn rarn      # 두 번째 낱말이 alias 다. 이게 중요하다
rokit trust Hawakiki/roblox-rarn
rokit install
```

```toml
# 실행 후 rokit.toml
[tools]
rarn = "Hawakiki/roblox-rarn@0.2.0"
```

**alias 를 꼭 붙이자.** Rokit 은 따로 말 안 하면 도구 이름을 저장소 이름에서 가져온다.
그래서 `rokit add Hawakiki/roblox-rarn` 만 하면 `roblox-rarn` 으로 깔리고, `rarn` 을 치면
*"Failed to find tool 'rarn' in any project manifest file"* 로 거절당한다. `~/.rokit/bin` 에
`rarn` 셰임은 멀쩡히 있는데도 그렇다. 에러가 "추가하라"고 하니 다시 추가하게 되는데, 그래도
똑같다. 이미 깔았다면 `rokit.toml` 의 키를 손으로 고쳐도 된다.

trust 는 Rarn 이 아니라 Rokit 의 정책이다. 아무도 보증하지 않은 도구는 실행을 거부하고,
빼먹으면 `rokit install` 이 *"has not been marked as trusted"* 로 멈춘다. 머신당 한 번만
물어본다.

아니면 [Releases](https://github.com/Hawakiki/roblox-rarn/releases) 에서 플랫폼에 맞는
아카이브를 받아 바이너리를 PATH 에 두면 된다. Windows x86-64, macOS arm64, Linux x86-64 를
빌드해 둔다.

### 소스에서

```bash
git clone https://github.com/Hawakiki/roblox-rarn
cd roblox-rarn
bun install
bun run build          # -> dist/rarn(.exe)
```

어느 호스트에서든 크로스컴파일된다. 딱 하나 예외가 있는데, Windows 타깃에 `--bytecode` 를
붙이면 안 된다. 이유는 [CLAUDE.md](CLAUDE.md#verifying-an-install) 에 적어 뒀다.

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
| 패키지 가지치기 | 소스 저장소를 통째로 깔아둠 | 모듈 트리만 |
| 설치에 Rojo | 필요 | 불필요 |
| 해석 | 탐욕적, 순서에 좌우됨 | 제약을 다 모은 다음 교집합 |
| 락파일 재사용 | — | 완전 오프라인 재설치 |
| 링크 너머의 타입 | 사라짐 — 호출부마다 `Unknown type` | 전달됨, `--!strict` 가 된다 |
| 중복이 보이나 | 안 보임 | `rarn why`, `rarn dedupe` |
| 미사용·누락 의존성 | 안 보임 | `rarn doctor` |

이 중 셋은 표 한 줄로 넘기기엔 아깝다.

**해석 순서가 결과를 바꾼다.** Wally 는 백트래킹 없이 탐욕적으로 해석한다. `^1.2.0` 과
`^1.5.0` 이 있고 `1.9.0` 이 나와 있다고 하자. 어느 쪽이 먼저 큐에 들어가느냐에 따라 `1.2.0`
이 먼저 확정되고, 그 뒤로 오는 `1.x` 는 전부 "이미 고른 버전과 호환됨"이라며 거절당한다.
답이 뻔히 있는 그래프에서 설치가 실패하는 셈이다. Rarn 은 그래프를 끝까지 걷고 패키지별로
범위를 모은 다음 교집합을 낸다. `^1.2.0 ∩ ^1.5.0` 은 둘 다에게 `1.9.0` 을 준다. 교집합이
진짜로 비어야만 충돌로 보고하고, 그때는 누가 무슨 범위를 요구했는지 이름을 대준다.

**Wally 아카이브는 모듈이 아니라 소스 저장소다.** `evaera/promise@4.0.0` 을 받으면 340개
파일이 딸려 온다. `docs/`, `CHANGELOG.md`, 벤더링된 TestEZ 까지. 정작 모듈은 `lib/init.lua`
하나다. Wally 는 이걸 전부 풀어놓고, 동기화할 때 Rojo 가 안에 있는 프로젝트 파일을 다시
읽어주기를 기대한다. Rarn 은 `default.project.json` 을 읽어 `$path` 를 풀고 거기만 복사한다.
Rarn 이 뱉은 트리가 Rojo 없이도 맞는 이유가 이거다.

**대신 저자가 모듈 루트 안에 넣어둔 건 건드리지 않는다.** 자기 테스트를 거기 두는 패키지들이
있다. `jsdotlua/promise` 는 소스 옆에 `init.spec.lua` 를 같이 배포한다. 그것들도 나머지와
함께 플레이스로 들어온다. 보통은 몇 킬로바이트라 신경 쓸 일이 아닌데, 기본 패턴이
`**/?(*.)+(spec|test)` 인 테스트 프레임워크를 쓰기 시작하면 얘기가 달라진다. jest-lua 가
패키지의 spec 을 네 것인 줄 알고 주워간다. 이건 Rojo 프로젝트에서 막는 게 맞다. 무엇이
플레이스까지 갈지 정하는 건 거기니까.

```jsonc
"globIgnorePaths": ["**/*.spec.lua", "**/*.spec.luau", "**/__tests__/**"]
```

Rarn 이 알아서 걷어내지는 않는다. 모듈 루트는 저자가 "내 패키지는 여기까지다"라고 선언한
것이고, 패키지 매니저가 거기에 말없이 토를 다는 게 spec 파일 하나 굴러다니는 것보다 훨씬 큰
문제다.

**링크를 지나면 패키지의 타입이 사라진다. 이건 고칠 수 있다.** Luau 는 링크 파일 너머로
모듈의 값은 넘겨주지만 타입 alias 는 하나도 안 넘긴다. Wally 링크로 받으면
`React.createElement` 는 타입 체크가 되는데 `React.Node` 는 쓰는 곳마다
`Unknown type 'React.Node'` 가 뜬다. 타입 있는 패키지에 `--!strict` 시그니처를 못 쓴다는
뜻이다. 많이 쓰이는 584개 패키지 중 **300개가 이런 식으로 타입을 내보낸다.** Rarn 은 엔트리
모듈이 선언한 걸 읽어서 그대로 다시 내보내니, 쓰려던 주석을 그냥 쓰면 된다. 실제로 생성되는
파일은 [설치 결과의 모양](#설치-결과의-모양) 에 있다.

## 명령

이름은 Yarn 것을 가져왔다. Rarn 자체가 Yarn 의 모델을 Roblox 에 옮긴 거라서 그렇다.

### 매일 쓰는 것

| | |
|---|---|
| `rarn init` | `rarn.json` 만들기 |
| `rarn import` | 기존 `wally.toml` 에서 만들기. `--dry-run` |
| `rarn add <pkg…>` | 추가하고 설치. `-D` dev, `--server` server, `-E` 정확한 버전 |
| `rarn install` | 매니페스트대로 설치. `--frozen-lockfile`, `--production` |
| `rarn remove <pkg…>` | 매니페스트에서 빼고 다시 설치 |
| `rarn up [pkg…]` | `rarn.json` 의 범위를 올림. `--latest` 는 범위를 무시 |

### 트리 들여다보기

| | |
|---|---|
| `rarn list` (`ls`) | 설치된 트리. `--depth <n>` |
| `rarn why <pkg>` | `rarn.json` 에서 거기까지 가는 모든 경로 |
| `rarn dedupe` | 두 버전 이상 깔린 패키지와 요구자. **같은 DataModel 을 쓰는 다른 프로젝트까지 본다** |
| `rarn outdated` | 설치됨 / 범위 내 최신 / 진짜 최신. CI 용 `--check` |
| `rarn doctor` | 설치된 소스의 require 를 선언된 의존성과 대조 |

`place` 를 `rarn.json` 에 안 적으면 프로젝트의 Rojo 파일에서 알아서 읽어낸다. 고정된 파일명
하나가 아니라 `*.project.json` 을 전부 본다. 멀티 플레이스 저장소는 보통 플레이스마다 파일명을
따로 짓거나 디렉터리를 나눠 놓기 때문이다. 두 출처가 다른 말을 하거나, 프로젝트 파일 둘이 한
realm 을 서로 다른 데 두거나, 아무 Rojo 프로젝트도 싣지 않는 패키지 디렉터리가 있으면 그걸
알려준다. Roblox 는 경로가 틀리면 `Requested module experienced an error while loading` 만
뱉고 어느 경로가 틀렸는지는 말해주지 않는다. 그래서 이 검사를 여기서 해야 한다.

### 레지스트리

| | |
|---|---|
| `rarn search <query>` | 레지스트리 검색 |
| `rarn info <pkg>[@ver]` | 버전, realm, 라이선스, 의존성 |
| `rarn login` / `logout` / `whoami` | GitHub device flow. 토큰은 레지스트리별로 따로 |
| `rarn pack` | `publish` 가 올릴 아카이브를 만들어봄. `--list`, `-o <file>` |
| `rarn publish` | 업로드. `--dry-run` |

### 어디서나

`--cwd <path>` · `--verbose` · `--silent` · `--no-color` · `--offline`, 그리고 읽기 명령
대부분에 `--json`.

`--offline` 은 네트워크를 슬쩍 쓰는 대신 아예 못 쓰게 막는다. 락파일이 최신이고 캐시가
따뜻하면 설치에 네트워크가 필요 없으니 이 옵션은 손해가 없고, "어쩌다 네트워크가 안 필요했다"
를 "네트워크를 못 쓴다"로 바꿔준다. 기차 안에서 필요한 건 후자다. 셸 하나나 CI 잡 전체에
걸고 싶으면 `RARN_NO_NETWORK=1` 을 쓰면 된다.

종료 코드는 `0` 정상, `1` 프로젝트나 인자 문제, `2` 레지스트리나 네트워크 문제다. 에러에는
고정된 코드가 붙는다. 주변 문구가 어떻게 바뀌든 `RN0210` 은 계속 같은 뜻이다.

숫자만 봐도 어느 계층인지 알 수 있고, 대개 그것만으로 누구 문제인지 짐작이 간다.

| | |
|---|---|
| `RN00xx` | CLI, 또는 `rarn.json` |
| `RN01xx` | 레지스트리나 네트워크 |
| `RN02xx` | 해석 — 충돌, realm, 순환 |
| `RN03xx` | 캐시, 다운로드, 아카이브 |
| `RN04xx` | 프로젝트 파일 해석, 트리 쓰기 |
| `RN05xx` | `rarn.lock` |
| `RN06xx` | 인증, 패킹, 발행 |
| `RN07xx` | `wally.toml` 가져오기 |

전체 목록은 `src/util/codes.ts` 에 있다. 한 번 나간 코드는 다른 뜻으로 재활용하지 않고,
퇴역시킨 코드도 지우지 않는다. 그래서 번호로 검색하면 언제 하든 한 가지가 나온다.

## 매니페스트

```jsonc
{
  "name": "@you/your-game",
  "version": "0.1.0",
  "realm": "shared",

  "dependencies":       { "@sleitnick/knit": "^1.7.0" },
  "serverDependencies": { "@evaera/promise": "^4.0.0" },
  "devDependencies":    { "@roblox/testez":  "^0.4.1" },

  // 두 의존자가 호환 안 되는 major 를 요구할 때 버전을 하나로 못 박는다.
  // Roblox 에서는 편의 기능이 아니다. 안 하면 ModuleScript 사본이 두 개 생긴다.
  "resolutions": { "@evaera/promise": "4.0.0" },

  // server 나 dev 패키지가 shared 패키지를 쓸 때만 필요하다.
  "place": { "sharedPackages": "game.ReplicatedStorage.Packages" }
}
```

범위는 npm 표기를 쓴다. `^1.2.3`, `~1.2.3`, `>=1.2.0 <2.0.0`, `1.2.x`, `*`, `||`.

**Wally 는 Cargo 표기를 쓰는데, 두 군데가 다르다.** `,` 가 AND 구분자라는 것, 그리고 맨
버전이 캐럿 요구사항이라는 것. Cargo 는 `1.0.0` 을 `^1.0.0` 으로 읽지만 npm 은 딱 그 버전으로
읽는다. 둘 다 조용히 어긋나기만 하고 에러를 안 내니까, 짐작하지 않고 명시적으로 변환한다.
`rarn import` 는 `red-blox/spawn@1.0.0` 을 `^1.0.0` 으로 바꾸는데, 레지스트리가 그 줄에 대해
실제로 저장해 둔 값이 그거다. 반대로 `rarn publish` 는 Cargo 로 표현 못 하는 범위를 슬쩍
넓히는 대신 그냥 거절한다.

## 설치 결과의 모양

```
RARN_MODULE/                        <- shared
  Promise.luau                      <- shim. 직접 의존성만 여기 나온다
  _Index/
    evaera_promise@4.0.0/
      promise/                      <- 진짜 소스. 딱 한 벌
        init.luau
    sleitnick_knit@1.7.0/
      knit/
      Promise.luau                  <- shim. 소스 폴더 옆에 나란히
RARN_MODULE_SERVER/                 <- server realm, 같은 모양
RARN_MODULE_DEV/                    <- dev realm, 같은 모양
```

```lua
-- RARN_MODULE/Promise.luau
return require(script.Parent._Index["evaera_promise@4.0.0"]["promise"])
```

**이 모양은 고른 게 아니라 어쩔 수 없는 거다.** 패키지 소스에는
`require(script.Parent.Parent.Alias)` 가 하드코딩돼 있다. 그러니 의존성 shim 은 그 패키지
소스 폴더와 형제로 앉아 있어야 한다. 안 그러면 그 호출이 `nil` 을 물어온다.

**shim 이 패키지 타입까지 넘겨주니까 `--!strict` 가 된다.** Luau 는 링크 너머로 값만
넘겨주고 타입 alias 는 안 넘긴다. Wally 링크로 받은 React 에서 `createElement` 는 되는데
`React.Node` 는 안 되는 게 그래서다. Rarn 은 엔트리 모듈이 내보내는 걸 읽어서 다시 내보낸다.

```lua
-- Packages/React.luau
local Module = require(script.Parent._Index["jsdotlua_react@17.2.1"]["react"])

export type Node = Module.Node
export type PureComponent<Props, State = nil> = Module.PureComponent<Props, State>

return Module
```

많이 쓰이는 584개 패키지 중 300개가 이렇게 타입을 내보낸다. **확실하게 못 읽은 건 짐작하지
않고 그냥 뺀다.** 빠진 alias 는 어차피 손으로 쓰려던 주석 하나 더 쓰면 그만이지만, 잘못 넘긴
건 쓴 적도 없는 생성 파일에 에러를 박아 넣는 거라 성격이 다르다. 타입을 안 내보내는 패키지는
예전처럼 한 줄짜리 shim 그대로다.

**여기서 중복은 디스크 낭비가 아니라 버그다.** Roblox 의 `require` 는 Instance 를 받고
ModuleScript 인스턴스 단위로 캐시한다. 그래서 같은 패키지가 두 벌 깔리면 상태가 따로 노는
모듈 두 개가 되고, 안에 있던 싱글턴이 조용히 둘로 갈라진다. 한 버전으로 해석된 패키지들은
`_Index` 폴더 하나를 같이 쓴다. 규칙으로 지키는 게 아니라 구조로 강제하는 셈이다.

realm 은 서로 형제고 절대 중첩되지 않는다. 각각 다른 Roblox 서비스에 동기화되기 때문이다.
shim 은 한 realm 안에서만 상대 경로로 걸을 수 있으니, shared 패키지를 쓰는 server 패키지에는
절대 DataModel 경로가 필요하다. `place` 가 그것 때문에 있다. 그리고 `shared` 패키지는
`shared` 패키지만 쓸 수 있다. shared 코드는 클라이언트로 복제되니까 shared→server 로 가는
간선은 런타임에 깨진다.

**형제 둘의 이름은 `packageDir` 에서 나온다.** 뒤에 `_SERVER` 와 `_DEV` 를 붙인다.
`packageDir` 을 `Packages` 로 두면 `Packages/`, `Packages_SERVER/`, `Packages_DEV/` 가 된다.
따로따로 설정할 수는 없고, 무엇을 썼는지는 `rarn install` 이 출력해 준다.

셋 다 Studio 까지 가려면 Rojo 항목이 있어야 하는데, `place` 가 필요한 건 둘뿐이다.

| 디렉터리 | 어디에 마운트 | `place` 항목 |
|---|---|---|
| `Packages/` | shared 코드 있는 곳, 보통 `ReplicatedStorage` | `sharedPackages` |
| `Packages_SERVER/` | 서버 전용 서비스, 보통 `ServerScriptService` | `serverPackages` |
| `Packages_DEV/` | 아무 데나. 테스트 돌리는 프로젝트 파일에 | 없음 — 아래 참고 |

`place.devPackages` 는 없고, 표에서 빠진 세 번째도 없다. 패키지는 그걸 요구한 realm 중 가장
넓은 곳에 놓인다. 그러니 dev 에 놓인 패키지를 누가 require 한다면 그 순간 이미 dev 밖으로
끌려 나왔을 것이고, 결국 dev 안쪽으로 절대 경로를 뻗을 일이 없다. 나머지 둘은 그럴 일이 있고,
`place` 는 그것 하나 때문에 있다.

## 속도

네트워크를 쓰는 단계는 해석뿐이다. 가져오기는 전역 캐시를 읽고 링크는 전부 로컬이라, 락파일만
최신이면 재설치는 통째로 오프라인이다.

| | 5패키지 그래프 |
|---|---|
| 콜드, 캐시 없음 | ~2.0 s |
| 캐시 있고 락파일 최신 | **~65 ms** |

콜드 쪽은 대부분 네트워크 시간이라 당신 환경에선 다르게 나온다. 자랑할 만한 건 따뜻한 쪽이고,
요청을 아예 안 보내기 때문이다.

캐시는 아카이브만 들고 있는 게 아니라 압축을 푼 트리까지 들고 있다. 그래서 따뜻한 설치는
네트워크도 안 타고 unzip 도 안 한다. 하드링크가 아니라 복사인데, 한 프로젝트에서 고친 게
캐시를 공유하는 다른 프로젝트로 번지면 안 되기 때문이다.

### 506개 실제 패키지로 Wally 와 비교

라이브 레지스트리에서 다른 패키지가 자주 의존하는 순으로 506개를 골랐고, 전이 의존성까지
합치면 575개다. Windows 11, Bun 1.3.14, Wally 0.3.2 기준. 방법과 다른 크기 집합, 어떻게
골랐는지는 [test/benchmark](test/benchmark/README.md) 에 있다.

| | rarn | wally |
|---|---:|---:|
| 설치, 캐시 있음 | **4.0 s** — 네트워크 안 씀 | 10.0 s — 575개 전부 다시 받음 |
| 설치, 캐시 없음 | 38.0 s | 10.0 s |
| 이 머신에서 처음 | 38.0 s | 10.0 s **+ 12 s** 인덱스 clone (46 MB, `git` 필요) |
| 쓴 파일 | **7,050** | 12,961 |
| 쓴 바이트 | **43.6 MB** | 107.9 MB |
| Rojo 없이 풀리는 모듈 루트 | **548 / 556 (98.6%)** | 148 / 575 (25.7%) |
| 링크 너머로 타입이 닿나 | **닿는다** | 안 닿는다 — 호출부마다 `Unknown type` |

웜은 5회의 중앙값이고 콜드는 1회다. 전체 표는 칸마다 산포와 표본 수를 달고 있고 원자료도
옆에 커밋돼 있다. **콜드 숫자를 다른 날 잰 것과 비교하면 안 된다** — 콜드 설치의 절반 넘게가
레지스트리를 기다리는 시간이라, 차이는 대개 도구가 아니라 네트워크다.

저 표가 감추지 않는 것 셋.

- **콜드 설치는 Wally 가 이긴다.** 레지스트리 인덱스를 미리 clone 해 두니까 해석에 네트워크가
  안 든다. Rarn 은 HTTP 로 물어본다. `git` 없이 돌아가고 46 MB clone 을 안 들고 다니는 값이라고
  보면 된다.
- **Wally 에는 패키지 캐시가 없다.** 인덱스만 캐시하니까 설치할 때마다 아카이브를 전부 다시
  받는다. 저 열에 숫자가 하나뿐인 이유고, 차이가 제일 크게 나는 데가 CI 인 이유다.
- **마지막 줄은 속도 얘기가 아니다.** Wally 설치는 동기화할 때 Rojo 가 각 패키지 안의 프로젝트
  파일을 다시 읽어주기를 전제하니까, 모듈 폴더 넷 중 셋에는 루트에 `init` 이 없다. Rarn 은 그
  일을 설치할 때 해둔다. **Wally 는 되는데 Rarn 은 안 되는 패키지는 없었다.**

벤치마크를 만들다가 이미 나간 결함 둘이 튀어나왔다. 작은 그래프에서는 안 보이는 것들이다.
512 KiB 넘는 파일이 든 아카이브를 아예 못 풀던 것, 그리고 해석이 패키지마다 소켓을 하나씩 열던
것. 둘 다 고쳤고 자세한 건 CHANGELOG 에 있다.

**락파일이 최신인지 판정할 때는 일부러 한쪽으로 기울여 둔다.** 멀쩡한 락파일을 낡았다고 하면
왕복 한 번 손해다. 낡은 걸 멀쩡하다고 하면 매니페스트가 더는 요구하지 않는 버전을 깔아놓고
성공했다고 말한다. 모든 비교는 낡은 쪽으로 기운다.

## `rarn doctor`

설치된 Luau 를 훑어서 모듈 루트 밖으로 나가는 require — 즉 shim 을 거쳐 풀리는 것들 — 을
찾아내고, 선언된 의존성과 대조한다.

```
@scope/example@1.0.0
  requires NotDeclared — not a declared dependency
    RARN_MODULE/_Index/scope_example@1.0.0/example/init.lua:13  resolves to nil at runtime

  scanned 20 files across 5 packages
  10 requires are built at runtime and could not be checked
```

의존성이 빠졌으면 `1` 로 끝내고, 안 쓰는 선언은 경고만 한다. 넉넉하게 적어둔 매니페스트가
뭘 깨뜨리진 않으니까. 정적으로 못 푸는 require 는 숨기지 않고 세어서 알려준다. 얼마나 못
봤는지 감추는 검사는 실제보다 꼼꼼해 보이기 마련이다.

한 번의 조회를 Roblox 가 받아주는 표기가 넷인데, 넷 다 읽는다. 패키지들이 실제로 넷 다 쓰고,
둘만 아는 스캐너는 차라리 없느니만 못하다.

```lua
require(script.Parent.Parent.Promise)                 -- 인덱싱
require(script.Parent.Parent["Promise"])              -- 대괄호
require(script.Parent.Parent:WaitForChild("promise")) -- 레지스트리의 JS 포팅 계열
require(script.Parent.Parent:FindFirstChild("promise"))
```

세 번째는 드문 경우가 아니다. `jsdotlua/*` 패키지들 — react-lua, jest-lua, luau-polyfill —
이 오직 저 표기만 쓴다. 그래서 52패키지짜리 React 프로젝트에서 **1663건 중 1655건**을 못 읽고
있었고, 그게 전부 "선언해놓고 안 쓴다"는 엉뚱한 보고로 되돌아 나왔다. 지금은 10건이다.

변수를 거친 require 도 따라간다. 생태계에서 제일 많이 쓰이는 프레임워크가 이렇게 하기
때문이다.

```lua
KnitClient.Util = (script.Parent :: Instance).Parent
local Promise = require(KnitClient.Util.Promise)   -- 이것도 찾는다
```

## 발행

```bash
rarn login              # GitHub device flow, read:user 만
rarn pack --list        # 뭐가 올라갈지 미리 본다
rarn publish --dry-run  # 업로드만 빼고 전부
rarn publish
```

레지스트리는 올라온 아카이브 안의 `wally.toml` 을 읽어서 패키지 이름과 버전을 알아낸다.
그래서 Rarn 이 `rarn.json` 을 보고 하나 만들어 넣는다. 저장소에 체크인해 둔 사본이 그걸
가리는 일은 없다.

`.env`, `*.key`, `*.pem` 과 realm 디렉터리들은 기본으로 빠지고, `_Index/` 를 품은 디렉터리도
전부 빠진다. 그건 다른 패키지 매니저의 설치 트리인데, 남이 그 디렉터리를 뭐라고 불렀는지는
알 수 없으니 이름이 아니라 모양으로 알아본다. 발행한 버전은 영구적이고 공개되며 취소가 안
된다. 파일 하나 빠뜨리면 설치가 깨지지만 몇 분이면 고친다. 하나 더 들어가면 되돌릴 방법이
없다. `include` 에 파일명을 정확히 적으면 기본 제외를 덮어쓸 수 있고, 글롭으로는 안 된다.

## 쓰고 계신가요

**[여기에 한 줄만 남겨 주세요.](https://github.com/Hawakiki/roblox-rarn/issues/47)** 10초면
되고, 링크 없어도 되고, 비공개 프로젝트도 똑같이 셉니다. 밖에서 보면 *아무도 안 써봤다* 와
*쓰는데 말을 안 한다* 가 똑같이 생겼는데, 1.0 에서 매니페스트와 락파일 포맷이 동결됩니다.
아무도 안 써본 포맷을 동결하는 건 찍는 거라, 그 시점이 왔는지를 저 스레드가 알려줍니다.

버그나 아이디어는 새 이슈로 올려 주세요. 저건 출석부입니다.

## 개발

```bash
bun test                 # 전체
bun run check            # format + lint + typecheck + test, 이 순서로
bun run src/cli.ts <..>  # 빌드 없이 CLI 실행
```

`bun run check` 가 pre-commit 훅이 돌리는 것이다.

Roblox 쪽 검증은 별개고 `rokit.toml` 에서 온다.

```bash
lune run tests/roblox/verify.luau -- <install-dir> [<realm>] [--mount=<path>=<dir>]... [--execute]
```

Roblox 의 `require` 를 다시 구현한 것이다. 인스턴스로 찾고 인스턴스 단위로 캐시한다. 실제
설치 트리 위에서, 파일 트리 비교로는 못 하는 두 가지를 묻는다. 모든 shim 이 진짜
ModuleScript 에 닿는가, 그리고 **두 경로로 찾아간 패키지가 같은 인스턴스로 돌아오는가.**
사본 두 개는 디스크에서 똑같이 생겼고 런타임에 가서야 갈라진다. `bun test` 가 합성 트리로
자동으로 돌리고, 일부러 망가뜨린 트리 셋도 같이 돌린다. 아무것도 못 잡는 하니스는 있으나
마나니까.

realm 을 건너는 shim 은 절대 DataModel 경로를 쓴다. 그래서 대조할 대상이 있으려면 형제
realm 을 `--mount` 로 걸어줘야 한다. 안 걸면 실패가 아니라 *not verified* 로 보고한다.
2026-08-22 전까지는 멀쩡한 shim 을 망가진 걸로 보고했었다.

모델은 실제 Studio 에 한 번 대조해 봤다. `test/roblox/` 를 `rojo build` 한 위에서 검사 17개를
돌렸고 Studio 가 전부 같은 답을 냈다. 제일 중요한 둘 — 한 소스의 사본 두 개는 테이블 두 개고,
한 인스턴스를 두 번 require 하면 테이블 하나라는 것 — 도 포함해서다.
`tests/roblox/emulate-selftest.luau` 는 질문이 다르다. **모델이 자기가 말한 대로 동작하는가.**
결함 둘이 딱 그 틈에 숨어 있었다.

물론 이게 `test/roblox/` 를 대신하진 않는다. 하니스가 증명하는 건 트리가 Roblox 의 *모델*
아래서 앞뒤가 맞는다는 것뿐이다. 모델이 틀리면 하니스는 통과하고 Studio 가 깨진다. 패키지
코드는 `--execute` 를 안 주면 실행되지 않고, 줘도 엔진은 없다. `Enum`, `Instance.new`,
`task`, `RunService` 는 일부러 모델 밖에 뒀다. 스텁을 하나 늘릴 때마다 *통과했는데 사실은
틀린* 영역이 그만큼 넓어지기 때문이다.

## 라이선스

MIT. 전문은 [LICENSE](LICENSE) 에 있다.
