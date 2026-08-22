> PLAN.md §2 에서 2026-08-21 에 이관한 기록이다. 완료 시점의 실측을 보존한다.
> 문서 경로 참조만 이관 시점 구조에 맞게 고쳤고, 내용은 편집하지 않는다.

# M1 — 매니페스트 ✅

- [x] `manifest/types.ts` — 스키마의 TS 미러 + realm 디렉터리 규칙
- [x] `manifest/validate.ts` — **2단 검증** (ajv 형태 + 의미)
- [x] `manifest/read.ts` — 읽기, 기본값 채우기, 이름 제안
- [x] `manifest/write.ts` — 필드 순서 고정, 의존성 정렬, 미지 필드 보존
- [x] `cli/commands/init.ts` — 대화형/`-y`/`--force`, `.gitignore` 갱신
- [x] `util/fs.ts` — 중복됐던 `isNotFoundError` / `pathExists` 추출

M1 상태: **120 tests pass / eslint clean / tsc clean / biome clean.**

**검증 2단 구조.** JSON Schema는 형태만 본다. `^^4` 가 진짜 semver 범위인지,
두 패키지가 같은 shim 이름을 만드는지, `resolutions` 값이 범위가 아닌지는
스키마가 표현할 수 없다. 스키마는 "패턴 불일치"까지밖에 말 못 하지만 의미 검사는
어느 두 패키지가 부딪혔고 뭘 고쳐야 하는지 말할 수 있다.

**예외:** 버전 형태만은 의미 검사를 ajv **앞에** 돌린다. 스키마에도 semver 패턴이
있어서 그냥 두면 스키마가 먼저 잡고 "형태가 틀렸다"고만 말한다. `resolutions` 는
*왜* 범위가 거부되는지가 답의 핵심이라 그걸 잃으면 안 된다. 스키마 패턴은
에디터 자동완성용으로 남기고, CLI에서는 더 나은 메시지가 이긴다.

**완료 기준 달성 — 실제 출력:**

```
RN0021: dependencies["@evaera/promise"] is '^^4', which is not a valid version range.
  at .../rarn.json

Use a range such as '^4.0.0', '~1.2.3', '>=1.0.0 <2.0.0', or '*'.
```

```
RN0030: 2 packages would both be installed as 'Promise'.
  at .../rarn.json

  @a/promise
  @b/promise

Give one of them a different name under "aliases", for example:
  "aliases": { "@a/promise": "Promise2" }
```

> 매니페스트 에러를 사용자가 실제로 보게 되는 건 M8부터다. 지금은 `init` 만
> 구현돼 있고 그건 매니페스트를 읽지 않는다. 레이어 자체는 완성이며 테스트로 고정했다.
