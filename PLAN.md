# Rarn — 구현 계획

> 이 문서는 **무엇을 어떤 순서로 만들지**를 정한다.
> 플랫폼 제약과 검증된 API 사실은 [CLAUDE.md](CLAUDE.md)에 있으며, 여기서 반복하지 않는다.

---

## 0. 확정된 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| 구현 언어 | TypeScript + Bun | 부품(zip·semver·HTTP) 전부 성숙, `--compile`로 단일 바이너리까지 해결 |
| 패키지 소스 | Wally 레지스트리 API | 기존 Roblox 생태계를 그대로 흡수 |
| 설치 위치 | `RARN_MODULE/` | `node_modules` 감각. 내부는 `_Index` + shim (구조는 강제사항) |
| 매니페스트 | `rarn.json` | npm 표기법 `"@evaera/promise": "^4.0.0"` |
| 락파일 | `rarn.lock` (JSON) | 정렬된 키, 재현 가능 |
| 스키마 | JSON Schema 2020-12 | `schemas/` 가 두 포맷의 단일 진실 |
| 캐시 | 전역 캐시 + **복사** | 하드링크는 프로젝트 간 편집 전파 사고 위험 |
| MVP 범위 | `init` `add` `install` `remove` `list` | CLI 표면 전체를 얇게 |
| 차별점 | 좋은 CLI 경험 + dedupe 가시화 | `why` / `dedupe` 는 Wally에 없는 영역 |
| 배포 | 로컬 실행만 | 크로스컴파일·릴리스는 기능 완성 후 |
| 린트 | Biome 포매터 + ESLint 타입룰 | Biome은 타입 인지 린팅이 **구조적으로** 불가 |
| 훅 | husky `pre-commit` 에 전부 | 느려지면 `pre-push` 로 분리 |
| 에러 코드 | `RN####` (Yarn Berry `YN0060` 방식) | 검색 가능한 고정 식별자 |

### Yarn에서 가져온 것

| Yarn | Rarn | 비고 |
|---|---|---|
| `resolutions` | `resolutions` | **버전 강제 통일.** 충돌 시 유일한 탈출구 |
| `yarn up [--latest]` | `rarn up [--latest]` | 업그레이드 |
| `YN0060` 코드 | `RN0210` 코드 | 메시지 문구는 바뀌어도 코드는 불변 |
| `yarn why` / `dedupe` | 동일 | 이미 계획에 있었음 |
| `--frozen-lockfile` | 동일 | Classic 철자 유지 (Berry는 `--immutable`) |

### 채택하지 않은 것과 그 이유

| 후보 | 왜 안 했나 |
|---|---|
| Luau + Lune | Lune에 **zip 해제가 없다**. Wally가 zip을 주므로 치명적 |
| Rust | 생태계 정통성은 최고지만 개발 속도 손해가 큼 |
| 하드링크 캐시 | 한 프로젝트의 편집이 다른 프로젝트로 전파됨 |
| 자체 레지스트리 | 서버 운영·인증·스토리지가 MVP 범위를 크게 넘음 |
| `.rbxm` 직접 생성 | 바이너리 포맷 직렬화 난이도가 높음. `rarn pack`으로 후순위 |

---

## 1. 아키텍처 요약

```
rarn.json
   |
   v
[resolver] --(metadata API)--> 정확한 버전 집합 + dedupe 판정
   |
   v
[cache] --(miss: contents API -> zip -> unzip)--> extracted/
   |
   v
[project] --(default.project.json)--> 모듈 루트만 골라냄
   |
   v
[linker] --> RARN_MODULE/_Index/... + *.luau shim
   |
   v
rarn.lock
```

`resolver`는 **네트워크를 metadata 호출로만 쓴다.** zip은 버전 집합이 확정된 뒤에만 받는다.
메타데이터가 의존성 그래프를 통째로 주기 때문에 가능한 설계이며, 이게 속도의 대부분을 만든다.

---

## 2. 마일스톤 현황

완료된 마일스톤의 실측 기록은 `docs/milestones/` 에 파일별로 보존한다.
이 표는 현황과 링크만 담는다.

| 마일스톤 | 상태 | 한 줄 | 기록 |
|---|---|---|---|
| M0 툴체인 | ✅ | Bun·biome·eslint·husky 골격 | [기록](docs/milestones/m00-toolchain.md) |
| M1 매니페스트 | ✅ | rarn.json 스키마·검증·정규화 | [기록](docs/milestones/m01-manifest.md) |
| M2 레지스트리 | ✅ | Wally HTTP 클라이언트, 426·ZIP 매직바이트 | [기록](docs/milestones/m02-registry.md) |
| R1 PnP 연구 | ✅ | **기각** — 전문 [research/r1](docs/research/r1-pnp-feasibility.md) | [기록](docs/milestones/r1-pnp-research.md) |
| M3 리졸버 | ✅ | 순서 무관 교집합 해석 | [기록](docs/milestones/m03-resolver.md) |
| M4 캐시 | ✅ | 전역 캐시, temp+rename, sha256 | [기록](docs/milestones/m04-cache.md) |
| M5 가지치기 | ✅ | default.project.json 해석, $path 프루닝 | [기록](docs/milestones/m05-prune.md) |
| M6 링커 | ✅ | _Index + shim, Lune 하니스 | [기록](docs/milestones/m06-linker.md) |
| M7 락파일 | ✅ | 재사용, 신선도 비대칭 | [기록](docs/milestones/m07-lockfile.md) |
| M8 CLI 명령 | ✅ | 10개 추가, doctor 포함 | [기록](docs/milestones/m08-commands.md) |
| M9 마감 | ✅ | README·ora·에러 렌더링 | [기록](docs/milestones/m09-polish.md) |
| M10 발행 | ✅ | pack/login/publish — **라이브 발행은 여전히 미검증** | [기록](docs/milestones/m10-publish.md) |
| M11 CI | ✅ | 잡별 매트릭스 축, 크로스컴파일 세그폴트 발견 | [기록](docs/milestones/m11-ci.md) |
| M12 원자성 | ✅ | .rarn-tmp 스왑, --offline | [기록](docs/milestones/m12-atomic-offline.md) |
| M13 import | ✅ | wally.toml 이주, 맨 버전 = 캐럿 | [기록](docs/milestones/m13-import.md) |
| M14 place | ✅ | Rojo 파생, sourcemap 대조 | [기록](docs/milestones/m14-place.md) |
| R2 워크스페이스 연구 | ✅ | **REDUCE_SCOPE** 80% — 전문 [research/r2](docs/research/r2-workspaces.md) | [기록](docs/milestones/r2-workspaces-research.md) |
| M15 워크스페이스 | ⏸ | R2 로 재정의. 실사용자 신호 후 조건부 | [기록](docs/milestones/m15-workspaces.md) |
| M16 0.1.0 배포 | ↩️ | 나갔다가 **RN-1 로 당일 철회** — 0.1.1 로 재도전 | [기록](docs/milestones/m16-release-0.1.0.md) |

R2 의 결론 한 줄: 워크스페이스의 경계는 리포도 매니페스트도 아닌 **place(DataModel)** 이고,
place 지향 워크스페이스는 이미 서비스되므로 짓지 않는다. 패키지 지향은 실사용자 신호가
나타난 뒤에만 연다.

---

## 3. 다음 할 일

우선순위대로.

1. **라이브 발행 1회** — `rarn publish` 는 `--dry-run` 으로만 돌려봤다. 발행된 버전은
   영구이므로 발행할 가치가 있는 것이 생길 때까지 미검증으로 남는다. 1.0.0 선행조건에서
   유일하게 남은 항목이다.
2. **파이프라인을 `cli/` 에서 꺼내기** — R2 §6.4 의 6번. 남은 REDUCE_SCOPE 단계는
   이것 하나다 (5번 크로스 트리 진단은 RN-3 으로 끝났다). 워크스페이스 드라이버의
   선행 조건이고, 부수적으로 제품에서 유일하게 테스트 없는 부분에 합성 테스트가 생긴다.
3. **M15 는 조건부** — 둘 이상의 `rarn.json` 을 한 리포에 둔 실제 사용자가 신호.
   그 전에 여는 것은 R2 가 명시적으로 반대했다. 이제 그 신호를 읽을 계측기가 있다:
   `rarn dedupe` 의 `RN0213`.

### 1.0.0 선행조건

| 조건 | 상태 |
|---|---|
| CI 초록 | ✅ |
| RN-1~RN-5 수정 | ✅ |
| 0.1.1 이 나가고 `rokit add` 동작 | ✅ (2026-08-22, 릴리스 자산으로 확인) |
| 라이브 발행 1회 성공 | ❌ (`--dry-run` 만) |
| M13 import 실프로젝트 3개 이주 | ✅ |
| R2 결론 반영 (M15 재정의) | ✅ |
| CHANGELOG·에러 코드표 | ✅ |

---

## 4. 이후 (마일스톤에 없는 것)

M11~M16 이 생기면서 이 표의 절반은 마일스톤으로 승격됐다. 여기 남는 것은 **어느 마일스톤에도
속하지 않는** 잔가지뿐이다.

| 항목 | 어디에 얹으면 되나 |
|---|---|
| `rarn pack` → `.rbxm` | Rojo 없이 Studio 드래그. 바이너리 직렬화가 필요해 사실상 별도 마일스톤 |
| `--linked` 캐시 | 하드링크 옵트인. 언제든, 단독 |
| `pack` 의 `.gitignore` 폴백 | M13 근처 — 파일 목록 로직을 어차피 건드릴 때 |
| `_Meta.luau` (해석 맵을 읽기 전용 데이터로) | R1 보류분. 성격은 M14 와 가깝다 |
| CHANGELOG | M16 선행조건 |

승격된 것: 워크스페이스 → **M15**, `wally.toml` 임포트 → **M13**, 크로스컴파일·CI → **M11**,
Rokit 배포 → **M16**. 이미 끝난 것: `rarn publish` → M10, `rarn doctor` → M8.

---

## 5. 위험 요소

| 위험 | 영향 | 대응 |
|---|---|---|
| Cargo 범위 문법 번역 누락 | 범위를 조용히 오해석 | 전용 유닛 테스트, M2에서 최우선 |
| `default.project.json` 형태가 다양함 | 잘못된 트리 배치 | 단순형만 처리, 나머지는 통째 복사 + 경고 |
| `Content-Type` 이 거짓말함 | 해제 실패 | 매직바이트로만 판별 |
| Wally API 스펙 변경 | 전면 고장 | 클라이언트를 한 파일에 격리, 검증 사실을 CLAUDE.md에 기록 |
| zip slip | 임의 파일 쓰기 | 엔트리 경로 검증 |
| Bun `--compile` 바이너리 크기 (50~110MB) | 배포 부담 | `--minify --bytecode` |
| 순환 의존성 | 무한 루프 | 방문 표시, 순환은 경고 처리 |

---

## 6. 테스트 전략

| 층 | 방식 |
|---|---|
| `resolver` | 순수 함수. 손으로 만든 메타데이터 픽스처로 표 기반 테스트 |
| `registry` | 녹화된 HTTP 픽스처. **CI에서 네트워크 금지** |
| `project` | 실제 `default.project.json` 샘플 모음 |
| `linker` | 임시 디렉터리에 설치 후 트리 구조와 shim 내용 스냅샷 |
| 통합 | `@sleitnick/knit` 설치 → 정확한 트리 검증 (네트워크 필요, 별도 태그) |

### `test/roblox/` — 실제 동작 검증장 (Rojo는 여기서만 도입)

위의 자동화 테스트는 **파일 트리가 맞는지**까지만 본다. `require` 가 런타임에 정말 해결되는지는
Roblox 안에서만 확인할 수 있다. 그래서 실제 Roblox 프로젝트를 하나 둔다.

```
test/roblox/
  rarn.json                 <- 여러 패키지를 일부러 섞어 넣은 매니페스트
  default.project.json      <- Rojo 프로젝트 (여기서만 Rojo를 쓴다)
  src/
    verify.server.luau      <- 각 패키지를 require 하고 결과를 출력
  RARN_MODULE/              <- rarn install 산출물 (gitignore)
```

**Rojo는 이 폴더 전용이다.** Rarn 자체는 Rojo에 의존하지 않으며 — 오히려 Rojo 없이 동작하는 게
목표다 — 여기서는 산출물을 Studio로 밀어넣는 **운반 수단**으로만 쓴다.

검증 시나리오는 난이도 순으로 쌓는다:

| # | 시나리오 | 무엇을 증명하나 |
|---|---|---|
| 1 | 의존성 없는 패키지 1개 (`@evaera/promise`) | 기본 트리와 shim이 맞다 |
| 2 | 전이 의존성 (`@sleitnick/knit` → comm, promise) | `_Index` 내부 형제 shim이 해결된다 |
| 3 | 두 패키지가 같은 의존성 공유 | **dedupe** — 두 경로의 require가 같은 테이블을 반환한다 |
| 4 | `serverDependencies` 포함 | realm 분리와 교차 realm 절대 경로 shim |
| 5 | major가 다른 두 버전 공존 | 비호환 버전이 각자 자기 것을 본다 |
| 6 | 가지치기 전후 비교 | 파일 수가 줄어도 동작이 같다 |

3번이 가장 중요하다. 이렇게 확인한다:

```lua
-- src/verify.server.luau
local direct   = require(game.ReplicatedStorage.RARN_MODULE.Promise)
local viaKnit  = require(game.ReplicatedStorage.RARN_MODULE._Index["sleitnick_knit@1.7.0"].Promise)
assert(direct == viaKnit, "dedupe 실패: Promise 사본이 2개다")
print("✓ dedupe 확인")
```

`direct == viaKnit` 이 참이어야 한다. 거짓이면 ModuleScript 인스턴스가 둘이라는 뜻이고,
싱글톤이 깨진다 — 파일 트리 스냅샷 테스트로는 절대 잡을 수 없는 종류의 버그다.

절차: `rarn install` → `rojo build` → Studio에서 열기 → `execute_luau` 로 검증.

**Studio MCP 를 쓸 수 있게 되어 이 단계가 더 이상 수동이 아니다.** 2026-08-21 에 처음
돌렸고, 결과는 CLAUDE.md 의 "The model has been checked against real Studio" 에 있다.
요약하면 하니스가 모델 안에서 주장하던 것이 전부 실제로도 참이었다 — dedupe 동일성,
교차 realm 동일성, `Knit.Util` 이 `_Index` 엔트리 폴더라는 것, 그리고 knit/promise/signal
이 실제로 실행된다는 것.

모델이 맞다고 확인된 것은 **이 트리 모양 하나**다. 링커를 건드리면 다시 돌린다 —
자동화된 것은 하니스이고, 하니스가 옳은지는 여기서만 확인된다.

---

