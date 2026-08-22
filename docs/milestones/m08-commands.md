> PLAN.md §2 에서 2026-08-21 에 이관한 기록이다. 완료 시점의 실측을 보존한다.
> 문서 경로 참조만 이관 시점 구조에 맞게 고쳤고, 내용은 편집하지 않는다.

# M8 — CLI 명령 ✅

**이미 동작하는 것:** `init` `add` `install` — M1·M6 에서 배선했다.

M8 은 **10개**를 추가한다. 발행 계열은 이번에 넣지 않는다 (아래 M10).

전 명령 공통: `--verbose`, `--silent`, `--no-color`, `--cwd`.
종료 코드는 `0` 성공 / `1` 사용자 오류 / `2` 네트워크·레지스트리 오류.

#### A. 편집·조회 (5개) — 밑단이 전부 있음

| 명령 | 옵션 | 하는 일 | 크기 |
|---|---|---|---|
| `remove <pkg...>` | | 매니페스트에서 제거 후 재설치 | S |
| `up [pkg...]` | `--latest` | 범위 내 최신으로 올리고 **매니페스트 범위도 갱신** | S |
| `list` (`ls`) | `--depth` `--json` | 락파일로 트리 출력. 네트워크 0 | S |
| `why <pkg>` | `--json` | 루트까지 역추적 | S |
| `dedupe` | `--json` | 중복 버전 진단 | S |

- `remove` 는 **어느 섹션에 있든 찾아서** 지운다. `withoutDependency` 가 M1 에 이미 있고
  아직 안 쓰인다. 없는 패키지를 지우라고 하면 조용히 성공하지 말고 그렇게 말한다.
- `up` 은 `install` 과 다르다. `install` 은 매니페스트를 안 건드리지만 `up` 은
  **범위를 새 버전에 맞춰 다시 쓴다** (Yarn 과 동일). `--latest` 는 선언된 범위를 무시한다.
- `why` 는 락파일의 `requestedBy` 가 곧 역방향 간선이라 **네트워크 없이** 된다.
  직접 요구자만이 아니라 **루트까지의 경로 전체**를 보여준다.

> **`dedupe` 는 Yarn 과 역할이 다르다.** Yarn 의 `dedupe` 는 재해석해서 버전 수를 줄인다.
> Rarn 의 리졸버는 **이미 제약을 다 모은 뒤 교집합으로 푸는** 순서 독립 알고리즘이라
> 결과가 항상 최소다 — 더 줄일 여지가 없다. 그래서 Rarn 의 `dedupe` 는 축약이 아니라
> **"왜 못 합쳤는지 설명하고 `resolutions` 를 제안"** 하는 진단 명령이다.

#### B. 탐색 (3개)

| 명령 | 하는 일 | 크기 |
|---|---|---|
| `search <query>` | 레지스트리 검색 | **XS** |
| `info <pkg>[@ver]` | 버전 목록·설명·라이선스·realm·의존성 | S |
| `outdated` | 설치본 vs 범위 내 최신 vs 전체 최신 | S |

> `search` 는 **M2 에서 이미 구현했고 버그까지 고쳤는데** (scope/name 분리 필드)
> 아무 데서도 안 부른다. 배선만 하면 끝난다.

`outdated` 는 Yarn Classic 형식으로 `current / wanted / latest` 3열. CI 용으로
낡은 게 있으면 종료 코드를 1로 할지는 구현 시 결정한다 — 기본은 0, `--check` 로 옵트인이
안전해 보인다.

#### D. 유지보수 (2개)

| 명령 | 하는 일 | 크기 |
|---|---|---|
| `cache dir\|clean\|verify` | 캐시 경로 출력 / 비우기 / 무결성 재검사 | S |
| `doctor` | 선언 ↔ 실제 require 불일치 검사 | M |

- `cache verify` 는 `downloads/` 를 다시 해싱해 `extracted/` 와 대조한다.
  M4 의 무결성 코드를 그대로 쓴다.
- `cache clean` 은 **되돌릴 수 없으므로** 지울 용량과 항목 수를 먼저 보여준다.
- `doctor` 는 [R1 연구](docs/research/r1-pnp-feasibility.md) 5-2 에서 나온 항목이다. 패키지 소스가
  `script.Parent.Parent.X` 를 부르는데 `X` 가 선언된 의존성에 없으면 경고, 반대로 선언만
  하고 안 쓰면 경고. **표본의 4.5% 는 동적 require 라 검사 불가인데, 그 사실을 그대로 보고한다.**
  Wally 에 없는 영역이다.

---

#### 실측 결과

10개 전부 구현·배선했다. 아래는 `@sleitnick/knit` + `@evaera/promise` 를 설치한
스크래치 프로젝트에서 실제로 받은 출력이다.

| 명령 | 확인한 것 |
|---|---|
| `remove` | 매니페스트에서 지우고 재설치. 없는 패키지는 `RN0002` 로 거부하고 **아무것도 안 지운다** |
| `up` | `^1.4.0` → `^1.7.0` 으로 **범위까지 다시 씀**. `--latest` 는 범위를 넘어 `^3.2.1` → `^4.0.0` |
| `list` | 트리 + 중복 경고. 재방문 노드는 `·` 로 접는다 |
| `why` | 루트까지의 경로 전체. 사슬이라 항상 `└─` |
| `dedupe` | 버전별 요구자와 범위, `resolutions` 제안 |
| `search` | `--limit` 동작. M2 의 scope/name 분리 필드 그대로 |
| `info` | 버전 목록·realm·라이선스·의존성 |
| `outdated` | `current / wanted / latest` 3열. 범위 밖 최신만 노랑 |
| `cache` | `dir` / `clean` / `verify` — verify 는 락파일과 대조 |
| `doctor` | 아래 |

`up` 이 실제 중복을 만들어 `dedupe` 를 검증할 재료가 되어 줬다:

```
@evaera/promise is installed at 2 versions:
  4.0.0
    >=4.0.0 <5.0.0       <- @sleitnick/comm@1.0.1
    >=4.0.0 <5.0.0       <- @sleitnick/knit@1.7.0
  3.2.1
    ^3.2.1               <- rarn.json (direct dependency)

  Force one version with:  "resolutions": { "@evaera/promise": "4.0.0" }
```

**`doctor` 는 대조군으로 검증했다.** 통과만으로는 검사기가 아무것도 안 하고 있는
경우와 구별이 안 되기 때문이다.

| 주입한 결함 | 결과 |
|---|---|
| 선언 안 한 `NotDeclared` 를 require | `requires NotDeclared — not a declared dependency` + 파일·줄 번호, 종료 1 |
| Knit 소스에서 `Comm` require 제거 | `declares Comm — never required`, 종료 0 |

두 번째가 중요하다. Knit 은 `KnitClient.Util = (script.Parent :: Instance).Parent`
로 한 번 변수를 경유해서 require 한다. **그 require 를 지웠을 때만 `unused` 로 바뀌었다는 건
스캐너가 변수 경유를 실제로 따라가고 있다는 뜻이다** — 안 따라갔다면 애초에 `Comm` 을
쓰는 걸 못 봤을 테니 지우기 전에도 `unused` 라고 했을 것이다.

`missing` 은 런타임에 `nil` 이 되는 진짜 결함이라 종료 1, `unused` 는 매니페스트가
넉넉한 것뿐이라 종료 0 으로 나눴다.

스캐너가 못 보는 것도 그대로 보고한다: `7 requires are built at runtime and could not be checked`.

문자열 처리에 걸린 게 하나 있다. 주석 속 예제 코드를 진짜 require 로 읽지 않으려면
문자열을 지워야 하는데, 그러면 `folder["Promise"]` 의 이름까지 날아간다. 이름 하나짜리
리터럴만 남기고 나머지를 지우는 것으로 갈랐다 — `require(...)` 를 숨길 만큼 긴 문자열이
문제였던 거지 짧은 이름은 아니었다.

전체 검사 초록: 315 tests pass, 0 fail (12 files, 1467ms).
