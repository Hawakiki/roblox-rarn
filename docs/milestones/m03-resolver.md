> PLAN.md §2 에서 2026-08-21 에 이관한 기록이다. 완료 시점의 실측을 보존한다.
> 문서 경로 참조만 이관 시점 구조에 맞게 고쳤고, 내용은 편집하지 않는다.

# M3 — 리졸버 ✅

Wally의 리졸버는 **탐욕적 + 백트래킹 없음**이라 큐 순서에 결과가 좌우되고,
`^1.2.0` 과 `^1.5.0` 처럼 명백히 풀리는 조합에서도 실패할 수 있다
(상세: [docs/research/wally-internals.md](docs/research/wally-internals.md) 2절).

**"major당 한 버전" 정책은 그대로 유지하되, 알고리즘을 순서 독립적으로 만든다.**
버전을 하나라도 고르기 전에 제약을 전부 모으는 게 핵심이다.

**고정점 반복**으로 푼다. 매 회차마다 제약을 **처음부터 다시 쌓는다.**

```
chosen = {}
반복:
    constraints = rarn.json 의 직접 의존성
    for (이름, 버전들) in chosen:                 # 선택된 버전의 의존성만 펼친다
        for 버전 in 버전들:
            for (별칭, 요구) in 버전.dependencies:
                constraints[요구.이름] += (출처=버전, 범위=요구.범위)

    next = {}
    for 이름 in constraints:                      # 이름별로 독립적으로 푼다
        후보 = 메타데이터(이름).versions
        resolutions 에 있으면 그 버전으로 고정
        next[이름] = solve(후보, constraints[이름])

    if next == chosen: 끝
    chosen = next
```

**왜 매번 다시 쌓나.** 증분으로 제약을 더하면 어떤 버전이 탈락했을 때 *그 버전이 기여했던
제약*을 정확히 걷어내야 하는데, 그 부기가 틀리기 쉽고 틀리면 과도 제약이 되어 조용히
엉뚱한 버전을 고른다. 매 회차 재구축은 그 문제가 원천적으로 없다. 메타데이터는 전부
캐시되므로 재구축 비용은 사실상 0이다.

> **이전 계획을 정정했다.** 원래는 "범위에 맞는 *모든 후보*의 의존성을 큐에 넣고 나중에
> 추린다"였는데, 범위 하나가 20개 버전에 걸리면 20개 전부의 전이 의존성을 캐게 되어
> 조합적으로 터진다. 선택된 버전의 것만 펼치고 반복하는 쪽이 단순하면서 정확하다.

**수렴.** 실전에서는 그래프 깊이 + 1회 안에 멈춘다. 다만 이론적으로는 진동이 가능하다 —
버전이 내려가면 그 의존성이 달라지고, 그래서 다른 곳의 제약이 사라져 또 다른 버전이
올라갈 수 있다. **회차 상한을 두고 초과하면 내부 오류로 실패**시킨다. 조용히 아무 답이나
내놓는 것보다 낫다.

- [x] `resolver/types.ts` — placement 규칙, realm 유효성
- [x] `resolver/select.ts` — 범위 그룹핑, 버전 선택
- [x] `resolver/resolve.ts` — 고정점 루프, placement 완화(relaxation)
- [x] `resolver/conflict.ts` — 충돌 시 **누가 뭘 요구했는지** 출력

```
X @evaera/promise 를 하나의 버전으로 통합할 수 없습니다

    ^3.2.0  <- @nevermore/signal@2.1.0 이 요구
    ^4.0.0  <- rarn.json 이 직접 요구

  두 범위는 겹치지 않아 각각 설치됩니다.
  두 사본은 런타임에 서로 다른 모듈이 되어 싱글톤이 깨질 수 있습니다.
  -> @nevermore/signal 을 올릴 수 있는지 확인하세요.
```

- [x] 순환 의존성은 자연히 종료된다 (고정점이라 별도 감지 불필요)
- [x] pre-release 는 범위가 명시적으로 언급한 경우에만 후보에 들어간다

M3 상태: **178 tests pass / eslint clean / tsc clean / biome clean.**

**완료 기준 달성 — 실서버:**

```
=== knit 하나 ===   5 packages in 1108ms
  @evaera/promise@4.0.0     shared
  @sleitnick/comm@1.0.1     shared  Option->@sleitnick/option@1.0.5 Promise->@evaera/promise@4.0.0 Signal->@sleitnick/signal@2.0.3
  @sleitnick/knit@1.7.0     shared  Comm->@sleitnick/comm@1.0.1 Promise->@evaera/promise@4.0.0
  @sleitnick/option@1.0.5   shared
  @sleitnick/signal@2.0.3   shared

=== 만족 불가 범위 ===
RN0200: No published version of evaera/promise satisfies every requirement.
  ^99.0.0              <- rarn.json (direct dependency)
  published: 4.0.0, 4.0.0-rc.2, 3.2.1, 3.2.0, 3.1.0
```

**구현하며 잡은 것 3가지:**

1. **`assemble` 이 `chosen` 을 순회하고 있었다.** 해석에 실패한 패키지는 `chosen` 에
   애초에 안 들어가므로, 에러를 내는 대신 **조용히 빠진 채 설치가 성공**했다.
   선언한 의존성이 사라지는데 아무 말도 안 하는 것 — 제약(constraints)을 순회하도록 고쳤다.
2. **중복 판정이 `semver.major` 를 쓰고 있었다.** 셀렉터는 `areCompatible` 을 쓰는데
   둘이 `0.x` 에서 갈린다. `0.2.0` 과 `0.3.0` 은 major 가 같지만 호환되지 않는다.
   정상적인 조합을 "Rarn 버그" 로 보고하고 있었다. 같은 정책은 한 함수만 써야 한다.
3. **충돌 메시지가 모든 요구자를 모든 버전 아래에 나열**하고 있었다. 그 버전이 실제로
   만족시키는 요구자만 보여주도록 고쳤다.

**placement 는 완화(relaxation)로 푼다.** 간선은 요청자의 placement 를 물려받는데
요청자의 placement 는 자기를 가리키는 간선들이 정한다 — 순환이다. 가장 좁은 realm 에서
시작해 변화가 없을 때까지 넓히면 3단계 안에서 단조 증가하므로 반드시 멈춘다.
