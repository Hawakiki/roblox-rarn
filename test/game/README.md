# test/game — 일부러 과하게 만든 프로젝트

**목적: 스키마 필드를 실제로 써 보는 것.** 동결(M4b) 전에 필요한 것이 이것이다 — 필드 대부분이
단위 테스트에서만 쓰였고 한 프로젝트 안에서 **동시에** 쓰인 적이 없었다.

`test/roblox/` 와 역할이 다르다. 그쪽은 Studio 에서 눈으로 보는 **최소** 검증장이라 작게
유지한다. 여기는 그 반대다.

```bash
bun run src/cli.ts install --cwd test/game
```

산출물과 락파일은 커밋하지 않는다 (`test/roblox/` 와 같은 규칙). 매니페스트와 프로젝트
파일만 남는다.

---

## 무엇이 이 매니페스트에 왜 있나

| 필드 | 무엇으로 밟나 | 무엇을 증명하나 |
|---|---|---|
| `packageDir` | `"Packages"` (기본값 아님) | 이름이 Wally 의 것과 같아도 설치가 옳게 돈다 |
| `place.sharedPackages` | **`"...Shared Packages"` — 공백 있음** | 점이 닿지 못하는 세그먼트를 shim 이 대괄호로 감싼다 |
| `place.serverPackages` | 크로스 realm 링크가 실제로 필요 | 절대 DataModel 경로가 생성된다 |
| `dependencies` | 5개, 그래프 깊음 | |
| `serverDependencies` | `@sleitnick/comm` | **배치가 넓어지는 것**을 밟는다 — 아래 참조 |
| `devDependencies` | `@roblox/testez` | 세 번째 realm 디렉터리가 생긴다 |
| `aliases` | `@sleitnick/knit` → `Framework` | 파생 이름을 덮어쓴다 |
| `resolutions` | `@csqrl/sift` → `0.0.8` | 해결 불가 충돌의 유일한 탈출구 |
| `private` | `true` | 게임이므로 `publish` 가 거부해야 한다 |

**밟지 못하는 것: `include` / `exclude`.** 발행 시점에만 쓰이는데 이 프로젝트는 `private` 이라
`publish` 가 애초에 거절한다. 그 둘은 `tests/publish.test.ts` 가 맡는다.

## 일부러 만든 상황 셋

**1. 배치가 넓어진다.** `@sleitnick/comm` 은 `serverDependencies` 에 있지만 `@sleitnick/knit`
(shared) 도 그것을 요구한다. 배치는 가장 넓은 요구자로 정해지므로 comm 은 **shared 에 저장되고**,
`Packages_SERVER/` 에는 그것을 가리키는 크로스 realm shim 하나만 남는다.

```
Packages_SERVER/
  Comm.luau  ->  require(game.ReplicatedStorage["Shared Packages"]._Index["sleitnick_comm@1.0.1"]["comm"])
```

`_Index` 가 없는 realm 디렉터리는 **정상**이다. 하니스가 이것을 실패로 보고 있었고 이 픽스처가
찾아냈다.

**2. 해결 불가 충돌.** `@joelbrd/table` 이 `csqrl/sift` 를 `>=0.0.8 <0.0.9` 로 묶는데 직접
의존은 `^0.0.11` 이다. 교집합이 비어 `RN0200` 이 나고, 에러가 제안하는 `resolutions` 를 그대로
적으면 설치된다. **에러 메시지의 조언이 실제로 통하는지**가 여기서 검증된다.

```
override @csqrl/sift pinned to 0.0.8 by "resolutions"
```

**3. 합법 중복.** `@b-j-roberts/starknet-luau` 는 promise 3 을, knit 는 promise 4 를 요구한다.
major 가 다르므로 둘은 **공존해야 한다** — 제약 5 가 금지하는 것은 *호환* 중복뿐이다.

```
duplicate @evaera/promise installed at 4.0.0 and 3.2.1
```

## 검증

```bash
# shared realm
lune run tests/roblox/verify.luau -- test/game/Packages Packages

# server / dev — 크로스 realm shim 이 있으므로 마운트가 필요하다
lune run tests/roblox/verify.luau -- test/game/Packages_SERVER Packages_SERVER \
  "--mount=game.ReplicatedStorage.Shared Packages=test/game/Packages"

# Rojo 가 place 를 정말 그 자리에 짓는지
cd test/game && rojo sourcemap | grep _Index
```

`default.project.json` 은 게임 place, `test.project.json` 은 테스트 place 다. 둘이 같은 realm 을
**같은 DataModel 경로에** 마운트하므로 파생이 갈리지 않는다 — 갈리면 Rarn 은 파생을 포기하고
그 사실을 출력한다.

## 이것이 증명하지 않는 것

**실사용이 아니다.** 이 매니페스트는 도구의 제약을 전부 아는 사람이 썼다. 모르는 사람이
걸어들어갈 길 — 문서를 대충 읽고, 에러 메시지 하나로 다음 수를 정하고, 막히면 다른 도구로
돌아가는 길 — 은 여기서 밟히지 않는다.

1.0 게이트가 "우리 밖 프로젝트" 를 요구하는 이유가 그것이고, 이 폴더는 그 게이트를 닫지 못한다.
