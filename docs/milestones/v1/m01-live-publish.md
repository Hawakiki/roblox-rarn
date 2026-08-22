# M1 — 라이브 발행 1회

> 완료 시점의 사실만 담고 이후 편집하지 않는다 — 링크 수정만 예외.

**완료:** 2026-08-22
**결과:** [`hawakiki/luau-mathlib@0.1.0`](https://api.wally.run/v1/package-metadata/hawakiki/luau-mathlib)
발행. `rarn publish` 의 업로드 절반이 처음으로 실행됐다.

---

## 무엇이 목표였나

`rarn publish` 는 `--dry-run` 으로만 돌았다. 그 분기 아래 — 토큰을 읽고 `POST /v1/publish` 로
zip 을 올리는 부분 — 은 한 줄도 실행된 적이 없었다. 발행 경로는 `rarn.json` 을 읽어 **`wally.toml`
을 새로 만들어** 아카이브에 넣고, 서버는 그 파일에서 이름과 버전을 읽는다. 즉 우리가 만든
번역이 맞는지는 서버만 알 수 있었다.

포맷 동결(M4) 전에 있어야 했던 이유가 그것이다. 번역이 틀렸다면 매니페스트 쪽 결정이 바뀐다.

## 무엇을 발행했나

[Hawakiki/Luau-Math-LIB](https://github.com/Hawakiki/Luau-Math-LIB) — JavaScript 스타일 Math
API 를 내는 Luau 라이브러리. Rarn 자신은 TypeScript 라 Wally 레지스트리에 올릴 수 없으므로
실제 Luau 패키지가 필요했다.

## 발행 전에 그 라이브러리를 고쳐야 했다 — 이게 이 마일스톤의 절반이다

**있는 그대로 올렸으면 설치했을 때 깨지는 패키지가 나갔다.** 셋 다 발행 자체는 성공시켰을
문제라, dry-run 만으로는 드러나지 않았을 것이다.

**1. `default.project.json` 이 place 를 서술했다.** 패키지 매니저는 그 파일로 모듈 루트를
찾는데, DataModel 형태에는 단일 `$path` 가 없다.

```
수정 전   findModuleRoot -> source: fallback, path: ""
          note: uses $className, ReplicatedStorage, ServerScriptService
수정 후   findModuleRoot -> source: project-file, path: "module"
```

아카이브 루트에 `init.luau` 가 없으므로 `require(Packages.LuauMathLib)` 가 폴더를 가리켰을
것이다. **Wally 로 설치해도 같다** — 벤치마크에서 측정한 "Wally 설치본의 74% 는 모듈 루트에
init 이 없다" 와 같은 현상이고, 그쪽은 Rojo 가 동기 시점에 메꾸는 것을 전제한다.

**2. 스코프가 남의 것이었다.** `wally.toml` 이 `anbi/luau-mathlib` 였는데 `github.com/anbi` 는
실재하는 다른 계정(2020-11-22 가입)이다. Wally 스코프는 GitHub 신원에 묶이고 첫 발행이 그
스코프를 영구히 차지한다. 이 계정으로는 거부됐을 것이고, 거부되는 것이 맞다.

**3. TestEZ 가 런타임 의존성이었다.** `[dependencies]` 에 있으면 그 라이브러리를 쓰는 모든
사람이 TestEZ 를 같이 받는다. `[dev-dependencies]` 로 옮겼다 — Wally 는 dev 를 `Packages/` 가
아니라 `DevPackages/` 에 깐다(직접 확인).

수정은 [Luau-Math-LIB#4](https://github.com/Hawakiki/Luau-Math-LIB/pull/4) 로 나갔다.

## 발행 경로가 검증한 것

| | |
|---|---|
| GitHub device flow 로그인 | `read:user` 스코프로 `Hawakiki` 인증 |
| `rarn.json` → `wally.toml` 생성 | 서버가 그 파일로 이름·버전을 읽고 받아들였다 |
| npm 범위 → Cargo 범위 번역 | `^0.4.1` 을 보냈고 인덱스에 `>=0.4.1, <0.5.0` 으로 저장됐다 |
| `exclude` | 45개만 올라갔다 |
| 발행물이 실제로 설치되나 | Rarn·Wally 양쪽에서 |

마지막 줄이 이 마일스톤의 완료 조건이었다. 발행 성공만으로는 부족하다.

```
rarn install   installed 1 packages, 39 files, 1 links, 6 pruned
               _Index/hawakiki_luau-mathlib@0.1.0/luau-mathlib/init.luau
               하니스 3/3 통과

wally install  같은 트리. _Index 에 hawakiki_luau-mathlib@0.1.0 하나뿐 —
               TestEZ 가 소비자에게 딸려가지 않는다
```

**범위 번역이 인덱스 기준으로 맞다는 것이 확인됐다.** CLAUDE.md 가 "인덱스는 확장형만
저장한다(76/76)" 고 적어 둔 것을 우리가 보낸 쪽에서도 확인한 셈이다.

## 남긴 것 — 기본 exclude 가 Wally 디렉터리를 모른다

아카이브가 처음에 **388개 파일 222.7 KiB** 로 나왔다. `wally install` 이 만든 `DevPackages/`
339개가 통째로 들어갔기 때문이다.

`alwaysExcluded` 는 `packageDir` 로 realm 디렉터리를 계산해 제외하는데, 그것은 **Rarn 자신의**
디렉터리 이름이다. Wally 의 `Packages/` 와 `DevPackages/` 는 그 목록에 없다.

Wally 에서 이주해 온 사용자는 그 두 디렉터리를 리포에 갖고 있을 가능성이 높고, `exclude` 를
손으로 적지 않으면 자기 의존성 트리를 통째로 발행하게 된다. 발행은 되돌릴 수 없으므로 조용히
틀리기 나쁜 자리다. **M4 스키마 동결 리뷰의 안건으로 남긴다** — 기본 제외 목록에 넣을지, 아니면
경고할지.

## 이 마일스톤이 바꾼 것

1.0.0 선행조건에서 마지막 ❌ 가 닫혔다. 그리고 M4 를 막던 미지 하나 — "생성한 wally.toml 을
서버가 받아들이는가" — 가 사라졌다.
