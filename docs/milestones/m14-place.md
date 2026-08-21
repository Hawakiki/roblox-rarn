> PLAN.md §2 에서 2026-08-21 에 이관한 기록이다. 완료 시점의 실측을 보존한다.
> 문서 경로 참조만 이관 시점 구조에 맞게 고쳤고, 내용은 편집하지 않는다.

# M14 — Rojo·place 연동 ✅

**목표:** `place` 를 손으로 적지 않아도 되고, 어긋나면 설치 시점에 잡힌다.

같은 사실이 지금 두 군데에 적혀 있다 — `rarn.json` 의 `place` 와 `default.project.json` 의
트리. 어긋나면 교차 realm shim 이 **존재하지 않는 DataModel 경로** 를 가리키는데, 이건 파일
트리 스냅샷으로도 Lune 하니스로도 잡히지 않는다. Studio 에서 처음 터진다.

그리고 터질 때 아무것도 알려주지 않는다. 2026-08-21 에 Studio 에서 실제로 재현했다 —
place 가 틀린 경우, 버전 폴더가 없는 경우, 서비스명에 오타가 난 경우가 **전부 같은 한 줄**
로 나온다:

```
Requested module experienced an error while loading
```

경로도, 무엇이 없는지도 없다. 진짜 원인(`Packages is not a valid member of
ReplicatedStorage`)은 한 겹 아래에 있고 Output 의 두 번째 줄로만 보인다.

즉 이 실패는 설치도 성공하고, 파일 트리도 맞고, 하니스도 통과한 뒤, 런타임에 저 한 줄로
나타난다. **설치 시점에 잡아야 한다는 주장은 이제 추론이 아니라 측정이다.**

| 항목 | 내용 |
|---|---|
| 파생 | `default.project.json` 에서 `$path` 가 realm 디렉터리인 노드를 찾아 그 DataModel 경로를 `place` 로 사용 |
| 우선순위 | 매니페스트의 명시 `place` 가 이긴다. 파생은 **없을 때만** |
| 검증 | 둘 다 있고 다르면 경고 + 어느 쪽을 썼는지 명시 (`RN04xx`) |
| `init` | 프로젝트 파일이 있으면 세 realm 항목을 넣어 줄지 묻고, 거절하면 붙여넣을 스니펫을 출력 |
| 미선언 | 교차 realm 링크가 필요한데 경로를 못 찾으면 **무엇을 어디에 추가할지** 까지 적어서 실패 |

같이 측정할 것: 설치 후 `rojo sourcemap` 재생성이 필요한지, luau-lsp 가 `_Index` 안쪽 타입을
따라가는지. 안 되면 고치는 것과 별개로 **그 사실만이라도 문서화한다.**

**판정:** `place` 를 일부러 틀리게 적은 프로젝트에서 경고가 나오는가. `place` 를 지운 프로젝트가
프로젝트 파일만으로 정상 설치되는가.

#### 실측 결과

둘 다 통과했고, 판정에 없던 것 하나가 더 나왔다.

| 시나리오 | 결과 |
|---|---|
| `place` 미선언 + Rojo 파일만 있음 | 파생 성공. 교차 realm shim 이 `game.ReplicatedStorage.SharedPkgs` 로 나왔다 — 폴더 이름은 `RARN_MODULE` 이다 |
| 선언과 파생이 다름 | 경고 출력, 매니페스트 채택 |
| **wally 이주 직후** | `Packages_SERVER/` 에 패키지가 들어갔는데 Rojo 가 안 옮긴다고 경고 |

세 번째가 판정에 없던 것이다. M13 의 import 경고("Wally 는 ServerPackages 를 썼다")와
M14 의 설치 경고("Packages_SERVER 를 프로젝트 파일이 안 나른다")가 **이어져서 하나의
이야기가 된다.** 어느 쪽도 에러가 아니고, 둘 다 없으면 서버 realm 이 그냥 Studio 에
나타나지 않는다.

#### 조사부터 했다

실제 `default.project.json` 을 GitHub 에서 여러 개 받아 봤고, 추측했으면 셋을 놓쳤다.

| 야생의 사실 | 놓쳤다면 |
|---|---|
| 서비스 노드에 `$className` 이 없어도 된다 | 가장 흔한 템플릿을 통째로 건너뛴다 |
| `$path` 가 `{ "optional": "Packages" }` 일 수 있다 | 패키지 매니저를 쓰는 프로젝트가 정확히 이 형태를 쓴다 |
| 한 노드가 `$path` 와 자식을 동시에 가진다 | 그 아래를 못 본다 |

그리고 DataModel 이름과 폴더 이름은 **다른 것이다.** `"SharedPackages": { "$path": "Packages" }`
가 실제로 존재한다 — `packageDir` 로는 절대 추측할 수 없는 이유다.

#### 검증 수단이 하나 늘었다

`rojo sourcemap` 이 Rojo 가 실제로 지을 인스턴스 트리를 JSON 으로 내놓는다. 파생한 경로가
거기 있는지 비교하면 **Studio 없이** 확인된다. 손으로 한 번 하고 마는 대신
`tests/place-sourcemap.test.ts` 로 만들었고, CI 도 rojo 를 깐다.

하니스와 같은 논리의 한 층 위다 — 하니스는 realm *안에서* require 가 풀리는지 보고,
이건 그 realm 이 shim 에게 말해 준 자리에 실제로 있는지 본다.

부수적으로 확인된 것: 소스맵은 `_Index` 안쪽까지 다 보인다
(`game.ReplicatedStorage.Pkgs._Index.evaera_promise@4.0.0.promise`). luau-lsp 가 설치된
패키지의 타입을 따라갈 수 있다는 뜻이고, 조건은 설치 후 소스맵을 다시 만드는 것뿐이다.

426 → **429 tests**.
