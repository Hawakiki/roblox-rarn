# test/roblox — Studio 검증장

두 층으로 검증한다. **여기는 두 번째 층이다.**

| 층 | 무엇을 증명하나 | 자동화 |
|---|---|---|
| `tests/roblox/verify.luau` (Lune) | 트리가 Roblox 규칙대로 해석되는가, dedupe가 진짜 되는가 | **O** — `bun test` |
| **이 폴더** (Rojo + Studio) | 그게 **실제 엔진에서도** 그런가 | X — 수동 1회 |

Lune 하니스는 Roblox의 require 의미론을 **재구현**한 것이다. 트리가 그 모델 아래에서
일관됨을 증명하지, 엔진에서 그렇다는 걸 증명하지 않는다. 모델이 어딘가 틀렸다면
하니스는 통과하고 Studio는 깨진다 — 재구현이 지는 위험이 정확히 그것이므로 둘을 분리해 둔다.

## 실행

```bash
cd test/roblox
rarn install          # RARN_MODULE/ 생성
rojo serve            # Studio 연결
                      # Studio 에서 Play -> 출력 확인
```

## 이 검증장이 잡는 것

`src/verify.server.luau` 는 Lune 하니스가 **답할 수 없는** 것만 확인한다:

- `Promise.new(...):andThen(...)` 가 실제로 동작하는가 — 패키지 코드가 엔진에서 도는가
- `Knit.Util` 이 진짜 Instance 인가 — [R1 연구](../../docs/pnp-feasibility.md)에서 확인한
  대로 shim 파일의 물리적 존재가 관측 가능한 API 표면이라는 사실

나머지 (트리 모양, dedupe 동일성)는 Lune 쪽에서 이미 매번 자동으로 돈다.

## 언제 돌려야 하나

링커를 건드릴 때마다. 그 외에는 Lune 하니스로 충분하다.
