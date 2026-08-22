# M2 — 별칭 충돌 정책 확정

> 완료 시점의 사실만 담고 이후 편집하지 않는다 — 링크 수정만 예외.

**완료:** 2026-08-22
**결정:** 별칭은 **매니페스트 섹션 하나 안에서만** 유일하면 된다. 그것이 shim 경로가
갈리는 단위다.

---

## 무엇이 문제였나

R2 가 `assertNoAliasCollisions` 를 두고 *"레이아웃이 요구하는 것보다 엄격하고 문서에 없다"*
고 적었다. 그것을 확정하는 것이 M2 였다 — 매니페스트 필드의 의미가 걸려 있으므로 포맷 동결
전에 결론이 나야 했다.

## 측정

세 경우를 실제로 설치해 봤다.

| 경우 | shim 이 가는 곳 | 수정 전 | 맞나 |
|---|---|---|---|
| 같은 섹션, 다른 패키지, 같은 별칭 | **같은 파일** | `RN0030` | ✅ |
| 다른 섹션, 다른 패키지, 같은 별칭 | 다른 파일 | `RN0030` | ❌ 과함 |
| 같은 패키지를 두 섹션에 | 다른 파일 | `RN0030` | ❌ **틀림** |

`writeRootShims` 는 매니페스트 **섹션별로** 루트 shim 을 쓴다 — `dependencies` 는 shared realm
디렉터리로, `serverDependencies` 는 server 로, `devDependencies` 는 dev 로. 그런데 검사는 세
섹션을 한 통에 넣고 있었다.

세 번째가 특히 나쁘다. `writeRootShims` 의 주석이 *"a package declared in two sections should be
reachable from both realm directories even though it is only stored once"* 라고 그 동작을 명시하는데,
합쳐 세는 검사가 그것을 **자기 자신과의 충돌**로 읽어 링커의 문서화된 동작을 도달 불가능하게
만들고 있었다.

## 결정과 근거

**섹션 단위.** 위험은 두 shim 이 같은 경로에 쓰이는 것 하나뿐이고, 그것은 같은 섹션에서만
일어난다. 더 넓게 잡으면 레이아웃이 허용하는 것을 거절하게 된다.

수정 후 측정:

```
shared @evaera/promise + server @jsdotlua/promise
  installed 2 packages into RARN_MODULE, RARN_MODULE_SERVER
  RARN_MODULE/Promise.luau
  RARN_MODULE_SERVER/Promise.luau          <- 다른 파일, 다른 패키지

@evaera/promise 를 dependencies + devDependencies 에
  installed 1 packages into RARN_MODULE, RARN_MODULE_DEV
  _Index 사본: shared 1, dev 0
  RARN_MODULE_DEV/Promise.luau
    -> require(game.ReplicatedStorage.Packages._Index["evaera_promise@4.0.0"]["promise"])
```

두 번째가 요점이다 — **패키지는 한 벌이고 두 realm 에서 도달한다.** 제약 1 이 그대로 지켜진다.

## 하지 않기로 한 것

**섹션이 다르지만 같은 별칭일 때 경고하지 않는다.** `Promise` 가 realm 마다 다른 패키지를
뜻하는 것은 헷갈릴 수 있지만, Roblox 에서는 서비스 경로로 require 하므로 애초에 갈라져 있다.
그리고 매니페스트 검증기에는 경고 채널이 없다 — 드문 경우 하나 때문에 채널을 만드는 것은
값에 비해 결합이 크다.

## 폭이 왜 중요한가

벤치마크에서 측정한 것: 가장 많이 쓰이는 패키지 506개 중 **40개 별칭이 둘 이상의 패키지를
가리킨다.** `React` 는 `jsdotlua`·`haedrix`·`core-packages` 가 각각 낸다. 실제 프로젝트는
의존성 스무 개, 서른 개쯤에서 이것을 밟는다 — 다섯 개에서가 아니라.

## 남긴 것

에러 메시지가 섹션 이름을 말한다. 같은 별칭이 다른 섹션에서는 괜찮으므로 *"2 packages would
both be installed as 'Promise'"* 만으로는 어디를 고쳐야 하는지 알 수 없다.

규칙을 CLAUDE.md 의 Naming 에 적었다. R2 가 지적한 "문서에 없다" 가 닫혔다.
