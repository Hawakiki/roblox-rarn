# Wally 역해석 정리

> `UpliftGames/wally` 소스를 직접 읽고 정리한 문서다. 분석 후 소스는 삭제했다.
> 목적은 두 가지 — **반드시 따라야 할 규약**과 **Rarn이 다르게 갈 지점**을 가르는 것.
>
> 읽은 파일: `installation.rs` `resolution.rs` `package_contents.rs` `package_id.rs`
> `manifest.rs` `lockfile.rs` `package_source/registry.rs` `package_index.rs`

---

## 1. 설치 레이아웃 — `installation.rs`

### 디렉터리는 3개다 (하나가 아니다)

```rust
let shared_dir = project_path.join("Packages");
let server_dir = project_path.join("ServerPackages");
let dev_dir    = project_path.join("DevPackages");
// 각각 그 아래 _Index/
```

realm별로 **최상위 형제 디렉터리**를 따로 만든다. 하나의 폴더 안에 하위 폴더로 realm을
나누는 방식이 아니다. Roblox에서 각 realm이 DataModel의 서로 다른 서비스
(`ReplicatedStorage` / `ServerScriptService`)로 들어가야 하기 때문이다.

### `_Index` 폴더 이름과 내부 폴더 이름

```rust
fn package_id_file_name(id: &PackageId) -> String {
    format!("{}_{}@{}", id.name().scope(), id.name().name(), id.version())
}

// write_contents:
path.push(package_id_file_name(package_id));  // evaera_promise@4.0.0
path.push(package_id.name().name());          // promise
```

> **중요 정정:** 내부 폴더 이름은 `default.project.json` 의 `name` 필드가 아니라
> **패키지 이름에서 그대로 온다.** 프로젝트 파일을 읽을 필요조차 없다.
>
> 헷갈리기 쉬운 이유는 Wally가 **publish 시점에 `default.project.json` 의 `name` 을
> 패키지 이름으로 강제 덮어쓰기** 때문이다 (`package_contents.rs`). 둘이 항상 같아 보이지만,
> 실제로 폴더 이름을 정하는 쪽은 패키지 이름이다.

### shim 4종

```rust
// 1. 루트 -> 같은 realm
return require(script.Parent._Index["{scope}_{name}@{ver}"]["{name}"])

// 2. _Index 내부 -> 같은 realm 형제
return require(script.Parent.Parent["{scope}_{name}@{ver}"]["{name}"])

// 3. 다른 realm -> shared  (절대 DataModel 경로 필요)
return require({place.shared-packages}._Index["{scope}_{name}@{ver}"]["{name}"])

// 4. 다른 realm -> server
return require({place.server-packages}._Index["{scope}_{name}@{ver}"]["{name}"])
```

3번과 4번이 존재하는 이유: 서버 패키지가 shared 패키지를 참조할 때 두 폴더는 DataModel의
**다른 서비스 하위**에 있으므로 `script.Parent` 상대 탐색으로 건너갈 수 없다. 그래서
`wally.toml` 의 `[place]` 에 절대 경로를 선언해야 하고, 없으면 Wally는 에러를 낸다:

```toml
[place]
shared-packages = "game.ReplicatedStorage.Packages"
server-packages = "game.ServerScriptService.Packages"
```

**Rarn도 이 설정이 필요하다.** 회피 방법이 없는 플랫폼 제약이다.

### 확장자는 `.lua` 다

```rust
let path = base_path.join(format!("{}.lua", dep_name));
```

Wally는 shim을 `.lua` 로 쓴다. Rarn은 `.luau` 로 쓴다 — Rojo와 Studio 모두 양쪽을 처리하고,
`.luau` 가 현재 권장 확장자다. 호환성 문제는 없다.

### 설치 = 전체 삭제 후 재생성

`clean()` 이 `Packages` / `ServerPackages` / `DevPackages` 를 통째로 `remove_dir_all` 한 뒤
처음부터 다시 만든다. **증분 설치가 없다.**

Rarn도 이 방식을 따른다. 고아 항목 추적보다 훨씬 단순하고, 부분 실패 상태가 남지 않는다.
단 삭제 범위는 `packageDir` 안으로만 엄격히 제한한다.

---

## 2. 리졸버 — `resolution.rs`

### 알고리즘

```
큐 = 루트의 직접 의존성 전부 (realm별로)
while 큐:
    요청 = 큐.pop_front()                       # BFS
    이미 활성화된 동명 패키지를 버전 내림차순으로 확인
        요청 범위에 맞는 게 있으면 -> 재사용하고 continue
    레지스트리 질의 -> 후보 버전 목록
    정렬: 락파일에 있던 것 우선, 그다음 버전 내림차순
    for 후보 in 후보들:
        이미 활성화된 동명 패키지와 semver 호환이면 -> 충돌로 기록하고 skip
        아니면 -> 활성화하고 그 의존성을 큐에 넣고 continue
    후보를 하나도 못 고르면 -> 에러
```

호환 판정:

```rust
fn compatible(a: &Version, b: &Version) -> bool {
    if a == b { return true; }
    if a.major == 0 && b.major == 0 { a.minor == b.minor }
    else { a.major == b.major }
}
```

즉 `1.2.0` 과 `1.9.0` 은 호환 → **공존 금지**. `1.x` 와 `2.x` 는 비호환 → **공존 허용**.
0.x 는 minor를 major처럼 취급한다.

### 여기에 실제 결함이 있다

이 알고리즘은 **탐욕적이고 백트래킹이 없어서 큐 순서에 결과가 좌우된다.**

`^1.2.0` 과 `^1.5.0` 을 요구하는 두 패키지가 있고 레지스트리에 `1.9.0` 이 있다고 하자.
정답은 명백히 "둘 다 `1.9.0` 사용"이다. 그런데 큐에서 `^1.2.0` 이 먼저 나오고 어떤 이유로
`1.2.0` 이 활성화되면:

- `^1.5.0` 요청이 온다 → 활성화된 `1.2.0` 은 범위에 안 맞음
- 후보 `1.9.0` → `compatible(1.9.0, 1.2.0)` = 같은 major = **true** → 충돌, skip
- 모든 `1.x` 후보가 같은 이유로 skip
- → **하드 에러**

```
All possible candidates for package X conflicted with other packages
that were already installed. These packages were previously selected: ...
```

해결 가능한 문제를 순서 때문에 못 푸는 것이고, 에러 메시지도 사용자가 뭘 해야 하는지
알려주지 않는다.

> **Rarn의 접근:** "한 major당 한 버전"이라는 **정책은 그대로 유지**한다 (Roblox의 싱글톤
> 문제 때문에 옳은 정책이다). 대신 **알고리즘을 순서 독립적으로** 만든다 — 그래프를 먼저
> 전부 순회해 이름별 범위 집합을 모으고, 그 뒤에 교집합으로 버전을 정한다.
> 위 사례는 `^1.2.0 ∩ ^1.5.0 = >=1.5.0 <2.0.0` → `1.9.0` 하나로 자연히 풀린다.
> 진짜로 못 푸는 경우에만 에러를 내고, 그때는 어느 패키지가 어느 범위를 요구했는지 보여준다.

### realm 결정 규칙

패키지가 어느 폴더에 놓이는지는 `origin_realm` 이 정한다. 여러 요청이 겹치면:

```
Shared > Server > Dev
```

한 곳이라도 shared로 요구하면 shared에 놓인다. 클라이언트에서 보여야 하는 패키지가
서버 전용 폴더에 갇히는 걸 막는 규칙이다.

의존 가능 여부는 별도 규칙:

```rust
fn is_dependency_valid(dep_type, dep_realm) -> bool {
    matches!((dep_type, dep_realm), (Server, _) | (Shared, Shared) | (Dev, _))
}
```

| 요청하는 쪽 | 의존 가능한 realm |
|---|---|
| server | 전부 |
| **shared** | **shared 뿐** |
| dev | 전부 |

shared 패키지가 server 패키지에 의존하는 것은 금지된다. 클라이언트에 복제될 코드가
서버 전용 코드를 참조하면 런타임에 깨지기 때문이다.

또 한 가지: 패키지의 `[dependencies]` 는 항상 `request_realm: Shared` 로 큐에 들어가고,
`[server-dependencies]` 만 `Server` 로 들어간다. `origin_realm` 은 부모 요청에서 상속된다.

---

## 3. 패키지 내용 — `package_contents.rs`

### 압축 해제 시 가공이 전혀 없다

```rust
pub fn unpack_into_path(&self, output: &Path) -> anyhow::Result<()> {
    let mut archive = ZipArchive::new(Cursor::new(self.data.as_slice()))?;
    archive.extract(output)?;   // 통째로 푼다. 끝.
}
```

`default.project.json` 해석도, 가지치기도 없다. zip에 든 그대로 `_Index` 에 쏟아붓는다.
`evaera/promise@4.0.0` 이 340개 파일로 설치되는 이유가 이것이다.

**그럼 Studio에서는 왜 정상 동작하나?** Rojo가 sync 시점에 `Packages/_Index/.../promise/`
안의 `default.project.json` 을 발견하고 `{"tree": {"$path": "lib"}}` 대로 폴더를 재해석해
`lib/` 의 트리로 바꿔치기하기 때문이다.

> 즉 **Wally 설치 결과물은 Rojo가 있어야만 올바른 모듈 트리가 된다.**
> Rarn이 설치 시점에 가지치기를 하는 것은 Rojo가 sync 시점에 하는 일을 앞당기는 것이고,
> 그래서 Rojo 없이도 동작한다. 이게 Rarn의 핵심 차별점이 성립하는 근거다.

### zip이 비대해지는 원인은 publish 쪽에 있다

```rust
static EXCLUDED_GLOBS: &[&str] = &[".*", "wally.lock", "Packages", "ServerPackages", "DevPackages"];
```

`include` 가 비어 있으면 `.gitignore` 줄들을 exclude로 쓰고 위 목록을 더한다.
대부분의 패키지가 `include` 를 지정하지 않으므로 `docs/`, 테스트, 벤더링된 서브모듈까지
전부 올라간다. **레지스트리에 있는 zip 자체가 이미 비대하다** — 클라이언트가 고칠 수 없고,
받은 뒤 걸러내는 수밖에 없다.

### publish 시 프로젝트 파일 이름 덮어쓰기

```rust
if project_name != package_name {
    *project_json.get_mut("name").unwrap() = json!(package_name);
}
```

`default.project.json` 의 `name` 을 `wally.toml` 의 패키지 이름으로 강제 통일한다.
(1절에서 언급한, 폴더 이름 출처를 헷갈리게 만드는 원인.)

---

## 4. 레지스트리 접근 — `registry.rs`, `package_index.rs`

### 해석에 git clone을 쓴다

```rust
fn query(&self, package_req) -> Vec<Manifest> {
    let metadata = self.index()?.get_package_metadata(package_req.name())?;
    ...
}
// index() -> PackageIndex::new() -> git_util::open_or_clone(...)  // git2::Repository
```

`GET /v1/package-metadata` HTTP 엔드포인트가 존재하는데도 **클라이언트는 안 쓴다.**
대신 인덱스 저장소 전체를 `dirs::cache_dir()` 에 git clone 하고 파일을 읽는다.

> **Rarn은 HTTP 메타데이터 API를 쓴다.** 인덱스 clone이 통째로 사라진다.
> 첫 실행 체감 차이가 가장 크게 나는 지점이고, git 의존성도 없앨 수 있다.
> 대가는 패키지마다 HTTP 요청 1회 — 병렬 처리와 메모리 캐시로 상쇄한다.

### 다운로드 헤더

```rust
let mut request = self.client.get(url).header("Wally-Version", VERSION);  // CARGO_PKG_VERSION
if let Some(token) = self.auth_token()? {
    request = request.header(AUTHORIZATION, format!("Bearer {}", token));
}
```

`Wally-Version` 은 크레이트 버전 문자열이다. 인증 토큰은 선택이며 `~/.wally/auth.toml` 에
API URL을 키로 저장된다. 공개 패키지는 토큰 없이 받아진다.

---

## 5. 락파일 — `lockfile.rs`

포맷은 TOML이고 `writeln!` 로 **손수 문자열을 쌓아 만든다** (serde 직렬화가 아니다):

```toml
# This file is automatically @generated by Wally.
# It is not intended for manual editing.
registry = "..."

[[package]]
name = "evaera/promise"
version = "4.0.0"
dependencies = []
```

### checksum 필드가 있는데 채워지지 않는다

```rust
packages.push(LockPackage::Registry(RegistryLockPackage {
    name: ...,
    version: ...,
    checksum: None,      // <-- 항상 None
    dependencies,
}));
```

읽고 쓰는 코드는 있지만 (`if let Some(checksum) = ...`) 생성 경로에서 항상 `None` 이다.
**실질적으로 Wally 락파일에는 무결성 검증이 없다.** Rarn은 `sha256-` 다이제스트를 채우고
설치할 때마다 검증한다.

락파일이 저장하는 의존성은 `[별칭, "scope/name@version"]` 쌍의 배열이다. Rarn의
`dependencies` 맵(별칭 → packageKey)과 개념이 같다.

---

## 6. Rarn 결정 요약

### 그대로 따르는 것 (플랫폼·호환 제약)

| 항목 | 이유 |
|---|---|
| `_Index` 2단 구조와 shim 4종 | 패키지 소스에 require 경로가 하드코딩돼 있음 |
| `{scope}_{name}@{version}` 폴더명 | Wally 사용자에게 그대로 읽힘 |
| 내부 폴더명 = 패키지 이름 | 프로젝트 파일이 아니라 패키지 이름이 출처 |
| realm별 최상위 형제 디렉터리 | DataModel의 다른 서비스로 들어가야 함 |
| 교차 realm에 절대 경로 필요 | 상대 탐색으로 서비스 경계를 못 넘음 |
| 설치 = 전체 삭제 후 재생성 | 단순하고 부분 실패 상태가 안 남음 |
| major당 한 버전 정책 | Roblox 싱글톤 정합성 |

### 다르게 가는 것

| 항목 | Wally | Rarn |
|---|---|---|
| 버전 해석 | 인덱스 git clone | HTTP 메타데이터 API |
| 해석 알고리즘 | 탐욕적, 순서 의존, 백트래킹 없음 | 제약 수집 후 교집합 |
| 충돌 에러 | 어느 범위가 부딪혔는지 안 알려줌 | 요구자와 범위를 전부 표시 |
| 패키지 가지치기 | 없음 (Rojo에 위임) | 설치 시점에 모듈 루트만 |
| 무결성 검증 | 필드만 있고 미구현 | sha256, 매 설치 검증 |
| 전역 캐시 | zip만 | zip + 압축 해제 결과 |
| shim 확장자 | `.lua` | `.luau` |
| Rojo 없이 동작 | 안 됨 | 됨 |

### 스키마에 반영해야 할 정정

1. `rarn.lock` 의 `projectName` **제거** — 폴더 이름은 패키지 이름에서 유도된다.
2. `rarn.json` 에 `place` 추가 — 교차 realm shim에 필수.
3. realm 디렉터리를 `packageDir` 하위가 아니라 **형제 3개**로.
