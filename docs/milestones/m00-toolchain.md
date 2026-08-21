> PLAN.md §2 에서 2026-08-21 에 이관한 기록이다. 완료 시점의 실측을 보존한다.
> 문서 경로 참조만 이관 시점 구조에 맞게 고쳤고, 내용은 편집하지 않는다.

# M0 — 툴체인 부트스트랩 ✅

- [x] Bun 1.3.14 설치 확인
- [x] `package.json`, `tsconfig.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- [x] 의존성 확정 — **전부 순수 JS** (네이티브 애드온은 크로스컴파일 불가)

| 용도 | 패키지 | 비고 |
|---|---|---|
| CLI 파싱 | `commander` | |
| 색상 | `chalk` | |
| 스피너/진행 | `ora` | |
| semver | `semver` | Cargo 문법 번역 후 투입 |
| zip 해제 | `fflate` | 순수 JS |
| 스키마 검증 | `ajv` + `ajv-formats` | `schemas/*.json`을 그대로 소비 |
| HTTP / 해시 / 파일 | Bun 내장 | `fetch`, `crypto.subtle`, `Bun.file` |

TOML 파서는 **필요 없다.** 의존성 별칭까지 metadata API가 JSON으로 준다.

- [x] `biome` 린트 설정, `bun test` 동작 확인
- [x] `src/` 레이어 디렉터리 골격 생성
- [x] `src/util/errors.ts` — `what` / `where` / `how` 3요소 에러
- [x] `src/util/package-name.ts` — 이름 4형태 변환, 별칭 도출
- [x] **`src/util/version-range.ts` — Cargo→npm 범위 번역** (최고 위험 항목, M2보다 앞당김)
- [x] `src/cli.ts` — commander 배선, 전 명령 스텁
- [x] `bun build --compile` 단일 바이너리 확인 (99MB)
- [x] ESLint 타입 인지 룰 (`typescript-eslint` `strictTypeChecked`)
- [x] husky `pre-commit` + lint-staged
- [x] `src/util/codes.ts` — `RN####` 에러 코드 체계
- [x] `resolutions` 필드, `rarn up` 명령

M0 상태: **86 tests pass / eslint clean / typecheck clean / biome clean.**

> 번역 로직을 M2가 아니라 M0에서 끝냈다. 위험도 1순위였고 순수 함수라 의존성이 없었다.
> 테스트에는 *번역하지 않은 범위가 다른 의미로 파싱된다*는 것을 고정하는 케이스를 넣어,
> 이 변환이 왜 필요한지가 코드에 남도록 했다.

> `--bytecode` 는 CommonJS로 내보내므로 top-level await 를 쓸 수 없다.
> `src/cli.ts` 진입점을 async IIFE로 감싸 둔 이유다 — 안 그러면 인터프리터 실행은 되는데
> 컴파일된 바이너리만 깨진다.
